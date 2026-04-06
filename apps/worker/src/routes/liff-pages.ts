import { Hono } from 'hono';
import type { Env } from '../index.js';

const liffPages = new Hono<Env>();

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * GET /liff/portal — LIFF マイページ SPA
 *
 * LIFF SDK で初期化 → IDトークン取得 → API呼び出し → セクション表示
 * Tailwind CSS CDN + LIFF SDK CDN を使用
 */
liffPages.get('/liff/portal', (c) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  // LIFF ID を LIFF_URL から抽出 (例: https://liff.line.me/1234567890-abcdefgh → 1234567890-abcdefgh)
  const liffId = liffUrl.replace('https://liff.line.me/', '');

  return c.html(portalPage(liffId, workerUrl));
});

function portalPage(liffId: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>naturism マイページ</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap');
    body { font-family: 'Noto Sans JP', system-ui, sans-serif; background: #f8f9fa; }
    .tab-active { color: #06C755; border-bottom: 2px solid #06C755; }
    .tab-inactive { color: #999; }
    .btn-primary { background: #06C755; color: #fff; }
    .btn-primary:active { background: #05a847; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .skeleton { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .progress-bar { transition: width 0.6s ease-out; }
    .streak-fire { animation: pulse 1s ease-in-out infinite alternate; }
    @keyframes pulse { 0% { transform: scale(1); } 100% { transform: scale(1.1); } }
    .section { display: none; }
    .section.active { display: block; }
  </style>
</head>
<body class="min-h-screen pb-20">

  <!-- Header -->
  <header class="bg-white sticky top-0 z-50 shadow-sm">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-800">naturism</h1>
      <div id="user-avatar" class="w-8 h-8 rounded-full bg-gray-200"></div>
    </div>
  </header>

  <!-- Tab Navigation -->
  <nav class="bg-white border-b sticky top-[52px] z-40">
    <div class="max-w-lg mx-auto flex">
      <button onclick="switchTab('home')" id="tab-home" class="flex-1 py-3 text-xs font-medium text-center tab-active">マイページ</button>
      <button onclick="switchTab('quiz')" id="tab-quiz" class="flex-1 py-3 text-xs font-medium text-center tab-inactive">診断</button>
      <button onclick="switchTab('intake')" id="tab-intake" class="flex-1 py-3 text-xs font-medium text-center tab-inactive">服用記録</button>
      <button onclick="switchTab('health')" id="tab-health" class="flex-1 py-3 text-xs font-medium text-center tab-inactive">体調</button>
      <button onclick="switchTab('shop')" id="tab-shop" class="flex-1 py-3 text-xs font-medium text-center tab-inactive">ストア</button>
    </div>
  </nav>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4">

    <!-- ===== HOME Section ===== -->
    <div id="section-home" class="section active space-y-4">
      <!-- Rank Card -->
      <div id="rank-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>

      <!-- Today's Tip -->
      <div id="tip-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>

      <!-- Coupons -->
      <div id="coupons-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>

      <!-- Referral -->
      <div id="referral-card" class="card p-4">
        <div class="skeleton h-16 rounded-lg"></div>
      </div>
    </div>

    <!-- ===== INTAKE Section ===== -->
    <div id="section-intake" class="section space-y-4">
      <!-- Streak -->
      <div id="streak-card" class="card p-4 text-center">
        <div class="skeleton h-32 rounded-lg"></div>
      </div>
      <!-- Log Button -->
      <button onclick="logIntake()" class="btn-primary w-full py-4 rounded-xl text-lg font-bold shadow-md">
        服用を記録する
      </button>
      <!-- Reminder -->
      <div id="reminder-card" class="card p-4">
        <div class="skeleton h-12 rounded-lg"></div>
      </div>
    </div>

    <!-- ===== HEALTH Section ===== -->
    <div id="section-health" class="section space-y-4">
      <!-- Summary -->
      <div id="health-summary" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>
      <!-- Log Form -->
      <div class="card p-4">
        <h3 class="text-sm font-bold text-gray-700 mb-3">今日の記録</h3>
        <div class="space-y-3">
          <div>
            <label class="text-xs text-gray-500">体重 (kg)</label>
            <input type="number" id="weight-input" step="0.1" min="30" max="200" class="w-full mt-1 p-2 border rounded-lg text-sm" placeholder="例: 58.5">
          </div>
          <div>
            <label class="text-xs text-gray-500">体調</label>
            <div class="flex gap-2 mt-1">
              <button onclick="setCondition('good')" data-cond="good" class="cond-btn flex-1 py-2 rounded-lg text-sm border">良い</button>
              <button onclick="setCondition('normal')" data-cond="normal" class="cond-btn flex-1 py-2 rounded-lg text-sm border">普通</button>
              <button onclick="setCondition('bad')" data-cond="bad" class="cond-btn flex-1 py-2 rounded-lg text-sm border">悪い</button>
            </div>
          </div>
          <div>
            <label class="text-xs text-gray-500">メモ</label>
            <input type="text" id="health-note" maxlength="500" class="w-full mt-1 p-2 border rounded-lg text-sm" placeholder="自由記入">
          </div>
          <button onclick="saveHealthLog()" class="btn-primary w-full py-3 rounded-lg text-sm font-bold">記録を保存</button>
        </div>
      </div>
    </div>

    <!-- ===== QUIZ Section ===== -->
    <div id="section-quiz" class="section space-y-4">
      <!-- Quiz Intro -->
      <div id="quiz-intro" class="card p-6 text-center">
        <div class="text-4xl mb-3">💊</div>
        <h2 class="text-lg font-bold text-gray-800 mb-2">あなたにぴったりの naturism は？</h2>
        <p class="text-sm text-gray-500 mb-4">8つの質問に答えるだけで、最適な商品をご提案します。</p>
        <button onclick="startQuiz()" class="btn-primary px-8 py-3 rounded-xl text-sm font-bold shadow-md">診断スタート</button>
      </div>

      <!-- Quiz Steps (hidden until started) -->
      <div id="quiz-steps" class="card p-5" style="display:none;">
        <div class="flex items-center justify-between mb-4">
          <p class="text-xs text-gray-400" id="quiz-progress">Q1 / 8</p>
          <div class="flex-1 mx-3 bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div id="quiz-progress-bar" class="bg-green-500 h-1.5 transition-all duration-300" style="width:12.5%"></div>
          </div>
        </div>
        <p class="text-sm font-bold text-gray-800 mb-4" id="quiz-question"></p>
        <div id="quiz-options" class="space-y-2"></div>
      </div>

      <!-- Quiz Result (hidden until complete) -->
      <div id="quiz-result" style="display:none;">
        <div class="card p-6 text-center">
          <p class="text-xs text-green-600 font-bold mb-2">あなたにおすすめ</p>
          <div class="text-4xl mb-2" id="result-emoji"></div>
          <h3 class="text-xl font-bold text-gray-800 mb-1" id="result-name"></h3>
          <p class="text-sm text-green-600 font-bold mb-3" id="result-price"></p>
          <p class="text-xs text-gray-600 leading-relaxed mb-4" id="result-reason"></p>
          <div class="flex gap-2">
            <a id="result-store-link" href="#" target="_blank" class="flex-1 btn-primary py-3 rounded-xl text-sm font-bold text-center block">商品を見る</a>
            <button onclick="retryQuiz()" class="flex-1 py-3 rounded-xl text-sm font-bold border border-gray-300 text-gray-600">もう一度</button>
          </div>
        </div>
        <!-- Score Breakdown -->
        <div class="card p-4 mt-4">
          <p class="text-xs text-gray-500 font-bold mb-3">スコア内訳</p>
          <div id="result-scores" class="space-y-2"></div>
        </div>
      </div>
    </div>

    <!-- ===== SHOP Section ===== -->
    <div id="section-shop" class="section space-y-4">
      <!-- Products -->
      <div id="products-card" class="card p-4">
        <div class="skeleton h-48 rounded-lg"></div>
      </div>
      <!-- Recent Orders -->
      <div id="orders-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>
      <!-- Fulfillments -->
      <div id="fulfillments-card" class="card p-4">
        <div class="skeleton h-24 rounded-lg"></div>
      </div>
    </div>

  </main>

  <!-- Loading overlay -->
  <div id="loading" class="fixed inset-0 bg-white bg-opacity-90 flex items-center justify-center z-50">
    <div class="text-center">
      <div class="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
      <p class="text-sm text-gray-500">読み込み中...</p>
    </div>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-full text-sm shadow-lg opacity-0 transition-opacity pointer-events-none z-50"></div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
let idToken = null;
let selectedCondition = null;

// ─── LIFF Init ───
let isDemo = false;

async function initLiff() {
  try {
    if (!LIFF_ID) throw new Error('LIFF_ID not configured');
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    idToken = liff.getIDToken();
    const profile = await liff.getProfile();
    if (profile.pictureUrl) {
      document.getElementById('user-avatar').innerHTML =
        '<img src="' + profile.pictureUrl + '" class="w-8 h-8 rounded-full">';
    }
    await Promise.all([loadRank(), loadTip(), loadCoupons()]);
    // 紹介リンク経由チェック（?ref=xxx）
    checkReferralParam();
    document.getElementById('loading').style.display = 'none';
  } catch (err) {
    console.error('LIFF init error:', err);
    // Demo mode: show UI with sample data for browser preview
    isDemo = true;
    loadDemoData();
    document.getElementById('loading').style.display = 'none';
  }
}

function loadDemoData() {
  // Demo banner
  var banner = document.createElement('div');
  banner.className = 'bg-yellow-50 border border-yellow-200 rounded-lg p-2 text-center text-xs text-yellow-700 mx-4 mt-2';
  banner.textContent = 'DEMO MODE - LINE\u30a2\u30d7\u30ea\u5185\u3067\u958b\u304f\u3068\u5b9f\u30c7\u30fc\u30bf\u304c\u8868\u793a\u3055\u308c\u307e\u3059';
  document.querySelector('nav').after(banner);

  // Avatar
  document.getElementById('user-avatar').innerHTML =
    '<div class="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center text-white text-xs font-bold">D</div>';

  // Rank
  document.getElementById('rank-card').innerHTML =
    '<div class="flex items-center gap-3 mb-3">' +
    '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:#C0C0C020">Ag</div>' +
    '<div><p class="text-sm font-bold text-gray-800">Silver</p>' +
    '<p class="text-xs text-gray-500">\u7d2f\u8a08 \xa515,000</p></div></div>' +
    '<div class="bg-gray-100 rounded-full h-2 overflow-hidden"><div class="bg-green-500 h-2 progress-bar" style="width:25%"></div></div>' +
    '<p class="text-xs text-gray-400 mt-1">\u6b21\u306e\u30e9\u30f3\u30af Gold \u307e\u3067\u3042\u3068 \xa59,000</p>';

  // Tip
  document.getElementById('tip-card').innerHTML =
    '<p class="text-xs text-green-600 font-bold mb-1">Today\\\'s Tip</p>' +
    '<p class="text-sm font-bold text-gray-800">\u6c34\u5206\u88dc\u7d66\u306e\u30b3\u30c4</p>' +
    '<p class="text-xs text-gray-600 mt-1">\u3053\u307e\u3081\u306a\u6c34\u5206\u88dc\u7d66\u304c\u5927\u5207\u3067\u3059\u3002\u98df\u4e8b\u306e30\u5206\u524d\u306b\u30b3\u30c3\u30d7\u4e00\u676f\u306e\u6c34\u3092\u98f2\u3080\u3068\u3001\u6d88\u5316\u3092\u30b5\u30dd\u30fc\u30c8\u3057\u307e\u3059\u3002</p>';

  // Coupons
  document.getElementById('coupons-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u30af\u30fc\u30dd\u30f3</p>' +
    '<div class="flex items-center justify-between py-2 border-b">' +
    '<div><p class="text-sm font-bold text-green-600">WELCOME500</p>' +
    '<p class="text-xs text-gray-500">500\u5186OFF (\u521d\u56de\u9650\u5b9a)</p></div>' +
    '<p class="text-xs text-gray-400">~2026-12-31</p></div>' +
    '<div class="flex items-center justify-between py-2">' +
    '<div><p class="text-sm font-bold text-green-600">SILVER10</p>' +
    '<p class="text-xs text-gray-500">10%OFF (\u30b7\u30eb\u30d0\u30fc\u7279\u5178)</p></div>' +
    '<p class="text-xs text-gray-400">~2026-06-30</p></div>';

  // Referral
  document.getElementById('referral-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u53cb\u3060\u3061\u7d39\u4ecb</p>' +
    '<p class="text-sm text-gray-700">\u7d39\u4ecb\u30ea\u30f3\u30af\u3092\u5171\u6709\u3057\u3066\u304a\u4e92\u3044\u306b\u30af\u30fc\u30dd\u30f3\u3092\u30b2\u30c3\u30c8!</p>' +
    '<div class="mt-2 flex items-center gap-2"><span class="bg-gray-100 px-3 py-1 rounded text-xs font-mono">ref-a1b2c3d4</span>' +
    '<button class="text-xs text-green-600 font-bold">\u30b3\u30d4\u30fc</button></div>';

  // Streak (intake)
  document.getElementById('streak-card').innerHTML =
    '<div class="text-4xl mb-2 streak-fire">&#x2B50;</div>' +
    '<p class="text-3xl font-bold text-gray-800">5<span class="text-sm text-gray-500 ml-1">\u65e5\u9023\u7d9a</span></p>' +
    '<div class="flex justify-center gap-6 mt-3 text-xs text-gray-500">' +
    '<div>\u6700\u9577 <span class="font-bold text-gray-800">12\u65e5</span></div>' +
    '<div>\u7d2f\u8a08 <span class="font-bold text-gray-800">45\u65e5</span></div></div>';

  // Reminder
  document.getElementById('reminder-card').innerHTML =
    '<div class="flex items-center justify-between">' +
    '<div><p class="text-sm font-bold text-gray-700">\u671d\u30ea\u30de\u30a4\u30f3\u30c9</p>' +
    '<p class="text-xs text-gray-500">08:00 \u306b\u30d7\u30c3\u30b7\u30e5\u901a\u77e5</p></div>' +
    '<div class="w-10 h-6 bg-green-500 rounded-full relative"><div class="w-5 h-5 bg-white rounded-full absolute right-0.5 top-0.5 shadow"></div></div></div>';

  // Health summary
  document.getElementById('health-summary').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u76f4\u8fd17\u65e5\u9593</p>' +
    '<div class="grid grid-cols-3 gap-2 text-center">' +
    '<div class="bg-green-50 rounded-lg p-2"><p class="text-lg font-bold text-green-600">4</p><p class="text-xs text-gray-500">\u826f\u3044</p></div>' +
    '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-yellow-600">2</p><p class="text-xs text-gray-500">\u666e\u901a</p></div>' +
    '<div class="bg-red-50 rounded-lg p-2"><p class="text-lg font-bold text-red-600">1</p><p class="text-xs text-gray-500">\u60aa\u3044</p></div></div>' +
    '<p class="text-xs text-gray-500 mt-2">\u6700\u65b0\u4f53\u91cd: 58.5kg</p>';

  // Products
  document.getElementById('products-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-3">\u5546\u54c1\u30e9\u30a4\u30f3\u30ca\u30c3\u30d7</p>' +
    '<div class="flex items-center gap-3 py-3 border-b">' +
    '<div class="w-16 h-16 rounded-lg bg-blue-50 flex items-center justify-center text-2xl">B</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">naturism Blue</p>' +
    '<p class="text-xs text-gray-500">8\u6210\u5206\u30fb\u8102\u8cea\u30ab\u30c3\u30c8\u7279\u5316</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,376</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>' +
    '<div class="flex items-center gap-3 py-3 border-b">' +
    '<div class="w-16 h-16 rounded-lg bg-pink-50 flex items-center justify-center text-2xl">P</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">KOSO in naturism Pink</p>' +
    '<p class="text-xs text-gray-500">10\u6210\u5206\u30fb\u7f8e\u5bb9+\u98df\u4e8b\u30b1\u30a2</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,830</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>' +
    '<div class="flex items-center gap-3 py-3">' +
    '<div class="w-16 h-16 rounded-lg bg-gray-50 flex items-center justify-center text-2xl">Pr</div>' +
    '<div class="flex-1"><p class="text-sm font-bold text-gray-800">naturism Premium</p>' +
    '<p class="text-xs text-gray-500">16\u6210\u5206\u30fb\u6a5f\u80fd\u6027\u8868\u793a\u98df\u54c1</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa55,590</p></div>' +
    '<span class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">\u8cfc\u5165</span></div>';

  // Orders
  document.getElementById('orders-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u6700\u8fd1\u306e\u6ce8\u6587</p>' +
    '<div class="py-2 border-b"><div class="flex justify-between items-center"><p class="text-sm font-bold">#1042</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa56,415</p></div><p class="text-xs text-gray-400">2026-03-28</p></div>' +
    '<div class="py-2"><div class="flex justify-between items-center"><p class="text-sm font-bold">#1035</p>' +
    '<p class="text-sm text-green-600 font-bold">\xa52,830</p></div><p class="text-xs text-gray-400">2026-03-01</p></div>';

  // Quiz (demo keeps intro visible, no special demo data needed)

  // Fulfillments
  document.getElementById('fulfillments-card').innerHTML =
    '<p class="text-xs text-gray-500 font-bold mb-2">\u914d\u9001\u72b6\u6cc1</p>' +
    '<div class="py-2"><div class="flex justify-between"><p class="text-sm">#1042</p>' +
    '<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">delivered</span></div>' +
    '<p class="text-xs text-blue-500">\u30e4\u30de\u30c8\u904b\u8f38 1234-5678-9012</p></div>';
}

// ─── API Helper ───
async function api(path, body = {}) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  return res.json();
}

// ─── Tab Switching ───
function switchTab(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => { b.className = b.className.replace('tab-active', 'tab-inactive'); });
  document.getElementById('section-' + name).classList.add('active');
  document.getElementById('tab-' + name).className = document.getElementById('tab-' + name).className.replace('tab-inactive', 'tab-active');

  // Lazy load section data
  if (name === 'intake') loadIntakeData();
  if (name === 'health') loadHealthData();
  if (name === 'shop') loadShopData();
}

// ─── Toast ───
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 2000);
}

// ─── HOME: Rank ───
async function loadRank() {
  try {
    const { data } = await api('/api/liff/rank');
    if (!data) return;
    const el = document.getElementById('rank-card');
    if (data.currentRank) {
      const pct = data.progressPercent || 0;
      el.innerHTML = '<div class="flex items-center gap-3 mb-3">' +
        '<div class="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style="background:' + (data.currentRank.color || '#ccc') + '20">' + (data.currentRank.icon || '') + '</div>' +
        '<div><p class="text-sm font-bold text-gray-800">' + data.currentRank.name + '</p>' +
        '<p class="text-xs text-gray-500">累計 ¥' + Number(data.totalSpent).toLocaleString() + '</p></div></div>' +
        '<div class="bg-gray-100 rounded-full h-2 overflow-hidden"><div class="bg-green-500 h-2 progress-bar" style="width:' + pct + '%"></div></div>' +
        (data.nextRank ? '<p class="text-xs text-gray-400 mt-1">次のランク ' + data.nextRank.name + ' まであと ¥' + Number(data.nextRank.remaining).toLocaleString() + '</p>' : '<p class="text-xs text-green-600 mt-1">最高ランク達成!</p>');
    } else {
      el.innerHTML = '<p class="text-sm text-gray-500">まだ購入履歴がありません</p>';
    }
  } catch { /* ignore */ }
}

// ─── HOME: Today's Tip ───
async function loadTip() {
  try {
    const { data } = await apiGet('/api/liff/tips/today');
    const el = document.getElementById('tip-card');
    if (data) {
      el.innerHTML = '<p class="text-xs text-green-600 font-bold mb-1">Today\\'s Tip</p>' +
        '<p class="text-sm font-bold text-gray-800">' + data.title + '</p>' +
        '<p class="text-xs text-gray-600 mt-1">' + data.content + '</p>';
    } else {
      el.innerHTML = '<p class="text-xs text-gray-400">今日のTipはまだありません</p>';
    }
  } catch { /* ignore */ }
}

// ─── HOME: Coupons ───
async function loadCoupons() {
  try {
    const { data } = await api('/api/liff/coupons');
    const el = document.getElementById('coupons-card');
    if (data && data.coupons && data.coupons.length > 0) {
      el.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">クーポン</p>' +
        data.coupons.map(function(cp) {
          return '<div class="flex items-center justify-between py-2 border-b last:border-0">' +
            '<div><p class="text-sm font-bold text-green-600">' + cp.code + '</p>' +
            '<p class="text-xs text-gray-500">' + cp.title + '</p></div>' +
            '<p class="text-xs text-gray-400">' + (cp.expiresAt ? '~' + cp.expiresAt.slice(0, 10) : '') + '</p></div>';
        }).join('');
    } else {
      el.innerHTML = '<p class="text-xs text-gray-400">利用可能なクーポンはありません</p>';
    }
  } catch { /* ignore */ }
}

// ─── INTAKE Section ───
async function loadIntakeData() {
  try {
    const { data } = await api('/api/liff/intake/streak');
    const el = document.getElementById('streak-card');
    if (data) {
      const fire = data.currentStreak >= 3 ? ' streak-fire' : '';
      el.innerHTML = '<div class="text-4xl mb-2' + fire + '">' + (data.currentStreak >= 7 ? '&#x1F525;' : data.currentStreak >= 3 ? '&#x2B50;' : '&#x1F331;') + '</div>' +
        '<p class="text-3xl font-bold text-gray-800">' + data.currentStreak + '<span class="text-sm text-gray-500 ml-1">日連続</span></p>' +
        '<div class="flex justify-center gap-6 mt-3 text-xs text-gray-500">' +
        '<div>最長 <span class="font-bold text-gray-800">' + data.longestStreak + '日</span></div>' +
        '<div>累計 <span class="font-bold text-gray-800">' + data.totalDays + '日</span></div></div>';
    }
  } catch { /* ignore */ }
}

async function logIntake() {
  if (isDemo) { showToast('DEMO: 記録しました! (連続6日)'); return; }
  try {
    const { data } = await api('/api/liff/intake', { productName: 'naturism' });
    if (data) {
      showToast('記録しました! (連続' + data.streakCount + '日)');
      loadIntakeData();
    }
  } catch { showToast('記録に失敗しました'); }
}

// ─── HEALTH Section ───
async function loadHealthData() {
  try {
    const { data } = await api('/api/liff/health/summary');
    const el = document.getElementById('health-summary');
    if (data) {
      el.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">直近7日間</p>' +
        '<div class="grid grid-cols-3 gap-2 text-center">' +
        '<div class="bg-green-50 rounded-lg p-2"><p class="text-lg font-bold text-green-600">' + data.goodDays + '</p><p class="text-xs text-gray-500">良い</p></div>' +
        '<div class="bg-yellow-50 rounded-lg p-2"><p class="text-lg font-bold text-yellow-600">' + data.normalDays + '</p><p class="text-xs text-gray-500">普通</p></div>' +
        '<div class="bg-red-50 rounded-lg p-2"><p class="text-lg font-bold text-red-600">' + data.badDays + '</p><p class="text-xs text-gray-500">悪い</p></div></div>' +
        (data.latestWeight ? '<p class="text-xs text-gray-500 mt-2">最新体重: ' + data.latestWeight + 'kg</p>' : '');
    }
  } catch { /* ignore */ }
}

function setCondition(cond) {
  selectedCondition = cond;
  document.querySelectorAll('.cond-btn').forEach(function(b) {
    b.className = b.className.replace('bg-green-500 text-white', '').replace('bg-yellow-500 text-white', '').replace('bg-red-500 text-white', '') + ' bg-white';
  });
  var btn = document.querySelector('[data-cond="' + cond + '"]');
  var colors = { good: 'bg-green-500 text-white', normal: 'bg-yellow-500 text-white', bad: 'bg-red-500 text-white' };
  btn.className = btn.className.replace('bg-white', '') + ' ' + colors[cond];
}

async function saveHealthLog() {
  if (isDemo) { showToast('DEMO: 体調を記録しました'); return; }
  var weight = parseFloat(document.getElementById('weight-input').value);
  var note = document.getElementById('health-note').value;
  try {
    await api('/api/liff/health/log', {
      weight: isNaN(weight) ? undefined : weight,
      condition: selectedCondition,
      note: note || undefined,
    });
    showToast('体調を記録しました');
    loadHealthData();
    document.getElementById('weight-input').value = '';
    document.getElementById('health-note').value = '';
    selectedCondition = null;
    document.querySelectorAll('.cond-btn').forEach(function(b) {
      b.className = b.className.replace('bg-green-500 text-white', '').replace('bg-yellow-500 text-white', '').replace('bg-red-500 text-white', '') + ' bg-white';
    });
  } catch { showToast('記録に失敗しました'); }
}

// ─── SHOP Section ───
async function loadShopData() {
  try {
    const { data } = await api('/api/liff/reorder');
    if (data) {
      // Products
      var pel = document.getElementById('products-card');
      if (data.products && data.products.length > 0) {
        pel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-3">商品ラインナップ</p>' +
          data.products.map(function(p) {
            return '<div class="flex items-center gap-3 py-3 border-b last:border-0">' +
              (p.imageUrl ? '<img src="' + p.imageUrl + '" class="w-16 h-16 rounded-lg object-cover">' : '<div class="w-16 h-16 rounded-lg bg-gray-100"></div>') +
              '<div class="flex-1"><p class="text-sm font-bold text-gray-800">' + p.title + '</p>' +
              '<p class="text-sm text-green-600 font-bold">¥' + Number(p.price).toLocaleString() + '</p></div>' +
              '<a href="' + p.storeUrl + '" target="_blank" class="text-xs text-green-600 border border-green-600 px-3 py-1 rounded-full">購入</a></div>';
          }).join('');
      }
      // Orders
      var oel = document.getElementById('orders-card');
      if (data.recentOrders && data.recentOrders.length > 0) {
        oel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">最近の注文</p>' +
          data.recentOrders.map(function(o) {
            return '<div class="py-2 border-b last:border-0">' +
              '<div class="flex justify-between items-center"><p class="text-sm font-bold">#' + o.orderNumber + '</p>' +
              '<p class="text-sm text-green-600 font-bold">¥' + Number(o.totalPrice).toLocaleString() + '</p></div>' +
              '<p class="text-xs text-gray-400">' + (o.createdAt || '').slice(0, 10) + '</p></div>';
          }).join('');
      } else {
        oel.innerHTML = '<p class="text-xs text-gray-400">まだ注文がありません</p>';
      }
    }
  } catch { /* ignore */ }

  // Fulfillments
  try {
    const { data } = await api('/api/liff/fulfillments');
    var fel = document.getElementById('fulfillments-card');
    if (data && data.fulfillments && data.fulfillments.length > 0) {
      fel.innerHTML = '<p class="text-xs text-gray-500 font-bold mb-2">配送状況</p>' +
        data.fulfillments.slice(0, 3).map(function(f) {
          return '<div class="py-2 border-b last:border-0">' +
            '<div class="flex justify-between"><p class="text-sm">#' + f.orderNumber + '</p>' +
            '<span class="text-xs px-2 py-0.5 rounded-full ' + (f.status === 'delivered' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700') + '">' + (f.status || 'in_transit') + '</span></div>' +
            (f.trackingUrl ? '<a href="' + f.trackingUrl + '" target="_blank" class="text-xs text-blue-500 underline">追跡する</a>' : '') + '</div>';
        }).join('');
    } else {
      fel.innerHTML = '<p class="text-xs text-gray-400">配送情報はありません</p>';
    }
  } catch { /* ignore */ }
}

// ─── Referral Claim (auto-detect ?ref= param) ───
function checkReferralParam() {
  try {
    var params = new URLSearchParams(window.location.search);
    var ref = params.get('ref');
    if (!ref) return;
    // Clean URL (remove ref param)
    var url = new URL(window.location.href);
    url.searchParams.delete('ref');
    window.history.replaceState({}, '', url.toString());
    // Claim referral (non-blocking)
    api('/api/liff/referral/claim', { refCode: ref }).then(function(res) {
      if (res.success && res.data && !res.data.alreadyClaimed) {
        showToast('紹介リンクが適用されました!');
      }
    }).catch(function() {});
  } catch(e) { /* ignore */ }
}

// ─── QUIZ Engine (client-side) ───
var QUIZ_QUESTIONS = [
  { id: 'q1', text: 'naturismを試すのは初めてですか？', options: [
    { label: '初めてです', scores: { blue: 3, pink: 0, premium: 0 } },
    { label: '飲んだことがあります', scores: { blue: 0, pink: 1, premium: 1 } },
    { label: '今飲んでいて、別の種類を検討中', scores: { blue: 0, pink: 0, premium: 2 } },
  ]},
  { id: 'q2', text: '普段の食事で一番多いのは？', options: [
    { label: '揚げ物・脂っこい料理が多い', scores: { blue: 3, pink: 0, premium: 0 } },
    { label: 'ご飯・パン・麺類など炭水化物が中心', scores: { blue: 0, pink: 0, premium: 3 } },
    { label: 'バランスよく食べている', scores: { blue: 0, pink: 2, premium: 0 } },
    { label: '外食やコンビニが中心で偏りがち', scores: { blue: 0, pink: 1, premium: 2 } },
  ]},
  { id: 'q3', text: '一週間でスイーツやお菓子を食べる頻度は？', options: [
    { label: 'ほぼ毎日', scores: { blue: 0, pink: 0, premium: 3 } },
    { label: '週3〜4回', scores: { blue: 0, pink: 0, premium: 2 } },
    { label: '週1〜2回', scores: { blue: 1, pink: 1, premium: 0 } },
    { label: 'ほとんど食べない', scores: { blue: 2, pink: 0, premium: 0 } },
  ]},
  { id: 'q4', text: '美容面で気になることはありますか？', options: [
    { label: '肌のハリやツヤが気になる', scores: { blue: 0, pink: 3, premium: 0 } },
    { label: '消化が重い・胃もたれしやすい', scores: { blue: 0, pink: 3, premium: 0 } },
    { label: '特に気にならない', scores: { blue: 2, pink: 0, premium: 0 } },
    { label: '全体的にケアしたい', scores: { blue: 0, pink: 0, premium: 2 } },
  ]},
  { id: 'q5', text: '体型管理への本気度は？', options: [
    { label: '本格的に取り組みたい', scores: { blue: 0, pink: 0, premium: 3 } },
    { label: '少し意識している程度', scores: { blue: 0, pink: 2, premium: 0 } },
    { label: 'まずは気軽に始めたい', scores: { blue: 3, pink: 0, premium: 0 } },
    { label: '食事制限なしで何かしたい', scores: { blue: 2, pink: 1, premium: 0 } },
  ]},
  { id: 'q6', text: 'アレルギーで気になるものはありますか？', options: [
    { label: 'オレンジ・キウイ・バナナ・大豆・ゴマ等にアレルギーがある', scores: { blue: 5, pink: 0, premium: 0 }, excludes: ['pink','premium'] },
    { label: '特にない', scores: { blue: 0, pink: 0, premium: 0 } },
    { label: 'よくわからない', scores: { blue: 1, pink: 0, premium: 0 } },
  ]},
  { id: 'q7', text: '1日あたりの予算はどのくらいをイメージしていますか？', options: [
    { label: '¥60〜70くらい（コーヒー1杯分）', scores: { blue: 3, pink: 0, premium: 0 } },
    { label: '¥70〜100くらい', scores: { blue: 0, pink: 3, premium: 0 } },
    { label: '¥100〜150くらい、しっかり投資したい', scores: { blue: 0, pink: 0, premium: 3 } },
    { label: '良いものなら価格は気にしない', scores: { blue: 0, pink: 0, premium: 2 } },
  ]},
  { id: 'q8', text: 'naturismに一番期待することは？', options: [
    { label: '毎日の食事のお供としてシンプルに始めたい', scores: { blue: 3, pink: 0, premium: 0 } },
    { label: '美容と食事ケアを両立したい', scores: { blue: 0, pink: 3, premium: 0 } },
    { label: '炭水化物や糖質が気になる食生活を本格サポートしてほしい', scores: { blue: 0, pink: 0, premium: 3 } },
    { label: '食べることを我慢せず、できることから始めたい', scores: { blue: 2, pink: 1, premium: 0 } },
  ]},
];

var QUIZ_PRODUCTS = {
  blue: { name: 'naturism Blue', emoji: '\\u{1F499}', price: '\\u00a564/日〜', components: 8, reason: '脂質カットに特化したエントリーモデル。11年以上のロングセラーで、シンプルに始めたい方に最適です。', storeUrl: 'https://naturism-diet.com' },
  pink: { name: 'KOSO in naturism Pink', emoji: '\\u{1F497}', price: '\\u00a575/日〜', components: 10, reason: 'Blueの8成分に加え、穀物麹由来の活きた酵素360mgを配合。食事ケアと美容を両立したい方のためにデザインされています。', storeUrl: 'https://naturism-diet.com' },
  premium: { name: 'naturism Premium', emoji: '\\u{1FA76}', price: '\\u00a5149/日〜', components: 16, reason: '全16成分配合のフラッグシップ。白インゲン豆324mg・サラシア・ブラックジンジャーなど糖質対応成分を含む機能性表示食品です。', storeUrl: 'https://naturism-diet.com' },
};

var quizCurrentStep = 0;
var quizAnswers = {};
var quizExcluded = [];

function startQuiz() {
  quizCurrentStep = 0;
  quizAnswers = {};
  quizExcluded = [];
  document.getElementById('quiz-intro').style.display = 'none';
  document.getElementById('quiz-result').style.display = 'none';
  document.getElementById('quiz-steps').style.display = 'block';
  renderQuizStep();
}

function retryQuiz() {
  startQuiz();
}

function renderQuizStep() {
  var q = QUIZ_QUESTIONS[quizCurrentStep];
  document.getElementById('quiz-progress').textContent = 'Q' + (quizCurrentStep + 1) + ' / ' + QUIZ_QUESTIONS.length;
  document.getElementById('quiz-progress-bar').style.width = ((quizCurrentStep + 1) / QUIZ_QUESTIONS.length * 100) + '%';
  document.getElementById('quiz-question').textContent = q.text;

  var optHtml = '';
  for (var i = 0; i < q.options.length; i++) {
    var opt = q.options[i];
    optHtml += '<button onclick="selectQuizOption(' + quizCurrentStep + ',' + i + ')" class="w-full text-left px-4 py-3 rounded-xl border border-gray-200 text-sm text-gray-700 hover:border-green-400 hover:bg-green-50 transition-colors active:bg-green-100">' + opt.label + '</button>';
  }
  document.getElementById('quiz-options').innerHTML = optHtml;
}

function selectQuizOption(stepIdx, optIdx) {
  var q = QUIZ_QUESTIONS[stepIdx];
  var opt = q.options[optIdx];
  quizAnswers[q.id] = opt.label;

  // Track excludes
  if (opt.excludes) {
    for (var e = 0; e < opt.excludes.length; e++) {
      if (quizExcluded.indexOf(opt.excludes[e]) === -1) quizExcluded.push(opt.excludes[e]);
    }
  }

  // Highlight selected
  var btns = document.getElementById('quiz-options').querySelectorAll('button');
  for (var b = 0; b < btns.length; b++) {
    btns[b].className = btns[b].className.replace('border-green-500 bg-green-50 font-bold', 'border-gray-200');
  }
  btns[optIdx].className = btns[optIdx].className.replace('border-gray-200', 'border-green-500 bg-green-50 font-bold');

  // Auto advance after short delay
  setTimeout(function() {
    if (quizCurrentStep < QUIZ_QUESTIONS.length - 1) {
      quizCurrentStep++;
      renderQuizStep();
    } else {
      finishQuiz();
    }
  }, 300);
}

function finishQuiz() {
  // Score calculation (mirrors quiz-engine.ts)
  var scores = { blue: 0, pink: 0, premium: 0 };
  for (var i = 0; i < QUIZ_QUESTIONS.length; i++) {
    var q = QUIZ_QUESTIONS[i];
    var label = quizAnswers[q.id];
    if (!label) continue;
    for (var j = 0; j < q.options.length; j++) {
      if (q.options[j].label === label) {
        var s = q.options[j].scores;
        scores.blue += s.blue || 0;
        scores.pink += s.pink || 0;
        scores.premium += s.premium || 0;
        break;
      }
    }
  }

  // Zero out excluded
  for (var e = 0; e < quizExcluded.length; e++) {
    scores[quizExcluded[e]] = 0;
  }

  // Find winner (tie-break: blue > pink > premium)
  var winner = 'blue';
  var winScore = scores.blue;
  if (scores.pink > winScore) { winner = 'pink'; winScore = scores.pink; }
  if (scores.premium > winScore) { winner = 'premium'; winScore = scores.premium; }

  var product = QUIZ_PRODUCTS[winner];

  // Display result
  document.getElementById('quiz-steps').style.display = 'none';
  document.getElementById('quiz-result').style.display = 'block';
  document.getElementById('result-emoji').textContent = product.emoji;
  document.getElementById('result-name').textContent = product.name;
  document.getElementById('result-price').textContent = product.price + '（' + product.components + '成分）';
  document.getElementById('result-reason').textContent = product.reason;
  document.getElementById('result-store-link').href = product.storeUrl;

  // Score bars
  var maxScore = Math.max(scores.blue, scores.pink, scores.premium, 1);
  var colors = { blue: '#3B82F6', pink: '#EC4899', premium: '#6B7280' };
  var names = { blue: 'Blue', pink: 'Pink', premium: 'Premium' };
  var barsHtml = '';
  for (var key in scores) {
    var pct = Math.round(scores[key] / maxScore * 100);
    barsHtml += '<div class="flex items-center gap-2"><span class="text-xs w-16 text-gray-500">' + names[key] + '</span>' +
      '<div class="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden"><div class="h-2 rounded-full transition-all duration-500" style="width:' + pct + '%;background:' + colors[key] + '"></div></div>' +
      '<span class="text-xs text-gray-500 w-6 text-right">' + scores[key] + '</span></div>';
  }
  document.getElementById('result-scores').innerHTML = barsHtml;

  // Submit to server (non-blocking)
  if (!isDemo && idToken) {
    api('/api/liff/quiz/submit', { answers: quizAnswers }).catch(function() {});
  }
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', initLiff);
</script>
</body>
</html>`;
}

export { liffPages };
