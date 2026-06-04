import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  NATURISM_RANK_DEFS,
  resolveFriendRank,
  getLatestRankSnapshot,
  getCouponAssignmentsByFriend,
  getActiveRankDiscountCode,
  getShopifyProducts,
} from '@line-crm/db';
import { buildCartPermalink, buildDiscountApplyUrl } from '../services/cart-permalink.js';

// 顧客向けストアフロント (= 公式ドメイン)。SHOPIFY_STORE_DOMAIN は Admin/API 用なので使わない。
const STORE_DOMAIN = 'naturism-diet.com';
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
  // 保有クーポン (= 未使用のみ)。失敗しても会員証本体は表示するため握りつぶす。
  let coupons: Array<Record<string, unknown>> = [];
  try {
    coupons = await getCouponAssignmentsByFriend(c.env.DB, liffUser.friendId, true);
  } catch {
    coupons = [];
  }
  const p = resolved.progress;

  // ─── 3タップ購入 (= PR5-5b): ランク割引コード + cart permalink ───
  // ランク割引は RANK_DISCOUNT_ENABLED 有効化 (= 5c 承認後) で発行される。未発行なら null → コード無し cart に graceful。
  const rankDiscount = await getActiveRankDiscountCode(c.env.DB, liffUser.friendId).catch(() => null);
  const discountCode = rankDiscount?.code ?? null;
  const discountApplyUrl = discountCode ? buildDiscountApplyUrl(STORE_DOMAIN, discountCode) : null;

  // かんたん購入: アクティブ商品の先頭 variant で cart permalink (= ランク割引コードがあれば自動付与)。
  const quickBuy: Array<{ title: string; price: string | null; imageUrl: string | null; url: string }> = [];
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
      const url = buildCartPermalink(STORE_DOMAIN, [{ variantId, quantity: 1 }], discountCode);
      if (url) {
        quickBuy.push({ title: prod.title, price: prod.price, imageUrl: prod.image_url, url });
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
        ? { id: p.next.id, name: p.next.name, remainingJpy: p.remainingToNextJpy }
        : null,
      progressRatio: p.progressRatio,
      // official = 月次 snapshot (= cron 実行後に値が入る、 未実行なら null で live のみ)
      official: snapshot
        ? { rankId: snapshot.rankId, period: snapshot.period, direction: snapshot.direction }
        : null,
      // 保有クーポン (発行済み・未使用)
      coupons: coupons.map((a) => ({
        code: a.code ?? null,
        title: a.title ?? null,
        discountType: a.discount_type ?? null,
        discountValue: a.discount_value ?? null,
        expiresAt: a.expires_at ?? null,
      })),
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
      quickBuy,
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>マイランク — naturism</title>
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
    .spinner{display:inline-block;width:34px;height:34px;border:3px solid #cffafe;border-top-color:#0ABAB5;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .pop{animation:pop .55s cubic-bezier(.22,1.4,.4,1) both}
    @keyframes pop{0%{transform:scale(.7);opacity:0}100%{transform:scale(1);opacity:1}}
    .rise{animation:rise .5s ease both}
    @keyframes rise{0%{transform:translateY(10px);opacity:0}100%{transform:translateY(0);opacity:1}}
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
      <a href="/liff/portal" class="text-xs text-gray-500 flex items-center gap-1 tap">&larr; マイページ</a>
      <h1 class="text-base font-extrabold tracking-tight" style="color:#0ABAB5">&#x1F451; マイランク</h1>
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
    <section id="shop-card" style="display:none;"></section>
    <section id="coupons-card" style="display:none;"></section>
    <section id="about-card" style="display:none;"></section>
    <a id="store-cta" href="https://${escapeHtml(storeDomain)}" style="display:none;" class="block text-center card tap" >
      <span class="inline-flex items-center justify-center gap-2 w-full py-3.5 text-sm font-bold" style="color:#0ABAB5">&#x1F6CD;&#xFE0F; ストアでお買い物する &rarr;</span>
    </a>
    <section id="error-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-2">&#x1F614;</p>
      <p class="text-sm font-bold text-gray-700 mb-1">ランク情報を取得できませんでした</p>
      <p class="text-xs text-gray-500" id="error-detail">しばらくしてからもう一度お試しください。</p>
    </section>
  </main>

  <div id="toast" class="fixed left-1/2 bottom-8 z-50 text-white text-sm font-bold px-5 py-2.5 rounded-full shadow-xl" style="transform:translate(-50%,16px);opacity:0;background:#0f172a;pointer-events:none"></div>

  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center">
    <div class="spinner"></div>
    <p class="text-sm text-gray-400 mt-4">読み込み中...</p>
  </div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
let idToken = null;
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
  discountApplyUrl: 'https://naturism-diet.com/discount/NLR-SILVER-DEMO2345',
  quickBuy: [
    { title: 'KOSO in naturism ToGo (Pink) 180粒 (30日分)', price: '2830', imageUrl: null, url: 'https://naturism-diet.com/cart/42884926636285:1?discount=NLR-SILVER-DEMO2345' },
    { title: 'KOSO in naturism (Pink) 18粒 (3日分)', price: '430', imageUrl: null, url: 'https://naturism-diet.com/cart/42885035819261:1?discount=NLR-SILVER-DEMO2345' }
  ]
};

function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function yen(n){ try{ return '¥' + Number(n||0).toLocaleString('ja-JP'); }catch(e){ return '¥' + (n||0); } }
// badgeColor は style 属性に入るため HTML-escape では不十分 (CSS injection 防止)。hex のみ allowlist 正規化。
function safeColor(c){ return /^#[0-9A-Fa-f]{3,8}$/.test(String(c)) ? String(c) : '#0ABAB5'; }
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
  var color = safeColor(rank.badgeColor || '#0ABAB5');
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
        '<p class="en text-4xl font-extrabold mt-0.5" style="color:#1f2937;letter-spacing:.02em">'+esc(enName(rank.id))+'</p>' +
        '<p class="text-xs text-gray-400 mt-0.5">'+esc(rank.name)+'会員</p>' +
        (pct > 0
          ? '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-sm font-bold shadow" style="background:linear-gradient(135deg,'+color+','+color+'cc);color:'+txt+'">'+pct+'% OFF 常時割引</div>'
          : '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-gray-600 text-sm font-bold" style="background:#f1f5f9">まずは1回のお買い物でブロンズ会員に</div>') +
      '</div>' +
      '<p class="text-xs text-gray-400 text-center pb-5 pt-3">直近12ヶ月のお買い上げ <span class="font-bold text-gray-600">'+esc(yen(d.trailing12moJpy))+'</span></p>' +
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
    card.innerHTML = '<p class="text-sm font-bold text-center" style="color:#0ABAB5">&#x2728; 最高ランク達成！いつもありがとうございます</p>' + evalLine;
    return;
  }
  var ratio = Math.max(0, Math.min(1, d.progressRatio || 0));
  var pctW = Math.round(ratio * 100);
  card.innerHTML =
    '<div class="flex items-end justify-between mb-2">' +
      '<p class="text-xs text-gray-500">次のランク</p>' +
      '<p class="text-sm font-bold text-gray-800"><span class="en">'+esc(enName(d.next.id))+'</span> <span class="text-xs text-gray-400">'+esc(d.next.name)+'</span></p>' +
    '</div>' +
    '<div class="w-full h-3 rounded-full overflow-hidden" style="background:#e2e8f0">' +
      '<div class="bar-fill h-3 rounded-full" id="bar" style="width:0%;background:linear-gradient(90deg,#0ABAB5,#22d3ee)"></div>' +
    '</div>' +
    '<p class="text-xs text-gray-500 mt-2 text-center">あと <span class="font-bold" style="color:#0ABAB5">'+esc(yen(d.next.remainingJpy))+'</span> で '+esc(d.next.name)+'にランクアップ</p>' +
    evalLine;
  setTimeout(function(){ var b=document.getElementById('bar'); if(b) b.style.width = pctW + '%'; }, 80);
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
    (pct > 0 ? '<span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:#ecfeff;color:#0ABAB5">ランク特典 ' + pct + '% OFF</span>' : '') +
  '</div>';
  if (applyUrl){
    html += '<a href="' + esc(applyUrl) + '" class="tap block text-center text-white text-sm font-bold py-3 rounded-xl shadow mb-3" style="background:linear-gradient(135deg,#0ABAB5,#22d3ee)">' +
      (pct > 0 ? pct + '% OFF を使ってお買い物' : 'お買い物にすすむ') + ' &rarr;</a>';
  }
  if (items.length){
    if (applyUrl) html += '<p class="text-xs text-gray-400 mb-2">かんたん購入 (割引適用済み)</p>';
    html += '<div class="space-y-2">' + items.map(function(q){
      var price = q.price ? '¥' + Number(q.price).toLocaleString('ja-JP') : '';
      var img = q.imageUrl
        ? '<img src="' + esc(q.imageUrl) + '" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:10px;flex-shrink:0">'
        : '<div style="width:48px;height:48px;border-radius:10px;background:#f1f5f9;flex-shrink:0"></div>';
      return '<a href="' + esc(q.url) + '" class="tap flex items-center gap-3 p-2.5 rounded-xl" style="border:1px solid #e2e8f0">' +
        img +
        '<div class="flex-1 min-w-0"><p class="text-xs font-bold text-gray-800 truncate">' + esc(q.title) + '</p>' +
          (price ? '<p class="text-xs text-gray-500 mt-0.5">' + esc(price) + '</p>' : '') + '</div>' +
        '<span class="text-xs font-bold text-white px-3 py-1.5 rounded-lg shrink-0" style="background:#0ABAB5">購入</span>' +
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
  var head = '<div class="flex items-center justify-between mb-3"><p class="text-sm font-bold text-gray-700">&#x1F39F;&#xFE0F; 保有クーポン</p><span class="text-xs font-bold px-2 py-0.5 rounded-full" style="background:#ecfeff;color:#0ABAB5">'+list.length+'枚</span></div>';
  if (list.length === 0){
    card.innerHTML = head + '<p class="text-xs text-gray-400 text-center py-3">利用できるクーポンはまだありません</p>';
    return;
  }
  var rows = list.map(function(c){
    var exp = fmtMd(c.expiresAt);
    return '<div class="flex items-center gap-3 p-3 rounded-xl" style="background:linear-gradient(135deg,#f0fdfa,#faf5ff);border:1px solid #e2e8f0">' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-sm font-bold text-gray-800 truncate">'+esc(c.title || 'クーポン')+'</p>' +
        '<p class="text-xs font-bold mt-0.5" style="color:#0ABAB5">'+esc(couponValueLabel(c))+(exp ? ' <span class="text-gray-400 font-normal">/ '+esc(exp)+'まで</span>' : '')+'</p>' +
        '<p class="text-[11px] text-gray-400 mt-0.5 font-mono truncate">'+esc(c.code)+'</p>' +
      '</div>' +
      '<button type="button" data-code="'+esc(c.code)+'" class="copy-btn tap shrink-0 text-xs font-bold text-white px-3 py-2 rounded-lg shadow" style="background:#0ABAB5">コピー</button>' +
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
    return '<div class="ladder-row flex items-center justify-between px-4 py-2.5" style="'+(active?'background:#ecfeff':'')+'">' +
      '<div class="flex items-center gap-2">' +
        (active ? '<span style="color:#0ABAB5">&#x25B6;</span>' : '<span class="w-3 inline-block"></span>') +
        '<span class="en text-sm font-bold '+(active?'':'text-gray-600')+'" style="'+(active?'color:#0ABAB5':'')+'">'+esc(enName(r.id))+'</span>' +
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
      '<p class="text-[11px] text-gray-400 px-5 pb-4 pt-1 leading-relaxed">過去12ヶ月のお買い上げ金額で、毎月1日に自動で判定します（降格あり）。割引はサブスク割引と重ねてご利用いただけます。</p>' +
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
  document.getElementById('card-skeleton').style.display='none';
  renderRank(d);
  renderProgress(d);
  renderShop(d);
  renderCoupons(d);
  renderAbout(d);
  var cta=document.getElementById('store-cta'); if(cta) cta.style.display='block';
}

function showError(msg){
  document.getElementById('card-skeleton').style.display='none';
  var e=document.getElementById('error-card');
  e.style.display='block';
  if (msg) document.getElementById('error-detail').textContent = msg;
}

async function loadRank(){
  try {
    var res = await fetch(API_BASE + '/api/liff/my-rank', { headers: idToken ? { 'Authorization': 'Bearer ' + idToken } : {} });
    var body = await res.json().catch(function(){ return null; });
    if (res.status !== 200 || !body || !body.success){
      showError(body && body.error ? body.error : null);
      return;
    }
    renderAll(body.data);
  } catch (e) {
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
