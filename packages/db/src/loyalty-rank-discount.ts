/**
 * loyalty_rank_discounts CRUD (= 自社内製ロイヤリティ ランク割引, 2026-06-04 PR5-5a)
 *
 * 会員ランクに応じた常時%OFF 割引を顧客別 Shopify コード (NLR-) で記録。
 * friend ごとに status='active' は最大1行 (= 現ランクの割引)。
 *
 * 発行ロジック (Shopify API 呼び出し含む) は apps/worker/src/services/rank-discount-issuer.ts。
 * 本ファイルは純 D1 CRUD のみ (= 純粋・テスト容易、 worker 非依存)。
 */

export interface RankDiscount {
  id: string;
  friendId: string;
  rankId: string;
  code: string;
  shopifyDiscountNodeId: string | null;
  discountPercent: number;
  status: string;
  brandId: string | null;
  issuedAt: string;
  expiresAt: string | null;
}

interface RankDiscountRow {
  id: string;
  friend_id: string;
  rank_id: string;
  code: string;
  shopify_discount_node_id: string | null;
  discount_percent: number;
  status: string;
  brand_id: string | null;
  issued_at: string;
  expires_at: string | null;
}

function rowToRankDiscount(r: RankDiscountRow): RankDiscount {
  return {
    id: r.id,
    friendId: r.friend_id,
    rankId: r.rank_id,
    code: r.code,
    shopifyDiscountNodeId: r.shopify_discount_node_id ?? null,
    discountPercent: r.discount_percent,
    status: r.status,
    brandId: r.brand_id ?? null,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at ?? null,
  };
}

const SELECT_COLS =
  'id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, brand_id, issued_at, expires_at';

/** friend の現在 active なランク割引を取得 (= 冪等チェック + 5b permalink)。 */
export async function getActiveRankDiscount(
  db: D1Database,
  friendId: string,
): Promise<RankDiscount | null> {
  const row = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM loyalty_rank_discounts
        WHERE friend_id = ? AND status = 'active'
        ORDER BY issued_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first<RankDiscountRow>();
  return row ? rowToRankDiscount(row) : null;
}

/** 5b 用の軽量アクセサ: active 割引の code+percent のみ (= cart permalink 生成用)。 */
export async function getActiveRankDiscountCode(
  db: D1Database,
  friendId: string,
): Promise<{ code: string; discountPercent: number } | null> {
  const d = await getActiveRankDiscount(db, friendId);
  return d ? { code: d.code, discountPercent: d.discountPercent } : null;
}

export interface InsertRankDiscountInput {
  id: string;
  friendId: string;
  rankId: string;
  code: string;
  shopifyDiscountNodeId: string | null;
  discountPercent: number;
  issuedAt: string;
  expiresAt: string | null;
  brandId?: string | null;
}

/** 新規ランク割引を active として記録。 code UNIQUE 制約で重複は INSERT 失敗。 */
export async function insertRankDiscount(
  db: D1Database,
  input: InsertRankDiscountInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO loyalty_rank_discounts
         (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, brand_id, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.friendId,
      input.rankId,
      input.code,
      input.shopifyDiscountNodeId,
      input.discountPercent,
      input.brandId ?? null,
      input.issuedAt,
      input.expiresAt,
    )
    .run();
}

/**
 * friend の既存 active 割引を superseded 化 (= ランク変更時の旧割引無効化マーク)。 戻り値=更新件数。
 * exceptId 指定時はその id を除外 (= 新規 insert 済み行を supersede しないため。 insert→supersede 順序で必須)。
 */
export async function supersedeActiveRankDiscounts(
  db: D1Database,
  friendId: string,
  supersededAt: string,
  exceptId?: string,
): Promise<number> {
  const res = exceptId
    ? await db
        .prepare(
          `UPDATE loyalty_rank_discounts SET status = 'superseded', superseded_at = ?
            WHERE friend_id = ? AND status = 'active' AND id != ?`,
        )
        .bind(supersededAt, friendId, exceptId)
        .run()
    : await db
        .prepare(
          `UPDATE loyalty_rank_discounts SET status = 'superseded', superseded_at = ?
            WHERE friend_id = ? AND status = 'active'`,
        )
        .bind(supersededAt, friendId)
        .run();
  return res.meta?.changes ?? 0;
}
