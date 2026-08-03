-- naturism FAQ v4: 商品ファクト系 (違い/アレルギー/成分) を公式サイトの単一真実に合わせて修正
-- 2026-08-03
--
-- 背景: v2 で投入した auto_replies のうち 違い / アレルギー / 成分 の3件が、
--   2026-08-03 に公式サイト側で是正した内容と矛盾したまま本番 D1 で有効だった。
--   auto_replies は intent-router / AI 応答より優先して返るため、
--   ソース(ai-response.ts / faq-context.ts)を直すだけでは本番の回答は変わらない。
--
-- 直す内容 (すべて公式PDPの原材料表示・/pages/faq・/pages/compare で実測して裏取り済):
--   1) 成分数        … Blue 8 → 9 (玄米外皮・胚芽加工食品が抜けていた)。Pink 10 / Premium 16 は据置
--   2) 包含関係の誤り … 「Pink = Blue + 酵素」ではない。Blue から玄米外皮・胚芽を除いて2成分追加で10。
--                      Premium は Pink から植物発酵乾燥粉末を除いて7成分追加で16
--   3) アレルゲン    … Pink と Premium を同一扱いしていた。実ラベルは Pink=7品目 / Premium=大豆 /
--                      Blue=特定原材料8品目・推奨表示20品目の使用なし (/pages/faq と同一文言に統一)
--   4) 薬機法        … 「脂質カット特化」「糖質カット最強」は一般食品(Blue/Pink)への機能表示のため削除
--   5) 撤回済み表現  … 「全商品100%天然由来」(原材料にショ糖脂肪酸エステル等を含むため不成立)、
--                      「人工甘味料・マスキング香料は不使用」(消費者庁「食品添加物の不使用表示に関する
--                      ガイドライン」類型2: 人工/合成/化学/天然の語を用いた不使用表示は不適切)
--   6) 「活きた酵素360mg」… Pink の成分表に無い数値のため削除
--
-- ⚠️ apply は 1 回のみ (再実行すると新行も無効化され重複が増える)。
--    v3 と同じ非破壊パターン: 旧行を is_active=0 にしてから新行を INSERT する (DELETE は使わない)。

-- ── 1. 旧・商品ファクト系 auto_replies を無効化 (重複行も全て対象) ──
--   ヴィーガン: 「天然由来成分のみ」「動物性原料は一切使用しておりません」と断定していた。
--     原材料にショ糖脂肪酸エステル等を含み、Premium の乳酸菌発酵物末は培地の確認が要るため断定できない。
--   Kep1er: 「ドン・キホーテでは限定フォトカードキャンペーンも実施中！」が、終了済み販促を
--     現在進行形で告知していた (サイト横断+ブログ全104記事の実測で痕跡0件)。景表法リスク。
UPDATE auto_replies SET is_active = 0
 WHERE keyword IN ('違い', 'アレルギー', '成分', 'ヴィーガン', 'Kep1er');

-- ── 2. 公式サイト準拠の新しい商品ファクト FAQ を INSERT ──

-- 違い・比較 (keyword: 違い)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '違い', 'contains', 'text',
 '【3種類の違い】🌿

🩵 Blue（9成分）
食事の脂質・糖質が気になる方の基盤モデル。1日¥64〜

💗 Pink（10成分）
Blueから玄米外皮・胚芽加工食品を除き、穀物麹（活きた酵素）と植物発酵乾燥粉末を加えたモデル。美容も気になる方へ。1日¥75〜

🩶 Premium（16成分）★機能性表示食品（届出番号 H975）
シリーズ最高峰。1日¥149〜

迷ったらまずBlueのお試しからがおすすめです😊', 1);

-- アレルギー (keyword: アレルギー)
-- 文言は /pages/faq「アレルギー成分は含まれますか？」と同一 (theme-dawn/templates/page.faq.json)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'アレルギー', 'contains', 'text',
 '⚠️ アレルギー情報

💗 Pink
オレンジ、キウイフルーツ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ

🩶 Premium
大豆

🩵 Blue
特定原材料8品目・推奨表示20品目は使用していません（製造工程上の混入の可能性は否定できません）

いずれも詳しくは商品パッケージの原材料表示をご確認ください🙏', 1);

-- 成分 (keyword: 成分)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '成分', 'contains', 'text',
 '🌿 国内製造。香料・着色料・保存料は使用していません

🩵 Blue（9成分）
玄米外皮・胚芽加工食品、ウーロン茶ポリフェノール、アロエベラ、L-カルニチン、サンザシ、ケイシ、イヌリン、アマチャヅル、デキストリン

💗 Pink（10成分）
Blueから玄米外皮・胚芽加工食品を除き、穀物麹（活きた酵素）と植物発酵乾燥粉末を追加

🩶 Premium（16成分）
Pinkから植物発酵乾燥粉末を除き、サラシア、白インゲン豆、ブラックジンジャー、コンブチャ（発酵紅茶）、ヨクイニン、乳酸菌、パパイヤ酵素を追加

機能性関与成分（Premium）: ブラックジンジャー由来ポリメトキシフラボン 12mg', 1);

-- ヴィーガン (keyword: ヴィーガン)
-- 断定を避け、確認できる事実のみを返す。ヴィーガン認証は取得していない。
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'ヴィーガン', 'contains', 'text',
 '🌱 原材料表示に動物性原料の記載はございません。

ただしヴィーガン認証は取得しておらず、製造工程や原料の培地までは保証しかねます。
厳密にご確認が必要な場合は、各商品ページの原材料表示をご覧いただくか、お問い合わせください🙏', 1);

-- Kep1er (keyword: Kep1er)
-- 終了済み販促の告知を削除し、ブランドミューズの事実のみ残す。
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'Kep1er', 'contains', 'text',
 'Kep1er（ケプラー）は2025年7月よりnaturism初の公式ブランドミューズです🌟

実施中のキャンペーンは公式ストアの最新情報をご確認ください💗', 1);

-- ── 3. auto_replies 以外の user-visible な D1 データ ──
--   ソースを直しても D1 の行が優先/直接表示されるため、同じファクトを持つ以下も揃える。

-- 3-1. 定期リマインドのクロスセル理由文 (subscription-reminder.ts が Flex にそのまま出す)
--      migration 045_phase6_seed.sql 由来。Blue は 9成分 / 「酵素360mg」は成分表に無い数値。
UPDATE purchase_cross_sell_map SET reason = replace(reason, '8成分のシンプル定番ライン', '9成分のシンプル定番ライン')
 WHERE reason LIKE '%8成分のシンプル定番ライン%';
UPDATE purchase_cross_sell_map SET reason = replace(reason, '酵素360mgと食物繊維', '活きた酵素と食物繊維')
 WHERE reason LIKE '%酵素360mgと食物繊維%';

-- 3-2. 友だち追加シナリオ (webhook.ts の friend_add で enrollFriendInScenario される)
--      scripts/welcome-scenario-v2-2026-05-24.sql 由来。Blue の成分数と Pink の構成説明。
UPDATE scenario_steps SET message_content = replace(message_content, '8 成分配合、 1日¥64〜', '9 成分配合、 1日¥64〜')
 WHERE message_content LIKE '%8 成分配合、 1日¥64〜%';
UPDATE scenario_steps SET message_content = replace(message_content, 'Blue ＋活きた酵素配合。', 'Blue から玄米外皮・胚芽を除き活きた酵素を配合。')
 WHERE message_content LIKE '%Blue ＋活きた酵素配合。%';

-- 3-3. 届出範囲外の機能表示 (H975 の届出機能は「腹部の脂肪」であって「糖質ケア」ではない)
--      purchase_cross_sell_map / nutrition_sku_map は定期リマインド等でそのまま表示される。
UPDATE purchase_cross_sell_map SET reason = replace(reason, '16成分の機能性表示食品で糖質ケアも一緒に', '全16成分のシリーズ最高峰')
 WHERE reason LIKE '%16成分の機能性表示食品で糖質ケアも一緒に%';
UPDATE purchase_cross_sell_map SET reason = replace(reason, '16成分の機能性表示食品で糖質ケアも', '全16成分のシリーズ最高峰')
 WHERE reason LIKE '%16成分の機能性表示食品で糖質ケアも%';
UPDATE nutrition_sku_map SET copy_template = replace(copy_template, '糖質対応の機能性表示食品で食事ケアに', '全16成分のシリーズ最高峰で食事ケアに')
 WHERE copy_template LIKE '%糖質対応の機能性表示食品で食事ケアに%';
