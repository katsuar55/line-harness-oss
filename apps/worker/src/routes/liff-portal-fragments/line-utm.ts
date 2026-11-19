/**
 * ミニアプリ (LIFF) から公式ストアへ出るリンクに、計測の印を付ける (2026-11-19・L-1)。
 *
 * ## なぜ
 * ミニアプリから Shopify へ出るリンクは、リッチメニュー以外に UTM が付いておらず、
 * 「LINE のどの画面が訪問と購入につながったか」を測れなかった。
 *
 * ## 何をするか
 * - 公式ストアのホスト (naturism-diet.com / www.) のリンクだけに付ける。外部 (SNS・決済) は触らない。
 * - 既に utm_source があるリンクは触らない (配信側で明示した印を上書きしない)。
 * - `/apps/` (App Proxy の連携入口) は署名つきの経路なので触らない。
 * - 付ける値: utm_source=line / utm_medium=miniapp / utm_campaign=<画面> / utm_content=<任意>
 * - カートへ直行する `/cart/` リンクには `ref=line-miniapp-<画面>` も付ける
 *   (Shopify は直行リンクの UTM を確実には拾わないが、ref は注文の「参照コード」に残る)。
 * - 画面名は、押された要素を囲む `section-<名前>` の id から取る (home / quiz / shop / intake / account)。
 *   `data-utm-campaign` / `data-utm-content` を書いた要素はその値を優先する。
 *
 * ## 仕組み
 * - クリックの capture 段階で `<a href>` を書き換える (既存の各リンクを1つずつ直さなくてよい)。
 * - `openExternalUrl()` 経由の遷移は、直前に押された要素の画面名を使う (`nxLineUtm` を呼ぶ)。
 *
 * ## 注意
 * client JS は文字列配列で持つ (template literal のエスケープ潰れを構造的に避ける —
 * バックスラッシュを1文字も使わない)。
 */

export const LINE_UTM_STORE_HOSTS = ['naturism-diet.com', 'www.naturism-diet.com'] as const;

export function lineUtmJs(defaultCampaign = 'portal'): string {
  const fallback = JSON.stringify(defaultCampaign);
  const hosts = JSON.stringify(
    Object.fromEntries(LINE_UTM_STORE_HOSTS.map((h) => [h, 1])),
  );
  return [
    '// ─── 公式ストアへのリンクに計測の印 (L-1・2026-11-19) ───',
    '// 設計は routes/liff-portal-fragments/line-utm.ts の冒頭コメント。',
    'var NX_UTM_HOSTS = ' + hosts + ';',
    'var NX_UTM_DEFAULT = ' + fallback + ';',
    'var nxLastUtmCampaign = null;',
    'var nxLastUtmContent = null;',
    'function nxLineUtm(url, campaign, content) {',
    '  try {',
    '    var u = new URL(String(url), window.location.href);',
    '    if (!NX_UTM_HOSTS[u.hostname]) return url;',
    "    if (u.pathname.indexOf('/apps/') === 0) return url;",
    "    if (u.searchParams.get('utm_source')) return url;",
    '    var c = campaign || NX_UTM_DEFAULT;',
    "    u.searchParams.set('utm_source', 'line');",
    "    u.searchParams.set('utm_medium', 'miniapp');",
    "    u.searchParams.set('utm_campaign', c);",
    "    if (content) u.searchParams.set('utm_content', String(content));",
    "    if (u.pathname.indexOf('/cart/') === 0 && !u.searchParams.get('ref')) {",
    "      u.searchParams.set('ref', 'line-miniapp-' + c);",
    '    }',
    '    return u.toString();',
    '  } catch (e) { return url; }',
    '}',
    'function nxUtmCampaignFor(el) {',
    '  var n = el;',
    '  while (n && n.nodeType === 1) {',
    "    var dc = n.getAttribute('data-utm-campaign');",
    '    if (dc) return dc;',
    "    if (n.id && n.id.indexOf('section-') === 0) return n.id.slice(8);",
    '    n = n.parentNode;',
    '  }',
    '  return NX_UTM_DEFAULT;',
    '}',
    'function nxUtmContentFor(el) {',
    '  var n = el;',
    '  while (n && n.nodeType === 1) {',
    "    var v = n.getAttribute('data-utm-content');",
    '    if (v) return v;',
    '    n = n.parentNode;',
    '  }',
    '  return null;',
    '}',
    "document.addEventListener('click', function (ev) {",
    '  var t = ev.target;',
    '  if (!t || t.nodeType !== 1) { t = t && t.parentNode; }',
    '  if (!t || !t.closest) return;',
    '  nxLastUtmCampaign = nxUtmCampaignFor(t);',
    '  nxLastUtmContent = nxUtmContentFor(t);',
    "  var a = t.closest('a[href]');",
    '  if (!a) return;',
    "  var href = a.getAttribute('href');",
    "  if (!href || href.charAt(0) === '#') return;",
    '  var next = nxLineUtm(a.href, nxLastUtmCampaign, nxLastUtmContent);',
    '  if (next !== a.href) a.href = next;',
    '}, true);',
    '// openExternalUrl などスクリプトからの遷移用: 直前に押された画面名で印を付ける',
    'function nxLineUtmLast(url) {',
    '  return nxLineUtm(url, nxLastUtmCampaign, nxLastUtmContent);',
    '}',
  ].join('\n');
}
