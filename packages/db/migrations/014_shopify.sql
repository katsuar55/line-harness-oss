-- Shopify 連携テーブル
CREATE TABLE IF NOT EXISTS shopify_orders (
  id TEXT PRIMARY KEY,
  shopify_order_id TEXT NOT NULL UNIQUE,
  shopify_customer_id TEXT,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  email TEXT,
  phone TEXT,
  total_price REAL,
  currency TEXT DEFAULT 'JPY',
  financial_status TEXT,
  fulfillment_status TEXT,
  order_number INTEGER,
  line_items TEXT,
  tags TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE IF NOT EXISTS shopify_customers (
  id TEXT PRIMARY KEY,
  shopify_customer_id TEXT NOT NULL UNIQUE,
  friend_id TEXT REFERENCES friends(id) ON DELETE SET NULL,
  email TEXT,
  phone TEXT,
  first_name TEXT,
  last_name TEXT,
  orders_count INTEGER DEFAULT 0,
  total_spent REAL DEFAULT 0,
  tags TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_friend ON shopify_orders(friend_id);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_email ON shopify_orders(email);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_shopify_customer ON shopify_orders(shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_friend ON shopify_customers(friend_id);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_email ON shopify_customers(email);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_phone ON shopify_customers(phone);

-- Shopify トークンキャッシュテーブル（Client Credentials Grant）
CREATE TABLE IF NOT EXISTS shopify_tokens (
  id TEXT PRIMARY KEY DEFAULT 'default',
  access_token TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
