/**
 * Phase 6 PR-1 — 商品別再購入間隔の DB ヘルパー
 *
 * `product_repurchase_intervals` テーブルへの CRUD と、
 * `subscription_reminders` の interval_source / sample_size 拡張カラム
 * への upsert ヘルパーを提供する。
 *
 * 推定ロジック本体は `apps/worker/src/services/repurchase-estimator.ts` にあり、
 * 本ファイルはあくまでデータアクセス層に専念する (副作用最小化)。
 */

export type IntervalSource =
  | 'manual'
  | 'product_default'
  | 'user_history'
  | 'seed'
  | 'auto_estimated'
  | 'fallback';

export interface ProductRepurchaseInterval {
  shopify_product_id: string;
  product_title: string | null;
  default_interval_days: number;
  source: IntervalSource;
  sample_size: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertProductIntervalInput {
  shopifyProductId: string;
  productTitle?: string | null;
  defaultIntervalDays: number;
  source?: IntervalSource;
  sampleSize?: number;
  notes?: string | null;
}

/**
 * 商品の推奨再購入間隔を取得。未登録なら null。
 */
export async function getProductInterval(
  db: D1Database,
  shopifyProductId: string,
): Promise<ProductRepurchaseInterval | null> {
  const row = await db
    .prepare(
      `SELECT shopify_product_id, product_title, default_interval_days, source,
              sample_size, notes, created_at, updated_at
       FROM product_repurchase_intervals
       WHERE shopify_product_id = ?`,
    )
    .bind(shopifyProductId)
    .first<ProductRepurchaseInterval>();
  return row ?? null;
}

/**
 * 商品間隔を upsert。`source` 省略時は 'manual'。
 */
export async function upsertProductInterval(
  db: D1Database,
  input: UpsertProductIntervalInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO product_repurchase_intervals
        (shopify_product_id, product_title, default_interval_days, source,
         sample_size, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(shopify_product_id) DO UPDATE SET
         product_title = excluded.product_title,
         default_interval_days = excluded.default_interval_days,
         source = excluded.source,
         sample_size = excluded.sample_size,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.shopifyProductId,
      input.productTitle ?? null,
      input.defaultIntervalDays,
      input.source ?? 'manual',
      input.sampleSize ?? 0,
      input.notes ?? null,
      now,
      now,
    )
    .run();
}

/**
 * 全商品間隔をリスト取得 (管理画面用)。
 */
export async function listProductIntervals(
  db: D1Database,
  options: { limit?: number } = {},
): Promise<ProductRepurchaseInterval[]> {
  const limit = Math.min(options.limit ?? 200, 500);
  const { results } = await db
    .prepare(
      `SELECT shopify_product_id, product_title, default_interval_days, source,
              sample_size, notes, created_at, updated_at
       FROM product_repurchase_intervals
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ProductRepurchaseInterval>();
  return results ?? [];
}

/**
 * 商品間隔を削除 (誤登録のロールバック用)。
 */
export async function deleteProductInterval(
  db: D1Database,
  shopifyProductId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM product_repurchase_intervals WHERE shopify_product_id = ?')
    .bind(shopifyProductId)
    .run();
}

/**
 * 友だちの同 product_id に対する過去注文数 + 平均間隔 (日) を計算。
 * 注文 2 件以上ないと null を返す。
 *
 * shopify_orders.line_items は JSON 配列。各要素に `product_id` (number)
 * を含む前提。pseudo-streaming で 100 件まで取得して JS 側で集計する。
 */
export async function computeUserPurchaseInterval(
  db: D1Database,
  friendId: string,
  shopifyProductId: string,
): Promise<{ averageDays: number; sampleSize: number } | null> {
  const { results } = await db
    .prepare(
      `SELECT created_at, line_items
       FROM shopify_orders
       WHERE friend_id = ?
       ORDER BY created_at ASC
       LIMIT 100`,
    )
    .bind(friendId)
    .all<{ created_at: string; line_items: string | null }>();

  const orderTimes: number[] = [];
  for (const row of results ?? []) {
    if (!row.line_items) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.line_items);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const hasProduct = parsed.some((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const pid = (item as { product_id?: unknown }).product_id;
      return pid !== undefined && pid !== null && String(pid) === shopifyProductId;
    });
    if (hasProduct) {
      const t = Date.parse(row.created_at);
      if (!Number.isNaN(t)) orderTimes.push(t);
    }
  }

  if (orderTimes.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < orderTimes.length; i++) {
    const diffMs = orderTimes[i] - orderTimes[i - 1];
    if (diffMs > 0) intervals.push(diffMs / 86_400_000);
  }
  if (intervals.length === 0) return null;

  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  return { averageDays: avg, sampleSize: intervals.length };
}
