-- Migration 080: loyalty_rank_discounts.shopify_deactivated_at — supersede 済みコードの Shopify 側無効化マーカー
-- 2026-08-15 Ultraplan PR-D (ランク×定期便):
--   ランク変更 (supersede) で DB 上は旧コードが superseded になるが、Shopify 側の
--   discount は endsAt (最長45日) まで生きたままだった。PR-D で supersede 時に
--   discountCodeDeactivate を撃つが、失敗 (timeout / token 失効) すると旧コードが
--   放置される。この列は「Shopify 側も殺したか」の進捗マーカーで、日次 sweep
--   (coupon-expiry-sweep JST 03:40) が NULL の行を拾って deactivate を再試行し前進する。
--
-- 設計:
--   - NULL = Shopify 側の無効化が未完了 (sweep の再試行対象)
--   - 値あり = deactivate 成功 or 不要と判定した時刻 (期限切れ済みで自然死した行も
--     API を呼ばずマークして走査から外す)
--   - additive only (ALTER ADD COLUMN のみ = live-safe・既存行は NULL)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\080_loyalty_rank_shopify_deactivated.sql
--   (または Admin Ops workflow op: apply-migration-080)

ALTER TABLE loyalty_rank_discounts ADD COLUMN shopify_deactivated_at TEXT;

-- sweep の走査 (superseded かつ未 deactivate) を index で支える。
-- 部分 index の述語は sweep の WHERE と一致させる (status + マーカー NULL)。
CREATE INDEX IF NOT EXISTS idx_loyalty_rank_discounts_pending_deactivation
  ON loyalty_rank_discounts(status, shopify_deactivated_at)
  WHERE shopify_deactivated_at IS NULL;
