/**
 * Shopify OAuth Install Flow
 *
 * パートナーダッシュボードアプリをストアにインストールするための
 * OAuth 2.0 Authorization Code Grant フロー。
 *
 * フロー:
 *   1. GET /auth/shopify → Shopify 同意画面へリダイレクト
 *   2. マーチャントが承認
 *   3. GET /auth/shopify/callback → コード交換 → トークン保存
 *   4. Client Credentials Grant で自動トークン更新（shopify-token.ts）
 */

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { jstNow } from '@line-crm/db';

const shopifyAuth = new Hono<Env>();

const SCOPES = [
  'read_customers',
  'write_customers',
  'read_inventory',
  'read_orders',
  'write_orders',
  'read_products',
  'write_products',
  'read_fulfillments',
  'read_shipping',
  'read_discounts',
  'write_discounts',
  'read_draft_orders',
  'write_draft_orders',
  'read_price_rules',
  'write_price_rules',
  'read_returns',
  'write_returns',
].join(',');

/**
 * HMAC 検証（Shopify コールバックの署名確認）
 */
async function verifyOAuthHmac(
  query: URLSearchParams,
  clientSecret: string,
): Promise<boolean> {
  const hmac = query.get('hmac');
  if (!hmac) return false;

  const params = new URLSearchParams(query);
  params.delete('hmac');

  const message = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );

  const computed = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return computed === hmac;
}

/**
 * ランダム nonce 生成
 */
function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ========== Step 1: OAuth 開始 ==========

shopifyAuth.get('/auth/shopify', async (c) => {
  try {
    const clientId = c.env.SHOPIFY_CLIENT_ID;
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN;

    if (!clientId || !storeDomain) {
      return c.json({ success: false, error: 'Shopify credentials not configured' }, 500);
    }

    // shop パラメータがあればそちらを優先（Shopify からのリダイレクト時）
    const shop = c.req.query('shop') || storeDomain;

    // CSRF 保護用 nonce を生成して D1 に保存
    const nonce = generateNonce();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString(); // 10分有効

    await c.env.DB.prepare(
      `INSERT INTO shopify_oauth_states (id, nonce, store_domain, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(nonce, nonce, shop, expiresAt)
      .run();

    // Worker URL を自動検出
    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const redirectUri = `${workerUrl}/auth/shopify/callback`;

    const authUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${clientId}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${nonce}`;

    return c.redirect(authUrl);
  } catch (err) {
    console.error('Shopify OAuth start error:', err);
    return c.json({ success: false, error: 'OAuth initialization failed' }, 500);
  }
});

// ========== Step 2: OAuth コールバック ==========

shopifyAuth.get('/auth/shopify/callback', async (c) => {
  try {
    const clientId = c.env.SHOPIFY_CLIENT_ID;
    const clientSecret = c.env.SHOPIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return c.json({ success: false, error: 'Shopify credentials not configured' }, 500);
    }

    const url = new URL(c.req.url);
    const query = url.searchParams;
    const code = query.get('code');
    const shop = query.get('shop');
    const state = query.get('state');

    if (!code || !shop || !state) {
      return c.json({ success: false, error: 'Missing required parameters' }, 400);
    }

    // 1. HMAC 署名検証
    const valid = await verifyOAuthHmac(query, clientSecret);
    if (!valid) {
      return c.json({ success: false, error: 'HMAC verification failed' }, 401);
    }

    // 2. State nonce 検証（CSRF 保護）
    const storedState = await c.env.DB.prepare(
      `SELECT nonce, store_domain, expires_at FROM shopify_oauth_states WHERE nonce = ?`,
    )
      .bind(state)
      .first<{ nonce: string; store_domain: string; expires_at: string }>();

    if (!storedState) {
      return c.json({ success: false, error: 'Invalid state parameter' }, 400);
    }

    // 期限切れチェック
    if (new Date(storedState.expires_at) < new Date()) {
      await c.env.DB.prepare(`DELETE FROM shopify_oauth_states WHERE nonce = ?`)
        .bind(state)
        .run();
      return c.json({ success: false, error: 'State expired, please try again' }, 400);
    }

    // 使用済み nonce を削除
    await c.env.DB.prepare(`DELETE FROM shopify_oauth_states WHERE nonce = ?`)
      .bind(state)
      .run();

    // 3. 認証コードをアクセストークンに交換
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error('Shopify token exchange failed:', errBody);
      return c.json({ success: false, error: 'Token exchange failed' }, 500);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      scope: string;
    };

    // 4. アクセストークンを D1 に保存（shopify_tokens テーブル）
    // OAuth で取得したトークンはオフラインアクセストークン（期限なし）
    const farFuture = '2099-12-31T23:59:59.000Z';
    await c.env.DB.prepare(
      `INSERT INTO shopify_tokens (id, access_token, scope, expires_at)
       VALUES ('default', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         access_token = excluded.access_token,
         scope = excluded.scope,
         expires_at = excluded.expires_at`,
    )
      .bind(tokenData.access_token, tokenData.scope, farFuture)
      .run();

    console.info(`Shopify app installed on ${shop}, scopes: ${tokenData.scope}`);

    // 5. 成功ページを表示
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shopify連携完了</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f6f6f7; }
    .card { background: white; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.1); max-width: 400px; }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #1a1a1a; margin: 0 0 8px; }
    p { font-size: 14px; color: #616161; margin: 0 0 24px; }
    .scope { font-size: 12px; color: #8c8c8c; background: #f6f6f7; border-radius: 8px; padding: 12px; text-align: left; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Shopify連携が完了しました</h1>
    <p>ストア「${shop}」とLINE Harness CRMが接続されました。</p>
    <div class="scope">
      <strong>許可されたスコープ:</strong><br>
      ${tokenData.scope.split(',').join(', ')}
    </div>
  </div>
</body>
</html>`;

    return c.html(html);
  } catch (err) {
    console.error('Shopify OAuth callback error:', err);
    return c.json({ success: false, error: 'OAuth callback failed' }, 500);
  }
});

// ========== Shopify 接続ステータス ==========

shopifyAuth.get('/api/integrations/shopify/status', async (c) => {
  try {
    const cached = await c.env.DB.prepare(
      `SELECT access_token, scope, expires_at FROM shopify_tokens WHERE id = 'default'`,
    ).first<{ access_token: string; scope: string | null; expires_at: string }>();

    if (!cached) {
      return c.json({
        success: true,
        data: { connected: false, storeDomain: c.env.SHOPIFY_STORE_DOMAIN || null },
      });
    }

    // トークンが有効か簡易チェック（Shopify API に問い合わせ）
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN;
    let shopName: string | null = null;

    if (storeDomain && cached.access_token) {
      try {
        const res = await fetch(`https://${storeDomain}/admin/api/2025-07/shop.json`, {
          headers: { 'X-Shopify-Access-Token': cached.access_token },
        });
        if (res.ok) {
          const data = (await res.json()) as { shop: { name: string } };
          shopName = data.shop.name;
        }
      } catch {
        // ネットワークエラーは無視
      }
    }

    return c.json({
      success: true,
      data: {
        connected: true,
        storeDomain: storeDomain || null,
        shopName,
        scope: cached.scope,
        expiresAt: cached.expires_at,
      },
    });
  } catch (err) {
    console.error('Shopify status check error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { shopifyAuth };
