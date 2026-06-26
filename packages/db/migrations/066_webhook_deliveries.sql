-- Migration 066: webhook_deliveries テーブル (= LINE webhook event 冪等化 / 二重 fireEvent 防止、 2026-06-26)
--
-- 目的:
--   LINE Platform は webhook 配信を再送することがある (= 同一 event の重複配信、 deliveryContext.isRedelivery)。
--   また我々が 1 秒以内に 200 を返せなかった場合等にも再送が起こりうる。
--   再送のたびに handleEvent が friend_add/message を二重処理すると、 automation 発火・スコア加算・
--   クーポン発行・welcome 配信が重複してしまう。
--   event.webhookEventId (= LINE が各 event に付与する一意 ID) を冪等 key として記録し、
--   初見の event だけ処理する (= INSERT OR IGNORE で「初めて行を入れられた実行」 のみ続行)。
--
-- 設計:
--   - webhook_event_id を PRIMARY KEY にし、 INSERT OR IGNORE の changes===1 で初見判定。
--   - created_at は TTL prune 用 (= 日次 cron で 72h 超を削除、 無限肥大を防止)。
--   - 非破壊 (= CREATE TABLE IF NOT EXISTS + index)。 既存テーブル不変・forward-only。
--   - fail-open: コードは本テーブルが無くても (= migration 未適用でも) 処理を止めない設計
--     (recordWebhookDelivery が throw → caller の catch → 処理続行)。 適用順序に依存しない。
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\066_webhook_deliveries.sql

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  webhook_event_id TEXT PRIMARY KEY,  -- LINE event の一意 ID (= 冪等 key)
  created_at TEXT NOT NULL             -- ISO8601 (UTC) 受信時刻 (= TTL prune 用)
);

-- TTL prune (= created_at < cutoff の DELETE) 用
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at
  ON webhook_deliveries(created_at);
