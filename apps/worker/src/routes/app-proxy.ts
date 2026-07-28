/**
 * Shopify App Proxy ルート (2026-07-29)
 *
 *   GET /proxy/line-link — storefront `/apps/line-link` から App Proxy 経由で転送される公開エンドポイント。
 *     署名検証は service (handleAppProxyLinkEntry) が行う。 認証 skip は GET 限定
 *     ([[feedback_auth_skiplist_method_independent]] = method 非依存 skip の穴を作らない)。
 *
 * 応答はすべて自己完結の静的 HTML (ブランドティール)。 動的値は LIFF redirect URL のみで、
 * それも env 由来 + 自前発行 token (base64url) に限定し attribute-escape して埋め込む
 * (= ユーザ入力を一切 HTML に反映しない → XSS 面ゼロ。 inline JS も書かない = #193 クラス回避)。
 *
 * 注意: App Proxy は Set-Cookie を剥がすため cookie は使えない。 状態は sub_link_tokens 行のみ。
 */

import { Hono } from 'hono';
import { handleAppProxyLinkEntry } from '../services/app-proxy-link.js';
import type { Env } from '../index.js';

const appProxy = new Hono<Env>();

/** HTML attribute / text 用の最小エスケープ (埋め込むのは自前 URL のみだが深層防御)。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 共通シェル。 60代可読性トークン (§10-6) に合わせ 16px+ / コントラスト AA。
 * meta refresh は ready ページのみ (= JS なしで LINE へ送り返す)。
 */
function page(opts: { title: string; emoji: string; body: string; refreshUrl?: string }): string {
  const refresh = opts.refreshUrl
    ? `<meta http-equiv="refresh" content="0;url=${esc(opts.refreshUrl)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
${refresh}<title>${esc(opts.title)} | naturism</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
         background:#f6faf9; color:#1f2937; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; border:1px solid #d8ece9; border-radius:20px; box-shadow:0 8px 24px rgba(15,118,110,.08);
          max-width:420px; margin:16px; padding:32px 24px; text-align:center; }
  .emoji { font-size:44px; margin-bottom:12px; }
  h1 { font-size:19px; font-weight:700; margin:0 0 12px; color:#0f766e; }
  p { font-size:16px; line-height:1.7; margin:0 0 20px; color:#374151; }
  .btn { display:inline-block; background:#0e9f97; color:#fff; text-decoration:none; font-weight:700;
         font-size:16px; padding:14px 28px; border-radius:9999px; }
  .note { font-size:13px; color:#6b7280; margin-top:16px; }
</style>
</head>
<body>
<div class="card">
  <div class="emoji">${opts.emoji}</div>
  <h1>${esc(opts.title)}</h1>
  ${opts.body}
</div>
</body>
</html>`;
}

appProxy.get('/proxy/line-link', async (c) => {
  try {
    const query = new URL(c.req.url).searchParams;
    const result = await handleAppProxyLinkEntry(c.env, query);

    if (!result.ok) {
      if (result.code === 'disabled') {
        // dormant: 存在を露出しない (storefront には店のテーマの 404 相当として見える)
        return c.text('Not Found', 404);
      }
      if (result.code === 'misconfigured') {
        return c.text('Service Unavailable', 503);
      }
      console.warn('[app-proxy] unauthorized proxy request:', result.reason);
      return c.text('Unauthorized', 401);
    }

    if (result.state === 'login_required') {
      // App Proxy 応答は storefront ドメインで表示されるため相対 URL でログインへ誘導できる
      // (= classic / new customer accounts どちらでも Shopify 側が適切なログイン画面へ振る)。
      return c.html(
        page({
          title: 'ログインしてLINEと連携',
          emoji: '🔑',
          body: `<p>LINEとの連携には、オンラインストアへのログインが必要です。<br>ログイン後、もう一度このページが開きます。</p>
  <a class="btn" href="/account/login?return_url=%2Fapps%2Fline-link">ログインする</a>
  <p class="note">アカウントをお持ちでない場合は、ご購入時に作成できます。</p>`,
        }),
      );
    }

    if (result.state === 'already_linked') {
      return c.html(
        page({
          title: 'すでに連携済みです',
          emoji: '✅',
          body: `<p>このアカウントは、すでにLINEと連携されています。<br>特典やお知らせはLINEでお届けしています。</p>
  <p class="note">別のLINEアカウントへ変更したい場合は、LINEのトークからサポートへご連絡ください。</p>`,
        }),
      );
    }

    // ready: 即 LINE (LIFF) へ送り返す。 meta refresh + ボタン (JS なし)。
    return c.html(
      page({
        title: 'LINEに戻って連携を完了',
        emoji: '🌿',
        refreshUrl: result.redirectUrl,
        body: `<p>ログインを確認しました。<br>自動でLINEが開き、連携の最終確認が表示されます。</p>
  <a class="btn" href="${esc(result.redirectUrl)}">LINEを開いて連携する</a>
  <p class="note">画面が切り替わらない場合は、上のボタンを押してください。</p>`,
      }),
    );
  } catch (err) {
    console.error('GET /proxy/line-link error:', err);
    return c.text('Internal Server Error', 500);
  }
});

export { appProxy };
