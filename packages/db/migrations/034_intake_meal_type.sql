-- Phase 1: 能動pull化 + 服用記録
-- intake_logs に meal_type カラムを追加し、同日同 meal_type の重複登録を防止する。
-- 既存データ (meal_type なし) は NULL のまま残す (後方互換性のため CHECK 制約は緩く)。

ALTER TABLE intake_logs ADD COLUMN meal_type TEXT;

-- 同一日 + 同一 meal_type の重複防止 (NULL は無制限なので既存データに影響なし)
-- logged_at は ISO8601 文字列 (YYYY-MM-DDTHH:mm:ss.sss+09:00) なので date 部分で UNIQUE
-- SQLite は UNIQUE INDEX に式が使えるので substr で日付抽出
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_logs_unique_meal
  ON intake_logs (friend_id, substr(logged_at, 1, 10), meal_type)
  WHERE meal_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intake_logs_friend_date
  ON intake_logs (friend_id, logged_at);
