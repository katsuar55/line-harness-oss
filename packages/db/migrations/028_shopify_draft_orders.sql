-- 028: Shopify Draft Orders — LIFF再購入で作成したDraft Orderを追跡
CREATE TABLE IF NOT EXISTS shopify_draft_orders (
  id TEXT PRIMARY KEY,
  friend_id TEXT REFERENCES friends(id),
  shopify_draft_order_id TEXT NOT NULL,
  shopify_draft_order_gid TEXT,
  invoice_url TEXT,
  status TEXT DEFAULT 'open',
  total_price REAL,
  currency TEXT DEFAULT 'JPY',
  line_items TEXT,
  source_order_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shopify_draft_orders_friend
  ON shopify_draft_orders(friend_id);
CREATE INDEX IF NOT EXISTS idx_shopify_draft_orders_shopify_id
  ON shopify_draft_orders(shopify_draft_order_id);
