/**
 * Shopify Access Token — Client Credentials Grant で自動取得・キャッシュ
 *
 * Dev Dashboard アプリの Client ID + Secret で24時間有効なトークンを取得。
 * D1 の shopify_tokens テーブルにキャッシュし、期限切れ前に自動リフレッシュ。
 *
 * 参照: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 */

const TOKEN_REFRESH_MARGIN_MS = 60 * 60_000; // 1時間前にリフレッシュ
const AES_ALGO = 'AES-GCM';
const IV_LENGTH = 12; // AES-GCM 推奨 IV長

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

// ========== AES-GCM 暗号化ヘルパー（オプション） ==========

async function deriveKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('shopify-token-v1'), iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: AES_ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptToken(plaintext: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, encoded);
  // Format: base64(iv + ciphertext)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptToken(encrypted: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: AES_ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

function isEncrypted(value: string): boolean {
  // 暗号化済みトークンはbase64で長くなる。Shopifyの平文トークンは "shpca_" で始まる
  return !value.startsWith('shpca_') && !value.startsWith('shpat_');
}

// ========== D1 キャッシュ操作 ==========

/**
 * D1 からキャッシュされたトークンを取得（暗号化対応）
 */
async function getCachedToken(db: D1Database, encryptionKey?: string): Promise<CachedToken | null> {
  const row = await db
    .prepare(`SELECT access_token, scope, expires_at FROM shopify_tokens WHERE id = 'default'`)
    .first<CachedToken>();
  if (!row) return null;

  // 暗号化キーがあり、トークンが暗号化済みなら復号
  if (encryptionKey && isEncrypted(row.access_token)) {
    try {
      row.access_token = await decryptToken(row.access_token, encryptionKey);
    } catch {
      // 復号失敗（キー変更等）→ キャッシュ無効として扱う
      console.warn('Shopify token decryption failed — treating as expired');
      return null;
    }
  }
  return row;
}

/**
 * D1 にトークンをキャッシュ（upsert、暗号化対応）
 */
async function cacheToken(db: D1Database, token: string, scope: string, expiresAt: string, encryptionKey?: string): Promise<void> {
  const storedToken = encryptionKey ? await encryptToken(token, encryptionKey) : token;
  await db
    .prepare(
      `INSERT INTO shopify_tokens (id, access_token, scope, expires_at) VALUES ('default', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope, expires_at = excluded.expires_at`,
    )
    .bind(storedToken, scope, expiresAt)
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
    SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  },
): Promise<string> {
  const storeDomain = env.SHOPIFY_STORE_DOMAIN;
  const clientId = env.SHOPIFY_CLIENT_ID;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET;
  const encryptionKey = env.SHOPIFY_TOKEN_ENCRYPTION_KEY;

  if (!storeDomain || !clientId || !clientSecret) {
    throw new Error('Shopify credentials not configured (SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET)');
  }

  // 1. キャッシュ確認
  const cached = await getCachedToken(db, encryptionKey);
  if (cached && isTokenValid(cached)) {
    return cached.access_token;
  }

  // 2. 新しいトークンを取得
  const tokenResponse = await requestNewToken(storeDomain, clientId, clientSecret);

  // 3. 有効期限を計算してキャッシュ（暗号化キーがあれば暗号化保存）
  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
  await cacheToken(db, tokenResponse.access_token, tokenResponse.scope, expiresAt, encryptionKey);

  console.log(`Shopify token refreshed (expires ${expiresAt}, encrypted=${!!encryptionKey})`);

  return tokenResponse.access_token;
}
