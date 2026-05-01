/**
 * Resend Webhook Receiver (Round 4 PR-4)
 *
 * 役割:
 * - Resend (Svix 経由) から送られてくる webhook を受信
 * - 署名検証 (svix-signature ヘッダ + RESEND_WEBHOOK_SECRET)
 * - イベント別処理:
 *   - email.delivered → email_messages_log.status='delivered'
 *   - email.bounced   → recordBounce + status='bounced'
 *   - email.complained → recordComplaint + status='complained'
 *   - email.opened    → status='opened' + open_count++
 *   - email.clicked   → status='clicked' + click_count++ + email_link_clicks INSERT
 *   - email.delivery_delayed / email.sent → 200 OK だが何もしない (status='sent' を上書きしない)
 *   - 未知 type → 200 OK (skip)
 *
 * 設計方針:
 * - **冪等性**: 同じ webhook が再送されても DB 重複しない。
 *   email_messages_log の更新は status / カウンタ加算のみで、
 *   delivered_at / first_opened_at は初回のみセット (既存ロジック)。
 * - **fail-soft**: 記録対象 log が見つからない場合 (provider_message_id 不明)
 *   は warn ログ + 200 を返す (Resend 側のリトライを止める)。
 * - **bounce 闾値**: 3 回で is_active=0 (recordBounce ロジック)
 * - **complaint 闘値**: 1 回で即 is_active=0 (recordComplaint ロジック)
 *
 * セキュリティ:
 * - 署名なし / 署名不一致 → 401 (Resend のリトライ対象に)
 * - timestamp 5 分以上古い → 401 (replay 攻撃緩和)
 *
 * 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-4
 *       packages/email-sdk/types.ts (EmailLogStatus)
 *       apps/worker/src/utils/svix-signature.ts (Svix 署名検証)
 */

import { Hono } from 'hono';
import {
  updateEmailLogStatus,
  getEmailLogByProviderId,
  recordEmailClick,
  recordBounce,
  recordComplaint,
  getEmailSubscriberById,
  type EmailMessageLog,
} from '@line-crm/db';
import { verifySvixSignature } from '../utils/svix-signature.js';
import type { Env } from '../index.js';

const integrationsResend = new Hono<Env>();

// ============================================================
// 型 (Resend Webhook Payload)
// ============================================================

interface ResendWebhookPayload {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[];
    subject?: string;
    bounce_type?: string;
    bounce?: {
      message?: string;
      bounceSubType?: string;
    };
    click?: {
      link?: string;
      ipAddress?: string;
      userAgent?: string;
    };
    [key: string]: unknown;
  };
}

// ============================================================
// 主要な処理: イベント種別ごとの分岐
// ============================================================

interface ProcessResult {
  /** 内部メトリクス用。HTTP レスポンス自体は常に 200 */
  action: 'updated' | 'skipped' | 'log_not_found' | 'unknown_event';
  detail?: string;
}

export async function processResendEvent(
  db: D1Database,
  payload: ResendWebhookPayload,
): Promise<ProcessResult> {
  const type = payload.type;
  const emailId = payload.data?.email_id;

  if (!emailId) {
    return { action: 'skipped', detail: 'no email_id in payload' };
  }

  // 既存 log の有無確認 (provider='resend')
  const log = await getEmailLogByProviderId(db, 'resend', emailId);

  switch (type) {
    case 'email.sent':
      // 送信時点では既に sent ステータスでログ済 (insertEmailLog 側) なので skip
      return { action: 'skipped', detail: 'sent (no-op)' };

    case 'email.delivery_delayed':
      // 一時的な失敗 — 後続 delivered/bounced で確定するので state を上書きしない
      return { action: 'skipped', detail: 'delivery_delayed (transient)' };

    case 'email.delivered':
      if (!log) return { action: 'log_not_found' };
      await updateEmailLogStatus(db, {
        provider: 'resend',
        providerMessageId: emailId,
        newStatus: 'delivered',
      });
      return { action: 'updated', detail: 'delivered' };

    case 'email.opened':
      if (!log) return { action: 'log_not_found' };
      await updateEmailLogStatus(db, {
        provider: 'resend',
        providerMessageId: emailId,
        newStatus: 'opened',
        incrementOpenCount: true,
      });
      return { action: 'updated', detail: 'opened' };

    case 'email.clicked':
      if (!log) return { action: 'log_not_found' };
      await updateEmailLogStatus(db, {
        provider: 'resend',
        providerMessageId: emailId,
        newStatus: 'clicked',
        incrementClickCount: true,
      });
      // click 詳細を別 table に追記 (URL / UA / IP hash)
      if (payload.data?.click?.link) {
        const ipHash = await maybeHashIp(payload.data.click.ipAddress);
        try {
          await recordEmailClick(db, log.id, payload.data.click.link, {
            userAgent: payload.data.click.userAgent,
            ipHash,
          });
        } catch (err) {
          // click 記録は best-effort (重複等は無視)
          console.warn(
            '[resend-webhook] recordEmailClick failed',
            err instanceof Error ? err.name : 'unknown',
          );
        }
      }
      return { action: 'updated', detail: 'clicked' };

    case 'email.bounced': {
      if (!log) return { action: 'log_not_found' };
      const errorSummary = formatBounceError(payload);
      await updateEmailLogStatus(db, {
        provider: 'resend',
        providerMessageId: emailId,
        newStatus: 'bounced',
        errorSummary,
      });
      // subscriber 側のカウンタ + 闾値処理
      const subscriber = await getEmailSubscriberById(db, log.subscriber_id);
      if (subscriber) {
        await recordBounce(db, subscriber.email);
      }
      return { action: 'updated', detail: 'bounced' };
    }

    case 'email.complained': {
      if (!log) return { action: 'log_not_found' };
      await updateEmailLogStatus(db, {
        provider: 'resend',
        providerMessageId: emailId,
        newStatus: 'complained',
      });
      const subscriber = await getEmailSubscriberById(db, log.subscriber_id);
      if (subscriber) {
        await recordComplaint(db, subscriber.email);
      }
      return { action: 'updated', detail: 'complained' };
    }

    default:
      return { action: 'unknown_event', detail: type };
  }
}

// ============================================================
// helpers
// ============================================================

function formatBounceError(payload: ResendWebhookPayload): string {
  const bt = payload.data?.bounce_type ?? '';
  const subt = payload.data?.bounce?.bounceSubType ?? '';
  const msg = payload.data?.bounce?.message ?? '';
  const composed = [bt, subt, msg].filter(Boolean).join(' / ');
  return composed.slice(0, 500);
}

/**
 * IP hash 化 (個人情報最小化)。
 * 失敗時は undefined を返す (best-effort)。
 */
async function maybeHashIp(ip?: string): Promise<string | undefined> {
  if (!ip) return undefined;
  try {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(ip));
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return undefined;
  }
}

// ============================================================
// Route
// ============================================================

integrationsResend.post('/api/integrations/resend/webhook', async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // secret 未登録 → 503 (Resend にリトライさせない設定にはしない)
    return c.json({ success: false, error: 'webhook not configured' }, 503);
  }

  const body = await c.req.text();
  const svixId = c.req.header('svix-id') ?? '';
  const svixTimestamp = c.req.header('svix-timestamp') ?? '';
  const svixSignature = c.req.header('svix-signature') ?? '';

  const verify = await verifySvixSignature({
    body,
    secret,
    svixId,
    svixTimestamp,
    svixSignature,
  });

  if (!verify.valid) {
    return c.json({ success: false, error: 'invalid signature', reason: verify.reason }, 401);
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(body) as ResendWebhookPayload;
  } catch {
    // 署名は OK なのに JSON パース失敗は Resend 側のバグ。200 で吸収しても害はない。
    return c.json({ success: false, error: 'invalid json' }, 400);
  }

  let result: ProcessResult;
  try {
    result = await processResendEvent(c.env.DB, payload);
  } catch (err) {
    console.error(
      '[resend-webhook] processing failed',
      err instanceof Error ? err.name : 'unknown',
      payload.type,
    );
    // DB 障害 — Resend に再送させたいので 5xx
    return c.json({ success: false, error: 'processing failed' }, 500);
  }

  return c.json({ success: true, action: result.action, detail: result.detail });
});

export { integrationsResend };

// ============================================================
// テスト用エクスポート
// ============================================================
export const __test__ = {
  processResendEvent,
  formatBounceError,
  maybeHashIp,
};

// types re-export (テストで使う)
export type { ResendWebhookPayload };
