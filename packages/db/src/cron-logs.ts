/**
 * Cron 実行ログ (Phase 5 PR-4)
 *
 * 定期 job の死活監視のため、各 cron が status と metrics を残す。
 * services/cron-monitor.ts がこのテーブルを参照し、最終成功から
 * 一定時間以上経過した job について Discord アラートを発火する。
 */

import { jstNow } from './utils.js';

// ============================================================
// 型
// ============================================================

export type CronRunLogStatus = 'success' | 'skipped' | 'error' | 'partial';

export interface CronRunLog {
  id: string;
  job_name: string;
  ran_at: string;
  status: CronRunLogStatus;
  metrics_json: string | null;
  error_summary: string | null;
}

export interface InsertCronRunLogInput {
  jobName: string;
  status: CronRunLogStatus;
  /** 自由形式の metrics (例: { evaluated: 10, generated: 8, pushed: 8 }) */
  metrics?: object;
  /** error / partial 時のサマリ。200 字に切り詰めて保存する */
  errorSummary?: string;
}

const ERROR_SUMMARY_MAX = 200;

// ============================================================
// クエリ
// ============================================================

/**
 * cron 実行ログを 1 件 INSERT する。
 *
 * 失敗してもメイン処理を止めないために、呼び出し側は try/finally で囲み、
 * このヘルパー自体の throw は無視するのが原則 (cron-monitor 側の責務)。
 */
export async function insertCronRunLog(
  db: D1Database,
  input: InsertCronRunLogInput,
): Promise<void> {
  const id = crypto.randomUUID();
  const ranAt = jstNow();
  const metricsJson = input.metrics === undefined ? null : safeStringify(input.metrics);
  const errorSummary =
    input.errorSummary === undefined
      ? null
      : truncate(input.errorSummary, ERROR_SUMMARY_MAX);

  await db
    .prepare(
      `INSERT INTO cron_run_logs (id, job_name, ran_at, status, metrics_json, error_summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.jobName, ranAt, input.status, metricsJson, errorSummary)
    .run();
}

/**
 * 指定 job の最後に成功した実行ログを返す。
 * status='success' のみ対象 (skipped/error/partial は「成功」とみなさない)。
 */
export async function getLastSuccessfulRun(
  db: D1Database,
  jobName: string,
): Promise<CronRunLog | null> {
  return await db
    .prepare(
      `SELECT id, job_name, ran_at, status, metrics_json, error_summary
         FROM cron_run_logs
        WHERE job_name = ? AND status = 'success'
        ORDER BY ran_at DESC
        LIMIT 1`,
    )
    .bind(jobName)
    .first<CronRunLog>();
}

/**
 * 指定 job の最後に「生存」していた実行ログを返す (= success または partial)。
 *
 * cron-monitor の silence 監視用 (2026-08-11)。複数 feed を持つ job は
 * 1 feed だけの恒久失敗で partial が定常状態になり得るが、それは
 * 「job は生きているが劣化」であって「沈黙」ではない。success のみを
 * 生存とみなすと partial 定常の job に毎朝 silence 誤警報が出る。
 * skipped / error は引き続き生存とみなさない。
 */
export async function getLastLiveRun(
  db: D1Database,
  jobName: string,
): Promise<CronRunLog | null> {
  return await db
    .prepare(
      `SELECT id, job_name, ran_at, status, metrics_json, error_summary
         FROM cron_run_logs
        WHERE job_name = ? AND status IN ('success', 'partial')
        ORDER BY ran_at DESC
        LIMIT 1`,
    )
    .bind(jobName)
    .first<CronRunLog>();
}

/**
 * 指定 job について sinceIso 以降に走った件数を返す。
 * status='any' なら全 status、それ以外なら status 一致のみ。
 */
export async function countRunsSince(
  db: D1Database,
  jobName: string,
  sinceIso: string,
  status: CronRunLogStatus | 'any' = 'any',
): Promise<number> {
  if (status === 'any') {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM cron_run_logs
          WHERE job_name = ? AND ran_at >= ?`,
      )
      .bind(jobName, sinceIso)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM cron_run_logs
        WHERE job_name = ? AND ran_at >= ? AND status = ?`,
    )
    .bind(jobName, sinceIso, status)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ============================================================
// helpers
// ============================================================

function safeStringify(o: object): string {
  try {
    return JSON.stringify(o);
  } catch {
    return '{}';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
