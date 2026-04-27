/**
 * 週次栄養コーチ Push 配信 (Phase 4 PR-5)
 *
 * 毎週火曜 10:00 JST に cron で起動し、active 友だちに対して
 *   1. PR-2 nutrition-analyzer で栄養不足を判定
 *   2. PR-3 nutrition-recommender でレコメンドを生成 + DB insert
 *   3. LINE push (Flex Bubble) で `liff/coach` への導線を送る
 * までを行う。
 *
 * 設計方針:
 * - **Cron 5 分毎発火** だが、JST 火曜 10:00-10:04 のウィンドウのみ trigger=true。
 *   それ以外は no-op で即 return (gating)。`force` でテスト/手動から bypass 可能。
 * - **idempotent**: 直近 7 日以内に既に nutrition_recommendations を生成済みの
 *   friend は対象から除外 (cron が重複発火しても二重 push しない)。
 * - **失敗局所化**: 1 友だちの analyzer/recommender/push 失敗で batch を止めない。
 *   `errors` カウントで観測する。
 * - **AI 失敗握り潰し**: recommender 側で template fallback されるためここでは何もしない。
 *
 * 依存:
 * - PR-2 `services/nutrition-analyzer.ts`
 * - PR-3 `services/nutrition-recommender.ts`
 * - PR-4 で追加された `/liff/coach` エンドポイント
 */

import { LineClient, flexMessage, flexBubble, flexBox, flexText, flexButton } from '@line-crm/line-sdk';
import type { FlexBubble, Message } from '@line-crm/line-sdk';
import { insertCronRunLog } from '@line-crm/db';
import { analyzeFriendNutrition } from './nutrition-analyzer.js';
import { generateAndStoreRecommendation } from './nutrition-recommender.js';

const CRON_JOB_NAME = 'weekly-coach-push';

// ============================================================
// 型
// ============================================================

export interface WeeklyCoachPushEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LIFF_URL?: string;
}

export interface WeeklyCoachPushResult {
  /** false の場合 gating で何もしなかった (no-op) */
  triggered: boolean;
  /** 候補に上がった友だち数 */
  evaluated: number;
  /** recommender が DB insert した数 */
  generated: number;
  /** analyzer or recommender が skip した数 */
  skipped: number;
  /** LINE push 成功数 */
  pushed: number;
  /** 例外発生数 (analyzer / recommender / push のいずれか) */
  errors: number;
}

/** 内部 LINE push クライアント抽象 (テスト容易性のため) */
export interface LinePushClient {
  pushMessage: (userId: string, messages: unknown[]) => Promise<unknown>;
}

export interface WeeklyCoachPushOptions {
  /** 現在時刻 (JST 換算前の壁時計). default は new Date() */
  now?: Date;
  /** force: true で gating skip (手動実行 / テスト用) */
  force?: boolean;
  /** 1 バッチで処理する最大友だち数 (default 50) */
  batchSize?: number;
  /** Anthropic clientOverride を recommender に渡す (テスト用) */
  clientOverride?: { messages: { create: (...args: unknown[]) => Promise<unknown> } };
  /** LineClient のモック (テスト用) */
  lineClient?: LinePushClient;
}

// ============================================================
// 定数
// ============================================================

const DEFAULT_BATCH_SIZE = 50;
/** トリガー曜日: 火曜 (Sun=0, Mon=1, Tue=2 ...) */
const TRIGGER_DAY_OF_WEEK = 2;
const TRIGGER_HOUR = 10;
/** 5 分 cron 想定: 10:00-10:04 のウィンドウのみ true (1 ウィンドウだけ発火) */
const TRIGGER_MINUTE_FROM = 0;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 5;

const RECENT_RECO_WINDOW_DAYS = 7;

// ============================================================
// gating
// ============================================================

/**
 * JST に変換した「曜日 + 時 + 分」を返す。
 * 内部は UTC を +9 時間ずらして Date を再構成し getUTC* を読む。
 */
export function jstParts(now: Date): { day: number; hour: number; minute: number } {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return {
    day: jst.getUTCDay(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  };
}

/** 火曜 10:00-10:04 JST のみ true */
export function isTriggerWindow(now: Date): boolean {
  const { day, hour, minute } = jstParts(now);
  return (
    day === TRIGGER_DAY_OF_WEEK &&
    hour === TRIGGER_HOUR &&
    minute >= TRIGGER_MINUTE_FROM &&
    minute < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

// ============================================================
// メイン
// ============================================================

interface FriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
}

export async function processWeeklyCoachPush(
  env: WeeklyCoachPushEnv,
  options: WeeklyCoachPushOptions = {},
): Promise<WeeklyCoachPushResult> {
  const now = options.now ?? new Date();
  const force = options.force ?? false;

  if (!force && !isTriggerWindow(now)) {
    // 5 分毎 cron で gating skip するたびに log を残すと DB が膨らむため、
    // skipped 時は cron_run_logs に書かない (DB を触らない既存挙動を維持)。
    return {
      triggered: false,
      evaluated: 0,
      generated: 0,
      skipped: 0,
      pushed: 0,
      errors: 0,
    };
  }

  const batchSize = clampBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);

  try {
  // ---- 候補抽出 ----
  // 直近 7 日以内に reco がある friend は除外
  // active = is_following=1 AND is_blacklisted=0 AND line_user_id IS NOT NULL
  // schema.sql の friends テーブルに合わせる (is_blocked カラムはない)
  const candidates = await loadCandidateFriends(env.DB, batchSize);

  if (candidates.length === 0) {
    console.log('[weekly-coach-push] triggered=true evaluated=0 generated=0 pushed=0');
    await safeRecordRun(env.DB, {
      status: 'success',
      metrics: { evaluated: 0, generated: 0, pushed: 0, skipped: 0, errors: 0 },
    });
    return {
      triggered: true,
      evaluated: 0,
      generated: 0,
      skipped: 0,
      pushed: 0,
      errors: 0,
    };
  }

  const lineClient: LinePushClient = options.lineClient ?? wrapLineClient(env.LINE_CHANNEL_ACCESS_TOKEN);

  let generated = 0;
  let skipped = 0;
  let pushed = 0;
  let errors = 0;

  for (const friend of candidates) {
    try {
      const analysis = await analyzeFriendNutrition({ db: env.DB, friendId: friend.id });
      if (analysis.skipReason || analysis.deficits.length === 0) {
        skipped++;
        continue;
      }

      const reco = await generateAndStoreRecommendation({
        db: env.DB,
        friendId: friend.id,
        apiKey: env.ANTHROPIC_API_KEY,
        deficits: analysis.deficits,
        friendName: friend.display_name ?? undefined,
        clientOverride: options.clientOverride,
      });

      if (!reco) {
        skipped++;
        continue;
      }

      generated++;

      // sent_at をその場で UPDATE (JST ISO)
      const sentAt = jstNowIso();
      await env.DB
        .prepare(
          `UPDATE nutrition_recommendations SET sent_at = ? WHERE id = ?`,
        )
        .bind(sentAt, reco.id)
        .run();

      const bubble = buildCoachBubble({
        aiMessage: reco.aiMessage,
        liffUrl: env.LIFF_URL,
      });

      try {
        await lineClient.pushMessage(friend.line_user_id, [
          flexMessage('今週の栄養コーチが届きました', bubble),
        ]);
        pushed++;
      } catch (pushErr) {
        errors++;
        console.error(
          '[weekly-coach-push] push failed for',
          friend.id,
          pushErr instanceof Error ? pushErr.name : 'unknown',
        );
      }
    } catch (err) {
      errors++;
      console.error(
        '[weekly-coach-push] friend processing failed for',
        friend.id,
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  console.log(
    `[weekly-coach-push] triggered=true evaluated=${candidates.length} generated=${generated} pushed=${pushed} skipped=${skipped} errors=${errors}`,
  );

  await safeRecordRun(env.DB, {
    status: errors > 0 ? 'partial' : 'success',
    metrics: {
      evaluated: candidates.length,
      generated,
      pushed,
      skipped,
      errors,
    },
    errorSummary: errors > 0 ? `${errors} friend(s) failed during analyze/recommend/push` : undefined,
  });

  return {
    triggered: true,
    evaluated: candidates.length,
    generated,
    skipped,
    pushed,
    errors,
  };
  } catch (err) {
    await safeRecordRun(env.DB, {
      status: 'error',
      errorSummary: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
    });
    throw err;
  }
}

// ============================================================
// 候補抽出
// ============================================================

async function loadCandidateFriends(db: D1Database, batchSize: number): Promise<FriendRow[]> {
  // 直近 7 日以内に nutrition_recommendations が生成済の friend を除外
  // generated_at は JST ISO で保存されている (jstNow()) ので JST 起点で比較する。
  // SQLite の datetime('now', '-7 days', '+9 hours') で JST の 7 日前を計算。
  const { results } = await db
    .prepare(
      `SELECT f.id, f.line_user_id, f.display_name
         FROM friends AS f
        WHERE COALESCE(f.is_following, 1) = 1
          AND COALESCE(f.is_blacklisted, 0) = 0
          AND f.line_user_id IS NOT NULL
          AND f.line_user_id <> ''
          AND NOT EXISTS (
            SELECT 1
              FROM nutrition_recommendations AS nr
             WHERE nr.friend_id = f.id
               AND nr.generated_at >= datetime('now', '-7 days', '+9 hours')
          )
        ORDER BY f.created_at ASC
        LIMIT ?`,
    )
    .bind(batchSize)
    .all<FriendRow>();

  return results ?? [];
}

// ============================================================
// Flex Bubble 組み立て
// ============================================================

interface BuildCoachBubbleInput {
  aiMessage: string;
  liffUrl: string | undefined;
}

export function buildCoachBubble(input: BuildCoachBubbleInput): FlexBubble {
  const trimmed = clipForBubble(input.aiMessage, 120);
  const target = buildCoachUrl(input.liffUrl);

  return flexBubble({
    body: flexBox(
      'vertical',
      [
        flexText('今週の栄養コーチ', { weight: 'bold', size: 'lg', color: '#059669' }),
        flexText(trimmed, { size: 'sm', color: '#1f2937', wrap: true, margin: 'md' }),
      ],
      { spacing: 'sm' },
    ),
    footer: flexBox(
      'vertical',
      [
        flexButton(
          { type: 'uri', label: '詳しく見る', uri: target },
          { style: 'primary', color: '#059669' },
        ),
      ],
      { spacing: 'sm' },
    ),
  });
}

function buildCoachUrl(liffUrl: string | undefined): string {
  if (!liffUrl) {
    // LIFF_URL が未設定でもメッセージ送信は続けたい (ボタンは fallback URL)。
    return 'https://liff.line.me/';
  }
  // liffUrl に既にパスが含まれているケースを考慮し、末尾スラッシュを正規化
  const base = liffUrl.replace(/\/+$/, '');
  // LIFF URL に "?" を含む可能性を避けて単純結合
  if (base.includes('/liff/')) {
    return base;
  }
  return `${base}/liff/coach`;
}

function clipForBubble(s: string, max: number): string {
  if (!s) return '今週の栄養傾向をチェックしてみましょう。';
  const arr = Array.from(s);
  if (arr.length <= max) return s;
  return arr.slice(0, max).join('') + '...';
}

// ============================================================
// helpers
// ============================================================

function wrapLineClient(accessToken: string): LinePushClient {
  const client = new LineClient(accessToken);
  return {
    pushMessage: (userId, messages) => client.pushMessage(userId, messages as Message[]),
  };
}

function clampBatchSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(n), 500);
}

function jstNowIso(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '');
}

/**
 * cron_run_logs に 1 行追加。失敗してもメイン処理を止めない (fail-safe)。
 */
async function safeRecordRun(
  db: D1Database,
  input: {
    status: 'success' | 'skipped' | 'error' | 'partial';
    metrics?: object;
    errorSummary?: string;
  },
): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: CRON_JOB_NAME,
      status: input.status,
      metrics: input.metrics,
      errorSummary: input.errorSummary,
    });
  } catch (err) {
    console.error(
      '[weekly-coach-push] cron_run_logs insert failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }
}

// ============================================================
// テスト用エクスポート
// ============================================================
export const __test__ = {
  jstParts,
  isTriggerWindow,
  buildCoachBubble,
  buildCoachUrl,
  clipForBubble,
  clampBatchSize,
  TRIGGER_DAY_OF_WEEK,
  TRIGGER_HOUR,
  RECENT_RECO_WINDOW_DAYS,
  DEFAULT_BATCH_SIZE,
};
