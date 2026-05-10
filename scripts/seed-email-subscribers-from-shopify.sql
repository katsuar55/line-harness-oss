-- ============================================================
-- email_subscribers seed: Shopify customers の opt-in 同意済者をインポート
-- ============================================================
--
-- 前提:
--   - shopify-customer-sync が enrichment 版で 1 回以上走っていること (metadata に opt-in 情報が保存済)
--   - shopify_customers.metadata に json_extract で email_marketing_consent.state を取得可能
--
-- 実行タイミング:
--   - Katsu レビュー + 承認後
--   - 本番 D1 で `wrangler d1 execute naturism-line-crm --remote --file=scripts/seed-email-subscribers-from-shopify.sql`
--   - 冪等性: email_subscribers のユニーク制約 (idx_email_subscribers_email) で email 重複は INSERT OR IGNORE で skip
--
-- 抽出条件:
--   - email IS NOT NULL AND email != ''
--   - email_marketing_consent.state = 'subscribed' (opt-in 同意済者のみ)
--
-- consent_source:
--   - 'shopify_marketing_consent' (Shopify Admin で同意取得済み = 特定電子メール法準拠)
--
-- friend_id:
--   - shopify_customers.friend_id を引き継ぐ (LINE 友だち連携済の場合のみ)
--
-- consent_at:
--   - email_marketing_consent.consent_updated_at が存在する場合はそれを採用
--   - なければ現在時刻 (sync 時点) を採用
-- ============================================================

-- まず Dry-run: 何件が import 対象になるか確認 (実行はせず確認のみ)
-- SELECT COUNT(*) AS import_candidates
-- FROM shopify_customers sc
-- WHERE sc.email IS NOT NULL
--   AND sc.email != ''
--   AND json_extract(sc.metadata, '$.email_marketing_consent.state') = 'subscribed'
--   AND NOT EXISTS (
--     SELECT 1 FROM email_subscribers es WHERE es.email = sc.email
--   );

-- 本実行: subscribed の Shopify customers を email_subscribers へ INSERT
INSERT OR IGNORE INTO email_subscribers (
  id,
  friend_id,
  email,
  is_active,
  transactional_only,
  consent_source,
  consent_at,
  created_at,
  updated_at
)
SELECT
  -- D1 SQLite では UUID を直接生成できないため、 hex(randomblob(16)) で擬似 UUID v4 形式を作る
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ) AS id,
  sc.friend_id AS friend_id,
  sc.email AS email,
  1 AS is_active,
  0 AS transactional_only,
  'shopify_marketing_consent' AS consent_source,
  COALESCE(
    json_extract(sc.metadata, '$.email_marketing_consent.consent_updated_at'),
    strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
  ) AS consent_at,
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') AS created_at,
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') AS updated_at
FROM shopify_customers sc
WHERE sc.email IS NOT NULL
  AND sc.email != ''
  AND json_extract(sc.metadata, '$.email_marketing_consent.state') = 'subscribed'
  AND NOT EXISTS (
    SELECT 1 FROM email_subscribers es WHERE es.email = sc.email
  );

-- 結果確認: 何件インポートされたか
SELECT COUNT(*) AS total_subscribers FROM email_subscribers;
SELECT consent_source, COUNT(*) AS n FROM email_subscribers GROUP BY consent_source;
