-- naturism 初期データ: 自動応答FAQ（Layer 1 キーワードマッチ用）
-- match_type = 'contains' で部分一致を使用

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '送料', 'contains', 'text',
 '送料は配送方法や商品によって異なります📦
メール便（ポスト投函）: 無料〜220円
宅配便: 550円（税込）
5,500円（税込）以上のお買い物で送料無料です🎁
※沖縄・離島は別途送料がかかります
詳しくは商品ページをご確認ください✨', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '電話', 'contains', 'text',
 'お電話でのお問い合わせは 03-6411-5513 までお願いします😊
メールでのお問い合わせは info@kenkoex.com へどうぞ✉️', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '解約', 'contains', 'text',
 '定期便の解約は次回お届け予定日の10日前までにご連絡ください。
お休みプランもご用意していますので、よかったらご検討くださいね😊
お問い合わせ: info@kenkoex.com', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '返品', 'contains', 'text',
 '商品到着後8日以内にご連絡いただければ、未開封品に限り返品を承ります📦
※ゆうパケット配送のご注文は返品不可です
※着払い返品はお受けできません
お問い合わせ: info@kenkoex.com', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '返金', 'contains', 'text',
 '初回購入に限り全額返金保証がございます✨
対象: ナチュリズム180粒・酵素inナチュリズム180粒
商品到着後14日以内にご連絡ください。
お問い合わせ: info@kenkoex.com', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '支払', 'contains', 'text',
 'お支払い方法は以下からお選びいただけます💳
・クレジットカード（VISA/Master/JCB/AMEX/Diners）
・代金引換（手数料330円・8,200円以上で無料）
※代引はゆうパケット配送ではご利用いただけません', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '飲み方', 'contains', 'text',
 '1日の目安量を、お水やぬるま湯でお召し上がりください😊
食品ですのでいつお飲みいただいてもOKですが、お食事の際に一緒にお飲みいただくのがおすすめです✨', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '住所', 'contains', 'text',
 '〒103-0028 東京都中央区八重洲1-5-15 荘栄建物ビル5F
東京駅八重洲北口より徒歩1分です🏢', 1);

INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active) VALUES
(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
 '営業時間', 'contains', 'text',
 'naturism公式オンラインストアは24時間ご利用いただけます✨
お問い合わせへのご返信は平日に順次対応しております。
メール: info@kenkoex.com', 1);
