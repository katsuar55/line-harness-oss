-- =============================================
-- 031: Feature Gap — ブラックリスト・グループ管理・日数経過トリガー
-- DMMチャットブースト for EC 機能パリティ
-- =============================================

-- 1. ブラックリスト（㉖）— friends テーブルにフラグ追加
ALTER TABLE friends ADD COLUMN is_blacklisted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_friends_blacklisted ON friends(is_blacklisted);

-- 2. グループ管理（⑰）— ユーザーを分類するグループ
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#6B7280',
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS friend_groups (
  friend_id  TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_groups_group_id ON friend_groups(group_id);

-- 3. 日数経過トリガー配信（⑪）
CREATE TABLE IF NOT EXISTS tag_elapsed_deliveries (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  trigger_tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  elapsed_days     INTEGER NOT NULL,
  message_type     TEXT NOT NULL DEFAULT 'text',
  message_content  TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  send_hour        INTEGER NOT NULL DEFAULT 10,
  created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_tag_elapsed_tag ON tag_elapsed_deliveries(trigger_tag_id);

-- 配信ログ（重複送信防止）
CREATE TABLE IF NOT EXISTS tag_elapsed_delivery_logs (
  id           TEXT PRIMARY KEY,
  delivery_id  TEXT NOT NULL REFERENCES tag_elapsed_deliveries(id) ON DELETE CASCADE,
  friend_id    TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  sent_at      TEXT NOT NULL,
  UNIQUE(delivery_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_elapsed_logs_delivery ON tag_elapsed_delivery_logs(delivery_id);
