/**
 * Shopify Access Token — Client Credentials Grant で自動取得・キャッシュ
 *
 * Dev Dashboard アプリの Client ID + Secret で24時間有効なトークンを取得。
 * D1 の shopify_tokens テーブルにキャッシュし、期限切れ前に自動リフレッシュ。
 *
 * 参照: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

const TOKEN_REFRESH_MARGIN_MS = 60 * 60_000; // 1時間前にリフレッシュ

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
  expires_in: number; // seconds (typically 86399 = 24h)
}

interface CachedToken {
  access_token: string;
  scope: string | null;
  expires_at: string;
}

/**
 * D1 からキャッシュされたトークンを取得
 */
async function getCachedToken(db: D1Database): Promise<CachedToken | null> {
  return db
    .prepare(`SELECT access_token, scope, expires_at FROM shopify_tokens WHERE id = 'default'`)
    .first<CachedToken>();
}

/**
 * D1 にトークンをキャッシュ（upsert）
 */
async function cacheToken(db: D1Database, token: string, scope: string, expiresAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO shopify_tokens (id, access_token, scope, expires_at) VALUES ('default', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope, expires_at = excluded.expires_at`,
    )
    .bind(token, scope, expiresAt)
    .run();
}

/**
 * キャッシュされたトークンがまだ有効かチェック
 */
function isTokenValid(cached: CachedToken): boolean {
  const expiresAt = new Date(cached.expires_at).getTime();
  return expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS;
}

/**
 * Shopify の Client Credentials Grant でアクセストークンを取得
 */
async function requestNewToken(
  storeDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<ShopifyTokenResponse> {
  const url = `https://${storeDomain}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token API ${res.status}: ${body}`);
  }

  return res.json() as Promise<ShopifyTokenResponse>;
}

/**
 * Shopify Admin API アクセストークンを取得（キャッシュ付き）
 *
 * 1. D1 キャッシュを確認
 * 2. 有効なら返却
 * 3. 期限切れなら Client Credentials Grant で再取得 → キャッシュ更新
 */
export async function getShopifyAccessToken(
  db: D1Database,
  env: {
    SHOPIFY_STORE_DOMAIN?: string;
    SHOPIFY_CLIENT_ID?: string;
    SHOPIFY_CLIENT_SECRET?: string;
  },
): Promise<string> {
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;

  if (!storeDomain || !clientId || !clientSecret) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)');
  }

  // 1. キャッシュ確認
  const cached = await getCachedToken(db);
  if (cached && isTokenValid(cached)) {
    return cached.access_token;
  }

  // 2. 新しいトークンを取得
  const tokenResponse = await requestNewToken(storeDomain, clientId, clientSecret);

  // 3. 有効期限を計算してキャッシュ
  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
  await cacheToken(db, tokenResponse.access_token, tokenResponse.scope, expiresAt);

  console.log(`🔑 Shopify token refreshed (expires ${expiresAt})`);

  return tokenResponse.access_token;
}
