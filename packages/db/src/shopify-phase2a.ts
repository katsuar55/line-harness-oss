import { jstNow } from './utils.js';

// ===== Abandoned Carts =====

export async function upsertAbandonedCart(
  db: D1Database,
  cart: {
    shopifyCheckoutId: string;
    friendId?: string;
    shopifyCustomerId?: string;
    cartToken?: string;
    email?: string;
    lineItems?: string;
    totalPrice?: number;
    currency?: string;
    checkoutUrl?: string;
    notificationScheduledAt?: string;
  },
): Promise<{ id: string; shopify_checkout_id: string; [key: string]: unknown }> {
  const existing = await db
    .prepare(`SELECT * FROM abandoned_carts WHERE shopify_checkout_id = ?`)
    .bind(cart.shopifyCheckoutId)
    .first<{ id: string; shopify_checkout_id: string; [key: string]: unknown }>();

  const now = jstNow();

  if (existing) {
    await db
      .prepare(
        `UPDATE abandoned_carts SET friend_id = COALESCE(?, friend_id), shopify_customer_id = COALESCE(?, shopify_customer_id), cart_token = COALESCE(?, cart_token), email = COALESCE(?, email), line_items = COALESCE(?, line_items), total_price = COALESCE(?, total_price), checkout_url = COALESCE(?, checkout_url), notification_scheduled_at = COALESCE(?, notification_scheduled_at), updated_at = ? WHERE shopify_checkout_id = ?`,
      )
      .bind(
        cart.friendId ?? null,
        cart.shopifyCustomerId ?? null,
        cart.cartToken ?? null,
        cart.email ?? null,
        cart.lineItems ?? null,
        cart.totalPrice ?? null,
        cart.checkoutUrl ?? null,
        cart.notificationScheduledAt ?? null,
        now,
        cart.shopifyCheckoutId,
      )
      .run();

    return (await db
      .prepare(`SELECT * FROM abandoned_carts WHERE id = ?`)
      .bind(existing.id)
      .first<{ id: string; shopify_checkout_id: string; [key: string]: unknown }>())!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO abandoned_carts (id, shopify_checkout_id, friend_id, shopify_customer_id, cart_token, email, line_items, total_price, currency, checkout_url, status, notification_scheduled_at, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', ?, ?)`,
    )
    .bind(
      id,
      cart.shopifyCheckoutId,
      cart.friendId ?? null,
      cart.shopifyCustomerId ?? null,
      cart.cartToken ?? null,
      cart.email ?? null,
      cart.lineItems ?? '[]',
      cart.totalPrice ?? 0,
      cart.currency ?? 'JPY',
      cart.checkoutUrl ?? null,
      cart.notificationScheduledAt ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM abandoned_carts WHERE id = ?`)
    .bind(id)
    .first<{ id: string; shopify_checkout_id: string; [key: string]: unknown }>())!;
}

export async function getAbandonedCartByCheckoutId(
  db: D1Database,
  shopifyCheckoutId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM abandoned_carts WHERE shopify_checkout_id = ?`)
    .bind(shopifyCheckoutId)
    .first<Record<string, unknown>>();
}

export async function getPendingAbandonedCarts(
  db: D1Database,
  beforeTime: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(
      `SELECT * FROM abandoned_carts WHERE status = 'pending' AND notification_scheduled_at IS NOT NULL AND notification_scheduled_at <= ? ORDER BY notification_scheduled_at ASC`,
    )
    .bind(beforeTime)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function updateAbandonedCartStatus(
  db: D1Database,
  id: string,
  status: string,
  extra?: { notifiedAt?: string; recoveredAt?: string; recoveredOrderId?: string },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE abandoned_carts SET status = ?, notified_at = COALESCE(?, notified_at), recovered_at = COALESCE(?, recovered_at), recovered_order_id = COALESCE(?, recovered_order_id), updated_at = ? WHERE id = ?`,
    )
    .bind(
      status,
      extra?.notifiedAt ?? null,
      extra?.recoveredAt ?? null,
      extra?.recoveredOrderId ?? null,
      now,
      id,
    )
    .run();
}

export async function recoverAbandonedCartByCartToken(
  db: D1Database,
  cartToken: string,
  orderId: string,
): Promise<Record<string, unknown> | null> {
  const now = jstNow();
  const cart = await db
    .prepare(`SELECT * FROM abandoned_carts WHERE cart_token = ? AND status = 'pending'`)
    .bind(cartToken)
    .first<Record<string, unknown>>();

  if (!cart) return null;

  await db
    .prepare(
      `UPDATE abandoned_carts SET status = 'recovered', recovered_at = ?, recovered_order_id = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(now, orderId, now, cart.id as string)
    .run();

  return (await db
    .prepare(`SELECT * FROM abandoned_carts WHERE id = ?`)
    .bind(cart.id as string)
    .first<Record<string, unknown>>())!;
}

// ===== Restock Requests =====

export async function createRestockRequest(
  db: D1Database,
  request: {
    friendId: string;
    shopifyProductId: string;
    shopifyVariantId: string;
    productTitle?: string;
    variantTitle?: string;
  },
): Promise<{ id: string; [key: string]: unknown }> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO restock_requests (id, friend_id, shopify_product_id, shopify_variant_id, product_title, variant_title, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', '{}', ?, ?)`,
    )
    .bind(
      id,
      request.friendId,
      request.shopifyProductId,
      request.shopifyVariantId,
      request.productTitle ?? null,
      request.variantTitle ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM restock_requests WHERE id = ?`)
    .bind(id)
    .first<{ id: string; [key: string]: unknown }>())!;
}

export async function getRestockRequestsByVariant(
  db: D1Database,
  shopifyVariantId: string,
  status: string = 'waiting',
): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(
      `SELECT * FROM restock_requests WHERE shopify_variant_id = ? AND status = ? ORDER BY created_at ASC`,
    )
    .bind(shopifyVariantId, status)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function getRestockRequestsByFriend(
  db: D1Database,
  friendId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(`SELECT * FROM restock_requests WHERE friend_id = ? ORDER BY created_at DESC`)
    .bind(friendId)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function updateRestockRequestStatus(
  db: D1Database,
  id: string,
  status: string,
  notifiedAt?: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE restock_requests SET status = ?, notified_at = COALESCE(?, notified_at), updated_at = ? WHERE id = ?`,
    )
    .bind(status, notifiedAt ?? null, now, id)
    .run();
}

export async function cancelRestockRequest(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE restock_requests SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(now, now, id)
    .run();
}

// ===== Shopify Fulfillments =====

export async function upsertShopifyFulfillment(
  db: D1Database,
  fulfillment: {
    shopifyOrderId: string;
    shopifyFulfillmentId: string;
    orderId?: string;
    friendId?: string;
    trackingNumber?: string;
    trackingUrl?: string;
    trackingCompany?: string;
    status?: string;
    lineItems?: string;
  },
): Promise<{ id: string; shopify_fulfillment_id: string; [key: string]: unknown }> {
  const existing = await db
    .prepare(`SELECT * FROM shopify_fulfillments WHERE shopify_fulfillment_id = ?`)
    .bind(fulfillment.shopifyFulfillmentId)
    .first<{ id: string; shopify_fulfillment_id: string; [key: string]: unknown }>();

  const now = jstNow();

  if (existing) {
    await db
      .prepare(
        `UPDATE shopify_fulfillments SET order_id = COALESCE(?, order_id), friend_id = COALESCE(?, friend_id), tracking_number = COALESCE(?, tracking_number), tracking_url = COALESCE(?, tracking_url), tracking_company = COALESCE(?, tracking_company), status = COALESCE(?, status), line_items = COALESCE(?, line_items), updated_at = ? WHERE shopify_fulfillment_id = ?`,
      )
      .bind(
        fulfillment.orderId ?? null,
        fulfillment.friendId ?? null,
        fulfillment.trackingNumber ?? null,
        fulfillment.trackingUrl ?? null,
        fulfillment.trackingCompany ?? null,
        fulfillment.status ?? null,
        fulfillment.lineItems ?? null,
        now,
        fulfillment.shopifyFulfillmentId,
      )
      .run();

    return (await db
      .prepare(`SELECT * FROM shopify_fulfillments WHERE id = ?`)
      .bind(existing.id)
      .first<{ id: string; shopify_fulfillment_id: string; [key: string]: unknown }>())!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shopify_fulfillments (id, shopify_order_id, shopify_fulfillment_id, order_id, friend_id, tracking_number, tracking_url, tracking_company, status, line_items, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    )
    .bind(
      id,
      fulfillment.shopifyOrderId,
      fulfillment.shopifyFulfillmentId,
      fulfillment.orderId ?? null,
      fulfillment.friendId ?? null,
      fulfillment.trackingNumber ?? null,
      fulfillment.trackingUrl ?? null,
      fulfillment.trackingCompany ?? null,
      fulfillment.status ?? 'pending',
      fulfillment.lineItems ?? '[]',
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_fulfillments WHERE id = ?`)
    .bind(id)
    .first<{ id: string; shopify_fulfillment_id: string; [key: string]: unknown }>())!;
}

export async function getShopifyFulfillmentsByOrder(
  db: D1Database,
  shopifyOrderId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(`SELECT * FROM shopify_fulfillments WHERE shopify_order_id = ? ORDER BY created_at ASC`)
    .bind(shopifyOrderId)
    .all<Record<string, unknown>>();
  return result.results;
}

// ===== Shopify Payment Notifications =====

export async function createPaymentNotification(
  db: D1Database,
  notification: {
    shopifyOrderId: string;
    orderId?: string;
    friendId?: string;
    financialStatus: string;
    totalPrice?: number;
    currency?: string;
  },
): Promise<{ id: string; [key: string]: unknown }> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO shopify_payment_notifications (id, shopify_order_id, order_id, friend_id, financial_status, total_price, currency, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .bind(
      id,
      notification.shopifyOrderId,
      notification.orderId ?? null,
      notification.friendId ?? null,
      notification.financialStatus,
      notification.totalPrice ?? null,
      notification.currency ?? 'JPY',
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_payment_notifications WHERE id = ?`)
    .bind(id)
    .first<{ id: string; [key: string]: unknown }>())!;
}

export async function getPaymentNotificationByOrder(
  db: D1Database,
  shopifyOrderId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(
      `SELECT * FROM shopify_payment_notifications WHERE shopify_order_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(shopifyOrderId)
    .first<Record<string, unknown>>();
}

// ===== Shopify Coupons =====

export async function createShopifyCoupon(
  db: D1Database,
  coupon: {
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
  },
): Promise<{ id: string; code: string; [key: string]: unknown }> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO shopify_coupons (id, code, title, description, discount_type, discount_value, minimum_order_amount, usage_limit, starts_at, expires_at, shopify_price_rule_id, shopify_discount_id, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)`,
    )
    .bind(
      id,
      coupon.code,
      coupon.title ?? null,
      coupon.description ?? null,
      coupon.discountType,
      coupon.discountValue,
      coupon.minimumOrderAmount ?? null,
      coupon.usageLimit ?? null,
      coupon.startsAt ?? null,
      coupon.expiresAt ?? null,
      coupon.shopifyPriceRuleId ?? null,
      coupon.shopifyDiscountId ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_coupons WHERE id = ?`)
    .bind(id)
    .first<{ id: string; code: string; [key: string]: unknown }>())!;
}

export async function getShopifyCouponByCode(
  db: D1Database,
  code: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM shopify_coupons WHERE code = ?`)
    .bind(code)
    .first<Record<string, unknown>>();
}

export async function getShopifyCoupons(
  db: D1Database,
  filters?: {
    status?: string;
    limit?: number;
    offset?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  if (filters?.status) {
    const result = await db
      .prepare(`SELECT * FROM shopify_coupons WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(filters.status, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  const result = await db
    .prepare(`SELECT * FROM shopify_coupons ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function updateShopifyCoupon(
  db: D1Database,
  id: string,
  updates: {
    title?: string;
    description?: string;
    discountType?: string;
    discountValue?: number;
    minimumOrderAmount?: number;
    usageLimit?: number;
    startsAt?: string;
    expiresAt?: string;
    status?: string;
    shopifyPriceRuleId?: string;
    shopifyDiscountId?: string;
  },
): Promise<Record<string, unknown> | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE shopify_coupons SET title = COALESCE(?, title), description = COALESCE(?, description), discount_type = COALESCE(?, discount_type), discount_value = COALESCE(?, discount_value), minimum_order_amount = COALESCE(?, minimum_order_amount), usage_limit = COALESCE(?, usage_limit), starts_at = COALESCE(?, starts_at), expires_at = COALESCE(?, expires_at), status = COALESCE(?, status), shopify_price_rule_id = COALESCE(?, shopify_price_rule_id), shopify_discount_id = COALESCE(?, shopify_discount_id), updated_at = ? WHERE id = ?`,
    )
    .bind(
      updates.title ?? null,
      updates.description ?? null,
      updates.discountType ?? null,
      updates.discountValue ?? null,
      updates.minimumOrderAmount ?? null,
      updates.usageLimit ?? null,
      updates.startsAt ?? null,
      updates.expiresAt ?? null,
      updates.status ?? null,
      updates.shopifyPriceRuleId ?? null,
      updates.shopifyDiscountId ?? null,
      now,
      id,
    )
    .run();

  return db.prepare(`SELECT * FROM shopify_coupons WHERE id = ?`).bind(id).first<Record<string, unknown>>();
}

export async function deleteShopifyCoupon(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM shopify_coupons WHERE id = ?`).bind(id).run();
}

// ===== Shopify Coupon Assignments =====

export async function assignCoupon(
  db: D1Database,
  assignment: {
    couponId: string;
    friendId: string;
  },
): Promise<{ id: string; [key: string]: unknown }> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO shopify_coupon_assignments (id, coupon_id, friend_id, assigned_at, metadata, created_at) VALUES (?, ?, ?, ?, '{}', ?)`,
    )
    .bind(id, assignment.couponId, assignment.friendId, now, now)
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_coupon_assignments WHERE id = ?`)
    .bind(id)
    .first<{ id: string; [key: string]: unknown }>())!;
}

export async function getCouponAssignmentsByFriend(
  db: D1Database,
  friendId: string,
  unusedOnly?: boolean,
): Promise<Array<Record<string, unknown>>> {
  if (unusedOnly) {
    const result = await db
      .prepare(
        `SELECT a.*, c.code, c.title, c.discount_type, c.discount_value, c.expires_at FROM shopify_coupon_assignments a JOIN shopify_coupons c ON a.coupon_id = c.id WHERE a.friend_id = ? AND a.used_at IS NULL ORDER BY a.assigned_at DESC`,
      )
      .bind(friendId)
      .all<Record<string, unknown>>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT a.*, c.code, c.title, c.discount_type, c.discount_value, c.expires_at FROM shopify_coupon_assignments a JOIN shopify_coupons c ON a.coupon_id = c.id WHERE a.friend_id = ? ORDER BY a.assigned_at DESC`,
    )
    .bind(friendId)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function markCouponUsed(
  db: D1Database,
  assignmentId: string,
  usage: { usedAt: string; shopifyOrderId: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE shopify_coupon_assignments SET used_at = ?, shopify_order_id = ? WHERE id = ?`,
    )
    .bind(usage.usedAt, usage.shopifyOrderId, assignmentId)
    .run();

  // Increment usage_count on the coupon
  const assignment = await db
    .prepare(`SELECT coupon_id FROM shopify_coupon_assignments WHERE id = ?`)
    .bind(assignmentId)
    .first<{ coupon_id: string }>();

  if (assignment) {
    await db
      .prepare(`UPDATE shopify_coupons SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?`)
      .bind(jstNow(), assignment.coupon_id)
      .run();
  }
}

// ===== Member Ranks =====

export async function getMemberRanks(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db
    .prepare(`SELECT * FROM member_ranks WHERE is_active = 1 ORDER BY sort_order ASC`)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function createMemberRank(
  db: D1Database,
  rank: {
    name: string;
    minTotalSpent: number;
    minOrdersCount: number;
    color?: string;
    icon?: string;
    benefitsJson?: string;
    sortOrder: number;
  },
): Promise<{ id: string; name: string; [key: string]: unknown }> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO member_ranks (id, name, min_total_spent, min_orders_count, color, icon, benefits_json, sort_order, is_active, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '{}', ?, ?)`,
    )
    .bind(
      id,
      rank.name,
      rank.minTotalSpent,
      rank.minOrdersCount,
      rank.color ?? null,
      rank.icon ?? null,
      rank.benefitsJson ?? '[]',
      rank.sortOrder,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM member_ranks WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; [key: string]: unknown }>())!;
}

export async function updateMemberRank(
  db: D1Database,
  id: string,
  updates: {
    name?: string;
    minTotalSpent?: number;
    minOrdersCount?: number;
    color?: string;
    icon?: string;
    benefitsJson?: string;
    sortOrder?: number;
    isActive?: boolean;
  },
): Promise<Record<string, unknown> | null> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE member_ranks SET name = COALESCE(?, name), min_total_spent = COALESCE(?, min_total_spent), min_orders_count = COALESCE(?, min_orders_count), color = COALESCE(?, color), icon = COALESCE(?, icon), benefits_json = COALESCE(?, benefits_json), sort_order = COALESCE(?, sort_order), is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?`,
    )
    .bind(
      updates.name ?? null,
      updates.minTotalSpent ?? null,
      updates.minOrdersCount ?? null,
      updates.color ?? null,
      updates.icon ?? null,
      updates.benefitsJson ?? null,
      updates.sortOrder ?? null,
      updates.isActive !== undefined ? (updates.isActive ? 1 : 0) : null,
      now,
      id,
    )
    .run();

  return db.prepare(`SELECT * FROM member_ranks WHERE id = ?`).bind(id).first<Record<string, unknown>>();
}

export async function deleteMemberRank(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM member_ranks WHERE id = ?`).bind(id).run();
}

// ===== Friend Ranks =====

export async function getFriendRank(
  db: D1Database,
  friendId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(
      `SELECT fr.*, mr.name as rank_name, mr.color as rank_color, mr.icon as rank_icon, mr.benefits_json as rank_benefits FROM friend_ranks fr JOIN member_ranks mr ON fr.rank_id = mr.id WHERE fr.friend_id = ?`,
    )
    .bind(friendId)
    .first<Record<string, unknown>>();
}

export async function calculateAndUpdateFriendRank(
  db: D1Database,
  friendId: string,
): Promise<Record<string, unknown> | null> {
  // Get customer stats from shopify_customers
  const customer = await db
    .prepare(`SELECT total_spent, orders_count FROM shopify_customers WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ total_spent: number; orders_count: number }>();

  const totalSpent = customer?.total_spent ?? 0;
  const ordersCount = customer?.orders_count ?? 0;

  // Find the highest matching rank (sorted by sort_order DESC to get best match first)
  const matchedRank = await db
    .prepare(
      `SELECT * FROM member_ranks WHERE is_active = 1 AND min_total_spent <= ? AND min_orders_count <= ? ORDER BY sort_order DESC LIMIT 1`,
    )
    .bind(totalSpent, ordersCount)
    .first<{ id: string; [key: string]: unknown }>();

  if (!matchedRank) return null;

  const now = jstNow();
  const existing = await db
    .prepare(`SELECT * FROM friend_ranks WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ id: string; rank_id: string; [key: string]: unknown }>();

  if (existing) {
    const previousRankId = existing.rank_id !== matchedRank.id ? existing.rank_id : null;
    await db
      .prepare(
        `UPDATE friend_ranks SET rank_id = ?, total_spent = ?, orders_count = ?, previous_rank_id = COALESCE(?, previous_rank_id), calculated_at = ?, updated_at = ? WHERE friend_id = ?`,
      )
      .bind(matchedRank.id, totalSpent, ordersCount, previousRankId, now, now, friendId)
      .run();
  } else {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO friend_ranks (id, friend_id, rank_id, total_spent, orders_count, calculated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, friendId, matchedRank.id, totalSpent, ordersCount, now, now, now)
      .run();
  }

  return getFriendRank(db, friendId);
}
