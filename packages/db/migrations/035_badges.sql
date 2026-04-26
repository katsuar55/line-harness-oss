-- Phase 2: Gamification — badges + friend_badges
--
-- badges: マスターテーブル (定義)
-- friend_badges: 友だちごとの獲得記録
--
-- 設計方針:
-- - 「集めたい人だけ集める」プレッシャーゼロ。獲得は post-action のトリガーで自動付与
-- - 累計記録優先。ストリーク途切れても badge は永久保存
-- - level は DB に持たず friends.score / 100 で表示時計算 (テーブル肥大回避)

CREATE TABLE IF NOT EXISTS badges (
  code        TEXT PRIMARY KEY,                  -- intake_streak_7 等
  category    TEXT NOT NULL,                     -- intake / purchase / referral / seasonal
  name        TEXT NOT NULL,                     -- 7日連続
  description TEXT,                              -- バッジの説明文
  icon        TEXT,                              -- 絵文字 or icon URL
  threshold   INTEGER,                           -- 獲得閾値 (streak日数 / 購入回数 等)
  rarity      TEXT NOT NULL DEFAULT 'common',    -- common / rare / epic / legendary
  is_active   INTEGER NOT NULL DEFAULT 1,        -- 0 = 廃止
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE INDEX IF NOT EXISTS idx_badges_category ON badges (category, sort_order);

CREATE TABLE IF NOT EXISTS friend_badges (
  id         TEXT PRIMARY KEY,
  friend_id  TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  badge_code TEXT NOT NULL REFERENCES badges(code) ON DELETE CASCADE,
  earned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_id, badge_code)                 -- 同一バッジの重複獲得防止
);
CREATE INDEX IF NOT EXISTS idx_friend_badges_friend ON friend_badges (friend_id);
CREATE INDEX IF NOT EXISTS idx_friend_badges_earned ON friend_badges (earned_at);

-- ===== 初期 seed (bulk INSERT、再実行可能) =====
INSERT OR IGNORE INTO badges (code, category, name, description, icon, threshold, rarity, sort_order) VALUES
  ('intake_streak_7',   'intake',   '7日連続',     '服用記録を7日連続で達成しました',     '🌱', 7,   'common',    10),
  ('intake_streak_30',  'intake',   '30日連続',    '服用記録を30日連続で達成しました',    '🌿', 30,  'rare',      11),
  ('intake_streak_100', 'intake',   '100日連続',   '服用記録を100日連続で達成しました',   '🌳', 100, 'epic',      12),
  ('intake_total_30',   'intake',   '累計30回',    '服用記録の累計が30回に達しました',    '⭐', 30,  'common',    20),
  ('intake_total_100',  'intake',   '累計100回',   '服用記録の累計が100回に達しました',   '🌟', 100, 'rare',      21),
  ('intake_total_365',  'intake',   '累計365回',   '服用記録の累計が365回に達しました',   '🏆', 365, 'legendary', 22),
  ('purchase_first',    'purchase', '初回購入',    'はじめてのご購入ありがとうございます', '🎉', 1,   'common',    30),
  ('purchase_5',        'purchase', 'リピーター',  '5回ご購入いただきました',             '💎', 5,   'rare',      31),
  ('purchase_10',       'purchase', '常連様',      '10回ご購入いただきました',            '👑', 10,  'epic',      32),
  ('referral_first',    'referral', '初紹介',      'お友だち1人を紹介してくれました',     '🤝', 1,   'common',    40),
  ('referral_5',        'referral', 'アンバサダー','お友だち5人を紹介してくれました',     '✨', 5,   'rare',      41);
