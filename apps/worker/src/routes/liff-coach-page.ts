import { Hono } from 'hono';
import type { Env } from '../index.js';

/**
 * LIFF 栄養コーチページ (Phase 4 PR-4)
 *
 * 役割: LIFF SDK で IDトークンを取得 → /api/liff/coach/* を呼び出し、
 * 「あなたの今週の栄養レコメンド」を表示する SPA。
 *
 * 認証: liffAuthMiddleware により Authorization: Bearer <idToken> ヘッダで保護。
 * バックエンド API は同 PR-4 で追加 (apps/worker/src/routes/liff-portal.ts)。
 *
 * 配置: /liff/coach (末尾スラッシュ両対応)
 *       戻るリンクは /liff/portal。
 */
const liffCoachPage = new Hono<Env>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const coachPageHandler = (c: { env: Env['Bindings']; html: (html: string) => Response }) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(coachPage(liffId, workerUrl));
};
liffCoachPage.get('/liff/coach', coachPageHandler as never);
liffCoachPage.get('/liff/coach/', coachPageHandler as never);

function coachPage(liffId: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>栄養コーチ — naturism</title>
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
    #toast{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(15,23,42,.85);font-weight:500;letter-spacing:.02em}
    #loading{background:linear-gradient(160deg,#f0fdf4 0%,#f8fafc 40%,#faf5ff 100%)}
    .badge{display:inline-flex;align-items:center;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px}
    .sev-mild{background:#ecfdf5;color:#059669}
    .sev-moderate{background:#fef3c7;color:#b45309}
    .sev-severe{background:#fee2e2;color:#b91c1c}
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid #d1fae5;border-top-color:#059669;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media(hover:hover){.btn-primary:hover{box-shadow:0 4px 16px rgba(5,150,105,.25)}}
  </style>
</head>
<body class="min-h-screen pb-20">

  <header class="sticky top-0 z-50" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" class="text-xs text-gray-500 flex items-center gap-1">&larr; マイページ</a>
      <h1 class="text-base font-bold tracking-tight" style="background:linear-gradient(135deg,#059669,#06C755);-webkit-background-clip:text;-webkit-text-fill-color:transparent">&#x1F33F; 栄養コーチ</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4" id="main">

    <!-- AI message card -->
    <section id="ai-card" class="card p-5">
      <div class="skeleton h-6 rounded-lg mb-2"></div>
      <div class="skeleton h-4 rounded-lg w-3/4"></div>
    </section>

    <!-- Deficit list -->
    <section id="deficit-card" class="card p-4" style="display:none;">
      <p class="text-sm font-bold text-gray-700 mb-3">気になる栄養傾向</p>
      <div id="deficit-list" class="space-y-2"></div>
    </section>

    <!-- SKU suggestions -->
    <section id="sku-card" class="card p-4" style="display:none;">
      <p class="text-sm font-bold text-gray-700 mb-3">あなたへの提案</p>
      <div id="sku-list" class="space-y-3"></div>
    </section>

    <!-- Footer actions -->
    <section id="footer-actions" class="card p-4 space-y-2" style="display:none;">
      <button id="regen-btn" onclick="onRegenerate()" class="btn-secondary w-full py-3 rounded-2xl text-sm font-bold">最新の状態を再生成する</button>
      <button id="dismiss-btn" onclick="onDismiss()" class="btn-danger w-full py-3 rounded-2xl text-sm font-bold">今は表示しない</button>
      <p class="text-[11px] text-gray-400 text-center pt-2">再生成は24時間に1回までご利用いただけます</p>
    </section>

    <!-- Empty state -->
    <section id="empty-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-3">&#x1F33E;</p>
      <p class="text-sm font-bold text-gray-700 mb-1">もう少し記録が集まったら</p>
      <p class="text-xs text-gray-500 leading-relaxed">食事の写真や手動記録が 5 日分以上たまると、あなた向けの栄養レコメンドが届きます。</p>
      <a href="/liff/food" class="btn-primary inline-block mt-4 px-6 py-3 rounded-2xl text-sm font-bold no-underline">食事を記録する</a>
    </section>

    <!-- Done state -->
    <section id="done-card" class="card p-6 text-center" style="display:none;">
      <p class="text-3xl mb-3">&#x1F495;</p>
      <p class="text-sm font-bold text-gray-700">ありがとうございました</p>
      <p class="text-xs text-gray-500 mt-2">また新しい提案が届いたらお知らせします。</p>
    </section>

  </main>

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
let idToken = null;
let currentRec = null;

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
async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(function(){ return null; }) };
}

// ─── Deficit label table ───
const DEFICIT_LABEL = {
  protein_low: 'タンパク質が不足気味',
  calorie_low: 'カロリーが控えめ',
  calorie_high: 'カロリーが高め',
  iron_low: '鉄分も気になります',
  fiber_low: '食物繊維が控えめ',
};

function deficitLabel(key) { return DEFICIT_LABEL[key] || key; }

function severityClass(sev) {
  if (sev === 'severe') return 'sev-severe';
  if (sev === 'moderate') return 'sev-moderate';
  return 'sev-mild';
}
function severityLabel(sev) {
  if (sev === 'severe') return '強度';
  if (sev === 'moderate') return '中度';
  return '軽度';
}

// ─── Render ───
function renderRecommendation(rec) {
  currentRec = rec;
  // AI message
  var aiCard = document.getElementById('ai-card');
  aiCard.innerHTML =
    '<p class="text-xs text-gray-400 mb-2">あなたの今週の栄養レポート</p>' +
    '<p class="text-base font-semibold text-gray-800 leading-relaxed">' + esc(rec.ai_message || '') + '</p>';

  // Deficits
  var deficits = Array.isArray(rec.deficits) ? rec.deficits : [];
  var dList = document.getElementById('deficit-list');
  dList.innerHTML = '';
  deficits.forEach(function(d) {
    var row = document.createElement('div');
    row.className = 'flex items-center justify-between border border-gray-100 rounded-xl px-3 py-2';
    row.innerHTML =
      '<span class="text-sm text-gray-700">' + esc(deficitLabel(d.key)) + '</span>' +
      '<span class="badge ' + severityClass(d.severity) + '">' + esc(severityLabel(d.severity)) + '</span>';
    dList.appendChild(row);
  });
  document.getElementById('deficit-card').style.display = deficits.length > 0 ? 'block' : 'none';

  // Suggestions
  var sugs = Array.isArray(rec.suggestions) ? rec.suggestions : [];
  var sList = document.getElementById('sku-list');
  sList.innerHTML = '';
  sugs.forEach(function(s, idx) {
    var row = document.createElement('div');
    row.className = 'border border-gray-100 rounded-xl p-3';
    row.innerHTML =
      '<p class="text-sm font-bold text-gray-800">' + esc(s.productTitle || '') + '</p>' +
      '<p class="text-xs text-gray-500 mt-1 leading-relaxed">' + esc(s.copy || '') + '</p>' +
      '<button class="btn-primary w-full py-2.5 rounded-xl text-xs font-bold mt-3" data-idx="' + idx + '">商品を見る</button>';
    var btn = row.querySelector('button');
    btn.addEventListener('click', function() { onSkuClick(idx); });
    sList.appendChild(row);
  });
  document.getElementById('sku-card').style.display = sugs.length > 0 ? 'block' : 'none';

  // Footer
  document.getElementById('footer-actions').style.display = 'block';
  document.getElementById('empty-card').style.display = 'none';
  document.getElementById('done-card').style.display = 'none';
}

function renderEmpty() {
  document.getElementById('ai-card').style.display = 'none';
  document.getElementById('deficit-card').style.display = 'none';
  document.getElementById('sku-card').style.display = 'none';
  document.getElementById('footer-actions').style.display = 'none';
  document.getElementById('done-card').style.display = 'none';
  document.getElementById('empty-card').style.display = 'block';
}

function renderDone() {
  document.getElementById('ai-card').style.display = 'none';
  document.getElementById('deficit-card').style.display = 'none';
  document.getElementById('sku-card').style.display = 'none';
  document.getElementById('footer-actions').style.display = 'none';
  document.getElementById('empty-card').style.display = 'none';
  document.getElementById('done-card').style.display = 'block';
}

// ─── Actions ───
async function onSkuClick(idx) {
  if (!currentRec) return;
  try {
    var r = await apiPost('/api/liff/coach/click', { id: currentRec.id, suggestionIndex: idx });
    if (r.status === 200 && r.body && r.body.success && r.body.data && r.body.data.shopifyProductId) {
      var url = String(r.body.data.shopifyProductId || '');
      // shopifyProductId が外部 URL ならそのまま、Shopify GID 形式なら / で続けて開く
      if (typeof liff !== 'undefined' && liff.openWindow) {
        liff.openWindow({ url: url, external: true });
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } else {
      showToast('商品ページを開けませんでした');
    }
  } catch (e) {
    showToast('商品ページを開けませんでした');
  }
}

async function onDismiss() {
  if (!currentRec) return;
  var btn = document.getElementById('dismiss-btn');
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    var r = await apiPost('/api/liff/coach/dismiss', { id: currentRec.id });
    if (r.status === 200 && r.body && r.body.success) {
      renderDone();
    } else {
      showToast((r.body && r.body.error) || '更新に失敗しました');
    }
  } catch (e) {
    showToast('更新に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '今は表示しない';
  }
}

async function onRegenerate() {
  var btn = document.getElementById('regen-btn');
  btn.disabled = true;
  btn.textContent = '再生成中…';
  try {
    var r = await apiPost('/api/liff/coach/regenerate', {});
    if (r.status === 429) {
      showToast('再生成は24時間に1回までです');
      return;
    }
    if (r.status !== 200 || !r.body || !r.body.success) {
      showToast((r.body && r.body.error) || '再生成に失敗しました');
      return;
    }
    var d = r.body.data;
    if (!d || d.skipped) {
      showToast('もう少し記録が集まったら再生成できます');
      return;
    }
    // 再生成後は最新を取り直して表示更新
    await loadLatest();
    showToast('最新のレコメンドに更新しました');
  } catch (e) {
    showToast('再生成に失敗しました');
  } finally {
    btn.disabled = false;
    btn.textContent = '最新の状態を再生成する';
  }
}

// ─── Boot ───
async function loadLatest() {
  var r = await apiGet('/api/liff/coach/latest');
  if (r.status !== 200 || !r.body || !r.body.success) {
    renderEmpty();
    return;
  }
  var data = r.body.data;
  if (!data) {
    renderEmpty();
    return;
  }
  renderRecommendation(data);
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
    await loadLatest();
    document.getElementById('loading').style.display = 'none';
  } catch (err) {
    console.error('LIFF init error:', err);
    renderEmpty();
    document.getElementById('loading').style.display = 'none';
  }
}

initLiff();
</script>
</body>
</html>`;
}

export { liffCoachPage };
