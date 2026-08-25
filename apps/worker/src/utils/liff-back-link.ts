/**
 * サブ LIFF ページの「← マイページ」を **本物の戻る** にする (2026-08-25)。
 *
 * ## 直したこと
 * 各サブページ (会員証 / 食事 / AI コーチ / 再購入 / メール設定) の戻りリンクは
 * 素の `<a href="/liff/portal">` だった。これは戻るではなく**前進遷移**なので、
 * 履歴が `portal → my-rank → portal → …` と積み上がる。その状態で端末の戻るを押すと
 * 「戻ったのに 1 つ前の画面 (my-rank) に進む」ように見え、ミニアプリを閉じるまで
 * 何度も押す羽目になる。オーナー報告「戻るボタンの挙動がおかしい」の一部。
 *
 * ## 方針
 * リンクはそのまま `href` を持たせる (JS が落ちても動く)。クリック時に
 * 「**直前の履歴エントリが本当にその行き先である**」と確認できたときだけ `history.back()`
 * に差し替える。確認できなければ従来どおり前進遷移する (安全側)。
 *
 * 確認の条件:
 *   1. `document.referrer` の path が、リンクの href の path と一致する
 *      (= 直前の文書がその行き先そのもの)
 *   2. 行き先がポータルのとき、ポータルの離脱スナップショットが `via: 'replace'` でない
 *      — リッチメニュー `#rank` は `location.replace('/liff/my-rank')` でポータルの
 *      履歴エントリを**上書き**している。このとき referrer はポータルを指すのに、
 *      戻り先はポータルではない (ミニアプリが閉じる)。referrer だけを信じると外す。
 *
 * ## 注意
 * - inline script は CLAUDE.md の LIFF ルールに従い文字列配列で持つ。
 * - 終了タグを literal で書かない (コメント・文字列を含む)。
 */

/** ポータルの離脱スナップショット (fragments/nav-state.ts の NAV_SNAPSHOT_KEY と同値)。 */
const NAV_SNAPSHOT_KEY = 'nx_portal_nav_v1';

/**
 * 戻りリンクに付ける属性。script はこの属性で対象を集める。
 * 各ページの `<a>` に手で書く (見た目の class がページごとに違うため markup は共有しない)。
 * `href` は必ず残すこと — JS が無効/失敗しても前進遷移で行き先に着く。
 */
export const LIFF_BACK_ATTR = 'data-liff-back';

const BACK_LINK_JS: string = [
  '(function () {',
  '  var NAV_KEY = ' + JSON.stringify(NAV_SNAPSHOT_KEY) + ';',
  '  function trimSlash(p) {',
  '    return (p && p.length > 1 && p.charAt(p.length - 1) === "/") ? p.slice(0, -1) : p;',
  '  }',
  '  // ポータルが location.replace で去った直後は、referrer がポータルを指していても',
  '  // 戻り先はポータルではない (エントリが上書きされている)。そのときは前進遷移に倒す。',
  '  function portalEntryWasReplaced() {',
  '    try {',
  '      var raw = window.sessionStorage.getItem(NAV_KEY);',
  '      if (!raw) return false;',
  '      var rec = JSON.parse(raw);',
  '      return !!rec && rec.via === "replace";',
  '    } catch (e) { return false; }',
  '  }',
  '  function previousIs(href) {',
  '    if (!document.referrer) return false;',
  '    try {',
  '      var target = new URL(href, window.location.origin);',
  '      var ref = new URL(document.referrer, window.location.origin);',
  '      if (ref.origin !== target.origin) return false;',
  '      if (trimSlash(ref.pathname) !== trimSlash(target.pathname)) return false;',
  '      if (trimSlash(target.pathname) === "/liff/portal" && portalEntryWasReplaced()) return false;',
  '      return true;',
  '    } catch (e) { return false; }',
  '  }',
  '  function onClick(ev) {',
  '    var el = ev && ev.currentTarget;',
  '    if (!el || !el.getAttribute) return;',
  '    var href = el.getAttribute("href");',
  '    if (!href || !previousIs(href)) return;',
  '    if (!(window.history && window.history.length > 1)) return;',
  '    if (ev.preventDefault) ev.preventDefault();',
  '    window.history.back();',
  '  }',
  '  function wire() {',
  '    var nodes = document.querySelectorAll("[' + LIFF_BACK_ATTR + ']");',
  '    for (var i = 0; i < nodes.length; i++) { nodes[i].addEventListener("click", onClick); }',
  '  }',
  '  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", wire); }',
  '  else { wire(); }',
  '})();',
].join('\n');

/** ページ末尾に置く script タグ (utils/liff-watchdog.ts と同じ流儀)。 */
export function liffBackLinkScriptTag(): string {
  return '<script>\n' + BACK_LINK_JS + '\n</' + 'script>';
}
