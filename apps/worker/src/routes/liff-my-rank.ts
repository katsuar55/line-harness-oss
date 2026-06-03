import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  NATURISM_RANK_DEFS,
  resolveFriendRank,
  getLatestRankSnapshot,
} from '@line-crm/db';

/**
 * マイランク LIFF (= 自社内製ロイヤリティ, 2026-06-01, PR4)
 *
 * 役割: LINE ユーザーが自分の会員ランク (= trailing-12ヶ月で算出) を確認する pull 型 LIFF。
 *   - 会員証: rank バッジ + 割引% + 直近12ヶ月 購入額
 *   - 次ランクまでの進捗バー (= あと ¥X で昇格)
 *   - cb-admin 互換の rank (regular0/bronze2/silver4/gold6/platinum8 %)
 *
 * pull 型 = タップで開く LIFF のため push 課金ゼロ。豪華演出は Web (LIFF) 側で実装。
 *
 * 認証: API `/api/liff/my-rank` は liffAuthMiddleware (Authorization: Bearer idToken) で保護。
 *       検証済 friendId を c.get('liffUser') から取得。
 * 配置: ページ `/liff/my-rank` (末尾スラッシュ両対応、 公開 = HTML 自体は認証不要、 API 呼出時に検証)。
 *
 * 表示ロジック: live rank (= resolveFriendRank) を会員証に表示し常に最新。
 *   月次 snapshot (= getLatestRankSnapshot) は official 値として併せて返す (= PR8 降格通知の基盤)。
 */
const liffMyRank = new Hono<Env>();

// ─── API: 自分のランク ───
liffMyRank.get('/api/liff/my-rank', async (c) => {
  const liffUser = c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
  if (!liffUser) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const resolved = await resolveFriendRank(c.env.DB, liffUser.friendId, NATURISM_RANK_DEFS);
  const snapshot = await getLatestRankSnapshot(c.env.DB, liffUser.friendId);
  const p = resolved.progress;

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
    },
  });
});

// ─── ページ: 会員証 SPA ───
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const myRankPageHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(myRankPage(liffId, workerUrl));
};
liffMyRank.get('/liff/my-rank', myRankPageHandler as never);
liffMyRank.get('/liff/my-rank/', myRankPageHandler as never);

function myRankPage(liffId: string, apiBase: string): string {
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
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent}
    body{font-family:'Noto Sans JP',system-ui,sans-serif;background:linear-gradient(160deg,#ecfeff 0%,#f8fafc 45%,#faf5ff 100%);min-height:100vh}
    .card{background:rgba(255,255,255,.9);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:18px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 6px 20px rgba(0,0,0,.03)}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:10px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .bar-fill{transition:width 1.1s cubic-bezier(.22,1,.36,1)}
    .badge-glow{filter:drop-shadow(0 4px 10px rgba(0,0,0,.18))}
    #loading{background:linear-gradient(160deg,#ecfeff 0%,#f8fafc 45%,#faf5ff 100%)}
    .spinner{display:inline-block;width:32px;height:32px;border:3px solid #cffafe;border-top-color:#0ABAB5;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .pop{animation:pop .5s cubic-bezier(.22,1.4,.4,1) both}
    @keyframes pop{0%{transform:scale(.6);opacity:0}100%{transform:scale(1);opacity:1}}
  </style>
</head>
<body class="min-h-screen pb-16">

  <header class="sticky top-0 z-40" style="background:rgba(255,255,255,.9);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.05)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" class="text-xs text-gray-500 flex items-center gap-1">&larr; マイページ</a>
      <h1 class="text-base font-extrabold tracking-tight" style="color:#0ABAB5">&#x1F451; マイランク</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-5 space-y-4" id="main">
    <div id="demo-note" style="display:none;background:#fef9c3;color:#854d0e;border:1px solid #fde68a;border-radius:10px;padding:8px 12px;font-size:12px;text-align:center;">&#x1F441; これはデモ表示です（サンプルデータ）。実際のランクは LINE 内で表示されます。</div>
    <section id="card-skeleton" class="card p-6">
      <div class="skeleton h-32 rounded-2xl"></div>
    </section>
    <section id="rank-card" style="display:none;"></section>
    <section id="progress-card" style="display:none;"></section>
    <section id="error-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-2">&#x1F614;</p>
      <p class="text-sm font-bold text-gray-700 mb-1">ランク情報を取得できませんでした</p>
      <p class="text-xs text-gray-500" id="error-detail">しばらくしてからもう一度お試しください。</p>
    </section>
  </main>

  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center">
    <div class="spinner"></div>
    <p class="text-sm text-gray-400 mt-4">読み込み中...</p>
  </div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
let idToken = null;
// ?demo=1 でサンプル会員証を表示 (= LINE 文脈外でも UI 確認用、 認証/実データ不要)。
var DEMO_DATA = { rank: { id: 'silver', name: 'シルバー', discountPercent: 4, badgeEmoji: '\\uD83E\\uDD48', badgeColor: '#C0C0C0', badgeImageUrl: '/images/rank-silver-v2.png' }, trailing12moJpy: 15000, next: { id: 'gold', name: 'ゴールド', remainingJpy: 9000 }, progressRatio: 0.25, official: null };

function esc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function yen(n){ try{ return '\\u00A5' + Number(n||0).toLocaleString('ja-JP'); }catch(e){ return '\\u00A5' + (n||0); } }
// badgeColor は style 属性に入るため HTML-escape では不十分 (CSS injection 防止)。hex のみ allowlist 正規化。
// multi-brand で badge_color が DB ソース化しても安全 (= 現状 hardcoded だが将来 brand_config 由来になる)。
function safeColor(c){ return /^#[0-9A-Fa-f]{3,8}$/.test(String(c)) ? String(c) : '#0ABAB5'; }

function renderRank(d){
  var rank = d.rank || {};
  var color = safeColor(rank.badgeColor || '#0ABAB5');
  var emoji = rank.badgeEmoji || '\\u2728';
  var pct = Number.isFinite(rank.discountPercent) ? Math.floor(rank.discountPercent) : 0;
  var imgUrl = rank.badgeImageUrl;
  var badgeHtml = imgUrl
    ? '<img id="badge-img" src="' + esc(imgUrl) + '" alt="' + esc(rank.name) + '" style="height:176px;width:auto;max-width:172px;object-fit:contain;display:block;margin:0 auto;filter:drop-shadow(0 10px 22px rgba(0,0,0,.16))"><div id="badge-fallback" class="badge-glow" style="display:none;font-size:64px;line-height:1">' + esc(emoji) + '</div>'
    : '<div class="badge-glow" style="font-size:64px;line-height:1">' + esc(emoji) + '</div>';
  var card = document.getElementById('rank-card');
  card.className = 'card p-6 pop';
  card.style.display = 'block';
  card.innerHTML =
    '<div class="text-center">' +
      badgeHtml +
      '<p class="mt-2 text-xs tracking-widest font-semibold" style="color:' + color + '">YOUR RANK</p>' +
      '<p class="text-2xl font-extrabold text-gray-800 mt-1">' + esc(rank.name) + '</p>' +
      (pct > 0
        ? '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-white text-sm font-bold" style="background:' + color + '">' + pct + '% OFF 常時割引</div>'
        : '<div class="inline-flex items-center gap-1 mt-3 px-4 py-1.5 rounded-full text-gray-600 text-sm font-bold" style="background:#f1f5f9">まずは1回のお買い物でブロンズ会員に</div>') +
      '<p class="text-xs text-gray-400 mt-4">直近12ヶ月のお買い上げ ' + esc(yen(d.trailing12moJpy)) + '</p>' +
    '</div>';
  // 画像が無い/読込失敗時は emoji にフォールバック (inline onerror を避け JS で attach)。
  var bimg = document.getElementById('badge-img');
  if (bimg) {
    bimg.onerror = function(){ bimg.style.display = 'none'; var f = document.getElementById('badge-fallback'); if (f) f.style.display = 'block'; };
    if (bimg.complete && bimg.naturalWidth === 0) { bimg.onerror(); }
  }
}

function renderProgress(d){
  var card = document.getElementById('progress-card');
  card.style.display = 'block';
  if (!d.next){
    card.className = 'card p-5 text-center';
    card.innerHTML = '<p class="text-sm font-bold" style="color:#0ABAB5">\\u2728 最高ランク達成！いつもありがとうございます</p>';
    return;
  }
  var ratio = Math.max(0, Math.min(1, d.progressRatio || 0));
  var pctW = Math.round(ratio * 100);
  card.className = 'card p-5';
  card.innerHTML =
    '<div class="flex items-end justify-between mb-2">' +
      '<p class="text-xs text-gray-500">次のランク</p>' +
      '<p class="text-sm font-bold text-gray-800">' + esc(d.next.name) + '</p>' +
    '</div>' +
    '<div class="w-full h-3 rounded-full overflow-hidden" style="background:#e2e8f0">' +
      '<div class="bar-fill h-3 rounded-full" id="bar" style="width:0%;background:linear-gradient(90deg,#0ABAB5,#22d3ee)"></div>' +
    '</div>' +
    '<p class="text-xs text-gray-500 mt-2 text-center">あと <span class="font-bold" style="color:#0ABAB5">' + esc(yen(d.next.remainingJpy)) + '</span> で ' + esc(d.next.name) + 'にランクアップ</p>';
  // animate bar after paint
  setTimeout(function(){ var b = document.getElementById('bar'); if(b) b.style.width = pctW + '%'; }, 60);
}

function showError(msg){
  document.getElementById('card-skeleton').style.display = 'none';
  var e = document.getElementById('error-card');
  e.style.display = 'block';
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
    document.getElementById('card-skeleton').style.display = 'none';
    renderRank(body.data);
    renderProgress(body.data);
  } catch (e) {
    showError(null);
  }
}

async function initLiff(){
  try {
    if (new URLSearchParams(location.search).get('demo') === '1'){
      renderRank(DEMO_DATA); renderProgress(DEMO_DATA);
      var dn = document.getElementById('demo-note'); if (dn) dn.style.display = 'block';
      document.getElementById('card-skeleton').style.display = 'none';
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
    document.getElementById('loading').style.display = 'none';
  }
}

initLiff();
</script>
</body>
</html>`;
}

export { liffMyRank };
