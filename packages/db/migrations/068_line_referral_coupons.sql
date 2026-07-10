-- Migration 068: line_referral_coupons — 友だち紹介の両側実クーポン台帳 (2026-07-10)
--
-- 背景 (確定仕様 2026-07-10):
--   - referred (紹介された側) の ¥500 = 「友だち追加 welcome クーポン」(= 別途の紹介クーポンは
--     発行しない。 referred は ¥500 一枚)。 welcome は 7 日有効・1 アカウント1回・新規ユーザー限定。
--   - referrer (紹介した側) = referred がその welcome クーポンを「利用して購入」するたびに ¥500 実
--     クーポンを 1 枚獲得 (= 何度でも紹介でき、 成立ごとに 1 枚)。 本テーブルは referrer の獲得
--     クーポン専用台帳 (referred は line_friend_coupons の welcome を使う)。
--   発行は welcome と同じ Shopify discountCodeBasicCreate 経路 (実発行) で行う。
--
-- なぜ line_friend_coupons を再利用せず別テーブルか:
--   line_friend_coupons.friend_id は列レベル UNIQUE (migration 050) で referrer が複数の獲得
--   クーポンを持てない。 追加種別を additive な別テーブルにすれば非破壊 + welcome 経路無改変 +
--   deploy 順序ハザード無 (= 破壊的 rebuild 回避)。
--
-- 設計:
--   - UNIQUE(reward_id) で「紹介成立1件につき referrer クーポン1枚」= 冪等キー。 friend_id では
--     UNIQUE にしない (= referrer は複数の reward で複数クーポンを持てる = 無制限紹介に対応)。
--   - status enum で issued / redeemed / expired / revoked ライフサイクル。
--   - reward_id は referral_rewards.id (FK は張らず柔軟に、 だが NOT NULL の冪等キー)。
--   - issued_at/expires_at は発行 service が explicit UTC ISO ('Z') で書く (line_friend_coupons と
--     同じ TZ 規約。 表示 read も new Date().toISOString() (UTC) で比較するため整合)。
--   - line_account_id (NULL 可、 multi-tenant 対応)。
--
-- 適用 (cwd: apps/worker、 非破壊 = 破壊的承認ルール非該当):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\068_line_referral_coupons.sql
--   ※ この端末は wrangler 未認証 → Katsu wrangler or Admin Ops workflow で適用。
--     gate REFERRAL_REWARD_ENABLED (既定 off) のため、 適用前に code を deploy しても本番無害。

CREATE TABLE IF NOT EXISTS line_referral_coupons (
  id                       TEXT PRIMARY KEY,
  friend_id                TEXT NOT NULL,                   -- referrer (= 紹介した側、 報酬クーポンの所有者)
  reward_id                TEXT NOT NULL,                   -- referral_rewards.id (= 紹介成立1件。 冪等キー)
  role                     TEXT NOT NULL DEFAULT 'referrer'
                           CHECK (role IN ('referrer', 'referred')),
  coupon_code              TEXT NOT NULL,                  -- Shopify で発行された code
  shopify_discount_code_id TEXT,                           -- Shopify GraphQL ID (gid://shopify/DiscountCodeNode/...)
  discount_value           INTEGER NOT NULL DEFAULT 500,
  discount_currency        TEXT NOT NULL DEFAULT 'JPY',
  issued_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at               TEXT,                            -- coupon 有効期限 (NULL = 無期限)
  redeemed_at              TEXT,                            -- 使用時刻 (将来 orders webhook で更新)
  status                   TEXT NOT NULL DEFAULT 'issued'
                           CHECK (status IN ('issued', 'redeemed', 'expired', 'revoked')),
  line_account_id          TEXT,
  metadata                 TEXT,                            -- JSON (Shopify API response の subset 等)
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id) ON DELETE SET NULL,
  -- 紹介成立 (referral_rewards) 1 件につき referrer クーポン 1 枚 = 冪等キー。
  -- referrer は「何度でも紹介でき、 紹介先が購入するたびに ¥500」= friend_id では UNIQUE にしない
  -- (= 1 referrer が複数の reward で複数クーポンを持てる)。
  UNIQUE (reward_id)
);

CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_friend
  ON line_referral_coupons(friend_id);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_code
  ON line_referral_coupons(coupon_code);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_reward
  ON line_referral_coupons(reward_id);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_status
  ON line_referral_coupons(status, issued_at DESC);
