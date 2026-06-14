-- naturism FAQ v3: 運用系 (配送/返品/定期/営業時間) を公式ポリシーページ準拠に修正
-- 2026-06-12 (#10-2 / DMM 移行ローンチ)
--
-- 背景: 既存 auto_replies の 送料/返品/返金/解約/営業時間 は、 naturism-diet.com の
--   公式ポリシーページと矛盾する古いファクトを返していた (= DMM 移行で顧客に誤回答する launch blocker)。
--   さらに各キーワードに重複行が存在した。
--   → 該当キーワードの旧行を全て is_active=0 で無効化し、 公式準拠の単一行を再 INSERT する
--     (v2 が「飲み方」で行ったのと同じ非破壊パターン。 DELETE は本番破壊操作のため使わない)。
--
-- 出典 (公式・最終改定 2026-05〜06):
--   /policies/shipping-policy  /policies/refund-policy
--   /policies/subscription-policy  /policies/legal-notice
--
-- ⚠️ apply は 1 回のみ (再実行すると新行も無効化され重複が増える)。 本番投入は Katsu 文面検証後。

-- ── 1. 旧・運用系 auto_replies を無効化 (重複行も全て対象) ──
UPDATE auto_replies SET is_active = 0
 WHERE keyword IN ('送料', '返品', '返金', '解約', '営業時間');

-- ── 2. 公式準拠の新しい運用系 FAQ を INSERT ──

-- 配送・送料 (keyword: 送料 / 配送 / 発送)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '送料', 'contains', 'text',
 '【配送・送料について】🚚

■送料（税込）
・メール便（ゆうパケット）220円 ※7日分〜100日分は送料無料／3日分お試しのみ220円
・宅配便（ヤマト運輸）550円
・商品合計5,500円以上でどの商品でも送料無料（沖縄・離島除く）
・沖縄・離島は宅配便一律1,500円
・定期便のご注文はすべて送料無料✨

■発送
平日12:00までのご注文は原則当日発送（在庫がある場合）😊
12:00以降・土日祝・年末年始は翌営業日発送です。', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '配送', 'contains', 'text',
 '【配送・送料について】🚚

■配送業者
・宅配便＝ヤマト運輸
・メール便＝ゆうパケット（日本郵便）※お届け日時のご指定は不可

■送料（税込）
・メール便220円 ※7日分〜100日分は送料無料
・宅配便550円
・商品合計5,500円以上で送料無料（沖縄・離島除く／離島は一律1,500円）

■発送
平日12:00までのご注文は原則当日発送（在庫がある場合）。12:00以降・土日祝・年末年始は翌営業日発送です😊', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '発送', 'contains', 'text',
 '【発送について】📦
平日12:00までのご注文は原則当日発送いたします（在庫がある場合）😊
12:00以降・土日祝・年末年始のご注文は翌営業日の発送となります。

配送業者は宅配便＝ヤマト運輸、メール便＝ゆうパケット（日本郵便）です。
ゆうパケットはお届け日時のご指定ができませんのでご了承ください🙏', 1);

-- 返品・返金 (keyword: 返品 / 返金)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '返品', 'contains', 'text',
 '【返品・返金について】📦
naturism は食品（健康食品）のため、開封・未開封を問わずお客様都合による返品は原則お受けしておりません🙏

ただし以下は対応いたします:

🎁 全額返金保証（初回購入限定・対象3商品）
ナチュリズム180粒／酵素in ナチュリズム180粒／ナチュリズム プレミアム180粒の初回ご購入に限り、ご満足いただけなければ商品到着後14日以内のご連絡で全額返金いたします（残り商品はご返送・送料お客様負担）。

🔧 不良品・配送破損
商品到着後10日以内のご連絡で、送料当社負担にて交換または全額返金いたします。

📩 info@kenkoex.com ／ 📞 03-6411-5513（平日10:00〜17:00）', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '返金', 'contains', 'text',
 '【全額返金保証について】🎁
対象3商品（ナチュリズム180粒／酵素in ナチュリズム180粒／ナチュリズム プレミアム180粒）の初回ご購入に限り、ご満足いただけなければ全額返金いたします✨

・商品到着後14日以内に info@kenkoex.com までご連絡
・残りの商品をご返送（送料お客様負担）
・返送確認後3〜5営業日で全額返金
・初回購入のみ（2回目以降は対象外）

不良品・配送破損は到着後10日以内のご連絡で、送料当社負担にて交換または全額返金いたします🙏', 1);

-- 定期便 (keyword: 解約 / 定期 / スキップ / 休止)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '解約', 'contains', 'text',
 '【定期便の解約・スキップ・変更】🔄
マイページから24時間いつでも 解約・スキップ・変更 が可能です😊

✅ 最低継続回数の縛りなし（1回目からいつでも解約OK・解約金/違約金/手数料なし）
✅ 全注文 送料無料
✅ 次回お届け予定日・数量・商品・お届け先・お支払いカードを変更可能

操作: マイページ →「注文履歴」→「定期購買一覧」→「詳細の確認」
※出荷準備完了メール送信後は、当該回の変更・キャンセルは承れません（解約・変更は次回お届け分から適用）。お届け3日前に事前案内メールをお送りします。
※会員登録なし（ゲスト購入）の方はカスタマーサポートへご連絡ください。', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '定期便', 'contains', 'text',
 '【定期便について】🔄
✅ マイページから24時間いつでも 解約・スキップ・変更 が可能
✅ 最低継続回数の縛りなし（1回目からいつでも解約OK・解約金なし）
✅ 全注文 送料無料
✅ お届け周期・数量は各商品ページでご指定（初回は注文日から2〜4日でお届け）

操作: マイページ →「注文履歴」→「定期購買一覧」→「詳細の確認」
※出荷準備完了メール送信後は当該回の変更・キャンセル不可（次回お届け分から適用）。お届け3日前に事前案内メールをお送りします😊', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 'スキップ', 'contains', 'text',
 '【定期便のスキップ】🔄
次回のお届けはマイページから24時間いつでもスキップできます😊
マイページ →「注文履歴」→「定期購買一覧」→「詳細の確認」から操作してください。

※出荷準備完了メール送信後は当該回のスキップ・変更は承れません（次回お届け分から適用）。お届け3日前の事前案内メールでお知らせします🙏', 1),
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '休止', 'contains', 'text',
 '【定期便のお休み（スキップ）】🔄
お届けのお休み（スキップ）や周期の変更は、マイページから24時間いつでも可能です😊
マイページ →「注文履歴」→「定期購買一覧」→「詳細の確認」から操作してください。

最低継続回数の縛りはなく、解約も1回目からいつでも可能です（解約金なし）。
※出荷準備完了メール送信後は当該回の変更は承れません（次回お届け分から適用）🙏', 1);

-- 営業時間 / お問い合わせ受付 (keyword: 営業時間)
INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '営業時間', 'contains', 'text',
 '【お問い合わせ受付時間】🕙
平日 10:00〜17:00（土日祝・年末年始を除く）

📞 03-6411-5513
📩 info@kenkoex.com

公式オンラインストア（naturism-diet.com）は24時間ご注文いただけます✨
お問い合わせはお急ぎでなければメールが便利です（順次ご返信いたします）😊', 1);
