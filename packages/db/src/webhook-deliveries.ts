/**
 * webhook_deliveries — LINE webhook event の冪等化 (= 二重 fireEvent 防止、 2026-06-26)
 *
 * LINE Platform は webhook を再送することがある (deliveryContext.isRedelivery)。
 * event.webhookEventId を冪等 key に記録し、 初見の event だけ処理させる。
 *
 * 関連: apps/worker/src/routes/webhook.ts (= handleEvent 入口の dedup guard / 書込元)、
 *       packages/db/migrations/066_webhook_deliveries.sql、
 *       apps/worker/src/services/webhook-delivery-cleanup.ts (= TTL prune cron)
 */

/**
 * webhook event を初めて受信したときだけ true を返す (= 処理続行可)。
 *
 * INSERT OR IGNORE で webhook_event_id (PRIMARY KEY) の重複を弾き、
 * changes===1 (= 行を新規挿入できた) のときのみ「初見」 と判定する。
 * 既に記録済 (= 再送) なら changes===0 → false (= caller は skip すべき)。
 *
 * 注: caller は fail-open であること (= この関数が throw したら処理を続行する)。
 *     正当な event を dedup 障害で落とさないため。
 */
export async function recordWebhookDelivery(
  db: D1Database,
  webhookEventId: string,
  createdAtIso: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO webhook_deliveries (webhook_event_id, created_at) VALUES (?, ?)`,
    )
    .bind(webhookEventId, createdAtIso)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * created_at < cutoffIso の古い配信記録を削除し、 削除行数を返す。
 * 日次 cron から呼ばれる TTL prune。 冪等 (= 何度実行しても同結果)。
 */
export async function pruneWebhookDeliveries(
  db: D1Database,
  cutoffIso: string,
): Promise<number> {
  const res = await db
    .prepare(`DELETE FROM webhook_deliveries WHERE created_at < ?`)
    .bind(cutoffIso)
    .run();
  return res.meta?.changes ?? 0;
}
