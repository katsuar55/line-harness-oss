import { Hono } from 'hono';
import {
  upsertShopifyOrder,
  upsertShopifyCustomer,
  upsertShopifyProduct,
  getShopifyOrders,
  getShopifyOrderById,
  getShopifyCustomers,
  getShopifyOrderByShopifyId,
  getShopifyCustomerByShopifyId,
  linkShopifyCustomerToFriend,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { verifyShopifySignature } from '../utils/shopify-hmac.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';

const shopify = new Hono<Env>();

// ========== ヘルパー: Webhookログ ==========

async function logWebhook(
  db: D1Database,
  topic: string,
  shopifyId: string | undefined,
  status: string,
  summary?: string,
  error?: string,
): Promise<void> {
  try {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '');
    await db
      .prepare(
        `INSERT INTO shopify_webhook_log (topic, shopify_id, status, summary, error, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(topic, shopifyId ?? null, status, summary ?? null, error ?? null, now)
      .run();
  } catch (err) {
    console.error('Webhook log write failed:', err);
  }
}

// ========== Shopify Webhookレシーバー ==========

shopify.post('/api/integrations/shopify/webhook', async (c) => {
  try {
    const shopifySecret = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_WEBHOOK_SECRET;
    let body: Record<string, unknown>;

    // 署名検証に使うシークレット（SHOPIFY_WEBHOOK_SECRET → SHOPIFY_CLIENT_SECRET の優先順）
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    const webhookSecret = envRecord.SHOPIFY_WEBHOOK_SECRET;
    const clientSecret = envRecord.SHOPIFY_CLIENT_SECRET;
    const signingSecret = webhookSecret || clientSecret;

    if (signingSecret) {
      // 署名検証モード（本番環境）
      const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
      const rawBody = await c.req.text();

      // まず主シークレットで検証
      let valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);

      // 主シークレットで失敗した場合、もう一方で再試行
      if (!valid && webhookSecret && clientSecret && webhookSecret !== clientSecret) {
        valid = await verifyShopifySignature(clientSecret, rawBody, hmacHeader);
        if (valid) {
          console.warn('Shopify HMAC: succeeded with CLIENT_SECRET, not WEBHOOK_SECRET — consider updating SHOPIFY_WEBHOOK_SECRET');
        }
      }

      if (!valid) {
        const topic = c.req.header('X-Shopify-Topic') ?? '';
        const debugInfo = `hmac_len=${hmacHeader.length} body_len=${rawBody.length} tried=${webhookSecret ? 'webhook+client' : 'client_only'}`;
        console.error(`Shopify HMAC failed: ${debugInfo}`);
        await logWebhook(c.env.DB, topic, undefined, 'auth_failed', `HMAC verification failed: ${debugInfo}`);
        return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      // シークレット未設定 — セキュリティのため本番では拒否
      console.error('Shopify webhook rejected: no signing secret configured');
      return c.json({ success: false, error: 'Webhook secret not configured' }, 500);
    }

    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const db = c.env.DB;

    // 注文イベント
    if (topic === 'orders/create' || topic === 'orders/updated') {
      const shopifyOrderId = String(body.id ?? '');

      // 冪等性チェック（orders/create の重複受信対策）
      if (topic === 'orders/create') {
        const existing = await getShopifyOrderByShopifyId(db, shopifyOrderId);
        if (existing) {
          return c.json({ success: true, data: { message: 'Already processed' } });
        }
      }

      const customer = body.customer as Record<string, unknown> | undefined;
      const email = (body.email as string) ?? (customer?.email as string) ?? undefined;
      const phone = (body.phone as string) ?? (customer?.phone as string) ?? undefined;
      const shopifyCustomerId = customer?.id ? String(customer.id) : undefined;
      const totalPrice = body.total_price ? Number(body.total_price) : undefined;
      const lineItemsRaw = body.line_items as Array<Record<string, unknown>> | undefined;

      await logWebhook(db, topic, shopifyOrderId, 'received', `order #${body.order_number ?? '?'} ¥${body.total_price ?? '?'}`);

      const order = await upsertShopifyOrder(db, {
        shopifyOrderId,
        shopifyCustomerId,
        email,
        phone,
        totalPrice,
        currency: (body.currency as string) ?? 'JPY',
        financialStatus: (body.financial_status as string) ?? undefined,
        fulfillmentStatus: (body.fulfillment_status as string) ?? undefined,
        orderNumber: body.order_number ? Number(body.order_number) : undefined,
        lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
        tags: (body.tags as string) ?? undefined,
        metadata: JSON.stringify({ source: 'webhook', topic }),
      });

      await logWebhook(db, topic, shopifyOrderId, 'processed', `saved as ${order.id}`);

      // 非同期処理: フレンドマッチング・タグ付け・イベント発火
      const orderAsyncWork = (async () => {
          try {
            let friendId: string | null = null;

            // メールでフレンドを検索
            if (email) {
              const userByEmail = await db
                .prepare(`SELECT id FROM users WHERE email = ?`)
                .bind(email)
                .first<{ id: string }>();
              if (userByEmail) {
                const friendByUser = await db
                  .prepare(`SELECT id FROM friends WHERE user_id = ?`)
                  .bind(userByEmail.id)
                  .first<{ id: string }>();
                if (friendByUser) {
                  friendId = friendByUser.id;
                }
              }
            }

            // 電話番号でフレンドを検索（メールで見つからない場合）
            if (!friendId && phone) {
              const normalizedPhone = phone.replace(/[^0-9+]/g, '');
              const userByPhone = await db
                .prepare(`SELECT id FROM users WHERE phone = ?`)
                .bind(normalizedPhone)
                .first<{ id: string }>();
              if (userByPhone) {
                const friendByUser = await db
                  .prepare(`SELECT id FROM friends WHERE user_id = ?`)
                  .bind(userByPhone.id)
                  .first<{ id: string }>();
                if (friendByUser) {
                  friendId = friendByUser.id;
                }
              }
            }

            if (friendId) {
              // 注文にフレンドIDを紐付け
              await db
                .prepare(`UPDATE shopify_orders SET friend_id = ?, updated_at = ? WHERE shopify_order_id = ?`)
                .bind(friendId, jstNow(), shopifyOrderId)
                .run();

              // Shopify顧客とフレンドを紐付け
              if (shopifyCustomerId) {
                await linkShopifyCustomerToFriend(db, shopifyCustomerId, friendId);
              }

              // 自動タグ付け: shopify_customer
              const shopifyTag = await db
                .prepare(`SELECT id FROM tags WHERE name = ?`)
                .bind('shopify_customer')
                .first<{ id: string }>();
              if (shopifyTag) {
                await db
                  .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
                  .bind(friendId, shopifyTag.id, jstNow())
                  .run();
              }

              // 自動タグ付け: purchased
              const purchasedTag = await db
                .prepare(`SELECT id FROM tags WHERE name = ?`)
                .bind('purchased')
                .first<{ id: string }>();
              if (purchasedTag) {
                await db
                  .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
                  .bind(friendId, purchasedTag.id, jstNow())
                  .run();
              }

              // イベントバスに発火（自動化ルール用）
              const { fireEvent } = await import('../services/event-bus.js');
              await fireEvent(db, 'purchase_completed', {
                friendId,
                eventData: { source: 'shopify', shopifyOrderId, amount: totalPrice },
              });
            }
          } catch (err) {
            console.error('Shopify webhook async processing error (order):', err);
          }
        })();
      try { c.executionCtx.waitUntil(orderAsyncWork); } catch { /* no exec ctx in tests */ }

      return c.json({ success: true, data: { id: order.id, shopifyOrderId: order.shopify_order_id } });
    }

    // 顧客イベント
    if (topic === 'customers/create' || topic === 'customers/update') {
      const shopifyCustomerId = String(body.id ?? '');
      const email = (body.email as string) ?? undefined;
      const phone = (body.phone as string) ?? undefined;

      await logWebhook(db, topic, shopifyCustomerId, 'received', `${body.first_name ?? ''} ${body.last_name ?? ''}`);

      const customer = await upsertShopifyCustomer(db, {
        shopifyCustomerId,
        email,
        phone,
        firstName: (body.first_name as string) ?? undefined,
        lastName: (body.last_name as string) ?? undefined,
        ordersCount: body.orders_count ? Number(body.orders_count) : undefined,
        totalSpent: body.total_spent ? Number(body.total_spent) : undefined,
        tags: (body.tags as string) ?? undefined,
        metadata: JSON.stringify({ source: 'webhook', topic }),
      });

      await logWebhook(db, topic, shopifyCustomerId, 'processed', `saved as ${customer.id}`);

      // 非同期処理: フレンドマッチング
      const customerAsyncWork = (async () => {
          try {
            let friendId: string | null = null;

            if (email) {
              const userByEmail = await db
                .prepare(`SELECT id FROM users WHERE email = ?`)
                .bind(email)
                .first<{ id: string }>();
              if (userByEmail) {
                const friendByUser = await db
                  .prepare(`SELECT id FROM friends WHERE user_id = ?`)
                  .bind(userByEmail.id)
                  .first<{ id: string }>();
                if (friendByUser) {
                  friendId = friendByUser.id;
                }
              }
            }

            if (!friendId && phone) {
              const normalizedPhone = phone.replace(/[^0-9+]/g, '');
              const userByPhone = await db
                .prepare(`SELECT id FROM users WHERE phone = ?`)
                .bind(normalizedPhone)
                .first<{ id: string }>();
              if (userByPhone) {
                const friendByUser = await db
                  .prepare(`SELECT id FROM friends WHERE user_id = ?`)
                  .bind(userByPhone.id)
                  .first<{ id: string }>();
                if (friendByUser) {
                  friendId = friendByUser.id;
                }
              }
            }

            if (friendId) {
              await linkShopifyCustomerToFriend(db, shopifyCustomerId, friendId);
            }
          } catch (err) {
            console.error('Shopify webhook async processing error (customer):', err);
          }
        })();
      try { c.executionCtx.waitUntil(customerAsyncWork); } catch { /* no exec ctx in tests */ }

      return c.json({ success: true, data: { id: customer.id, shopifyCustomerId: customer.shopify_customer_id } });
    }

    // 未対応のトピック
    await logWebhook(db, topic, String(body.id ?? ''), 'skipped', 'Unhandled topic');
    return c.json({ success: true, data: { message: `Topic '${topic}' received but not processed` } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify Product Webhookレシーバー ==========

shopify.post('/api/integrations/shopify/webhook/product', async (c) => {
  try {
    const envRecord = c.env as unknown as Record<string, string | undefined>;
    const signingSecret = envRecord.SHOPIFY_WEBHOOK_SECRET || envRecord.SHOPIFY_CLIENT_SECRET;
    let body: Record<string, unknown>;

    if (signingSecret) {
      const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
      const rawBody = await c.req.text();
      let valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);

      // フォールバック: CLIENT_SECRET で再試行
      if (!valid && envRecord.SHOPIFY_WEBHOOK_SECRET && envRecord.SHOPIFY_CLIENT_SECRET
          && envRecord.SHOPIFY_WEBHOOK_SECRET !== envRecord.SHOPIFY_CLIENT_SECRET) {
        valid = await verifyShopifySignature(envRecord.SHOPIFY_CLIENT_SECRET, rawBody, hmacHeader);
      }

      if (!valid) {
        return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      console.error('Shopify product webhook rejected: no signing secret configured');
      return c.json({ success: false, error: 'Webhook secret not configured' }, 500);
    }

    const topic = c.req.header('X-Shopify-Topic') ?? '';
    const db = c.env.DB;
    const shopifyProductId = String(body.id ?? '');

    await logWebhook(db, topic, shopifyProductId, 'received', String(body.title ?? ''));

    if (topic === 'products/delete') {
      // 論理削除: ステータスを archived に変更
      await db
        .prepare(`UPDATE shopify_products SET status = 'archived', updated_at = ? WHERE shopify_product_id = ?`)
        .bind(jstNow(), shopifyProductId)
        .run();
      await logWebhook(db, topic, shopifyProductId, 'processed', 'archived');
      return c.json({ success: true, data: { message: 'Product archived', shopifyProductId } });
    }

    // products/create, products/update
    const variants = body.variants as Array<Record<string, unknown>> | undefined;
    const firstVariant = variants?.[0];
    const images = body.images as Array<Record<string, unknown>> | undefined;
    const firstImage = images?.[0];
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN ?? '';

    const statusRaw = (body.status as string) ?? 'active';
    const status = ['active', 'draft', 'archived'].includes(statusRaw)
      ? (statusRaw as 'active' | 'draft' | 'archived')
      : 'draft';

    await upsertShopifyProduct(db, {
      shopifyProductId,
      title: String(body.title ?? ''),
      description: (body.body_html as string) ?? null,
      vendor: (body.vendor as string) ?? null,
      productType: (body.product_type as string) ?? null,
      handle: (body.handle as string) ?? null,
      status,
      imageUrl: (firstImage?.src as string) ?? null,
      price: firstVariant?.price != null ? String(firstVariant.price) : null,
      compareAtPrice: firstVariant?.compare_at_price != null ? String(firstVariant.compare_at_price) : null,
      tags: (body.tags as string) ?? null,
      variantsJson: variants ? JSON.stringify(variants) : null,
      storeUrl: storeDomain ? `https://${storeDomain}/products/${body.handle ?? ''}` : null,
    });

    await logWebhook(db, topic, shopifyProductId, 'processed', `"${body.title}" ${status}`);
    return c.json({ success: true, data: { shopifyProductId, title: body.title } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/product error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify注文一覧 ==========

shopify.get('/api/integrations/shopify/orders', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const email = c.req.query('email') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const items = await getShopifyOrders(c.env.DB, { friendId, email, limit, offset });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        shopifyOrderId: e.shopify_order_id,
        shopifyCustomerId: e.shopify_customer_id,
        friendId: e.friend_id,
        email: e.email,
        phone: e.phone,
        totalPrice: e.total_price,
        currency: e.currency,
        financialStatus: e.financial_status,
        fulfillmentStatus: e.fulfillment_status,
        orderNumber: e.order_number,
        lineItems: e.line_items ? JSON.parse(e.line_items as string) : null,
        tags: e.tags,
        metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/orders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify注文詳細 ==========

shopify.get('/api/integrations/shopify/orders/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getShopifyOrderById(c.env.DB, id);
    if (!item) {
      return c.json({ success: false, error: 'Order not found' }, 404);
    }
    return c.json({
      success: true,
      data: {
        id: item.id,
        shopifyOrderId: item.shopify_order_id,
        shopifyCustomerId: item.shopify_customer_id,
        friendId: item.friend_id,
        email: item.email,
        phone: item.phone,
        totalPrice: item.total_price,
        currency: item.currency,
        financialStatus: item.financial_status,
        fulfillmentStatus: item.fulfillment_status,
        orderNumber: item.order_number,
        lineItems: item.line_items ? JSON.parse(item.line_items as string) : null,
        tags: item.tags,
        metadata: item.metadata ? JSON.parse(item.metadata as string) : null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/orders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify顧客一覧 ==========

shopify.get('/api/integrations/shopify/customers', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const email = c.req.query('email') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const items = await getShopifyCustomers(c.env.DB, { friendId, email, limit, offset });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        shopifyCustomerId: e.shopify_customer_id,
        friendId: e.friend_id,
        email: e.email,
        phone: e.phone,
        firstName: e.first_name,
        lastName: e.last_name,
        ordersCount: e.orders_count,
        totalSpent: e.total_spent,
        tags: e.tags,
        metadata: e.metadata ? JSON.parse(e.metadata as string) : null,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/customers error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify手動同期 ==========

shopify.post('/api/integrations/shopify/sync', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;

    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN is not configured' }, 400);
    }

    // SSRF防止: storeDomain がShopifyドメインであることを検証
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(storeDomain)) {
      return c.json({ success: false, error: 'Invalid SHOPIFY_STORE_DOMAIN format' }, 400);
    }

    const accessToken = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const apiVersion = '2025-07';
    const headers = {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    };

    // --- 商品同期 ---
    const productsRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/products.json`,
      { headers },
    );
    if (!productsRes.ok) {
      console.error(`Shopify Products API error: ${productsRes.status}`);
      return c.json(
        { success: false, error: `Shopify Products API returned ${productsRes.status}` },
        502,
      );
    }

    const productsData = (await productsRes.json()) as {
      products: Array<Record<string, unknown>>;
    };
    const products = productsData.products ?? [];

    let productsSynced = 0;
    for (const p of products) {
      const variants = p.variants as Array<Record<string, unknown>> | undefined;
      const firstVariant = variants?.[0];
      const images = p.images as Array<Record<string, unknown>> | undefined;
      const firstImage = images?.[0];

      await upsertShopifyProduct(db, {
        shopifyProductId: String(p.id),
        title: String(p.title ?? ''),
        description: (p.body_html as string) ?? null,
        vendor: (p.vendor as string) ?? null,
        productType: (p.product_type as string) ?? null,
        handle: (p.handle as string) ?? null,
        status: ['active', 'draft', 'archived'].includes(p.status as string)
          ? (p.status as 'active' | 'draft' | 'archived')
          : 'active',
        imageUrl: (firstImage?.src as string) ?? null,
        price: firstVariant?.price != null ? String(firstVariant.price) : null,
        compareAtPrice: firstVariant?.compare_at_price != null
          ? String(firstVariant.compare_at_price)
          : null,
        tags: (p.tags as string) ?? null,
        variantsJson: variants ? JSON.stringify(variants) : null,
        storeUrl: `https://${storeDomain}/products/${p.handle ?? ''}`,
      });
      productsSynced++;
    }

    // --- 注文同期 ---
    const ordersRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/orders.json?status=any&limit=50`,
      { headers },
    );
    if (!ordersRes.ok) {
      console.error(`Shopify Orders API error: ${ordersRes.status}`);
      return c.json(
        { success: false, error: `Shopify Orders API returned ${ordersRes.status}` },
        502,
      );
    }

    const ordersData = (await ordersRes.json()) as {
      orders: Array<Record<string, unknown>>;
    };
    const orders = ordersData.orders ?? [];

    let ordersSynced = 0;
    for (const o of orders) {
      const customer = o.customer as Record<string, unknown> | undefined;
      const lineItemsRaw = o.line_items as Array<Record<string, unknown>> | undefined;

      await upsertShopifyOrder(db, {
        shopifyOrderId: String(o.id),
        shopifyCustomerId: customer?.id ? String(customer.id) : undefined,
        email: (o.email as string) ?? (customer?.email as string) ?? undefined,
        phone: (o.phone as string) ?? (customer?.phone as string) ?? undefined,
        totalPrice: o.total_price ? Number(o.total_price) : undefined,
        currency: (o.currency as string) ?? 'JPY',
        financialStatus: (o.financial_status as string) ?? undefined,
        fulfillmentStatus: (o.fulfillment_status as string) ?? undefined,
        orderNumber: o.order_number ? Number(o.order_number) : undefined,
        lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
        tags: (o.tags as string) ?? undefined,
        metadata: JSON.stringify({ source: 'manual_sync' }),
      });
      ordersSynced++;
    }

    // --- 顧客同期 ---
    const customersRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/customers.json?limit=250`,
      { headers },
    );
    let customersSynced = 0;
    if (customersRes.ok) {
      const customersData = (await customersRes.json()) as {
        customers: Array<Record<string, unknown>>;
      };
      const customers = customersData.customers ?? [];

      for (const cust of customers) {
        await upsertShopifyCustomer(db, {
          shopifyCustomerId: String(cust.id),
          email: (cust.email as string) ?? undefined,
          phone: (cust.phone as string) ?? undefined,
          firstName: (cust.first_name as string) ?? undefined,
          lastName: (cust.last_name as string) ?? undefined,
          ordersCount: cust.orders_count ? Number(cust.orders_count) : undefined,
          totalSpent: cust.total_spent ? Number(cust.total_spent) : undefined,
          tags: (cust.tags as string) ?? undefined,
          metadata: JSON.stringify({ source: 'manual_sync' }),
        });
        customersSynced++;
      }
    }

    return c.json({
      success: true,
      data: {
        message: 'Shopify sync completed',
        productsSynced,
        ordersSynced,
        customersSynced,
      },
    });
  } catch (err) {
    console.error('POST /api/integrations/shopify/sync error:', err);
    return c.json({ success: false, error: 'Shopify sync failed' }, 500);
  }
});

// ========== Shopify Webhook登録 ==========

shopify.post('/api/integrations/shopify/webhooks/register', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;
    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 400);
    }

    const token = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const apiVersion = '2025-07';

    const webhookTopics = [
      { topic: 'orders/create', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'orders/updated', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'customers/create', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'customers/update', address: `${workerUrl}/api/integrations/shopify/webhook` },
      { topic: 'products/create', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'products/update', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'products/delete', address: `${workerUrl}/api/integrations/shopify/webhook/product` },
      { topic: 'fulfillments/create', address: `${workerUrl}/api/integrations/shopify/webhook/fulfillment` },
      { topic: 'fulfillments/update', address: `${workerUrl}/api/integrations/shopify/webhook/fulfillment` },
    ];

    const results: Array<{ topic: string; status: string; id?: string }> = [];

    for (const wh of webhookTopics) {
      const res = await fetch(
        `https://${storeDomain}/admin/api/${apiVersion}/webhooks.json`,
        {
          method: 'POST',
          headers: {
            'X-Shopify-Access-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            webhook: {
              topic: wh.topic,
              address: wh.address,
              format: 'json',
            },
          }),
        },
      );

      if (res.ok) {
        const data = (await res.json()) as { webhook: { id: number } };
        results.push({ topic: wh.topic, status: 'created', id: String(data.webhook.id) });
      } else {
        const errBody = await res.text();
        // 既に登録済みの場合は "already exists" が含まれる
        if (errBody.includes('already') || errBody.includes('taken')) {
          results.push({ topic: wh.topic, status: 'already_exists' });
        } else {
          results.push({ topic: wh.topic, status: `error: ${res.status}` });
        }
      }
    }

    return c.json({ success: true, data: { webhooks: results } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhooks/register error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Shopify Webhook一覧 ==========

shopify.get('/api/integrations/shopify/webhooks', async (c) => {
  try {
    const db = c.env.DB;
    const storeDomain = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_STORE_DOMAIN;
    if (!storeDomain) {
      return c.json({ success: false, error: 'SHOPIFY_STORE_DOMAIN not configured' }, 400);
    }

    const token = await getShopifyAccessToken(db, c.env as unknown as Record<string, string | undefined>);
    const apiVersion = '2025-07';

    const res = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/webhooks.json`,
      { headers: { 'X-Shopify-Access-Token': token } },
    );

    if (!res.ok) {
      const body = await res.text();
      return c.json({ success: false, error: `Shopify API ${res.status}: ${body}` }, 502);
    }

    const data = (await res.json()) as {
      webhooks: Array<{ id: number; topic: string; address: string; created_at: string }>;
    };

    return c.json({
      success: true,
      data: data.webhooks.map((w) => ({
        id: w.id,
        topic: w.topic,
        address: w.address,
        createdAt: w.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/webhooks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { shopify };
