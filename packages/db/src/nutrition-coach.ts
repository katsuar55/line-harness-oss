import { jstNow } from './utils.js';

// ============================================================
// 型定義
// ============================================================

/** 栄養不足の判定結果 (services/nutrition-analyzer.ts が出力) */
export interface NutritionDeficit {
  /** 栄養素キー */
  key:
    | 'protein_low'
    | 'fiber_low'
    | 'iron_low'
    | 'calorie_low'
    | 'calorie_high';
  /** 観測平均 (1日あたり) */
  observedAvg: number;
  /** 目標平均 (1日あたり, 厚労省「日本人の食事摂取基準 2025」を参照) */
  targetAvg: number;
  /** 軽度/中度/強度 */
  severity: 'mild' | 'moderate' | 'severe';
}

/** SKU レコメンド (services/nutrition-recommender.ts が組み立て) */
export interface SkuSuggestion {
  shopifyProductId: string;
  productTitle: string;
  /** 60 字以内・効能効果断定なしのコピー */
  copy: string;
  deficitKey: NutritionDeficit['key'];
}

export type NutritionRecommendationStatus =
  | 'active'
  | 'dismissed'
  | 'clicked'
  | 'converted';

export interface NutritionRecommendation {
  id: string;
  friend_id: string;
  generated_at: string;
  deficit_json: string;
  sku_suggestions_json: string;
  ai_message: string;
  status: NutritionRecommendationStatus;
  sent_at: string | null;
  clicked_at: string | null;
  converted_at: string | null;
  conversion_event_id: string | null;
}

export interface SkuMapRow {
  deficit_key: string;
  shopify_product_id: string;
  product_title: string;
  copy_template: string;
  is_active: number;
  created_at: string;
}

export interface CoachAnalytics {
  /** 集計期間内に生成されたレコメンド総数 */
  generated: number;
  /** クリック (status='clicked' or 'converted') */
  clicked: number;
  /** 実際に購入に至った数 (status='converted') */
  converted: number;
  /** click-through rate (clicked/generated) */
  ctr: number;
  /** conversion rate (converted/generated) */
  cvr: number;
}

export interface InsertRecommendationInput {
  friendId: string;
  deficits: ReadonlyArray<NutritionDeficit>;
  suggestions: ReadonlyArray<SkuSuggestion>;
  aiMessage: string;
  /** 配信タイミングを記録するなら指定 (LIFF オンデマンド表示なら省略) */
  sentAt?: string;
}

// ============================================================
// クエリ関数
// ============================================================

/**
 * 新規レコメンドを INSERT。status='active' で作成。
 *
 * deficits / suggestions は **必ず非空配列** であること (caller 側で gate)。
 * 空配列の場合は呼び出さない設計 (LIFF 表示時に意味のないカードになるため)。
 */
export async function insertNutritionRecommendation(
  db: D1Database,
  input: InsertRecommendationInput,
  id?: string,
): Promise<NutritionRecommendation> {
  const newId = id ?? crypto.randomUUID();
  const now = jstNow();
  const deficitJson = JSON.stringify(input.deficits);
  const suggestionsJson = JSON.stringify(input.suggestions);
  const sentAt = input.sentAt ?? null;

  await db
    .prepare(
      `INSERT INTO nutrition_recommendations (
         id, friend_id, generated_at, deficit_json, sku_suggestions_json,
         ai_message, status, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .bind(
      newId,
      input.friendId,
      now,
      deficitJson,
      suggestionsJson,
      input.aiMessage,
      sentAt,
    )
    .run();

  return {
    id: newId,
    friend_id: input.friendId,
    generated_at: now,
    deficit_json: deficitJson,
    sku_suggestions_json: suggestionsJson,
    ai_message: input.aiMessage,
    status: 'active',
    sent_at: sentAt,
    clicked_at: null,
    converted_at: null,
    conversion_event_id: null,
  };
}

/**
 * 友だちの最新 active レコメンド (1 件) を取得。
 * dismissed / clicked / converted のものは返さない (LIFF 上で再表示しないため)。
 */
export async function getLatestActiveRecommendation(
  db: D1Database,
  friendId: string,
): Promise<NutritionRecommendation | null> {
  return await db
    .prepare(
      `SELECT * FROM nutrition_recommendations
        WHERE friend_id = ? AND status = 'active'
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .bind(friendId)
    .first<NutritionRecommendation>();
}

/**
 * 友だちのレコメンド履歴を generated_at 降順で返す。
 * 管理画面 / デバッグ用 (active 以外も含む)。
 */
export async function getRecommendationsByFriend(
  db: D1Database,
  friendId: string,
  limit = 20,
): Promise<NutritionRecommendation[]> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const { results } = await db
    .prepare(
      `SELECT * FROM nutrition_recommendations
        WHERE friend_id = ?
        ORDER BY generated_at DESC
        LIMIT ?`,
    )
    .bind(friendId, safeLimit)
    .all<NutritionRecommendation>();
  return results;
}

/**
 * status を遷移させる。
 *
 * - 'dismissed' / 'clicked' / 'converted' のいずれかで呼ぶ
 * - 'converted' なら conversion_event_id を併せて記録 (CV 計測基盤と紐付け)
 * - clicked_at / converted_at を JST で自動セット
 *
 * 既に同 status の場合は何もしない (no-op)。
 */
export async function markRecommendationStatus(
  db: D1Database,
  id: string,
  status: Exclude<NutritionRecommendationStatus, 'active'>,
  conversionEventId?: string,
): Promise<void> {
  const now = jstNow();

  if (status === 'dismissed') {
    await db
      .prepare(
        `UPDATE nutrition_recommendations
            SET status = 'dismissed'
          WHERE id = ? AND status = 'active'`,
      )
      .bind(id)
      .run();
    return;
  }

  if (status === 'clicked') {
    // active → clicked のみ。clicked → clicked は no-op
    await db
      .prepare(
        `UPDATE nutrition_recommendations
            SET status = 'clicked', clicked_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .bind(now, id)
      .run();
    return;
  }

  // converted: clicked or active からの遷移を許容
  await db
    .prepare(
      `UPDATE nutrition_recommendations
          SET status = 'converted',
              converted_at = ?,
              conversion_event_id = ?
        WHERE id = ? AND status IN ('active', 'clicked')`,
    )
    .bind(now, conversionEventId ?? null, id)
    .run();
}

/**
 * 不足キー → SKU 行を取得。
 * is_active = 0 の SKU は返さない (販売停止に備える)。
 */
export async function getSkuMapByDeficit(
  db: D1Database,
  key: string,
): Promise<SkuMapRow | null> {
  return await db
    .prepare(
      `SELECT * FROM nutrition_sku_map
        WHERE deficit_key = ? AND is_active = 1`,
    )
    .bind(key)
    .first<SkuMapRow>();
}

/**
 * 全 SKU 一覧 (管理画面用)。
 */
export async function listSkuMaps(db: D1Database): Promise<SkuMapRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM nutrition_sku_map ORDER BY deficit_key ASC`,
    )
    .all<SkuMapRow>();
  return results;
}

/**
 * SKU マップを upsert (管理画面から SKU を追加・更新するとき用)。
 */
export async function upsertSkuMap(
  db: D1Database,
  row: {
    deficitKey: string;
    shopifyProductId: string;
    productTitle: string;
    copyTemplate: string;
    isActive?: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO nutrition_sku_map (
         deficit_key, shopify_product_id, product_title, copy_template, is_active
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(deficit_key) DO UPDATE SET
         shopify_product_id = excluded.shopify_product_id,
         product_title      = excluded.product_title,
         copy_template      = excluded.copy_template,
         is_active          = excluded.is_active`,
    )
    .bind(
      row.deficitKey,
      row.shopifyProductId,
      row.productTitle,
      row.copyTemplate,
      row.isActive === false ? 0 : 1,
    )
    .run();
}

/**
 * 期間内の生成数 / クリック数 / CV 数 / CTR / CVR を返す。
 * 0 件の期間でも NaN を返さず 0 を返す。
 */
export async function getCoachAnalytics(
  db: D1Database,
  fromDate: string,
  toDate: string,
): Promise<CoachAnalytics> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS generated,
         SUM(CASE WHEN status IN ('clicked', 'converted') THEN 1 ELSE 0 END) AS clicked,
         SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted
       FROM nutrition_recommendations
       WHERE generated_at >= ? AND generated_at <= ?`,
    )
    .bind(fromDate, toDate)
    .first<{ generated: number; clicked: number | null; converted: number | null }>();

  const generated = row?.generated ?? 0;
  const clicked = row?.clicked ?? 0;
  const converted = row?.converted ?? 0;

  return {
    generated,
    clicked,
    converted,
    ctr: generated > 0 ? clicked / generated : 0,
    cvr: generated > 0 ? converted / generated : 0,
  };
}

/**
 * status='active' で `generated_at` が指定日時より古いレコメンド数。
 * 古い active を「停滞」として可視化する管理画面で使う想定。
 */
export async function countStaleActiveRecommendations(
  db: D1Database,
  olderThanIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM nutrition_recommendations
        WHERE status = 'active' AND generated_at < ?`,
    )
    .bind(olderThanIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
