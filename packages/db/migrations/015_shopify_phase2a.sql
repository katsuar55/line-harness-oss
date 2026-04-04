-- =============================================
-- Phase 2A: Shopify 連携強化
-- カゴ落ち・再入荷通知・発送通知・クーポン・会員ランク
-- =============================================

-- ===========================================
-- 1. カゴ落ちメッセージ配信 (Abandoned Carts)
-- ===========================================
CREATE TABLE IF NOT EXISTS abandoned_carts (
  id                        TEXT PRIMARY KEY,
  shopify_checkout_id       TEXT NOT NULL UNIQUE,
  friend_id                 TEXT REFERENCES friends(id) ON DELETE SET NULL,
  shopify_customer_id       TEXT,
  cart_token                TEXT,
  email                     TEXT,
  line_items                TEXT DEFAULT '[]',
  total_price               REAL DEFAULT 0,
  currency                  TEXT DEFAULT 'JPY',
  checkout_url              TEXT,
  status                    TEXT NOT NULL DEFAULT 'pending',
  notification_scheduled_at TEXT,
  notified_at               TEXT,
  recovered_at              TEXT,
  recovered_order_id        TEXT,
  metadata                  TEXT DEFAULT '{}',
  created_at                TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_friend ON abandoned_carts(friend_id);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_status ON abandoned_carts(status);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_scheduled ON abandoned_carts(status, notification_scheduled_at);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_cart_token ON abandoned_carts(cart_token);
CREATE INDEX IF NOT EXISTS idx_abandoned_carts_email ON abandoned_carts(email);

-- ===========================================
-- 2. 入荷/再入荷通知 (Restock Requests)
-- ===========================================
CREATE TABLE IF NOT EXISTS restock_requests (
  id                   TEXT PRIMARY KEY,
  friend_id            TEXT REFERENCES friends(id) ON DELETE SET NULL,
  shopify_product_id   TEXT NOT NULL,
  shopify_variant_id   TEXT NOT NULL,
  product_title        TEXT,
  variant_title        TEXT,
  status               TEXT NOT NULL DEFAULT 'waiting',
  notified_at          TEXT,
  cancelled_at         TEXT,
  metadata             TEXT DEFAULT '{}',
  created_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_restock_requests_friend ON restock_requests(friend_id);
CREATE INDEX IF NOT EXISTS idx_restock_requests_variant ON restock_requests(shopify_variant_id, status);
CREATE INDEX IF NOT EXISTS idx_restock_requests_product ON restock_requests(shopify_product_id, status);
CREATE INDEX IF NOT EXISTS idx_restock_requests_status ON restock_requests(status);

-- ===========================================
-- 3. 発送通知 (Fulfillments)
-- ===========================================
CREATE TABLE IF NOT EXISTS shopify_fulfillments (
  id                      TEXT PRIMARY KEY,
  shopify_order_id        TEXT NOT NULL,
  shopify_fulfillment_id  TEXT NOT NULL UNIQUE,
  order_id                TEXT REFERENCES shopify_orders(id) ON DELETE SET NULL,
  friend_id               TEXT REFERENCES friends(id) ON DELETE SET NULL,
  tracking_number         TEXT,
  tracking_url            TEXT,
  tracking_company        TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending',
  line_items              TEXT DEFAULT '[]',
  notified_at             TEXT,
  metadata                TEXT DEFAULT '{}',
  created_at              TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_shopify_fulfillments_order ON shopify_fulfillments(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_shopify_fulfillments_friend ON shopify_fulfillments(friend_id);
CREATE INDEX IF NOT EXISTS idx_shopify_fulfillments_status ON shopify_fulfillments(status);

-- 決済通知ログ
CREATE TABLE IF NOT EXISTS shopify_payment_notifications (
  id                TEXT PRIMARY KEY,
  shopify_order_id  TEXT NOT NULL,
  order_id          TEXT REFERENCES shopify_orders(id) ON DELETE SET NULL,
  friend_id         TEXT REFERENCES friends(id) ON DELETE SET NULL,
  financial_status  TEXT NOT NULL,
  total_price       REAL,
  currency          TEXT DEFAULT 'JPY',
  notified_at       TEXT,
  metadata          TEXT DEFAULT '{}',
  created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_payment_notifications_order ON shopify_payment_notifications(shopify_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_notifications_friend ON shopify_payment_notifications(friend_id);

-- ===========================================
-- 4. クーポン管理 (Coupons)
-- ===========================================
CREATE TABLE IF NOT EXISTS shopify_coupons (
  id                    TEXT PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE,
  shopify_price_rule_id TEXT,
  shopify_discount_id   TEXT,
  title                 TEXT,
  description           TEXT,
  discount_type         TEXT NOT NULL DEFAULT 'percentage',
  discount_value        REAL NOT NULL DEFAULT 0,
  minimum_order_amount  REAL,
  usage_limit           INTEGER,
  usage_count           INTEGER DEFAULT 0,
  starts_at             TEXT,
  expires_at            TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  metadata              TEXT DEFAULT '{}',
  created_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_shopify_coupons_code ON shopify_coupons(code);
CREATE INDEX IF NOT EXISTS idx_shopify_coupons_status ON shopify_coupons(status);

CREATE TABLE IF NOT EXISTS shopify_coupon_assignments (
  id              TEXT PRIMARY KEY,
  coupon_id       TEXT NOT NULL REFERENCES shopify_coupons(id) ON DELETE CASCADE,
  friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  assigned_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  used_at         TEXT,
  shopify_order_id TEXT,
  metadata        TEXT DEFAULT '{}',
  created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_coupon_assignments_coupon ON shopify_coupon_assignments(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_assignments_friend ON shopify_coupon_assignments(friend_id);

-- ===========================================
-- 5. 会員ランク (Member Ranks)
-- ===========================================
CREATE TABLE IF NOT EXISTS member_ranks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  min_total_spent  REAL NOT NULL DEFAULT 0,
  min_orders_count INTEGER NOT NULL DEFAULT 0,
  color            TEXT,
  icon             TEXT,
  benefits_json    TEXT DEFAULT '[]',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_member_ranks_sort ON member_ranks(sort_order);

CREATE TABLE IF NOT EXISTS friend_ranks (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  rank_id       TEXT NOT NULL REFERENCES member_ranks(id) ON DELETE CASCADE,
  total_spent   REAL NOT NULL DEFAULT 0,
  orders_count  INTEGER NOT NULL DEFAULT 0,
  previous_rank_id TEXT,
  calculated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_ranks_friend ON friend_ranks(friend_id);
CREATE INDEX IF NOT EXISTS idx_friend_ranks_rank ON friend_ranks(rank_id);

-- デフォルトランク（管理画面で後から変更可能）
INSERT OR IGNORE INTO member_ranks (id, name, min_total_spent, min_orders_count, color, sort_order, benefits_json)
VALUES
  ('rank_regular',  'レギュラー', 0,     0, '#9E9E9E', 1, '[]'),
  ('rank_bronze',   'ブロンズ',   5000,  2, '#CD7F32', 2, '["birthday_coupon"]'),
  ('rank_silver',   'シルバー',   15000, 5, '#C0C0C0', 3, '["birthday_coupon","free_shipping"]'),
  ('rank_gold',     'ゴールド',   50000, 10, '#FFD700', 4, '["birthday_coupon","free_shipping","early_access"]'),
  ('rank_platinum', 'プラチナ',   100000, 20, '#E5E4E2', 5, '["birthday_coupon","free_shipping","early_access","vip_support"]');
