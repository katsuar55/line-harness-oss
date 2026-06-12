-- 065: 再入荷通知の完動化 (Task#3, 2026-06-12)
--
-- 背景: Shopify の inventory_levels/update webhook は inventory_item_id を運ぶが、
--   restock_requests は shopify_variant_id しか持たず、旧実装は inventory_item_id を
--   variant_id とみなして照合していた (= 永遠に不一致でゼロ通知のバグ)。
--   登録時に variants_json から inventory_item_id を解決して保存し、webhook は本列で照合する。
ALTER TABLE restock_requests ADD COLUMN inventory_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_restock_requests_inventory_item
  ON restock_requests (inventory_item_id, status);
