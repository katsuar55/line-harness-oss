-- 045: Phase 6 KPI seed — product_repurchase_intervals + purchase_cross_sell_map
--
-- 目的: Phase 6 (再購入リマインダー + クロスセル) を本番で実動作させるための初期 seed。
--   1. naturism 主要 3 商品 (Blue / KOSO Pink / Premium) の再購入間隔を投入
--      → Shopify orders/create webhook で自動 enroll される subscription_reminders が
--        商品ごとに正確な next_reminder_at を計算できるようになる
--   2. 同 3 商品の cross-sell ペア 6 行を投入
--      → 再購入リマインダー push 時に「🎁 こちらもおすすめ」として最大 2 件提示される
--
-- 設計方針:
-- - shopify_product_id は Shopify webhook が送る数値 ID (= shopify_products テーブルの
--   shopify_product_id) と一致させる。Phase 5 PR-2 (migration 044) の nutrition_sku_map
--   は URL を格納しているが、これは別テーブル別用途 (LIFF onSkuClick が openWindow に直接
--   渡すため) で本 migration とは独立。
-- - source = 'seed' で投入。後から admin UI (`/reorder`) や user_history で上書きされる。
-- - cross-sell の reason 文言は薬機法配慮で「成分・組成の客観的説明」+ ライフスタイル提案のみ。
--   効能効果 (例: 「●● が効く」) は厳禁。
-- - ON CONFLICT DO NOTHING で再適用安全 (idempotent)。既存行は触らない。
--
-- 関連: docs/PROGRESS.md (Phase 6 PR-1/PR-3), Round 4 PR-7 admin UI
-- 商品 ID 出処: shopify_products テーブル (canonical 180粒 SKU 3 件、コピー / コラボ品除外)
--   * 7694090469629 — naturism Blue 180粒(個包装6粒×約30日分)
--   * 7694096367869 — KOSO in naturism(Pink)180粒 (個包装6粒×30日分)
--   * 9081674006781 — naturism Premium 180粒(20日分)[機能性表示食品]

-- ============================================================
-- 1. product_repurchase_intervals — 再購入間隔の seed
-- ============================================================

INSERT INTO product_repurchase_intervals
  (shopify_product_id, product_title, default_interval_days, source, sample_size, notes)
VALUES
  ('7694090469629', 'naturism Blue 180粒(個包装6粒×約30日分)', 30, 'seed', 0,
   '180粒を1日6粒目安で約30日分'),
  ('7694096367869', 'KOSO in naturism(Pink)180粒 (個包装6粒×30日分)', 30, 'seed', 0,
   '180粒を1日6粒目安で約30日分'),
  ('9081674006781', 'naturism Premium 180粒(20日分)[機能性表示食品]', 20, 'seed', 0,
   '180粒を1日9粒目安で約20日分 (機能性表示食品)')
ON CONFLICT(shopify_product_id) DO NOTHING;

-- ============================================================
-- 2. purchase_cross_sell_map — クロスセルペア seed (3×2 = 6 行)
-- ============================================================
--
-- 推奨ロジック: subscription-reminder cron が source 商品のリマインド push 時に
-- 同 source から最大 2 件 (priority DESC) を bubble に追加する。
-- 主要 3 商品はそれぞれ他 2 商品を相互に推奨。

-- Blue → Pink, Premium
INSERT INTO purchase_cross_sell_map
  (source_product_id, recommended_product_id, reason, priority, is_active)
VALUES
  ('7694090469629', '7694096367869',
   '酵素360mgと食物繊維をプラスして美容ケアも', 10, 1),
  ('7694090469629', '9081674006781',
   '16成分の機能性表示食品で糖質ケアも一緒に', 5, 1)
ON CONFLICT(source_product_id, recommended_product_id) DO NOTHING;

-- Pink → Blue, Premium
INSERT INTO purchase_cross_sell_map
  (source_product_id, recommended_product_id, reason, priority, is_active)
VALUES
  ('7694096367869', '7694090469629',
   '8成分のシンプル定番ラインで継続しやすく', 10, 1),
  ('7694096367869', '9081674006781',
   '16成分の機能性表示食品で糖質ケアも', 5, 1)
ON CONFLICT(source_product_id, recommended_product_id) DO NOTHING;

-- Premium → Blue, Pink
INSERT INTO purchase_cross_sell_map
  (source_product_id, recommended_product_id, reason, priority, is_active)
VALUES
  ('9081674006781', '7694090469629',
   '8成分のシンプル定番ラインで日々の食事ケアに', 10, 1),
  ('9081674006781', '7694096367869',
   '酵素360mgと食物繊維で美容ケアも追加', 5, 1)
ON CONFLICT(source_product_id, recommended_product_id) DO NOTHING;
