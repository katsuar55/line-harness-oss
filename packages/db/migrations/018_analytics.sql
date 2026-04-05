-- 018: Google Analytics 4 連携
-- GA4 Measurement Protocol 設定 + UTMリンク管理

-- GA4設定テーブル（アカウント別）
CREATE TABLE IF NOT EXISTS analytics_settings (
  id TEXT PRIMARY KEY,
  line_account_id TEXT,
  provider TEXT NOT NULL DEFAULT 'ga4',
  measurement_id TEXT,           -- G-XXXXXXXXXX
  api_secret TEXT,               -- Measurement Protocol API secret
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL DEFAULT '{}',  -- JSON: 追加設定
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

-- GA4イベントログ
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  friend_id TEXT,
  event_name TEXT NOT NULL,       -- friend_add, message_open, link_click, purchase
  event_params TEXT DEFAULT '{}', -- JSON: GA4 event parameters
  measurement_id TEXT,
  status TEXT NOT NULL DEFAULT 'sent',  -- sent, failed
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

-- UTMリンクテンプレート（キャンペーン別）
CREATE TABLE IF NOT EXISTS utm_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  utm_source TEXT NOT NULL DEFAULT 'line',
  utm_medium TEXT NOT NULL DEFAULT 'message',
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  line_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_friend ON analytics_events(friend_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_utm_templates_account ON utm_templates(line_account_id);
