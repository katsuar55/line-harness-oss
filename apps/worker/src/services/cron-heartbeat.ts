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
 * fn() が正常 return した場合の記録 status を戻り値から判定した結果。
 *
 * 2026-08-11: エラーを throw せず戻り値の error field で報告する job
 * (例: shopify-customer-sync) が、部分失敗でも常に status='success' で
 * 記録される silent-fallback を解消するために導入。
 * - 'partial': 実行はしたが一部失敗 (errorSummary に理由を残す)
 * - 'skipped': gating / 未設定で実処理なし
 * - 'error' はここでは指定不可 (fn() の throw 経路専用)
 */
export interface HeartbeatOutcome {
  status: 'success' | 'partial' | 'skipped';
  errorSummary?: string;
}

/**
 * cron 関数を heartbeat 付きで実行する。
 *
 * @param db D1 binding
 * @param jobName cron_run_logs に記録される job 名
 * @param fn 実行する cron 関数 (async)
 * @param metricsExtractor 戻り値から metrics オブジェクトを抽出する任意関数
 * @param outcomeExtractor 戻り値から status / errorSummary を判定する任意関数
 *   (未指定・抽出失敗・不正 status は従来どおり 'success')
 * @returns fn() の戻り値をそのまま返す
 * @throws fn() が throw した場合、heartbeat 書き込み後に同じエラーを再 throw
 */
export async function withHeartbeat<T>(
  db: D1Database,
  jobName: string,
  fn: () => Promise<T>,
  metricsExtractor?: (result: T) => object,
  outcomeExtractor?: (result: T) => HeartbeatOutcome,
): Promise<T> {
  try {
    const result = await fn();
    const outcome = outcomeExtractor ? safeOutcome(outcomeExtractor, result) : undefined;
    await safeRecord(db, {
      jobName,
      status: outcome?.status ?? 'success',
      metrics: metricsExtractor ? safeExtract(metricsExtractor, result) : undefined,
      errorSummary: outcome?.errorSummary,
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

const VALID_OUTCOME_STATUSES: ReadonlySet<string> = new Set(['success', 'partial', 'skipped']);

function safeOutcome<T>(
  extractor: (r: T) => HeartbeatOutcome,
  result: T,
): HeartbeatOutcome | undefined {
  try {
    const outcome = extractor(result);
    // 抽出関数のバグで不正 status が返っても heartbeat 自体は落とさない
    if (!outcome || !VALID_OUTCOME_STATUSES.has(outcome.status)) return undefined;
    return outcome;
  } catch {
    return undefined;
  }
}
