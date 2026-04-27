-- 041: Phase 6 PR-3 — 購入連動クロスセル推奨マップ
--
-- ゴール: 再購入リマインダー push 時に「ついでにこちらもどうですか」を
--        最大 2 件提案する。商品ペア (source → recommended) を運用者が登録。
--
-- データソースは「Phase 4 nutrition_sku_map (栄養素ベース)」と独立した
-- 「購入実績ベース (例: プロテイン → 鉄サプリ、コラーゲン → 食物繊維)」。
-- 両方の SKU を最終的にユニオンして提案する想定。

CREATE TABLE IF NOT EXISTS purchase_cross_sell_map (
  source_product_id TEXT NOT NULL,
  recommended_product_id TEXT NOT NULL,
  reason TEXT,
  priority INTEGER NOT NULL DEFAULT 0,    -- 大きい方を優先
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (source_product_id, recommended_product_id)
);

CREATE INDEX IF NOT EXISTS idx_cross_sell_source
  ON purchase_cross_sell_map(source_product_id, is_active, priority DESC);
