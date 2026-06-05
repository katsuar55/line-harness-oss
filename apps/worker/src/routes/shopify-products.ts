import { Hono } from 'hono';
import {
  getShopifyProducts,
  getShopifyProductById,
  deleteShopifyProduct,
  upsertShopifyProduct,
} from '@line-crm/db';
import type { ShopifyProduct as DbProduct } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { buildProductCarousel, sendProductRecommendations } from '../services/product-display.js';
import type { Env } from '../index.js';

const shopifyProducts = new Hono<Env>();

function serializeProduct(row: DbProduct) {
  return {
    id: row.id,
    shopifyProductId: row.shopify_product_id,
    title: row.title,
    description: row.description,
    vendor: row.vendor,
    productType: row.product_type,
    handle: row.handle,
    status: row.status,
    imageUrl: row.image_url,
    price: row.price,
    compareAtPrice: row.compare_at_price,
    tags: row.tags,
    storeUrl: row.store_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// GET /api/shopify/products — list products
shopifyProducts.get('/api/shopify/products', async (c) => {
  try {
    const status = c.req.query('status') || 'active';
    const productType = c.req.query('productType');
    const limit = Number(c.req.query('limit') || '50');
    const offset = Number(c.req.query('offset') || '0');

    const products = await getShopifyProducts(c.env.DB, {
      status,
      productType: productType || undefined,
      limit,
      offset,
    });

    return c.json({ success: true, data: products.map(serializeProduct) });
  } catch (err) {
    console.error('GET /api/shopify/products error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ㉗ GET /api/shopify/products/new-arrivals — 新着商品（※ :id より前に定義）
shopifyProducts.get('/api/shopify/products/new-arrivals', async (c) => {
  try {
    const limit = Number(c.req.query('limit') || '10');
    const productType = c.req.query('productType');
    const db = c.env.DB;

    let sql = `SELECT * FROM shopify_products WHERE status = 'active'`;
    const binds: unknown[] = [];
    if (productType) {
      sql += ` AND product_type = ?`;
      binds.push(productType);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    binds.push(limit);

    const result = await (binds.length > 0
      ? db.prepare(sql).bind(...binds)
      : db.prepare(sql)
    ).all<DbProduct>();

    return c.json({ success: true, data: result.results.map(serializeProduct) });
  } catch (err) {
    console.error('GET /api/shopify/products/new-arrivals error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/shopify/products/:id — get single product
shopifyProducts.get('/api/shopify/products/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const product = await getShopifyProductById(c.env.DB, id);

    if (!product) {
      return c.json({ success: false, error: 'Product not found' }, 404);
    }

    return c.json({ success: true, data: serializeProduct(product) });
  } catch (err) {
    console.error('GET /api/shopify/products/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/shopify/products — manual product upsert
shopifyProducts.post('/api/shopify/products', async (c) => {
  try {
    const body = await c.req.json<{
      shopifyProductId: string;
      title: string;
      description?: string;
      vendor?: string;
      productType?: string;
      handle?: string;
      status?: 'active' | 'draft' | 'archived';
      imageUrl?: string;
      price?: string;
      compareAtPrice?: string;
      tags?: string;
      storeUrl?: string;
    }>();

    if (!body.shopifyProductId || !body.title) {
      return c.json({ success: false, error: 'shopifyProductId and title are required' }, 400);
    }

    const product = await upsertShopifyProduct(c.env.DB, {
      shopifyProductId: body.shopifyProductId,
      title: body.title,
      description: body.description ?? null,
      vendor: body.vendor ?? null,
      productType: body.productType ?? null,
      handle: body.handle ?? null,
      status: body.status,
      imageUrl: body.imageUrl ?? null,
      price: body.price ?? null,
      compareAtPrice: body.compareAtPrice ?? null,
      tags: body.tags ?? null,
      storeUrl: body.storeUrl ?? null,
    });

    return c.json({ success: true, data: serializeProduct(product) }, 201);
  } catch (err) {
    console.error('POST /api/shopify/products error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/shopify/products/:id — delete product
shopifyProducts.delete('/api/shopify/products/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await deleteShopifyProduct(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/shopify/products/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/shopify/products/preview-carousel — preview Flex carousel message
shopifyProducts.post('/api/shopify/products/preview-carousel', async (c) => {
  try {
    const body = await c.req.json<{ productIds?: string[]; limit?: number }>();
    let products: DbProduct[];

    if (body.productIds && body.productIds.length > 0) {
      const fetched = await Promise.all(
        body.productIds.map((id) => getShopifyProductById(c.env.DB, id)),
      );
      products = fetched.filter((p): p is DbProduct => p !== null);
    } else {
      products = await getShopifyProducts(c.env.DB, {
        status: 'active',
        limit: body.limit ?? 5,
      });
    }

    const message = buildProductCarousel(products);
    if (!message) {
      return c.json({ success: false, error: 'No active products found' }, 404);
    }

    return c.json({ success: true, data: message });
  } catch (err) {
    console.error('POST /api/shopify/products/preview-carousel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/shopify/products/send — send product recommendations to a friend
shopifyProducts.post('/api/shopify/products/send', async (c) => {
  try {
    const body = await c.req.json<{
      friendId: string;
      friendLineUserId: string;
      triggerType?: 'purchase' | 'browse' | 'restock' | 'manual' | 'scheduled';
      productType?: string;
      limit?: number;
    }>();

    if (!body.friendId || !body.friendLineUserId) {
      return c.json({ success: false, error: 'friendId and friendLineUserId are required' }, 400);
    }

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await sendProductRecommendations(
      c.env.DB,
      lineClient,
      body.friendLineUserId,
      body.friendId,
      {
        triggerType: body.triggerType,
        productType: body.productType,
        limit: body.limit,
      },
    );

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/shopify/products/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// NOTE (2026-05-30 code review): the POST /api/integrations/shopify/webhook/product
// handler that lived here was DEAD CODE. routes/shopify.ts mounts first (index.ts)
// and registers the same path+method, so Hono routed every product webhook to
// shopify.ts and this handler never executed. It also carried a broken recipient
// query (JOIN sp.shopify_product_id = so.shopify_customer_id — disjoint id spaces)
// and divergent delete semantics (hard-delete vs shopify.ts soft-archive).
// Removed to eliminate the silent shadow. The products/create auto-notify feature
// it attempted was never live; re-implement it in shopify.ts with a correct
// product_type→recipient query if desired (see CODE_REVIEW_2026-05-30.md rank #10/#20).

export { shopifyProducts };
