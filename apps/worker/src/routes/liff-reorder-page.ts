import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * LIFF 再購入リマインダー管理ページ (Phase 6 PR-4)
 *
 * 役割: ユーザー自身が `subscription_reminders` を確認・編集する SPA。
 *   - 一覧: 商品名 / 次回リマインド日 / 間隔 (日) / 状態 (有効/停止)
 *   - アクション: 停止/再開、間隔変更 (preset から選択)、削除
 *
 * 認証: liffAuthMiddleware (Authorization: Bearer <idToken>) で保護された
 *       /api/liff/subscriptions* を呼ぶ。
 *
 * 配置: /liff/reorder (末尾スラッシュ両対応)
 */
const liffReorderPage = new Hono<Env>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const reorderPageHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(reorderPage(liffId, workerUrl));
};
liffReorderPage.get('/liff/reorder', reorderPageHandler as never);
liffReorderPage.get('/liff/reorder/', reorderPageHandler as never);

function reorderPage(liffId: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>再購入リマインダー — naturism</title>
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
    .btn-pill{border:1.5px solid #d1fae5;background:#fff;color:#059669;font-size:12px;font-weight:600;padding:6px 14px;border-radius:9999px}
    .btn-pill.is-active{background:#059669;color:#fff;border-color:#059669}
    .card{background:rgba(255,255,255,.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:16px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.02)}
    .skeleton{background:linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:8px}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    #toast{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(15,23,42,.85);font-weight:500;letter-spacing:.02em}
    #loading{background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%)}
    .badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
    .badge-on{background:#ecfdf5;color:#059669}
    .badge-off{background:#f3f4f6;color:#6b7280}
    .source-tag{font-size:10px;color:#9ca3af}
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid #d1fae5;border-top-color:#059669;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body class="min-h-screen pb-20">

  <header class="sticky top-0 z-50" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" class="text-xs text-gray-500 flex items-center gap-1">&larr; マイページ</a>
      <h1 class="text-base font-bold tracking-tight" style="background:linear-gradient(135deg,#059669,#06C755);-webkit-background-clip:text;-webkit-text-fill-color:transparent">&#x1F4E6; 再購入リマインダー</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4" id="main">

    <section id="intro-card" class="card p-4">
      <p class="text-xs text-gray-400 mb-1">設定中のリマインダー</p>
      <p class="text-sm text-gray-700 leading-relaxed">商品ごとに次回お知らせのタイミングを管理できます。間隔の変更や一時停止も自由です。</p>
    </section>

    <section id="list-card" class="card p-4">
      <div id="list" class="space-y-3">
        <div class="skeleton h-20 rounded-xl"></div>
        <div class="skeleton h-20 rounded-xl"></div>
      </div>
    </section>

    <section id="empty-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-3">&#x1F50E;</p>
      <p class="text-sm font-bold text-gray-700 mb-1">まだリマインダーがありません</p>
      <p class="text-xs text-gray-500 leading-relaxed">商品をご注文いただくと、自動でこちらに表示されます。</p>
    </section>

  </main>

  <!-- Edit modal -->
  <div id="modal" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style="display:none;background:rgba(15,23,42,.5)">
    <div class="card p-5 w-full sm:max-w-md mx-2 mb-2 sm:mb-0" style="border-radius:20px 20px 0 0">
      <p class="text-sm font-bold text-gray-800 mb-1" id="modal-title">間隔の変更</p>
      <p class="text-xs text-gray-500 mb-4" id="modal-product"></p>
      <div class="grid grid-cols-3 gap-2 mb-4" id="preset-grid"></div>
      <div class="flex gap-2">
        <button onclick="closeModal()" class="btn-secondary flex-1 py-3 rounded-2xl text-sm font-bold">キャンセル</button>
        <button id="modal-save" class="btn-primary flex-1 py-3 rounded-2xl text-sm font-bold">保存する</button>
      </div>
    </div>
  </div>

  <!-- Loading overlay -->
  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center" style="background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%)">
    <div class="spinner" style="width:32px;height:32px;border-width:3px;"></div>
    <p class="text-sm text-gray-400 mt-4">読み込み中...</p>
  </div>

  <!-- Toast -->
  <div id="toast" class="fixed bottom-24 left-1/2 -translate-x-1/2 text-white px-5 py-2.5 rounded-2xl text-sm shadow-xl opacity-0 transition-opacity pointer-events-none z-50"></div>

<script>
const LIFF_ID = '${escapeHtml(liffId)}';
const API_BASE = '${escapeHtml(apiBase)}';
const PRESET_DAYS = [7, 14, 30, 45, 60, 90];
let idToken = null;
let subs = [];
let editingId = null;
let editingDays = null;

function esc(s) { if (s === null || s === undefined) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(function(){ t.style.opacity = '0'; }, 2200);
}

function authHeaders(extra) {
  var h = extra || {};
  if (idToken) { h['Authorization'] = 'Bearer ' + idToken; }
  return h;
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path, { headers: authHeaders({}) });
  return { status: res.status, body: await res.json().catch(function(){ return null; }) };
}
async function apiPut(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(function(){ return null; }) };
}
async function apiDelete(path) {
  const res = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: authHeaders({}),
  });
  return { status: res.status, body: await res.json().catch(function(){ return null; }) };
}

function formatNextDate(iso) {
  if (!iso) return '-';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '/' + m + '/' + day;
  } catch (e) { return '-'; }
}

function sourceLabel(src) {
  if (src === 'user_history') return '購入履歴に基づく';
  if (src === 'product_default') return '商品ごとのおすすめ';
  if (src === 'auto_estimated') return '商品名から推定';
  if (src === 'manual') return '手動設定';
  if (src === 'fallback') return '標準設定';
  return '';
}

function render() {
  var listEl = document.getElementById('list');
  listEl.innerHTML = '';
  if (!subs || subs.length === 0) {
    document.getElementById('list-card').style.display = 'none';
    document.getElementById('empty-card').style.display = 'block';
    return;
  }
  document.getElementById('list-card').style.display = 'block';
  document.getElementById('empty-card').style.display = 'none';

  subs.forEach(function(s) {
    var row = document.createElement('div');
    var isOn = s.is_active === 1 || s.is_active === true;
    row.className = 'border border-gray-100 rounded-xl p-3';
    var src = sourceLabel(s.interval_source);
    row.innerHTML =
      '<div class="flex items-start justify-between gap-2 mb-2">' +
        '<p class="text-sm font-bold text-gray-800 leading-snug flex-1">' + esc(s.product_title) + '</p>' +
        '<span class="badge ' + (isOn ? 'badge-on' : 'badge-off') + '">' + (isOn ? '配信中' : '停止中') + '</span>' +
      '</div>' +
      '<p class="text-xs text-gray-500">次回: ' + esc(formatNextDate(s.next_reminder_at)) + ' / ' + esc(s.interval_days) + '日サイクル</p>' +
      (src ? '<p class="source-tag mt-1">' + esc(src) + '</p>' : '') +
      '<div class="flex flex-wrap gap-2 mt-3">' +
        '<button class="btn-pill" data-action="interval">間隔変更</button>' +
        '<button class="btn-pill" data-action="toggle">' + (isOn ? '停止する' : '再開する') + '</button>' +
        '<button class="btn-pill" data-action="delete" style="border-color:#fecaca;color:#dc2626">削除</button>' +
      '</div>';

    var btns = row.querySelectorAll('button[data-action]');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var action = btn.getAttribute('data-action');
        if (action === 'interval') openInterval(s);
        else if (action === 'toggle') onToggle(s);
        else if (action === 'delete') onDelete(s);
      });
    });
    listEl.appendChild(row);
  });
}

function openInterval(s) {
  editingId = s.id;
  editingDays = s.interval_days;
  document.getElementById('modal-product').textContent = s.product_title;
  var grid = document.getElementById('preset-grid');
  grid.innerHTML = '';
  PRESET_DAYS.forEach(function(d) {
    var b = document.createElement('button');
    b.className = 'btn-pill' + (d === editingDays ? ' is-active' : '');
    b.textContent = d + '日';
    b.addEventListener('click', function() {
      editingDays = d;
      // re-render selected state
      var all = grid.querySelectorAll('button');
      all.forEach(function(x){ x.classList.remove('is-active'); });
      b.classList.add('is-active');
    });
    grid.appendChild(b);
  });
  document.getElementById('modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
  editingId = null;
  editingDays = null;
}

document.getElementById('modal-save').addEventListener('click', async function() {
  if (!editingId || !editingDays) { closeModal(); return; }
  var btn = document.getElementById('modal-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    var r = await apiPut('/api/liff/subscriptions/' + encodeURIComponent(editingId), { intervalDays: editingDays });
    if (r.status === 200 && r.body && r.body.success) {
      showToast('間隔を更新しました');
      closeModal();
      await loadList();
    } else {
      showToast((r.body && r.body.error) || '更新に失敗しました');
    }
  } catch (e) {
    showToast('更新に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存する';
  }
});

async function onToggle(s) {
  var nextActive = !(s.is_active === 1 || s.is_active === true);
  try {
    var r = await apiPut('/api/liff/subscriptions/' + encodeURIComponent(s.id), { isActive: nextActive });
    if (r.status === 200 && r.body && r.body.success) {
      showToast(nextActive ? '再開しました' : '停止しました');
      await loadList();
    } else {
      showToast((r.body && r.body.error) || '更新に失敗しました');
    }
  } catch (e) {
    showToast('更新に失敗しました');
  }
}

async function onDelete(s) {
  if (!confirm(s.product_title + ' のリマインダーを削除しますか?')) return;
  try {
    var r = await apiDelete('/api/liff/subscriptions/' + encodeURIComponent(s.id));
    if (r.status === 200 && r.body && r.body.success) {
      showToast('削除しました');
      await loadList();
    } else {
      showToast((r.body && r.body.error) || '削除に失敗しました');
    }
  } catch (e) {
    showToast('削除に失敗しました');
  }
}

async function loadList() {
  var r = await apiGet('/api/liff/subscriptions');
  if (r.status !== 200 || !r.body || !r.body.success) {
    subs = [];
    render();
    return;
  }
  subs = (r.body.data && r.body.data.subscriptions) || [];
  render();
}

async function initLiff() {
  try {
    if (!LIFF_ID) throw new Error('LIFF_ID not configured');
    await liff.init({ liffId: LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }
    idToken = liff.getIDToken();
    await loadList();
    document.getElementById('loading').style.display = 'none';
  } catch (err) {
    console.error('LIFF init error:', err);
    subs = [];
    render();
    document.getElementById('loading').style.display = 'none';
  }
}

initLiff();
</script>
</body>
</html>`;
}

export { liffReorderPage };
