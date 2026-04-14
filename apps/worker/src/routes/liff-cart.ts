/**
 * ㉘ LIFF カート — LINE内購入フロー
 *
 * - GET    /api/liff/cart              — カート内容取得
 * - POST   /api/liff/cart              — カートに商品追加
 * - PUT    /api/liff/cart/:itemId      — 数量変更
 * - DELETE /api/liff/cart/:itemId      — カートから削除
 * - POST   /api/liff/cart/checkout     — Shopifyチェックアウト URL 生成
 * - GET    /api/liff/cart/checkout-url — 単品購入用リダイレクト URL
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

export const liffCart = new Hono<Env>();

// GET /api/liff/cart — カート取得
liffCart.get('/api/liff/cart', async (c) => {
  try {
    const liffUser = c.get('liffUser');
    const friendId = liffUser.friendId;
    const db = c.env.DB;

    const items = await db
      .prepare(
        `SELECT lc.*, sp.title as product_title, sp.image_url, sp.handle, sp.store_url
         FROM liff_carts lc
         LEFT JOIN shopify_products sp ON sp.shopify_product_id = lc.shopify_product_id
         WHERE lc.friend_id = ?
         ORDER BY lc.created_at ASC`,
      )
      .bind(friendId)
      .all<Record<string, unknown>>();

    const total = items.results.reduce((sum, item) => {
      return sum + (Number(item.price) || 0) * (Number(item.quantity) || 1);
    }, 0);

    return c.json({
      success: true,
      data: {
        items: items.results.map((item) => ({
          id: item.id,
          shopifyVariantId: item.shopify_variant_id,
          shopifyProductId: item.shopify_product_id,
          title: item.title || item.product_title,
          imageUrl: item.image_url,
          price: Number(item.price),
          quantity: Number(item.quantity),
          handle: item.handle,
        })),
        total,
        itemCount: items.results.length,
      },
    });
  } catch (err) {
    console.error('GET /api/liff/cart error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/liff/cart — カートに追加
liffCart.post('/api/liff/cart', async (c) => {
  try {
    const liffUser = c.get('liffUser');
    const friendId = liffUser.friendId;
    const body = await c.req.json<{
      shopifyVariantId: string;
      shopifyProductId?: string;
      title?: string;
      imageUrl?: string;
      price: number;
      quantity?: number;
    }>();

    if (!body.shopifyVariantId || body.price == null) {
      return c.json({ success: false, error: 'shopifyVariantId and price are required' }, 400);
    }

    const db = c.env.DB;
    const now = jstNow();

    // UPSERT — 同一variant既存なら数量加算
    const existing = await db
      .prepare('SELECT id, quantity FROM liff_carts WHERE friend_id = ? AND shopify_variant_id = ?')
      .bind(friendId, body.shopifyVariantId)
      .first<{ id: string; quantity: number }>();

    if (existing) {
      const newQty = existing.quantity + (body.quantity ?? 1);
      await db
        .prepare('UPDATE liff_carts SET quantity = ?, updated_at = ? WHERE id = ?')
        .bind(newQty, now, existing.id)
        .run();
      return c.json({ success: true, data: { id: existing.id, quantity: newQty } });
    }

    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO liff_carts (id, friend_id, shopify_variant_id, shopify_product_id, title, image_url, price, quantity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        friendId,
        body.shopifyVariantId,
        body.shopifyProductId ?? null,
        body.title ?? null,
        body.imageUrl ?? null,
        body.price,
        body.quantity ?? 1,
        now,
        now,
      )
      .run();

    return c.json({ success: true, data: { id, quantity: body.quantity ?? 1 } }, 201);
  } catch (err) {
    console.error('POST /api/liff/cart error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/liff/cart/:itemId — 数量変更
liffCart.put('/api/liff/cart/:itemId', async (c) => {
  try {
    const liffUser = c.get('liffUser');
    const itemId = c.req.param('itemId');
    const body = await c.req.json<{ quantity: number }>();

    if (!body.quantity || body.quantity < 1) {
      return c.json({ success: false, error: 'quantity must be >= 1' }, 400);
    }

    const db = c.env.DB;
    await db
      .prepare('UPDATE liff_carts SET quantity = ?, updated_at = ? WHERE id = ? AND friend_id = ?')
      .bind(body.quantity, jstNow(), itemId, liffUser.friendId)
      .run();

    return c.json({ success: true, data: { id: itemId, quantity: body.quantity } });
  } catch (err) {
    console.error('PUT /api/liff/cart/:itemId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/liff/cart/:itemId — カートから削除
liffCart.delete('/api/liff/cart/:itemId', async (c) => {
  try {
    const liffUser = c.get('liffUser');
    const db = c.env.DB;
    await db
      .prepare('DELETE FROM liff_carts WHERE id = ? AND friend_id = ?')
      .bind(c.req.param('itemId'), liffUser.friendId)
      .run();
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/liff/cart/:itemId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/liff/cart/checkout — Shopify チェックアウト URL 生成
// カート内全商品を /cart/{variant_id}:{qty},{variant_id}:{qty} 形式でまとめてリダイレクト
liffCart.post('/api/liff/cart/checkout', async (c) => {
  try {
    const liffUser = c.get('liffUser');
    const db = c.env.DB;
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN;

    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 500);
    }

    const items = await db
      .prepare('SELECT shopify_variant_id, quantity FROM liff_carts WHERE friend_id = ?')
      .bind(liffUser.friendId)
      .all<{ shopify_variant_id: string; quantity: number }>();

    if (items.results.length === 0) {
      return c.json({ success: false, error: 'Cart is empty' }, 400);
    }

    // Shopify cart permalink: https://{store}/cart/{variant_id}:{qty},{variant_id}:{qty}
    const cartItems = items.results
      .map((item) => `${item.shopify_variant_id}:${item.quantity}`)
      .join(',');
    const checkoutUrl = `https://${storeDomain}/cart/${cartItems}`;

    // カートをクリア（チェックアウト開始後）
    await db
      .prepare('DELETE FROM liff_carts WHERE friend_id = ?')
      .bind(liffUser.friendId)
      .run();

    return c.json({
      success: true,
      data: { checkoutUrl, itemCount: items.results.length },
    });
  } catch (err) {
    console.error('POST /api/liff/cart/checkout error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/liff/cart/checkout-url — 単品クイック購入 URL（variantId + quantity）
liffCart.get('/api/liff/cart/checkout-url', async (c) => {
  try {
    const variantId = c.req.query('variantId');
    const quantity = c.req.query('quantity') || '1';
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN;

    if (!variantId) {
      return c.json({ success: false, error: 'variantId is required' }, 400);
    }
    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 500);
    }

    const checkoutUrl = `https://${storeDomain}/cart/${variantId}:${quantity}`;
    return c.json({ success: true, data: { checkoutUrl } });
  } catch (err) {
    console.error('GET /api/liff/cart/checkout-url error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
