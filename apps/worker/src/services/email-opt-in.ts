/**
 * Email Opt-In Service (Phase 5β-1)
 *
 * 役割:
 *   - email opt-in URL の HMAC token 署名 / 検証 (stateless、 DB lookup 不要)
 *   - recordMarketingOptIn の wrapper (audit_logs hook 付き)
 *
 * 動線:
 *   1. Shopify 顧客向け email: transactional email 内に
 *      `${WORKER_URL}/email/opt-in?email=...&e=<expiresAt>&token=<hmac>` を埋め込む
 *   2. LIFF 経路: friendId + idToken 検証済の状態で email + marketing 同意 checkbox を受け取る
 *
 * セキュリティ:
 *   - HMAC-SHA256(secret, `${email}:${expiresAt}`)
 *   - expiresAt = unix timestamp (seconds)、 default 30 days
 *   - 定数時間比較で timing attack 対策
 *   - email は URL 内に露出するが、 token なしでは攻撃不能
 *
 * 関連: routes/email-opt-in.ts、 routes/liff-opt-in.ts
 */

import { recordMarketingOptIn, type ConsentSource } from '@line-crm/db';

// ============================================================
// HMAC token (email + expiresAt 署名)
// ============================================================

const DEFAULT_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * HMAC-SHA256 hex (Web Crypto API、 Cloudflare Workers 互換)。
 * email-unsubscribe.ts と同じ式 (key と payload が異なる、 cross-use 防止のため key は別 secret)。
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

/** 定数時間比較 (timing attack 緩和)。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** email の最低限の sanity check (詳細 RFC 5321 検証は省略、 token 検証が主体)。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string | undefined | null): email is string {
  return typeof email === 'string' && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export interface SignEmailOptInTokenOptions {
  /** unix timestamp (seconds) で expiresAt を明示。 省略時は now + 30 日 */
  expiresAt?: number;
  /** TTL を秒で指定 (expiresAt 省略時に使用)。 default 30 日 */
  ttlSeconds?: number;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface EmailOptInToken {
  email: string;
  expiresAt: number;
  token: string;
}

/**
 * email + expiresAt から HMAC token を生成。
 * URL 化: `?email=${encodeURIComponent(email)}&e=${expiresAt}&token=${token}`
 */
export async function signEmailOptInToken(
  hmacKey: string,
  email: string,
  options: SignEmailOptInTokenOptions = {},
): Promise<EmailOptInToken> {
  if (!hmacKey) throw new Error('hmacKey is required');
  if (!isValidEmail(email)) throw new Error('Invalid email format');

  const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
  const expiresAt =
    options.expiresAt ?? now + (options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS);

  const payload = `${email.toLowerCase()}:${expiresAt}`;
  const token = await hmacSha256Hex(hmacKey, payload);
  return { email, expiresAt, token };
}

export interface VerifyEmailOptInTokenInput {
  email: string;
  expiresAt: number;
  token: string;
  /** test 用 clock 注入 */
  now?: () => number;
}

export type EmailOptInTokenError = 'invalid_format' | 'expired' | 'signature_mismatch';

export interface EmailOptInTokenResult {
  valid: boolean;
  /** valid=false のときに具体的な失敗理由 (UI 出し分け用) */
  error?: EmailOptInTokenError;
}

/**
 * email + expiresAt + token を verify する。
 * 検証順: format → expiry → HMAC 一致 (expiry を先に切ることで HMAC 計算コストを節約)
 */
export async function verifyEmailOptInToken(
  hmacKey: string,
  input: VerifyEmailOptInTokenInput,
): Promise<EmailOptInTokenResult> {
  if (!hmacKey) return { valid: false, error: 'invalid_format' };
  if (!isValidEmail(input.email)) return { valid: false, error: 'invalid_format' };
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    return { valid: false, error: 'invalid_format' };
  }
  if (!/^[a-f0-9]{64}$/i.test(input.token)) {
    return { valid: false, error: 'invalid_format' };
  }

  const now = input.now ? input.now() : Math.floor(Date.now() / 1000);
  if (input.expiresAt < now) {
    return { valid: false, error: 'expired' };
  }

  const payload = `${input.email.toLowerCase()}:${input.expiresAt}`;
  const expected = await hmacSha256Hex(hmacKey, payload);
  if (!constantTimeEqual(expected.toLowerCase(), input.token.toLowerCase())) {
    return { valid: false, error: 'signature_mismatch' };
  }
  return { valid: true };
}

// ============================================================
// Business logic: opt-in 実行 + 結果
// ============================================================

export type OptInChannel = 'liff' | 'web';

export interface PerformOptInInput {
  email: string;
  friendId?: string | null;
  channel: OptInChannel;
  /** consent_source を上書きする場合 (default: 'opt_in_form') */
  consentSource?: ConsentSource;
}

export interface PerformOptInResult {
  subscriberId: string;
  email: string;
  /** new = 新規登録 / re_consent = 既存レコードの更新 (transactional_only → marketing 含む) / reactivated = unsubscribed/bounced からの復活 */
  outcome: 'new' | 're_consent' | 'reactivated';
  /** 既存 complaint 履歴があれば true (caller 側で warning 出し用) */
  hadComplaint: boolean;
}

/**
 * marketing opt-in を実行する。
 *   - 新規 / 既存 transactional / 既存 unsubscribed / 既存 bounce-suppressed すべて active 化
 *   - outcome を返すので caller (admin UI / audit) で表示分岐可能
 */
export async function performEmailOptIn(
  db: D1Database,
  input: PerformOptInInput,
): Promise<PerformOptInResult> {
  if (!isValidEmail(input.email)) throw new Error('Invalid email format');

  // before state を取得して outcome を判定
  const before = await db
    .prepare(`SELECT id, is_active, transactional_only, unsubscribed_at, bounce_count, complaint_count
              FROM email_subscribers WHERE email = ?`)
    .bind(input.email)
    .first<{
      id: string;
      is_active: number;
      transactional_only: number;
      unsubscribed_at: string | null;
      bounce_count: number;
      complaint_count: number;
    }>();

  const consentSource = input.consentSource ?? 'opt_in_form';
  const sub = await recordMarketingOptIn(db, {
    email: input.email,
    friendId: input.friendId ?? null,
    consentSource,
  });

  let outcome: PerformOptInResult['outcome'];
  if (!before) {
    outcome = 'new';
  } else if (before.unsubscribed_at !== null || before.is_active === 0) {
    outcome = 'reactivated';
  } else {
    outcome = 're_consent';
  }

  return {
    subscriberId: sub.id,
    email: sub.email,
    outcome,
    hadComplaint: (before?.complaint_count ?? 0) > 0,
  };
}

// ============================================================
// テスト用 export
// ============================================================
export const __test__ = {
  hmacSha256Hex,
  constantTimeEqual,
  DEFAULT_TOKEN_TTL_SECONDS,
};
