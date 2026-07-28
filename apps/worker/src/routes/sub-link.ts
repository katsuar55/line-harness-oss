/**
 * サブスク連携獲得キット (magic-link) ルート (2026-07-24)
 *
 *   admin (API_KEY bearer):
 *     POST /api/admin/sub-link/generate — 未連携サブスク顧客ごとに 1タップ連携リンクを発行 (mail-merge 用)
 *     GET  /api/admin/sub-link/status   — トークン件数のみ (PII なし・定点観測)
 *
 *   LIFF (idToken / liffAuthMiddleware):
 *     POST /api/liff/sub-link/preview   — トークン検証 + プラン提示 (= 消費しない・PII を返さない)
 *     POST /api/liff/sub-link/redeem    — single-use 消費 → friends.shopify_customer_id を紐付け
 *
 * ガード: SUB_LINK_ENABLED='true' でなければ service が disabled を返し、 admin/LIFF とも inert。
 *   /api/admin/* は authMiddleware (API_KEY)、 /api/liff/* は liffAuthMiddleware (idToken) 配下。
 *
 * 関連: services/sub-link.ts、 routes/liff-account-link.ts (= 同 LIFF POST パターン)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  generateSubLinkBatch,
  getSubLinkStatus,
  previewSubLinkToken,
  redeemSubLinkToken,
  type RedeemFailure,
} from '../services/sub-link.js';
import type { Env } from '../index.js';

const subLink = new Hono<Env>();

function getLiffUser(c: { get: (key: string) => unknown }) {
  return c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
}

// ============================================================
// admin: POST /api/admin/sub-link/generate
// ============================================================

const GenerateSchema = z.object({
  customerIds: z.array(z.string().min(1)).max(500).optional(),
  onlyUnlinked: z.boolean().optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

subLink.post('/api/admin/sub-link/generate', async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // 空ボディ = 既定 (全未連携サブスク顧客) を許容
  }
  const parsed = GenerateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  try {
    const result = await generateSubLinkBatch(c.env, parsed.data);
    if (result.ok) {
      return c.json({ success: true, data: result });
    }
    const status = result.code === 'disabled' ? 409 : result.code === 'misconfigured' ? 503 : 400;
    const message =
      result.code === 'disabled'
        ? 'SUB_LINK_ENABLED is not true — feature is dormant'
        : result.code === 'misconfigured'
          ? 'LIFF_URL is not configured'
          : 'Invalid input';
    return c.json({ success: false, error: result.code, message }, status as never);
  } catch (err) {
    console.error('POST /api/admin/sub-link/generate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// admin: GET /api/admin/sub-link/status
// ============================================================

subLink.get('/api/admin/sub-link/status', async (c) => {
  try {
    const status = await getSubLinkStatus(c.env);
    return c.json({ success: true, data: status });
  } catch (err) {
    console.error('GET /api/admin/sub-link/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// LIFF: POST /api/liff/sub-link/preview
// ============================================================

const TokenSchema = z.object({ token: z.string().min(1).max(64) });

subLink.post('/api/liff/sub-link/preview', async (c) => {
  const user = getLiffUser(c);
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: 'Invalid request body' }, 400);

  try {
    const result = await previewSubLinkToken(c.env, { token: parsed.data.token, friendId: user.friendId });
    if (result.ok) {
      return c.json({
        success: true,
        // kind = 発行経路 ('subscription' | 'shop')。 LIFF の確認カード文言分岐に必須
        // (落とすと App Proxy 経由の非サブスク顧客に「定期購入」と誤表示される)。
        // hint = ready のみのマスク済 email (= 連携先が自分かを人間が判断する唯一の材料)。
        data: {
          status: result.status,
          plan: result.plan,
          intervalDays: result.intervalDays,
          kind: result.kind,
          hint: result.hint,
        },
      });
    }
    // disabled = 機能未稼働。 endpoint の存在を露出しないため 404
    return c.json({ success: false, error: 'not_found' }, 404);
  } catch (err) {
    console.error('POST /api/liff/sub-link/preview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// LIFF: POST /api/liff/sub-link/redeem
// ============================================================

const REDEEM_FAILURE: Record<RedeemFailure, { status: number; message: string }> = {
  disabled: { status: 404, message: 'お探しのページは見つかりませんでした。' },
  invalid: { status: 400, message: 'この連携リンクは無効です。 お手元の最新のリンクからお試しください。' },
  expired: { status: 410, message: 'この連携リンクは有効期限が切れています。 お手数ですが再発行をご依頼ください。' },
  used: { status: 409, message: 'この連携リンクはすでに使用されています。' },
  taken: { status: 409, message: 'このご登録は別の LINE アカウントと連携済みです。' },
  friend_conflict: { status: 409, message: 'この LINE アカウントは別のご登録と連携済みです。' },
};

subLink.post('/api/liff/sub-link/redeem', async (c) => {
  const user = getLiffUser(c);
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }
  const parsed = TokenSchema.safeParse(body);
  if (!parsed.success) return c.json({ success: false, error: 'Invalid request body' }, 400);

  try {
    const result = await redeemSubLinkToken(c.env, {
      token: parsed.data.token,
      friendId: user.friendId,
      lineUserId: user.lineUserId,
    });
    if (result.ok) {
      return c.json({
        success: true,
        data: { linked: true, alreadyLinked: result.alreadyLinked, ...result.summary },
      });
    }
    const m = REDEEM_FAILURE[result.code];
    return c.json({ success: false, error: result.code, message: m.message }, m.status as never);
  } catch (err) {
    console.error('POST /api/liff/sub-link/redeem error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { subLink };
