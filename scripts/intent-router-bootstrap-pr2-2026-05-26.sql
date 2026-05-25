-- ULTRATHINK fix PR 2 (2026-05-26): 「違い」 auto_replies deactivate (= intent-router に移譲)
--
-- 背景:
--   user 検証 Step 7 で「3 種類の違いは？」 → text 形式回答 = 見栄え悪い
--   → intent-router の新 intent 'product_compare' で welcome-postback の buildProductCompareFlex を再利用
--   → auto_replies の「違い」 row (= text response_type) を deactivate して intent-router に prioritize
--
-- 「マイクーポン」 等は auto_replies に元々無いので影響なし (= intent-router 直接処理)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\intent-router-bootstrap-pr2-2026-05-26.sql

UPDATE auto_replies SET is_active = 0 WHERE keyword IN ('違い', '3 種類の違い', '3種類の違い', '比較') AND is_active = 1;
