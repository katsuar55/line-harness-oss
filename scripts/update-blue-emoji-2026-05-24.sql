-- auto_replies の Blue emoji 💙 → 🩵 一括置換 (Plan B、 2026-05-24)
--
-- 背景:
--   user 指摘「Blue ♡ icon が本物の青で違和感、 naturism Blue (= ティファニーブルー) に変更したい」。
--   seed-naturism-faq-v2.sql で apply 済の auto_replies 全 row の response_content 内
--   💙 (= U+1F499 Dark Blue Heart) を 🩵 (= U+1FA75 Light Blue Heart) に置換する。
--
-- 影響範囲 (seed-naturism-faq-v2.sql 参照):
--   - 飲み方 ('飲み方ガイド' text)
--   - ドンキ (店舗案内)
--   - 違い (3 種類の違い)
--   - アレルギー
--   - 価格 (= 2 箇所、 「Blue:」 と「VP Blue ¥6,415」)
--   - 成分
--
-- Premium 🩶 と Pink 💗 は user 指示で据置 (= 触らない)。
--
-- 適用方法:
--   PowerShell から (= Bash の cd && は 7403 trap、 PowerShell の Set-Location 推奨):
--   Set-Location apps/worker
--   npx wrangler d1 execute naturism-line-crm --remote --file ..\..\scripts\update-blue-emoji-2026-05-24.sql

UPDATE auto_replies
SET response_content = REPLACE(response_content, '💙', '🩵')
WHERE response_content LIKE '%💙%' AND is_active = 1;

-- 確認 query (= apply 後に実行推奨):
--   SELECT keyword, substr(response_content, 1, 80) AS preview
--   FROM auto_replies
--   WHERE is_active = 1 AND (response_content LIKE '%🩵%' OR response_content LIKE '%💙%');
