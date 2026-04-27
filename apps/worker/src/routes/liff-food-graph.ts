import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * GET /liff/food/graph — 食事ログ集計グラフ SPA (PR-6)
 *
 * Chart.js (CDN) + LIFF SDK (CDN) + Tailwind CDN で動く inline HTML SPA。
 * バックエンドは PR-4 で実装済の以下を叩く:
 *   - GET /api/liff/food/stats/range?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   - GET /api/liff/food/report/:yearMonth
 * 全 API は LIFF idToken (Authorization: Bearer ...) で認証。
 */

export const liffFoodGraph = new Hono<Env>();

const graphHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(graphPage(liffId, workerUrl));
};
liffFoodGraph.get('/liff/food/graph', graphHandler as never);
liffFoodGraph.get('/liff/food/graph/', graphHandler as never);

function graphPage(liffId: string, apiBase: string): string {
  // LIFF_ID と API_BASE は inline JS 内で string literal として埋め込む。
  // どちらもサーバー env 由来 (XSS 経路なし) なので JSON.stringify で安全にエンコード。
  const liffIdLit = JSON.stringify(liffId);
  const apiBaseLit = JSON.stringify(apiBase);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>📊 食事グラフ — naturism</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent}
    body{font-family:'Noto Sans JP',system-ui,sans-serif;background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%);min-height:100vh}
    .card{background:rgba(255,255,255,.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:16px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.02)}
    .btn-primary{background:linear-gradient(135deg,#059669 0%,#06C755 100%);color:#fff;border:none;transition:transform .15s,box-shadow .15s;border-radius:12px}
    .btn-primary:active{transform:scale(0.97);box-shadow:0 2px 8px rgba(5,150,105,.3)}
    .range-btn{transition:all .15s;border-radius:10px;font-weight:500}
    .range-btn-active{background:linear-gradient(135deg,#059669,#06C755);color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.25)}
    .range-btn-inactive{background:#fff;color:#64748b;border:1px solid #e2e8f0}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:8px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .chart-wrap{position:relative;height:240px;width:100%}
    .empty-state{display:flex;align-items:center;justify-content:center;height:240px;color:#94a3b8;font-size:14px}
    #loading{background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%);position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:100}
    .spinner{width:36px;height:36px;border:3px solid #e2e8f0;border-top-color:#06C755;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(hover:hover){.btn-primary:hover{box-shadow:0 4px 16px rgba(5,150,105,.25)}}
  </style>
</head>
<body class="min-h-screen pb-20">

  <div id="loading"><div class="spinner"></div></div>

  <header class="sticky top-0 z-40" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
      <a href="/liff/food" class="text-emerald-600 text-sm font-medium hover:underline" aria-label="食事ログに戻る">&larr; 戻る</a>
      <h1 class="text-lg font-bold tracking-tight ml-1" style="background:linear-gradient(135deg,#059669,#06C755);-webkit-background-clip:text;-webkit-text-fill-color:transparent">📊 食事グラフ</h1>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4">

    <!-- Range tabs -->
    <div class="card p-3 flex gap-2" role="tablist" aria-label="集計期間">
      <button id="range-7"  class="range-btn flex-1 py-2 text-sm" data-range="7"  role="tab">7日</button>
      <button id="range-30" class="range-btn flex-1 py-2 text-sm" data-range="30" role="tab">30日</button>
      <button id="range-90" class="range-btn flex-1 py-2 text-sm" data-range="90" role="tab">90日</button>
    </div>

    <!-- Calorie chart card -->
    <section class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-bold text-gray-800">🔥 合計カロリー (kcal)</h2>
      </div>
      <div id="calorie-wrap" class="chart-wrap"><canvas id="calorie-chart"></canvas></div>
      <div id="calorie-empty" class="empty-state" style="display:none">データがありません</div>
    </section>

    <!-- PFC chart card -->
    <section class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-sm font-bold text-gray-800">🥗 PFC (g) — 積み上げ</h2>
        <div class="flex gap-3 text-xs text-gray-500">
          <span><span class="inline-block w-2 h-2 rounded-full" style="background:#10b981"></span> P</span>
          <span><span class="inline-block w-2 h-2 rounded-full" style="background:#f59e0b"></span> F</span>
          <span><span class="inline-block w-2 h-2 rounded-full" style="background:#3b82f6"></span> C</span>
        </div>
      </div>
      <div id="pfc-wrap" class="chart-wrap"><canvas id="pfc-chart"></canvas></div>
      <div id="pfc-empty" class="empty-state" style="display:none">データがありません</div>
    </section>

    <!-- Summary stats card -->
    <section class="card p-4">
      <h2 class="text-sm font-bold text-gray-800 mb-3">📈 期間サマリー</h2>
      <div id="summary-stats" class="grid grid-cols-2 gap-3 text-sm">
        <div class="skeleton h-16"></div><div class="skeleton h-16"></div>
        <div class="skeleton h-16"></div><div class="skeleton h-16"></div>
      </div>
    </section>

    <!-- Monthly report (collapsible) -->
    <section class="card p-4">
      <button id="report-toggle" class="btn-primary w-full py-2.5 text-sm font-bold" type="button">
        今月の AI レポートを見る
      </button>
      <div id="report-body" class="mt-3 text-sm text-gray-700 leading-relaxed" style="display:none"></div>
    </section>

  </main>

<script>
(function(){
  'use strict';

  var LIFF_ID = ${liffIdLit};
  var API_BASE = ${apiBaseLit};
  var idToken = null;
  var currentRange = 7; // default
  var calorieChart = null;
  var pfcChart = null;

  // ---- helpers ----
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayYearMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  function rangeDates(days) {
    var to = new Date();
    var from = new Date();
    from.setDate(to.getDate() - (days - 1));
    return { from: fmtDate(from), to: fmtDate(to) };
  }
  function shortLabel(yyyymmdd) {
    // "2026-04-27" -> "4/27"
    var parts = String(yyyymmdd).split('-');
    if (parts.length !== 3) return yyyymmdd;
    return Number(parts[1]) + '/' + Number(parts[2]);
  }

  function api(path) {
    var url = (API_BASE || '') + path;
    var headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = 'Bearer ' + idToken;
    return fetch(url, { method: 'GET', headers: headers })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }

  function showError(containerId, message) {
    var el = $(containerId);
    if (!el) return;
    el.style.display = 'flex';
    el.textContent = message;
  }

  // ---- chart rendering ----
  function destroyCharts() {
    if (calorieChart) { calorieChart.destroy(); calorieChart = null; }
    if (pfcChart) { pfcChart.destroy(); pfcChart = null; }
  }

  function renderCalorieChart(stats) {
    var wrap = $('calorie-wrap');
    var empty = $('calorie-empty');
    if (!stats || stats.length === 0) {
      wrap.style.display = 'none';
      empty.style.display = 'flex';
      empty.textContent = 'データがありません';
      return;
    }
    wrap.style.display = '';
    empty.style.display = 'none';

    var labels = stats.map(function(s) { return shortLabel(s.date); });
    var data = stats.map(function(s) { return Number(s.total_calories) || 0; });
    var ctx = $('calorie-chart').getContext('2d');
    calorieChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'kcal',
          data: data,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.12)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointBackgroundColor: '#ef4444',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { color: '#64748b', font: { size: 10 } } },
          x: { ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 0, autoSkip: true } },
        },
      },
    });
  }

  function renderPfcChart(stats) {
    var wrap = $('pfc-wrap');
    var empty = $('pfc-empty');
    if (!stats || stats.length === 0) {
      wrap.style.display = 'none';
      empty.style.display = 'flex';
      empty.textContent = 'データがありません';
      return;
    }
    wrap.style.display = '';
    empty.style.display = 'none';

    var labels = stats.map(function(s) { return shortLabel(s.date); });
    var protein = stats.map(function(s) { return Number(s.total_protein_g) || 0; });
    var fat = stats.map(function(s) { return Number(s.total_fat_g) || 0; });
    var carbs = stats.map(function(s) { return Number(s.total_carbs_g) || 0; });
    var ctx = $('pfc-chart').getContext('2d');
    pfcChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'P (g)', data: protein, backgroundColor: '#10b981' },
          { label: 'F (g)', data: fat, backgroundColor: '#f59e0b' },
          { label: 'C (g)', data: carbs, backgroundColor: '#3b82f6' },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { stacked: true, ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, beginAtZero: true, ticks: { color: '#64748b', font: { size: 10 } } },
        },
      },
    });
  }

  function renderSummary(stats) {
    var box = $('summary-stats');
    if (!box) return;
    if (!stats || stats.length === 0) {
      box.innerHTML = '<p class="col-span-2 text-gray-400 text-center py-4">データがありません</p>';
      return;
    }
    var n = stats.length;
    var sumCal = 0, sumP = 0, sumF = 0, sumC = 0, sumMeals = 0;
    for (var i = 0; i < n; i++) {
      sumCal   += Number(stats[i].total_calories) || 0;
      sumP     += Number(stats[i].total_protein_g) || 0;
      sumF     += Number(stats[i].total_fat_g) || 0;
      sumC     += Number(stats[i].total_carbs_g) || 0;
      sumMeals += Number(stats[i].meal_count) || 0;
    }
    var avgCal = Math.round(sumCal / n);
    var avgP = Math.round(sumP / n);
    var avgF = Math.round(sumF / n);
    var avgC = Math.round(sumC / n);

    function tile(label, value, unit) {
      // label/unit はリテラル, value は number なので textContent 経由でなくても XSS 経路なし
      return '<div class="bg-emerald-50/50 rounded-xl p-3 border border-emerald-100">' +
        '<p class="text-xs text-gray-500">' + label + '</p>' +
        '<p class="text-lg font-bold text-gray-800 mt-1">' + value + '<span class="text-xs text-gray-500 ml-1">' + unit + '</span></p>' +
        '</div>';
    }
    box.innerHTML =
      tile('平均カロリー', avgCal, 'kcal/日') +
      tile('食事回数 (合計)', sumMeals, '回') +
      tile('平均 P', avgP, 'g/日') +
      tile('平均 F・C', avgF + ' / ' + avgC, 'g/日');
  }

  // ---- data loading ----
  function setActiveRange(days) {
    currentRange = days;
    [7, 30, 90].forEach(function(d) {
      var btn = $('range-' + d);
      if (!btn) return;
      btn.classList.remove('range-btn-active', 'range-btn-inactive');
      btn.classList.add(d === days ? 'range-btn-active' : 'range-btn-inactive');
      btn.setAttribute('aria-selected', d === days ? 'true' : 'false');
    });
  }

  function loadRange(days) {
    setActiveRange(days);
    destroyCharts();
    var r = rangeDates(days);
    var path = '/api/liff/food/stats/range?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    return api(path).then(function(json) {
      if (!json || !json.success) {
        renderCalorieChart([]);
        renderPfcChart([]);
        renderSummary([]);
        return;
      }
      var stats = Array.isArray(json.data) ? json.data : [];
      renderCalorieChart(stats);
      renderPfcChart(stats);
      renderSummary(stats);
    }).catch(function(err) {
      console.error('loadRange error', err);
      renderCalorieChart([]);
      renderPfcChart([]);
      renderSummary([]);
    });
  }

  function loadMonthlyReport() {
    var body = $('report-body');
    if (!body) return;
    body.style.display = 'block';
    body.textContent = '読み込み中...';
    var ym = todayYearMonth();
    api('/api/liff/food/report/' + encodeURIComponent(ym)).then(function(json) {
      if (!json || !json.success || !json.data) {
        body.textContent = 'まだレポートが生成されていません';
        return;
      }
      var d = json.data;
      // summary_text は AI 生成 — XSS 防止のため textContent で流し込む
      body.textContent = '';
      var meta = document.createElement('p');
      meta.className = 'text-xs text-gray-500 mb-2';
      meta.textContent = (d.year_month || ym) +
        ' • 食事 ' + (Number(d.meal_count) || 0) + ' 回 • 平均 ' + (Number(d.avg_calories) || 0) + ' kcal/日';
      var summary = document.createElement('p');
      summary.className = 'text-sm text-gray-700 whitespace-pre-wrap';
      summary.textContent = String(d.summary_text || '');
      body.appendChild(meta);
      body.appendChild(summary);
    }).catch(function(err) {
      console.error('loadMonthlyReport error', err);
      body.textContent = 'レポート取得に失敗しました';
    });
  }

  function attachHandlers() {
    [7, 30, 90].forEach(function(d) {
      var btn = $('range-' + d);
      if (!btn) return;
      btn.addEventListener('click', function() { loadRange(d); });
    });
    var rt = $('report-toggle');
    if (rt) {
      rt.addEventListener('click', function() {
        var body = $('report-body');
        if (body && body.style.display === 'block' && body.textContent && body.textContent !== '読み込み中...') {
          // toggle close
          body.style.display = 'none';
          rt.textContent = '今月の AI レポートを見る';
          return;
        }
        rt.textContent = 'レポートを閉じる';
        loadMonthlyReport();
      });
    }
  }

  // ---- LIFF init ----
  function initLiff() {
    if (!LIFF_ID) {
      console.error('LIFF_ID not configured');
      finishInit();
      return;
    }
    if (typeof liff === 'undefined') {
      console.error('LIFF SDK not loaded');
      finishInit();
      return;
    }
    liff.init({ liffId: LIFF_ID }).then(function() {
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }
      idToken = liff.getIDToken();
      finishInit();
    }).catch(function(err) {
      console.error('LIFF init error', err);
      // demo / browser preview: idToken なしで API は 401 になる想定。プレースホルダ表示。
      finishInit();
    });
  }

  function finishInit() {
    var loading = $('loading');
    if (loading) loading.style.display = 'none';
    attachHandlers();
    setActiveRange(currentRange);
    loadRange(currentRange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLiff);
  } else {
    initLiff();
  }
})();
</script>
</body>
</html>`;
}
