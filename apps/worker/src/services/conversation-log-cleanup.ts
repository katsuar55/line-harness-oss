/**
 * 会話ログ retention cleanup (= messages_log / conversation_logs の PII を 2 年で自動削除、 2026-06-28)
 *
 * 採点 Round1 D6 + Katsu 運用判断: ユーザーの生テキスト (PII) を「必要な期間だけ持つ」 ため、
 * 24ヶ月超の messages_log / conversation_logs を日次 cron で削除する。
 *
 * 設計方針 (= cron-cleanup.ts / webhook-delivery-cleanup.ts と同パターン):
 *   - **gating**: cron は 5 分毎なので JST 03:30-03:34 のウィンドウのみ trigger
 *     (= cron-cleanup 03:00 / account-link 03:10 / webhook-delivery 03:20 とずらして競合回避)。
 *     `CONVERSATION_LOG_CLEANUP_FORCE='true'` で bypass (テスト/手動)。
 *   - **retention 24ヶ月**: Katsu 決定。 リピート顧客対応に十分かつ古い PII を溜め込まない。
 *   - cutoff は DB 側 strftime で生成 (created_at の JST ローカル形式と整合、 log-retention.ts 参照)。
 *   - idempotent / fail-safe (= DELETE 失敗で throw しない、 cron 全体を止めない)。
 *   - **self-record**: cron_run_logs に記録 (= cron-monitor で silent 監視、 DEFAULT_RULES 登録済)。
 *
 * 関連: packages/db/src/log-retention.ts、 apps/worker/src/services/cron-monitor.ts、
 *       docs/CUTOVER_RUNBOOK.md (PII 運用方針)
 */

import { insertCronRunLog, pruneOldMessagesLog, pruneOldConversationLogs } from '@line-crm/db';

export interface ConversationLogCleanupEnv {
  DB: D1Database;
  /** 'true' で gating bypass */
  CONVERSATION_LOG_CLEANUP_FORCE?: string;
}

export interface ConversationLogCleanupOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** 保持月数 (default 24ヶ月 = 2年) */
  retentionMonths?: number;
}

export interface ConversationLogCleanupResult {
  triggered: boolean;
  /** messages_log 削除行数 */
  deletedMessages: number;
  /** conversation_logs 削除行数 */
  deletedConversations: number;
}

export const CONVERSATION_LOG_CLEANUP_JOB_NAME = 'conversation-log-cleanup';
const TRIGGER_HOUR = 3;
const TRIGGER_MINUTE_FROM = 30;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 35;
const DEFAULT_RETENTION_MONTHS = 24;

export async function processConversationLogCleanup(
  env: ConversationLogCleanupEnv,
  options: ConversationLogCleanupOptions = {},
): Promise<ConversationLogCleanupResult> {
  const now = options.now ?? new Date();
  const retentionMonths = options.retentionMonths ?? DEFAULT_RETENTION_MONTHS;
  const force = env.CONVERSATION_LOG_CLEANUP_FORCE === 'true';

  if (!force && !isConversationLogCleanupWindow(now)) {
    return { triggered: false, deletedMessages: 0, deletedConversations: 0 };
  }

  let deletedMessages = 0;
  let deletedConversations = 0;
  try {
    deletedMessages = await pruneOldMessagesLog(env.DB, retentionMonths);
    deletedConversations = await pruneOldConversationLogs(env.DB, retentionMonths);
  } catch (err) {
    console.error(
      '[conversation-log-cleanup] prune failed',
      err instanceof Error ? err.name : 'unknown',
    );
    return { triggered: true, deletedMessages, deletedConversations };
  }

  try {
    await insertCronRunLog(env.DB, {
      jobName: CONVERSATION_LOG_CLEANUP_JOB_NAME,
      status: 'success',
      metrics: { deletedMessages, deletedConversations, retentionMonths },
    });
  } catch (err) {
    console.error(
      '[conversation-log-cleanup] self-record failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }

  return { triggered: true, deletedMessages, deletedConversations };
}

// ============================================================
// gating
// ============================================================

export function isConversationLogCleanupWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

export const __test__ = {
  isConversationLogCleanupWindow,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
  DEFAULT_RETENTION_MONTHS,
};
