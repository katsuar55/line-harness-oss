/**
 * Broadcast Insights Fetcher (Phase 5β-5c-prep)
 *
 * 役割:
 *   - 配信済 broadcast (= status='sent', line_request_id あり) に対して
 *     LINE Messaging API の Insight endpoint (GET /v2/bot/insight/message/event?requestId=...)
 *     を call して delivery/uniqueImpression/uniqueClick 等の集計を取得する。
 *   - 取得結果は broadcasts.insights_json + insights_fetched_at に save (= 重複取得防止)。
 *   - LINE Insight API は配信から数十分〜数時間後に集計完了 (= overview=null の間は retryable)。
 *
 * 動作条件 (= pickup 対象 broadcast):
 *   - status = 'sent' (= 配信完了)
 *   - line_request_id IS NOT NULL (= Insight API call 可能)
 *   - insights_json IS NULL (= まだ取得していない)
 *   - sent_at > now - 30 days (= LINE Insight API 保持期間 ~30 日)
 *   - sent_at < now - MIN_AGE_HOURS (= LINE 側集計に時間が必要、 即時取得は overview=null)
 *
 * cron 統合:
 *   - 既存 5 min 毎 cron に組込 (= apps/worker/src/index.ts の scheduled handler)
 *   - BATCH_SIZE で 1 cycle あたりの取得数を制限 (= rate limit + Worker CPU time 配慮)
 *   - retryable (= overview=null) は次回 cron で自然 retry
 *
 * 関連:
 *   - packages/line-sdk/src/client.ts:111 getInsightMessageEvent
 *   - packages/db/schema.sql:130 broadcasts (insights_json TEXT, insights_fetched_at TEXT)
 *   - apps/worker/src/routes/line-insights.ts (= 集計を UI に出す PR #42 で活用)
 */

import { jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';

const MAX_AGE_DAYS = 30;
const MIN_AGE_HOURS = 1;
const DEFAULT_BATCH_SIZE = 5;

interface PendingBroadcast {
  id: string;
  line_request_id: string;
  sent_at: string;
  title: string;
}

export interface FetchInsightsResult {
  /** 対象 broadcast 件数 (limit 上限まで pickup) */
  processed: number;
  /** insights_json を保存できた件数 */
  succeeded: number;
  /** LINE API call が throw した件数 */
  failed: number;
  /** overview=null で次回 retry に持ち越した件数 */
  retryable: number;
}

export interface FetchInsightsOptions {
  /** 1 回の cron で処理する最大件数 (default 5) */
  batchSize?: number;
  /** 配信から何時間経ったら fetch 対象か (default 1h) */
  minAgeHours?: number;
  /** テスト用: 現在時刻を固定 */
  nowFn?: () => number;
}

/**
 * insights_json が未取得の broadcast を集めて LINE Insight API で集計を取得し保存する。
 *
 * 失敗時は best-effort: 個別 broadcast の error は console.error に出して continue、
 * caller (cron) には throw しない (= 1 件失敗で全 cron 止めない)。
 */
export async function fetchPendingBroadcastInsights(
  db: D1Database,
  lineClient: LineClient,
  options: FetchInsightsOptions = {},
): Promise<FetchInsightsResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const minAgeHours = options.minAgeHours ?? MIN_AGE_HOURS;
  const nowMs = options.nowFn ? options.nowFn() : Date.now();
  const oldestAllowed = new Date(nowMs - MAX_AGE_DAYS * 86_400_000).toISOString();
  const youngestAllowed = new Date(nowMs - minAgeHours * 3_600_000).toISOString();

  // 対象 broadcast を取得
  const result = await db
    .prepare(
      `SELECT id, line_request_id, sent_at, title FROM broadcasts
       WHERE status = 'sent'
         AND line_request_id IS NOT NULL
         AND insights_json IS NULL
         AND sent_at > ?
         AND sent_at < ?
       ORDER BY sent_at DESC
       LIMIT ?`,
    )
    .bind(oldestAllowed, youngestAllowed, batchSize)
    .all<PendingBroadcast>();

  const broadcasts = result.results ?? [];
  let succeeded = 0;
  let failed = 0;
  let retryable = 0;

  for (const b of broadcasts) {
    try {
      const insights = await lineClient.getInsightMessageEvent(b.line_request_id);
      // LINE 側集計未完了 (= 配信直後等) は overview=null。 次回 cron で retry。
      if (!insights.overview) {
        retryable++;
        continue;
      }
      // insights_json + insights_fetched_at を UPDATE (= 冪等)
      await db
        .prepare(
          `UPDATE broadcasts
           SET insights_json = ?, insights_fetched_at = ?
           WHERE id = ?`,
        )
        .bind(JSON.stringify(insights), jstNow(), b.id)
        .run();
      succeeded++;
    } catch (err) {
      // 個別 fail は best-effort: log のみ、 次の broadcast に continue
      console.error(
        `[broadcast-insights-fetcher] failed broadcast=${b.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  return { processed: broadcasts.length, succeeded, failed, retryable };
}
