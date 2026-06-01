-- Migration 061: loyalty_rank_snapshots table (= 自社内製ロイヤリティ 月次再判定, 2026-06-01)
--
-- 目的:
--   月次 rank 再判定 cron が、 friend ごとに「その月の official rank」 を記録する。
--   trailing-12ヶ月 購入額から算出した rank を月次スナップショットとして固定し、
--   前月 snapshot との比較で 昇格/降格 を検知 (= 降格3日前通知 PR8 の基盤)。
--
-- design:
--   - friend × period で 1 行 (= UNIQUE(friend_id, period) で同月冪等)
--   - rank_id = その月の official rank (regular/bronze/silver/gold/platinum)
--   - direction = 前月比 (initial|up|down|same)
--   - 表示用の live rank は loyalty-rank.ts resolveFriendRank で別途算出 (= 進捗バー)
--   - cb-admin は月次再判定・降格あり → 本 snapshot がその月の確定 rank
--
-- 関連:
--   - packages/db/src/loyalty-rank.ts (= rank 判定 純関数 + trailing-12mo 集計、 migration 059 events 源)
--   - packages/db/src/loyalty-rank-snapshots.ts (= 本 table の CRUD)
--   - apps/worker/src/services/loyalty-rank-cron.ts (= 本 table を書く月次 cron)
--   - PR8 (将来): 降格3日前通知 (= gold/platinum で direction=down 予測時)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\061_loyalty_rank_snapshots.sql

CREATE TABLE IF NOT EXISTS loyalty_rank_snapshots (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL,                   -- friends.id
  period             TEXT NOT NULL,                   -- 'YYYY-MM' (= 評価対象月、 同月冪等 key)
  rank_id            TEXT NOT NULL,                   -- regular/bronze/silver/gold/platinum
  trailing_12mo_jpy  INTEGER NOT NULL DEFAULT 0,      -- 算出時の trailing-12ヶ月 購入額
  prev_rank_id       TEXT,                            -- 前 snapshot の rank (= 降格/昇格検知)
  direction          TEXT NOT NULL DEFAULT 'initial', -- 'initial' | 'up' | 'down' | 'same'
  brand_id           TEXT,                            -- multi-brand (= NULL は naturism default)
  evaluated_at       TEXT NOT NULL,                   -- 算出時点 (JST)
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(friend_id, period)
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rank_snapshots_friend
  ON loyalty_rank_snapshots(friend_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_loyalty_rank_snapshots_period
  ON loyalty_rank_snapshots(period, rank_id);

-- 降格 (= direction=down) を period 内で高速抽出 (= PR8 降格通知)
CREATE INDEX IF NOT EXISTS idx_loyalty_rank_snapshots_demotion
  ON loyalty_rank_snapshots(period, direction);
