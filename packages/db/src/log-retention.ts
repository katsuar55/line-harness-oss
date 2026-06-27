/**
 * 会話ログ retention prune (= PII 保持期間ポリシー、 2026-06-28、 採点 Round1 D6)
 *
 * messages_log / conversation_logs はユーザーの生テキスト (住所/電話/注文番号/健康相談等の PII を
 * 含みうる) を保持する CRM 本質機能。 「必要な期間だけ持つ」 原則のため Katsu 判断で保持期間を
 * **2 年 (24ヶ月)** と決定し、 それを超えた行を日次 cron で自動削除する。
 *
 * 重要 — cutoff の形式整合:
 *   両テーブルの created_at は DEFAULT で `strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')` の
 *   **JST ローカル ISO (Z/offset なし)** 形式で保存される。 JS の new Date().toISOString() (UTC Z) と
 *   混ぜると lexicographic 比較がズレるため、 cutoff も **同じ strftime 式 + '-N months' modifier** で
 *   DB 側生成する (D1 で動作確認済)。
 *
 * 関連: apps/worker/src/services/conversation-log-cleanup.ts (= 日次 cron caller)、
 *       docs/CUTOVER_RUNBOOK.md (PII 運用方針)
 */

/** messages_log の retentionMonths ヶ月超の行を削除し、 削除行数を返す。 */
export async function pruneOldMessagesLog(
  db: D1Database,
  retentionMonths: number,
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM messages_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', ?)`,
    )
    .bind(`-${retentionMonths} months`)
    .run();
  return res.meta?.changes ?? 0;
}

/** conversation_logs の retentionMonths ヶ月超の行を削除し、 削除行数を返す。 */
export async function pruneOldConversationLogs(
  db: D1Database,
  retentionMonths: number,
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM conversation_logs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', ?)`,
    )
    .bind(`-${retentionMonths} months`)
    .run();
  return res.meta?.changes ?? 0;
}
