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
 *   2. 行き先がポータルのとき、この URL に `?entry=replace` が付いていない
 *      — リッチメニュー `#rank` は `location.replace('/liff/my-rank?entry=replace')` で
 *      ポータルの履歴エントリを**上書き**している。このとき referrer はポータルを指すのに、
 *      戻り先はポータルではない (ミニアプリが閉じる)。referrer だけを信じると外す。
 *      印はクエリ名で引いて値を照合する (部分一致は別パラメータの値を誤検出する)。
 *
 * ## 注意
 * - inline script は CLAUDE.md の LIFF ルールに従い文字列配列で持つ。
 * - 終了タグを literal で書かない (コメント・文字列を含む)。
 */

/**
 * ポータルが `location.replace` で去ったことを示す印 (liff-pages.ts の #rank 集約 redirect が付ける)。
 *
 * 🚨 これを sessionStorage で持ってはいけない。 守りたい事実は「**この履歴エントリ**は replace で
 * 作られた」というエントリ固有かつ永続の性質なのに、sessionStorage はセッションに 1 つしかない
 * 可変スロットで、後続のポータル文書が pagehide のたびに同じキーを上書きする。 上書きされた後に
 * 端末の戻るでそのエントリへ復帰すると guard が外れ、preventDefault 済みのまま history.back() が
 * ミニアプリを閉じる方向へ走る (採点ループ P2)。 URL のクエリなら履歴エントリと一緒に復元される。
 */
export const LIFF_ENTRY_REPLACED_KEY = 'entry';
export const LIFF_ENTRY_REPLACED_VALUE = 'replace';
/** URL に付ける形 (liff-pages.ts の redirect が使う)。 */
export const LIFF_ENTRY_REPLACED_PARAM = `${LIFF_ENTRY_REPLACED_KEY}=${LIFF_ENTRY_REPLACED_VALUE}`;

/**
 * 戻りリンクに付ける属性。script はこの属性で対象を集める。
 * 各ページの `<a>` に手で書く (見た目の class がページごとに違うため markup は共有しない)。
 * `href` は必ず残すこと — JS が無効/失敗しても前進遷移で行き先に着く。
 */
export const LIFF_BACK_ATTR = 'data-liff-back';

const BACK_LINK_JS: string = [
  '(function () {',
  '  function trimSlash(p) {',
  '    return (p && p.length > 1 && p.charAt(p.length - 1) === "/") ? p.slice(0, -1) : p;',
  '  }',
  '  // ポータルが location.replace で去ったエントリでは、referrer がポータルを指していても',
  '  // 戻り先はポータルではない (エントリが上書きされている)。 印は URL に載っているので、',
  '  // このページのどの履歴エントリでも・何度戻ってきても同じ答えになる。',
  '  function entryWasReplaced() {',
  '    try {',
  '      // 🚨 部分一致で探さない。 別パラメータの値に同じ文字列が埋まっていると誤検出し、',
  '      //    正当な戻るを拒否して履歴をもう 1 段積む (Codex P3)。 名前で引いて値を照合する。',
  '      var q = new URLSearchParams(String(window.location.search || ""));',
  '      return q.get(' + JSON.stringify(LIFF_ENTRY_REPLACED_KEY) + ') === ' + JSON.stringify(LIFF_ENTRY_REPLACED_VALUE) + ';',
  '    } catch (e) { return true; }',
  '  }',
  '  function previousIs(href) {',
  '    if (!document.referrer) return false;',
  '    try {',
  '      var target = new URL(href, window.location.origin);',
  '      var ref = new URL(document.referrer, window.location.origin);',
  '      if (ref.origin !== target.origin) return false;',
  '      if (trimSlash(ref.pathname) !== trimSlash(target.pathname)) return false;',
  '      if (trimSlash(target.pathname) === "/liff/portal" && entryWasReplaced()) return false;',
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
