-- Migration 068: line_referral_coupons — 友だち紹介の両側実クーポン台帳 (2026-07-10)
--
-- 背景:
--   紹介機能は claim (POST /api/liff/referral/claim) で referral_rewards を作るが、
--   クーポンは referral_coupons テンプレ + shopify_coupon_assignments に「偽コード」
--   (Shopify 未作成 = 使えない) を書くだけで、通知も無く、両側とも claim 時に即発行
--   していた。 本 migration + 紹介クーポン完成 PR で:
--     - referred = claim (友だち追加→ポータル ?ref) 時に即時 ¥500 実クーポン発行
--     - referrer = referred が購入して初めて ¥500 実クーポン発行 + LINE push
--   を、 welcome クーポンと同じ Shopify discountCodeBasicCreate 経路 (実発行) で行う。
--
-- なぜ line_friend_coupons を再利用せず別テーブルか:
--   line_friend_coupons.friend_id は列レベル UNIQUE (migration 050)。 welcome を受給済の
--   friend に 2 枚目 (紹介) を発行するには複合 UNIQUE 化が必要だが、 SQLite/D1 は列レベル
--   UNIQUE を ALTER で外せずテーブル再構築 (DROP TABLE) = 破壊的 migration になる。 かつ
--   welcome 発行経路 (findExistingCoupon/getCouponCodeForFriend) を source-aware に変える
--   必要があり、 列未追加のまま deploy すると全 follow で welcome 発行がクラッシュする。
--   → additive な別テーブルにすれば非破壊 + welcome 経路無改変 + deploy 順序ハザード無。
--
-- 設計:
--   - UNIQUE(friend_id, role) で friend × 役割ごとに 1 枚 (= 冪等キー)。 referrer は生涯 1 枚
--     (= 既知の MVP 制約。 refer 多数でも referral coupon は 1 枚)。
--   - status enum で issued / redeemed / expired / revoked ライフサイクル。
--   - reward_id で referral_rewards.id を弱リンク (FK は張らず、 削除時の連鎖を避け柔軟に)。
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
  friend_id                TEXT NOT NULL,
  reward_id                TEXT,                           -- referral_rewards.id (弱リンク)
  role                     TEXT NOT NULL
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
  UNIQUE (friend_id, role)
);

CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_friend
  ON line_referral_coupons(friend_id);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_code
  ON line_referral_coupons(coupon_code);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_reward
  ON line_referral_coupons(reward_id);
CREATE INDEX IF NOT EXISTS idx_line_referral_coupons_status
  ON line_referral_coupons(status, issued_at DESC);
