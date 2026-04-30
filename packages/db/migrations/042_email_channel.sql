-- Round 4 PR-2: Email channel infrastructure
--
-- 目的: Round 4 メール配信のための schema を整備する。
--
-- 設計方針:
-- - friends.email (identity) と email_subscribers.email (subscription state) を分離
--   → LINE 友だち未登録の Shopify 顧客 290+ 名にも配信可能にする
-- - transactional vs marketing を明確に区別 (特定電子メール法準拠)
-- - bounce 3 回 / complaint 1 回で auto-suppress
-- - Phase 6 連携用に source_order_id / source_kind / category 列を log に保持
--
-- 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §4

-- ============================================================
-- email_subscribers: 配信対象 + 同意状態
-- ============================================================
CREATE TABLE IF NOT EXISTS email_subscribers (
  id                 TEXT PRIMARY KEY,
  -- LINE 友だち紐付き (任意。未紐付きでも Shopify 由来で配信可能)
  friend_id          TEXT REFERENCES friends(id) ON DELETE SET NULL,
  email              TEXT NOT NULL,
  -- marketing 配信可否のメインフラグ。bounce/complaint で auto-OFF される
  is_active          INTEGER NOT NULL DEFAULT 1,
  -- 1 = transactional のみ送信。marketing 解除しても 0 にしない (注文確認等は届く)
  transactional_only INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at    TEXT,
  -- 3 で auto-suppress (is_active=0)
  bounce_count       INTEGER NOT NULL DEFAULT 0,
  -- 1 で即 auto-suppress (法令上の苦情応答)
  complaint_count    INTEGER NOT NULL DEFAULT 0,
  -- 'shopify_checkout' | 'liff_signup' | 'manual_import' | 'opt_in_form'
  consent_source     TEXT,
  consent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_subscribers_email ON email_subscribers(email);
CREATE INDEX IF NOT EXISTS idx_email_subscribers_active ON email_subscribers(is_active, unsubscribed_at);
CREATE INDEX IF NOT EXISTS idx_email_subscribers_friend ON email_subscribers(friend_id);

-- ============================================================
-- email_templates: HTML / text テンプレ (templates テーブルとは別管理)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- 'transactional' | 'marketing' | 'reorder' | 'coach_report' 等
  category      TEXT NOT NULL DEFAULT 'general',
  subject       TEXT NOT NULL,
  html_content  TEXT NOT NULL,
  text_content  TEXT NOT NULL,
  preheader     TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_email_templates_category ON email_templates(category);

-- ============================================================
-- email_messages_log: 配信履歴 + Phase 6 連携追跡
-- ============================================================
CREATE TABLE IF NOT EXISTS email_messages_log (
  id                  TEXT PRIMARY KEY,
  subscriber_id       TEXT NOT NULL REFERENCES email_subscribers(id),
  template_id         TEXT REFERENCES email_templates(id),
  broadcast_id        TEXT REFERENCES broadcasts(id),
  scenario_step_id    TEXT REFERENCES scenario_steps(id),
  -- Phase 6 連携 (どの Shopify 注文が起点か)
  source_order_id     TEXT REFERENCES shopify_orders(id) ON DELETE SET NULL,
  -- 'reorder' | 'cross_sell' | 'broadcast' | 'transactional' | 'manual'
  source_kind         TEXT NOT NULL DEFAULT 'manual',
  -- 法令上の区分: 'transactional' | 'marketing'
  category            TEXT NOT NULL DEFAULT 'marketing',
  subject             TEXT NOT NULL,
  from_address        TEXT NOT NULL,
  reply_to            TEXT,
  -- provider 情報
  provider            TEXT NOT NULL,
  provider_message_id TEXT,
  -- 状態: 'queued' | 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'failed'
  status              TEXT NOT NULL DEFAULT 'queued',
  error_summary       TEXT,
  sent_at             TEXT,
  delivered_at        TEXT,
  first_opened_at     TEXT,
  last_event_at       TEXT,
  open_count          INTEGER NOT NULL DEFAULT 0,
  click_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_subscriber ON email_messages_log(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_email_log_provider ON email_messages_log(provider, provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_log_broadcast ON email_messages_log(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_email_log_source_order ON email_messages_log(source_order_id);
CREATE INDEX IF NOT EXISTS idx_email_log_source_kind ON email_messages_log(source_kind, status);

-- ============================================================
-- email_link_clicks: クリックトラッキング (任意の詳細データ)
-- ============================================================
CREATE TABLE IF NOT EXISTS email_link_clicks (
  id            TEXT PRIMARY KEY,
  email_log_id  TEXT NOT NULL REFERENCES email_messages_log(id),
  url           TEXT NOT NULL,
  clicked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  user_agent    TEXT,
  -- IP は SHA-256 で hash 化して保存 (個人情報最小化)
  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_clicks_log ON email_link_clicks(email_log_id);
