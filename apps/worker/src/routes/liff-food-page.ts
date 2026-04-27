import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * LIFF 食事記録ページ (Phase 3 PR-5)
 *
 * 役割: LIFF SDK で IDトークンを取得 → /api/liff/food/* を呼び出して
 * 「今日の集計」「履歴」「手動入力」「削除」を提供する SPA。
 *
 * 認証: liffAuthMiddleware により Authorization: Bearer <idToken> ヘッダで保護。
 * バックエンド API は PR-4 で実装済 (apps/worker/src/routes/liff-portal.ts)。
 *
 * 配置: /liff/food (末尾スラッシュ両対応)
 *       戻るリンクは /liff/portal。
 */
const liffFoodPage = new Hono<Env>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const foodPageHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(foodPage(liffId, workerUrl));
};
liffFoodPage.get('/liff/food', foodPageHandler as never);
liffFoodPage.get('/liff/food/', foodPageHandler as never);

function foodPage(liffId: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>食事記録 — naturism</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent}
    body{font-family:'Noto Sans JP',system-ui,sans-serif;background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%);min-height:100vh}
    .btn-primary{background:linear-gradient(135deg,#059669 0%,#06C755 100%);color:#fff;border:none;transition:transform .15s,box-shadow .15s}
    .btn-primary:active{transform:scale(0.97);box-shadow:0 2px 8px rgba(5,150,105,.3)}
    .btn-secondary{background:#fff;color:#059669;border:1.5px solid #d1fae5;transition:background .15s}
    .btn-secondary:active{background:#ecfdf5}
    .btn-danger{background:#fff;color:#dc2626;border:1.5px solid #fecaca;transition:background .15s}
    .btn-danger:active{background:#fef2f2}
    .card{background:rgba(255,255,255,.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:16px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.02)}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:8px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    input[type="datetime-local"],input[type="number"],input[type="text"],textarea,select{border-radius:12px;border:1.5px solid #e2e8f0;padding:10px 12px;font-size:14px;transition:border-color .2s,box-shadow .2s;background:#fff;width:100%}
    input:focus,textarea:focus,select:focus{outline:none;border-color:#06C755;box-shadow:0 0 0 3px rgba(6,199,85,.12)}
    #toast{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(15,23,42,.85);font-weight:500;letter-spacing:.02em}
    #loading{background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%)}
    .badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
    .badge-meal{background:#ecfdf5;color:#059669}
    .badge-ai{background:#eff6ff;color:#2563eb}
    .badge-manual{background:#f5f3ff;color:#7c3aed}
    .badge-pending{background:#fef3c7;color:#b45309}
    .badge-failed{background:#fee2e2;color:#b91c1c}
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid #d1fae5;border-top-color:#059669;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    details>summary{cursor:pointer;list-style:none;outline:none}
    details>summary::-webkit-details-marker{display:none}
    details[open] .chevron{transform:rotate(180deg)}
    .chevron{transition:transform .2s}
    @media(hover:hover){.btn-primary:hover{box-shadow:0 4px 16px rgba(5,150,105,.25)}}
  </style>
</head>
<body class="min-h-screen pb-20">

  <!-- Header -->
  <header class="sticky top-0 z-50" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" class="text-xs text-gray-500 flex items-center gap-1">&larr; マイページ</a>
      <h1 class="text-base font-bold tracking-tight" style="background:linear-gradient(135deg,#059669,#06C755);-webkit-background-clip:text;-webkit-text-fill-color:transparent">&#x1F37D; 食事記録</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4">

    <!-- Today summary -->
    <section id="today-card" class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-sm font-bold text-gray-700">今日の集計</p>
        <p id="today-date-label" class="text-xs text-gray-400"></p>
      </div>
      <div id="today-body">
        <div class="skeleton h-20 rounded-lg"></div>
      </div>
    </section>

    <!-- Capture (info only — actual photo is sent via LINE chat) -->
    <section class="card p-4">
      <button onclick="openCaptureInfo()" class="btn-primary w-full py-3 rounded-2xl text-sm font-bold shadow-md">
        &#x1F4F7; 写真で記録する
      </button>
      <p class="text-xs text-gray-400 text-center mt-2">写真は LINE のトーク画面から送信してください</p>
    </section>

    <!-- Manual entry (collapsible) -->
    <section class="card p-4">
      <details>
        <summary class="flex items-center justify-between">
          <span class="text-sm font-bold text-gray-700">&#x270F;&#xFE0F; 手動で記録する</span>
          <span class="chevron text-gray-400">&#x25BE;</span>
        </summary>
        <form id="manual-form" class="mt-4 space-y-3" onsubmit="return false;">
          <div>
            <label class="text-xs text-gray-500 mb-1 block">食事日時</label>
            <input type="datetime-local" id="m-ate-at" required>
            <p class="text-[11px] text-gray-400 mt-1">今日から ±7日以内のみ登録できます</p>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">区分</label>
            <select id="m-meal-type">
              <option value="">未指定</option>
              <option value="breakfast">朝食</option>
              <option value="lunch">昼食</option>
              <option value="dinner">夕食</option>
              <option value="snack">間食</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-500 mb-1 block">食事内容</label>
            <textarea id="m-raw-text" rows="3" maxlength="500" placeholder="例: サラダチキン、玄米おにぎり、味噌汁"></textarea>
            <p class="text-[11px] text-gray-400 mt-1">最大 500 文字</p>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-500 mb-1 block">カロリー (kcal)</label>
              <input type="number" id="m-calories" min="0" step="1" placeholder="任意">
            </div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">タンパク質 (g)</label>
              <input type="number" id="m-protein" min="0" step="0.1" placeholder="任意">
            </div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">脂質 (g)</label>
              <input type="number" id="m-fat" min="0" step="0.1" placeholder="任意">
            </div>
            <div>
              <label class="text-xs text-gray-500 mb-1 block">炭水化物 (g)</label>
              <input type="number" id="m-carbs" min="0" step="0.1" placeholder="任意">
            </div>
          </div>
          <p class="text-[11px] text-gray-400">数値を1つ以上入力すると即時集計に反映されます (空のままだと「解析待ち」状態で登録)</p>
          <button id="m-submit" onclick="submitManual()" class="btn-primary w-full py-3 rounded-2xl text-sm font-bold shadow-md">記録する</button>
        </form>
      </details>
    </section>

    <!-- History list -->
    <section class="card p-4">
      <p class="text-sm font-bold text-gray-700 mb-3">記録履歴</p>
      <div id="history-list" class="space-y-3">
        <div class="skeleton h-16 rounded-lg"></div>
        <div class="skeleton h-16 rounded-lg"></div>
        <div class="skeleton h-16 rounded-lg"></div>
      </div>
      <button id="load-more-btn" onclick="loadMore()" style="display:none;" class="btn-secondary w-full py-2.5 rounded-2xl text-xs font-bold mt-4">もっと見る</button>
      <p id="history-empty" class="text-center text-xs text-gray-400 mt-2" style="display:none;">まだ記録がありません</p>
    </section>

  </main>

  <!-- Loading overlay -->
  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center" style="background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%)">
    <div class="spinner" style="width:32px;height:32px;border-width:3px;"></div>
    <p class="text-sm text-gray-400 mt-4">読み込み中...</p>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-24 left-1/2 -translate-x-1/2 text-white px-5 py-2.5 rounded-2xl text-sm shadow-xl opacity-0 transition-opacity pointer-events-none z-50"></div>

  <!-- Capture info modal -->
  <div id="capture-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(0,0,0,0.5);">
    <div style="position:absolute;bottom:0;left:0;right:0;background:#fff;border-radius:24px 24px 0 0;padding:24px;">
      <div class="flex justify-between items-center mb-3">
        <p class="text-sm font-bold text-gray-700">&#x1F4F7; 写真での記録方法</p>
        <button onclick="closeCaptureInfo()" class="text-gray-400 text-xl">&times;</button>
      </div>
      <ol class="text-sm text-gray-600 space-y-2 list-decimal list-inside">
        <li>このページを閉じて LINE のトーク画面に戻ります</li>
        <li>食事の写真を撮影 / 選択してそのまま送信します</li>
        <li>AI が栄養素を自動計算し、こちらの履歴に追加されます</li>
      </ol>
      <button onclick="closeCaptureInfo()" class="btn-primary w-full py-3 rounded-2xl text-sm font-bold mt-4">閉じる</button>
    </div>
  </div>

  <!-- Delete confirmation modal -->
  <div id="delete-modal" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:60;background:rgba(0,0,0,0.5);">
    <div style="position:absolute;bottom:0;left:0;right:0;background:#fff;border-radius:24px 24px 0 0;padding:24px;">
      <p class="text-sm font-bold text-gray-700 mb-2">この記録を削除しますか?</p>
      <p class="text-xs text-gray-500 mb-4">削除すると今日の集計からも差し引かれます。元に戻せません。</p>
      <div class="flex gap-2">
        <button onclick="closeDeleteModal()" class="btn-secondary flex-1 py-3 rounded-2xl text-sm font-bold">キャンセル</button>
        <button id="delete-confirm-btn" onclick="confirmDelete()" class="btn-danger flex-1 py-3 rounded-2xl text-sm font-bold">削除する</button>
      </div>
    </div>
  </div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
let idToken = null;
let nextCursor = null;
let pendingDeleteId = null;
let isDemo = false;

// ─── XSS escape ───
function esc(s) { if (s === null || s === undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── Toast ───
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(function() { t.style.opacity = '0'; }, 2200);
}

// ─── API helpers (Authorization: Bearer <idToken>) ───
function authHeaders(extra) {
  var h = extra || {};
  if (idToken) { h['Authorization'] = 'Bearer ' + idToken; }
  return h;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, { headers: authHeaders({}) });
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API_BASE + path, { method: 'DELETE', headers: authHeaders({}) });
  return res.json();
}

// ─── LIFF init ───
async function initLiff() {
  try {
    if (!LIFF_ID) throw new Error('LIFF_ID not configured');
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    idToken = liff.getIDToken();
    setDefaultDateTime();
    await Promise.all([loadTodayStats(), loadHistory(true)]);
    document.getElementById('loading').style.display = 'none';
  } catch (err) {
    console.error('LIFF init error:', err);
    isDemo = true;
    setDefaultDateTime();
    renderDemo();
    document.getElementById('loading').style.display = 'none';
  }
}

// ─── Today summary ───
async function loadTodayStats() {
  try {
    const res = await apiGet('/api/liff/food/stats/today');
    renderTodayStats(res && res.data ? res.data : null);
  } catch (e) {
    renderTodayStats(null);
  }
}

function renderTodayStats(stats) {
  var dateLabel = formatJstDate(new Date());
  var labelEl = document.getElementById('today-date-label');
  if (labelEl) labelEl.textContent = dateLabel;
  var el = document.getElementById('today-body');
  if (!stats) {
    el.innerHTML = '<p class="text-xs text-gray-500">まだ今日の記録はありません</p>';
    return;
  }
  var kcal = Math.round(Number(stats.total_calories) || 0);
  var p = Number(stats.total_protein_g) || 0;
  var f = Number(stats.total_fat_g) || 0;
  var c = Number(stats.total_carbs_g) || 0;
  var mealCount = Number(stats.meal_count) || 0;
  el.innerHTML =
    '<div class="flex items-baseline gap-2 mb-3">' +
    '<span class="text-3xl font-bold text-gray-800">' + kcal + '</span>' +
    '<span class="text-xs text-gray-400">kcal</span>' +
    '<span class="text-xs text-gray-400 ml-auto">' + mealCount + ' 食</span>' +
    '</div>' +
    '<div class="grid grid-cols-3 gap-2 text-center">' +
    '<div class="bg-emerald-50 rounded-lg py-2"><p class="text-xs text-gray-500">P</p><p class="text-sm font-bold text-emerald-700">' + p.toFixed(1) + 'g</p></div>' +
    '<div class="bg-amber-50 rounded-lg py-2"><p class="text-xs text-gray-500">F</p><p class="text-sm font-bold text-amber-700">' + f.toFixed(1) + 'g</p></div>' +
    '<div class="bg-blue-50 rounded-lg py-2"><p class="text-xs text-gray-500">C</p><p class="text-sm font-bold text-blue-700">' + c.toFixed(1) + 'g</p></div>' +
    '</div>';
}

// ─── History list ───
async function loadHistory(reset) {
  if (reset) {
    nextCursor = null;
    document.getElementById('history-list').innerHTML = '';
    document.getElementById('history-empty').style.display = 'none';
  }
  try {
    var qs = '?limit=20' + (nextCursor ? '&cursor=' + encodeURIComponent(nextCursor) : '');
    const res = await apiGet('/api/liff/food/logs' + qs);
    var data = res && res.data ? res.data : { logs: [], nextCursor: null };
    var logs = Array.isArray(data.logs) ? data.logs : [];
    nextCursor = data.nextCursor || null;

    var listEl = document.getElementById('history-list');
    if (reset && logs.length === 0) {
      listEl.innerHTML = '';
      document.getElementById('history-empty').style.display = 'block';
    } else {
      logs.forEach(function(log) {
        listEl.appendChild(renderLogCard(log));
      });
    }
    document.getElementById('load-more-btn').style.display = nextCursor ? 'block' : 'none';
  } catch (e) {
    console.error('loadHistory error:', e);
    showToast('履歴を取得できませんでした');
  }
}

function loadMore() {
  if (!nextCursor) return;
  loadHistory(false);
}

function renderLogCard(log) {
  var card = document.createElement('div');
  card.className = 'border border-gray-100 rounded-xl p-3';
  card.setAttribute('data-id', String(log.id || ''));

  var when = formatJstDateTime(log.ate_at);
  var meal = mealLabel(log.meal_type);
  var status = String(log.analysis_status || '');
  var aiAnalysis = parseAnalysis(log.ai_analysis);
  var isManual = aiAnalysis && aiAnalysis.model_version === 'manual';

  // header row
  var headerHtml =
    '<div class="flex items-center gap-2 mb-1 flex-wrap">' +
    '<span class="text-xs text-gray-500">' + esc(when) + '</span>' +
    (meal ? '<span class="badge badge-meal">' + esc(meal) + '</span>' : '') +
    (status === 'completed' ? '<span class="badge ' + (isManual ? 'badge-manual' : 'badge-ai') + '">' + (isManual ? '&#x270F;&#xFE0F; 手動' : '&#x1F916; AI') + '</span>' : '') +
    (status === 'pending' ? '<span class="badge badge-pending"><span class="spinner" style="margin-right:4px;"></span>解析中…</span>' : '') +
    (status === 'failed' ? '<span class="badge badge-failed">解析失敗</span>' : '') +
    '</div>';

  // calories / pfc summary
  var kcal = (log.total_calories !== null && log.total_calories !== undefined) ? Math.round(Number(log.total_calories)) : null;
  var summaryParts = [];
  if (kcal !== null) summaryParts.push(kcal + ' kcal');
  if (log.total_protein_g !== null && log.total_protein_g !== undefined) summaryParts.push('P ' + Number(log.total_protein_g).toFixed(1));
  if (log.total_fat_g !== null && log.total_fat_g !== undefined) summaryParts.push('F ' + Number(log.total_fat_g).toFixed(1));
  if (log.total_carbs_g !== null && log.total_carbs_g !== undefined) summaryParts.push('C ' + Number(log.total_carbs_g).toFixed(1));
  var summaryHtml = summaryParts.length
    ? '<p class="text-sm font-semibold text-gray-700">' + esc(summaryParts.join(' / ')) + '</p>'
    : '';

  // items / raw_text
  var bodyText = '';
  if (aiAnalysis && Array.isArray(aiAnalysis.items) && aiAnalysis.items.length > 0) {
    var names = aiAnalysis.items
      .map(function(it) { return it && typeof it.name === 'string' ? it.name : ''; })
      .filter(function(n) { return n.length > 0; });
    if (names.length > 0) {
      bodyText = names.slice(0, 5).join('、');
      if (names.length > 5) bodyText += ' ほか';
    }
  }
  if (!bodyText && log.raw_text) {
    bodyText = String(log.raw_text);
    if (bodyText.length > 80) bodyText = bodyText.slice(0, 80) + '…';
  }
  var bodyHtml = bodyText ? '<p class="text-xs text-gray-500 mt-1">' + esc(bodyText) + '</p>' : '';

  // error
  var errorHtml = (status === 'failed' && log.error_message)
    ? '<p class="text-xs text-red-500 mt-1">' + esc(String(log.error_message)) + '</p>'
    : '';

  // delete button
  var actionsHtml =
    '<div class="flex justify-end mt-2">' +
    '<button class="text-xs text-red-500 underline" onclick="askDelete(\\''+ esc(String(log.id || '')) +'\\')">削除</button>' +
    '</div>';

  card.innerHTML = headerHtml + summaryHtml + bodyHtml + errorHtml + actionsHtml;
  return card;
}

function parseAnalysis(s) {
  if (!s || typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

function mealLabel(t) {
  if (t === 'breakfast') return '朝食';
  if (t === 'lunch') return '昼食';
  if (t === 'dinner') return '夕食';
  if (t === 'snack') return '間食';
  return '';
}

// ─── Delete flow ───
function askDelete(id) {
  if (!id) return;
  pendingDeleteId = id;
  document.getElementById('delete-modal').style.display = 'block';
}
function closeDeleteModal() {
  pendingDeleteId = null;
  document.getElementById('delete-modal').style.display = 'none';
}
async function confirmDelete() {
  var id = pendingDeleteId;
  if (!id) return;
  var btn = document.getElementById('delete-confirm-btn');
  btn.disabled = true;
  btn.textContent = '削除中…';
  try {
    if (isDemo) {
      removeCardFromDom(id);
      showToast('DEMO: 削除しました');
    } else {
      var res = await apiDelete('/api/liff/food/logs/' + encodeURIComponent(id));
      if (res && res.success) {
        removeCardFromDom(id);
        showToast('削除しました');
        loadTodayStats();
      } else {
        showToast((res && res.error) || '削除に失敗しました');
      }
    }
  } catch (e) {
    showToast('削除に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '削除する';
    closeDeleteModal();
  }
}

function removeCardFromDom(id) {
  var node = document.querySelector('#history-list [data-id="' + cssEscape(id) + '"]');
  if (node && node.parentNode) node.parentNode.removeChild(node);
  // empty state
  if (!document.querySelector('#history-list > div')) {
    document.getElementById('history-empty').style.display = 'block';
  }
}

function cssEscape(s) {
  // Minimal CSS attribute selector escape for the id (UUID-like string is safe, but be defensive)
  return String(s).replace(/["\\\\]/g, '\\\\$&');
}

// ─── Manual entry ───
function setDefaultDateTime() {
  var input = document.getElementById('m-ate-at');
  if (!input) return;
  var now = new Date();
  // datetime-local expects local time string YYYY-MM-DDTHH:mm
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  var s = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
    'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  input.value = s;
}

function readNumberOrUndefined(id) {
  var el = document.getElementById(id);
  if (!el) return undefined;
  var raw = el.value;
  if (raw === '' || raw === null || raw === undefined) return undefined;
  var n = Number(raw);
  if (!isFinite(n) || n < 0) return undefined;
  return n;
}

async function submitManual() {
  var ateAtRaw = (document.getElementById('m-ate-at') || {}).value;
  if (!ateAtRaw) { showToast('日時を入力してください'); return; }
  // datetime-local → ISO with local offset → convert to ISO via Date
  var ateAtDate = new Date(ateAtRaw);
  if (isNaN(ateAtDate.getTime())) { showToast('日時の形式が正しくありません'); return; }
  // ±7d guard (client-side hint; server enforces too)
  var diffMs = Math.abs(Date.now() - ateAtDate.getTime());
  if (diffMs > 7 * 24 * 60 * 60 * 1000) {
    showToast('±7日以内の日時のみ登録できます');
    return;
  }

  var rawText = (document.getElementById('m-raw-text') || {}).value || '';
  if (rawText.length > 500) rawText = rawText.slice(0, 500);
  var mealType = (document.getElementById('m-meal-type') || {}).value || '';

  var payload = {
    ateAt: ateAtDate.toISOString(),
    rawText: rawText || undefined,
    mealType: mealType || undefined,
    calories: readNumberOrUndefined('m-calories'),
    proteinG: readNumberOrUndefined('m-protein'),
    fatG: readNumberOrUndefined('m-fat'),
    carbsG: readNumberOrUndefined('m-carbs'),
  };

  var btn = document.getElementById('m-submit');
  btn.disabled = true;
  btn.textContent = '記録中…';
  try {
    if (isDemo) {
      showToast('DEMO: 記録しました');
    } else {
      var res = await apiPost('/api/liff/food/log', payload);
      if (res && res.success) {
        showToast('記録しました');
        // reset form
        var rt = document.getElementById('m-raw-text'); if (rt) rt.value = '';
        ['m-calories','m-protein','m-fat','m-carbs'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
        await Promise.all([loadTodayStats(), loadHistory(true)]);
      } else {
        showToast((res && res.error) || '記録に失敗しました');
      }
    }
  } catch (e) {
    showToast('記録に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '記録する';
  }
}

// ─── Capture info modal ───
function openCaptureInfo() { document.getElementById('capture-modal').style.display = 'block'; }
function closeCaptureInfo() { document.getElementById('capture-modal').style.display = 'none'; }

// ─── Date formatting (JST) ───
function formatJstDate(d) {
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
}
function formatJstDateTime(s) {
  if (!s) return '';
  var d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// ─── Demo mode ───
function renderDemo() {
  // banner
  var banner = document.createElement('div');
  banner.className = 'bg-amber-50 border border-amber-200 rounded-2xl p-2.5 text-center text-xs text-amber-700 mt-2 font-medium';
  banner.textContent = '\u{1F6A7} DEMO MODE — LINEアプリ内で開くと実データが表示されます';
  var main = document.querySelector('main');
  if (main) main.insertBefore(banner, main.firstChild);

  renderTodayStats({
    total_calories: 1240,
    total_protein_g: 58.4,
    total_fat_g: 38.2,
    total_carbs_g: 142.0,
    meal_count: 2,
  });

  var demoLogs = [
    { id: 'demo1', ate_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), meal_type: 'lunch',
      raw_text: 'サラダチキン、玄米おにぎり', ai_analysis: JSON.stringify({ calories: 540, protein_g: 32, fat_g: 8, carbs_g: 78, items: [{ name: 'サラダチキン' }, { name: '玄米おにぎり' }], model_version: 'manual' }),
      total_calories: 540, total_protein_g: 32, total_fat_g: 8, total_carbs_g: 78, analysis_status: 'completed', error_message: null, created_at: '' },
    { id: 'demo2', ate_at: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(), meal_type: 'breakfast',
      raw_text: '', ai_analysis: JSON.stringify({ calories: 700, protein_g: 26.4, fat_g: 30.2, carbs_g: 64, items: [{ name: 'クロワッサン' }, { name: 'スクランブルエッグ' }, { name: 'カフェラテ' }], model_version: 'claude-vision' }),
      total_calories: 700, total_protein_g: 26.4, total_fat_g: 30.2, total_carbs_g: 64, analysis_status: 'completed', error_message: null, created_at: '' },
    { id: 'demo3', ate_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), meal_type: 'snack',
      raw_text: 'プロテインバー', ai_analysis: null,
      total_calories: null, total_protein_g: null, total_fat_g: null, total_carbs_g: null, analysis_status: 'pending', error_message: null, created_at: '' },
  ];
  var listEl = document.getElementById('history-list');
  listEl.innerHTML = '';
  demoLogs.forEach(function(l) { listEl.appendChild(renderLogCard(l)); });
  document.getElementById('load-more-btn').style.display = 'none';
}

// ─── Boot ───
initLiff();
</script>
</body>
</html>`;
}

export { liffFoodPage };
