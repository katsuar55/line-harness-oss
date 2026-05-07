import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

interface VerifyOptions {
  /** テスト時に現在時刻 (ms) を固定したい場合に渡す。default: Date.now() */
  now?: number;
  /** timestamp の許容差 (秒)。default: 300 (Stripe 公式推奨値) */
  toleranceSec?: number;
}

/** hex 文字列を Uint8Array に変換 (奇数長や非 hex 文字は null を返す) */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[a-f0-9]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Stripe webhook 署名検証 (公式仕様準拠)。
 * - 形式: `t=<unix_ts>,v1=<hex>[,v1=<hex>]` (シークレットローテーション中は v1 が複数)
 * - timestamp 検証で replay 攻撃防止 (現在時刻と ±toleranceSec)
 * - `crypto.subtle.verify` で timing-safe 比較
 *
 * @returns 検証 OK なら true、それ以外は false
 */
export async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  sigHeader: string,
  opts?: VerifyOptions,
): Promise<boolean> {
  if (!sigHeader) return false;
  const nowMs = opts?.now ?? Date.now();
  const toleranceSec = opts?.toleranceSec ?? 300;

  // Stripe署名形式: t=timestamp,v1=signature[,v1=signature2]
  // signature ローテーション中は v1 が複数並ぶことがあるため、parts は配列で保持
  const pairs = sigHeader
    .split(',')
    .map((p) => {
      const idx = p.indexOf('=');
      if (idx === -1) return null;
      return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()] as const;
    })
    .filter((x): x is readonly [string, string] => x !== null);
  const timestamp = pairs.find(([k]) => k === 't')?.[1];
  const expectedSigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || expectedSigs.length === 0) return false;

  // timestamp 検証 (replay 防止)
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ageSec = Math.abs(Math.floor(nowMs / 1000) - ts);
  if (ageSec > toleranceSec) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // 各 v1 (hex 32 bytes = 64 chars) を Uint8Array 化して timing-safe 比較
  for (const sigHex of expectedSigs) {
    const sigBytes = hexToBytes(sigHex);
    if (!sigBytes || sigBytes.byteLength !== 32) continue;
    try {
      const ok = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(signedPayload));
      if (ok) return true;
    } catch {
      // 不正な signature 形式等は continue
    }
  }
  return false;
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    let body: StripeWebhookBody;

    if (stripeSecret) {
      // 署名検証モード（本番環境）
      const sigHeader = c.req.header('Stripe-Signature') ?? '';
      const rawBody = await c.req.text();

      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as StripeWebhookBody;
    } else {
      // シークレット未設定 → 本番ではリジェクト
      return c.json({ success: false, error: 'STRIPE_WEBHOOK_SECRET is not configured. Webhook rejected.' }, 500);
    }

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase');

      // 自動タグ付け（product_idベース）
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(`SELECT id FROM tags WHERE name = ?`)
          .bind(`purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await db
            .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
            .bind(friendId, tag.id, jstNow())
            .run();
        }
      }

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../services/event-bus.js');
      const { buildEmailDispatchConfig } = await import('../services/email-dispatch-config.js');
      await fireEvent(
        db,
        'cv_fire',
        { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } },
        undefined,
        undefined,
        buildEmailDispatchConfig(c.env),
      );
    }

    // サブスクリプションイベント処理
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(`SELECT id FROM tags WHERE name = 'subscription_cancelled'`)
        .first<{ id: string }>();
      if (cancelledTag) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friendId, cancelledTag.id, jstNow())
          .run();
      }
    }

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { stripe };
