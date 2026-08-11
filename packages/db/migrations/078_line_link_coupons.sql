-- 078: 連携特典クーポン台帳 (Sprint A-1, 2026-08-11)
--
-- 目的: LINE⇔Shopify アカウント連携を顧客自身が完了した瞬間に ¥500 OFF の
--   Shopify 実クーポンを 1 枚発行する (= crit1「LINE 到達可能な連携済み契約 >30」を
--   動かす連携インセンティブ)。対象経路 = sub-link redeem (App Proxy / magic-link) と
--   email OTP verify の顧客対話 2 系統。cron 逆引き / admin import は対象外。
--
-- 設計 (migration 068 line_referral_coupons と同型の 4 本目):
--   - **UNIQUE(friend_id) が冪等キー** = 連携特典は 1 friend につき生涯 1 枚。
--     再連携・別経路での重複発行・並行 redeem はすべてこの制約で 1 枚に収束する。
--   - line_friend_coupons (welcome) の再利用は friend_id 列レベル UNIQUE が
--     welcome 側で消費済みのため不可。line_referral_coupons の再利用は
--     role CHECK ('referrer','referred') の破壊的 rebuild が要るため不可
--     (SQLite の列レベル UNIQUE / CHECK は ALTER 不可 → additive 別テーブルが live-safe。
--      根拠: memory feedback_sqlite_inline_unique_rebuild / migration 068 の理由書き)。
--   - link_path は監査・経路別効果測定用 (audit_logs からの導出を 1 テーブルで完結させる)。
--
-- 適用 (cwd: apps/worker、 非破壊 = 破壊的承認ルール非該当):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\078_line_link_coupons.sql
--   gate LINK_REWARD_ENABLED (既定 off) のため、 適用前に code を deploy しても本番無害。

CREATE TABLE IF NOT EXISTS line_link_coupons (
  id                       TEXT PRIMARY KEY,
  friend_id                TEXT NOT NULL,                  -- 連携を完了した friend (= クーポン所有者)
  shopify_customer_id      TEXT NOT NULL,                  -- 連携先 Shopify customer (numeric id)
  link_path                TEXT NOT NULL DEFAULT 'unknown'
                           CHECK (link_path IN ('sub_link', 'email_otp', 'unknown')),
  coupon_code              TEXT NOT NULL,                  -- Shopify で発行された code (NLINK-)
  shopify_discount_code_id TEXT,                           -- Shopify GraphQL ID (gid://shopify/DiscountCodeNode/...)
  discount_value           INTEGER NOT NULL DEFAULT 500,
  discount_currency        TEXT NOT NULL DEFAULT 'JPY',
  issued_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at               TEXT,                           -- coupon 有効期限 (NULL = 無期限)
  redeemed_at              TEXT,                           -- 使用時刻 (将来 orders webhook で更新)
  status                   TEXT NOT NULL DEFAULT 'issued'
                           CHECK (status IN ('issued', 'redeemed', 'expired', 'revoked')),
  line_account_id          TEXT,
  metadata                 TEXT,                           -- JSON (Shopify API response の subset 等)
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE SET NULL,
  -- 連携特典は 1 friend につき生涯 1 枚 = 冪等キー (再連携で 2 枚目は出ない)
  UNIQUE (friend_id)
);

CREATE INDEX IF NOT EXISTS idx_line_link_coupons_code
  ON line_link_coupons(coupon_code);
CREATE INDEX IF NOT EXISTS idx_line_link_coupons_customer
  ON line_link_coupons(shopify_customer_id);
