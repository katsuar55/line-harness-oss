import { jstNow } from './utils.js';

// ===== Shopify Orders =====

export async function upsertShopifyOrder(
  db: D1Database,
  order: {
    shopifyOrderId: string;
    shopifyCustomerId?: string;
    friendId?: string;
    email?: string;
    phone?: string;
    totalPrice?: number;
    currency?: string;
    financialStatus?: string;
    fulfillmentStatus?: string;
    orderNumber?: number;
    lineItems?: string;
    tags?: string;
    metadata?: string;
  },
): Promise<{ id: string; shopify_order_id: string; [key: string]: unknown }> {
  const existing = await db
    .prepare(`SELECT * FROM shopify_orders WHERE shopify_order_id = ?`)
    .bind(order.shopifyOrderId)
    .first<{ id: string; shopify_order_id: string; [key: string]: unknown }>();

  const now = jstNow();

  if (existing) {
    await db
      .prepare(
        `UPDATE shopify_orders SET financial_status = ?, fulfillment_status = ?, friend_id = COALESCE(?, friend_id), tags = COALESCE(?, tags), updated_at = ? WHERE shopify_order_id = ?`,
      )
      .bind(
        order.financialStatus ?? existing.financial_status ?? null,
        order.fulfillmentStatus ?? existing.fulfillment_status ?? null,
        order.friendId ?? null,
        order.tags ?? null,
        now,
        order.shopifyOrderId,
      )
      .run();

    return (await db
      .prepare(`SELECT * FROM shopify_orders WHERE id = ?`)
      .bind(existing.id)
      .first<{ id: string; shopify_order_id: string; [key: string]: unknown }>())!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shopify_orders (id, shopify_order_id, shopify_customer_id, friend_id, email, phone, total_price, currency, financial_status, fulfillment_status, order_number, line_items, tags, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      order.shopifyOrderId,
      order.shopifyCustomerId ?? null,
      order.friendId ?? null,
      order.email ?? null,
      order.phone ?? null,
      order.totalPrice ?? null,
      order.currency ?? 'JPY',
      order.financialStatus ?? null,
      order.fulfillmentStatus ?? null,
      order.orderNumber ?? null,
      order.lineItems ?? null,
      order.tags ?? null,
      order.metadata ?? '{}',
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_orders WHERE id = ?`)
    .bind(id)
    .first<{ id: string; shopify_order_id: string; [key: string]: unknown }>())!;
}

export async function getShopifyOrders(
  db: D1Database,
  filters?: {
    friendId?: string;
    email?: string;
    limit?: number;
    offset?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  if (filters?.friendId) {
    const result = await db
      .prepare(`SELECT * FROM shopify_orders WHERE friend_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(filters.friendId, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  if (filters?.email) {
    const result = await db
      .prepare(`SELECT * FROM shopify_orders WHERE email = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(filters.email, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  const result = await db
    .prepare(`SELECT * FROM shopify_orders ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function getShopifyOrderById(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db.prepare(`SELECT * FROM shopify_orders WHERE id = ?`).bind(id).first<Record<string, unknown>>();
}

export async function getShopifyOrderByShopifyId(
  db: D1Database,
  shopifyOrderId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM shopify_orders WHERE shopify_order_id = ?`)
    .bind(shopifyOrderId)
    .first<Record<string, unknown>>();
}

// ===== Shopify Customers =====

export async function upsertShopifyCustomer(
  db: D1Database,
  customer: {
    shopifyCustomerId: string;
    friendId?: string;
    email?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    ordersCount?: number;
    totalSpent?: number;
    tags?: string;
    metadata?: string;
  },
): Promise<{ id: string; shopify_customer_id: string; [key: string]: unknown }> {
  const existing = await db
    .prepare(`SELECT * FROM shopify_customers WHERE shopify_customer_id = ?`)
    .bind(customer.shopifyCustomerId)
    .first<{ id: string; shopify_customer_id: string; [key: string]: unknown }>();

  const now = jstNow();

  if (existing) {
    await db
      .prepare(
        `UPDATE shopify_customers SET friend_id = COALESCE(?, friend_id), email = COALESCE(?, email), phone = COALESCE(?, phone), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), orders_count = COALESCE(?, orders_count), total_spent = COALESCE(?, total_spent), tags = COALESCE(?, tags), updated_at = ? WHERE shopify_customer_id = ?`,
      )
      .bind(
        customer.friendId ?? null,
        customer.email ?? null,
        customer.phone ?? null,
        customer.firstName ?? null,
        customer.lastName ?? null,
        customer.ordersCount ?? null,
        customer.totalSpent ?? null,
        customer.tags ?? null,
        now,
        customer.shopifyCustomerId,
      )
      .run();

    return (await db
      .prepare(`SELECT * FROM shopify_customers WHERE id = ?`)
      .bind(existing.id)
      .first<{ id: string; shopify_customer_id: string; [key: string]: unknown }>())!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shopify_customers (id, shopify_customer_id, friend_id, email, phone, first_name, last_name, orders_count, total_spent, tags, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      customer.shopifyCustomerId,
      customer.friendId ?? null,
      customer.email ?? null,
      customer.phone ?? null,
      customer.firstName ?? null,
      customer.lastName ?? null,
      customer.ordersCount ?? 0,
      customer.totalSpent ?? 0,
      customer.tags ?? null,
      customer.metadata ?? '{}',
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM shopify_customers WHERE id = ?`)
    .bind(id)
    .first<{ id: string; shopify_customer_id: string; [key: string]: unknown }>())!;
}

export async function getShopifyCustomers(
  db: D1Database,
  filters?: {
    friendId?: string;
    email?: string;
    limit?: number;
    offset?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  if (filters?.friendId) {
    const result = await db
      .prepare(`SELECT * FROM shopify_customers WHERE friend_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(filters.friendId, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  if (filters?.email) {
    const result = await db
      .prepare(`SELECT * FROM shopify_customers WHERE email = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(filters.email, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  const result = await db
    .prepare(`SELECT * FROM shopify_customers ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function getShopifyCustomerByShopifyId(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM shopify_customers WHERE shopify_customer_id = ?`)
    .bind(shopifyCustomerId)
    .first<Record<string, unknown>>();
}

export async function linkShopifyCustomerToFriend(
  db: D1Database,
  shopifyCustomerId: string,
  friendId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE shopify_customers SET friend_id = ?, updated_at = ? WHERE shopify_customer_id = ?`)
    .bind(friendId, now, shopifyCustomerId)
    .run();
  await db
    .prepare(`UPDATE shopify_orders SET friend_id = ? WHERE shopify_customer_id = ? AND friend_id IS NULL`)
    .bind(friendId, shopifyCustomerId)
    .run();
}
