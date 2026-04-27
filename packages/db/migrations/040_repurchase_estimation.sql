-- 040: Phase 6 PR-1 — 商品別再購入間隔推定
--
-- ゴール: subscription_reminders.interval_days を「ユーザー履歴 → 商品 default → fallback」
-- の優先順位で自動設定するための基盤。手動で変更も可能。
--
-- 既存の subscription_reminders (migration 029) を拡張し、推定ソース情報を保持する。

-- 商品別の推奨再購入間隔 (運用者が後で調整可能)
CREATE TABLE IF NOT EXISTS product_repurchase_intervals (
  shopify_product_id TEXT PRIMARY KEY,
  product_title TEXT,
  default_interval_days INTEGER NOT NULL DEFAULT 30,
  -- source: 'manual' (運用者編集) | 'seed' (初期投入) | 'auto_estimated' (実績ベース)
  source TEXT NOT NULL DEFAULT 'manual',
  sample_size INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_repurchase_intervals_source
  ON product_repurchase_intervals(source);

-- subscription_reminders に推定ソース情報を追加
-- D1 (SQLite) の ALTER TABLE は DEFAULT 句必須
ALTER TABLE subscription_reminders ADD COLUMN shopify_product_id TEXT;
ALTER TABLE subscription_reminders ADD COLUMN interval_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE subscription_reminders ADD COLUMN sample_size INTEGER NOT NULL DEFAULT 0;

-- product_id 検索用インデックス (cross-sell や履歴照会で使う)
CREATE INDEX IF NOT EXISTS idx_sub_reminders_product
  ON subscription_reminders(shopify_product_id);
