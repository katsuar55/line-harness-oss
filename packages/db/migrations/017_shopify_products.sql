-- 017_shopify_products.sql — Shopify商品カタログテーブル
-- Phase 2B: 商品自動表示（Flexメッセージ）のためのプロダクトキャッシュ

CREATE TABLE IF NOT EXISTS shopify_products (
  id                  TEXT PRIMARY KEY,
  shopify_product_id  TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT,
  vendor              TEXT,
  product_type        TEXT,
  handle              TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  image_url           TEXT,
  price               TEXT,
  compare_at_price    TEXT,
  tags                TEXT,
  variants_json       TEXT,
  store_url           TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_shopify_products_status ON shopify_products (status);
CREATE INDEX IF NOT EXISTS idx_shopify_products_type ON shopify_products (product_type);

-- 商品レコメンド履歴（同じユーザーに同じ商品を重複送信しない）
CREATE TABLE IF NOT EXISTS product_recommendations (
  id                  TEXT PRIMARY KEY,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  shopify_product_id  TEXT NOT NULL,
  trigger_type        TEXT NOT NULL CHECK (trigger_type IN ('purchase', 'browse', 'restock', 'manual', 'scheduled')),
  sent_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_prod_rec_friend ON product_recommendations (friend_id);
CREATE INDEX IF NOT EXISTS idx_prod_rec_product ON product_recommendations (shopify_product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prod_rec_unique ON product_recommendations (friend_id, shopify_product_id, trigger_type);
