-- Migration 021: 複数リマインダー対応 + メッセージテンプレート管理
--
-- 変更点:
-- 1. intake_reminders テーブルの friend_id UNIQUE制約を解除 → 1ユーザー複数リマインダー
-- 2. reminder_messages テーブル新設 — メーカー登録メッセージ（~1000種）
-- 3. reminder_message_log テーブル新設 — どのメッセージを誰に送ったかの履歴（重複回避用）
-- 4. intake_reminders に label カラム追加（「朝食前」「昼食前」等）

-- ═══ Step 1: intake_reminders を複数リマインダー対応に改修 ═══
-- SQLiteは ALTER TABLE DROP CONSTRAINT 非対応のため、テーブル再作成

CREATE TABLE IF NOT EXISTS intake_reminders_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '朝食前',
  reminder_time TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  reminder_type TEXT NOT NULL DEFAULT 'morning_push' CHECK(reminder_type IN ('morning_push', 'streak_only')),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  snooze_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);

-- 既存データ移行
INSERT INTO intake_reminders_new (id, friend_id, label, reminder_time, timezone, reminder_type, is_active, last_sent_at, snooze_until, created_at, updated_at)
  SELECT id, friend_id, '朝食前', reminder_time, timezone, reminder_type, is_active, last_sent_at, snooze_until, created_at, updated_at
  FROM intake_reminders;

DROP TABLE IF EXISTS intake_reminders;
ALTER TABLE intake_reminders_new RENAME TO intake_reminders;

-- 複合インデックス: Cron処理用（アクティブ + 時刻検索）
CREATE INDEX IF NOT EXISTS idx_intake_reminders_active_time ON intake_reminders(is_active, reminder_time);
-- ユーザー別リマインダー一覧取得用
CREATE INDEX IF NOT EXISTS idx_intake_reminders_friend ON intake_reminders(friend_id);
-- 1ユーザー最大5件制限チェック用
CREATE INDEX IF NOT EXISTS idx_intake_reminders_friend_count ON intake_reminders(friend_id, is_active);

-- ═══ Step 2: メッセージテンプレート ═══
-- メーカー側が登録する ~1000種のリマインドメッセージ

CREATE TABLE IF NOT EXISTS reminder_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  time_slot TEXT NOT NULL DEFAULT 'any' CHECK(time_slot IN ('morning', 'noon', 'evening', 'any')),
  message TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  weight INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_reminder_messages_slot ON reminder_messages(time_slot, is_active);

-- ═══ Step 3: 送信履歴（重複回避用） ═══

CREATE TABLE IF NOT EXISTS reminder_message_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6)))),
  friend_id TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  reminder_message_id TEXT NOT NULL REFERENCES reminder_messages(id) ON DELETE CASCADE,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_reminder_msg_log_friend ON reminder_message_log(friend_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_reminder_msg_log_msg ON reminder_message_log(reminder_message_id);

-- ═══ Step 4: 初期サンプルメッセージ（各時間帯10件ずつ） ═══

-- 朝（morning）
INSERT INTO reminder_messages (id, time_slot, message, category) VALUES
  ('rm-m001', 'morning', 'おはようございます！朝の1粒で今日も元気にスタート。', 'motivation'),
  ('rm-m002', 'morning', '新しい一日の始まりです。naturismと一緒に素敵な朝を。', 'motivation'),
  ('rm-m003', 'morning', '朝の習慣がカラダを変えます。今日も忘れずに。', 'health_tip'),
  ('rm-m004', 'morning', '体は食べたものでできています。朝のケアが大切です。', 'health_tip'),
  ('rm-m005', 'morning', '継続は力なり。今日もnaturismの時間です。', 'motivation'),
  ('rm-m006', 'morning', '朝日を浴びながら、体の内側からもケアしましょう。', 'lifestyle'),
  ('rm-m007', 'morning', '今朝の調子はいかがですか？naturismで体調管理を。', 'care'),
  ('rm-m008', 'morning', '朝食前の1粒。シンプルな習慣が大きな違いを生みます。', 'health_tip'),
  ('rm-m009', 'morning', 'おはようございます！今日も内側からキレイに。', 'beauty'),
  ('rm-m010', 'morning', '毎朝のルーティンにnaturismを。小さな積み重ねが大切。', 'motivation');

-- 昼（noon）
INSERT INTO reminder_messages (id, time_slot, message, category) VALUES
  ('rm-n001', 'noon', 'お昼の時間です。午後も元気に過ごすために。', 'motivation'),
  ('rm-n002', 'noon', 'ランチタイム。naturismで午後のエネルギーチャージ。', 'lifestyle'),
  ('rm-n003', 'noon', '午後の眠気対策にも。体の内側からサポート。', 'health_tip'),
  ('rm-n004', 'noon', 'お昼ごはんと一緒に。忘れていませんか？', 'care'),
  ('rm-n005', 'noon', '1日の折り返し地点。naturismで後半戦も元気に。', 'motivation'),
  ('rm-n006', 'noon', 'お疲れ様です。午後もカラダのケアを忘れずに。', 'care'),
  ('rm-n007', 'noon', '昼食後のひと粒。afternoon routineにプラス。', 'lifestyle'),
  ('rm-n008', 'noon', '午後の集中力をサポート。naturismの時間です。', 'health_tip'),
  ('rm-n009', 'noon', 'ランチの後に。体の内側から整えましょう。', 'health_tip'),
  ('rm-n010', 'noon', 'お昼のリマインド。今日も順調に続けられていますね。', 'motivation');

-- 夕（evening）
INSERT INTO reminder_messages (id, time_slot, message, category) VALUES
  ('rm-e001', 'evening', '今日も一日お疲れ様でした。夜のケアも大切に。', 'care'),
  ('rm-e002', 'evening', '夕食前のnaturism。明日の朝の調子が変わります。', 'health_tip'),
  ('rm-e003', 'evening', '1日の終わりに、体へのご褒美を。', 'motivation'),
  ('rm-e004', 'evening', '夜のリラックスタイムにnaturismを。', 'lifestyle'),
  ('rm-e005', 'evening', '今日もnaturismを忘れずに。良い夜をお過ごしください。', 'care'),
  ('rm-e006', 'evening', '夕食の前に。体の内側からの夜ケアを始めましょう。', 'health_tip'),
  ('rm-e007', 'evening', '今日の最後のケア。naturismで明日に備えて。', 'motivation'),
  ('rm-e008', 'evening', '夜は回復の時間。naturismでサポートしましょう。', 'health_tip'),
  ('rm-e009', 'evening', 'お疲れ様でした。今日もケアを続けてくれてありがとう。', 'care'),
  ('rm-e010', 'evening', '夕食前の習慣。コツコツが未来の自分をつくります。', 'motivation');
