-- Migration 020: 友だちプロフィール拡張 + ダッシュボード用ビュー
-- gender/birthday カラム追加、紹介クーポン自動発行対応、日別集計テーブル

-- ━━━ 友だちプロフィール拡張 ━━━
ALTER TABLE friends ADD COLUMN gender TEXT;          -- 'male' | 'female' | 'other' | null
ALTER TABLE friends ADD COLUMN birthday TEXT;         -- 'YYYY-MM-DD' | null
ALTER TABLE friends ADD COLUMN first_purchase_date TEXT; -- 初回購入日キャッシュ

-- ━━━ 日別集計スナップショット（Cron or 手動で更新） ━━━
CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  stat_date TEXT NOT NULL,            -- 'YYYY-MM-DD'
  new_friends INTEGER DEFAULT 0,      -- 新規友だち数
  unfollowed INTEGER DEFAULT 0,       -- ブロック/解除数
  total_friends INTEGER DEFAULT 0,    -- 累計友だち数
  orders_count INTEGER DEFAULT 0,     -- 注文件数
  orders_revenue REAL DEFAULT 0,      -- 売上合計
  intake_logs_count INTEGER DEFAULT 0, -- 服用記録数
  referrals_count INTEGER DEFAULT 0,  -- 紹介成立数
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(stat_date)
);

-- ━━━ 紹介クーポン定義テーブル（LINE CRM内部クーポン） ━━━
CREATE TABLE IF NOT EXISTS referral_coupons (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL DEFAULT 'fixed',  -- 'fixed' | 'percent'
  discount_value REAL NOT NULL DEFAULT 500,
  minimum_order_amount REAL DEFAULT 0,
  expires_days INTEGER NOT NULL DEFAULT 30,     -- 発行日から何日有効
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- デフォルトの紹介クーポン定義を挿入
INSERT OR IGNORE INTO referral_coupons (id, code, discount_type, discount_value, minimum_order_amount, expires_days)
VALUES
  ('ref-coupon-referrer', 'REFER500', 'fixed', 500, 2000, 30),
  ('ref-coupon-referred', 'WELCOME500', 'fixed', 500, 2000, 30);
