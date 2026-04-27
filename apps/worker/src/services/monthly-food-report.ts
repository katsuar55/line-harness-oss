/**
 * 月次食事レポート生成 (Phase 3 PR-7)
 *
 * Cron トリガーで毎月 1 日に前月の食事ログを集計し、Anthropic で
 * パーソナライズされた要約テキストを生成して `monthly_food_reports` に保存する。
 *
 * **pull 型**: friends に push しない。LIFF (`/liff/food/graph`) から
 * `GET /api/liff/food/report/:yearMonth` で取得して表示する。
 *
 * 設計方針:
 * - 日次集計テーブル (daily_food_stats) を使うので毎月 30 行程度しか読まず軽量
 * - 同月内の重複生成は monthly_food_reports.PK で除外 (UPSERT)
 *   ただし API コスト最適化のため、既存レポートが今月生成済ならスキップする
 * - ANTHROPIC_API_KEY 未設定時はテンプレ要約 (AI なし) を保存
 * - 薬機法ガード: food-analyzer と同じ PROHIBITED_PHRASES で再 redaction
 * - 失敗してもメイン処理は止めず Promise.allSettled で進める
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  getDailyFoodStatsRange,
  getMonthlyFoodReport,
  insertMonthlyFoodReport,
  jstNow,
} from '@line-crm/db';
import type { DailyFoodStats } from '@line-crm/db';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const ANALYSIS_TIMEOUT_MS = 30_000;
const ANALYSIS_MAX_TOKENS = 600;

// food-analyzer.ts の PROHIBITED_PHRASES と同期 (二重ガード)
const PROHIBITED_PHRASES = [
  '治る',
  '治す',
  '治療',
  '完治',
  '治癒',
  'ナオル',
  '効く',
  '効果絶大',
  '即効',
  '病気が改善',
  '症状が消える',
  'がんが消える',
  '癌が消える',
  '予防できる',
  '予防効果',
  '医薬品',
  '副作用なし',
  '保証',
  'cure',
  'heal',
] as const;

const REDACTION_TOKEN = '[省略]';

const SUMMARY_SYSTEM_PROMPT = `あなたは管理栄養士のアシスタントです。ユーザの 1 ヶ月分の食事データから、
励ましのトーンで短い要約を生成してください。

# 必須ルール
1. 出力は 200〜300 字の日本語テキスト 1 段落のみ。マークダウン禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善") は **絶対に書かない**。
3. 数値の事実のみ参照し、栄養バランスの観察と来月へのソフトな提案を述べる。
4. 説教調にしない。励まし + 客観事実 + 小さな提案。`;

// ----------------------------------------------------------------
// 型
// ----------------------------------------------------------------

export interface MonthlyAggregation {
  yearMonth: string;
  fromDate: string;
  toDate: string;
  mealCount: number;
  avgCalories: number | null;
  avgProteinG: number | null;
  avgFatG: number | null;
  avgCarbsG: number | null;
  daysLogged: number;
}

export interface ProcessMonthlyFoodReportsOptions {
  /** 今日の JST timestamp (テスト用 override) */
  nowOverride?: string;
  /** ANTHROPIC_API_KEY が空でも常にテンプレ要約のみで動かしたい場合 true */
  forceTemplateOnly?: boolean;
  /** Anthropic SDK モック注入 (テスト用) */
  clientOverride?: Pick<Anthropic, 'messages'>;
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

/**
 * 全友だちの先月分レポートを生成して `monthly_food_reports` に保存する。
 *
 * - 毎月 1 日にのみ実行 (それ以外の日は no-op で即 return)
 * - 1 日に複数回 cron が走っても、各 friend で「既存レポートがあればスキップ」
 *   なので二重生成しない (idempotent)
 *
 * 戻り値: 件数集計 (送信ではなく生成)。
 */
export async function processMonthlyFoodReports(
  db: D1Database,
  apiKey: string | undefined,
  options: ProcessMonthlyFoodReportsOptions = {},
): Promise<{ generated: number; skipped: number; errors: number }> {
  const now = options.nowOverride ?? jstNow();

  // 月初 (JST 1 日) のみ実行
  const dayOfMonth = parseInt(now.slice(8, 10), 10);
  if (dayOfMonth !== 1) {
    return { generated: 0, skipped: 0, errors: 0 };
  }

  // 対象 = 「先月」
  const { yearMonth, fromDate, toDate } = previousMonthRange(now);

  // food_logs を持っていた friend のみ対象 (空ユーザに無駄にレポートを作らない)
  const friends = await db
    .prepare(
      `SELECT DISTINCT friend_id
         FROM daily_food_stats
        WHERE date >= ? AND date <= ?`,
    )
    .bind(fromDate, toDate)
    .all<{ friend_id: string }>();

  let generated = 0;
  let skipped = 0;
  let errors = 0;

  // 直列処理 (Anthropic rate limit 安全側)。10 名/秒以内ならまったく問題ない。
  for (const row of friends.results) {
    const friendId = row.friend_id;
    try {
      const existing = await getMonthlyFoodReport(db, friendId, yearMonth);
      if (existing) {
        skipped++;
        continue;
      }

      const aggregation = await buildAggregation(db, friendId, yearMonth, fromDate, toDate);
      if (aggregation.mealCount === 0 || aggregation.daysLogged === 0) {
        // 集計テーブル経由なので普通は来ないが防御的に skip
        skipped++;
        continue;
      }

      const summaryText = await generateSummary(
        aggregation,
        apiKey,
        options,
      );

      await insertMonthlyFoodReport(db, {
        friendId,
        yearMonth,
        summaryText,
        mealCount: aggregation.mealCount,
        avgCalories: aggregation.avgCalories === null
          ? null
          : Math.round(aggregation.avgCalories),
      });
      generated++;
    } catch (err) {
      errors++;
      // err 全体ではなく要約のみログ (apiKey 等の closure を露出させない)
      console.error(
        `monthly food report failed for ${friendId}:`,
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  return { generated, skipped, errors };
}

// ----------------------------------------------------------------
// 集計
// ----------------------------------------------------------------

async function buildAggregation(
  db: D1Database,
  friendId: string,
  yearMonth: string,
  fromDate: string,
  toDate: string,
): Promise<MonthlyAggregation> {
  const stats = await getDailyFoodStatsRange(db, friendId, fromDate, toDate);

  if (stats.length === 0) {
    return {
      yearMonth,
      fromDate,
      toDate,
      mealCount: 0,
      avgCalories: null,
      avgProteinG: null,
      avgFatG: null,
      avgCarbsG: null,
      daysLogged: 0,
    };
  }

  const totalMeals = stats.reduce((s, r) => s + r.meal_count, 0);
  const totalCalories = stats.reduce((s, r) => s + r.total_calories, 0);
  const totalP = stats.reduce((s, r) => s + r.total_protein_g, 0);
  const totalF = stats.reduce((s, r) => s + r.total_fat_g, 0);
  const totalC = stats.reduce((s, r) => s + r.total_carbs_g, 0);

  const days = stats.length;

  return {
    yearMonth,
    fromDate,
    toDate,
    mealCount: totalMeals,
    avgCalories: days > 0 ? totalCalories / days : null,
    avgProteinG: days > 0 ? roundTo1(totalP / days) : null,
    avgFatG: days > 0 ? roundTo1(totalF / days) : null,
    avgCarbsG: days > 0 ? roundTo1(totalC / days) : null,
    daysLogged: days,
  };
}

// ----------------------------------------------------------------
// AI 要約生成
// ----------------------------------------------------------------

async function generateSummary(
  agg: MonthlyAggregation,
  apiKey: string | undefined,
  options: ProcessMonthlyFoodReportsOptions,
): Promise<string> {
  const fallback = templateSummary(agg);

  if (options.forceTemplateOnly) return fallback;
  if (!apiKey && !options.clientOverride) return fallback;

  const client =
    options.clientOverride ??
    new Anthropic({ apiKey: apiKey as string });

  const userMessage = formatStatsForPrompt(agg);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model: DEFAULT_MODEL,
        max_tokens: ANALYSIS_MAX_TOKENS,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: controller.signal },
    );

    const textBlock = response.content.find((b) => b.type === 'text') as
      | { type: 'text'; text: string }
      | undefined;
    const raw = textBlock?.text?.trim();
    if (!raw) return fallback;

    return redactProhibited(raw).slice(0, 1000);
  } catch (err) {
    console.error(
      'monthly summary generation failed (fallback to template):',
      err instanceof Error ? err.name : 'unknown',
    );
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function formatStatsForPrompt(agg: MonthlyAggregation): string {
  return [
    `期間: ${agg.fromDate} 〜 ${agg.toDate} (${agg.yearMonth})`,
    `記録した日数: ${agg.daysLogged} 日`,
    `総食事回数: ${agg.mealCount} 回`,
    `1 日平均カロリー: ${agg.avgCalories === null ? '不明' : Math.round(agg.avgCalories) + ' kcal'}`,
    `1 日平均 たんぱく質: ${agg.avgProteinG ?? '不明'} g`,
    `1 日平均 脂質: ${agg.avgFatG ?? '不明'} g`,
    `1 日平均 炭水化物: ${agg.avgCarbsG ?? '不明'} g`,
    '',
    'この内容から短い励まし要約 (200〜300 字, 効能効果の断定禁止) を生成してください。',
  ].join('\n');
}

/**
 * AI 失敗時のフォールバック要約 (テンプレ)。
 * 客観的事実のみで効能効果を含まない。
 */
export function templateSummary(agg: MonthlyAggregation): string {
  if (agg.daysLogged === 0) {
    return `${agg.yearMonth}は食事の記録がありませんでした。来月は少しずつでも記録してみましょう。`;
  }
  const cals = agg.avgCalories === null ? '—' : `${Math.round(agg.avgCalories)} kcal`;
  return [
    `${agg.yearMonth}は ${agg.daysLogged} 日にわたり ${agg.mealCount} 回の食事を記録しました。`,
    `1 日平均は約 ${cals}、たんぱく質 ${agg.avgProteinG ?? '—'} g、脂質 ${agg.avgFatG ?? '—'} g、`,
    `炭水化物 ${agg.avgCarbsG ?? '—'} g でした。`,
    `継続して記録することで、来月以降の傾向がより見えやすくなります。無理のないペースで続けましょう。`,
  ].join('');
}

// ----------------------------------------------------------------
// 期間計算
// ----------------------------------------------------------------

/**
 * 与えられた JST 日時から「先月」の YYYY-MM および YYYY-MM-DD 範囲を計算。
 * 例: now = 2026-04-01T03:00:00 → yearMonth = "2026-03", from = "2026-03-01", to = "2026-03-31"
 */
export function previousMonthRange(now: string): {
  yearMonth: string;
  fromDate: string;
  toDate: string;
} {
  const year = parseInt(now.slice(0, 4), 10);
  const month = parseInt(now.slice(5, 7), 10); // 1-12

  let prevYear = year;
  let prevMonth = month - 1;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear -= 1;
  }

  const yearMonth = `${prevYear.toString().padStart(4, '0')}-${prevMonth.toString().padStart(2, '0')}`;
  const fromDate = `${yearMonth}-01`;
  // 当月の最終日 = 翌月 1 日 - 1 日。Date.UTC を使うと閏年も正しく扱える。
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const toDate = `${yearMonth}-${lastDay.toString().padStart(2, '0')}`;

  return { yearMonth, fromDate, toDate };
}

// ----------------------------------------------------------------
// ガード
// ----------------------------------------------------------------

function redactProhibited(text: string): string {
  if (!text) return text;
  let result = text;
  for (const phrase of PROHIBITED_PHRASES) {
    if (!phrase) continue;
    const isAscii = /^[\x00-\x7f]+$/.test(phrase);
    if (isAscii) {
      const re = new RegExp(escapeRegExp(phrase), 'gi');
      result = result.replace(re, REDACTION_TOKEN);
    } else {
      result = result.split(phrase).join(REDACTION_TOKEN);
    }
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roundTo1(n: number): number {
  return Math.round(n * 10) / 10;
}

// テスト用エクスポート
export const __test__ = {
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibited,
  previousMonthRange,
  templateSummary,
  formatStatsForPrompt,
};
