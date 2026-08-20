/**
 * home タブ IA 再編 (Ultraplan PR-6b): rank-hero + coupon-hub。
 *
 * gate `LIFF_HOME_IA_ENABLED` (既定 off = dark)。off の間は 1 byte も emit しない。
 *
 * ## 方式: CSS order (DOM / JS / loader は一切動かさない)
 * 並び替えを markup 移動でやると 5,000 行の template literal 内で大ブロックを二重管理する
 * ことになり、loader の getElementById 契約・scroll 導線・既存テストの静的ガードを全て
 * 巻き込む。gate on のときだけ #section-home.active を flex column 化し、CSS `order` で
 * 視覚順を差し替える — DOM 順は不変なので既存の配線が 1 本も壊れない。
 *
 * ## 新しい視覚順 (gate on)
 *   1. VITAL STRIP (計器)
 *   2. 次の一手 (next-move)
 *   3. 会員ランク (rank-hero — 4 枚の発行済みクーポンカードの下に埋まっていたのを昇格)
 *   4. ストア連携 CTA (未連携時のみ)
 *   5. 🎟 クーポン・お得 (coupon-hub 見出し) + クーポン 5 面を**連続配置**
 *      (従来は発行済み 4 面が最上部・一覧が rank の下に分断されていた)
 *   6. 紹介ヒーロー → ランキング → バッジ → 服用 → Tip → アンバサダー (従来順)
 *
 * ## 注意
 * - `.section.active{display:block}` (liff-pages.ts) より強い `#section-home.active` で
 *   スコープする。`.active` を外して素の `#section-home` に書くと **非表示タブが常時表示**
 *   になる (display:none を flex が上書き) — 絶対にスコープを外さないこと
 * - space-y-4 の margin は DOM 順基準なので視覚順と食い違う → gap に置換して margin を殺す
 * - 並び順の台帳は HOME_IA_ORDER (単一の正)。home に card を足したら行を足すこと —
 *   行が無い要素は order:0 で先頭に紛れ込む (テストが全 id の網羅を固定している)
 */

/** 視覚順の台帳 (id → order)。home セクション直下の全要素を列挙する。 */
export const HOME_IA_ORDER: ReadonlyArray<readonly [string, number]> = [
  ['vital-strip', 0],
  ['next-move-card', 1],
  ['rank-card', 2],
  ['shopify-link-home-card', 3],
  ['coupon-hub-head', 4],
  ['coupons-card', 5],
  ['welcome-coupon-card', 6],
  ['referral-coupon-card', 7],
  ['link-coupon-card', 8],
  ['friend-coupon-card', 9],
  ['referral-card', 10],
  ['ranking-card', 11],
  ['badge-card', 12],
  ['intake-today-card', 13],
  ['tip-card', 14],
  ['ambassador-section', 15],
];

/** coupon-hub の見出し。DOM 上はどこに置いても CSS order が視覚位置を決める。 */
export function homeIaHubHeadHtml(): string {
  return [
    '<!-- coupon-hub 見出し (Ultraplan PR-6b, gate LIFF_HOME_IA_ENABLED) -->',
    '<div id="coupon-hub-head" role="heading" aria-level="2">',
    '  <span style="font-size:18px">🎟</span>',
    '  <p>クーポン・おトク</p>',
    '</div>',
  ].join('\n      ');
}

export function homeIaCss(): string {
  const orders = HOME_IA_ORDER.map(([id, n]) => '#' + id + '{order:' + n + '}').join('\n    ');
  return [
    '/* ─ home IA 再編 (PR-6b): rank-hero + coupon-hub。DOM 不変・CSS order のみ ─ */',
    '/* 🚨 .active スコープ必須 — 外すと display:none が上書きされ非表示タブが常時表示になる */',
    '#section-home.active{display:flex;flex-direction:column;gap:1rem}',
    '/* space-y-4 は DOM 順 margin なので視覚順とズレる — gap に置換して殺す */',
    '#section-home.active > *{margin-top:0 !important;margin-bottom:0 !important}',
    orders,
    '/* coupon-hub 見出し (§7 トークン: 16px bold ink)。余白は親 gap が担う */',
    '#coupon-hub-head{display:flex;align-items:center;gap:8px}',
    '#coupon-hub-head p{font-size:16px;font-weight:700;color:#052422;line-height:1.6}',
  ].join('\n    ');
}
