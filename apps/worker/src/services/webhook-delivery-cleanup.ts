/**
 * webhook_deliveries 自動 cleanup (= LINE webhook 冪等テーブルの TTL prune、 2026-06-26)
 *
 * 目的:
 *   webhook_deliveries (migration 066) は LINE event の重複配信を弾くための冪等 key
 *   (webhook_event_id) を保持する。 LINE の再送は通常配信直後 (数分〜数十分) に起こるが、
 *   deploy 障害等で Worker が一時的に不達だと、 復旧後に遅れて再送が届きうる。 これを取りこぼさない
 *   安全マージンとして 72h (3 日) 保持し、 それを超えた行を日次で prune する (= 無限肥大を防止)。
 *
 * 設計方針 (= cron-cleanup.ts / account-link-cleanup.ts と同パターン):
 *   - **gating**: cron は 5 分毎なので JST 03:20-03:24 のウィンドウのみ trigger
 *     (= cron-cleanup 03:00 / account-link-cleanup 03:10 とずらして同時実行の競合を避ける)。
 *     `WEBHOOK_DELIVERY_CLEANUP_FORCE='true'` で bypass (テスト/手動)。
 *   - **retention 72h**: 通常の再送 (数分〜数十分) に加え、 deploy 障害等の遅延再送に備えた
 *     安全マージン。 「dedup window」 と「テーブルサイズ」 のトレードオフ (= 行は ~50B、
 *     高トラフィックでも数 MB 以内なので長めでも安価)。
 *   - **created_at < cutoff で削除**。 idempotent / fail-safe (= DB 失敗で throw しない)。
 *   - **self-record**: cron_run_logs に記録 (= cron-monitor で silent 監視)。
 *   - **migration 未適用時も安全**: prune が throw しても triggered=true / deletedRows=0 で返す。
 *
 * 関連: packages/db/src/webhook-deliveries.ts、 packages/db/migrations/066_webhook_deliveries.sql、
 *       apps/worker/src/routes/webhook.ts (= 本テーブルへの書込元)、
 *       apps/worker/src/services/cron-cleanup.ts (= 同パターンの参照実装)
 */

import { insertCronRunLog, pruneWebhookDeliveries } from '@line-crm/db';

export interface WebhookDeliveryCleanupEnv {
  DB: D1Database;
  /** 'true' で gating bypass */
  WEBHOOK_DELIVERY_CLEANUP_FORCE?: string;
}

export interface WebhookDeliveryCleanupOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** 保持時間 (default 72 時間) */
  retentionHours?: number;
}

export interface WebhookDeliveryCleanupResult {
  triggered: boolean;
  /** DELETE された行数 */
  deletedRows: number;
}

export const WEBHOOK_DELIVERY_CLEANUP_JOB_NAME = 'webhook-delivery-cleanup';
const TRIGGER_HOUR = 3;
const TRIGGER_MINUTE_FROM = 20;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 25;
const DEFAULT_RETENTION_HOURS = 72;

export async function processWebhookDeliveryCleanup(
  env: WebhookDeliveryCleanupEnv,
  options: WebhookDeliveryCleanupOptions = {},
): Promise<WebhookDeliveryCleanupResult> {
  const now = options.now ?? new Date();
  const retentionHours = options.retentionHours ?? DEFAULT_RETENTION_HOURS;
  const force = env.WEBHOOK_DELIVERY_CLEANUP_FORCE === 'true';

  if (!force && !isWebhookDeliveryCleanupWindow(now)) {
    return { triggered: false, deletedRows: 0 };
  }

  const cutoffMs = now.getTime() - retentionHours * 3600 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let deletedRows = 0;
  try {
    // created_at (UTC ISO) を webhook.ts と同じ UTC Z 形式で書込むため lexicographic 比較が時系列順。
    deletedRows = await pruneWebhookDeliveries(env.DB, cutoffIso);
  } catch (err) {
    // migration 066 未適用 (= table なし) でもここで吸収し、 cron 全体を止めない。
    console.error(
      '[webhook-delivery-cleanup] prune failed',
      err instanceof Error ? err.name : 'unknown',
    );
    return { triggered: true, deletedRows: 0 };
  }

  // self-record (= cron-monitor で silent 検知できるよう success を記録)
  try {
    await insertCronRunLog(env.DB, {
      jobName: WEBHOOK_DELIVERY_CLEANUP_JOB_NAME,
      status: 'success',
      metrics: { deletedRows, retentionHours },
    });
  } catch (err) {
    console.error(
      '[webhook-delivery-cleanup] self-record failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }

  return { triggered: true, deletedRows };
}

// ============================================================
// gating
// ============================================================

export function isWebhookDeliveryCleanupWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isWebhookDeliveryCleanupWindow,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
  DEFAULT_RETENTION_HOURS,
};
