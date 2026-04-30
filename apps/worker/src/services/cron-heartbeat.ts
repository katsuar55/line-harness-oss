/**
 * Cron Heartbeat Wrapper (Phase 7: 2026-04-29)
 *
 * 目的: 既存の cron job を 1 行ラップするだけで cron_run_logs に
 *   success / error の heartbeat を残す。
 *
 * 設計方針:
 * - 失敗時も heartbeat 書き込み (status='error' / error_summary 付き)
 * - heartbeat 自体の書き込み失敗はメイン処理を止めない (catch して swallow)
 * - 元の関数の戻り値は完全に透過
 * - metrics extractor を任意で受け取り、戻り値から JSON metrics を抽出可能
 *
 * 使用例:
 *   jobs.push(
 *     withHeartbeat(env.DB, 'step-delivery', () =>
 *       processStepDeliveries(env.DB, lineClient, env.WORKER_URL),
 *     ),
 *   );
 *
 * 将来課題: cron_run_logs のサイズ増加。月間 ~86k 行追加見込み。
 *   1 年経過後に partition / TTL を検討 (Phase 8 以降)。
 */

import { insertCronRunLog } from '@line-crm/db';

/**
 * cron 関数を heartbeat 付きで実行する。
 *
 * @param db D1 binding
 * @param jobName cron_run_logs に記録される job 名
 * @param fn 実行する cron 関数 (async)
 * @param metricsExtractor 戻り値から metrics オブジェクトを抽出する任意関数
 * @returns fn() の戻り値をそのまま返す
 * @throws fn() が throw した場合、heartbeat 書き込み後に同じエラーを再 throw
 */
export async function withHeartbeat<T>(
  db: D1Database,
  jobName: string,
  fn: () => Promise<T>,
  metricsExtractor?: (result: T) => object,
): Promise<T> {
  try {
    const result = await fn();
    await safeRecord(db, {
      jobName,
      status: 'success',
      metrics: metricsExtractor ? safeExtract(metricsExtractor, result) : undefined,
    });
    return result;
  } catch (err) {
    await safeRecord(db, {
      jobName,
      status: 'error',
      errorSummary: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ============================================================
// 内部: 失敗を握りつぶす書き込み helper
// ============================================================

async function safeRecord(
  db: D1Database,
  input: Parameters<typeof insertCronRunLog>[1],
): Promise<void> {
  try {
    await insertCronRunLog(db, input);
  } catch (err) {
    // heartbeat 書き込みの失敗は cron 全体を止めない
    console.error(
      '[cron-heartbeat] insert failed for',
      input.jobName,
      err instanceof Error ? err.name : 'unknown',
    );
  }
}

function safeExtract<T>(extractor: (r: T) => object, result: T): object | undefined {
  try {
    return extractor(result);
  } catch {
    return undefined;
  }
}
