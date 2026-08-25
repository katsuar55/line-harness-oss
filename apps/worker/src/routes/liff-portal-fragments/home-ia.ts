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
 *   1. 統合ランクヒーロー (rank-card — 2026-08-25 に VITAL STRIP と統合。ノータップでランク/割引%/次条件)
 *   2. 次の一手 (next-move)
 *   3. ストア連携 CTA (未連携時のみ — C3「連携は全ての前提なので上部」の決定を維持し、
 *      前提未充足の rank ティーザーより上に置く)
 *   4. 🎟 クーポン・お得 (coupon-hub 見出し) + クーポン 5 面を**連続配置**
 *      (従来は発行済み 4 面が最上部・一覧が rank の下に分断されていた)
 *   5. 紹介ヒーロー → ランキング → バッジ → 服用 → Tip → アンバサダー (従来順)
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
  // 2026-08-25: VITAL STRIP は廃止し、ランクヒーロー (rank-card) が最上段を継いだ。
  ['rank-card', 0],
  ['next-move-card', 1],
  ['shopify-link-home-card', 2],
  ['coupon-hub-head', 3],
  ['coupons-card', 4],
  ['welcome-coupon-card', 5],
  ['referral-coupon-card', 6],
  ['link-coupon-card', 7],
  ['friend-coupon-card', 8],
  ['referral-card', 9],
  ['ranking-card', 10],
  ['badge-card', 11],
  ['intake-today-card', 12],
  ['tip-card', 13],
  ['ambassador-section', 14],
];

/** coupon-hub の見出し。DOM 上はどこに置いても CSS order が視覚位置を決める。 */
export function homeIaHubHeadHtml(): string {
  return [
    '<!-- coupon-hub 見出し (Ultraplan PR-6b, gate LIFF_HOME_IA_ENABLED) -->',
    // role="heading" は付けない: CSS order は a11y tree を並べ替えないため、DOM 上この
    // 見出しの直後は (未発行時) 連携 CTA や rank になり、SR の見出しナビを誤誘導する
    // (採点ループ confirmed)。装飾テキスト扱い = SR 体験は旧 IA と完全一致。
    '<div id="coupon-hub-head">',
    '  <span style="font-size:18px" aria-hidden="true">🎟</span>',
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
