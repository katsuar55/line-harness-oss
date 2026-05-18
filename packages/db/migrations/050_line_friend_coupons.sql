-- Phase 5β-1d-2: LINE 友だち追加経路の Shopify 動的クーポン発行履歴
--
-- 目的:
--   LINE 友だち追加時 (webhook follow event) に 1 friend 1 回限り Shopify 連動の
--   500 円 OFF クーポンを発行。 発行履歴を本テーブルで一元管理し、 重複発行 (friend_id UNIQUE)
--   と将来の使用追跡 (Shopify webhook で redeemed_at 更新予定) を可能にする。
--
-- 設計原則:
--   - friend_id UNIQUE で 1 friend 1 coupon を DB レベルで強制
--   - status enum で issued / redeemed / expired / revoked のライフサイクル管理
--   - source enum で shopify (API 成功) と static_fallback (Shopify API 失敗時の静的 fallback)
--     を区別 (将来 fallback 戦略を導入する際の準備、 MVP では shopify のみ)
--   - line_account_id (NULL 可、 multi-tenant 対応)
--   - metadata JSON で Shopify 側の追加情報 (price_rule_id 詳細等) を append-only 保存

CREATE TABLE IF NOT EXISTS line_friend_coupons (
  id                       TEXT PRIMARY KEY,
  friend_id                TEXT NOT NULL UNIQUE,           -- 1 friend に 1 coupon (初回のみ)
  line_account_id          TEXT,
  coupon_code              TEXT NOT NULL,                  -- Shopify で発行された code (顧客が入力する文字列)
  shopify_discount_code_id TEXT,                           -- Shopify GraphQL ID (gid://shopify/DiscountCodeBasic/...)
  shopify_price_rule_id    TEXT,                           -- Shopify Price Rule ID (legacy REST、 将来更新可)
  discount_value           INTEGER NOT NULL,               -- 値引き額 (整数、 例: 500)
  discount_currency        TEXT NOT NULL DEFAULT 'JPY',
  issued_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  redeemed_at              TEXT,                            -- 使用された時刻 (将来 Shopify webhook で更新)
  expires_at               TEXT,                            -- coupon 有効期限 (NULL = 無期限)
  status                   TEXT NOT NULL DEFAULT 'issued'
                           CHECK (status IN ('issued', 'redeemed', 'expired', 'revoked')),
  source                   TEXT NOT NULL DEFAULT 'shopify'
                           CHECK (source IN ('shopify', 'static_fallback')),
  metadata                 TEXT,                            -- JSON (Shopify API response の subset 等)
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_line_friend_coupons_friend
  ON line_friend_coupons(friend_id);
CREATE INDEX IF NOT EXISTS idx_line_friend_coupons_account
  ON line_friend_coupons(line_account_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_friend_coupons_issued
  ON line_friend_coupons(issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_line_friend_coupons_code
  ON line_friend_coupons(coupon_code);
CREATE INDEX IF NOT EXISTS idx_line_friend_coupons_status
  ON line_friend_coupons(status, issued_at DESC);
