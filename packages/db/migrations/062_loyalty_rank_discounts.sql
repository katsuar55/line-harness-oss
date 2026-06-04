-- Migration 062: loyalty_rank_discounts table (= 自社内製ロイヤリティ ランク割引発行, 2026-06-04 PR5-5a)
--
-- 目的:
--   会員ランクに応じた「常時%OFF」割引を、 顧客別 Shopify コード (NLR-{rank}-{suffix}) で発行・記録する。
--   3タップ単発購入 (cart permalink ?discount={code}) で利用。 A2 クロスクラス前提で
--   combinesWith product+order true で発行 (= 将来のサブスク併用 13% スタッキングに備える)。
--
-- design:
--   - friend ごとに status='active' は最大1行 (= 現ランクの割引)。 ランク変更時は旧を superseded 化 + 新規 issue。
--   - code は NLR- prefix (= cb-admin 感謝クーポンと衝突しない namespace)。
--   - discount_percent = 2/4/6/8 (= regular 0% は割引コード発行しない)。
--   - 本番発行は env RANK_DISCOUNT_ENABLED='true' でのみ実行 (= 承認後に有効化、 default off で本番未書込)。
--
-- 関連:
--   - apps/worker/src/services/rank-discount-issuer.ts (= 発行サービス、 discountCodeBasicCreate)
--   - packages/db/src/loyalty-rank-discount.ts (= 本 table の CRUD)
--   - packages/db/src/loyalty-rank.ts (= rank 判定、 discount_percent の源)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\062_loyalty_rank_discounts.sql

CREATE TABLE IF NOT EXISTS loyalty_rank_discounts (
  id                       TEXT PRIMARY KEY,
  friend_id                TEXT NOT NULL,                   -- friends.id
  rank_id                  TEXT NOT NULL,                   -- bronze/silver/gold/platinum (= regular は発行しない)
  code                     TEXT NOT NULL UNIQUE,            -- NLR-{RANK}-{suffix}
  shopify_discount_node_id TEXT,                            -- gid://shopify/DiscountCodeNode/...
  discount_percent         INTEGER NOT NULL DEFAULT 0,      -- 2/4/6/8
  status                   TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  brand_id                 TEXT,                            -- multi-brand (= NULL は naturism default)
  issued_at                TEXT NOT NULL,                   -- 発行時刻 (JST ISO)
  expires_at               TEXT,                            -- NULL=無期限 (= 既定は ~45日で再発行)
  superseded_at            TEXT,                            -- supersede 時刻
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- friend の active 割引を高速取得 (= 冪等チェック + 5b cart permalink)
CREATE INDEX IF NOT EXISTS idx_loyalty_rank_discounts_friend_status
  ON loyalty_rank_discounts(friend_id, status);

-- code から逆引き (= 将来 orders/paid で利用検知・失効処理)
CREATE INDEX IF NOT EXISTS idx_loyalty_rank_discounts_code
  ON loyalty_rank_discounts(code);
