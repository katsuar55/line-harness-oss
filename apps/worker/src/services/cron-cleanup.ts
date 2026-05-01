/**
 * cron_run_logs 自動 cleanup (Phase 7 — 2026-05-01)
 *
 * 目的:
 * - cron heartbeat (10 jobs / 5 分毎) で月間 86k 行追加見込み。
 *   1 年放置で 100 万行になり D1 のサイズ + クエリ性能が劣化する。
 * - 30 日経過した行を 1 日 1 回 DELETE で削減。
 *
 * 設計方針:
 * - **gating**: cron は 5 分毎なので、JST 03:00-03:04 のウィンドウのみ trigger。
 *   `CRON_CLEANUP_FORCE='true'` で bypass (テスト/手動実行用)。
 * - **idempotent**: DELETE は ran_at < cutoff の絶対条件、何度実行しても結果は同じ。
 * - **self-record**: `cron-cleanup` 自体も cron_run_logs に記録 (silent 監視のため)。
 * - **fail-safe**: DB 失敗で例外を throw しない。cron 全体を止めない。
 *
 * 関連: cron-monitor.ts DEFAULT_RULES に 'cron-cleanup' を追加して死活監視可。
 */

import { insertCronRunLog } from '@line-crm/db';

export interface CronCleanupEnv {
  DB: D1Database;
  /** 'true' で gating bypass */
  CRON_CLEANUP_FORCE?: string;
}

export interface CronCleanupOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** 保持日数 (デフォルト 30 日) */
  retentionDays?: number;
}

export interface CronCleanupResult {
  triggered: boolean;
  /** DELETE された行数 */
  deletedRows: number;
}

export const CRON_CLEANUP_JOB_NAME = 'cron-cleanup';
const TRIGGER_HOUR = 3;
const TRIGGER_MINUTE_FROM = 0;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 5;
const DEFAULT_RETENTION_DAYS = 30;

export async function processCronCleanup(
  env: CronCleanupEnv,
  options: CronCleanupOptions = {},
): Promise<CronCleanupResult> {
  const now = options.now ?? new Date();
  const retention = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const force = env.CRON_CLEANUP_FORCE === 'true';

  if (!force && !isCleanupWindow(now)) {
    return { triggered: false, deletedRows: 0 };
  }

  const cutoffMs = now.getTime() - retention * 24 * 3600 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let deletedRows = 0;
  try {
    const result = await env.DB.prepare(
      `DELETE FROM cron_run_logs WHERE ran_at < ?`,
    )
      .bind(cutoffIso)
      .run();
    deletedRows = result.meta?.changes ?? 0;
  } catch (err) {
    console.error(
      '[cron-cleanup] DELETE failed',
      err instanceof Error ? err.name : 'unknown',
    );
    // self-record も試みず early return (DB が腐っているなら次回試行で復旧)
    return { triggered: true, deletedRows: 0 };
  }

  // self-record (success として記録、cron-monitor で 24+H silent なら異常)
  try {
    await insertCronRunLog(env.DB, {
      jobName: CRON_CLEANUP_JOB_NAME,
      status: 'success',
      metrics: { deletedRows, retentionDays: retention },
    });
  } catch (err) {
    console.error(
      '[cron-cleanup] self-record failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }

  return { triggered: true, deletedRows };
}

// ============================================================
// gating
// ============================================================

export function isCleanupWindow(now: Date): boolean {
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
  isCleanupWindow,
  TRIGGER_HOUR,
  DEFAULT_RETENTION_DAYS,
};
