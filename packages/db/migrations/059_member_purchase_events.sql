-- Migration 059: member_purchase_events table (= Phase 4-γ Shopify orders 連動、 2026-05-28)
--
-- 目的:
--   Shopify orders webhook 受信時、 既存 friend にマッチしたら members.total_purchase_jpy を加算する。
--   shopify_order_id を unique key とした重複防止 + audit trail テーブル。
--
-- design:
--   - 1 order = 1 row (= shopify_order_id UNIQUE)
--   - friend_id NULLABLE (= マッチしなくても order 自体は記録、 後で email/phone update 可能性)
--   - amount_jpy = order.total_price * 100 ではなく JPY 整数 (= naturism は JPY only)
--   - applied_at = members への加算実行時刻 (= NULL なら未適用)
--
-- 関連:
--   - Phase 4-β (PR #81 merged): membership_tiers + members + promoteMemberIfEligible (= migration 058)
--   - Phase 4-γ (本 PR): order webhook → addPurchaseEvent → upsertMember + promote
--   - Phase 4-δ (将来): 月次 cron で全 member sanity check (= members の現状値で promoteMemberIfEligible)
--   - Phase 4-ε (将来): referral_codes (= members.total_referral_count update path)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\059_member_purchase_events.sql

CREATE TABLE IF NOT EXISTS member_purchase_events (
  id                TEXT PRIMARY KEY,
  shopify_order_id  TEXT NOT NULL UNIQUE,           -- Shopify order ID (= 冪等性 key)
  friend_id         TEXT,                            -- friends.id FK (= NULL ならマッチ失敗 audit only)
  amount_jpy        INTEGER NOT NULL DEFAULT 0,      -- 注文金額 (= 円)
  currency          TEXT NOT NULL DEFAULT 'JPY',
  order_number      INTEGER,                         -- Shopify order_number (= 人間可読)
  email             TEXT,                            -- order email (= マッチ失敗時の debug 用)
  phone             TEXT,                            -- order phone (= 同上)
  applied_at        TEXT,                            -- members への加算実行時刻 (NULL なら未適用)
  source            TEXT NOT NULL DEFAULT 'webhook', -- 'webhook' | 'backfill' | 'manual'
  metadata          TEXT,                            -- JSON: raw fields for debug
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_member_purchase_events_order
  ON member_purchase_events(shopify_order_id);

CREATE INDEX IF NOT EXISTS idx_member_purchase_events_friend
  ON member_purchase_events(friend_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_member_purchase_events_unapplied
  ON member_purchase_events(applied_at) WHERE applied_at IS NULL;
