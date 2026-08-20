/**
 * ポータル視覚刷新 v2 (Ultraplan PR-7/8): 主役カードの計器アクセント。
 *
 * gate `LIFF_VISUAL_V2_ENABLED` (既定 off = dark)。off の間は 1 byte も emit しない。
 *
 * ## 設計原則 (VITAL INSTRUMENT 準拠・抑制されたポリッシュ)
 * - **新色ゼロ**: 既存トークン (--grad-vital / --shadow-float / --edge-light / --hairline)
 *   のみを使う。文字色・塗りは一切変えない = §7-1 コントラスト宣言表に新ペアを増やさない
 *   (liff-contrast-guard.test.ts の守備範囲を変えない)
 * - **装飾のみ**: レイアウト値 (padding/size/order) を触らない — IA は PR-6b (home-ia) の
 *   管轄で、本 fragment は「見た目の格」だけを足す
 * - 主役カード 2 面 (会員ランク / 定期便のお手続き) に、タブの active レール
 *   (.tab-active) と同じ「計器レール」idiom の 3px グラデ天冠を与える
 *
 * ## 注意
 * - #rank-card は Ambassador のとき .rank-ambassador (金の環境光 + ::before sparkle) を
 *   まとう。id セレクタで background を上書きすると金の額装が死ぬため、**必ず
 *   :not(.rank-ambassador) で除外**する (テストが固定)
 * - ::before/::after は使わない (rank-ambassador::before と衝突するため)。天冠は
 *   .tab-active と同じ multi-layer background idiom で実現する
 */

export function visualV2Css(): string {
  return [
    '/* ─ visual-v2 (PR-7/8): 主役カードの計器アクセント。新色ゼロ・トークンのみ ─ */',
    '/* rank-hero の額装: 3px の計器レール天冠 + 浮き shadow (Ambassador の金装は温存) */',
    '#rank-card:not(.rank-ambassador){background:var(--grad-vital) top/100% 3px no-repeat,#ffffff;box-shadow:var(--shadow-float),var(--edge-light)}',
    '/* 定期便のお手続き (shop タブの主役) にも同じ天冠 — 面をまたいだ計器の一貫性 */',
    '#sub-contracts-card{background:var(--grad-vital) top/100% 3px no-repeat,#ffffff;box-shadow:var(--shadow-float),var(--edge-light)}',
    '/* coupon-hub 見出しにヘアラインのレールを伸ばす (見出しがラベルとして立つ) */',
    '#coupon-hub-head::after{content:"";flex:1 1 auto;height:1px;background:var(--hairline)}',
  ].join('\n    ');
}
