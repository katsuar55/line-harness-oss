/**
 * Email Unsubscribe Route (Round 4 PR-5)
 *
 * 役割:
 * - GET /email/unsubscribe?id=...&token=... — 確認 HTML ページ表示
 * - POST /email/unsubscribe — 実際の解除処理 (フォーム + RFC 8058 One-Click 兼用)
 *
 * セキュリティ:
 * - HMAC-SHA256 トークン検証 (key = EMAIL_UNSUBSCRIBE_HMAC_KEY env)
 * - HMAC は EmailRenderer (packages/email-sdk/src/renderer.ts) と同じ式で生成
 *
 * 法令:
 * - 特定電子メール法 第 4 条 (送信者情報・解除方法明示)
 * - RFC 8058 List-Unsubscribe-Post (One-Click) 対応
 *
 * 設計方針:
 * - GET ページは LIFF と独立 (LINE 友だちでない Shopify 顧客にも到達可能)
 * - POST は GET ページのフォーム送信 + RFC 8058 ワンクリック の両方を受ける
 * - 既に解除済 → 200 idempotent (404 にしない、ユーザー混乱回避)
 * - HMAC 不一致 → 400 (生のエラー文言は出さない)
 *
 * 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-5
 */

import { Hono } from 'hono';
import {
  getEmailSubscriberById,
  unsubscribeById,
  resubscribeById,
} from '@line-crm/db';
import type { Env } from '../index.js';

const emailUnsubscribe = new Hono<Env>();

// ============================================================
// HMAC 検証 helper (EmailRenderer と同じロジック)
// ============================================================

/**
 * HMAC-SHA256 hex (Web Crypto API、Cloudflare Workers 互換)。
 * EmailRenderer.buildUnsubscribeUrl と完全同一の式である必要がある。
 */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定数時間比較 (timing attack 緩和)。
 * 文字列長が異なる場合は false (短絡 OK — 長さは秘密ではない)。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * subscriber.id (UUID v4) の形式バリデーション。
 * `crypto.randomUUID()` が生成する標準形式に限定する。
 * 形式違反は HMAC を計算する前に reject することで、不正な id を DB に
 * 渡す総当たり攻撃を初期段階でブロックする。
 */
const SUBSCRIBER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSubscriberId(id: string | undefined | null): id is string {
  return typeof id === 'string' && SUBSCRIBER_ID_PATTERN.test(id);
}

/**
 * subscriberId と token (URL 経由) を verify する。
 * @returns 検証 OK なら subscriberId、NG なら null
 */
export async function verifyUnsubscribeToken(
  hmacKey: string,
  subscriberId: string,
  token: string,
): Promise<boolean> {
  if (!subscriberId || !token) return false;
  if (!isValidSubscriberId(subscriberId)) return false;
  // hex 形式バリデーション (token は 64 文字 hex)
  if (!/^[a-f0-9]{64}$/i.test(token)) return false;
  const expected = await hmacSha256Hex(hmacKey, subscriberId);
  return constantTimeEqual(expected.toLowerCase(), token.toLowerCase());
}

// ============================================================
// HTML rendering (依存最小化のため inline)
// ============================================================

function renderConfirmPage(opts: {
  subscriberId: string;
  token: string;
  email: string;
  alreadyUnsubscribed: boolean;
}): string {
  const status = opts.alreadyUnsubscribed
    ? '<p style="color:#059669;">このメールアドレスは既に配信停止されています。</p>'
    : '';
  // フォーム POST は同じ URL に対して body=List-Unsubscribe=One-Click で送る
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配信停止 — naturism</title>
<style>
*{box-sizing:border-box}
body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1f2937}
.card{max-width:480px;margin:48px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 16px rgba(0,0,0,0.06)}
h1{font-size:20px;margin:0 0 16px;color:#0f766e}
p{font-size:14px;line-height:1.7;margin:8px 0}
.email{font-weight:600;color:#374151}
button{font-family:inherit;cursor:pointer;border:none;font-size:14px;padding:12px 24px;border-radius:8px;font-weight:600;width:100%;margin-top:16px}
.btn-danger{background:#dc2626;color:#fff}
.btn-danger:active{transform:scale(0.98)}
.btn-secondary{background:#e5e7eb;color:#374151;margin-top:8px}
.footer{font-size:11px;color:#9ca3af;margin-top:24px;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>📧 配信停止の確認</h1>
  ${status}
  <p>以下のメールアドレス宛の <strong>マーケティングメール</strong> を停止します:</p>
  <p class="email">${escapeHtml(opts.email)}</p>
  <p style="font-size:12px;color:#6b7280;">注: 注文確認・配送通知などの取引メールは引き続きお届けします。</p>
  <form method="POST" action="/email/unsubscribe">
    <input type="hidden" name="id" value="${escapeHtml(opts.subscriberId)}">
    <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
    <input type="hidden" name="List-Unsubscribe" value="One-Click">
    <button type="submit" class="btn-danger">配信を停止する</button>
  </form>
  <a href="https://naturism-diet.com" style="text-decoration:none;"><button type="button" class="btn-secondary">キャンセルしてサイトに戻る</button></a>
  <p class="footer">株式会社ケンコーエクスプレス｜naturism</p>
</div>
</body>
</html>`;
}

function renderResultPage(opts: { success: boolean; alreadyDone: boolean; email?: string }): string {
  let title: string;
  let message: string;
  if (opts.success && opts.alreadyDone) {
    title = '✅ 配信停止済み';
    message = 'このメールアドレスは既に配信停止されています。';
  } else if (opts.success) {
    title = '✅ 配信停止が完了しました';
    message = '今後、マーケティングメールは送信されません。注文確認等の取引メールは引き続きお届けします。';
  } else {
    title = '⚠️ エラー';
    message = '処理に失敗しました。お手数ですが support@naturism-diet.com までご連絡ください。';
  }
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>配信停止 — naturism</title>
<style>
body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1f2937}
.card{max-width:480px;margin:48px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 16px rgba(0,0,0,0.06)}
h1{font-size:20px;margin:0 0 16px;color:${opts.success ? '#059669' : '#dc2626'}}
p{font-size:14px;line-height:1.7;margin:8px 0;color:#374151}
.footer{font-size:11px;color:#9ca3af;margin-top:24px;text-align:center}
a.cta{display:inline-block;margin-top:16px;color:#0f766e;font-weight:600;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <p>${message}</p>
  ${opts.email ? `<p style="font-size:12px;color:#6b7280;">対象: ${escapeHtml(opts.email)}</p>` : ''}
  <a class="cta" href="https://naturism-diet.com">naturism-diet.com に戻る →</a>
  <p class="footer">株式会社ケンコーエクスプレス｜naturism</p>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// GET /email/unsubscribe — 確認ページ
// ============================================================

emailUnsubscribe.get('/email/unsubscribe', async (c) => {
  const id = c.req.query('id');
  const token = c.req.query('token');
  const hmacKey = c.env.EMAIL_UNSUBSCRIBE_HMAC_KEY;

  if (!hmacKey) {
    return c.text('Email unsubscribe not configured', 503);
  }
  if (!id || !token) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 400);
  }

  const valid = await verifyUnsubscribeToken(hmacKey, id, token);
  if (!valid) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 400);
  }

  const subscriber = await getEmailSubscriberById(c.env.DB, id);
  if (!subscriber) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 404);
  }

  const alreadyUnsubscribed =
    subscriber.unsubscribed_at !== null || subscriber.is_active === 0;

  return c.html(
    renderConfirmPage({
      subscriberId: id,
      token,
      email: subscriber.email,
      alreadyUnsubscribed,
    }),
  );
});

// ============================================================
// POST /email/unsubscribe — 実際の解除処理
// ============================================================

emailUnsubscribe.post('/email/unsubscribe', async (c) => {
  const hmacKey = c.env.EMAIL_UNSUBSCRIBE_HMAC_KEY;
  if (!hmacKey) {
    return c.text('Email unsubscribe not configured', 503);
  }

  // 入力受け取り: query string OR form body のどちらでも OK (RFC 8058 One-Click は body 経由)
  const queryId = c.req.query('id');
  const queryToken = c.req.query('token');
  let bodyId: string | undefined;
  let bodyToken: string | undefined;
  try {
    const form = await c.req.parseBody();
    bodyId = typeof form.id === 'string' ? form.id : undefined;
    bodyToken = typeof form.token === 'string' ? form.token : undefined;
  } catch {
    // body parse 失敗 (Content-Type 不一致等) は許容、query 側で判定
  }

  const id = queryId ?? bodyId;
  const token = queryToken ?? bodyToken;

  if (!id || !token) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 400);
  }

  const valid = await verifyUnsubscribeToken(hmacKey, id, token);
  if (!valid) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 400);
  }

  const subscriber = await getEmailSubscriberById(c.env.DB, id);
  if (!subscriber) {
    return c.html(renderResultPage({ success: false, alreadyDone: false }), 404);
  }

  // 既に解除済みなら idempotent に成功扱い (ユーザー混乱回避)
  if (subscriber.unsubscribed_at !== null) {
    return c.html(
      renderResultPage({
        success: true,
        alreadyDone: true,
        email: subscriber.email,
      }),
    );
  }

  // unsubscribeById は is_active=1 のレコードのみ更新する。bounce/complaint で既に
  // is_active=0 のレコードに対しても unsubscribed_at をセットしておきたいので、
  // 戻り値が false でも fallthrough して直接 UPDATE する。
  const ok = await unsubscribeById(c.env.DB, id);
  if (!ok) {
    // 既に is_active=0 (bounce/complaint 抑制済) のケース。unsubscribed_at だけ追加で記録。
    await c.env.DB.prepare(
      `UPDATE email_subscribers SET unsubscribed_at = ?, updated_at = ? WHERE id = ? AND unsubscribed_at IS NULL`,
    )
      .bind(new Date().toISOString(), new Date().toISOString(), id)
      .run();
  }

  return c.html(
    renderResultPage({ success: true, alreadyDone: false, email: subscriber.email }),
  );
});

// ============================================================
// POST /email/resubscribe — 再 opt-in (誤解除救済)
// ============================================================

emailUnsubscribe.post('/email/resubscribe', async (c) => {
  const hmacKey = c.env.EMAIL_UNSUBSCRIBE_HMAC_KEY;
  if (!hmacKey) {
    return c.text('Email unsubscribe not configured', 503);
  }
  const id = c.req.query('id');
  const token = c.req.query('token');

  if (!id || !token) return c.json({ success: false, error: 'missing params' }, 400);

  const valid = await verifyUnsubscribeToken(hmacKey, id, token);
  if (!valid) return c.json({ success: false, error: 'invalid token' }, 400);

  const ok = await resubscribeById(c.env.DB, id);
  return c.json({ success: ok });
});

export { emailUnsubscribe };

// ============================================================
// テスト用エクスポート
// ============================================================
export const __test__ = {
  verifyUnsubscribeToken,
  hmacSha256Hex,
  constantTimeEqual,
  escapeHtml,
};
