-- Migration 060: friends.shopify_customer_id column 追加 (= Phase 4-ι customer bridge、 2026-05-28)
--
-- 目的:
--   friends に Shopify customer ID 列を追加し、 friend と Shopify customer の direct bridge を確立。
--   既存 path (= users.email/phone → friends.user_id) は LIFF email opt-in 完了後しか動かないが、
--   shopify_customer_id 直結 path は LINE 友だち追加時に customer_id を取得できれば即動く。
--
-- 効果:
--   - Phase 4-γ resolveFriendForOrder の customer_id match path で過去/新規 order の friend resolve 精度向上
--   - 5/28 時点 backfill: shopify_orders.email = friends.email match で 0 件 → 将来 friend が email opt-in
--     完了したら retrospective match cron で過去 order を members 累計に反映可能 (= 別 PR)
--
-- 関連:
--   - Phase 4-γ (= PR #83): resolveFriendForOrder (= 純関数、 shopify_customer_id path 既に input にあるが未使用)
--   - 本 PR: friends にcolumn 追加 + resolveFriendForOrder で customer_id 経由 lookup 実装
--   - 後 PR (= retrospective match cron): friend が email link 完了時に過去 shopify_orders を members に retroactively 反映
--
-- 設計:
--   - NULLABLE (= 既存 friends は NULL、 後で update 可能)
--   - UNIQUE INDEX (= 1 Shopify customer ≦ 1 LINE friend、 重複防止)
--   - PARTIAL INDEX `WHERE shopify_customer_id IS NOT NULL` (= NULL の重複は許可、 D1/SQLite で必要)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\060_friends_shopify_customer_id.sql

ALTER TABLE friends ADD COLUMN shopify_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_shopify_customer_id
  ON friends(shopify_customer_id)
  WHERE shopify_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_friends_shopify_customer_id_lookup
  ON friends(shopify_customer_id);
