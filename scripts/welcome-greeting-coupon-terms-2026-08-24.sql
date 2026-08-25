-- 友だち追加の挨拶 (scenario_steps) のクーポン表記を実装に合わせる (2026-08-24)
--
-- 背景:
--   友だち追加の挨拶は**コードではなく D1 のデータ** (scenarios / scenario_steps) にあるため、
--   コード側の文言掃き出し (commit a07eb2b 以降) の対象外だった。本番実測で 2 か所ズレていた:
--     ① 「naturism-diet.com で 3 日間 ご利用可」 → 実際は 7 日 (follow は validDays:7 で発行)
--     ② 最低購入 ¥2,000 の記載が無い (全券に付いているのに、顧客が読むこの面に書かれていない)
--   なお「🎁 友だち限定 500 円 OFF クーポン」の額は、welcome を ¥500 へ戻したので**正しい**。
--
-- 性質:
--   - UPDATE のみ (DROP / DELETE なし)
--   - replace() による部分置換 + WHERE の LIKE ガードで**冪等** (2 回流しても 2 重置換されない)
--   - 対象は friend_add シナリオの step 0 の 1 行のみ
--
-- 実行前の確認 (現物を見てから流すこと):
--   npx wrangler d1 execute naturism-line-crm --remote --json \
--     --command "SELECT id, substr(message_content, instr(message_content, '3 日間') - 40, 120) AS around \
--                FROM scenario_steps WHERE id = 'nw-step-0'"
--
-- 実行後の確認:
--   npx wrangler d1 execute naturism-line-crm --remote --json \
--     --command "SELECT (message_content LIKE '%7 日間 ご利用可%') AS fixed, \
--                       (message_content LIKE '%2,000 以上のご注文%') AS has_terms \
--                FROM scenario_steps WHERE id = 'nw-step-0'"
--   → fixed = 1 / has_terms = 1 になること。
--   ⚠️ 反映は**次に友だち追加した人から**。既に受け取った人の履歴は書き換わらない。

UPDATE scenario_steps
   SET message_content = replace(
         message_content,
         'naturism-diet.com で 3 日間 ご利用可',
         'naturism-diet.com で 7 日間 ご利用可 / ¥2,000 以上のご注文で'
       )
 WHERE id = 'nw-step-0'
   AND message_content LIKE '%naturism-diet.com で 3 日間 ご利用可%';
