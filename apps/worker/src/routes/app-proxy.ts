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

/**
 * ready 応答は単回限りの連携トークン (capability) を本文に含むのに、 URL は全顧客で同一
 * (`/apps/line-link`)。 共有キャッシュ (企業プロキシ / storefront 前段 / 共有端末) が
 * ヒューリスティック保存すると、 顧客 A の token ページが顧客 B に配られる (R1 採点 MED)。
 * 全応答に付ける (状態ごとに差があると、 それ自体がキャッシュ層への情報になるため)。
 */
const NO_STORE = { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' } as const;

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
function page(opts: { title: string; emoji: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>${esc(opts.title)} | naturism</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
         background:#f6faf9; color:#1f2937; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; border:1px solid #d8ece9; border-radius:20px; box-shadow:0 8px 24px rgba(15,118,110,.08);
          max-width:420px; margin:16px; padding:32px 24px; text-align:center; }
  .emoji { font-size:44px; margin-bottom:12px; }
  h1 { font-size:20px; font-weight:700; margin:0 0 12px; color:#0f766e; }
  p { font-size:16px; line-height:1.7; margin:0 0 20px; color:#374151; }
  /* #0f766e = ポータル btn-primary と同一トークン (白文字 5.47:1 = WCAG AA)。
     初版で使っていた明るいティールは白文字 3.27:1 で AA 不合格だった (R1 採点 MED)。 */
  .btn { display:inline-block; background:#0f766e; color:#fff; text-decoration:none; font-weight:700;
         font-size:17px; padding:16px 30px; border-radius:9999px;
         transition:transform .12s ease-out, box-shadow .12s ease-out; box-shadow:0 3px 10px rgba(15,118,110,.24); }
  .btn:active { transform:translateY(1px) scale(.98); box-shadow:0 1px 4px rgba(15,118,110,.2); }
  .btn-sub { display:inline-block; margin-top:14px; color:#0f766e; font-size:15px; font-weight:700; text-decoration:underline; }
  .note { font-size:15px; color:#4b5563; margin-top:18px; line-height:1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="emoji" aria-hidden="true">${opts.emoji}</div>
  <h1>${esc(opts.title)}</h1>
  ${opts.body}
</div>
</body>
</html>`;
}

/** 「利用できません」の共通ページ (= storefront 上に生テキストを出さない)。 */
function unavailablePage(): string {
  return page({
    title: 'ただいまご利用いただけません',
    emoji: 'ℹ️',
    body: `<p>この連携ページは現在ご利用いただけません。<br>お手数ですが、時間をおいてお試しください。</p>
  <p class="note">お困りのときは、LINEのトークからサポートへご連絡ください。</p>`,
  });
}

const entryHandler = async (c: {
  req: { url: string; header: (n: string) => string | undefined };
  env: Env['Bindings'];
  html: (h: string, s?: number, hdr?: Record<string, string>) => Response;
  text: (t: string, s?: number, hdr?: Record<string, string>) => Response;
}) => {
  try {
    // このページはブラウザのナビゲーションでのみ意味を持つ。 storefront に同居する
    // 第三者アプリの script が fetch('/apps/line-link') すると、 Shopify は閲覧者の
    // セッションで proxy するため、 本文の連携トークン (= capability) を読み取られる。
    // Sec-Fetch-* を送る UA ではナビゲーション以外を弾く (ヘッダ非対応 UA は従来通り通す)。
    const dest = c.req.header('sec-fetch-dest');
    const mode = c.req.header('sec-fetch-mode');
    if ((dest && dest !== 'document') || (mode && mode !== 'navigate')) {
      return c.text('Not Found', 404, NO_STORE);
    }

    const query = new URL(c.req.url).searchParams;
    const result = await handleAppProxyLinkEntry(c.env, query);

    if (!result.ok) {
      // 応答は「署名が正当だったか」だけで分岐させる。 gate/設定の状態で 404/503 を
      // 打ち分けると、 誰でも叩ける workers.dev から「有効化されたか」「secret が入ったか」を
      // 無認証で監視できる設定オラクルになる (R1 採点 LOW)。
      if (result.code === 'misconfigured') {
        console.error('[app-proxy] misconfigured: SHOPIFY_CLIENT_SECRET or LIFF_URL missing');
      } else if (result.code === 'unauthorized') {
        console.warn('[app-proxy] unauthorized proxy request:', result.reason);
      }
      // 404 でもブランドページを返す (= 設定作業中や誤アクセスで storefront ドメイン上に
      // 生の "Not Found" テキストが出るのを避ける)。 status は 404 のまま = 情報は増やさない。
      return c.html(unavailablePage(), 404, NO_STORE);
    }

    const liffHome = (c.env.LIFF_URL ?? '').trim();

    if (result.state === 'login_required') {
      // ログイン後の復帰は `/customer_authentication/login?return_to=<相対URL>` が公式の方式
      // (https://shopify.dev/docs/storefronts/themes/sign-in)。 `/account/login?return_url=` は
      // 文書化されておらず、 新 customer accounts では無視されて /account に着地する (R1 採点 HIGH)。
      return c.html(
        page({
          title: 'ログインしてLINEと連携',
          emoji: '🔑',
          body: `<p>LINEとの連携には、オンラインストアへのログインが必要です。<br>ログインが終わると、この連携ページに戻ります。</p>
  <a class="btn" href="/customer_authentication/login?return_to=%2Fapps%2Fline-link">ログインする</a>
  ${liffHome ? `<a class="btn-sub" href="${esc(liffHome)}">あとでLINEに戻る</a>` : ''}
  <p class="note">アカウントをお持ちでない場合は、ご購入時に作成できます。</p>`,
        }),
        200,
        NO_STORE,
      );
    }

    if (result.state === 'already_linked') {
      // 外部ブラウザ側には訪問者の LINE identity が無いため、連携先が「あなたのLINE」かは
      // 構造的に判定できない (家族共有・機種変で別 LINE のことがある)。断定しない。
      return c.html(
        page({
          title: 'すでに連携済みです',
          emoji: '✅',
          body: `<p>このお客様アカウントは、すでにいずれかのLINEアカウントと連携されています。</p>
  ${liffHome ? `<a class="btn" href="${esc(liffHome)}">LINEに戻る</a>` : ''}
  <p class="note">LINEでお知らせが届いていない場合は、連携先が別のLINEアカウントになっている可能性があります。お手数ですが、LINEのトークからサポートへご連絡ください。</p>`,
        }),
        200,
        NO_STORE,
      );
    }

    if (result.state === 'sync_pending') {
      // Shopify 側にはいるが当方の顧客データに未反映。連携させると確認材料 (連携先の表示) を
      // 出せないまま同意させることになるので、待ってもらう。
      return c.html(
        page({
          title: 'もう少しお待ちください',
          emoji: '⏳',
          body: `<p>お客様情報の反映に少しお時間をいただいています。<br>数分ほどおいてから、もう一度お試しください。</p>
  ${liffHome ? `<a class="btn" href="${esc(liffHome)}">LINEに戻る</a>` : ''}
  <p class="note">何度お試しになってもこの画面が出る場合は、LINEのトークからサポートへご連絡ください。</p>`,
        }),
        200,
        NO_STORE,
      );
    }

    // ready: タップで LINE へ戻す。
    // **meta refresh は使わない** — iOS/Android の universal link / App Link は自動遷移では
    // 発火せず、 外部ブラウザ内で LIFF endpoint が開いて LINE ログインを再要求する
    // (= 60代ユーザーの最大の脱落点)。 ユーザーのタップだけが確実に LINE アプリを開く (R1 採点 HIGH)。
    return c.html(
      page({
        title: 'LINEに戻って連携を完了',
        emoji: '🌿',
        body: `<p>ログインを確認しました。<br>下のボタンを押すとLINEが開き、連携の最終確認が表示されます。</p>
  <a class="btn" href="${esc(result.redirectUrl)}">LINEを開いて連携する</a>
  <p class="note">うまくいかないときは、ストアの連携ページをもう一度開いてください。</p>`,
      }),
      200,
      NO_STORE,
    );
  } catch (err) {
    console.error('GET /proxy/line-link error:', err);
    return c.text('Internal Server Error', 500, NO_STORE);
  }
};

// App Proxy は prefix 配下の全サブパスを転送する (`/apps/line-link/` や
// `/apps/line-link/foo` → `/proxy/line-link/...`)。 未登録だと authMiddleware の
// 生 401 が storefront 上に露出するので、 同じハンドラに寄せる (R1 採点 LOW)。
appProxy.get('/proxy/line-link', entryHandler as never);
appProxy.get('/proxy/line-link/', entryHandler as never);
appProxy.get('/proxy/line-link/*', entryHandler as never);

export { appProxy };
