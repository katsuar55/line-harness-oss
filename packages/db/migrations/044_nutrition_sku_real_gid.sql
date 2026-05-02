-- Phase 5 PR-2: nutrition_sku_map を実 naturism Shopify 商品にマッピング
--
-- 目的: AI 栄養コーチ (/coach) が提案する商品リンクを、
--      placeholder://* から実在する naturism オンラインストアの商品ページに置き換える。
--
-- 設計方針:
-- - shopify_product_id 列には完全 URL を格納する。
--   理由: liff-coach-page.ts の onSkuClick が `liff.openWindow({ url: shopifyProductId })`
--   としてこの値を直接開くため、URL を入れるのが最小変更で動作する。
--   (migration 037 のコメントは "実 GID に置換" となっているが実装は URL を期待していた)
-- - public domain `naturism-diet.com` を使う (canonical / SEO 観点)
-- - 商品は naturism の主要 3 ライン × 180 粒 (約 1 ヶ月) を採用
--   * naturism Blue       — シンプル定番 8 成分
--   * KOSO in naturism Pink — Blue 8 成分 + 酵素 360mg、食事ケア + 美容
--   * naturism Premium    — 16 成分の機能性表示食品 (糖質対応)
-- - copy_template は薬機法配慮で「効能効果の断定」を避け、ライフスタイル提案として記述
--
-- 関連: docs/PHASE5_PR2_GID_INVESTIGATION.md (本セッションで作成)

-- 既存 placeholder 行を実 URL に上書き
UPDATE nutrition_sku_map SET
  shopify_product_id = 'https://naturism-diet.com/products/1',
  product_title = 'naturism Blue 180粒(個包装6粒×約30日分)',
  copy_template = '今週はたんぱく質摂取が控えめでした。日々の食事ケアの選択肢として'
WHERE deficit_key = 'protein_low';

UPDATE nutrition_sku_map SET
  shopify_product_id = 'https://naturism-diet.com/products/5',
  product_title = 'KOSO in naturism(Pink)180粒 (個包装6粒×30日分)',
  copy_template = '食物繊維がやや不足気味の週でした。1日1回のシンプルな食事ケアに'
WHERE deficit_key = 'fiber_low';

UPDATE nutrition_sku_map SET
  shopify_product_id = 'https://naturism-diet.com/products/5',
  product_title = 'KOSO in naturism(Pink)180粒 (個包装6粒×30日分)',
  copy_template = '鉄分が控えめな週でした。バランスを意識したい方の食事ケアに'
WHERE deficit_key = 'iron_low';

UPDATE nutrition_sku_map SET
  shopify_product_id = 'https://naturism-diet.com/products/1',
  product_title = 'naturism Blue 180粒(個包装6粒×約30日分)',
  copy_template = '全体的にカロリーが控えめでした。日々の食事ケアの土台に'
WHERE deficit_key = 'calorie_low';

UPDATE nutrition_sku_map SET
  shopify_product_id = 'https://naturism-diet.com/products/naturism-premium-180%E7%B2%9220%E6%97%A5%E5%88%86%E6%A9%9F%E8%83%BD%E6%80%A7%E8%A1%A8%E7%A4%BA%E9%A3%9F%E5%93%81',
  product_title = 'naturism Premium 180粒(20日分)[機能性表示食品]',
  copy_template = 'カロリーが多めの週でした。糖質対応の機能性表示食品で食事ケアに'
WHERE deficit_key = 'calorie_high';
