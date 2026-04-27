/**
 * 栄養不足解析サービス (Phase 4 PR-2)
 *
 * Phase 3 で蓄積した `daily_food_stats` (PFC + カロリー × 日次) から
 * 直近 7 日窓を読み、決定論的に「栄養不足キー」を返す。
 *
 * 設計方針:
 * - **AI を使わない**。判定基準は厚労省「日本人の食事摂取基準 2025」相当のシンプルな
 *   閾値テーブルベース。安定性 + コスト 0 + 説明可能性を優先。
 * - **保守的な default**。性別 / 年齢が未登録の friend は「成人女性」想定 (naturism は
 *   女性向けインナーケアサプリブランドのため)。本格運用時は friends.metadata から
 *   取得して切り替える。
 * - **データ不足時は空配列**: 食事ログが 5 日未満の friend には判定しない。LIFF 側で
 *   「データ不足のため判定不可」表示を出す想定。
 * - **過剰陰性 > 過剰陽性**: 微妙なケースでは deficit を出さない (薬機法的にも誇張防止)。
 *
 * 戻り値の `severity`:
 * - mild     観測値が目標の 70-90% (摂取不足は warn) / 110-130% (過剰)
 * - moderate 50-70%             /                     130-150%
 * - severe   〜50%               /                     150%〜
 */

import { getDailyFoodStatsRange, type DailyFoodStats } from '@line-crm/db';
import type { NutritionDeficit } from '@line-crm/db';

// ============================================================
// 定数 (厚労省「日本人の食事摂取基準 2025」相当のシンプル化)
// ============================================================

/** 分析に必要な最低日数 (これ未満なら判定しない) */
export const MIN_DAYS_FOR_ANALYSIS = 5;

/** 解析窓 (直近 N 日) */
export const ANALYSIS_WINDOW_DAYS = 7;

/**
 * 栄養素の 1 日あたり目標値 (成人女性 18-49 歳 平均)。
 * naturism のメインターゲットを想定。
 *
 * 出典: 厚生労働省「日本人の食事摂取基準 2025」推定平均必要量 / 目安量を参考に
 *       実運用に合わせて単純化。
 *
 * - 鉄 (iron) は本来 mg だが daily_food_stats には鉄の集計列がないため
 *   PR-2 では暫定的に「タンパク質低下と相関する貧血リスク」として扱い、
 *   protein_low + calorie_low の同時発生時に補助判定 (将来 micro nutrients
 *   テーブルが入ったら独立判定へ)。
 */
export const NUTRITION_TARGET_FEMALE_ADULT = {
  /** 1 日カロリー目標 (kcal) */
  calorie: 2000,
  /** 1 日タンパク質目標 (g) */
  protein_g: 65,
  /** 1 日脂質目標 (g) — 過剰参考用 */
  fat_g: 60,
  /** 1 日炭水化物目標 (g) — 過剰参考用 */
  carbs_g: 280,
} as const;

// ============================================================
// 型
// ============================================================

export interface AnalyzeNutritionInput {
  db: D1Database;
  friendId: string;
  /** 解析の基準日 (YYYY-MM-DD JST)。default は今日 (UTC+9 で計算) */
  asOfDate?: string;
}

export interface AnalyzeNutritionResult {
  /** 解析対象の日付範囲 */
  fromDate: string;
  toDate: string;
  /** 実際に集計された日数 (5 日未満なら deficits は空配列) */
  daysWithData: number;
  /** 1 日あたり平均 (集計対象日のみで割る) */
  averages: {
    calorie: number;
    protein_g: number;
    fat_g: number;
    carbs_g: number;
  } | null;
  /** 不足 / 過剰判定。空配列 = 問題なし or データ不足 */
  deficits: NutritionDeficit[];
  /** スキップ理由 (データ不足等) */
  skipReason?: 'insufficient_data' | 'no_data';
}

// ============================================================
// ヘルパー: JST 日付計算
// ============================================================

/** 今日の JST 日付 (YYYY-MM-DD) */
function todayJst(): string {
  const now = new Date();
  // UTC を JST (+9) に変換
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** YYYY-MM-DD 文字列から N 日前の日付を返す (JST 想定の単純減算) */
function daysAgoJst(dateStr: string, days: number): string {
  // YYYY-MM-DD を UTC 解釈してから減算 (DST なし、JST は単純加算なので OK)
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) {
    throw new Error(`Invalid date string: ${dateStr}`);
  }
  const past = new Date(t - days * 86_400_000);
  return past.toISOString().slice(0, 10);
}

// ============================================================
// 判定ロジック (export してテスト容易)
// ============================================================

export function severityFor(observed: number, target: number, direction: 'low' | 'high'): NutritionDeficit['severity'] | null {
  if (target <= 0) return null;
  const ratio = observed / target;

  if (direction === 'low') {
    // observed < target の度合い
    if (ratio >= 0.9) return null; // 90% 以上は問題なし
    if (ratio >= 0.7) return 'mild';
    if (ratio >= 0.5) return 'moderate';
    return 'severe';
  }

  // direction === 'high': observed > target の度合い
  if (ratio <= 1.1) return null; // 110% 以下は問題なし
  if (ratio <= 1.3) return 'mild';
  if (ratio <= 1.5) return 'moderate';
  return 'severe';
}

/** averages → deficits に変換 (純粋関数、テスト容易) */
export function evaluateDeficits(averages: AnalyzeNutritionResult['averages']): NutritionDeficit[] {
  if (!averages) return [];

  const target = NUTRITION_TARGET_FEMALE_ADULT;
  const out: NutritionDeficit[] = [];

  // タンパク質不足 (最優先 — naturism の主要 SKU と直結)
  const proteinSeverity = severityFor(averages.protein_g, target.protein_g, 'low');
  if (proteinSeverity) {
    out.push({
      key: 'protein_low',
      observedAvg: round1(averages.protein_g),
      targetAvg: target.protein_g,
      severity: proteinSeverity,
    });
  }

  // カロリー不足 / 過剰 (片方のみ報告)
  const calorieLow = severityFor(averages.calorie, target.calorie, 'low');
  const calorieHigh = severityFor(averages.calorie, target.calorie, 'high');
  if (calorieLow) {
    out.push({
      key: 'calorie_low',
      observedAvg: Math.round(averages.calorie),
      targetAvg: target.calorie,
      severity: calorieLow,
    });
  } else if (calorieHigh) {
    out.push({
      key: 'calorie_high',
      observedAvg: Math.round(averages.calorie),
      targetAvg: target.calorie,
      severity: calorieHigh,
    });
  }

  // 鉄分判定 (簡易版): protein も低く calorie も低い場合のみ「鉄分も気になる」軽度提示。
  // 厳密な鉄分量は持っていないため、severity は最大 mild にクリップ。
  if (proteinSeverity && calorieLow) {
    out.push({
      key: 'iron_low',
      observedAvg: 0, // 直接観測ではないため 0 を入れる (UI 側で「鉄分量未計測」と注釈)
      targetAvg: 10.5, // 成人女性月経あり推奨値の概算
      severity: 'mild',
    });
  }

  // 食物繊維: daily_food_stats は fiber を持っていない (model_version 1 では out of scope)。
  // 暫定: protein も calorie も足りているのに carbs が極端に少ない場合に「主食/野菜が偏っているかも」
  //       として fiber_low を mild で返す。本格運用時は food_logs.ai_analysis から fiber_g を集計し直す。
  if (!proteinSeverity && !calorieLow && averages.carbs_g < target.carbs_g * 0.6) {
    out.push({
      key: 'fiber_low',
      observedAvg: round1(averages.carbs_g),
      targetAvg: target.carbs_g,
      severity: 'mild',
    });
  }

  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 集計テーブル → 平均値 */
export function summarizeAverages(stats: ReadonlyArray<DailyFoodStats>): AnalyzeNutritionResult['averages'] {
  if (stats.length === 0) return null;
  let cal = 0, p = 0, f = 0, c = 0;
  for (const s of stats) {
    cal += s.total_calories ?? 0;
    p += s.total_protein_g ?? 0;
    f += s.total_fat_g ?? 0;
    c += s.total_carbs_g ?? 0;
  }
  const n = stats.length;
  return {
    calorie: cal / n,
    protein_g: p / n,
    fat_g: f / n,
    carbs_g: c / n,
  };
}

// ============================================================
// メイン関数
// ============================================================

/**
 * friend の直近 7 日の食事集計から栄養不足を判定する。
 *
 * @example
 * const result = await analyzeFriendNutrition({ db, friendId: 'f1' });
 * if (result.skipReason === 'insufficient_data') {
 *   // LIFF UI で「もう少しデータが集まったら判定できます」と表示
 * } else {
 *   for (const d of result.deficits) console.log(d.key, d.severity);
 * }
 */
export async function analyzeFriendNutrition(
  input: AnalyzeNutritionInput,
): Promise<AnalyzeNutritionResult> {
  const toDate = input.asOfDate ?? todayJst();
  const fromDate = daysAgoJst(toDate, ANALYSIS_WINDOW_DAYS - 1);

  const stats = await getDailyFoodStatsRange(input.db, input.friendId, fromDate, toDate);

  if (stats.length === 0) {
    return {
      fromDate,
      toDate,
      daysWithData: 0,
      averages: null,
      deficits: [],
      skipReason: 'no_data',
    };
  }

  if (stats.length < MIN_DAYS_FOR_ANALYSIS) {
    return {
      fromDate,
      toDate,
      daysWithData: stats.length,
      averages: summarizeAverages(stats),
      deficits: [],
      skipReason: 'insufficient_data',
    };
  }

  const averages = summarizeAverages(stats);
  const deficits = evaluateDeficits(averages);

  return {
    fromDate,
    toDate,
    daysWithData: stats.length,
    averages,
    deficits,
  };
}

// ============================================================
// テスト用エクスポート
// ============================================================
export const __test__ = {
  todayJst,
  daysAgoJst,
  round1,
};
