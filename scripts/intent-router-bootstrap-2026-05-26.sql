-- ULTRATHINK fix (2026-05-26): intent-router 導入に伴う auto_replies 整理
--
-- 背景:
--   user 検証で「価格」 単独 keyword → text 形式の旧 auto_replies で返答 = user は grid flex 希望
--   → 旧 「価格」 auto_replies を deactivate、 intent-router (= keyword 検出 → grid flex) に移譲
--
-- 影響:
--   - 「価格」 単独 / 「価格教えて」 / 「値段」 / 「料金」 等 → intent-router で price_table flex
--   - 「飲み方」 「違い」 「成分」 「アレルギー」 「ドンキ」 「妊娠」 「賞味期限」 「Kep1er」 「ヴィーガン」 「国産」
--     等は引き続き auto_replies (= seed-naturism-faq-v2.sql 由来) で text 返答 (= 既存挙動維持)
--
-- 適用方法 (= cwd: apps/worker):
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\intent-router-bootstrap-2026-05-26.sql

-- 旧「価格」 auto_replies を deactivate (= intent-router に移譲)
UPDATE auto_replies SET is_active = 0 WHERE keyword = '価格' AND is_active = 1;

-- 念のため keyword='料金' '値段' で text 返答する row があれば deactivate (= intent-router 優先)
UPDATE auto_replies SET is_active = 0 WHERE keyword IN ('料金', '値段') AND is_active = 1;
