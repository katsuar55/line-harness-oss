-- ============================================================
-- Migration 047: brand_config + line_accounts.industry + email_templates.brand_id
--
-- 目的 (Phase 5α-9 / Ultraplan v4 大方針 2 「汎用性 multi-brand」):
--   - 業種非依存コア + 業種プラグイン設計の最小基盤を作る
--   - email_templates / scenarios / 各種文言の "naturism" hardcode を brand 変数化可能にする
--   - 将来 Phase 5κ で plugin 切出し時のテーブル変更を不要にする
--
-- 設計方針:
--   - brand_config に「default brand」 1 行 (line_account_id NULL, is_default=1) を保証
--     → 既存 5 templates (brand_id NULL) は default brand を使う
--   - 将来 multi-brand 運用時は line_account_id を指定して brand_config row 追加
--   - email_templates.brand_id NULL = default brand (= naturism) で後方互換
--
-- 関連:
--   - scripts/migrate-templates-to-brand-vars.mjs: 既存テンプレ text 列の REPLACE migrate
--   - apps/worker/src/services/send-email-action.ts: brand 注入機能追加
-- ============================================================

-- 1. line_accounts に industry 列追加
ALTER TABLE line_accounts ADD COLUMN industry TEXT;

-- 2. brand_config table 新規
CREATE TABLE IF NOT EXISTS brand_config (
  id                  TEXT PRIMARY KEY,
  -- NULL = default brand (system-wide fallback)、 値あり = account-specific brand
  line_account_id     TEXT REFERENCES line_accounts(id) ON DELETE CASCADE,
  -- 1 行のみ is_default=1 (UNIQUE WHERE で保証)
  is_default          INTEGER NOT NULL DEFAULT 0,
  -- 表示名 / 法人名 / 連絡先
  brand_name          TEXT NOT NULL,
  company_name        TEXT,
  support_email       TEXT,
  -- ストア URL 系
  shop_url            TEXT,
  subscription_url    TEXT,
  -- 視覚 (LINE 緑系がデフォルト)
  primary_color       TEXT NOT NULL DEFAULT '#06C755',
  -- welcome 等で紹介する代表商品ラベル
  intro_product_label TEXT,
  logo_url            TEXT,
  -- 拡張用 JSON (industry / plan / 業種固有設定 等)
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

-- account 単位で 1 brand (account-specific brand 用)
CREATE INDEX IF NOT EXISTS idx_brand_config_account ON brand_config(line_account_id);

-- default brand は 1 行のみ (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_config_default
  ON brand_config(is_default) WHERE is_default = 1;

-- 3. email_templates に brand_id 列追加 (NULL OK = default brand)
ALTER TABLE email_templates ADD COLUMN brand_id TEXT REFERENCES brand_config(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_templates_brand ON email_templates(brand_id);

-- 4. naturism default brand seed (idempotent)
INSERT INTO brand_config (
  id,
  line_account_id,
  is_default,
  brand_name,
  company_name,
  support_email,
  shop_url,
  subscription_url,
  primary_color,
  intro_product_label,
  metadata
) VALUES (
  'brand-naturism-default',
  NULL,
  1,
  'naturism',
  '株式会社ケンコーエクスプレス',
  'support@naturism-diet.com',
  'https://naturism-diet.com',
  'https://naturism-diet.com/pages/subscription',
  '#06C755',
  'Blue 7日分（42粒）¥696',
  '{"industry":"naturism","plan":"d2c-supplement"}'
)
ON CONFLICT(id) DO UPDATE SET
  brand_name = excluded.brand_name,
  company_name = excluded.company_name,
  support_email = excluded.support_email,
  shop_url = excluded.shop_url,
  subscription_url = excluded.subscription_url,
  primary_color = excluded.primary_color,
  intro_product_label = excluded.intro_product_label,
  metadata = excluded.metadata,
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours');
