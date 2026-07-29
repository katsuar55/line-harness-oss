/**
 * inline <script> に値を埋め込むための安全化ユーティリティ (2026-07-29)
 *
 * ## なぜ必要か
 * HTML parser は script data state において、コメント内・文字列内を **一切区別せず**
 * 最初の終了タグ (`</script` + 空白 / `/` / `>`) でスクリプトを打ち切る。
 * 打ち切られた断片は文法的に valid なことが多く、parse 検証をすり抜ける。
 * 実害: /liff/opt-in がコメント内の終了タグ 1 個で 2.5 ヶ月間まったく動かなかった
 * (2026-05-17〜07-29)。同型の欠陥が /t/:linkId にもあり、そちらは
 * ユーザ指定 URL 経由で **任意マークアップ注入** まで成立していた。
 *
 * ## 使い分け (ここを間違えると静かに壊れる)
 * - `jsonForScript`  : `<script>` の中の **JS 値** に使う。`<` `>` `&` を \\u00XX へ。
 *                      script data state では実体参照が復号されないため、`&amp;` を
 *                      使うと文字列が literal に壊れる (URL の `&t=30` → `&amp;t=30`)。
 * - `escapeHtmlAttr` : **HTML 属性値** に使う。こちらは実体参照が正しく復号される。
 */

/** JS line terminator (JSON では生のまま出るが JS ソースでは行末扱いになり構文を壊す)。 */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * inline script 内の JS 値として安全な JSON 文字列を返す (引用符込み)。
 * `<` `>` `&` を Unicode escape、U+2028/U+2029 (JS line terminator) も escape する。
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEPARATOR)
    .join('\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\u2029');
}

/** HTML 属性値として安全にエスケープする (属性値では実体参照が復号されるので `&amp;` で正しい)。 */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * inline script の **本体** (静的テンプレート) を安全化する。
 *
 * `jsonForScript` が守るのは「埋め込む値」だけで、テンプレートに直書きされた
 * 静的テキスト (コメント・文字列リテラル) は完全に無防備だった。これが今回の障害の
 * 直接原因なので、本体側にも構造的な防御を置く。
 *
 * 未エスケープの `</script` だけを `<\/script` に置換する。ブラウザから見た JS の
 * 意味は変わらない (文字列・コメントいずれでも同一) が、タグは閉じなくなる。
 * TS ソース上で既に `<\/script` と書かれている箇所 (正規表現リテラル等) は
 * パターンに一致しないため二重エスケープにならない。
 */
export function inlineScriptBody(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}
