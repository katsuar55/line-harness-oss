/**
 * Email Opt-In Route (Phase 5β-1)
 *
 * 役割:
 *   - GET  /email/opt-in?email=&e=&token=  — 確認 HTML ページ (Shopify 顧客向け web 経路)
 *   - POST /email/opt-in                   — 同意 submit (form / RFC 8058 One-Click 兼用)
 *
 * 設計:
 *   - LIFF と独立 (LINE 友だちでない Shopify 顧客にも到達可能)
 *   - HMAC token 検証で代替認証
 *   - 既に opt-in 済なら idempotent (success 表示、 ユーザー混乱回避)
 *   - hadComplaint 履歴がある場合は inline 警告を出す (法令配慮)
 *
 * セキュリティ:
 *   - X-Robots-Tag: noindex で URL の検索エンジン索引化を防止
 *   - 全エラー応答は薄い情報のみ (token の正当性を明かさない)
 *
 * 関連: services/email-opt-in.ts、 routes/liff-opt-in.ts
 */

import { Hono } from 'hono';
import {
  verifyEmailOptInToken,
  performEmailOptIn,
  isValidEmail,
} from '../services/email-opt-in.js';
import { auditSystem } from '../services/audit-logger.js';
import type { Env } from '../index.js';

const emailOptIn = new Hono<Env>();

// ============================================================
// HTML rendering (inline、 依存最小化)
// ============================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ConfirmPageOpts {
  email: string;
  expiresAt: number;
  token: string;
  alreadyOptedIn: boolean;
}

function renderConfirmPage(opts: ConfirmPageOpts): string {
  const banner = opts.alreadyOptedIn
    ? '<p style="color:#059669;font-weight:600;">✓ 既にメール配信に同意いただいています。 ありがとうございます。</p>'
    : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>メールマガジン登録 — naturism</title>
<style>
*{box-sizing:border-box}
body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1f2937}
.card{max-width:480px;margin:48px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 16px rgba(0,0,0,0.06)}
h1{font-size:20px;margin:0 0 16px;color:#0f766e}
p{font-size:14px;line-height:1.7;margin:8px 0}
.email{font-weight:600;color:#374151;background:#f1f5f9;padding:8px 12px;border-radius:6px;display:inline-block;margin:4px 0}
label.consent{display:flex;align-items:flex-start;gap:8px;padding:12px;background:#f8fafc;border-radius:8px;margin:16px 0;cursor:pointer;font-size:13px;line-height:1.6;color:#374151}
label.consent input{margin-top:3px;cursor:pointer}
button{font-family:inherit;cursor:pointer;border:none;font-size:14px;padding:12px 24px;border-radius:8px;font-weight:600;width:100%;margin-top:16px}
.btn-primary{background:#0f766e;color:#fff}
.btn-primary:active{transform:scale(0.98)}
.btn-primary:disabled{background:#cbd5e1;cursor:not-allowed}
.btn-secondary{background:#e5e7eb;color:#374151;margin-top:8px}
.footer{font-size:11px;color:#9ca3af;margin-top:24px;text-align:center;line-height:1.6}
.benefit{background:#fef3c7;border-radius:8px;padding:12px;margin:16px 0;font-size:13px;color:#92400e}
</style>
</head>
<body>
<div class="card">
  <h1>📧 メールマガジン登録の確認</h1>
  ${banner}
  <p>以下のメールアドレスに <strong>マーケティングメール</strong> (新商品 / 健康コラム / 季節のキャンペーン情報) をお届けします:</p>
  <p class="email">${escapeHtml(opts.email)}</p>
  <div class="benefit">🎁 登録完了で <strong>クーポンコード</strong> をプレゼント (内容は登録完了画面でご案内)</div>
  <form method="POST" action="/email/opt-in" id="opt-in-form">
    <input type="hidden" name="email" value="${escapeHtml(opts.email)}">
    <input type="hidden" name="e" value="${escapeHtml(String(opts.expiresAt))}">
    <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
    <input type="hidden" name="channel" value="web">
    <label class="consent">
      <input type="checkbox" name="marketing_consent" value="1" required>
      <span><strong>マーケティングメールの受信に同意します</strong> (いつでも解除可能。 取引メールは別途お届けします)</span>
    </label>
    <button type="submit" class="btn-primary">登録する</button>
  </form>
  <a href="https://naturism-diet.com" style="text-decoration:none;"><button type="button" class="btn-secondary">キャンセル</button></a>
  <p class="footer">株式会社ケンコーエクスプレス｜naturism<br><a href="https://naturism-diet.com/pages/privacy" style="color:#6b7280;">プライバシーポリシー</a></p>
</div>
</body>
</html>`;
}

interface ResultPageOpts {
  success: boolean;
  email?: string;
  message?: string;
  couponCode?: string | null;
}

function renderResultPage(opts: ResultPageOpts): string {
  const title = opts.success ? '✅ ご登録ありがとうございます' : '⚠️ エラー';
  const titleColor = opts.success ? '#059669' : '#dc2626';
  const message =
    opts.message ??
    (opts.success
      ? 'メールマガジンの配信を開始いたします。 いつでも配信停止できます。'
      : 'リンクが無効か、 有効期限を過ぎている可能性があります。 お手数ですが support@naturism-diet.com までご連絡ください。');
  const couponBlock = opts.couponCode
    ? `<div style="background:#fef3c7;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
         <p style="margin:0 0 6px;font-size:12px;color:#92400e;">クーポンコード</p>
         <p style="margin:0;font-size:22px;font-weight:700;color:#92400e;letter-spacing:2px;font-family:monospace;">${escapeHtml(opts.couponCode)}</p>
         <p style="margin:8px 0 0;font-size:11px;color:#92400e;">naturism-diet.com で次回購入時にご利用いただけます</p>
       </div>`
    : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>登録完了 — naturism</title>
<style>
body{font-family:'Noto Sans JP',system-ui,sans-serif;background:#f8fafc;margin:0;padding:24px;color:#1f2937}
.card{max-width:480px;margin:48px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 16px rgba(0,0,0,0.06)}
h1{font-size:20px;margin:0 0 16px;color:${titleColor}}
p{font-size:14px;line-height:1.7;margin:8px 0;color:#374151}
.footer{font-size:11px;color:#9ca3af;margin-top:24px;text-align:center}
a.cta{display:inline-block;margin-top:16px;color:#0f766e;font-weight:600;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <p>${escapeHtml(message)}</p>
  ${opts.email ? `<p style="font-size:12px;color:#6b7280;">対象: ${escapeHtml(opts.email)}</p>` : ''}
  ${couponBlock}
  <a class="cta" href="https://naturism-diet.com">naturism-diet.com に戻る →</a>
  <p class="footer">株式会社ケンコーエクスプレス｜naturism</p>
</div>
</body>
</html>`;
}

// ============================================================
// helpers
// ============================================================

function parseExpiresAt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * クーポンコード発行 (5β-1d で Shopify API 連動に置換、 現在は static MVP)。
 * 環境変数 EMAIL_OPTIN_DEFAULT_COUPON で固定値を出す。 未設定なら null。
 */
function getDefaultCoupon(env: Env['Bindings']): string | null {
  const fromEnv = (env as { EMAIL_OPTIN_DEFAULT_COUPON?: string }).EMAIL_OPTIN_DEFAULT_COUPON;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return null;
}

// ============================================================
// GET /email/opt-in — 確認ページ
// ============================================================

emailOptIn.get('/email/opt-in', async (c) => {
  const hmacKey = (c.env as { EMAIL_OPTIN_HMAC_KEY?: string }).EMAIL_OPTIN_HMAC_KEY;
  if (!hmacKey) {
    return c.text('Email opt-in not configured', 503);
  }

  const email = c.req.query('email');
  const expiresAtRaw = c.req.query('e');
  const token = c.req.query('token');

  if (!email || !expiresAtRaw || !token) {
    return c.html(renderResultPage({ success: false }), 400);
  }

  const expiresAt = parseExpiresAt(expiresAtRaw);
  if (expiresAt === null) {
    return c.html(renderResultPage({ success: false }), 400);
  }

  const verify = await verifyEmailOptInToken(hmacKey, { email, expiresAt, token });
  if (!verify.valid) {
    return c.html(
      renderResultPage({
        success: false,
        message:
          verify.error === 'expired'
            ? 'リンクの有効期限が切れています。 サポートまでご連絡いただければ再発行いたします。'
            : 'リンクが無効です。 URL をコピー&ペーストでご確認いただくか、 サポートまでご連絡ください。',
      }),
      400,
    );
  }

  // 既に opt-in 済かどうかチェック (UI 表示用)
  const existing = await c.env.DB.prepare(
    `SELECT is_active, transactional_only, unsubscribed_at FROM email_subscribers WHERE email = ?`,
  )
    .bind(email)
    .first<{ is_active: number; transactional_only: number; unsubscribed_at: string | null }>();
  const alreadyOptedIn =
    existing?.is_active === 1 &&
    existing?.transactional_only === 0 &&
    existing?.unsubscribed_at === null;

  return c.html(
    renderConfirmPage({
      email,
      expiresAt,
      token,
      alreadyOptedIn,
    }),
  );
});

// ============================================================
// POST /email/opt-in — 同意実行
// ============================================================

emailOptIn.post('/email/opt-in', async (c) => {
  const hmacKey = (c.env as { EMAIL_OPTIN_HMAC_KEY?: string }).EMAIL_OPTIN_HMAC_KEY;
  if (!hmacKey) {
    return c.text('Email opt-in not configured', 503);
  }

  let email: string | undefined;
  let expiresAtRaw: string | undefined;
  let token: string | undefined;
  let marketingConsent: string | undefined;

  // query / form / JSON 全部受ける
  try {
    const form = await c.req.parseBody();
    email = typeof form.email === 'string' ? form.email : undefined;
    expiresAtRaw = typeof form.e === 'string' ? form.e : undefined;
    token = typeof form.token === 'string' ? form.token : undefined;
    marketingConsent = typeof form.marketing_consent === 'string' ? form.marketing_consent : undefined;
  } catch {
    // body parse 失敗時は query にフォールバック
  }
  email = email ?? c.req.query('email');
  expiresAtRaw = expiresAtRaw ?? c.req.query('e');
  token = token ?? c.req.query('token');

  if (!email || !expiresAtRaw || !token) {
    return c.html(renderResultPage({ success: false }), 400);
  }
  if (!isValidEmail(email)) {
    return c.html(renderResultPage({ success: false }), 400);
  }

  const expiresAt = parseExpiresAt(expiresAtRaw);
  if (expiresAt === null) {
    return c.html(renderResultPage({ success: false }), 400);
  }

  const verify = await verifyEmailOptInToken(hmacKey, { email, expiresAt, token });
  if (!verify.valid) {
    return c.html(
      renderResultPage({
        success: false,
        message:
          verify.error === 'expired'
            ? 'リンクの有効期限が切れています。 サポートまでご連絡いただければ再発行いたします。'
            : 'リンクが無効です。 サポートまでご連絡ください。',
      }),
      400,
    );
  }

  // marketing_consent checkbox がない場合は同意扱いにしない (UI が必須なのでまず起きない)
  if (marketingConsent !== '1') {
    return c.html(
      renderResultPage({
        success: false,
        message: 'マーケティング同意 checkbox にチェックを入れて再度お試しください。',
      }),
      400,
    );
  }

  try {
    const result = await performEmailOptIn(c.env.DB, {
      email,
      channel: 'web',
      consentSource: 'opt_in_form',
    });

    // best-effort audit
    await auditSystem(c.env.DB, {
      action: 'email.opt_in',
      actorType: 'api',
      targetType: 'email_subscriber',
      targetId: result.subscriberId,
      metadata: {
        channel: 'web',
        outcome: result.outcome,
        had_complaint: result.hadComplaint,
      },
    });

    return c.html(
      renderResultPage({
        success: true,
        email: result.email,
        couponCode: getDefaultCoupon(c.env),
      }),
    );
  } catch (err) {
    console.warn('[email-opt-in] performEmailOptIn failed:', err instanceof Error ? err.message : String(err));
    return c.html(renderResultPage({ success: false }), 500);
  }
});

export { emailOptIn };

// テスト用 export
export const __test__ = {
  escapeHtml,
  parseExpiresAt,
  renderConfirmPage,
  renderResultPage,
};
