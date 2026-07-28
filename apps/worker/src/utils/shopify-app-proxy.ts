/**
 * Shopify App Proxy 署名検証 (2026-07-29)
 *
 * App Proxy 経由のリクエスト (storefront `/apps/...` → worker) には `signature` query が付く。
 * 計算方法は webhook の HMAC (base64 / raw body) とは**別物**:
 *   1. query から `signature` を除外
 *   2. 各キーを `key=value` に (同一キー複数値はカンマ結合: `extra=1,2`)
 *   3. キーの辞書順に sort し、**区切り文字なし**で連結
 *   4. app の client secret (= shared secret) で HMAC-SHA256 → hex
 *   5. `signature` と定数時間比較
 * 参照: https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *
 * 併せて timestamp の鮮度を検証する (= 署名済み URL の replay 窓を狭める。
 * ready ページの token は本人のブラウザにしか出ないが、 URL が履歴/ログ経由で漏れた場合の
 * 「他人の logged_in_customer_id で token を再発行させる」replay をここで遮断する)。
 */

/** timestamp 許容ずれ (秒)。 Shopify は転送時に発行するので通常は数秒以内に届く。 */
export const APP_PROXY_TIMESTAMP_TOLERANCE_SEC = 90;

export type AppProxyVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'bad_signature' | 'stale_timestamp' };

/** hex 文字列同士の定数時間比較 (= 早期 return による timing oracle を作らない)。 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 署名対象メッセージを構築する。
 * URLSearchParams は同一キー複数値を保持するので getAll でカンマ結合する (公式仕様)。
 */
export function buildAppProxyMessage(query: URLSearchParams): string {
  const keys = [...new Set([...query.keys()])].filter((k) => k !== 'signature');
  return keys
    .map((k) => `${k}=${query.getAll(k).join(',')}`)
    .sort()
    .join('');
}

/**
 * App Proxy 署名 + timestamp 鮮度を検証する。
 * @param query    転送リクエストの query (signature / timestamp を含む生の値)
 * @param secret   Shopify app の client secret
 * @param nowMs    現在時刻 (テスト注入用。 既定 Date.now())
 */
export async function verifyAppProxySignature(
  query: URLSearchParams,
  secret: string,
  nowMs: number = Date.now(),
): Promise<AppProxyVerifyResult> {
  const signature = query.get('signature');
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: 'missing_signature' };
  }

  const message = buildAppProxyMessage(query);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const computed = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (!timingSafeEqualHex(computed, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // 署名検証**後**に timestamp を見る (= 未署名リクエストに timestamp 有無の oracle を与えない)。
  // timestamp は署名対象に含まれるため、 ここまで来た値は Shopify が発行したもの。
  const ts = Number(query.get('timestamp'));
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > APP_PROXY_TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  return { ok: true };
}
