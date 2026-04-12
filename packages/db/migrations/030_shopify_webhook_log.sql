-- Shopify Webhook受信ログ（デバッグ・監視用）
CREATE TABLE IF NOT EXISTS shopify_webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  shopify_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  summary TEXT,
  error TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_log_topic ON shopify_webhook_log(topic);
CREATE INDEX IF NOT EXISTS idx_webhook_log_received ON shopify_webhook_log(received_at);
