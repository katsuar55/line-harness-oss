import { Hono } from 'hono';
import type { Env } from '../index.js';
import { liffWatchdogScriptTag } from '../utils/liff-watchdog.js';
import { liffBackLinkScriptTag } from '../utils/liff-back-link.js';
import {
  NATURISM_RANK_DEFS,
  resolveFriendRank,
  getLatestRankSnapshot,
  getCouponAssignmentsByFriend,
  getActiveRankDiscountCode,
  getShopifyProducts,
  getFriendById,
  getShopifyCustomerByShopifyId,
} from '@line-crm/db';
import { parseSubscriptionRankFromTags } from '../services/subscription-rank.js';
import { buildCartPermalink, buildDiscountApplyUrl } from '../services/cart-permalink.js';
import { issueRankDiscountForFriend } from '../services/rank-discount-issuer.js';
import { MIN_SUBTOTAL_JPY } from '../services/shopify-coupon-issuer.js';
import { getActiveLinkRewardCoupon } from '../services/link-reward-coupon-issuer.js';
import { isPurchaseImportPending } from '../services/member-purchase-backfill.js';

// 顧客向けストアフロント (= 公式ドメイン)。SHOPIFY_STORE_DOMAIN は Admin/API 用なので使わない。
const STORE_DOMAIN = 'naturism-diet.com';
// 最低購入金額の表示用ラベル。Workers ランタイムの Intl に依存させないため
// toLocaleString は使わず千区切りを自前で作る (サーバ側で組み立てる文字列のため)。
const MIN_SUBTOTAL_LABEL = MIN_SUBTOTAL_JPY.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const QUICK_BUY_LIMIT = 3;

/**
 * マイランク LIFF (= 自社内製ロイヤリティ, 2026-06-01 PR4, 2026-06-03 会員証リデザイン)
 *
 * 役割: LINE ユーザーが自分の会員ランク (= trailing-12ヶ月で算出) を確認する pull 型 LIFF。
 *   - 会員証: メダルバッジ (背景を radial mask で透明化) + 英語ランク名 + 割引% + 直近12ヶ月 購入額
 *   - 次ランクまでの進捗バー + 次回の会員ランク判定日 (毎月1日)
 *   - 保有クーポン一覧 (コードのワンタップコピー)
 *   - 会員ランクについて (in-page accordion = ナビ無しで全ランク表)
 *
 * pull 型 = タップで開く LIFF のため push 課金ゼロ。豪華演出は Web (LIFF) 側で実装。
 *
 * 認証: API `/api/liff/my-rank` は liffAuthMiddleware (Authorization: Bearer idToken) で保護。
 *       検証済 friendId を c.get('liffUser') から取得。
 * 配置: ページ `/liff/my-rank` (末尾スラッシュ両対応、 公開 = HTML 自体は認証不要、 API 呼出時に検証)。
 */
const liffMyRank = new Hono<Env>();

// ─── API: 自分のランク + 保有クーポン + ランク表 ───
liffMyRank.get('/api/liff/my-rank', async (c) => {
  const liffUser = c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
  if (!liffUser) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const resolved = await resolveFriendRank(c.env.DB, liffUser.friendId, NATURISM_RANK_DEFS);
  const snapshot = await getLatestRankSnapshot(c.env.DB, liffUser.friendId);

  // ─── 自前アカウント連携 (Phase 2): UI が連携 CTA を出し分けるための 2 フラグ ───
  //   linked = 既に Shopify customer に紐付け済か (= 紐付くと過去注文が rank に反映される)
  //   accountLinkEnabled = 連携機能が有効化されているか (= ACCOUNT_LINK_ENABLED 未設定なら UI は出さない)
  const friend = await getFriendById(c.env.DB, liffUser.friendId).catch(() => null);
  const linked = !!friend?.shopify_customer_id;
  const accountLinkEnabled = c.env.ACCOUNT_LINK_ENABLED === 'true';
  // 「これまでの購入履歴をランクに反映」と書けるかの gate (2026-08-26)。
  // MEMBER_BACKFILL_ENABLED off では連携しても過去分が 1 円も反映されない
  // (verifyAccountLinkCode 内の backfill が no-op) ため、off で書くと嘘になる。
  const memberBackfillOn = c.env.MEMBER_BACKFILL_ENABLED === 'true';

  // ─── 定期便ランク (B案 2026-08-16): HB ネイティブ会員ランクのタグを読む ───
  //   HB がランク付与時に顧客タグ subscription-rank:ランク名 を書き、customers/update webhook が
  //   shopify_customers.tags へ取り込み済み。追加の外部 fetch なし・失敗しても会員証本体は表示。
  let subscriptionRank: ReturnType<typeof parseSubscriptionRankFromTags> = null;
  if (friend?.shopify_customer_id) {
    const customer = await getShopifyCustomerByShopifyId(
      c.env.DB,
      String(friend.shopify_customer_id),
    ).catch(() => null);
    subscriptionRank = parseSubscriptionRankFromTags(customer?.tags ?? null);
  }
  // 保有クーポン (= 未使用のみ)。失敗しても会員証本体は表示するため握りつぶす。
  let coupons: Array<Record<string, unknown>> = [];
  try {
    coupons = await getCouponAssignmentsByFriend(c.env.DB, liffUser.friendId, true);
  } catch {
    coupons = [];
  }

  // ─── 連携特典 ¥300 を保有クーポンに合流させる (2026-08-28) ───
  // 🚨 これが無いと、LINE 内メール OTP で連携した本人が特典を一度も見ない:
  //   ① ホームの第一候補 CTA (openAccountLinkCard) は window.location.href でこの会員証へ
  //      **フルページ遷移**する = ポータルの #link-coupon-card は破棄される
  //   ② ¥300 は line_link_coupons にしか無く、上の一覧が読む shopify_coupon_assignments には
  //      構造的に載らない → 「保有クーポン 0枚 / 利用できるクーポンはまだありません」と
  //      **持っているのに無いと言う**状態だった (本番初実行の直前 2026-08-28 に発見)
  // gate off では読まない (= portal-read と同じ扱い。kill switch で顧客画面からも消える)。
  const linkRewardCoupon =
    c.env.LINK_REWARD_ENABLED === 'true'
      ? await getActiveLinkRewardCoupon(c.env.DB, liffUser.friendId)
      : null;

  // ─── 過去注文の取り込みが未完了か (2026-08-28) ───
  // 🚨 backfill は連携応答の**後**に waitUntil で走る (¥300 発行と subrequest 予算を
  //    食い合わせないため)。その間 member_purchase_events は 0 行なので、会員証は必ず
  //    「レギュラー会員 / 直近12ヶ月 ¥0 / まずは1回のお買い物でブロンズ会員に」を出す。
  //    連携カードは「これまでのお買い物が会員ランクに反映されます」と約束しているので、
  //    このまま出すと**既存客ほど連携直後に嘘を見る**。取り込み中はそう言う。
  const purchaseImportPending =
    linked && memberBackfillOn ? await isPurchaseImportPending(c.env.DB, liffUser.friendId) : false;
  const p = resolved.progress;

  // ─── 3タップ購入 (= PR5-5b): ランク割引コード + cart permalink ───
  // ランク割引は RANK_DISCOUNT_ENABLED 有効化 (= 5c 承認後) で発行される。未発行なら null → コード無し cart に graceful。
  // PR-D: 期限切れコードは null 扱い (Shopify 側は endsAt で死んでいる) → 下の lazy 発行が
  //   再発行をトリガーし、閲覧起点で自己修復する (月次 cron の再発行と二重の網)。
  const rankDiscount = await getActiveRankDiscountCode(
    c.env.DB,
    liffUser.friendId,
    new Date().toISOString(),
  ).catch(() => null);
  // 死んだbackend修正 (Task#2): 適格 (非regular) なのに未発行なら発行をトリガー。
  //   ① RANK_DISCOUNT_ENABLED 有効時のみ呼ぶ (= gated off では呼出ゼロ・log noise なし)
  //   ② waitUntil で fire-and-forget (= Shopify 発行の最大 8s を GET hot path に乗せない)。
  //      コードは次回表示で反映 (月次 cron も proactive に発行)。 best-effort (失敗しても会員証は表示)。
  //   注: 同一会員の同時 GET で稀に orphan Shopify node が生じ得る (narrow window・UNIQUE backstop・
  //       gated 前提)。 PR3 完成後に customerSelection を顧客限定化する際に reconcile 予定。
  if (
    !rankDiscount &&
    resolved.rank.discountPercent > 0 &&
    c.env.RANK_DISCOUNT_ENABLED === 'true'
  ) {
    const friendId = liffUser.friendId;
    const issuePromise = (async () => {
      try {
        await issueRankDiscountForFriend(c.env.DB, c.env, {
          friendId,
          rankId: resolved.rank.id,
          discountPercent: resolved.rank.discountPercent,
          lineAccountId: friend?.line_account_id ?? null,
        });
      } catch (err) {
        console.error(
          '[liff-my-rank] lazy rank discount issue failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    try {
      c.executionCtx.waitUntil(issuePromise);
    } catch {
      /* tests: 実行コンテキスト無し — issuePromise は上で既に開始済 */
    }
  }
  const discountCode = rankDiscount?.code ?? null;
  const discountApplyUrl = discountCode ? buildDiscountApplyUrl(STORE_DOMAIN, discountCode) : null;

  // かんたん購入: アクティブ商品の先頭 variant で cart permalink。
  // PR-D: NLR- コードに min ¥2,000 が付いたため、¥2,000 未満の商品にはコードを**付けない**
  //   (付けても checkout で無言で外れる = 「割引適用済み」表示が虚偽になる。採点 CONFIRMED)。
  //   discounted フラグを UI に渡し、割引ラベルは適用される行にだけ出す。
  //   price 不明 (null/非数値) は安全側 = コード無しで出す。
  const quickBuy: Array<{
    title: string;
    price: string | null;
    imageUrl: string | null;
    url: string;
    discounted: boolean;
  }> = [];
  try {
    const products = await getShopifyProducts(c.env.DB, { status: 'active', limit: 8 });
    for (const prod of products) {
      let variantId: string | number | null = null;
      try {
        const variants = prod.variants_json
          ? (JSON.parse(prod.variants_json) as Array<{ id?: string | number; admin_graphql_api_id?: string }>)
          : [];
        const v = Array.isArray(variants) ? variants[0] : null;
        variantId = v ? (v.id ?? v.admin_graphql_api_id ?? null) : null;
      } catch {
        variantId = null;
      }
      const priceJpy = Number(prod.price);
      const discountEligible =
        discountCode !== null && Number.isFinite(priceJpy) && priceJpy >= MIN_SUBTOTAL_JPY;
      const url = buildCartPermalink(
        STORE_DOMAIN,
        [{ variantId, quantity: 1 }],
        discountEligible ? discountCode : null,
      );
      if (url) {
        quickBuy.push({
          title: prod.title,
          price: prod.price,
          imageUrl: prod.image_url,
          url,
          discounted: discountEligible,
        });
      }
      if (quickBuy.length >= QUICK_BUY_LIMIT) break;
    }
  } catch {
    // 商品取得失敗時は quickBuy なしで会員証本体は表示
  }

  return c.json({
    success: true,
    data: {
      rank: {
        id: resolved.rank.id,
        name: resolved.rank.name,
        discountPercent: resolved.rank.discountPercent,
        badgeEmoji: resolved.rank.badgeEmoji ?? null,
        badgeColor: resolved.rank.badgeColor ?? null,
        badgeImageUrl: resolved.rank.badgeImageUrl ?? null,
      },
      trailing12moJpy: resolved.trailing12moJpy,
      next: p.next
        ? {
            id: p.next.id,
            name: p.next.name,
            remainingJpy: p.remainingToNextJpy,
            // ホームの統合ランクヒーローと同じ shape を保つ (2026-08-25)
            discountPercent: p.next.discountPercent,
          }
        : null,
      progressRatio: p.progressRatio,
      // official = 月次 snapshot (= cron 実行後に値が入る、 未実行なら null で live のみ)
      official: snapshot
        ? { rankId: snapshot.rankId, period: snapshot.period, direction: snapshot.direction }
        : null,
      // 保有クーポン (発行済み・未使用)。連携特典は別台帳 (line_link_coupons) なので先頭に合流。
      //   🚨 金額・期限は**台帳の実値のみ**を載せる (定数を書かない = portal-read と同じ規約)。
      //   min ¥2,000 は callLinkDiscountCreate が実際に Shopify へ設定している値 (MIN_SUBTOTAL_JPY)。
      coupons: [
        ...(linkRewardCoupon
          ? [
              {
                kind: 'link_reward',
                code: linkRewardCoupon.code,
                title: `🔗 連携特典（¥${MIN_SUBTOTAL_LABEL}以上のご注文で）`,
                discountType: 'fixed_amount',
                discountValue: linkRewardCoupon.discountValue,
                expiresAt: linkRewardCoupon.expiresAt,
              },
            ]
          : []),
        ...coupons.map((a) => ({
          kind: null,
          code: a.code ?? null,
          title: a.title ?? null,
          discountType: a.discount_type ?? null,
          discountValue: a.discount_value ?? null,
          expiresAt: a.expires_at ?? null,
        })),
      ],
      // ランク表 (= 会員ランクについて accordion 用、 multi-brand 対応で defs 由来)
      ladder: NATURISM_RANK_DEFS.map((r) => ({
        id: r.id,
        name: r.name,
        discountPercent: r.discountPercent,
        minTrailing12moJpy: r.minTrailing12moJpy,
      })),
      // 3タップ購入 (= PR5-5b)。 code 自体は URL に内包 (= 認証済本人のみ取得)。
      rankDiscount: rankDiscount ? { discountPercent: rankDiscount.discountPercent } : null,
      discountApplyUrl,
      // B案 (2026-08-15 Katsu 決定 → 2026-08-16 検証ゲート通過・HB ランク公開済み):
      //   定期便×ランク% は Huckleberry ネイティブ会員ランクが担う。タグが無い顧客は null = カード非表示。
      subscriptionRank,
      quickBuy,
      // 自前アカウント連携 (Phase 2、 gated)
      linked,
      accountLinkEnabled,
      memberBackfillOn,
      // 取り込み中は金額・次ランクの文言を「反映しています」に差し替える (嘘を出さない)
      purchaseImportPending,
    },
  });
});

// ─── ページ: 会員証 SPA ───
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'); // single-quote も escape (= 単一引用符 JS 文字列への注入を防ぐ defense-in-depth)
}

const myRankPageHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  // 顧客向けストア導線は公式ストアフロント。SHOPIFY_STORE_DOMAIN は Admin/API 用ドメイン (xn--...myshopify.com) なので使わない。
  const storeDomain = 'naturism-diet.com';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(myRankPage(liffId, workerUrl, storeDomain));
};
liffMyRank.get('/liff/my-rank', myRankPageHandler as never);
liffMyRank.get('/liff/my-rank/', myRankPageHandler as never);

function myRankPage(liffId: string, apiBase: string, storeDomain: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#2fa8ad">
  <title>マイランク — naturism</title>
  ${liffWatchdogScriptTag()}
  ${liffBackLinkScriptTag()}
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent;box-sizing:border-box}
    body{font-family:'Noto Sans JP',system-ui,sans-serif;background:linear-gradient(165deg,#ecfeff 0%,#f8fafc 42%,#faf5ff 100%);min-height:100vh}
    .en{font-family:'Outfit','Noto Sans JP',sans-serif}
    .card{background:rgba(255,255,255,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:20px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.04)}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:12px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .bar-fill{transition:width 1.1s cubic-bezier(.22,1,.36,1)}
    /* メダル: 元画像の四隅(焼き込み背景)を放射状マスクで透明にフェード → 背景の箱が消える */
    .medal-wrap{position:relative;display:flex;align-items:center;justify-content:center;height:188px;margin:0 auto}
    .medal-glow{position:absolute;width:215px;height:215px;border-radius:50%;filter:blur(2px);opacity:.55}
    .medal-img{position:relative;height:188px;width:auto;max-width:200px;object-fit:contain;display:block;
      -webkit-mask-image:radial-gradient(circle at 50% 55%,#000 62%,rgba(0,0,0,.5) 78%,transparent 90%);
      mask-image:radial-gradient(circle at 50% 55%,#000 62%,rgba(0,0,0,.5) 78%,transparent 90%);
      filter:drop-shadow(0 10px 18px rgba(0,0,0,.20))}
    .badge-glow{filter:drop-shadow(0 4px 10px rgba(0,0,0,.18))}
    #loading{background:linear-gradient(165deg,#ecfeff 0%,#f8fafc 42%,#faf5ff 100%)}
    .spinner{display:inline-block;width:34px;height:34px;border:3px solid #cfe6e6;border-top-color:#0f766e;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .pop{animation:pop .55s cubic-bezier(.22,1.4,.4,1) both}
    @keyframes pop{0%{transform:scale(.7);opacity:0}100%{transform:scale(1);opacity:1}}
    .rise{animation:rise .5s ease both}
    @keyframes rise{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}
    /* #link 着地 (ホームの「メールで連携する」から) の強調。静的リング = reduced-motion でも成立 */
    .link-focus{box-shadow:0 0 0 3px rgba(15,118,110,.30),0 1px 4px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.04)}
    .ladder-row{transition:background .2s}
    .acc-body{overflow:hidden;max-height:0;transition:max-height .35s ease}
    .acc-body.open{max-height:560px}
    .chev{transition:transform .3s}
    .chev.open{transform:rotate(180deg)}
    #toast{transition:opacity .3s,transform .3s}
    .tap{transition:transform .08s}
    .tap:active{transform:scale(.96)}
  </style>
</head>
<body class="min-h-screen pb-20">

  <header class="sticky top-0 z-40" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.05)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" data-liff-back class="text-xs text-gray-500 flex items-center gap-1 tap">&larr; マイページ</a>
      <h1 class="text-base font-extrabold tracking-tight" style="color:#0f766e">&#x1F451; マイランク</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-5 space-y-4" id="main">
    <div id="demo-note" style="display:none;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;border-radius:12px;padding:8px 12px;font-size:12px;text-align:center;">&#x1F441; これはデモ表示です（サンプルデータ）。実際のランクは LINE 内で表示されます。</div>
    <section id="card-skeleton" class="card p-6">
      <div class="skeleton h-44 rounded-2xl"></div>
    </section>
    <section id="rank-card" style="display:none;"></section>
    <section id="progress-card" style="display:none;"></section>
    <section id="subrank-card" style="display:none;"></section>
    <section id="link-card" style="display:none;"></section>
    <section id="shop-card" style="display:none;"></section>
    <section id="coupons-card" style="display:none;"></section>
    <section id="about-card" style="display:none;"></section>
    <a id="store-cta" href="https://${escapeHtml(storeDomain)}" style="display:none;" class="block text-center card tap" >
      <span class="inline-flex items-center justify-center gap-2 w-full py-3.5 text-sm font-bold" style="color:#0f766e">&#x1F6CD;&#xFE0F; ストアでお買い物する &rarr;</span>
    </a>
    <section id="error-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-2">&#x1F614;</p>
      <p class="text-sm font-bold text-gray-700 mb-1">ランク情報を取得できませんでした</p>
      <p class="text-xs text-gray-500" id="error-detail">しばらくしてからもう一度お試しください。</p>
    </section>
  </main>

  <div id="toast" role="status" aria-live="polite" class="fixed left-1/2 bottom-8 z-50 text-white text-sm font-bold px-5 py-2.5 rounded-full shadow-xl" style="transform:translate(-50%,16px);opacity:0;background:#0f172a;pointer-events:none"></div>

  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center">
    <div class="spinner"></div>
    <p class="text-sm mt-4" style="color:#5b6670">読み込み中...</p>
  </div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
let idToken = null;
// 一度でも会員証を描画したら、 以降の refresh 失敗で error card を出さない
// (= 連携成功 → loadRank() 再取得が transient 失敗しても、 成功表示と既存の会員証を維持する)。
var hasRendered = false;
// ?demo=1 でサンプル会員証を表示 (= LINE 文脈外でも UI 確認用、 認証/実データ不要)。
var DEMO_DATA = {
  rank: { id: 'silver', name: 'シルバー', discountPercent: 4, badgeColor: '#C0C0C0', badgeImageUrl: '/images/rank-silver-v2.png', badgeEmoji: null },
  trailing12moJpy: 15000,
  next: { id: 'gold', name: 'ゴールド', remainingJpy: 9000 },
  progressRatio: 0.25,
  official: null,
  coupons: [
    { code: 'LINE-DEMO500', title: '友だち追加クーポン', discountType: 'fixed_amount', discountValue: 500, expiresAt: '2026-06-30T14:59:59Z' },
    { code: 'NLR-SILVER10', title: 'シルバー会員特典', discountType: 'percentage', discountValue: 10, expiresAt: '2026-07-10T14:59:59Z' }
  ],
  ladder: [
    { id: 'regular', name: 'レギュラー', discountPercent: 0, minTrailing12moJpy: 0 },
    { id: 'bronze', name: 'ブロンズ', discountPercent: 2, minTrailing12moJpy: 1 },
    { id: 'silver', name: 'シルバー', discountPercent: 4, minTrailing12moJpy: 12000 },
    { id: 'gold', name: 'ゴールド', discountPercent: 6, minTrailing12moJpy: 24000 },
    { id: 'platinum', name: 'プラチナ', discountPercent: 8, minTrailing12moJpy: 45000 }
  ],
  rankDiscount: { discountPercent: 4 },
  // demo は全カードを一画面で確認する目的のため subscriptionRank と linked:false を意図的に併存させる
  // (実 API では連携済み顧客にしか subscriptionRank は付かない = 連携カードと同時には出ない)
  subscriptionRank: { name: 'シルバー', discountPercent: 4 },
  discountApplyUrl: 'https://naturism-diet.com/discount/NLR-SILVER-DEMO2345',
  // ¥2,000 未満の商品はコード無し URL + discounted:false (= min ¥2,000 の実挙動を demo でも忠実に)
  quickBuy: [
    { title: 'KOSO in naturism ToGo (Pink) 180粒 (30日分)', price: '2830', imageUrl: null, url: 'https://naturism-diet.com/cart/42884926636285:1?discount=NLR-SILVER-DEMO2345', discounted: true },
    { title: 'KOSO in naturism (Pink) 18粒 (3日分)', price: '430', imageUrl: null, url: 'https://naturism-diet.com/cart/42885035819261:1', discounted: false }
  ],
  linked: false,
  accountLinkEnabled: true,
  memberBackfillOn: true
};

function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function yen(n){ try{ return '¥' + Number(n||0).toLocaleString('ja-JP'); }catch(e){ return '¥' + (n||0); } }
// badgeColor は style 属性に入るため HTML-escape では不十分 (CSS injection 防止)。hex のみ allowlist 正規化。
function safeColor(c){ return /^#[0-9A-Fa-f]{3,8}$/.test(String(c)) ? String(c) : '#0f766e'; }
// 背景色の明度から読みやすい文字色を選ぶ (= 明るい金/銀バッジに白文字で潰れるのを防止)。
function textOn(hex){ var h=String(hex).replace('#',''); if(h.length===3){ h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; } var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16); if(isNaN(r)) return '#ffffff'; return (0.299*r+0.587*g+0.114*b)/255 > 0.62 ? '#1f2937' : '#ffffff'; }
// rank id → 英語表示名 (この画面はランク名を英語で大きく見せる)。
function enName(id){ var m={regular:'REGULAR',bronze:'BRONZE',silver:'SILVER',gold:'GOLD',platinum:'PLATINUM'}; return m[id] || (id ? String(id).toUpperCase() : 'MEMBER'); }
// 次回判定日 = 毎月1日 (今日が1日ならば今日、 そうでなければ翌月1日)。ブラウザ local = JST。
function nextEvalDate(){ var d=new Date(); if(d.getDate()===1) return new Date(d.getFullYear(), d.getMonth(), 1); return new Date(d.getFullYear(), d.getMonth()+1, 1); }
function fmtYmd(dt){ return dt.getFullYear()+'年'+(dt.getMonth()+1)+'月'+dt.getDate()+'日'; }
function fmtMd(s){ if(!s) return ''; try{ var d=new Date(s); if(isNaN(d.getTime())) return ''; return (d.getMonth()+1)+'/'+d.getDate(); }catch(e){ return ''; } }
function couponValueLabel(cp){ var t=cp.discountType, v=cp.discountValue; if(t==='percentage') return (Number(v)||0)+'% OFF'; return yen(v)+' OFF'; }

var toastTimer = null;
function showToast(msg){
  var t=document.getElementById('toast'); if(!t) return;
  t.textContent=msg; t.style.opacity='1'; t.style.transform='translate(-50%,0)';
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ t.style.opacity='0'; t.style.transform='translate(-50%,16px)'; }, 1900);
}
function copyCode(code){
  if(!code) return;
  function fb(){ showToast('コード: '+code); }
  try {
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(code).then(function(){ showToast('クーポンコードをコピーしました'); }, fb);
    } else { fb(); }
  } catch(e){ fb(); }
}

function renderRank(d){
  var rank = d.rank || {};
  var color = safeColor(rank.badgeColor || '#0f766e');
  var txt = textOn(color);
  var emoji = rank.badgeEmoji || '✨';
  var pct = Number.isFinite(rank.discountPercent) ? Math.floor(rank.discountPercent) : 0;
  var imgUrl = rank.badgeImageUrl;
  var medalInner = imgUrl
    ? '<div class="medal-glow" style="background:radial-gradient(circle,'+color+'55 0%,'+color+'22 45%,transparent 70%)"></div>'
      + '<img id="badge-img" class="medal-img" src="'+esc(imgUrl)+'" alt="'+esc(enName(rank.id))+'">'
      + '<div id="badge-fallback" class="badge-glow" style="display:none;position:absolute;font-size:84px;line-height:1">'+esc(emoji)+'</div>'
    : '<div class="badge-glow" style="font-size:84px;line-height:1">'+esc(emoji)+'</div>';
  var card = document.getElementById('rank-card');
  card.className = 'card pop overflow-hidden';
  card.style.display = 'block';
  card.innerHTML =
    '<div style="background:linear-gradient(180deg,'+color+'1f 0%,'+color+'08 55%,transparent 100%)">' +
      '<div class="pt-6 px-6 text-center">' +
        '<div class="medal-wrap">'+medalInner+'</div>' +
        '<p class="en mt-1 text-[11px] tracking-[0.28em] font-semibold" style="color:'+color+'">YOUR RANK</p>' +
        '<p class="text-3xl font-extrabold mt-0.5" style="color:#1f2937">'+esc(rank.name)+'会員</p>' +
        '<p class="en text-xs tracking-[0.22em] font-semibold text-gray-500 mt-0.5">'+esc(enName(rank.id))+'</p>' +
        (pct > 0
          ? '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-sm font-bold shadow" style="background:linear-gradient(135deg,'+color+','+color+'cc);color:'+txt+'">通常購入 '+pct+'% OFFクーポン</div>'
          : (d.purchaseImportPending
            ? '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-gray-600 text-sm font-bold" style="background:#f1f5f9">これまでのお買い物を反映しています…</div>'
            : '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-gray-600 text-sm font-bold" style="background:#f1f5f9">まずは1回のお買い物でブロンズ会員に</div>')) +
      '</div>' +
      '<p class="text-xs text-gray-400 text-center pb-5 pt-3">直近12ヶ月のお買い上げ <span class="font-bold text-gray-600">'+(d.purchaseImportPending ? '集計中…' : esc(yen(d.trailing12moJpy)))+'</span></p>' +
    '</div>';
  var bimg = document.getElementById('badge-img');
  if (bimg) {
    bimg.onerror = function(){ bimg.style.display='none'; var f=document.getElementById('badge-fallback'); if(f) f.style.display='block'; };
    if (bimg.complete && bimg.naturalWidth === 0) { bimg.onerror(); }
  }
}

function renderProgress(d){
  var card = document.getElementById('progress-card');
  card.className = 'card p-5 rise';
  card.style.display = 'block';
  var evalLine = '<div class="flex items-center justify-center gap-1.5 mt-4 pt-3" style="border-top:1px dashed #e2e8f0">' +
    '<span class="text-xs text-gray-400">&#x1F4C5; 次回の会員ランク判定日</span>' +
    '<span class="text-xs font-bold text-gray-600">'+esc(fmtYmd(nextEvalDate()))+'</span>' +
  '</div>';
  if (!d.next){
    card.innerHTML = '<p class="text-sm font-bold text-center" style="color:#0f766e">&#x2728; 最高ランク達成！いつもありがとうございます</p>' + evalLine;
    return;
  }
  var ratio = Math.max(0, Math.min(1, d.progressRatio || 0));
  var pctW = Math.round(ratio * 100);
  card.innerHTML =
    '<div class="flex items-end justify-between mb-2">' +
      '<p class="text-xs text-gray-500">次のランク（会員ランク）</p>' +
      '<p class="text-sm font-bold text-gray-800"><span class="en">'+esc(enName(d.next.id))+'</span> <span class="text-xs text-gray-400">'+esc(d.next.name)+'</span></p>' +
    '</div>' +
    '<div class="w-full h-3 rounded-full overflow-hidden" style="background:#e2e8f0">' +
      '<div class="bar-fill h-3 rounded-full" id="bar" style="width:0%;background:linear-gradient(90deg,#2fa8ad,#80c8cd)"></div>' +
    '</div>' +
    (d.purchaseImportPending
      ? '<p class="text-xs text-gray-500 mt-2 text-center">これまでのお買い物を反映しています（数分かかる場合があります）</p>'
      : d.next.remainingJpy <= 1
        ? '<p class="text-xs text-gray-500 mt-2 text-center">まずは1回のお買い物で '+esc(d.next.name)+'会員へ</p>'
        : '<p class="text-xs text-gray-500 mt-2 text-center">あと <span class="font-bold" style="color:#0f766e">'+esc(yen(d.next.remainingJpy))+'</span> で '+esc(d.next.name)+'にランクアップ</p>') +
    evalLine;
  setTimeout(function(){ var b=document.getElementById('bar'); if(b) b.style.width = pctW + '%'; }, 80);
}

// ─── 定期便ランク (= Huckleberry ネイティブ会員ランク連動, B案 2026-08-16) ───
//   タグ subscription-rank: を持つ連携済み顧客にだけ出す。未知ランク名は % を断定しない (fail-honest)。
function renderSubRank(d){
  var card = document.getElementById('subrank-card');
  if(!card) return;
  var sr = d.subscriptionRank;
  if(!sr || !sr.name){ card.style.display='none'; return; }
  card.className = 'card p-5 rise';
  card.style.display = 'block';
  var pct = Number.isFinite(sr.discountPercent) ? Math.floor(sr.discountPercent) : 0;
  card.innerHTML =
    '<div class="flex items-center justify-between mb-1.5">' +
      '<p class="text-sm font-bold text-gray-700">&#x1F4E6; 定期便ランク</p>' +
      (pct > 0 ? '<span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:#eef7f7;color:#0f766e">毎回 '+pct+'% OFF</span>' : '') +
    '</div>' +
    '<p class="text-xl font-extrabold" style="color:#0f766e">'+esc(sr.name)+'</p>' +
    (pct > 0
      ? '<p class="text-xs text-gray-500 mt-1 leading-relaxed">定期便のお支払いごとに、'+pct+'% の割引が自動で適用されます。</p>'
      : '<p class="text-xs text-gray-500 mt-1 leading-relaxed">特典の内容は公式ストアのマイページでご確認ください。</p>') +
    '<p class="text-[11px] text-gray-400 mt-2 leading-relaxed">定期便のお支払い累計で決まるランクです。この割引は定期便のお支払いにだけ自動で適用されます。上の会員ランクは、定期便を含むすべてのお買い物の合計金額でランクを判定するもので、その割引は通常購入（単発のお買い物）用のクーポンとしてご利用いただけます。</p>' +
    '<p class="text-[11px] text-gray-400 mt-1 leading-relaxed">※ランクの集計は 2026年8月 に始まりました。それより前のご利用分は集計に含まれていない場合があります。</p>';
}

// ─── 自前アカウント連携 (= Phase 2: email OTP で Shopify customer を紐付け、 gated) ───
function linkHeaders(){ var h={'Content-Type':'application/json'}; if(idToken) h['Authorization']='Bearer '+idToken; return h; }
function linkMsg(msg, isErr){ var m=document.getElementById('link-msg'); if(!m) return; m.textContent=msg||''; m.style.display=msg?'block':'none'; m.style.color=isErr?'#dc2626':'#64748b'; }
function setLinkBusy(id, busy, busyLabel){
  var b=document.getElementById(id); if(!b) return;
  // busy 中はラベルを「送信中…」等に差し替え (= 低速回線で tap が効いた合図)。 解除時に原文へ復元。
  if(busy){ if(b.getAttribute('data-label')===null) b.setAttribute('data-label', b.textContent); if(busyLabel) b.textContent=busyLabel; }
  else { var orig=b.getAttribute('data-label'); if(orig!==null){ b.textContent=orig; b.removeAttribute('data-label'); } }
  b.disabled=busy; b.style.opacity=busy?'0.6':'1'; b.style.pointerEvents=busy?'none':'auto';
}
function linkStep(step){
  var e=document.getElementById('link-step-email'), c=document.getElementById('link-step-code');
  if(e) e.style.display=(step==='email')?'block':'none';
  if(c) c.style.display=(step==='code')?'block':'none';
}
async function linkRequest(){
  var emailEl=document.getElementById('link-email');
  var email=((emailEl && emailEl.value) || '').trim();
  if(!email){ linkMsg('メールアドレスを入力してください', true); return; }
  // 形式チェックはサーバ往復前に (不正フォーマットの往復待ちをなくす)
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ linkMsg('正しいメールアドレスをご入力ください', true); return; }
  linkMsg('', false); setLinkBusy('link-send-btn', true, '送信中…');
  try{
    var res=await fetch(API_BASE+'/api/liff/link/request-code', { method:'POST', headers:linkHeaders(), body:JSON.stringify({ email:email }) });
    var body=await res.json().catch(function(){ return null; });
    if(res.status===200 && body && body.success){
      var to=document.getElementById('link-sent-to'); if(to) to.textContent=email;
      linkStep('code');
      var ce=document.getElementById('link-code'); if(ce){ ce.value=''; ce.focus(); }
      linkMsg('', false);
    } else if(body && body.error==='already_linked'){
      showToast('すでに連携済みです'); loadRank();
    } else {
      linkMsg((body && body.message) || '送信に失敗しました。時間をおいてお試しください。', true);
    }
  }catch(e){ linkMsg('通信エラーが発生しました', true); }
  finally{ setLinkBusy('link-send-btn', false); }
}
async function linkVerify(){
  var emailEl=document.getElementById('link-email'), codeEl=document.getElementById('link-code');
  var email=((emailEl && emailEl.value) || '').trim();
  var code=((codeEl && codeEl.value) || '').trim();
  if(!/^[0-9]{6}$/.test(code)){ linkMsg('6桁の確認コードを入力してください', true); return; }
  linkMsg('', false); setLinkBusy('link-verify-btn', true, '確認中…');
  try{
    var res=await fetch(API_BASE+'/api/liff/link/verify-code', { method:'POST', headers:linkHeaders(), body:JSON.stringify({ email:email, code:code }) });
    var body=await res.json().catch(function(){ return null; });
    if(res.status===200 && body && body.success){
      showToast('アカウント連携が完了しました');
      var card=document.getElementById('link-card'); if(card) card.style.display='none';
      linkCouponPending = true;
      loadRank();
      refreshLinkCouponAfterLink(0);
      return;
    }
    var err=body && body.error;
    if(err==='already_linked'){ showToast('すでに連携済みです'); loadRank(); return; }
    var msg=(body && body.message) || '確認に失敗しました';
    if(err==='invalid_code' && body && typeof body.attemptsRemaining==='number'){ msg += '（残り'+body.attemptsRemaining+'回）'; }
    if(err==='locked' || err==='no_code'){ linkStep('email'); } // コード無効/期限切れ → 再送へ
    linkMsg(msg, true);
  }catch(e){ linkMsg('通信エラーが発生しました', true); }
  finally{ setLinkBusy('link-verify-btn', false); }
}

// 連携特典 ¥300 の後追い取得 (2026-08-28)。
// verify の HTTP 応答の**後**に waitUntil で Shopify 発行 → 台帳 INSERT が走るため、
// 応答直後の loadRank() だけではまだ 0 枚。後追いしないと
// **LINE 内メール OTP で連携した本人が特典を一度も見ない** (ポータル側の
// refreshLinkCouponAfterLink と同じ役割・同じ階段)。gate off / 発行失敗なら API は
// 連携特典を返さない = 何度呼んでも出ない (無害)。
// 🚨 クーポンが出た時点で打ち切ってはいけない (2026-08-28 採点ループ P1)。
// backfill も応答の後に走るため、クーポンだけを終了条件にすると
// **会員証が「レギュラー会員 / ¥0 / まずは1回のお買い物で」のままセッション中固着**する
// (この画面には visibilitychange / pageshow / interval の再取得が 1 つも無い)。
// 終了条件は「クーポンが出た **かつ** 取り込みが完了した」。
var LINK_COUPON_RETRY_MS = [1500, 4000, 9000, 20000];
var linkCouponPending = false;   // 発行待ち = 「ありません」と断定しない窓
var linkCouponTimedOut = false;  // 打ち切り = 「時間がかかっています」に切り替える
var linkCouponAnnounced = false; // 告知は 1 回だけ
var lastImportPending = false;   // 直近の loadRank が返した取り込み状態
function linkCouponVisible(){
  return !!document.querySelector('#coupons-card [data-coupon-kind="link_reward"]');
}
function refreshLinkCouponAfterLink(attempt){
  var n = attempt || 0;
  var got = linkCouponVisible();
  if (got){
    linkCouponPending = false;
    if (!linkCouponAnnounced){ linkCouponAnnounced = true; announceLinkCoupon(); }
  }
  if (got && !lastImportPending) return; // 両方そろった = 追う理由がない
  if (n >= LINK_COUPON_RETRY_MS.length){
    // 打ち切り。「ご用意しています…」を残したままにせず、正直な待ち文言へ。
    linkCouponPending = false;
    if (!linkCouponVisible()) linkCouponTimedOut = true;
    try { loadRank(); } catch (e) {}
    return;
  }
  setTimeout(function(){
    var p = null;
    try { p = loadRank(); } catch (e) { p = null; }
    var next = function(){ refreshLinkCouponAfterLink(n + 1); };
    if (p && typeof p.then === 'function'){ p.then(next, next); } else { next(); }
  }, LINK_COUPON_RETRY_MS[n]);
}
function announceLinkCoupon(){
  // **金額は書かない** — 正はクーポン行 (台帳の実値)。ここに数字を置くと二重管理の嘘になる。
  showToast('🎁 連携特典クーポンをお届けしました');
}
// 連携特典が届かなかったときの復旧導線 (2026-08-28)。
// 🚨 ここでは解除しない — 解除は会員ランク表示を失うので、既存の二段確認を開いて
//    「何が起きるか」を読んでもらってから本人に決めてもらう。
function showRelinkHelp(){
  var open = document.getElementById('unlink-open');
  var confirm = document.getElementById('unlink-confirm');
  if (confirm) confirm.style.display = 'block';
  if (open) open.style.display = 'none';
  var card = document.getElementById('link-card');
  if (card && card.scrollIntoView) {
    try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { card.scrollIntoView(); }
  }
}
// ─── 連携解除 (2026-08-28) ───
// 二段確認にする: 1 タップで消えると、ランクと注文履歴を意図せず失う事故になる。
// 文言は「何が起きるか」を具体的に書く (「解除します」だけだと何を失うか分からない)。
function renderUnlink(card){
  card.className='card p-5 rise';
  card.style.display='block';
  card.innerHTML =
    '<div class="flex items-center gap-2 mb-1.5"><span class="text-base">&#x2705;</span>' +
      '<p class="text-sm font-bold text-gray-700">オンラインストアと連携済み</p></div>' +
    '<p class="text-xs text-gray-500 leading-relaxed mb-3">ご注文の確認や会員ランクは、連携されたご注文アカウントの情報から表示しています。</p>' +
    '<button type="button" id="unlink-open" class="tap w-full text-xs py-3 rounded-xl" ' +
      'style="background:#f8fafc;border:1px solid #e2e8f0;color:#64748b">連携を解除する</button>' +
    '<div id="unlink-confirm" style="display:none;margin-top:10px">' +
      // 🚨 「元に戻ります」と断定しない (採点ループ HIGH)。復元は再連携後の
      //    backlink-repair cron が数分かけて行うので即時ではない。守れる範囲だけ書く。
      '<p class="text-xs text-gray-600 leading-relaxed mb-2">解除すると、ご注文の確認・再注文と、これまでのお買い物にもとづく<b>会員ランクが表示されなくなります</b>。お手持ちのクーポンはそのままご利用いただけます。あらためて連携していただくこともできます。</p>' +
      '<button type="button" id="unlink-do" class="tap w-full text-white text-sm font-bold py-2.5 rounded-xl shadow" style="background:#b84a2e">解除する</button>' +
      '<button type="button" id="unlink-cancel" class="tap w-full text-xs text-gray-600 mt-2 py-3 rounded-xl" style="background:#f8fafc;border:1px solid #e2e8f0">やめる</button>' +
    '</div>' +
    '<p id="unlink-msg" role="status" aria-live="polite" style="display:none;font-size:12px;margin-top:8px;text-align:center"></p>';
  var open=document.getElementById('unlink-open');
  if(open) open.addEventListener('click', function(){
    var c=document.getElementById('unlink-confirm'); if(c) c.style.display='block';
    open.style.display='none';
  });
  var cancel=document.getElementById('unlink-cancel');
  if(cancel) cancel.addEventListener('click', function(){
    var c=document.getElementById('unlink-confirm'); if(c) c.style.display='none';
    if(open) open.style.display='block';
  });
  var go=document.getElementById('unlink-do');
  if(go) go.addEventListener('click', unlinkAccount);
}

function unlinkMsg(text, isError){
  var m=document.getElementById('unlink-msg'); if(!m) return;
  if(!text){ m.style.display='none'; m.textContent=''; return; }
  m.style.display='block'; m.style.color=isError?'#b84a2e':'#0f766e'; m.textContent=text;
}

async function unlinkAccount(){
  unlinkMsg('', false); setLinkBusy('unlink-do', true, '解除中…');
  try{
    var res=await fetch(API_BASE+'/api/liff/link/unlink', { method:'POST', headers:linkHeaders(), body:'{}' });
    var body=await res.json().catch(function(){ return null; });
    if(res.status===200 && body && body.success){
      showToast((body && body.message) || '連携を解除しました');
      loadRank(); // 会員証全体を引き直す (ランク・注文・クーポンが同時に変わるため)
      return;
    }
    unlinkMsg('解除に失敗しました。時間をおいてお試しください', true);
  }catch(e){ unlinkMsg('通信エラーが発生しました', true); }
  finally{ setLinkBusy('unlink-do', false); }
}

function renderLink(d){
  var card=document.getElementById('link-card');
  if(!card) return;
  if(!d){ card.style.display='none'; return; }
  // 連携済みなら「解除」を出す (2026-08-28)。誤連携 (家族共有のメール等) を本人が直せないと
  // 他人の購買履歴が見え続けるため、受付 gate とは独立に常に出す。
  if(d.linked){ renderUnlink(card); return; }
  // 未連携: 受付 gate が有効なときだけ連携フォームを出す (= 押した先が 404 の死んだボタンを作らない)
  if(!d.accountLinkEnabled){ card.style.display='none'; return; }
  card.className='card p-5 rise';
  card.style.display='block';
  // a11y: 各 input に aria-label (placeholder だけだと入力開始で消える + SR が名前として読まない)。
  //       #link-msg は role=status aria-live=polite で検証/送信エラーを SR に通知。
  // 「これまでの購入履歴を反映」は memberBackfillOn 連動 (2026-08-26) — backfill gate off では
  // 連携しても過去分が 1 円も反映されないため、off ではその一文を落として連携の事実だけを述べる。
  card.innerHTML =
    '<div class="flex items-center gap-2 mb-1.5"><span class="text-base">&#x1F517;</span>' +
      '<p class="text-sm font-bold text-gray-700">' + (d.memberBackfillOn ? 'これまでのお買い物をランクに反映' : 'お買い物アカウントと連携') + '</p></div>' +
    // なぜメール? = 注文時メールで本人確認 → 購入履歴をランクへ。opt-in (メルマガ登録) とは別機能である区別も明記。
    '<p class="text-xs text-gray-500 leading-relaxed mb-3">' + (d.memberBackfillOn
      ? '公式ストアの<b>ご注文時に使ったメールアドレス</b>宛に確認コードをお送りして本人確認し、これまでの購入履歴を会員ランクに反映します。メールマガジンの配信登録とは別の機能で、これによってメールが届くようになることはありません。'
      : '公式ストアの<b>ご注文時に使ったメールアドレス</b>宛に確認コードをお送りして本人確認し、お客様のご注文アカウントとこのLINEを連携します。メールマガジンの配信登録とは別の機能で、これによってメールが届くようになることはありません。') + '</p>' +
    '<div id="link-step-email">' +
      '<input id="link-email" type="email" inputmode="email" autocomplete="email" enterkeyhint="send" aria-label="ご注文時のメールアドレス" placeholder="ご注文時のメールアドレス" ' +
        'class="w-full px-3.5 py-2.5 rounded-xl text-sm mb-2" style="border:1px solid #e2e8f0;outline:none">' +
      '<button type="button" id="link-send-btn" class="tap w-full text-white text-sm font-bold py-2.5 rounded-xl shadow" ' +
        'style="background:#0f766e">確認コードを送信</button>' +
    '</div>' +
    '<div id="link-step-code" style="display:none">' +
      '<p class="text-xs text-gray-500 mb-2"><span id="link-sent-to" class="font-bold text-gray-700"></span> に確認コードを送信しました（5分間有効）。</p>' +
      '<input id="link-code" type="text" inputmode="numeric" autocomplete="one-time-code" enterkeyhint="done" aria-label="6桁の確認コード" maxlength="6" placeholder="6桁の確認コード" ' +
        'class="w-full px-3.5 py-2.5 rounded-xl text-sm mb-2 text-center font-bold" style="border:1px solid #e2e8f0;outline:none;letter-spacing:.4em">' +
      '<button type="button" id="link-verify-btn" class="tap w-full text-white text-sm font-bold py-2.5 rounded-xl shadow" ' +
        'style="background:#0f766e">メールアドレスを確認して連携</button>' +
      '<button type="button" id="link-restart" class="tap w-full text-xs text-gray-600 mt-2 py-3 rounded-xl" style="background:#f8fafc;border:1px solid #e2e8f0">別のメールアドレスで送り直す</button>' +
    '</div>' +
    '<p id="link-msg" role="status" aria-live="polite" style="display:none;font-size:12px;margin-top:8px;text-align:center"></p>';
  var sb=document.getElementById('link-send-btn'); if(sb) sb.addEventListener('click', linkRequest);
  var vb=document.getElementById('link-verify-btn'); if(vb) vb.addEventListener('click', linkVerify);
  var rs=document.getElementById('link-restart'); if(rs) rs.addEventListener('click', function(){ linkStep('email'); linkMsg('', false); });
  // Enter/Go/Done キーで送信 (= 片手モバイルでキーボードを閉じずに進める)
  var ee=document.getElementById('link-email'); if(ee) ee.addEventListener('keydown', function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); linkRequest(); } });
  var ce2=document.getElementById('link-code'); if(ce2) ce2.addEventListener('keydown', function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); linkVerify(); } });
  // ホーム/マイアカウントの「メールで連携する（LINEの中で完結）」からの着地 (#link, 2026-08-26):
  // 連携カードへスクロールして 1 回だけ強調する。既連携などでカードが出ないときは何もしない。
  // 再 render (連携失敗後の loadRank 等) で毎回スクロールし直さないよう window flag で 1 回に限定。
  if(!window.__linkFocusDone && location.hash==='#link'){
    window.__linkFocusDone=true;
    setTimeout(function(){
      try{
        var smooth=true;
        try{ smooth=!window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
        card.scrollIntoView({behavior:smooth?'smooth':'auto',block:'center'});
        card.classList.add('link-focus');
      }catch(e){}
    },150);
  }
}

// ─── おトクにお買い物 (= 3タップ購入: 割引適用リンク + cart permalink) ───
function renderShop(d){
  var card = document.getElementById('shop-card');
  var items = (d.quickBuy || []).filter(function(q){ return q && q.url; });
  var applyUrl = d.discountApplyUrl;
  var pct = (d.rankDiscount && Number.isFinite(d.rankDiscount.discountPercent)) ? Math.floor(d.rankDiscount.discountPercent) : 0;
  if (!applyUrl && items.length === 0){ card.style.display = 'none'; return; }
  card.className = 'card p-5 rise';
  card.style.display = 'block';
  var html = '<div class="flex items-center justify-between mb-3">' +
    '<p class="text-sm font-bold text-gray-700">&#x1F6CD;&#xFE0F; おトクにお買い物</p>' +
    (pct > 0 ? '<span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:#eef7f7;color:#0f766e">ランク特典 ' + pct + '% OFF</span>' : '') +
  '</div>';
  if (applyUrl){
    html += '<a href="' + esc(applyUrl) + '" class="tap block text-center text-white text-sm font-bold py-3 rounded-xl shadow mb-1.5" style="background:#0f766e">' +
      (pct > 0 ? pct + '% OFF を使ってお買い物' : 'お買い物にすすむ') + ' &rarr;</a>' +
      // min ¥2,000 の開示 (PR-D): 条件なしの「割引」断定は有利誤認になる。税込/税抜は実測前なので書かない。
      '<p class="text-[11px] text-gray-400 mb-3 text-center">ランク割引は ¥2,000以上のご注文で適用されます</p>';
  }
  if (items.length){
    if (applyUrl) html += '<p class="text-xs text-gray-400 mb-2">かんたん購入</p>';
    html += '<div class="space-y-2">' + items.map(function(q){
      var price = q.price ? '¥' + Number(q.price).toLocaleString('ja-JP') : '';
      var img = q.imageUrl
        ? '<img src="' + esc(q.imageUrl) + '" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:10px;flex-shrink:0">'
        : '<div style="width:48px;height:48px;border-radius:10px;background:#f1f5f9;flex-shrink:0"></div>';
      // 割引ラベルはサーバが「本当にコードが乗る」と判定した行 (discounted=true) にだけ出す
      var badge = (q.discounted && pct > 0)
        ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded" style="background:#eef7f7;color:#0f766e">' + pct + '% OFF適用</span>'
        : '';
      return '<a href="' + esc(q.url) + '" class="tap flex items-center gap-3 p-2.5 rounded-xl" style="border:1px solid #e2e8f0">' +
        img +
        '<div class="flex-1 min-w-0"><p class="text-xs font-bold text-gray-800 truncate">' + esc(q.title) + '</p>' +
          '<p class="text-xs text-gray-500 mt-0.5">' + esc(price) + (badge ? ' ' + badge : '') + '</p>' + '</div>' +
        '<span class="text-xs font-bold text-white px-3 py-1.5 rounded-lg shrink-0" style="background:#0f766e">購入</span>' +
      '</a>';
    }).join('') + '</div>';
  }
  card.innerHTML = html;
}

function renderCoupons(d){
  var card = document.getElementById('coupons-card');
  card.className = 'card p-5 rise';
  card.style.display = 'block';
  var list = (d.coupons || []).filter(function(c){ return c && c.code; });
  // 🚨 枚数バッジは pending 判定の**後**に組む。先に組むと「ご用意しています…」の真上で
  //    「0枚」と言い続ける (= 本文だけ直しても合成後は嘘のまま。2026-08-28 採点ループ P2)。
  var waiting = list.length === 0 && (linkCouponPending || linkCouponTimedOut);
  var countLabel = waiting ? '準備中' : list.length + '枚';
  var head = '<div class="flex items-center justify-between mb-3"><p class="text-sm font-bold text-gray-700">&#x1F39F;&#xFE0F; 保有クーポン</p><span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:#eef7f7;color:#0f766e">'+countLabel+'</span></div>';
  if (list.length === 0){
    // 連携直後は発行 (waitUntil) 待ちなので「ありません」と断定しない (= 届く直前に否定する嘘)。
    // 打ち切り後も断定に戻さない — 失敗と発行中を画面で区別できないため (audit_logs が唯一の証跡)。
    var emptyHtml;
    if (linkCouponPending){
      emptyHtml = '<p class="text-xs text-gray-400 text-center py-3">特典クーポンをご用意しています…</p>';
    } else if (linkCouponTimedOut){
      // 発行が失敗したときの復旧口。台帳が空なら「解除 → 再連携」で冪等チェックが
      // 空振りして再発行される (#282 の解除機能)。ただし解除は会員ランク表示を失うので、
      // このボタンは**既存の二段確認を開くだけ**にする (ここでは解除しない)。
      emptyHtml =
        '<p class="text-xs text-gray-500 text-center pt-3">特典クーポンがまだ届いていません</p>' +
        '<p class="text-[11px] text-gray-400 text-center mt-1.5 leading-relaxed">ミニアプリを開き直すと表示されることがあります。<br>それでも表示されない場合は、連携をやり直すと再発行されます。</p>' +
        '<button type="button" onclick="showRelinkHelp()" class="tap w-full text-xs font-bold py-3 rounded-xl mt-3" style="background:#f8fafc;border:1px solid #e2e8f0;color:#0f766e">連携をやり直す方法を見る</button>';
    } else {
      emptyHtml = '<p class="text-xs text-gray-400 text-center py-3">利用できるクーポンはまだありません</p>';
    }
    card.innerHTML = head + emptyHtml;
    return;
  }
  var rows = list.map(function(c){
    var exp = fmtMd(c.expiresAt);
    var kindAttr = c.kind ? ' data-coupon-kind="' + esc(c.kind) + '"' : '';
    return '<div' + kindAttr + ' class="flex items-center gap-3 p-3 rounded-xl" style="background:linear-gradient(135deg,#f0fdfa,#faf5ff);border:1px solid #e2e8f0">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-bold text-gray-800 truncate">'+esc(c.title || 'クーポン')+'</p>' +
        '<p class="text-xs font-bold mt-0.5" style="color:#0f766e">'+esc(couponValueLabel(c))+(exp ? ' <span class="text-gray-400 font-normal">/ '+esc(exp)+'まで</span>' : '')+'</p>' +
        '<p class="text-[11px] text-gray-400 mt-0.5 font-mono truncate">'+esc(c.code)+'</p>' +
      '</div>' +
      '<button type="button" data-code="'+esc(c.code)+'" class="copy-btn tap shrink-0 text-xs font-bold text-white px-3 py-2 rounded-lg shadow" style="background:#0f766e">コピー</button>' +
    '</div>';
  }).join('');
  card.innerHTML = head + '<div class="space-y-2">'+rows+'</div>';
  var btns = card.querySelectorAll('.copy-btn');
  for (var i=0;i<btns.length;i++){
    btns[i].addEventListener('click', function(){ copyCode(this.getAttribute('data-code')); });
  }
}

function renderAbout(d){
  var card = document.getElementById('about-card');
  card.className = 'card rise overflow-hidden';
  card.style.display = 'block';
  var ladder = (d.ladder && d.ladder.length) ? d.ladder : [];
  var curId = (d.rank && d.rank.id) || '';
  var rows = ladder.map(function(r){
    var active = (r.id === curId);
    var thr = (Number(r.minTrailing12moJpy)||0) <= 1 ? (Number(r.minTrailing12moJpy)===0 ? '¥0〜' : '¥1〜') : yen(r.minTrailing12moJpy)+'〜';
    return '<div class="ladder-row flex items-center justify-between px-4 py-2.5" style="'+(active?'background:#eef7f7':'')+'">' +
      '<div class="flex items-center gap-2">' +
        (active ? '<span style="color:#0f766e">&#x25B6;</span>' : '<span class="w-3 inline-block"></span>') +
        '<span class="en text-sm font-bold '+(active?'':'text-gray-600')+'" style="'+(active?'color:#0f766e':'')+'">'+esc(enName(r.id))+'</span>' +
        '<span class="text-[11px] text-gray-400">'+esc(r.name)+'</span>' +
      '</div>' +
      '<div class="flex items-center gap-3">' +
        '<span class="text-[11px] text-gray-400">'+esc(thr)+'</span>' +
        '<span class="text-sm font-bold '+(Number(r.discountPercent)>0?'':'text-gray-400')+'" style="'+(Number(r.discountPercent)>0?'color:#0f172a':'')+'">'+(Number(r.discountPercent)||0)+'%</span>' +
      '</div>' +
    '</div>';
  }).join('');
  card.innerHTML =
    '<button type="button" id="about-toggle" class="w-full flex items-center justify-between px-5 py-4 tap">' +
      '<span class="text-sm font-bold text-gray-700">&#x1F6E1;&#xFE0F; 会員ランクについて</span>' +
      '<span id="about-chev" class="chev text-gray-400 text-xs">&#x25BC;</span>' +
    '</button>' +
    '<div id="about-body" class="acc-body">' +
      '<div class="pb-2" style="border-top:1px solid #f1f5f9">'+rows+'</div>' +
      // 定期便×ランクの表示は renderSubRank (定期便ランクカード) が担当 (B案 検証ゲート通過
      //   2026-08-16 で解禁済み)。この accordion は会員ランク (全購入 12ヶ月) の説明に限定し、
      //   重複訴求を書かない。定期便ランク保有者にだけ両者の区別の 1 行を出す。
      '<p class="text-[11px] text-gray-400 px-5 pb-1 pt-1 leading-relaxed">過去12ヶ月のお買い上げ金額で、毎月1日に自動で判定します（降格あり）。</p>' +
      ((d.subscriptionRank && d.subscriptionRank.name)
        ? '<p class="text-[11px] text-gray-400 px-5 pb-4 leading-relaxed">定期便をご利用の方には、この会員ランクとは別に、定期便のお支払い累計で決まる「定期便ランク」があります（上のカード）。</p>'
        : '<span class="block pb-3"></span>') +
    '</div>';
  var toggle = document.getElementById('about-toggle');
  var body = document.getElementById('about-body');
  var chev = document.getElementById('about-chev');
  toggle.addEventListener('click', function(){
    var open = body.classList.toggle('open');
    chev.classList.toggle('open', open);
  });
}

function renderAll(d){
  hasRendered = true;
  lastImportPending = !!d.purchaseImportPending;
  document.getElementById('card-skeleton').style.display='none';
  renderRank(d);
  renderProgress(d);
  renderSubRank(d);
  renderLink(d);
  renderShop(d);
  renderCoupons(d);
  renderAbout(d);
  var cta=document.getElementById('store-cta'); if(cta) cta.style.display='block';
}

// API の英語生エラーコードを顧客向け日本語に変換 (生の英語コードを顧客に出さない)。
// 未知コードは友好的なデフォルト文言にフォールバック。2026-06-29 監査 rank 7。
function localizeError(code){
  if (!code) return null;
  var map = {
    'Friend not found': '友だち情報の同期中です。少し時間をおいて、もう一度お開きください🌿',
    'Invalid or expired ID token': 'ログインの有効期限が切れました。お手数ですがLINEから開き直してください🌿',
    'Authentication required': 'LINEアプリ内から開いてください🌿',
    'LIFF auth not configured': '只今メンテナンス中です。しばらくしてからお試しください🌿',
    'Unauthorized': 'お手数ですがLINEから開き直してください🌿'
  };
  for (var k in map){ if (String(code).indexOf(k) !== -1) return map[k]; }
  return 'しばらくしてからもう一度お試しください🌿';
}
function showError(msg){
  // 既に会員証を描画済なら error card で上書きしない (= 連携成功後の refresh 失敗を無害化)。
  // 初回ロード失敗 (hasRendered=false) では従来どおりエラー表示する。
  if (hasRendered) return;
  document.getElementById('card-skeleton').style.display='none';
  var e=document.getElementById('error-card');
  e.style.display='block';
  var jp = localizeError(msg);
  if (jp) document.getElementById('error-detail').textContent = jp;
}

// 🚨 応答の追い越し対策 (2026-08-28)。連携直後は loadRank が重なる
// (成功分岐の即時 1 本 + 後追いの階段 1500/4000/9000ms)。遅い方が後に着くと、
// **発行前のスナップショットで上書きされ、いったん出た ¥300 が消えて
// 「利用できるクーポンはまだありません」に戻る** (= 直したはずの嘘が再発する)。
// 最後に発行した要求以外の応答は捨てる。
var loadRankSeq = 0;
async function loadRank(){
  var seq = ++loadRankSeq;
  try {
    var res = await fetch(API_BASE + '/api/liff/my-rank', { headers: idToken ? { 'Authorization': 'Bearer ' + idToken } : {} });
    var body = await res.json().catch(function(){ return null; });
    if (seq !== loadRankSeq) return; // 追い越された = この応答は古い
    if (res.status !== 200 || !body || !body.success){
      showError(body && body.error ? body.error : null);
      return;
    }
    renderAll(body.data);
  } catch (e) {
    if (seq !== loadRankSeq) return;
    showError(null);
  }
}

async function initLiff(){
  try {
    if (new URLSearchParams(location.search).get('demo') === '1'){
      renderAll(DEMO_DATA);
      var dn=document.getElementById('demo-note'); if(dn) dn.style.display='block';
      return;
    }
    if (!LIFF_ID) throw new Error('LIFF_ID not configured');
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()){ liff.login(); return; }
    idToken = liff.getIDToken();
    await loadRank();
  } catch (err) {
    console.error('LIFF init error:', err);
    showError(null);
  } finally {
    document.getElementById('loading').style.display='none';
  }
}

initLiff();
</script>
</body>
</html>`;
}

export { liffMyRank };
