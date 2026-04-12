-- 029: Notification preferences + Subscription reminders
-- 通知設定テーブル（ユーザーごとのオプトイン/アウト）
CREATE TABLE IF NOT EXISTS friend_notification_preferences (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  restock_alert INTEGER DEFAULT 1,       -- 在庫復活通知
  delivery_complete INTEGER DEFAULT 1,   -- 配送完了通知
  order_confirm INTEGER DEFAULT 1,       -- 注文確認通知
  campaign_message INTEGER DEFAULT 1,    -- キャンペーン通知
  reorder_reminder INTEGER DEFAULT 1,    -- 再購入リマインダー
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_prefs_friend ON friend_notification_preferences(friend_id);

-- 定期購買リマインダー（LINE再購入フロー代替）
CREATE TABLE IF NOT EXISTS subscription_reminders (
  id TEXT PRIMARY KEY,
  friend_id TEXT NOT NULL REFERENCES friends(id),
  product_title TEXT NOT NULL,
  variant_id TEXT,
  interval_days INTEGER NOT NULL DEFAULT 30,  -- リマインド間隔（日）
  next_reminder_at TEXT NOT NULL,
  last_sent_at TEXT,
  is_active INTEGER DEFAULT 1,
  source_order_id TEXT,                       -- 元の注文ID
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_reminders_friend ON subscription_reminders(friend_id);
CREATE INDEX IF NOT EXISTS idx_sub_reminders_next ON subscription_reminders(next_reminder_at, is_active);

-- FAQ テーブル（管理画面から編集可能）
CREATE TABLE IF NOT EXISTS faq_items (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
