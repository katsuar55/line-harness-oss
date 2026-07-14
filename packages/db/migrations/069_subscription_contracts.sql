-- 069: Shopify サブスク契約 read-model (WI-1, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)
-- Huckleberry「定期購買」が注文/顧客に付与するタグから契約状態を導出してキャッシュする。
-- 注意: 既存 subscription_reminders (再購入リマインド) とは完全に別物。
--   契約の正本は Huckleberry 側にあり、本テーブルは LINE トーク内表示 + リマインド用の導出値。
--   Phase 3 (自社課金基盤) 移行時にこのテーブルが契約本体テーブルへ昇格する。
CREATE TABLE IF NOT EXISTS subscription_contracts (
  contract_id TEXT PRIMARY KEY,               -- 注文タグ subscription-id:{ID} の値
  shopify_customer_id TEXT,                   -- shopify_customers / friends.shopify_customer_id と照合
  plan_name TEXT,                             -- selling plan 名 or 顧客タグ subscription-{ID}-plan の値
  interval_days INTEGER,                      -- plan 名から解析 (「30日に1回配送」→30)。解析不能は NULL
  order_count INTEGER,                        -- 注文タグ subscription-count:{N} (最新値)
  last_order_id TEXT,                         -- shopify_orders.shopify_order_id
  last_order_at TEXT,                         -- 直近の定期注文作成 (≈決済) 日時
  last_delivery_date TEXT,                    -- 注文タグ delivery-{ID}:{yyyy-mm-dd ...} の日付部
  skip_count INTEGER NOT NULL DEFAULT 0,      -- 顧客タグ subscription-{ID}-skip-count:{n} (累計)
  skip_count_at_last_order INTEGER NOT NULL DEFAULT 0, -- 直近注文時点の skip 累計 (推定日計算用)
  paused_at TEXT,                             -- 顧客タグ subscription-{ID}-pause:{date} (決済失敗も含む)
  cancelled_at TEXT,                          -- 顧客タグ subscription-{ID}-cancel:{date}
  next_billing_estimate TEXT,                 -- YYYY-MM-DD (JST)。cancelled/paused/interval不明は NULL
  estimate_source TEXT NOT NULL DEFAULT 'derived', -- derived | flow (WI-2 で Shopify Flow 実測に昇格)
  reminded_for_estimate TEXT,                 -- WI-2 リマインド冪等キー (この推定日に送信済み)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscription_contracts_customer
  ON subscription_contracts(shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_subscription_contracts_estimate
  ON subscription_contracts(next_billing_estimate);
