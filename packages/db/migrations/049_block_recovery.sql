-- ============================================================
-- Migration 049: ブロック復活施策トラッキング (Phase 5α-7)
--
-- 目的 (Ultraplan v4 大方針 3 Lステップ網羅):
--   - 友だちが LINE をブロック (unfollow) → 再フォロー した履歴を追跡
--   - 「ブロック復活した友だち」 を集計・可視化し、 再アプローチ施策に繋げる
--   - ban-monitor (account_health_logs) との 2 軸で「離脱と復活」 を見える化
--
-- 設計方針:
--   - friends テーブルに 3 列を追加 (履歴 log table は overkill、 直近状態だけで十分)
--   - last_unfollowed_at: 直近の unfollow タイムスタンプ
--   - last_refollowed_at: 直近の re-follow タイムスタンプ (NULL = 過去に unfollow なし or 再 follow なし)
--   - unfollow_count: 累計 unfollow 回数 (リピート離脱の検知)
--
-- 集計クエリ例:
--   -- 直近 7 日で復活した友だち
--   SELECT * FROM friends
--     WHERE last_refollowed_at >= datetime('now', '-7 days', '+9 hours')
--       AND is_following = 1
--     ORDER BY last_refollowed_at DESC;
--
--   -- 累計 2 回以上ブロック (常習)
--   SELECT * FROM friends WHERE unfollow_count >= 2;
-- ============================================================

ALTER TABLE friends ADD COLUMN last_unfollowed_at TEXT;
ALTER TABLE friends ADD COLUMN last_refollowed_at TEXT;
ALTER TABLE friends ADD COLUMN unfollow_count INTEGER NOT NULL DEFAULT 0;

-- 復活した友だちの timeline 検索を高速化
CREATE INDEX IF NOT EXISTS idx_friends_refollowed
  ON friends(last_refollowed_at DESC)
  WHERE last_refollowed_at IS NOT NULL;

-- 「ブロック中」 ステータス検索 (is_following=0 + last_unfollowed_at)
CREATE INDEX IF NOT EXISTS idx_friends_unfollowed
  ON friends(is_following, last_unfollowed_at DESC)
  WHERE last_unfollowed_at IS NOT NULL;
