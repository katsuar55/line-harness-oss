/**
 * Svix webhook 署名検証 (Resend Webhook 用 — Round 4 PR-4)
 *
 * Svix 仕様:
 * - Headers:
 *   - `svix-id`: 一意 ID
 *   - `svix-timestamp`: Unix timestamp (秒)
 *   - `svix-signature`: `v1,<base64sig> v1,<base64sig>` (rotation 時複数)
 * - 署名対象文字列: `${svix-id}.${svix-timestamp}.${body}`
 * - 署名アルゴリズム: HMAC-SHA256 + base64
 * - secret 形式: `whsec_<base64>` → prefix を剥がし base64 デコードして HMAC 鍵に
 *
 * セキュリティ:
 * - 5 分以上古い timestamp は replay 攻撃として reject
 * - crypto.subtle.verify でタイミングセーフ比較
 *
 * 参考: https://docs.svix.com/receiving/verifying-payloads/how-manual
 */

const TOLERANCE_SECONDS = 5 * 60;

export interface SvixVerifyInput {
  /** raw body (JSON 文字列、署名計算に使う) */
  body: string;
  /** webhook secret (例: `whsec_...`) */
  secret: string;
  /** svix-id ヘッダ */
  svixId: string;
  /** svix-timestamp ヘッダ (Unix 秒の文字列) */
  svixTimestamp: string;
  /** svix-signature ヘッダ (`v1,<base64> v1,<base64>` 形式) */
  svixSignature: string;
  /** 現在時刻 (テスト用 override、デフォルト Date.now()) */
  now?: Date;
}

export type SvixVerifyResult =
  | { valid: true }
  | { valid: false; reason: 'missing_headers' | 'malformed_secret' | 'timestamp_out_of_range' | 'no_v1_signature' | 'signature_mismatch' };

export async function verifySvixSignature(
  input: SvixVerifyInput,
): Promise<SvixVerifyResult> {
  if (!input.svixId || !input.svixTimestamp || !input.svixSignature || !input.body) {
    return { valid: false, reason: 'missing_headers' };
  }

  // secret prefix 確認 + デコード
  if (!input.secret.startsWith('whsec_')) {
    return { valid: false, reason: 'malformed_secret' };
  }
  let secretBytes: Uint8Array;
  try {
    const b64 = input.secret.slice('whsec_'.length);
    secretBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return { valid: false, reason: 'malformed_secret' };
  }

  // timestamp range check
  const ts = Number.parseInt(input.svixTimestamp, 10);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }
  const nowSec = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_out_of_range' };
  }

  // 署名対象文字列
  const message = `${input.svixId}.${input.svixTimestamp}.${input.body}`;

  // 署名ヘッダから v1 形式を抽出 (複数あれば全て試す)
  const v1Sigs = input.svixSignature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice('v1,'.length));

  if (v1Sigs.length === 0) {
    return { valid: false, reason: 'no_v1_signature' };
  }

  // HMAC 鍵をインポート
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  for (const sigB64 of v1Sigs) {
    let sigBytes: Uint8Array;
    try {
      sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    } catch {
      continue;
    }
    const ok = await crypto.subtle.verify(
      'HMAC',
      cryptoKey,
      sigBytes,
      enc.encode(message),
    );
    if (ok) return { valid: true };
  }

  return { valid: false, reason: 'signature_mismatch' };
}
