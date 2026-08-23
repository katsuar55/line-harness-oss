/**
 * Shop タブ v2 の UI (2026-08-23, gate LIFF_SHOP_V2_ENABLED)。
 *
 * renderPortal() の**出力ベース**で検証する (ソース静的検査は 0 マッチで恒久 pass する事故を起こす)。
 * gate off で 1 byte も emit しないこと、gate on で必要な要素が揃うことを両方見る。
 */
import { describe, it, expect } from 'vitest';
import { renderPortal, PORTAL_GATE_MATRIX, extractStyles } from './helpers/render-portal.js';

const ON = { LIFF_SHOP_V2_ENABLED: 'true' };
const ON_WITH_SUB = { LIFF_SHOP_V2_ENABLED: 'true', LIFF_SUB_CARD_ENABLED: 'true' };

/** 出力 HTML から top-level function のブロックを抽出 (行頭 `}` で終端)。 */
function fnBlock(html: string, name: string): string {
  const m = html.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('gate off = 1 byte も emit しない (dark)', () => {
  it('Shop v2 のマーカーが 1 つも出ない', async () => {
    const html = await renderPortal();
    for (const marker of ['sh-nav-', 'sh-anchor-', 'shop-grid-card', 'sh-anchors', 'renderShopGrid', 'shopJumpSub']) {
      expect(html, marker).not.toContain(marker);
    }
  });

  it('gate off でも Shop タブ本体と既存カードは無傷 (退行なし)', async () => {
    const html = await renderPortal();
    expect(html).toContain('id="section-shop"');
    expect(html).toContain('id="products-card"');
    expect(html).toContain('id="orders-card"');
  });
});

describe('gate on = アンカー 3 本 + グリッド', () => {
  it('再購入 / LINE UP のチップと着地センチネルが出る', async () => {
    const html = await renderPortal(ON);
    expect(html).toContain('id="sh-nav-reorder"');
    expect(html).toContain('id="sh-nav-lineup"');
    expect(html).toContain('id="sh-anchor-reorder"');
    expect(html).toContain('id="sh-anchor-lineup"');
    expect(html).toContain('id="shop-grid-card"');
    // Katsu 指定の文言をそのまま使う
    expect(html).toContain('LINE UP');
  });

  it('🚨 サブスクカードが無い構成ではサブスクチップも着地点も emit しない (押しても飛べない先を作らない)', async () => {
    const html = await renderPortal(ON);
    expect(html).not.toContain('id="sh-nav-sub"');
    expect(html).not.toContain('id="sh-anchor-sub"');
  });

  it('サブスクカードがある構成では 3 本揃う', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    expect(html).toContain('id="sh-nav-sub"');
    expect(html).toContain('id="sh-anchor-sub"');
    expect(html).toContain('id="sub-contracts-card"');
  });

  it('アンカーは DOM 順で Shop タブの先頭にある (CSS order を使わない)', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    const shop = html.slice(html.indexOf('id="section-shop"'));
    const nav = shop.indexOf('class="sh-anchors"');
    const sub = shop.indexOf('id="sub-contracts-card"');
    const grid = shop.indexOf('id="shop-grid-card"');
    const products = shop.indexOf('id="products-card"');
    expect(nav).toBeGreaterThan(-1);
    // 視覚順 = DOM 順: アンカー → サブスク → 再購入グリッド → ラインナップ
    expect(nav).toBeLessThan(sub);
    expect(sub).toBeLessThan(grid);
    expect(grid).toBeLessThan(products);
  });

  it('着地点は各カードの外側直前にある (scroll-reveal の 34px ズレを避ける)', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    const shop = html.slice(html.indexOf('id="section-shop"'));
    expect(shop.indexOf('id="sh-anchor-sub"')).toBeLessThan(shop.indexOf('id="sub-contracts-card"'));
    expect(shop.indexOf('id="sh-anchor-reorder"')).toBeLessThan(shop.indexOf('id="shop-grid-card"'));
    expect(shop.indexOf('id="sh-anchor-lineup"')).toBeLessThan(shop.indexOf('id="products-card"'));
  });

  it('🚨 location.hash を汚さない (次回起動の deep-link 判定が変わるため a href="#" を使わない)', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    const nav = html.match(/<nav class="sh-anchors"[\s\S]*?<\/nav>/)![0];
    expect(nav).not.toContain('href=');
    expect(nav).toContain('<button');
  });

  it('onclick は引数なしの名前付き関数のみ (LIFF inline JS の規律)', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    const nav = html.match(/<nav class="sh-anchors"[\s\S]*?<\/nav>/)![0];
    for (const oc of [...nav.matchAll(/onclick="([^"]+)"/g)].map((m) => m[1])) {
      expect(oc).toMatch(/^[A-Za-z_$][\w$]*\(\)$/);
    }
  });

  it('アンカーバーは横スワイプをタブ切替に奪われない', async () => {
    const html = await renderPortal(ON);
    expect(html).toMatch(/<nav class="sh-anchors"[^>]*data-no-tab-swipe/);
  });
});

describe('スタイル (ブランド準拠・新色ゼロ)', () => {
  it('着地オフセットが 3 センチネル共通の scroll-margin-top で入る', async () => {
    const css = extractStyles(await renderPortal(ON));
    expect(css).toMatch(/\.sh-anchor-t\{[^}]*scroll-margin-top:110px/);
  });

  it('2 列グリッドである (Katsu 指定)', async () => {
    const css = extractStyles(await renderPortal(ON));
    expect(css).toMatch(/\.sh-grid\{[^}]*grid-template-columns:1fr 1fr/);
  });

  it('LINE 黄緑と禁止色を使わない', async () => {
    const css = extractStyles(await renderPortal(ON));
    expect(css.toLowerCase()).not.toContain('#06c755');
    expect(css.toLowerCase()).not.toContain('#0abab5');
  });

  it('タップは柔らかく押し込む (ブランド常設方針)', async () => {
    const css = extractStyles(await renderPortal(ON));
    expect(css).toMatch(/\.sh-anchors button:active\{transform:scale\(\.97\)\}/);
    expect(css).toMatch(/\.sh-buy:active\{transform:scale\(\.97\)\}/);
  });
});

describe('client の配線', () => {
  it('🚨 サブスクチップの表示可否はカードの表示状態を直接見る (代理指標を使わない)', async () => {
    const html = await renderPortal(ON_WITH_SUB);
    const b = fnBlock(html, 'shopSubCardVisible');
    expect(b).toContain('sub-contracts-card');
    expect(b).toContain('style.display');
    // __liffHasActiveContract はカードの表示可否と別の API が決めるので代理にしない
    expect(b).not.toContain('__liffHasActiveContract');
  });

  it('飛び先が無いときは無反応にせずトーストで代替導線を出す', async () => {
    const html = await renderPortal(ON);
    expect(fnBlock(html, 'shopJumpSub')).toContain('showToast');
    expect(fnBlock(html, 'shopJumpReorder')).toContain('showToast');
  });

  it('reduced-motion では smooth スクロールにしない', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'shopJumpTo');
    expect(b).toContain('prefers-reduced-motion');
    expect(b).toMatch(/reduce \? "auto" : "smooth"/);
  });

  it('🚨 購入はサーバ経由 — クライアントが permalink も variantId も持たない', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'shopBuy');
    expect(b).toContain('/api/liff/shop/buy');
    expect(b).toContain('productId: it.productId');
    // variantId をサーバへ送らない (DOM 改変で任意商品のカートを組ませない)
    expect(b).not.toContain('variantId');
    // カート URL をクライアント側で組み立てない (既存の rosEditItems は別経路なので
    // 検査は Shop v2 のブロックに限定する)
    expect(b).not.toContain('/cart/');
    expect(fnBlock(html, 'buildShopTile')).not.toContain('/cart/');
  });

  it('409 は既存の確認シートに追随する (ack キーもコードも #269 と同一)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'shopBuy');
    expect(b).toContain('subscription_duplicate');
    expect(b).toContain('openSubDupConfirm()');
    expect(b).toContain('acknowledgeSubscriptionDuplicate = true');
  });

  it('確認シートの「単発で追加購入する」がグリッド購入を続行させる', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'subDupProceed');
    expect(b).toContain('shopBuyAckProceed');
    // 再注文シート経路より先に判定する (両方に ack が漏れないよう分岐を分ける)
    expect(b.indexOf('shopBuyAckProceed')).toBeLessThan(b.indexOf('rosAckSubDup = true'));
  });

  it('🚨 保留中の購入は商品 identity に束縛する (配列 index にしない)', async () => {
    // 採点ループ HIGH: index だとグリッド再描画で並びが変わったとき、
    // 顧客が確認していない商品に ack=true が付く
    const html = await renderPortal(ON);
    expect(html).toContain('var shopPendingBuyProductId = null;');
    expect(html).not.toContain('shopPendingBuyIdx');
    const b = fnBlock(html, 'shopBuyAckProceed');
    // 保存した productId が今のグリッドに無ければ**何も買わない**
    expect(b).toContain('productId === pid');
    expect(b).toContain('商品情報が更新されました');
  });

  it('🚨 確認シートを閉じたら保留中の購入を破棄する (次の再注文に横取りさせない)', async () => {
    // 採点ループ HIGH の本命: 「やめる」で閉じても保留が残ると、後で別経路 (再注文) の
    // 確認シートで「はい」を押したときにグリッド購入が横取りし、
    // 顧客が意図した再注文は無音で消え、選んでいない商品のカートが開く
    const html = await renderPortal(ON);
    const close = fnBlock(html, 'closeSubDupConfirm');
    expect(close).toContain('shopClearPendingBuy');
    const clear = fnBlock(html, 'shopClearPendingBuy');
    expect(clear).toContain('shopPendingBuyProductId = null');
  });

  it('タイルは DOM 組み立てで作る (HTML 文字列を組まない = XSS を構造的に不能にする)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    expect(b).toContain('createElement');
    expect(b).toContain('textContent');
    expect(b).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  });

  it('🚨 割引ラベルはサーバ判定 (discounted) のときだけ出す — クライアントで再計算しない', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    expect(b).toMatch(/it\.discounted && it\.discountPercent > 0/);
    // 金額から自前で割引後価格を計算しない (併用クーポン・送料でズレるため)
    expect(b).not.toMatch(/priceJpy\s*\*/);
  });

  it('価格が出せないときは「¥0」ではなく代替文言にする', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    expect(b).toMatch(/typeof it\.priceJpy === "number" && it\.priceJpy > 0/);
    expect(b).toContain('ストアで価格をみる');
  });

  it('定期便で届いている商品は「定期便を確認する」が主ボタン (単発購入は副線)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    expect(b).toContain('定期便を確認する');
    expect(b).toContain('単発で追加購入する');
    expect(b).toContain('定期便でお届け中');
  });

  it('🚨 定期便バッジは画像に重ねる (2026-08-23 Katsu 指示)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    // 画像とバッジを同じラッパに入れ、バッジ側を絶対配置する
    expect(b).toContain('sh-thumb-wrap');
    expect(b).toMatch(/over\.className = "sh-over"/);
    expect(b).toMatch(/wrap\.appendChild\(over\)/);
    // 定期便バッジは本文側でなく画像ラッパ側へ付く
    const overIdx = b.indexOf('sh-over');
    const bodyIdx = b.indexOf('sh-badges');
    expect(overIdx).toBeGreaterThan(-1);
    expect(overIdx).toBeLessThan(bodyIdx);

    const css = extractStyles(html);
    expect(css).toMatch(/\.sh-thumb-wrap\{[^}]*position:relative/);
    expect(css).toMatch(/\.sh-over\{[^}]*position:absolute/);
  });

  it('🚨 グリッドは購入履歴だけ — 「前回ご購入」バッジは出さない (全件に付き情報量ゼロ)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'buildShopTile');
    expect(b).not.toContain('前回ご購入');
    expect(b).not.toContain('it.purchased');
  });

  it('空のときは断定せず、下の LINE UP へ誘導する (未連携でも嘘にならない文言)', async () => {
    const html = await renderPortal(ON);
    const b = fnBlock(html, 'renderShopGrid');
    expect(b).toContain('これまでにお求めの商品がここに並びます');
    expect(b).toContain('LINE UP');
    // 連携 CTA は注文カード側に集約する (同じ CTA を 2 枚並べない)。
    // 検査対象は**実際に表示される文言**に絞る (コメント文言に反応させない)
    const shown = b.match(/empty\.textContent = "([^"]*)"/)![1];
    expect(shown).not.toContain('連携');
    expect(shown).not.toContain('ありません');
  });

  it('価格・割引の但し書きを 1 行出す (景表法の開示)', async () => {
    const html = await renderPortal(ON);
    expect(html).toContain('ランク割引は ¥2,000 以上のご注文で適用されます');
    expect(html).toContain('送料別');
  });
});

describe('PORTAL_GATE_MATRIX に登録されている', () => {
  it('Shop v2 の行と「全 gate on」への追加がある', () => {
    const labels = PORTAL_GATE_MATRIX.map(([l]) => l);
    expect(labels.some((l) => l.includes('Shop タブ v2'))).toBe(true);
    const all = PORTAL_GATE_MATRIX.find(([l]) => l.includes('全 gate on'));
    expect(all).toBeTruthy();
    expect(all![1].LIFF_SHOP_V2_ENABLED).toBe('true');
  });

  for (const [label, env] of PORTAL_GATE_MATRIX) {
    it(`${label}: 200 で描画できる`, async () => {
      const html = await renderPortal(env);
      expect(html).toContain('id="section-shop"');
    });
  }
});
