/**
 * Phase 6 PR-3 — 購入連動クロスセルマップの DB ヘルパー
 *
 * `purchase_cross_sell_map` の CRUD と suggest 取得を提供する。
 * 推薦ロジックは pure に近く、subscription reminder push と admin 画面で再利用。
 */

export interface CrossSellRule {
  source_product_id: string;
  recommended_product_id: string;
  reason: string | null;
  priority: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertCrossSellInput {
  sourceProductId: string;
  recommendedProductId: string;
  reason?: string | null;
  priority?: number;
  isActive?: boolean;
}

/**
 * 推薦候補を priority DESC + recommended_product_id ASC 順で取得。
 * is_active = 1 のみ。limit デフォルト 2、最大 5。
 */
export async function getCrossSellSuggestions(
  db: D1Database,
  sourceProductId: string,
  options: { limit?: number } = {},
): Promise<CrossSellRule[]> {
  const limit = Math.min(Math.max(options.limit ?? 2, 1), 5);
  const { results } = await db
    .prepare(
      `SELECT source_product_id, recommended_product_id, reason, priority,
              is_active, created_at, updated_at
       FROM purchase_cross_sell_map
       WHERE source_product_id = ? AND is_active = 1
       ORDER BY priority DESC, recommended_product_id ASC
       LIMIT ?`,
    )
    .bind(sourceProductId, limit)
    .all<CrossSellRule>();
  return results ?? [];
}

/**
 * 1 ルールを upsert。複合 PK (source_product_id, recommended_product_id) で一意。
 */
export async function upsertCrossSellRule(
  db: D1Database,
  input: UpsertCrossSellInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO purchase_cross_sell_map
        (source_product_id, recommended_product_id, reason, priority,
         is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_product_id, recommended_product_id) DO UPDATE SET
         reason = excluded.reason,
         priority = excluded.priority,
         is_active = excluded.is_active,
         updated_at = excluded.updated_at`,
    )
    .bind(
      input.sourceProductId,
      input.recommendedProductId,
      input.reason ?? null,
      input.priority ?? 0,
      input.isActive === false ? 0 : 1,
      now,
      now,
    )
    .run();
}

/**
 * 全ルール取得 (管理画面用)。
 */
export async function listCrossSellRules(
  db: D1Database,
  options: { limit?: number; sourceProductId?: string } = {},
): Promise<CrossSellRule[]> {
  const limit = Math.min(options.limit ?? 200, 500);
  if (options.sourceProductId) {
    const { results } = await db
      .prepare(
        `SELECT source_product_id, recommended_product_id, reason, priority,
                is_active, created_at, updated_at
         FROM purchase_cross_sell_map
         WHERE source_product_id = ?
         ORDER BY priority DESC, recommended_product_id ASC
         LIMIT ?`,
      )
      .bind(options.sourceProductId, limit)
      .all<CrossSellRule>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT source_product_id, recommended_product_id, reason, priority,
              is_active, created_at, updated_at
       FROM purchase_cross_sell_map
       ORDER BY source_product_id ASC, priority DESC, recommended_product_id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<CrossSellRule>();
  return results ?? [];
}

/**
 * 1 ルールを削除。
 */
export async function deleteCrossSellRule(
  db: D1Database,
  sourceProductId: string,
  recommendedProductId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM purchase_cross_sell_map
       WHERE source_product_id = ? AND recommended_product_id = ?`,
    )
    .bind(sourceProductId, recommendedProductId)
    .run();
}
