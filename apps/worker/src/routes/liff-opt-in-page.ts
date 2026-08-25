import { Hono } from 'hono';
import type { Env } from '../index.js';
import { liffWatchdogScriptTag } from '../utils/liff-watchdog.js';
import { liffBackLinkScriptTag } from '../utils/liff-back-link.js';

/**
 * LIFF Email Opt-In Page (Phase 5β-1b)
 *
 * 役割: LINE 友だちが email + marketing 同意を登録する SPA。
 *   - LIFF SDK で idToken 取得
 *   - email 入力 + 「メールマガジンを受け取る」 checkbox
 *   - POST /api/liff/opt-in
 *   - 登録完了画面を表示 (5β-1e: クーポン提供なし、 商業判断 — LINE 友だち追加経路の
 *     クーポンは別 system = Welcome シナリオ等で実装)
 *
 * 認証: liffAuthMiddleware で /api/liff/opt-in を保護。 このページ自体は public HTML (LIFF 内でしか useful にならない)。
 *
 * 配置: /liff/opt-in (末尾スラッシュ両対応)
 *
 * 関連: routes/liff-opt-in.ts, services/email-opt-in.ts
 */
const liffOptInPage = new Hono<Env>();

function escapeHtml(str: string): string {
  // 注: 単一引用符を含めて HTML attribute / JS string-context 両方で安全な escape
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * inline <script> 内に literal を埋め込む際の安全な JSON 化。
 * JSON.stringify 単体だと `</script>` substring が <script> tag を閉じてしまう XSS が成立する。
 * `<` `>` `&` を Unicode escape に置換 + U+2028 / U+2029 (JS line terminator) も escape。
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

liffOptInPage.get('/liff/opt-in', (c) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(optInPage(liffId, workerUrl));
});
liffOptInPage.get('/liff/opt-in/', (c) => {
  const liffUrl = c.env.LIFF_URL || '';
  const workerUrl = c.env.WORKER_URL || '';
  const liffId = liffUrl.replace('https://liff.line.me/', '');
  return c.html(optInPage(liffId, workerUrl));
});

function optInPage(liffId: string, apiBase: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#2fa8ad">
  <meta name="robots" content="noindex,nofollow">
  <title>メール配信登録 — naturism</title>
  ${liffWatchdogScriptTag()}
  ${liffBackLinkScriptTag()}
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{-webkit-tap-highlight-color:transparent}
    body{font-family:'Noto Sans JP',system-ui,sans-serif;background:linear-gradient(160deg,#f2fafa 0%,#f8fafc 40%,#faf5ff 100%);min-height:100vh}
    /* 60代可読性 (§7-1): 白文字を載せてよいのは白との比 4.5:1 以上の背景のみ。旧 LINE 黄緑は 2.2:1 で不成立。ページ全体もティールへ移行済 (LINE黄緑封印方針)。 */
    .btn-primary{background:#0f766e;color:#fff;border:none;transition:transform .15s,box-shadow .15s}
    .btn-primary:active{transform:scale(0.97);box-shadow:0 2px 8px rgba(15,118,110,.3)}
    .btn-primary:disabled{background:#cbd5e1;cursor:not-allowed}
    .btn-secondary{background:#fff;color:#0f766e;border:1.5px solid #cfe6e6;transition:background .15s}
    .btn-secondary:active{background:#eef7f7}
    .card{background:rgba(255,255,255,.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-radius:16px;border:1px solid rgba(0,0,0,.04);box-shadow:0 1px 4px rgba(0,0,0,.04),0 4px 16px rgba(0,0,0,.02)}
    #toast{backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);background:rgba(15,23,42,.85);font-weight:500;letter-spacing:.02em}
    #loading{background:linear-gradient(160deg,#f2fafa 0%,#f8fafc 40%,#faf5ff 100%)}
    .spinner{display:inline-block;width:14px;height:14px;border:2px solid #cfe6e6;border-top-color:#0f766e;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .input-field{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;background:#fff;transition:border-color .15s}
    .input-field:focus{outline:none;border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.12)}
    .input-error{border-color:#dc2626 !important}
    .consent-row{display:flex;align-items:flex-start;gap:10px;padding:12px;background:#f2fafa;border:1.5px solid #cfe6e6;border-radius:10px;cursor:pointer;line-height:1.6;font-size:13px;color:#374151}
    .consent-row input{margin-top:3px;cursor:pointer;width:18px;height:18px;accent-color:#0f766e}
    .benefits-box{background:#f2fafa;border:1px solid #cfe6e6;border-radius:12px;padding:14px}
    .benefits-box ul{list-style:disc;padding-left:20px;margin:0;line-height:1.8;color:#0f5f5c;font-size:12.5px}
  </style>
</head>
<body class="min-h-screen pb-20">

  <header class="sticky top-0 z-50" style="background:rgba(255,255,255,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,0,0,.06)">
    <div class="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
      <a href="/liff/portal" data-liff-back class="text-xs text-gray-500 flex items-center gap-1">&larr; マイページ</a>
      <h1 class="text-base font-bold tracking-tight" style="color:#0f766e">📧 メール配信登録</h1>
      <span class="w-16"></span>
    </div>
  </header>

  <main class="max-w-lg mx-auto px-4 py-4 space-y-4" id="main">

    <!-- Form view -->
    <section id="form-view">
      <div class="card p-5">
        <p class="text-sm text-gray-700 leading-relaxed mb-1"><strong>新商品・健康コラム・季節のキャンペーン</strong> をメールでお届けします。</p>
        <p class="text-xs text-gray-500 leading-relaxed">LINE トーク とは別チャネルで、 落ち着いて読める内容を中心にお送りします。</p>
      </div>

      <div class="card p-5 mt-4">
        <div class="benefits-box mb-4">
          <p class="text-xs text-teal-800 font-semibold mb-1.5">📬 配信内容</p>
          <ul>
            <li>新商品の先行ご案内</li>
            <li>季節の健康コラム / 摂取アドバイス</li>
            <li>定期便ご愛用者様向け限定情報</li>
          </ul>
        </div>

        <form id="opt-in-form" class="space-y-4">
          <div>
            <label for="email" class="block text-sm font-semibold text-gray-700 mb-2">メールアドレス</label>
            <input type="email" id="email" name="email" class="input-field" placeholder="your-email@example.com" autocomplete="email" required>
            <p id="email-error" class="text-xs text-red-600 mt-1 hidden">有効なメールアドレスを入力してください</p>
          </div>

          <label class="consent-row">
            <input type="checkbox" id="consent" name="consent" required>
            <span><strong>マーケティングメールの受信に同意します</strong><br><span class="text-xs text-gray-500">いつでも解除できます。 ご注文確認などの取引メールは別途お届けします。</span></span>
          </label>

          <button type="submit" id="submit-btn" class="btn-primary w-full py-3 rounded-xl text-sm font-bold">登録する</button>
        </form>

        <p class="text-xs text-gray-400 mt-4 text-center"><a href="https://naturism-diet.com/pages/privacy" target="_blank" class="underline">プライバシーポリシー</a></p>
      </div>
    </section>

    <!-- Success view -->
    <section id="success-view" style="display:none;">
      <div class="card p-6 text-center">
        <p class="text-3xl mb-2">✅</p>
        <p class="text-lg font-bold text-gray-800 mb-2">ご登録ありがとうございます</p>
        <p class="text-sm text-gray-600 leading-relaxed mb-4" id="success-message">メールマガジンの配信を開始いたします。 いつでも配信停止できます。</p>
        <p class="text-xs text-gray-500" id="success-email"></p>
      </div>

      <div class="card p-4 mt-4">
        <a href="/liff/portal" data-liff-back class="btn-secondary w-full py-3 rounded-xl text-sm font-bold inline-block text-center">マイページに戻る</a>
      </div>
    </section>

  </main>

  <!-- Loading overlay -->
  <div id="loading" class="fixed inset-0 z-50 flex flex-col items-center justify-center">
    <div class="spinner" style="width:32px;height:32px;border-width:3px;"></div>
    <p class="text-sm mt-4" style="color:#5b6670">読み込み中...</p>
  </div>

  <!-- Toast -->
  <div id="toast" role="status" aria-live="polite" class="fixed bottom-24 left-1/2 -translate-x-1/2 text-white px-5 py-2.5 rounded-2xl text-sm shadow-xl opacity-0 transition-opacity pointer-events-none z-50"></div>

<script>
// 注: jsonForScript で JS-string context + 終了タグ注入 攻撃を防ぐ
// (この行に終了タグを literal で書くと HTML parser がここで script を打ち切り、
//  以降の JS が一切実行されなくなる = 2026-05-17〜07-29 の本番障害の原因)
const LIFF_ID = ${jsonForScript(liffId)};
const API_BASE = ${jsonForScript(apiBase)};
let idToken = null;

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(function(){ t.style.opacity = '0'; }, 2500);
}

function isEmailValid(s) {
  if (!s || s.length > 254) return false;
  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s);
}

async function onSubmit(e) {
  e.preventDefault();
  const emailEl = document.getElementById('email');
  const consentEl = document.getElementById('consent');
  const errEl = document.getElementById('email-error');
  const submitBtn = document.getElementById('submit-btn');

  const email = (emailEl.value || '').trim();
  if (!isEmailValid(email)) {
    emailEl.classList.add('input-error');
    errEl.classList.remove('hidden');
    return;
  }
  emailEl.classList.remove('input-error');
  errEl.classList.add('hidden');

  if (!consentEl.checked) {
    showToast('同意 checkbox をご確認ください');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '登録中…';
  try {
    const res = await fetch(API_BASE + '/api/liff/opt-in', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ email: email, marketingConsent: true }),
    });
    const body = await res.json().catch(function(){ return null; });
    if (res.status === 401) {
      // idToken 失効: エラートーストで済ませず全画面の再読み込み誘導に倒す
      showFatalError('ログインの有効期限が切れました。お手数ですが、開き直してください🌿');
      return;
    }
    if (res.status === 200 && body && body.success) {
      // success
      document.getElementById('form-view').style.display = 'none';
      document.getElementById('success-view').style.display = 'block';
      document.getElementById('success-email').textContent = body.data.email;
      if (body.data.outcome === 'reactivated') {
        document.getElementById('success-message').textContent = 'メールマガジン配信を再開いたします。 ありがとうございます。';
      } else if (body.data.outcome === 're_consent') {
        document.getElementById('success-message').textContent = '同意情報を更新いたしました。 ありがとうございます。';
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      showToast((body && body.error) || '登録に失敗しました');
      submitBtn.disabled = false;
      submitBtn.textContent = '登録する';
    }
  } catch (err) {
    console.error('opt-in failed:', err);
    showToast('通信エラーが発生しました');
    submitBtn.disabled = false;
    submitBtn.textContent = '登録する';
  }
}

// 致命的な初期化失敗で空フォームを出さず (送信しても 401)、明示エラー+再読み込みを出す。
function showFatalError(msg) {
  var el = document.getElementById('loading');
  if (!el) return;
  window.__fatalShown = true;
  el.style.display = 'flex';
  el.innerHTML = '<div class="text-center px-8">' +
    '<p class="text-3xl mb-3">🌿</p>' +
    '<p class="text-sm text-gray-600 font-medium leading-relaxed mb-5">' + msg + '</p>' +
    '<button onclick="location.reload()" class="btn-primary px-6 py-2.5 rounded-xl text-sm font-bold">再読み込み</button>' +
    '</div>';
  var wd = document.getElementById('liff-watchdog-overlay');
  if (wd && wd.parentNode) { wd.parentNode.removeChild(wd); }
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
    if (!idToken) {
      showFatalError('ログインの有効期限が切れました。お手数ですが、トーク画面から開き直してください🌿');
      return;
    }
    // pre-fill email from LINE profile if available (LINE が email scope を返す場合のみ)
    try {
      const decoded = await liff.getDecodedIDToken();
      if (decoded && decoded.email) {
        document.getElementById('email').value = decoded.email;
      }
    } catch (e) { /* email scope 未許可、 user 入力 fallback */ }

    document.getElementById('opt-in-form').addEventListener('submit', onSubmit);
    document.getElementById('loading').style.display = 'none';
  } catch (err) {
    console.error('LIFF init error:', err);
    showFatalError('読み込みに失敗しました。通信環境をご確認のうえ、もう一度開き直してください🌿');
  }
}

initLiff();

// 「読み込み中...」永久固着の watchdog: liff.init や API が resolve も reject もしないまま
// 固まるケース (SDK/回線不調) で、12 秒後に明示エラー + 再読み込みへ倒す (2026-07-04 実機で固着を確認)。
setTimeout(function () {
  var el = document.getElementById('loading');
  if (el && el.style.display !== 'none' && !window.__fatalShown) {
    showFatalError('読み込みに時間がかかっています。通信環境をご確認のうえ、もう一度開いてください🌿');
  }
}, 12000);
</script>
</body>
</html>`;
}

export { liffOptInPage };
