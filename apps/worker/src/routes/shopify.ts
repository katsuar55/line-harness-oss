import { Hono } from 'hono';
import {
  upsertShopifyOrder,
  upsertShopifyCustomer,
  getShopifyOrders,
  getShopifyOrderById,
  getShopifyCustomers,
  getShopifyOrderByShopifyId,
  getShopifyCustomerByShopifyId,
  linkShopifyCustomerToFriend,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const shopify = new Hono<Env>();

// ========== Shopify HMAC-SHA256 署名検証 ==========

async function verifyShopifySignature(secret: string, rawBody: string, hmacHeader: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  // Shopifyはbase64エンコード（Stripeのhexとは異なる）
  const computedHmac = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return computedHmac === hmacHeader;
}

// ========== Shopify Webhookレシーバー ==========

shopify.post('/api/integrations/shopify/webhook', async (c) => {
  try {
    const shopifySecret = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_WEBHOOK_SECRET;
    let body: Record<string, unknown>;

    if (shopifySecret) {
      // 署名検証モード（本番環境）
      const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
      const rawBody = await c.req.text();

      const valid = await verifyShopifySignature(shopifySecret, rawBody, hmacHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      // シークレット未設定（開発環境向け）
      body = await c.req.json<Record<string, unknown>>();
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
    return c.json({ success: true, data: { message: `Topic '${topic}' received but not processed` } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook error:', err);
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

// ========== Shopify手動同期（プレースホルダー） ==========

shopify.post('/api/integrations/shopify/sync', async (c) => {
  return c.json({ success: true, data: { message: 'Manual sync is not yet implemented' } });
});

export { shopify };
