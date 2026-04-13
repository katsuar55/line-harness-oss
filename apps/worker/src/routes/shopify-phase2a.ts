import { Hono } from 'hono';
import {
  upsertAbandonedCart,
  getAbandonedCartByCheckoutId,
  upsertShopifyFulfillment,
  getPaymentNotificationByOrder,
  createPaymentNotification,
  createRestockRequest,
  getRestockRequestsByFriend,
  getRestockRequestsByVariant,
  cancelRestockRequest,
  updateRestockRequestStatus,
  getShopifyCoupons,
  createShopifyCoupon,
  updateShopifyCoupon,
  deleteShopifyCoupon,
  assignCoupon,
  getCouponAssignmentsByFriend,
  getMemberRanks,
  createMemberRank,
  updateMemberRank,
  deleteMemberRank,
  getFriendRank,
  calculateAndUpdateFriendRank,
  jstNow,
  getShopifyOrderByShopifyId,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { verifyShopifySignature } from '../utils/shopify-hmac.js';

const shopifyPhase2a = new Hono<Env>();

// ========== ヘルパー: Webhookログ ==========

async function logWebhook(
  db: D1Database,
  topic: string,
  shopifyId: string | undefined,
  status: string,
  summary?: string,
): Promise<void> {
  try {
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '');
    await db
      .prepare(
        `INSERT INTO shopify_webhook_log (topic, shopify_id, status, summary, error, received_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(topic, shopifyId ?? null, status, summary ?? null, null, now)
      .run();
  } catch (err) {
    console.error('Webhook log write failed:', err);
  }
}

// ========== ヘルパー: フレンドマッチング ==========

async function findFriendByEmailOrPhone(
  db: D1Database,
  email?: string,
  phone?: string,
): Promise<{ friendId: string; lineUserId: string | null } | null> {
  // メールでフレンドを検索
  if (email) {
    const userByEmail = await db
      .prepare(`SELECT id FROM users WHERE email = ?`)
      .bind(email)
      .first<{ id: string }>();
    if (userByEmail) {
      const friend = await db
        .prepare(`SELECT id, line_user_id FROM friends WHERE user_id = ?`)
        .bind(userByEmail.id)
        .first<{ id: string; line_user_id: string | null }>();
      if (friend) {
        return { friendId: friend.id, lineUserId: friend.line_user_id };
      }
    }
  }

  // 電話番号でフレンドを検索
  if (phone) {
    const normalizedPhone = phone.replace(/[^0-9+]/g, '');
    const userByPhone = await db
      .prepare(`SELECT id FROM users WHERE phone = ?`)
      .bind(normalizedPhone)
      .first<{ id: string }>();
    if (userByPhone) {
      const friend = await db
        .prepare(`SELECT id, line_user_id FROM friends WHERE user_id = ?`)
        .bind(userByPhone.id)
        .first<{ id: string; line_user_id: string | null }>();
      if (friend) {
        return { friendId: friend.id, lineUserId: friend.line_user_id };
      }
    }
  }

  return null;
}

// ========== ヘルパー: LINE メッセージ送信 ==========

/**
 * LINE Messaging API でテキストメッセージを送信
 */
async function sendLineMessage(
  lineChannelAccessToken: string,
  lineUserId: string,
  message: string,
): Promise<void> {
  // LINE Messaging API で送信
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${lineChannelAccessToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: 'text', text: message }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`LINE push message failed (${res.status}): ${body}`);
  }
}

// ========== ヘルパー: Webhook ボディ解析 + HMAC 検証 ==========

async function parseWebhookBody(
  c: { env: Env['Bindings']; req: { header: (name: string) => string | undefined; text: () => Promise<string>; json: <T>() => Promise<T> } },
): Promise<{ body: Record<string, unknown>; valid: boolean; errorResponse?: Response }> {
  const envRecord = c.env as unknown as Record<string, string | undefined>;
  const signingSecret = envRecord.SHOPIFY_WEBHOOK_SECRET || envRecord.SHOPIFY_CLIENT_SECRET;

  if (signingSecret) {
    const hmacHeader = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
    const rawBody = await c.req.text();
    let valid = await verifyShopifySignature(signingSecret, rawBody, hmacHeader);

    // フォールバック: CLIENT_SECRET で再試行
    if (!valid && envRecord.SHOPIFY_WEBHOOK_SECRET && envRecord.SHOPIFY_CLIENT_SECRET
        && envRecord.SHOPIFY_WEBHOOK_SECRET !== envRecord.SHOPIFY_CLIENT_SECRET) {
      valid = await verifyShopifySignature(envRecord.SHOPIFY_CLIENT_SECRET, rawBody, hmacHeader);
      if (valid) {
        console.warn('Shopify HMAC (phase2a): succeeded with CLIENT_SECRET fallback');
        // セキュリティイベントとしてD1に記録
        try {
          const db = (c.env as unknown as { DB: D1Database }).DB;
          const topic = c.req.header('X-Shopify-Topic') ?? 'unknown';
          await logWebhook(db, topic, undefined, 'security_warning', 'HMAC verified via CLIENT_SECRET fallback — SHOPIFY_WEBHOOK_SECRET may be misconfigured');
        } catch { /* ログ失敗は無視 */ }
      }
    }

    if (!valid) {
      return { body: {}, valid: false };
    }
    return { body: JSON.parse(rawBody) as Record<string, unknown>, valid: true };
  }

  // シークレット未設定 — セキュリティのため拒否
  console.error('Shopify webhook rejected: no signing secret configured');
  return { body: {}, valid: false };
}

// =============================================
// Webhook エンドポイント
// =============================================

// ========== POST /api/integrations/shopify/webhook/checkout ==========
// checkouts/create 受信 → カゴ落ちDB保存

shopifyPhase2a.post('/api/integrations/shopify/webhook/checkout', async (c) => {
  try {
    const { body, valid } = await parseWebhookBody(c);
    if (!valid) {
      return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
    }

    const db = c.env.DB;
    const shopifyCheckoutId = String(body.id ?? body.token ?? '');
    if (!shopifyCheckoutId) {
      return c.json({ success: false, error: 'Missing checkout ID' }, 400);
    }

    // 冪等性チェック
    const existing = await getAbandonedCartByCheckoutId(db, shopifyCheckoutId);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed', id: existing.id } });
    }

    const customer = body.customer as Record<string, unknown> | undefined;
    const email = (body.email as string) ?? (customer?.email as string) ?? undefined;
    const phone = (body.phone as string) ?? (customer?.phone as string) ?? undefined;
    const shopifyCustomerId = customer?.id ? String(customer.id) : undefined;

    // notification_scheduled_at = 現在時刻 + 1時間
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const lineItemsRaw = body.line_items as Array<Record<string, unknown>> | undefined;

    const cart = await upsertAbandonedCart(db, {
      shopifyCheckoutId,
      shopifyCustomerId,
      cartToken: (body.cart_token as string) ?? undefined,
      email,
      lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
      totalPrice: body.total_price ? Number(body.total_price) : undefined,
      currency: (body.currency as string) ?? 'JPY',
      checkoutUrl: (body.abandoned_checkout_url as string) ?? undefined,
      notificationScheduledAt: scheduledAt,
    });

    // 非同期: フレンドマッチング
    const asyncWork = (async () => {
      try {
        const match = await findFriendByEmailOrPhone(db, email, phone);
        if (match) {
          await db
            .prepare(`UPDATE abandoned_carts SET friend_id = ?, updated_at = ? WHERE shopify_checkout_id = ?`)
            .bind(match.friendId, jstNow(), shopifyCheckoutId)
            .run();
        }
      } catch (err) {
        console.error('Shopify checkout webhook async error:', err);
      }
    })();
    try { c.executionCtx.waitUntil(asyncWork); } catch { /* no exec ctx in tests */ }

    return c.json({ success: true, data: { id: cart.id, shopifyCheckoutId: cart.shopify_checkout_id } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/checkout error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== POST /api/integrations/shopify/webhook/fulfillment ==========
// fulfillments/create, fulfillments/update 受信 → 発送通知

shopifyPhase2a.post('/api/integrations/shopify/webhook/fulfillment', async (c) => {
  try {
    const { body, valid } = await parseWebhookBody(c);
    if (!valid) {
      return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
    }

    const db = c.env.DB;
    const shopifyFulfillmentId = String(body.id ?? '');
    const shopifyOrderId = String(body.order_id ?? '');

    if (!shopifyFulfillmentId) {
      return c.json({ success: false, error: 'Missing fulfillment ID' }, 400);
    }

    const trackingNumber = (body.tracking_number as string) ?? undefined;
    const trackingUrl = (body.tracking_url as string) ?? undefined;
    const trackingCompany = (body.tracking_company as string) ?? undefined;
    const status = (body.status as string) ?? undefined;
    const lineItemsRaw = body.line_items as Array<Record<string, unknown>> | undefined;

    // 注文IDで内部IDを取得
    let orderId: string | undefined;
    if (shopifyOrderId) {
      const order = await getShopifyOrderByShopifyId(db, shopifyOrderId);
      if (order) {
        orderId = order.id as string;
      }
    }

    await logWebhook(db, c.req.header('X-Shopify-Topic') ?? 'fulfillments/?', shopifyFulfillmentId, 'received', `order:${shopifyOrderId} ${status ?? ''}`);

    const fulfillment = await upsertShopifyFulfillment(db, {
      shopifyOrderId,
      shopifyFulfillmentId,
      orderId,
      trackingNumber,
      trackingUrl,
      trackingCompany,
      status,
      lineItems: lineItemsRaw ? JSON.stringify(lineItemsRaw) : undefined,
    });

    await logWebhook(db, c.req.header('X-Shopify-Topic') ?? 'fulfillments/?', shopifyFulfillmentId, 'processed', `saved as ${fulfillment.id}`);

    // 非同期: フレンドマッチング → LINE通知送信
    const asyncWork = (async () => {
      try {
        // 注文からメール/電話を取得
        const order = await db
          .prepare(`SELECT email, phone, friend_id FROM shopify_orders WHERE shopify_order_id = ?`)
          .bind(shopifyOrderId)
          .first<{ email: string | null; phone: string | null; friend_id: string | null }>();

        let friendId = order?.friend_id ?? null;
        let lineUserId: string | null = null;

        if (friendId) {
          const friend = await db
            .prepare(`SELECT line_user_id FROM friends WHERE id = ?`)
            .bind(friendId)
            .first<{ line_user_id: string | null }>();
          lineUserId = friend?.line_user_id ?? null;
        } else if (order) {
          const match = await findFriendByEmailOrPhone(db, order.email ?? undefined, order.phone ?? undefined);
          if (match) {
            friendId = match.friendId;
            lineUserId = match.lineUserId;

            // fulfillment にフレンドIDを紐付け
            await db
              .prepare(`UPDATE shopify_fulfillments SET friend_id = ?, updated_at = ? WHERE shopify_fulfillment_id = ?`)
              .bind(friendId, jstNow(), shopifyFulfillmentId)
              .run();
          }
        }

        // LINE通知送信（SHOPIFY_LINE_NOTIFY_ENABLED が 'true' の場合のみ）
        const notifyEnabled = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_LINE_NOTIFY_ENABLED === 'true';
        if (notifyEnabled && lineUserId && trackingNumber) {
          const message = `ご注文の商品が発送されました！追跡番号: ${trackingNumber}`;
          await sendLineMessage(c.env.LINE_CHANNEL_ACCESS_TOKEN, lineUserId, message);

          // notified_at を更新
          await db
            .prepare(`UPDATE shopify_fulfillments SET notified_at = ?, updated_at = ? WHERE shopify_fulfillment_id = ?`)
            .bind(jstNow(), jstNow(), shopifyFulfillmentId)
            .run();
        }
      } catch (err) {
        console.error('Shopify fulfillment webhook async error:', err);
      }
    })();
    try { c.executionCtx.waitUntil(asyncWork); } catch { /* no exec ctx in tests */ }

    return c.json({ success: true, data: { id: fulfillment.id, shopifyFulfillmentId: fulfillment.shopify_fulfillment_id } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/fulfillment error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== POST /api/integrations/shopify/webhook/inventory ==========
// inventory_levels/update 受信 → 再入荷通知

shopifyPhase2a.post('/api/integrations/shopify/webhook/inventory', async (c) => {
  try {
    const { body, valid } = await parseWebhookBody(c);
    if (!valid) {
      return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
    }

    const db = c.env.DB;
    const available = Number(body.available ?? 0);
    const inventoryItemId = String(body.inventory_item_id ?? '');

    if (available <= 0) {
      return c.json({ success: true, data: { message: 'Stock not available, no notifications sent' } });
    }

    // inventory_item_id から variant_id を検索
    // Shopify の inventory_item_id は variant の inventory_item_id と同じ
    // restock_requests には shopify_variant_id で保存されている
    // inventory_item_id を variant_id として扱う（Shopify webhook の仕様上）
    const variantId = inventoryItemId;

    const waitingRequests = await getRestockRequestsByVariant(db, variantId, 'waiting');

    if (waitingRequests.length === 0) {
      return c.json({ success: true, data: { message: 'No waiting restock requests', variantId } });
    }

    // 非同期: 再入荷通知送信
    const asyncWork = (async () => {
      try {
        for (const request of waitingRequests) {
          const friendId = request.friend_id as string | null;
          if (!friendId) continue;

          const friend = await db
            .prepare(`SELECT line_user_id FROM friends WHERE id = ?`)
            .bind(friendId)
            .first<{ line_user_id: string | null }>();

          if (friend?.line_user_id) {
            const restockNotifyEnabled = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_LINE_NOTIFY_ENABLED === 'true';
            if (restockNotifyEnabled) {
              const productTitle = (request.product_title as string) ?? '商品';
              const message = `お待たせしました！「${productTitle}」が再入荷しました。お早めにお求めください。`;
              await sendLineMessage(c.env.LINE_CHANNEL_ACCESS_TOKEN, friend.line_user_id, message);
            }
          }

          // status を notified に更新
          await updateRestockRequestStatus(db, request.id as string, 'notified', jstNow());
        }
      } catch (err) {
        console.error('Shopify inventory webhook async error:', err);
      }
    })();
    try { c.executionCtx.waitUntil(asyncWork); } catch { /* no exec ctx in tests */ }

    return c.json({
      success: true,
      data: { message: `${waitingRequests.length} restock notification(s) queued`, variantId },
    });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/inventory error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== POST /api/integrations/shopify/webhook/payment ==========
// orders/paid 受信 → 決済完了通知

shopifyPhase2a.post('/api/integrations/shopify/webhook/payment', async (c) => {
  try {
    const { body, valid } = await parseWebhookBody(c);
    if (!valid) {
      return c.json({ success: false, error: 'Shopify signature verification failed' }, 401);
    }

    const db = c.env.DB;
    const shopifyOrderId = String(body.id ?? '');
    const orderNumber = body.order_number ? Number(body.order_number) : undefined;
    const financialStatus = (body.financial_status as string) ?? 'paid';
    const totalPrice = body.total_price ? Number(body.total_price) : undefined;
    const currency = (body.currency as string) ?? 'JPY';

    if (!shopifyOrderId) {
      return c.json({ success: false, error: 'Missing order ID' }, 400);
    }

    // 重複通知防止
    const existingNotification = await getPaymentNotificationByOrder(db, shopifyOrderId);
    if (existingNotification) {
      return c.json({ success: true, data: { message: 'Already notified', id: existingNotification.id } });
    }

    const customer = body.customer as Record<string, unknown> | undefined;
    const email = (body.email as string) ?? (customer?.email as string) ?? undefined;
    const phone = (body.phone as string) ?? (customer?.phone as string) ?? undefined;

    // 内部注文IDを取得
    let orderId: string | undefined;
    const order = await getShopifyOrderByShopifyId(db, shopifyOrderId);
    if (order) {
      orderId = order.id as string;
    }

    // フレンドマッチング
    let friendId: string | undefined;
    let lineUserId: string | null = null;

    if (order?.friend_id) {
      friendId = order.friend_id as string;
      const friend = await db
        .prepare(`SELECT line_user_id FROM friends WHERE id = ?`)
        .bind(friendId)
        .first<{ line_user_id: string | null }>();
      lineUserId = friend?.line_user_id ?? null;
    } else {
      const match = await findFriendByEmailOrPhone(db, email, phone);
      if (match) {
        friendId = match.friendId;
        lineUserId = match.lineUserId;
      }
    }

    // 決済通知ログ保存
    const notification = await createPaymentNotification(db, {
      shopifyOrderId,
      orderId,
      friendId,
      financialStatus,
      totalPrice,
      currency,
    });

    // 非同期: LINE通知送信（SHOPIFY_LINE_NOTIFY_ENABLED が 'true' の場合のみ）
    const paymentNotifyEnabled = (c.env as unknown as Record<string, string | undefined>).SHOPIFY_LINE_NOTIFY_ENABLED === 'true';
    if (paymentNotifyEnabled && lineUserId && orderNumber) {
      const asyncWork = (async () => {
        try {
          const message = `ご注文ありがとうございます！注文番号: ${orderNumber}`;
          await sendLineMessage(c.env.LINE_CHANNEL_ACCESS_TOKEN, lineUserId!, message);
        } catch (err) {
          console.error('Shopify payment webhook async error:', err);
        }
      })();
      try { c.executionCtx.waitUntil(asyncWork); } catch { /* no exec ctx in tests */ }
    }

    return c.json({ success: true, data: { id: notification.id, shopifyOrderId } });
  } catch (err) {
    console.error('POST /api/integrations/shopify/webhook/payment error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================
// CRUD エンドポイント: 再入荷リクエスト
// =============================================

shopifyPhase2a.post('/api/integrations/shopify/restock-requests', async (c) => {
  try {
    const body = await c.req.json<{
      friendId: string;
      shopifyProductId: string;
      shopifyVariantId: string;
      productTitle?: string;
      variantTitle?: string;
    }>();

    if (!body.friendId || !body.shopifyProductId || !body.shopifyVariantId) {
      return c.json({ success: false, error: 'friendId, shopifyProductId, shopifyVariantId are required' }, 400);
    }

    const request = await createRestockRequest(c.env.DB, {
      friendId: body.friendId,
      shopifyProductId: body.shopifyProductId,
      shopifyVariantId: body.shopifyVariantId,
      productTitle: body.productTitle,
      variantTitle: body.variantTitle,
    });

    return c.json({ success: true, data: request }, 201);
  } catch (err) {
    console.error('POST /api/integrations/shopify/restock-requests error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.get('/api/integrations/shopify/restock-requests', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;

    if (friendId) {
      const items = await getRestockRequestsByFriend(c.env.DB, friendId);
      return c.json({ success: true, data: items });
    }

    // フィルタなしの場合は全件（制限付き）
    const result = await c.env.DB
      .prepare(`SELECT * FROM restock_requests ORDER BY created_at DESC LIMIT 100`)
      .all<Record<string, unknown>>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/integrations/shopify/restock-requests error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.delete('/api/integrations/shopify/restock-requests/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB
      .prepare(`SELECT * FROM restock_requests WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();

    if (!existing) {
      return c.json({ success: false, error: 'Restock request not found' }, 404);
    }

    await cancelRestockRequest(c.env.DB, id);
    return c.json({ success: true, data: { message: 'Restock request cancelled' } });
  } catch (err) {
    console.error('DELETE /api/integrations/shopify/restock-requests/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================
// CRUD エンドポイント: クーポン管理
// =============================================

shopifyPhase2a.get('/api/integrations/shopify/coupons', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    const items = await getShopifyCoupons(c.env.DB, { status, limit, offset });
    return c.json({ success: true, data: items });
  } catch (err) {
    console.error('GET /api/integrations/shopify/coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.post('/api/integrations/shopify/coupons', async (c) => {
  try {
    const body = await c.req.json<{
      code: string;
      title?: string;
      description?: string;
      discountType: string;
      discountValue: number;
      minimumOrderAmount?: number;
      usageLimit?: number;
      startsAt?: string;
      expiresAt?: string;
      shopifyPriceRuleId?: string;
      shopifyDiscountId?: string;
    }>();

    if (!body.code || !body.discountType || body.discountValue === undefined) {
      return c.json({ success: false, error: 'code, discountType, discountValue are required' }, 400);
    }

    const coupon = await createShopifyCoupon(c.env.DB, {
      code: body.code,
      title: body.title,
      description: body.description,
      discountType: body.discountType,
      discountValue: body.discountValue,
      minimumOrderAmount: body.minimumOrderAmount,
      usageLimit: body.usageLimit,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      shopifyPriceRuleId: body.shopifyPriceRuleId,
      shopifyDiscountId: body.shopifyDiscountId,
    });

    return c.json({ success: true, data: coupon }, 201);
  } catch (err) {
    console.error('POST /api/integrations/shopify/coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.put('/api/integrations/shopify/coupons/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      title?: string;
      description?: string;
      discountType?: string;
      discountValue?: number;
      minimumOrderAmount?: number;
      usageLimit?: number;
      startsAt?: string;
      expiresAt?: string;
      status?: string;
    }>();

    const updated = await updateShopifyCoupon(c.env.DB, id, {
      title: body.title,
      description: body.description,
      discountType: body.discountType,
      discountValue: body.discountValue,
      minimumOrderAmount: body.minimumOrderAmount,
      usageLimit: body.usageLimit,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      status: body.status,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Coupon not found' }, 404);
    }

    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/integrations/shopify/coupons/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.delete('/api/integrations/shopify/coupons/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB
      .prepare(`SELECT id FROM shopify_coupons WHERE id = ?`)
      .bind(id)
      .first<{ id: string }>();

    if (!existing) {
      return c.json({ success: false, error: 'Coupon not found' }, 404);
    }

    await deleteShopifyCoupon(c.env.DB, id);
    return c.json({ success: true, data: { message: 'Coupon deleted' } });
  } catch (err) {
    console.error('DELETE /api/integrations/shopify/coupons/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.post('/api/integrations/shopify/coupons/:id/assign', async (c) => {
  try {
    const couponId = c.req.param('id');
    const body = await c.req.json<{ friendId: string }>();

    if (!body.friendId) {
      return c.json({ success: false, error: 'friendId is required' }, 400);
    }

    // クーポン存在チェック
    const coupon = await c.env.DB
      .prepare(`SELECT id, status FROM shopify_coupons WHERE id = ?`)
      .bind(couponId)
      .first<{ id: string; status: string }>();

    if (!coupon) {
      return c.json({ success: false, error: 'Coupon not found' }, 404);
    }

    if (coupon.status !== 'active') {
      return c.json({ success: false, error: 'Coupon is not active' }, 400);
    }

    const assignment = await assignCoupon(c.env.DB, {
      couponId,
      friendId: body.friendId,
    });

    return c.json({ success: true, data: assignment }, 201);
  } catch (err) {
    console.error('POST /api/integrations/shopify/coupons/:id/assign error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.get('/api/integrations/shopify/coupons/assignments', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;

    if (friendId) {
      const items = await getCouponAssignmentsByFriend(c.env.DB, friendId);
      return c.json({ success: true, data: items });
    }

    // フィルタなし
    const result = await c.env.DB
      .prepare(
        `SELECT a.*, c.code, c.title, c.discount_type, c.discount_value FROM shopify_coupon_assignments a JOIN shopify_coupons c ON a.coupon_id = c.id ORDER BY a.assigned_at DESC LIMIT 100`,
      )
      .all<Record<string, unknown>>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/integrations/shopify/coupons/assignments error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================
// CRUD エンドポイント: 会員ランク
// =============================================

shopifyPhase2a.get('/api/integrations/shopify/ranks', async (c) => {
  try {
    const items = await getMemberRanks(c.env.DB);
    return c.json({ success: true, data: items });
  } catch (err) {
    console.error('GET /api/integrations/shopify/ranks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.post('/api/integrations/shopify/ranks', async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      minTotalSpent: number;
      minOrdersCount: number;
      color?: string;
      icon?: string;
      benefitsJson?: string;
      sortOrder: number;
    }>();

    if (!body.name || body.sortOrder === undefined) {
      return c.json({ success: false, error: 'name and sortOrder are required' }, 400);
    }

    const rank = await createMemberRank(c.env.DB, {
      name: body.name,
      minTotalSpent: body.minTotalSpent ?? 0,
      minOrdersCount: body.minOrdersCount ?? 0,
      color: body.color,
      icon: body.icon,
      benefitsJson: body.benefitsJson,
      sortOrder: body.sortOrder,
    });

    return c.json({ success: true, data: rank }, 201);
  } catch (err) {
    console.error('POST /api/integrations/shopify/ranks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.put('/api/integrations/shopify/ranks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      name?: string;
      minTotalSpent?: number;
      minOrdersCount?: number;
      color?: string;
      icon?: string;
      benefitsJson?: string;
      sortOrder?: number;
      isActive?: boolean;
    }>();

    const updated = await updateMemberRank(c.env.DB, id, {
      name: body.name,
      minTotalSpent: body.minTotalSpent,
      minOrdersCount: body.minOrdersCount,
      color: body.color,
      icon: body.icon,
      benefitsJson: body.benefitsJson,
      sortOrder: body.sortOrder,
      isActive: body.isActive,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Rank not found' }, 404);
    }

    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PUT /api/integrations/shopify/ranks/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.delete('/api/integrations/shopify/ranks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB
      .prepare(`SELECT id FROM member_ranks WHERE id = ?`)
      .bind(id)
      .first<{ id: string }>();

    if (!existing) {
      return c.json({ success: false, error: 'Rank not found' }, 404);
    }

    await deleteMemberRank(c.env.DB, id);
    return c.json({ success: true, data: { message: 'Rank deleted' } });
  } catch (err) {
    console.error('DELETE /api/integrations/shopify/ranks/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.get('/api/integrations/shopify/ranks/friend/:friendId', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const rank = await getFriendRank(c.env.DB, friendId);

    if (!rank) {
      return c.json({ success: false, error: 'Friend rank not found' }, 404);
    }

    return c.json({ success: true, data: rank });
  } catch (err) {
    console.error('GET /api/integrations/shopify/ranks/friend/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.post('/api/integrations/shopify/ranks/calculate/:friendId', async (c) => {
  try {
    const friendId = c.req.param('friendId');
    const rank = await calculateAndUpdateFriendRank(c.env.DB, friendId);

    if (!rank) {
      return c.json({ success: false, error: 'Could not calculate rank (no matching rank or friend not found)' }, 404);
    }

    return c.json({ success: true, data: rank });
  } catch (err) {
    console.error('POST /api/integrations/shopify/ranks/calculate/:friendId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================
// CRUD エンドポイント: カゴ落ち
// =============================================

shopifyPhase2a.get('/api/integrations/shopify/abandoned-carts', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const friendId = c.req.query('friendId') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const offset = Number(c.req.query('offset') ?? '0');

    let query = `SELECT * FROM abandoned_carts`;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (friendId) {
      conditions.push(`friend_id = ?`);
      params.push(friendId);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = c.env.DB.prepare(query);
    const result = await stmt.bind(...params).all<Record<string, unknown>>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/integrations/shopify/abandoned-carts error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

shopifyPhase2a.get('/api/integrations/shopify/abandoned-carts/stats', async (c) => {
  try {
    const db = c.env.DB;

    const pending = await db
      .prepare(`SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'pending'`)
      .first<{ count: number }>();
    const notified = await db
      .prepare(`SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'notified'`)
      .first<{ count: number }>();
    const recovered = await db
      .prepare(`SELECT COUNT(*) as count FROM abandoned_carts WHERE status = 'recovered'`)
      .first<{ count: number }>();

    return c.json({
      success: true,
      data: {
        pending: pending?.count ?? 0,
        notified: notified?.count ?? 0,
        recovered: recovered?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/integrations/shopify/abandoned-carts/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { shopifyPhase2a };
