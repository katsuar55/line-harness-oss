-- 016_ab_tests.sql — ABテスト配信機能
-- Phase 2B: 一斉配信の拡張 — A/Bバリアントの分割テスト

-- ABテストテーブル
CREATE TABLE IF NOT EXISTS ab_tests (
  id                        TEXT PRIMARY KEY,
  title                     TEXT NOT NULL,
  -- バリアントA
  variant_a_message_type    TEXT NOT NULL CHECK (variant_a_message_type IN ('text', 'image', 'flex')),
  variant_a_message_content TEXT NOT NULL,
  variant_a_alt_text        TEXT,
  -- バリアントB
  variant_b_message_type    TEXT NOT NULL CHECK (variant_b_message_type IN ('text', 'image', 'flex')),
  variant_b_message_content TEXT NOT NULL,
  variant_b_alt_text        TEXT,
  -- ターゲティング（broadcastsと同一パターン）
  target_type               TEXT NOT NULL CHECK (target_type IN ('all', 'tag')) DEFAULT 'all',
  target_tag_id             TEXT REFERENCES tags (id) ON DELETE SET NULL,
  -- 分割比率: バリアントAに割り当てる割合（1-99）。残りがB
  split_ratio               INTEGER NOT NULL DEFAULT 50 CHECK (split_ratio BETWEEN 1 AND 99),
  -- ステータス: draft → scheduled → sending → test_sent → winner_sent
  status                    TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'test_sent', 'winner_sent')) DEFAULT 'draft',
  scheduled_at              TEXT,
  sent_at                   TEXT,
  -- バリアント別カウント
  variant_a_total           INTEGER NOT NULL DEFAULT 0,
  variant_a_success         INTEGER NOT NULL DEFAULT 0,
  variant_b_total           INTEGER NOT NULL DEFAULT 0,
  variant_b_success         INTEGER NOT NULL DEFAULT 0,
  -- 勝者（未決定: NULL, 決定後: 'A' or 'B'）
  winner                    TEXT CHECK (winner IN ('A', 'B')),
  winner_total              INTEGER NOT NULL DEFAULT 0,
  winner_success            INTEGER NOT NULL DEFAULT 0,
  -- トラッキングリンクID（JSON配列）
  variant_a_tracked_link_ids TEXT,
  variant_b_tracked_link_ids TEXT,
  -- マルチアカウント
  line_account_id           TEXT REFERENCES line_accounts (id) ON DELETE SET NULL,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ab_tests_status ON ab_tests (status);
CREATE INDEX IF NOT EXISTS idx_ab_tests_line_account ON ab_tests (line_account_id);

-- ABテスト割り当てテーブル（各ユーザーがどのバリアントを受信したか記録）
CREATE TABLE IF NOT EXISTS ab_test_assignments (
  id            TEXT PRIMARY KEY,
  ab_test_id    TEXT NOT NULL REFERENCES ab_tests (id) ON DELETE CASCADE,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  variant       TEXT NOT NULL CHECK (variant IN ('A', 'B')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_ab_assign_test ON ab_test_assignments (ab_test_id);
CREATE INDEX IF NOT EXISTS idx_ab_assign_friend ON ab_test_assignments (friend_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ab_assign_unique ON ab_test_assignments (ab_test_id, friend_id);

-- messages_logにab_test_id列を追加（ABテスト経由の送信を追跡）
ALTER TABLE messages_log ADD COLUMN ab_test_id TEXT REFERENCES ab_tests (id) ON DELETE SET NULL;
