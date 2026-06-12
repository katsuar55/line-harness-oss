-- 065: 再入荷通知の完動化 (Task#3, 2026-06-12)
--
-- 背景: Shopify の inventory_levels/update webhook は inventory_item_id を運ぶが、
--   restock_requests は shopify_variant_id しか持たず、旧実装は inventory_item_id を
--   variant_id とみなして照合していた (= 永遠に不一致でゼロ通知のバグ)。
--   登録時に variants_json から inventory_item_id を解決して保存し、webhook は本列で照合する。
ALTER TABLE restock_requests ADD COLUMN inventory_item_id TEXT;

CREATE INDEX IF NOT EXISTS idx_restock_requests_inventory_item
  ON restock_requests (inventory_item_id, status);

-- 注意 (review MED): 本 migration 前に登録済みの waiting 行は inventory_item_id=NULL となり、
--   inventory_levels/update の照合 (WHERE inventory_item_id = ?) に永久に当たらない。
--   旧実装では再入荷導線自体が機能していなかった (= waiting 行はほぼ存在しない) ため実害は限定的。
--   念のため本番適用後に `SELECT COUNT(*) FROM restock_requests WHERE status='waiting' AND inventory_item_id IS NULL`
--   を確認し、存在する場合は variants_json から解決して backfill すること。
