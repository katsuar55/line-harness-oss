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
    // 2026-05-10 fix: UPDATE に metadata 列が抜けていた (customers と同パターン bug)。
    // COALESCE で「指定があれば上書き、 無ければ既存維持」 にする。
    // orders/updated で注文が編集された場合 (金額/商品/連絡先 変更) も反映できるよう、
    // total_price / line_items / email / phone / order_number も COALESCE で
    // 「指定があれば上書き、 無ければ既存維持」 にする (従来は UPDATE で一切触らず stale)。
    await db
      .prepare(
        `UPDATE shopify_orders SET financial_status = ?, fulfillment_status = ?, friend_id = COALESCE(?, friend_id), tags = COALESCE(?, tags), metadata = COALESCE(?, metadata), total_price = COALESCE(?, total_price), line_items = COALESCE(?, line_items), email = COALESCE(?, email), phone = COALESCE(?, phone), order_number = COALESCE(?, order_number), updated_at = ? WHERE shopify_order_id = ?`,
      )
      .bind(
        order.financialStatus ?? existing.financial_status ?? null,
        order.fulfillmentStatus ?? existing.fulfillment_status ?? null,
        order.friendId ?? null,
        order.tags ?? null,
        order.metadata ?? null,
        order.totalPrice ?? null,
        order.lineItems ?? null,
        order.email ?? null,
        order.phone ?? null,
        order.orderNumber ?? null,
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
    // 2026-05-10 fix: UPDATE に metadata 列が抜けていたため、 既存 customer の metadata が永久に
    // 上書きされない bug があった。COALESCE で「指定があれば上書き、 無ければ既存維持」 にする。
    await db
      .prepare(
        `UPDATE shopify_customers SET friend_id = COALESCE(?, friend_id), email = COALESCE(?, email), phone = COALESCE(?, phone), first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), orders_count = COALESCE(?, orders_count), total_spent = COALESCE(?, total_spent), tags = COALESCE(?, tags), metadata = COALESCE(?, metadata), updated_at = ? WHERE shopify_customer_id = ?`,
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
        customer.metadata ?? null,
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

export interface BatchUpsertShopifyCustomerInput {
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
}

/**
 * shopify_customers を 1 回の db.batch() でまとめて upsert する (cron 一括同期用)。
 *
 * upsertShopifyCustomer は 1 顧客あたり D1 round-trip が 3 回 (SELECT→UPDATE/INSERT→SELECT)
 * 走るため、数千件のフル同期では 1 invocation の途中で D1 接続断が起きて完走できなかった
 * (2026-08-11 調査: shopify-customer-sync の cron_run_logs 全行に D1_ERROR が残る状態)。
 * ON CONFLICT 1 文に畳むことでページ (250 件) あたり 1 round-trip にする。
 *
 * COALESCE の update 挙動 (指定があれば上書き・無ければ既存維持) は upsertShopifyCustomer と
 * 同一。既存行の id / created_at は保持される。
 *
 * 番号付きパラメータ (?N) を使う理由: excluded.* 参照だと「INSERT 時は 0 / '{}' に倒す」と
 * 「UPDATE 時は既存維持」を両立できない (VALUES 側で COALESCE(?, 0) すると excluded が 0 に
 * なり既存値を潰す)。VALUES 側と DO UPDATE 側で同じ ?N を参照し、それぞれの fallback を
 * 書き分けることで単発 upsert (INSERT default 0/'{}' + UPDATE 既存維持) と完全一致させる。
 * NULL を明示 bind すると schema の DEFAULT 句は適用されない点に注意 (segment-query の
 * `total_spent >= ?` は NULL 行を除外してしまうため、新規行の 0 default は必須)。
 */
export async function batchUpsertShopifyCustomers(
  db: D1Database,
  customers: BatchUpsertShopifyCustomerInput[],
): Promise<void> {
  if (customers.length === 0) return;
  const now = jstNow();
  const stmt = db.prepare(
    `INSERT INTO shopify_customers (id, shopify_customer_id, friend_id, email, phone, first_name, last_name, orders_count, total_spent, tags, metadata, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, 0), COALESCE(?9, 0), ?10, COALESCE(?11, '{}'), ?12, ?13)
       ON CONFLICT(shopify_customer_id) DO UPDATE SET
         friend_id = COALESCE(?3, friend_id),
         email = COALESCE(?4, email),
         phone = COALESCE(?5, phone),
         first_name = COALESCE(?6, first_name),
         last_name = COALESCE(?7, last_name),
         orders_count = COALESCE(?8, orders_count),
         total_spent = COALESCE(?9, total_spent),
         tags = COALESCE(?10, tags),
         metadata = COALESCE(?11, metadata),
         updated_at = ?13`,
  );
  await db.batch(
    customers.map((c) =>
      stmt.bind(
        crypto.randomUUID(),
        c.shopifyCustomerId,
        c.friendId ?? null,
        c.email ?? null,
        c.phone ?? null,
        c.firstName ?? null,
        c.lastName ?? null,
        c.ordersCount ?? null,
        c.totalSpent ?? null,
        c.tags ?? null,
        c.metadata ?? null,
        now,
        now,
      ),
    ),
  );
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
