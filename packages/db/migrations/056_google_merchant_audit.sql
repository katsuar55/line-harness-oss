-- Migration 056: google_merchant_audit + product_audit_issues (= LP launch blocker fix、 2026-05-27)
--
-- 目的:
--   Shopify-Google Merchant Center の 12/12 商品 Limited 状態を解消するための
--   audit + 自動修復 基盤。 薬機法 NG keyword scan + required field (= GPC /
--   identifier_exists / brand) 一括 set + 結果を D1 に保管。
--
-- 関連 (= 前セッション分析):
--   - スクショ確認結果: Merchant Center で Approved 0、 Limited 12、 全商品で
--     共通 attribute (= GTIN / GPC / 薬機法) 問題が疑われる
--   - 既存 shopify-token.ts で getShopifyAccessToken() が動作 (= shpca_ token 38 char cache)
--   - Shopify scope: read_products / write_products / read_inventory 完備
--   - API version: 2026-04 (= shopify-coupon-issuer.ts 等と統一)
--
-- schema:
--   1. google_merchant_audit_runs (= run 単位の集計、 cron 履歴)
--   2. product_audit_issues (= product × issue の詳細、 run 単位で記録)
--
-- 適用方法 (= cwd: apps/worker、 d1_migrations state drift trap 回避):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\packages\db\migrations\056_google_merchant_audit.sql

-- ============================================================
-- 1. google_merchant_audit_runs (= audit 実行履歴の summary)
-- ============================================================

CREATE TABLE IF NOT EXISTS google_merchant_audit_runs (
  id                  TEXT PRIMARY KEY,
  run_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  trigger             TEXT NOT NULL,            -- 'cron' / 'manual' / 'admin-ui'
  status              TEXT NOT NULL,            -- 'success' / 'partial' / 'error'
  total_products      INTEGER NOT NULL DEFAULT 0,
  products_with_issues INTEGER NOT NULL DEFAULT 0,
  high_severity_count INTEGER NOT NULL DEFAULT 0,
  medium_severity_count INTEGER NOT NULL DEFAULT 0,
  low_severity_count  INTEGER NOT NULL DEFAULT 0,
  issues_by_category  TEXT,                     -- JSON: { ng_keyword: 3, missing_gtin: 12, ... }
  duration_ms         INTEGER,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_gma_runs_at
  ON google_merchant_audit_runs(run_at DESC);

CREATE INDEX IF NOT EXISTS idx_gma_runs_status
  ON google_merchant_audit_runs(status, run_at DESC);

-- ============================================================
-- 2. product_audit_issues (= product × issue の明細、 直近 run のみ retain)
-- ============================================================

CREATE TABLE IF NOT EXISTS product_audit_issues (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,            -- google_merchant_audit_runs.id
  shopify_product_id  TEXT NOT NULL,            -- gid://shopify/Product/123
  product_title       TEXT NOT NULL,
  product_handle      TEXT,
  category            TEXT NOT NULL,            -- 'ng_keyword' / 'missing_gtin' / 'missing_gpc' / 'missing_brand' / 'image_overlay_suspected' / 'price_inconsistency' / 'inventory_zero' / 'missing_description'
  severity            TEXT NOT NULL,            -- 'high' / 'medium' / 'low'
  field               TEXT,                     -- 'title' / 'description' / 'metafield.google.identifier_exists' / etc.
  original_value      TEXT,                     -- before fix
  suggested_value     TEXT,                     -- recommended fix
  applied             INTEGER NOT NULL DEFAULT 0, -- 0 = pending, 1 = applied
  applied_at          TEXT,
  applied_by          TEXT,                     -- 'auto' / 'admin-ui' / user-id
  metadata            TEXT,                     -- JSON for extra context (= ng_pattern matched, etc.)
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_pai_run
  ON product_audit_issues(run_id, severity);

CREATE INDEX IF NOT EXISTS idx_pai_product
  ON product_audit_issues(shopify_product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pai_pending
  ON product_audit_issues(severity, created_at DESC)
  WHERE applied = 0;

CREATE INDEX IF NOT EXISTS idx_pai_category
  ON product_audit_issues(category, severity);
