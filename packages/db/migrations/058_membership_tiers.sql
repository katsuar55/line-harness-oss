-- Migration 058: membership_tiers + members table (= Phase 4 scaffolding、 2026-05-27)
--
-- 目的:
--   会員ランク 制度 (= Phase 4) の基盤。 friend ごとに purchase 累計額を集計し、
--   bronze / silver / gold / platinum の tier に auto promote する。
--   将来的に LIFF で「あなたのランク」 表示 + tier 別特典 (= 紹介クーポン拡張、
--   アンバサダー応募権限 etc.) を提供。
--
-- 関連 (= Phase 4 全体構想):
--   - PR #81 (本 migration): tier 定義 + member status (= scaffolding only)
--   - PR #82 (将来): 自動 promotion cron + Shopify customer 同期
--   - PR #83 (将来): 紹介 referral_codes table + LIFF 紹介 flow
--   - PR #84 (将来): アンバサダー tier + 高 referral 数で auto promote
--   - PR #85 (将来): admin web /membership page + dashboard
--
-- 設計方針:
--   - membership_tiers = master (= bronze / silver / gold / platinum / ambassador)
--     管理画面で追加 / 編集可能、 seed で 4 件初期登録
--   - members = friend_id → current tier の current state、 累計購入額、 promotion 履歴
--   - audit trail (= tier 昇格履歴) は audit_logs を使う (= migration 048 既存 table 流用)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\058_membership_tiers.sql

-- ============================================================
-- 1. membership_tiers (= master、 BRZ/SLV/GLD/PLT/AMB)
-- ============================================================

CREATE TABLE IF NOT EXISTS membership_tiers (
  id                    TEXT PRIMARY KEY,                -- e.g. 'bronze', 'silver'
  name                  TEXT NOT NULL,                   -- 表示名 (= 「ブロンズ」 「シルバー」)
  display_order         INTEGER NOT NULL,                -- sort order (= 1=bronze, 2=silver, ...)
  min_total_purchase_jpy INTEGER NOT NULL DEFAULT 0,     -- 累計購入額の閾値 (= 円)
  min_referral_count    INTEGER NOT NULL DEFAULT 0,      -- 紹介人数の閾値 (= alternative path)
  perks                 TEXT,                            -- JSON: { discount_percent: 5, exclusive_products: [], priority_support: false, ... }
  badge_emoji           TEXT,                            -- LIFF 表示用絵文字 (= 🥉 / 🥈 / 🥇 / 💎)
  badge_color           TEXT,                            -- hex color (= UI tinting 用)
  is_active             INTEGER NOT NULL DEFAULT 1,      -- 0/1
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_membership_tiers_order
  ON membership_tiers(display_order, is_active);

-- ============================================================
-- 2. members (= friend_id → current tier、 累計 purchase + promotion 履歴)
-- ============================================================

CREATE TABLE IF NOT EXISTS members (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL UNIQUE,            -- friends.id FK
  current_tier_id       TEXT NOT NULL DEFAULT 'bronze',  -- membership_tiers.id FK
  total_purchase_jpy    INTEGER NOT NULL DEFAULT 0,      -- 累計購入額 (= Shopify 連動で更新)
  total_referral_count  INTEGER NOT NULL DEFAULT 0,      -- 紹介成功人数 (= referral_codes でカウント)
  last_purchase_at      TEXT,                            -- 最終購入時刻
  last_promotion_at     TEXT,                            -- 最終 tier 昇格時刻
  joined_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_members_friend
  ON members(friend_id);

CREATE INDEX IF NOT EXISTS idx_members_tier
  ON members(current_tier_id, total_purchase_jpy DESC);

CREATE INDEX IF NOT EXISTS idx_members_purchase
  ON members(total_purchase_jpy DESC);

-- ============================================================
-- Seed: bronze / silver / gold / platinum / ambassador (= 5 tiers)
-- ============================================================

INSERT OR IGNORE INTO membership_tiers (
  id, name, display_order, min_total_purchase_jpy, min_referral_count,
  perks, badge_emoji, badge_color
) VALUES
  ('bronze',    'ブロンズ',     1, 0,       0,
   '{"discount_percent":0,"priority_support":false,"exclusive_products":[]}',
   '🥉', '#cd7f32'),
  ('silver',    'シルバー',     2, 10000,   0,
   '{"discount_percent":3,"priority_support":false,"exclusive_products":[]}',
   '🥈', '#c0c0c0'),
  ('gold',      'ゴールド',     3, 30000,   0,
   '{"discount_percent":5,"priority_support":true,"exclusive_products":[]}',
   '🥇', '#ffd700'),
  ('platinum',  'プラチナ',     4, 100000,  3,
   '{"discount_percent":8,"priority_support":true,"exclusive_products":["Pink Limited"]}',
   '💎', '#e5e4e2'),
  ('ambassador','アンバサダー', 5, 200000,  10,
   '{"discount_percent":10,"priority_support":true,"exclusive_products":["Pink Limited","Beta Test"],"affiliate_code":true}',
   '🌟', '#ff6b9d');
