-- naturism FAQ拡充 v2: ナレッジ完全版に基づく追加FAQ
-- 既存9件に加え、よくある質問を追加
-- match_type = 'contains' で部分一致

-- 飲み方を正確な情報に更新（既存レコードを無効化→新規追加）
UPDATE auto_replies SET is_active = 0 WHERE keyword = '飲み方';

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '飲み方', 'contains', 'text',
 '【飲み方ガイド】🌿

💙 Blue・💗Pink
1回2〜3粒、1日6〜9粒
食事中または食直後に水かぬるま湯で😊

🩶 Premium
1回3〜4粒、1日3回合計9粒
食事の直前に水かぬるま湯で✨

💡 軽い食事の時は−1粒、脂っこい食事は+1粒で調整できます！噛まずにお飲みください', 1);

-- ドンキ・店舗
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'ドンキ', 'contains', 'text',
 'はい！2025年7月より全国のドン・キホーテで販売中です🎉
3日分・7日分・30日分の各サイズをお取り扱いしています。
Blue💙・Pink💗・Premium🩶の3種類すべてございます✨', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'どこで買え', 'contains', 'text',
 'naturismはこちらでお求めいただけます🛍️

🛒 オンライン
・公式ストア（naturism-diet.com）
・楽天市場（健康エクスプレス）
・Amazon / Yahoo!ショッピング

🏪 実店舗
・ドン・キホーテ（全国）
・Cosme Kitchen / Biople
・AEON Body / 15/e organic

公式ストアは24時間ご注文可能です✨', 1);

-- 違い・比較
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '違い', 'contains', 'text',
 '【3種類の違い】🌿

💙 Blue（8成分）
脂質カット特化。1日¥64〜

💗 Pink（10成分）
Blue＋活きた酵素。美容にも。1日¥75〜

🩶 Premium（16成分）★機能性表示食品
全部入り。糖質カット最強。1日¥149〜

迷ったらまずBlueのお試しからがおすすめです😊', 1);

-- アレルギー
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'アレルギー', 'contains', 'text',
 '⚠️ アレルギー情報

💗 Pink・🩶 Premiumに含まれるアレルギー物質:
オレンジ、キウイフルーツ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ

💙 Blueには上記アレルゲンは含まれていません。
詳しくは商品パッケージの原材料表示をご確認ください🙏', 1);

-- 価格
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '価格', 'contains', 'text',
 '【価格一覧（税込）】💰

💙 Blue: ¥100〜¥6,415
💗 Pink: ¥121〜¥7,538
🩶 Premium: ¥720〜¥14,904

おトクなバリューパック（100日分）なら
💙 ¥6,415（1日約¥64）
💗 ¥7,538（1日約¥75）
🩶 ¥14,904（1日約¥149）

5,500円以上で送料無料です🎁', 1);

-- 成分
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '成分', 'contains', 'text',
 '🌿 全商品100%天然由来・国内製造です

💙 Blue（8成分）
ウーロン茶ポリフェノール、アロエベラ、L-カルニチン、サンザシ、ケイシ、イヌリン、アマチャヅル、デキストリン

💗 Pink: Blue＋穀物麹（活きた酵素360mg）
🩶 Premium: Pink＋サラシア、白インゲン豆、ブラックジンジャー、コンブチャ、ヨクイニン、乳酸菌、パパイヤ酵素（全16成分）

人工甘味料・マスキング香料は不使用です✨', 1);

-- 妊娠中
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '妊娠', 'contains', 'text',
 '妊娠中・授乳中の方は、かかりつけの医師にご相談の上でご使用をご検討ください🙏
お体の状態に合わせたアドバイスは医師が最適です。
ご不明な点がありましたらお気軽にお問い合わせください😊
📩 info@kenkoex.com', 1);

-- 賞味期限
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '賞味期限', 'contains', 'text',
 '賞味期限は製造から約30ヶ月です📅
パッケージに記載されていますのでご確認ください。
保存は高温多湿・直射日光を避けて涼しい場所でお願いします🙏', 1);

-- Kep1er
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'Kep1er', 'contains', 'text',
 'Kep1er（ケプラー）は2025年7月よりnaturism初の公式ブランドミューズです🌟
ドン・キホーテでは限定フォトカードキャンペーンも実施中！
メンバーも実際にnaturismを愛用してくれています💗', 1);

-- ヴィーガン
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'ヴィーガン', 'contains', 'text',
 'はい！naturismは全商品ヴィーガン・ベジタリアン対応です🌱
天然由来成分のみで作られており、動物性原料は一切使用しておりません✨', 1);

-- 国産
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '国産', 'contains', 'text',
 'はい！すべて日本国内のGMP対応工場で製造しています🇯🇵
日本健康・栄養食品協会認定。ロットごとに試験成績書を発行し、品質管理を徹底しています✨', 1);
