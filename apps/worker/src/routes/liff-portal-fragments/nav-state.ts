/**
 * ポータルの「戻る」を直前のタブ/位置へ戻す (2026-08-25)。
 *
 * ## 実機で起きていたこと
 * 「ミニアプリ内で画面遷移して戻るボタンをタップすると、**すべて** Shop タブの下部
 * 『再購入』に戻ってしまう」。原因は 1 つではなく 3 つが重なっていた:
 *
 * 1. **deep link が URL に残り続ける**。リッチメニュー「購入履歴・再購入」は
 *    `{LIFF_URL}#reorder` を開く。liff.init() が hash を復元するので URL は
 *    `/liff/portal#reorder` のまま**ずっと**残り、ポータルに戻るたびに handleDeepLink() が
 *    Shop タブ + orders-card へ跳ばす。1 回だけの意図が恒久設定になっていた。
 * 2. **タブが状態としてどこにも保存されていない**。switchTab は history にも
 *    sessionStorage にも一切触らないので、ポータルを離れた瞬間に「どこを見ていたか」は消える。
 * 3. **no-store が bfcache を無効化した** (#271, 2026-08-23)。それまでは戻る操作で
 *    WebView がページを丸ごと復元していたため 2 が露見しなかったが、no-store 以降は
 *    戻る = ポータルの完全リロードになり、1 の deep link だけが唯一の「行き先」として残った。
 *
 * ## 方針
 * - deep link は **1 回で使い切る** (消費したら URL から落とす)。以後その履歴エントリは
 *   `history.state.nxTab` が行き先の正になる。
 * - タブは `history.replaceState` で**そのエントリに**書く (URL は汚さない・履歴も増やさない)。
 *   タブ切替で履歴を積むと、ミニアプリを閉じるのに戻るを何度も押す羽目になる。
 * - スクロール位置は離脱直前に sessionStorage へ退避し、**戻ってきたときだけ**復元する。
 *   新規に開いたときは復元しない (勝手に途中から始まるのは「変な所に飛ぶ」の別の形)。
 *
 * ## やらないと決めたこと
 * 全画面オーバーレイ (再注文シート / 定期便の確認) を戻るで閉じる機能は**入れない**。
 * 開くときに履歴を積む方式は、`subDupProceed()` のように「閉じる → 別のシートを開く」と
 * 連続する経路で `history.back()` の非同期traversalが後から届き、**開いたばかりの
 * 再注文シートを勝手に閉じる**競合を作る。ここは購入の money path で、
 * 過去に確認シート周りで重大バグを 3 件出している面なので、実機報告に無い改善のために
 * 競合を持ち込まない。オーバーレイ表示中の戻るは従来どおりポータルを離れる。
 *
 * ## 注意
 * - `history.replaceState` を呼ぶ既存箇所 (clearRefParam / captureSubLinkToken) は
 *   **state を引き継がせること**。`{}` で上書きすると nxTab が消えて復元先を見失う。
 * - client JS は文字列配列で持つ (template literal のエスケープ潰れを構造的に回避 —
 *   2026-07-10 の本番全損と同じ穴を踏まない)。
 */

/** 復元対象のタブ (TAB_ORDER + account)。ここに無い名前は home に丸める。 */
export const NAV_RESTORE_TABS: readonly string[] = ['home', 'quiz', 'shop', 'intake', 'account'];

/** sessionStorage キー。版を上げると古い端末の退避データを無視できる。 */
export const NAV_SNAPSHOT_KEY = 'nx_portal_nav_v1';

/** 退避の有効期限 (ms)。これを過ぎたら「別の来訪」とみなして復元しない。 */
export const NAV_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/**
 * scrollIntoView の着地点が sticky ヘッダ (53px) + タブバー (約 47px) の下に潜らないようにする。
 * リッチメニュー #reorder / #delivery の着地は従来ヘッダ下に隠れており、画面に見えるのは
 * 目的のカードではなく**その手前**だった (実機報告「再購入のあたりに戻る」の見え方の一因)。
 * Shop v2 のセンチネル (.sh-anchor-t) が既に 110px を使っているので同値に揃える。
 */
export function navStateCss(): string {
  return [
    '/* deep link / 内部ジャンプの着地がヘッダ下に潜らないように (2026-08-25) */',
    '#rank-card,#coupons-card,#referral-card,#orders-card,#fulfillments-card{scroll-margin-top:110px}',
  ].join('\n    ');
}

export function navStateJs(): string {
  return NAV_STATE_JS;
}

const NAV_STATE_JS: string = [
  '// ─── ポータルのナビ状態 (2026-08-25): 戻るで直前のタブ/位置へ ───',
  '// 設計と「やらないと決めたこと」は routes/liff-portal-fragments/nav-state.ts の冒頭コメント。',
  'var NAV_KEY = ' + JSON.stringify(NAV_SNAPSHOT_KEY) + ';',
  'var NAV_TTL_MS = ' + NAV_SNAPSHOT_TTL_MS + ';',
  'var NAV_TABS = ' + JSON.stringify(NAV_RESTORE_TABS) + ';',
  '// 離脱の理由。#rank の集約 redirect は「顧客がタブを選んだ結果」ではないので区別する',
  '// (サブページの「マイページ」リンクが history.back() で LINE を閉じてしまうのを防ぐ)。',
  'var navViaOverride = null;',
  '// この起動の行き先。 初期化の早い段階で 1 度だけ決め、 prefetch / loading 解除 / 最終適用が共有する。',
  '// 再計算しないのは、 間に走る非同期処理が URL や history.state を書き換えても答えがブレないようにするため。',
  'var navEntry = null;',
  '',
  'function navActiveTab() {',
  '  try {',
  '    var a = document.querySelector(".section.active");',
  '    if (!a || !a.id) return "home";',
  '    var n = String(a.id).replace("section-", "");',
  '    return NAV_TABS.indexOf(n) >= 0 ? n : "home";',
  '  } catch (e) { return "home"; }',
  '}',
  '',
  '// history.state を保ったまま URL だけ書き換える。',
  '// 🚨 既存の replaceState 呼び出しは必ずこれを通すこと。素の replaceState({}, ...) は',
  '//    nxTab を消し、その履歴エントリの復元先を失わせる。',
  'function navReplaceUrl(url) {',
  '  try {',
  '    var st = null;',
  '    try { st = window.history.state; } catch (e) { st = null; }',
  '    window.history.replaceState(st || {}, "", url);',
  '  } catch (e) { /* 古い WebView: URL がそのままでも復元は state/退避で効く */ }',
  '}',
  '',
  '// いま見ているタブを、この履歴エントリに書く (URL は変えない・履歴も増やさない)',
  'function navMarkTab(name) {',
  '  if (NAV_TABS.indexOf(name) < 0) return;',
  '  try {',
  '    var st = null;',
  '    try { st = window.history.state; } catch (e) { st = null; }',
  '    var next = {};',
  '    if (st && typeof st === "object") {',
  '      for (var k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) { next[k] = st[k]; } }',
  '    }',
  '    next.nxTab = name;',
  '    window.history.replaceState(next, "");',
  '  } catch (e) { /* ignore */ }',
  '}',
  '',
  'function navStateTab() {',
  '  try {',
  '    var st = window.history.state;',
  '    var t = st && st.nxTab;',
  '    return (typeof t === "string" && NAV_TABS.indexOf(t) >= 0) ? t : null;',
  '  } catch (e) { return null; }',
  '}',
  '',
  '// ─── 離脱時の退避 ───',
  'function navSnapshotRead() {',
  '  var raw = null;',
  '  try { raw = window.sessionStorage.getItem(NAV_KEY); } catch (e) { raw = null; }',
  '  if (!raw) return null;',
  '  var rec = null;',
  '  try { rec = JSON.parse(raw); } catch (e) { return null; }',
  '  if (!rec || typeof rec !== "object") return null;',
  '  if (typeof rec.tab !== "string" || NAV_TABS.indexOf(rec.tab) < 0) return null;',
  '  if (!rec.ts || (Date.now() - Number(rec.ts)) > NAV_TTL_MS) return null;',
  '  return rec;',
  '}',
  '',
  '// 「いまどこを見ていたか」を退避する。via は離脱の理由 (link = 顧客の遷移 / replace = 集約 redirect)。',
  'function navSnapshot(via) {',
  '  var y = 0;',
  '  try { y = Math.max(0, Math.round(window.pageYOffset || 0)); } catch (e) { y = 0; }',
  '  var rec = { tab: navActiveTab(), y: y, via: navViaOverride || via || "link", ts: Date.now() };',
  '  try { window.sessionStorage.setItem(NAV_KEY, JSON.stringify(rec)); } catch (e) { /* private mode 等 */ }',
  '}',
  '',
  '// ─── 復元 ───',
  '// 「戻ってきた」= ①ブラウザの戻る/進む ②自サイトの別 LIFF ページからの遷移 (マイページ リンク)',
  'function navIsReturn() {',
  '  try {',
  '    var entries = (window.performance && window.performance.getEntriesByType) ? window.performance.getEntriesByType("navigation") : null;',
  '    if (entries && entries.length && entries[0].type === "back_forward") return true;',
  '  } catch (e) { /* 古い WebView */ }',
  '  try {',
  '    if (window.performance && window.performance.navigation && window.performance.navigation.type === 2) return true;',
  '  } catch (e) { /* ignore */ }',
  '  try {',
  '    var r = String(document.referrer || "");',
  '    if (r && r.indexOf(window.location.origin) === 0 && r.indexOf("/liff/") >= 0 && r.indexOf("/liff/portal") < 0) return true;',
  '  } catch (e) { /* ignore */ }',
  '  return false;',
  '}',
  '',
  '// この起動で「どのタブを・どこまでスクロールして」出すかを 1 箇所で決める。',
  '//   deeplink … リッチメニュー等の明示的な意図 (まだ消費していないときだけ最優先)',
  '//   restore  … 戻ってきた / 同じ履歴エントリの再読み込み',
  '//   fresh    … 新規に開いた (復元しない)',
  'function navResolveEntry() {',
  '  var marked = navStateTab();',
  '  var dl = null;',
  '  try { dl = deepLinkDest(); } catch (e) { dl = null; }',
  '  if (dl && !marked) { return { tab: dl, y: 0, source: "deeplink" }; }',
  '  var rec = navSnapshotRead();',
  '  var tab = marked || (rec ? rec.tab : null);',
  '  if (tab && (marked || navIsReturn())) {',
  '    var y = (rec && rec.tab === tab) ? (Number(rec.y) || 0) : 0;',
  '    return { tab: tab, y: y, source: "restore" };',
  '  }',
  '  return { tab: "home", y: 0, source: "fresh" };',
  '}',
  '',
  '// 行き先を 1 度だけ決めて憶える。例外時も必ず有効な entry を返す (初期化を止めない)。',
  'function navResolveOnce() {',
  '  if (navEntry) return navEntry;',
  '  try { navEntry = navResolveEntry(); } catch (e) { navEntry = { tab: "home", y: 0, source: "fresh" }; }',
  '  return navEntry;',
  '}',
  '',
  '// deep link を消費する。URL から hash と page を落とし、この履歴エントリの行き先を',
  '// nxTab に固定する。これをしないと #reorder / ?page=reorder が残り続け、戻るたびに Shop へ引き戻される。',
  'function navConsumeDeepLink(tab) {',
  '  navMarkTab(tab);',
  '  try {',
  '    var url = new URL(window.location.href);',
  '    var changed = false;',
  '    if (url.hash) { url.hash = ""; changed = true; }',
  '    if (url.searchParams.has("page")) { url.searchParams.delete("page"); changed = true; }',
  '    if (!changed) return;',
  '    navReplaceUrl(url.pathname + (url.search || ""));',
  '  } catch (e) { /* URL 非対応の古い WebView: nxTab だけで復元できる */ }',
  '}',
  '',
  '// 復元スクロール。カードが順に着弾して高さが伸びるので数回打ち直す。',
  '// 顧客が自分でスクロールしたら即座にやめる (操作を奪わない)。',
  'function navRestoreScroll(y) {',
  '  if (!(Number(y) > 0)) return;',
  '  var target = Number(y);',
  '  var cancelled = false;',
  '  function onUser() { cancelled = true; }',
  '  try {',
  '    window.addEventListener("touchstart", onUser, { passive: true });',
  '    window.addEventListener("wheel", onUser, { passive: true });',
  '  } catch (e) { /* ignore */ }',
  '  var tries = 0;',
  '  function apply() {',
  '    if (cancelled) return;',
  '    try {',
  '      var doc = document.documentElement;',
  '      var max = Math.max(0, (doc ? doc.scrollHeight : 0) - (window.innerHeight || 0));',
  '      window.scrollTo(0, Math.min(target, max));',
  '    } catch (e) { /* ignore */ }',
  '    tries++;',
  '    if (tries < 5) { setTimeout(apply, 160 * tries); }',
  '  }',
  '  apply();',
  '}',
  '',
  '// ─── 配線 ───',
  '// できるだけ早く呼ぶ。ブラウザ既定のスクロール復元を切り、離脱の退避を仕掛ける。',
  'function initNavState() {',
  '  try {',
  '    if (window.history && "scrollRestoration" in window.history) { window.history.scrollRestoration = "manual"; }',
  '  } catch (e) { /* ignore */ }',
  '  try { window.addEventListener("pagehide", function () { navSnapshot("link"); }); } catch (e) { /* ignore */ }',
  '  try {',
  '    document.addEventListener("visibilitychange", function () {',
  '      if (document.visibilityState === "hidden") { navSnapshot("link"); }',
  '    });',
  '  } catch (e) { /* ignore */ }',
  '}',
  '',
  '// 行き先を確定してタブを出す。戻ってきたときだけ位置も復元する。',
  '// entry を渡すと再計算しない (初期化の早い段階で prefetch 判断に使った結果を使い回す)。',
  'function applyNavEntry() {',
  '  var e2 = navResolveOnce();',
  '  if (e2.source === "deeplink") {',
  '    try { handleDeepLink(); } catch (e) { /* ignore */ }',
  '    navConsumeDeepLink(e2.tab);',
  '    return e2;',
  '  }',
  '  if (e2.tab !== "home") {',
  '    try { switchTab(e2.tab, true); } catch (e) { /* ignore */ }',
  '  }',
  '  navMarkTab(e2.tab);',
  '  navRestoreScroll(e2.y);',
  '  return e2;',
  '}',
].join('\n  ');
