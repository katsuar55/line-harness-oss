/**
 * HTML レスポンスの キャッシュ無効化 (2026-08-23)。
 *
 * 🚨 発覚した事故: LIFF ページ 7 本と管理画面 5 本の HTML は、
 *   リポジトリ開設以来 **Cache-Control / ETag / Last-Modified を 1 つも返していなかった**
 *   (2026-08-22 本番実測)。妥当性情報 (validator) が皆無な HTML を受け取った
 *   LINE の in-app WebView (iOS WKWebView / Android WebView) はヒューリスティック
 *   キャッシュに落ち、deploy 済みの新 HTML が実機に反映されない。
 *   実際に #270 (再注文シート視覚改修) を deploy し curl では新マーカーが確認できるのに、
 *   オーナー実機は「何も変わっていない」状態になった。
 *
 * 方針: **HTML だけ** no-store。理由:
 *   - portal は gzip 後 100KB (実測)。毎回取り直しても許容範囲
 *   - ETag 方式 (no-cache + 条件付き GET) は 343KB のハッシュ計算を毎リクエスト行うため、
 *     Workers 無料枠の CPU 10ms 制限を圧迫する。correctness を優先し no-store を採る
 *   - 画像 (brand-logo.png = immutable 1 週間) や JSON API は **Content-Type で自動的に対象外**。
 *     パスの denylist にしない (新ページ追加時に付け忘れる = CLAUDE.md の allowlist 原則と同じ思想)
 *   - 既に Cache-Control を明示しているルート (app-proxy の NO_STORE 等) は上書きしない
 *
 * 単一の chokepoint に置くこと。各ハンドラで個別に付ける方式は、
 * 新しい LIFF ページを足した人が忘れた瞬間に同じ事故が再発する。
 */
import type { Context, Next } from 'hono';

/** この値を返す。must-revalidate は no-store と重複するが、古い WebView 対策として残す */
export const HTML_CACHE_CONTROL = 'no-store, no-cache, must-revalidate';

export async function htmlNoStoreMiddleware(c: Context, next: Next): Promise<void> {
  await next();

  const res = c.res;
  if (!res) return;

  // Content-Type で判定する (パスで判定しない)。text/html 以外は一切触らない
  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return;

  // 明示的に Cache-Control を設定しているハンドラの意図を尊重する
  if (res.headers.get('Cache-Control')) return;

  res.headers.set('Cache-Control', HTML_CACHE_CONTROL);
  // HTTP/1.0 のみを解する古い中継・WebView 向け (LINE の Android WebView は端末により古い)
  res.headers.set('Pragma', 'no-cache');
}
