import { jstNow } from './utils.js';

// ============================================================
// 型定義
// ============================================================

export interface FoodLog {
  id: string;
  friend_id: string;
  ate_at: string;
  meal_type: string | null;
  image_url: string | null;
  raw_text: string | null;
  ai_analysis: string | null;
  total_calories: number | null;
  total_protein_g: number | null;
  total_fat_g: number | null;
  total_carbs_g: number | null;
  analysis_status: 'pending' | 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
}

/**
 * Anthropic Claude Vision の解析結果。ai_analysis カラムに JSON で保存。
 * モデル更新時の互換性のため、必須フィールド最小・拡張余地ありの設計。
 */
export interface FoodAnalysis {
  calories: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  fiber_g?: number;
  items: ReadonlyArray<{ name: string; qty?: string }>;
  notes?: string;
  model_version?: string;
}

export interface DailyFoodStats {
  friend_id: string;
  date: string;
  total_calories: number;
  total_protein_g: number;
  total_fat_g: number;
  total_carbs_g: number;
  meal_count: number;
  last_updated: string;
}

export interface MonthlyFoodReport {
  friend_id: string;
  year_month: string;
  summary_text: string;
  meal_count: number;
  avg_calories: number | null;
  generated_at: string;
}

export interface InsertFoodLogInput {
  friendId: string;
  ateAt: string;
  mealType?: string | null;
  imageUrl?: string | null;
  rawText?: string | null;
}

export interface DailyFoodStatsDelta {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  mealCountDelta: number;
}

export interface FoodLogPage {
  logs: FoodLog[];
  nextCursor: string | null;
}

// ============================================================
// クエリ関数
// ============================================================

/**
 * 食事ログを INSERT (analysis_status='pending')。
 * id は省略時に randomUUID で生成。
 */
export async function insertFoodLog(
  db: D1Database,
  input: InsertFoodLogInput,
  id?: string,
): Promise<FoodLog> {
  const newId = id ?? crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO food_logs (
         id, friend_id, ate_at, meal_type, image_url, raw_text,
         analysis_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      newId,
      input.friendId,
      input.ateAt,
      input.mealType ?? null,
      input.imageUrl ?? null,
      input.rawText ?? null,
      now,
    )
    .run();

  return {
    id: newId,
    friend_id: input.friendId,
    ate_at: input.ateAt,
    meal_type: input.mealType ?? null,
    image_url: input.imageUrl ?? null,
    raw_text: input.rawText ?? null,
    ai_analysis: null,
    total_calories: null,
    total_protein_g: null,
    total_fat_g: null,
    total_carbs_g: null,
    analysis_status: 'pending',
    error_message: null,
    created_at: now,
  };
}

/**
 * AI 解析完了時の更新。`food_logs` を 'completed' に遷移し、`daily_food_stats` を加算 upsert。
 *
 * 注意: このメソッドは **1 ログにつき 1 回のみ呼ぶ前提** (再解析の二重加算を防ぐため
 *       caller 側で analysis_status を確認すること)。
 */
export async function updateFoodLogAnalysis(
  db: D1Database,
  id: string,
  analysis: FoodAnalysis,
): Promise<void> {
  const ai = JSON.stringify(analysis);
  const calories = Math.round(analysis.calories);
  const protein = analysis.protein_g;
  const fat = analysis.fat_g;
  const carbs = analysis.carbs_g;

  const updated = await db
    .prepare(
      `UPDATE food_logs
          SET ai_analysis    = ?,
              total_calories = ?,
              total_protein_g = ?,
              total_fat_g    = ?,
              total_carbs_g  = ?,
              analysis_status = 'completed',
              error_message  = NULL
        WHERE id = ?
        RETURNING friend_id, ate_at`,
    )
    .bind(ai, calories, protein, fat, carbs, id)
    .first<{ friend_id: string; ate_at: string }>();

  if (!updated) return;

  const date = updated.ate_at.slice(0, 10);
  await upsertDailyFoodStats(db, updated.friend_id, date, {
    calories,
    protein,
    fat,
    carbs,
    mealCountDelta: 1,
  });
}

/** AI 解析失敗をマーク。集計テーブルは触らない (まだ加算されていないため)。 */
export async function markFoodLogFailed(
  db: D1Database,
  id: string,
  errorMessage: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE food_logs
          SET analysis_status = 'failed',
              error_message   = ?
        WHERE id = ?`,
    )
    .bind(errorMessage.slice(0, 500), id)
    .run();
}

/**
 * daily_food_stats を原子的に upsert。
 * 削除時は **負の delta** を渡せば集計から正しく差し引かれる。
 */
export async function upsertDailyFoodStats(
  db: D1Database,
  friendId: string,
  date: string,
  delta: DailyFoodStatsDelta,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO daily_food_stats (
         friend_id, date, total_calories, total_protein_g,
         total_fat_g, total_carbs_g, meal_count, last_updated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(friend_id, date) DO UPDATE SET
         total_calories  = total_calories  + excluded.total_calories,
         total_protein_g = total_protein_g + excluded.total_protein_g,
         total_fat_g     = total_fat_g     + excluded.total_fat_g,
         total_carbs_g   = total_carbs_g   + excluded.total_carbs_g,
         meal_count      = meal_count      + excluded.meal_count,
         last_updated    = excluded.last_updated`,
    )
    .bind(
      friendId,
      date,
      delta.calories,
      delta.protein,
      delta.fat,
      delta.carbs,
      delta.mealCountDelta,
      now,
    )
    .run();
}

/**
 * 友だちの食事ログを ate_at 降順で取得 (cursor base64)。
 *
 * cursor は "ateAt|id" を base64 エンコード。改ざん耐性は不要 (友だち本人のデータのみ参照)。
 */
export async function getFoodLogsByFriend(
  db: D1Database,
  friendId: string,
  options?: {
    limit?: number;
    cursor?: string | null;
    fromDate?: string;
    toDate?: string;
  },
): Promise<FoodLogPage> {
  const limit = Math.min(options?.limit ?? 20, 100);

  let cursorAteAt: string | null = null;
  let cursorId: string | null = null;
  if (options?.cursor) {
    try {
      const decoded = atob(options.cursor);
      const [a, i] = decoded.split('|');
      if (a && i) {
        cursorAteAt = a;
        cursorId = i;
      }
    } catch {
      // invalid cursor → 先頭から
    }
  }

  let sql = `SELECT * FROM food_logs WHERE friend_id = ?`;
  const params: unknown[] = [friendId];

  if (options?.fromDate) {
    sql += ` AND ate_at >= ?`;
    params.push(options.fromDate);
  }
  if (options?.toDate) {
    sql += ` AND ate_at <= ?`;
    params.push(options.toDate);
  }
  if (cursorAteAt && cursorId) {
    // (ate_at, id) ペアで安定 pagination
    sql += ` AND (ate_at < ? OR (ate_at = ? AND id < ?))`;
    params.push(cursorAteAt, cursorAteAt, cursorId);
  }

  sql += ` ORDER BY ate_at DESC, id DESC LIMIT ?`;
  params.push(limit + 1);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<FoodLog>();

  let nextCursor: string | null = null;
  if (results.length > limit) {
    const last = results[limit - 1];
    if (last) {
      nextCursor = btoa(`${last.ate_at}|${last.id}`);
    }
  }

  return {
    logs: results.slice(0, limit),
    nextCursor,
  };
}

/** 友だちの今日の食事集計 (PFC + カロリー + 食事回数)。未登録なら null */
export async function getDailyFoodStatsForToday(
  db: D1Database,
  friendId: string,
): Promise<DailyFoodStats | null> {
  const today = jstNow().slice(0, 10);
  return await db
    .prepare(`SELECT * FROM daily_food_stats WHERE friend_id = ? AND date = ?`)
    .bind(friendId, today)
    .first<DailyFoodStats>();
}

/** 期間内の日次集計 (グラフ表示用)。fromDate/toDate は YYYY-MM-DD */
export async function getDailyFoodStatsRange(
  db: D1Database,
  friendId: string,
  fromDate: string,
  toDate: string,
): Promise<DailyFoodStats[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM daily_food_stats
         WHERE friend_id = ? AND date >= ? AND date <= ?
         ORDER BY date ASC`,
    )
    .bind(friendId, fromDate, toDate)
    .all<DailyFoodStats>();
  return results;
}

/**
 * 食事ログを削除し、completed なら集計から差し引く。
 * 戻り値: 削除されたら true、見つからなければ false。
 */
export async function deleteFoodLog(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .prepare(
      `DELETE FROM food_logs
        WHERE id = ?
        RETURNING friend_id, ate_at, total_calories,
                  total_protein_g, total_fat_g, total_carbs_g, analysis_status`,
    )
    .bind(id)
    .first<{
      friend_id: string;
      ate_at: string;
      total_calories: number | null;
      total_protein_g: number | null;
      total_fat_g: number | null;
      total_carbs_g: number | null;
      analysis_status: string;
    }>();

  if (!deleted) return false;

  // completed のみ集計に反映済 → 差し引く必要あり
  if (deleted.analysis_status === 'completed') {
    const date = deleted.ate_at.slice(0, 10);
    await upsertDailyFoodStats(db, deleted.friend_id, date, {
      calories: -(deleted.total_calories ?? 0),
      protein: -(deleted.total_protein_g ?? 0),
      fat: -(deleted.total_fat_g ?? 0),
      carbs: -(deleted.total_carbs_g ?? 0),
      mealCountDelta: -1,
    });
  }

  return true;
}

// ============================================================
// 月次 AI レポート (pull 型)
// ============================================================

export async function insertMonthlyFoodReport(
  db: D1Database,
  input: {
    friendId: string;
    yearMonth: string; // "YYYY-MM"
    summaryText: string;
    mealCount: number;
    avgCalories: number | null;
  },
): Promise<MonthlyFoodReport> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO monthly_food_reports (
         friend_id, year_month, summary_text, meal_count, avg_calories, generated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(friend_id, year_month) DO UPDATE SET
         summary_text = excluded.summary_text,
         meal_count   = excluded.meal_count,
         avg_calories = excluded.avg_calories,
         generated_at = excluded.generated_at`,
    )
    .bind(
      input.friendId,
      input.yearMonth,
      input.summaryText,
      input.mealCount,
      input.avgCalories,
      now,
    )
    .run();

  return {
    friend_id: input.friendId,
    year_month: input.yearMonth,
    summary_text: input.summaryText,
    meal_count: input.mealCount,
    avg_calories: input.avgCalories,
    generated_at: now,
  };
}

export async function getMonthlyFoodReport(
  db: D1Database,
  friendId: string,
  yearMonth: string,
): Promise<MonthlyFoodReport | null> {
  return await db
    .prepare(
      `SELECT * FROM monthly_food_reports WHERE friend_id = ? AND year_month = ?`,
    )
    .bind(friendId, yearMonth)
    .first<MonthlyFoodReport>();
}
