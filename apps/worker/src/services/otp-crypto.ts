/**
 * OTP crypto helpers (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * email OTP の hash 化 / 定数時間比較 / 数値コード生成。
 *
 * NOTE: 同形式の HMAC-SHA256 / 定数時間比較は email-opt-in.ts / email-unsubscribe.ts にもあるが、
 *   consent 系コードへの blast radius を避けるため、 新規 feature では本 util を使う
 *   (= 3 箇所の将来的 consolidation は別 PR。 本 PR では既存 consent コードを触らない)。
 */

/**
 * HMAC-SHA256 hex (Web Crypto API、 Cloudflare Workers 互換)。
 * OTP は `HMAC(pepper, "friend:email:code")` で hash 化し、 平文を保存しない。
 * pepper (= server secret、 D1 外) により D1 dump 単体の offline 総当たりを防ぐ。
 */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定数時間比較 (timing attack 緩和)。 長さが異なれば即 false。 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * digits 桁の数値 OTP を crypto.getRandomValues で生成 (= 0 埋め)。
 * modulo bias を避けるため rejection sampling: 0-249 のみ採用し %10 で一様分布
 * (250 = 25×10 で割り切れる。 250-255 は破棄)。
 */
export function generateNumericCode(digits = 6): string {
  let out = '';
  const buf = new Uint8Array(1);
  while (out.length < digits) {
    crypto.getRandomValues(buf);
    const b = buf[0];
    if (b >= 250) continue; // bias 範囲を破棄
    out += (b % 10).toString();
  }
  return out;
}
