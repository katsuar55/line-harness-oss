import { Hono } from 'hono';
import {
  getShopifyProducts,
  getShopifyProductById,
  getShopifyProductByShopifyId,
  deleteShopifyProduct,
  upsertShopifyProduct,
} from '@line-crm/db';
import type { ShopifyProduct as DbProduct } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { syncProductFromWebhook, buildProductCarousel, sendProductRecommendations } from '../services/product-display.js';
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

// POST /api/integrations/shopify/webhook/product — product webhook handler
shopifyProducts.post('/api/integrations/shopify/webhook/product', async (c) => {
  try {
    const topic = c.req.header('X-Shopify-Topic') || '';
    const rawBody = await c.req.text();

    // Verify HMAC signature if secret is configured
    const hmac = c.req.header('X-Shopify-Hmac-Sha256');
    if (c.env.SHOPIFY_WEBHOOK_SECRET && hmac) {
      const { verifyShopifySignature } = await import('../utils/shopify-hmac.js');
      const valid = await verifyShopifySignature(c.env.SHOPIFY_WEBHOOK_SECRET, rawBody, hmac);
      if (!valid) {
        return c.json({ success: false, error: 'Invalid signature' }, 401);
      }
    }

    const body = JSON.parse(rawBody);

    if (topic === 'products/delete') {
      const shopifyId = String(body.id);
      const existing = await getShopifyProductByShopifyId(c.env.DB, shopifyId);
      if (existing) {
        await deleteShopifyProduct(c.env.DB, existing.id);
      }
      return c.json({ success: true, data: { action: 'deleted', shopifyProductId: shopifyId } });
    }

    // products/create or products/update
    const product = await syncProductFromWebhook(
      c.env.DB,
      body,
      c.env.SHOPIFY_STORE_DOMAIN,
    );

    return c.json({ success: true, data: { action: 'synced', id: product.id } });
  } catch (err) {
    console.error('Shopify product webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { shopifyProducts };
