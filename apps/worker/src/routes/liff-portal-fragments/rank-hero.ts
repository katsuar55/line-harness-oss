/**
 * ホーム最上部の統合ランクヒーロー (2026-08-25, オーナー実機 FB)。
 *
 * ## 直したこと
 * ホーム最上部には 2 枚のカードが縦に並んでいた:
 *   ① VITAL STRIP — 「ランク / はじめて」「クーポン / もらう →」「連携 / 連携済み」の 3 セル。
 *      オーナー評: **意味が分からない**。名詞だけ並んでいて、何が起きているのか読めない。
 *   ② 会員ランクカード — アイコンと「ご購入でランクが上がり、割引特典が受けられます」だけ。
 *      **「会員特典を見てみる →」をタップして初めて** 次ページでメダル・割引%・進捗が出る。
 * 指示は「2 枚を統合し、ノータップで会員ランク・何% OFF・次のランクまでの条件を出す。
 * ランク判定日と全ランク一覧はタップした次のページ (/liff/my-rank) に置く」。
 *
 * ## 🚨 ランクの出どころを付け替えたこと (これが本丸)
 * 旧 rank-card は DEPRECATED な `friend_ranks` / `member_ranks` を読んでいた
 * (docs/MEMBER_RANKS_DEPRECATION_2026-05-28.md)。この表は**本番で空**なので、
 * 全ユーザーが `currentRank: null` の else 分岐 = ティーザー文しか見たことがない。
 * 一方で会員証 (/liff/my-rank) は `member_purchase_events` の trailing-12ヶ月 SUM +
 * `NATURISM_RANK_DEFS` で算出しており、こちらが本番の正 (ランク割引コード NLR- の発行も
 * 月次 snapshot cron もこの系統)。ホームだけ別系統を読んでいたので、同じ顧客に
 * 「ホーム = はじめて」「会員証 = レギュラー会員」と**2 つの答え**を見せていた。
 * → ヒーローは `readLoyaltyRank` (= 会員証と同じ 1 本) の `data.loyalty` だけを描く。
 *
 * ## 嘘をつかないための決め事
 * - `trailing12moJpy` が 0 のときは **累計額を出さない**。未連携の顧客は実際には購入していても
 *   原資 (member_purchase_events) に載らず 0 になる。「¥0」と断定しない。
 * - 🚨 **ランクが上がると約束しない**。purchase ingest は PR #280 (2026-08-26) で
 *   orders/create/updated に配線され live になったが、それが効くのは**連携済みの顧客だけ**
 *   (本番 6,618 人中 10 人)。未連携の閲覧者 (大多数) には「1 回のお買い物で〜になります」は
 *   依然成立しないので、述べてよいのは**制度の条件**だけ (次はどのランクで、何が付くか)。
 * - 金額は「ランクに反映されたお買い上げ」と名乗る。取り込みが完全であるとは断定しない。
 * - % は会員証と**逐語で揃える**: 「通常購入 N% OFFクーポン」。「クーポン」を落とすと自動割引に
 *   読まれ、「通常購入」を落とすと定期便にも乗ると読まれる (NLR- は appliesOnSubscription:false)。
 * - 記録が 1 円も無いときは進捗バーを出さず、「会員ランクは、公式ストアでのお買い物の記録から
 *   判定しています」とだけ添える。**ヒーロー自身は「連携すれば反映されます」と書かない** —
 *   その約束は真下の連携 CTA カード (#shopify-link-home-card) が `MEMBER_BACKFILL_ENABLED`
 *   連動でサーバ側から出し分ける (2026-08-26 連携ファネル修復)。ヒーローにも書くと同じ CTA が
 *   2 枚並ぶうえ、gate 状態をクライアントへ二重に配る羽目になる。
 * - 割引率は `RANK_DISCOUNT_ENABLED` に連動させる。gate off では `issueRankDiscountForFriend` が
 *   1 枚も発行しないので、% を出した時点で「受け取れない割引」の広告になる。
 * - 🚨 % を出すときは必ず **「¥2,000 以上のご注文で」** を併記する。NLR- コードには
 *   `minimumRequirement` が必ず付く (services/rank-discount-issuer.ts) ので、% 単独は有利誤認。
 *
 * ## 色
 * 新しい hex を 1 つも増やさない (:root の既存トークンだけを使う)。とくに %OFF バッジの地色に
 * `badgeColor` を使わない — platinum の badgeColor はブランド原色ティールで、白文字 2.3:1 の
 * 事故色 (§7-1 恒久ガードの禁止 hex そのもの)。badgeColor は**文字が載らない**メダルの
 * グローにだけ使い、hex allowlist で正規化してから style に入れる (CSS injection 防止)。
 *
 * ## 組み立て
 * HTML 文字列を組まず DOM API で作る (shop-v2 の buildShopTile と同じ流儀)。
 * 文字列連結だと属性の引用符と JS 文字列の引用符が入れ子になり、2026-07-10 の
 * 「inline script 全損」と同じ穴に近づく。textContent なら XSS も構造的に不能。
 */

/** ヒーロー内の要素 id。テストと client JS の双方がここを見る (綴りの単一の正)。 */
export const RANK_HERO_IDS = {
  card: 'rank-card',
  medalImg: 'rh-medal-img',
  medalFallback: 'rh-medal-fallback',
  name: 'rh-name',
  off: 'rh-off',
  spent: 'rh-spent',
  bar: 'rh-bar-fill',
  next: 'rh-next',
  note: 'rh-note',
  couponBtn: 'rh-coupon',
  couponLabel: 'rh-coupon-label',
  detailBtn: 'rh-detail',
} as const;

export function rankHeroCss(): string {
  return [
    '/* ─ 統合ランクヒーロー (2026-08-25): 旧 VITAL STRIP + 旧ランクカードの後継 ─ */',
    '/* padding は各行が持つ (フッターの区切り線をカード幅いっぱいに引くため) */',
    '/* 角丸の内側でクリップする — フッターボタンの押下背景がカード下 2 隅の弧を上書きするため */',
    '#rank-card{padding:0 !important;overflow:hidden}',
    '/* cardError / demo が innerHTML で差し込む中身は行を持たないので、直下 div に余白を配る */',
    '#rank-card > div:not(.rh-top):not(.rh-body):not(.rh-foot):not(.sparkle-dots){padding:16px}',
    '.rh-top{display:flex;align-items:center;gap:14px;padding:16px 16px 10px}',
    '.rh-medal{position:relative;width:76px;height:76px;flex:none;display:flex;align-items:center;justify-content:center}',
    '.rh-medal img{width:76px;height:76px;object-fit:contain;filter:drop-shadow(0 4px 10px rgba(8,58,60,.16))}',
    '.rh-glow{position:absolute;left:-12%;top:-12%;right:-12%;bottom:-12%;border-radius:50%;pointer-events:none}',
    '.rh-emoji{font-size:50px;line-height:1}',
    '.rh-head{min-width:0;flex:1}',
    '.rh-label{display:block;font-size:11px;font-weight:700;letter-spacing:.16em;color:var(--action)}',
    '.rh-name{display:block;font-size:22px;font-weight:800;color:var(--ink);line-height:1.25;margin-top:2px}',
    '.rh-off{display:inline-block;margin-top:7px;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:800;background:var(--action-2);color:#fff;box-shadow:0 2px 6px rgba(15,118,110,.24)}',
    '.rh-off.is-none{background:var(--well);color:var(--ink-2);font-weight:700;box-shadow:none}',
    '.rh-cond{display:block;margin-top:5px;font-size:12px;font-weight:600;color:var(--muted);line-height:1.5}',
    '.rh-body{padding:0 16px 14px}',
    '.rh-spent{display:block;font-size:11px;font-weight:600;color:var(--muted)}',
    '.rh-bar{display:block;height:8px;border-radius:999px;background:var(--track);overflow:hidden;margin-top:7px}',
    '.rh-bar>i{display:block;height:8px;border-radius:999px;background:var(--grad-vital);width:0;transition:width var(--dur-gauge) var(--ease)}',
    '.rh-next{font-size:13px;font-weight:600;color:var(--ink-2);line-height:1.55;margin-top:9px}',
    '.rh-next b{font-weight:800;color:var(--action-2)}',
    '.rh-note{margin-top:10px;padding:8px 10px;border-radius:12px;font-size:12px;line-height:1.55;background:var(--gold-wash);border:1px solid var(--gold-line);color:var(--gold-ink)}',
    '.rh-foot{display:flex;align-items:stretch;border-top:1px solid var(--hairline)}',
    '.rh-foot button{flex:1;min-width:0;min-height:48px;padding:10px 8px;background:none;border:0;font-size:13px;font-weight:700;color:var(--action);display:flex;align-items:center;justify-content:center;gap:6px;transition:transform var(--dur-tap) var(--ease),background var(--dur-tap) var(--ease)}',
    '.rh-foot button:active{transform:scale(.96);background:var(--well)}',
    '.rh-foot .rh-sep{width:1px;flex:none;background:var(--hairline)}',
    '/* アンバサダーの金の粒と ::before は装飾。 本文より下に敷く (旧カードの z-index:1 の移植) */',
    '#rank-card.rank-ambassador .rh-top,#rank-card.rank-ambassador .rh-body,#rank-card.rank-ambassador .rh-foot{position:relative;z-index:1}',
    '#rank-card .sparkle-dots{z-index:0}',
    '.rh-coupon-n{font-weight:800;color:var(--ink);font-variant-numeric:tabular-nums}',
    '@media(prefers-reduced-motion:reduce){.rh-bar>i{transition:none}.rh-foot button{transition:none}.rh-foot button:active{transform:none}}',
  ].join('\n    ');
}

/** ヒーローの静的 markup (読み込み中の骨組み)。実データは renderRankHero が差し替える。 */
export function rankHeroHtml(): string {
  return [
    '<!-- 統合ランクヒーロー: ランク / 割引% / 次ランク条件 をノータップで出す (2026-08-25) -->',
    '<div id="rank-card" class="card">',
    '  <div class="rh-top">',
    '    <div class="skeleton" style="width:76px;height:76px;border-radius:50%;flex:none"></div>',
    '    <div class="rh-head">',
    '      <div class="skeleton" style="width:88px;height:11px;border-radius:6px"></div>',
    '      <div class="skeleton" style="width:150px;height:22px;border-radius:8px;margin-top:8px"></div>',
    '      <div class="skeleton" style="width:120px;height:24px;border-radius:999px;margin-top:9px"></div>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n      ');
}

export function rankHeroJs(): string {
  return RANK_HERO_JS;
}

const RANK_HERO_JS: string = [
  '// ─── 統合ランクヒーロー (2026-08-25) ───',
  '// 描くのは data.loyalty (= 会員証 /liff/my-rank と同じ 1 本) だけ。 DEPRECATED な',
  '// data.currentRank / totalSpent / nextRank / progressPercent は**見ない** (本番で空の表)。',
  '// 設計の根拠は routes/liff-portal-fragments/rank-hero.ts の冒頭コメント。',
  '',
  '// badgeColor は style 属性に入るので HTML-escape では不十分。hex のみ allowlist 正規化する。',
  'function rhSafeColor(c) {',
  '  return /^#[0-9A-Fa-f]{6}$/.test(String(c)) ? String(c) : "#2fa8ad";',
  '}',
  '',
  'function rhYen(n) {',
  '  try { return "¥" + Number(n || 0).toLocaleString("ja-JP"); } catch (e) { return "¥" + (n || 0); }',
  '}',
  '',
  'function rhNode(tag, cls, text) {',
  '  var n = document.createElement(tag);',
  '  if (cls) { n.className = cls; }',
  '  if (text !== undefined && text !== null) { n.textContent = String(text); }',
  '  return n;',
  '}',
  '',
  '// メダル。画像が落ちても絵文字へ退避する (会員証と同じ作法)。',
  'function rhMedal(rank) {',
  '  var wrap = rhNode("span", "rh-medal");',
  '  wrap.setAttribute("aria-hidden", "true");',
  '  var url = rank.badgeImageUrl ? String(rank.badgeImageUrl) : "";',
  '  var emoji = rank.badgeEmoji ? String(rank.badgeEmoji) : "✨";',
  '  if (!url) { wrap.appendChild(rhNode("span", "rh-emoji", emoji)); return wrap; }',
  '  var color = rhSafeColor(rank.badgeColor);',
  '  var glow = rhNode("span", "rh-glow");',
  '  glow.style.background = "radial-gradient(circle," + color + "4d 0%," + color + "1f 45%,transparent 70%)";',
  '  wrap.appendChild(glow);',
  '  var img = document.createElement("img");',
  '  img.id = "rh-medal-img";',
  '  img.width = 76;',
  '  img.height = 76;',
  '  img.alt = "";',
  '  // メダルは 143〜184KB / 実寸 250x325 の PNG を 76px で出す。 immutable 1 年でキャッシュされるが、',
  '  // 初回だけは重いのでデコードを描画から外す (width/height は上で明示済 = レイアウトシフト無し)。',
  '  img.decoding = "async";',
  '  var fb = rhNode("span", "rh-emoji", emoji);',
  '  fb.id = "rh-medal-fallback";',
  '  fb.style.display = "none";',
  '  img.onerror = function () { img.style.display = "none"; fb.style.display = "block"; };',
  '  img.src = url;',
  '  if (img.complete && img.naturalWidth === 0) { img.onerror(); }',
  '  wrap.appendChild(img);',
  '  wrap.appendChild(fb);',
  '  return wrap;',
  '}',
  '',
  '// ランク割引クーポンの最低購入金額。% を 1 箇所でも出すなら必ずこの行も出す。',
  'function rhCond() {',
  '  var cond = rhNode("span", "rh-cond", "通常購入（単発のお買い物）の ¥2,000 以上のご注文でお使いいただけます");',
  '  cond.id = "rh-cond";',
  '  return cond;',
  '}',
  '',
  '// 次ランクの案内。 過去の購入有無を**断定しない** (本番は原資が空で、 実際には買っている',
  '// 顧客も 0 円に見えるため。 「はじめてのお買い物で」とは書かない)。',
  'function rhFillNextLine(p, next) {',
  '  if (!next) { p.textContent = "✨ いちばん上のランクです。いつもありがとうございます"; return; }',
  '  var pct = Number(next.discountPercent);',
  '  var label = String(next.name || "") + "会員";',
  '  // 🚨 会員証と逐語で揃えて「クーポン」を落とさない。 NLR- は checkout でコードを適用する',
  '  //    顧客別クーポンで、自動割引ではない。 語を落とすと「勝手に引かれる」と読まれる。',
  '  //    「通常購入」も必ず残す — NLR- は appliesOnSubscription:false で定期便には 1 円も乗らないが、',
  '  //    ランクの判定額には定期便の支払いが算入されるため、限定語が無いと定期便顧客が誤読する。',
  '  // gate off では割引コードが 1 枚も発行されないので % を書かない (受け取れない割引を広告しない)',
  '  if (RANK_DISCOUNT_ON && isFinite(pct) && pct > 0) {',
  '    label += "（通常購入 " + Math.floor(pct) + "% OFFクーポン）";',
  '  }',
  '  // 🚨 「1 回のお買い物で〜になります」と**約束しない**。 purchase ingest (PR #280) が効くのは',
  '  //    連携済みの顧客だけで、 この面の閲覧者の大多数は未連携 (本番 6,618 人中 10 人)。',
  '  //    ここで述べてよいのは**制度の条件**だけ (次はどのランクで、何が付いて、いくら足りないか)。',
  '  p.appendChild(document.createTextNode("次のランク "));',
  '  p.appendChild(rhNode("b", "", label));',
  '  var remain = Number(next.remainingJpy);',
  '  if (isFinite(remain) && remain > 1) {',
  '    p.appendChild(document.createTextNode(" — あと "));',
  '    p.appendChild(rhNode("b", "", rhYen(remain)));',
  '  }',
  '}',
  '',
  '// フッター 2 ボタン: 旧 VITAL STRIP のクーポン枚数をここに吸収する。',
  '// 連携状態のセルは廃止した — 連携済みの人には情報価値がなく、 未連携の人には',
  '// 専用の連携 CTA カード (#shopify-link-home-card) が **この直下** (HOME_IA_ORDER: rank-card 0 →',
  '// next-move 1 → shopify-link 2) にあるため。 同じ CTA を 2 枚並べない。',
  'function rhFoot() {',
  '  var foot = rhNode("div", "rh-foot");',
  '  var coupon = document.createElement("button");',
  '  coupon.type = "button";',
  '  coupon.id = "rh-coupon";',
  '  var cIcon = rhNode("span", "", "\u{1F39F}️");',
  '  cIcon.setAttribute("aria-hidden", "true");',
  '  coupon.appendChild(cIcon);',
  '  // 🚨 ここに静的な「クーポン」を置かないこと。 文言は updateVsCouponCell が全文を持つので、',
  '  //    置くと「クーポン クーポン 3枚」と二重に出る (採点ループ P1・実際に出荷直前まで残っていた)。',
  '  var cLabel = rhNode("span", "", "");',
  '  cLabel.id = "rh-coupon-label";',
  '  coupon.appendChild(cLabel);',
  '  coupon.addEventListener("click", function () { vsJumpCoupons(); });',
  '  foot.appendChild(coupon);',
  '  var sep = rhNode("span", "rh-sep");',
  '  sep.setAttribute("aria-hidden", "true");',
  '  foot.appendChild(sep);',
  '  var detail = document.createElement("button");',
  '  detail.type = "button";',
  '  detail.id = "rh-detail";',
  '  var dIcon = rhNode("span", "", "\u{1F6CD}️");',
  '  dIcon.setAttribute("aria-hidden", "true");',
  '  detail.appendChild(dIcon);',
  '  detail.appendChild(rhNode("span", "", "会員特典を見る →"));',
  '  detail.addEventListener("click", function () { openFeaturePage("/liff/my-rank"); });',
  '  foot.appendChild(detail);',
  '  return foot;',
  '}',
  '',
  'function rhReset(el, isAmb) {',
  '  el.className = "card" + (isAmb ? " rank-ambassador" : "");',
  '  el.textContent = "";',
  '  if (!isAmb) return;',
  '  // アンバサダーの金の環境光 (旧カードから踏襲)。 .rank-ambassador が position:relative を持つ',
  '  var dots = rhNode("div", "sparkle-dots");',
  '  dots.setAttribute("aria-hidden", "true");',
  '  var spots = [[12, 85, 0], [35, 10, 0.6], [70, 78, 1.2], [55, 25, 0.3], [20, 55, 0.9]];',
  '  for (var i = 0; i < spots.length; i++) {',
  '    var d = rhNode("div", "sparkle-dot");',
  '    d.style.top = spots[i][0] + "%";',
  '    d.style.left = spots[i][1] + "%";',
  '    d.style.animationDelay = spots[i][2] + "s";',
  '    dots.appendChild(d);',
  '  }',
  '  el.appendChild(dots);',
  '}',
  '',

  '',
  'function renderRankHero(loyalty, isAmb) {',
  '  var el = document.getElementById("rank-card");',
  '  if (!el) return;',
  '  var rank = (loyalty && loyalty.rank) || null;',
  '  if (!rank) { renderRankHeroUnknown(el); return; }',
  '  rhReset(el, isAmb);',
  '',
  '  var top = rhNode("div", "rh-top");',
  '  top.appendChild(rhMedal(rank));',
  '  var head = rhNode("span", "rh-head");',
  '  head.appendChild(rhNode("span", "rh-label", "会員ランク"));',
  '  var name = rhNode("span", "rh-name", String(rank.name || "") + "会員");',
  '  name.id = "rh-name";',
  '  head.appendChild(name);',
  '  if (isAmb) {',
  '    var amb = rhNode("span", "ambassador-badge", "✨ Ambassador");',
  '    amb.style.marginLeft = "6px";',
  '    name.appendChild(amb);',
  '  }',
  '  var pct = Number(rank.discountPercent);',
  '  var hasOff = RANK_DISCOUNT_ON && isFinite(pct) && pct > 0;',
  '  var off = rhNode("span", hasOff ? "rh-off" : "rh-off is-none",',
  '    hasOff ? "通常購入 " + Math.floor(pct) + "% OFFクーポン"',
  '      : (RANK_DISCOUNT_ON ? "割引特典はこれから" : "割引特典は準備中です"));',
  '  off.id = "rh-off";',
  '  head.appendChild(off);',
  '  // 🚨 ランク割引コード (NLR-) には必ず ¥2,000 の最低購入金額が付く',
  '  //    (services/rank-discount-issuer.ts の minimumRequirement)。% だけ見せると有利誤認になる。',
  '  //    いま持っている割引のときは主張の真下に、 次ランクの予告だけのときは その行の真下に置く。',
  '  var nextPct = Number(loyalty.next && loyalty.next.discountPercent);',
  '  var showsAnyPct = hasOff || (RANK_DISCOUNT_ON && isFinite(nextPct) && nextPct > 0);',
  '  if (hasOff) { head.appendChild(rhCond()); }',
  '  top.appendChild(head);',
  '  el.appendChild(top);',
  '',
  '  var body = rhNode("div", "rh-body");',
  '  var spent = Number(loyalty.trailing12moJpy) || 0;',
  '  if (spent > 0) {',
  '    var sp = rhNode("span", "rh-spent", "ランクに反映されたお買い上げ（直近 12 ヶ月） " + rhYen(spent));',
  '    sp.id = "rh-spent";',
  '    body.appendChild(sp);',
  '  }',
  '  // 記録が 1 円も無いときは空のバーを出さない (0% の空バーは進捗があるかのように誤読される)',
  '  var fill = null;',
  '  if (spent > 0) {',
  '    var bar = rhNode("span", "rh-bar");',
  '    bar.setAttribute("aria-hidden", "true");',
  '    fill = rhNode("i", "");',
  '    fill.id = "rh-bar-fill";',
  '    bar.appendChild(fill);',
  '    body.appendChild(bar);',
  '  }',
  '  var nextP = rhNode("p", "rh-next");',
  '  nextP.id = "rh-next";',
  '  rhFillNextLine(nextP, loyalty.next);',
  '  body.appendChild(nextP);',
  '  // 現在の割引が無くても次ランクの % を出す以上、条件はどこかに必ず添える',
  '  if (!hasOff && showsAnyPct) { body.appendChild(rhCond()); }',
  '  // 🚨 ヒーロー自身は「連携すると反映されます」と書かない。 その約束は真下の連携 CTA カード',
  '  //    (#shopify-link-home-card) が MEMBER_BACKFILL_ENABLED 連動でサーバ側から出し分ける。',
  '  //    ここは判定の**根拠**だけを述べる (「なぜレギュラーなのか」に答えつつ、何も約束しない)。',
  '  if (spent <= 0) {',
  '    var note = rhNode("p", "rh-note", "会員ランクは、公式ストアでのお買い物の記録から判定しています");',
  '    note.id = "rh-note";',
  '    body.appendChild(note);',
  '  }',
  '  el.appendChild(body);',
  '  el.appendChild(rhFoot());',
  '',
  '  if (fill) {',
  '    var ratio = Math.max(0, Math.min(1, Number(loyalty.progressRatio) || 0));',
  '    var w = Math.round(ratio * 100) + "%";',
  '    if (TAB_REDUCED_MOTION) { fill.style.width = w; }',
  '    else { setTimeout(function () { fill.style.width = w; }, 80); }',
  '  }',
  '  updateVsCouponCell();',
  '}',
  '',
  '// ランクが取れなかったとき。 分からないものを断定せず、 会員証ページへ逃がす。',
  'function renderRankHeroUnknown(el) {',
  '  rhReset(el, false);',
  '  var top = rhNode("div", "rh-top");',
  '  var medal = rhNode("span", "rh-medal");',
  '  medal.setAttribute("aria-hidden", "true");',
  '  medal.appendChild(rhNode("span", "rh-emoji", "\u{1F331}"));',
  '  top.appendChild(medal);',
  '  var head = rhNode("span", "rh-head");',
  '  head.appendChild(rhNode("span", "rh-label", "会員ランク"));',
  '  var name = rhNode("span", "rh-name", "ただいま確認中");',
  '  name.id = "rh-name";',
  '  head.appendChild(name);',
  '  // 取得失敗の退避表示も gate に従う (Codex P2)。 gate off では issueRankDiscountForFriend が',
  '  // 1 枚も発行しないので、 ここで「割引特典が受けられます」と言うと受け取れない割引の広告になる。',
  '  var off = rhNode("span", "rh-off is-none",',
  '    RANK_DISCOUNT_ON ? "会員ランクに応じた割引クーポンがあります" : "ランクの割引特典は準備中です");',
  '  off.id = "rh-off";',
  '  head.appendChild(off);',
  '  top.appendChild(head);',
  '  el.appendChild(top);',
  '  el.appendChild(rhFoot());',
  '  updateVsCouponCell();',
  '}',
].join('\n  ');
