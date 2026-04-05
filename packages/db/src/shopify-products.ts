import { jstNow } from './utils.js';

// ---------- Types ----------

export interface ShopifyProduct {
  id: string;
  shopify_product_id: string;
  title: string;
  description: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  status: 'active' | 'draft' | 'archived';
  image_url: string | null;
  price: string | null;
  compare_at_price: string | null;
  tags: string | null;
  variants_json: string | null;
  store_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertShopifyProductInput {
  shopifyProductId: string;
  title: string;
  description?: string | null;
  vendor?: string | null;
  productType?: string | null;
  handle?: string | null;
  status?: 'active' | 'draft' | 'archived';
  imageUrl?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  tags?: string | null;
  variantsJson?: string | null;
  storeUrl?: string | null;
}

export interface ProductRecommendation {
  id: string;
  friend_id: string;
  shopify_product_id: string;
  trigger_type: 'purchase' | 'browse' | 'restock' | 'manual' | 'scheduled';
  sent_at: string;
}

// ---------- Product CRUD ----------

export async function upsertShopifyProduct(
  db: D1Database,
  input: UpsertShopifyProductInput,
): Promise<ShopifyProduct> {
  const now = jstNow();
  const existing = await getShopifyProductByShopifyId(db, input.shopifyProductId);

  if (existing) {
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    const mapping: Array<[keyof UpsertShopifyProductInput, string]> = [
      ['title', 'title'],
      ['description', 'description'],
      ['vendor', 'vendor'],
      ['productType', 'product_type'],
      ['handle', 'handle'],
      ['status', 'status'],
      ['imageUrl', 'image_url'],
      ['price', 'price'],
      ['compareAtPrice', 'compare_at_price'],
      ['tags', 'tags'],
      ['variantsJson', 'variants_json'],
      ['storeUrl', 'store_url'],
    ];

    for (const [key, col] of mapping) {
      if (input[key] !== undefined) {
        fields.push(`${col} = ?`);
        values.push(input[key]);
      }
    }

    values.push(existing.id);
    await db
      .prepare(`UPDATE shopify_products SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    return (await getShopifyProductById(db, existing.id))!;
  }

  // Insert new
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shopify_products
         (id, shopify_product_id, title, description, vendor, product_type, handle, status,
          image_url, price, compare_at_price, tags, variants_json, store_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.shopifyProductId,
      input.title,
      input.description ?? null,
      input.vendor ?? null,
      input.productType ?? null,
      input.handle ?? null,
      input.status ?? 'active',
      input.imageUrl ?? null,
      input.price ?? null,
      input.compareAtPrice ?? null,
      input.tags ?? null,
      input.variantsJson ?? null,
      input.storeUrl ?? null,
      now,
      now,
    )
    .run();

  return (await getShopifyProductById(db, id))!;
}

export async function getShopifyProducts(
  db: D1Database,
  opts?: { status?: string; productType?: string; limit?: number; offset?: number },
): Promise<ShopifyProduct[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (opts?.status) {
    conditions.push('status = ?');
    values.push(opts.status);
  }
  if (opts?.productType) {
    conditions.push('product_type = ?');
    values.push(opts.productType);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const result = await db
    .prepare(`SELECT * FROM shopify_products ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...values, limit, offset)
    .all<ShopifyProduct>();
  return result.results;
}

export async function getShopifyProductById(
  db: D1Database,
  id: string,
): Promise<ShopifyProduct | null> {
  return db.prepare('SELECT * FROM shopify_products WHERE id = ?').bind(id).first<ShopifyProduct>();
}

export async function getShopifyProductByShopifyId(
  db: D1Database,
  shopifyProductId: string,
): Promise<ShopifyProduct | null> {
  return db
    .prepare('SELECT * FROM shopify_products WHERE shopify_product_id = ?')
    .bind(shopifyProductId)
    .first<ShopifyProduct>();
}

export async function deleteShopifyProduct(
  db: D1Database,
  id: string,
): Promise<void> {
  await db.prepare('DELETE FROM shopify_products WHERE id = ?').bind(id).run();
}

// ---------- Recommendations ----------

export async function recordProductRecommendation(
  db: D1Database,
  friendId: string,
  shopifyProductId: string,
  triggerType: ProductRecommendation['trigger_type'],
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  // INSERT OR IGNORE to avoid duplicates (unique index)
  await db
    .prepare(
      `INSERT OR IGNORE INTO product_recommendations (id, friend_id, shopify_product_id, trigger_type, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, friendId, shopifyProductId, triggerType, now)
    .run();
}

export async function getRecommendedProductIds(
  db: D1Database,
  friendId: string,
  triggerType?: string,
): Promise<Set<string>> {
  let sql = 'SELECT shopify_product_id FROM product_recommendations WHERE friend_id = ?';
  const values: unknown[] = [friendId];

  if (triggerType) {
    sql += ' AND trigger_type = ?';
    values.push(triggerType);
  }

  const result = await db.prepare(sql).bind(...values).all<{ shopify_product_id: string }>();
  return new Set(result.results.map((r) => r.shopify_product_id));
}

export async function getProductsNotRecommendedTo(
  db: D1Database,
  friendId: string,
  triggerType: string,
  limit = 5,
): Promise<ShopifyProduct[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM shopify_products p
       WHERE p.status = 'active'
         AND p.shopify_product_id NOT IN (
           SELECT shopify_product_id FROM product_recommendations
           WHERE friend_id = ? AND trigger_type = ?
         )
       ORDER BY p.updated_at DESC
       LIMIT ?`,
    )
    .bind(friendId, triggerType, limit)
    .all<ShopifyProduct>();
  return result.results;
}
