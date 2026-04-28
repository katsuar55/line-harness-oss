/**
 * LINE Harness LIFF — The single entry point
 *
 * This URL IS the friend-add URL. Every user enters through here.
 *
 * Flow:
 *   LIFF URL → LINE Login (auto in LINE app) → UUID issued
 *   → friendship check → not friend? show add button → friend added → Webhook → scenario enroll
 *   → already friend? → show completion
 *
 * Query params:
 *   ?ref=xxx     — attribution tracking (which LP/campaign)
 *   ?redirect=x  — redirect after linking (for wrapped URLs)
 *   ?page=book   — booking page (calendar slot picker)
 */

import { initBooking } from './booking.js';
import { initForm } from './form.js';
import { initReorder } from './reorder.js';
import { initDelivery } from './delivery.js';

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string; statusMessage?: string }>;
  getIDToken(): string | null;
  getDecodedIDToken(): { sub: string; name?: string; email?: string; picture?: string } | null;
  getFriendship(): Promise<{ friendFlag: boolean }>;
  isInClient(): boolean;
  closeWindow(): void;
};

// Resolve LIFF ID: check query param first, then fallback to env var
function detectLiffId(): string {
  const params = new URLSearchParams(window.location.search);
  const fromParam = params.get('liffId');
  if (fromParam) return fromParam;
  return import.meta.env?.VITE_LIFF_ID || '';
}
const LIFF_ID = detectLiffId();
// NOTE: main.ts の最上位で throw すると ESM module init エラーで `<div id="app">` の
//       「読み込み中...」スピナーが永久に止まる (visible エラーが出ない) ため、
//       ここではスローせず、後続の main() 内で showError() を呼ぶ。
//       `main.ts is not loaded` (本番事故 2026-04-28) の再発防止。
const UUID_STORAGE_KEY = 'lh_uuid';
// LINE公式アカウントの友だち追加URL（LINE Developers Console → Messaging API → Bot basic ID）
const BOT_BASIC_ID = import.meta.env?.VITE_BOT_BASIC_ID || '';

function apiCall(path: string, options?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

function getPage(): string | null {
  const path = window.location.pathname.replace(/^\/+/, '');
  if (path === 'book') return 'book';
  const params = new URLSearchParams(window.location.search);
  return params.get('page');
}

function getRedirectUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('redirect');
}

function getRef(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('ref');
}

function getSavedUuid(): string | null {
  try {
    return localStorage.getItem(UUID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveUuid(uuid: string): void {
  try {
    localStorage.setItem(UUID_STORAGE_KEY, uuid);
  } catch {
    // silent fail
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── UI States ──────────────────────────────────────────

function showFriendAdd(profile: { displayName: string; pictureUrl?: string }) {
  const container = document.getElementById('app')!;
  const friendAddUrl = BOT_BASIC_ID
    ? `https://line.me/R/ti/p/${BOT_BASIC_ID}`
    : '#';

  container.innerHTML = `
    <div class="card">
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">まずは友だち追加をお願いします</p>
      <a href="${friendAddUrl}" class="add-friend-btn" id="addFriendBtn">
        友だち追加して始める
      </a>
      <p class="sub-message">追加後、この画面に戻ってきてください</p>
    </div>
  `;

  // 友だち追加後に戻ってきたら自動で再チェック
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      try {
        const { friendFlag } = await liff.getFriendship();
        if (friendFlag) {
          showCompletion(profile, false);
        }
      } catch {
        // ignore
      }
    }
  });
}

function showCompletion(profile: { displayName: string; pictureUrl?: string }, isRecovery: boolean) {
  const container = document.getElementById('app')!;
  const ref = getRef();

  // LINE 内ブラウザかどうかで導線を出し分ける
  // - LINE 内 + BOT_BASIC_ID あり: 2 秒後にトーク画面に自動リダイレクト (UX 維持)
  // - それ以外: マイページ / 機能メニューへのナビゲーションボタンを表示
  const isInLineApp = (() => {
    try {
      return typeof liff !== 'undefined' && liff.isInClient && liff.isInClient();
    } catch {
      return false;
    }
  })();

  const closeMessage =
    isInLineApp && BOT_BASIC_ID
      ? '<br>このページは閉じて大丈夫です。'
      : '';

  // メニューボタン (LINE 外 or BOT_BASIC_ID 未設定の場合に表示)
  const menuButtons =
    !isInLineApp || !BOT_BASIC_ID
      ? `
    <div class="menu-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:20px;">
      <a href="/liff/portal" class="menu-btn">🏠<br>マイページ</a>
      <a href="/liff/coach" class="menu-btn">🌿<br>栄養コーチ</a>
      <a href="/liff/food" class="menu-btn">🍱<br>食事記録</a>
      <a href="/liff/reorder" class="menu-btn">📦<br>再購入</a>
    </div>
    <style>
      .menu-btn {
        display: block;
        padding: 16px 12px;
        background: #fff;
        border: 1.5px solid #06C755;
        border-radius: 12px;
        color: #06C755;
        font-weight: 600;
        font-size: 13px;
        text-decoration: none;
        text-align: center;
        line-height: 1.5;
        transition: all .15s;
      }
      .menu-btn:active {
        background: #e8faf0;
        transform: scale(0.98);
      }
    </style>
  `
      : '';

  container.innerHTML = `
    <div class="card">
      <div class="check-icon">${isRecovery ? '🔄' : '✓'}</div>
      <h2>${isRecovery ? 'おかえりなさい！' : '登録完了！'}</h2>
      <div class="profile">
        ${profile.pictureUrl ? `<img src="${profile.pictureUrl}" alt="" />` : ''}
        <p class="name">${escapeHtml(profile.displayName)} さん</p>
      </div>
      <p class="message">
        ${isRecovery
          ? '以前のアカウント情報を引き継ぎました。'
          : 'ありがとうございます！これからお役立ち情報をお届けします。'
        }${closeMessage}
      </p>
      ${menuButtons}
      ${ref ? `<p class="ref-badge">${escapeHtml(ref)}</p>` : ''}
    </div>
  `;

  // 2 秒後にトーク画面に遷移（LINE 内 + BOT_BASIC_ID 設定済みの場合のみ）
  if (isInLineApp && BOT_BASIC_ID) {
    setTimeout(() => {
      window.location.href = `https://line.me/R/oaMessage/${BOT_BASIC_ID}/`;
    }, 2000);
  }
}

function showError(message: string) {
  const container = document.getElementById('app')!;
  container.innerHTML = `
    <div class="card">
      <h2>エラー</h2>
      <p class="error">${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * 接続中の進捗を視覚化 (デフォルトの「読み込み中...」を上書き)。
 * liff.init / liff.login の各段階で呼ぶ。
 */
function showProgress(message: string) {
  const container = document.getElementById('app');
  if (!container) return;
  container.innerHTML = `
    <div class="card">
      <div class="loading-spinner"></div>
      <p class="message">${escapeHtml(message)}</p>
    </div>
  `;
}

/**
 * LIFF init/login が想定時間内に完了しなかった場合の救済 UI。
 * LINE 内ブラウザで worker URL を直接開いた時の hang 対策 (2026-04-28 事故)。
 * LIFF URL に切り替えて開き直すよう案内する。
 */
function showLiffFallback(liffId: string) {
  const container = document.getElementById('app');
  if (!container) return;
  const liffUrl = `https://liff.line.me/${liffId}`;
  container.innerHTML = `
    <div class="card">
      <h2>LINE で開き直してください</h2>
      <p class="message">
        この URL を直接ブラウザで開くと、LIFF が正しく初期化されない場合があります。<br>
        下のボタンから LINE 経由で再度開いてください。
      </p>
      <a href="${liffUrl}" class="add-friend-btn">
        LINE で開く
      </a>
      <p class="sub-message">${escapeHtml(liffUrl)}</p>
    </div>
  `;
}

// ─── Core Flow ──────────────────────────────────────────

async function linkAndAddFlow() {
  const redirectUrl = getRedirectUrl();
  const ref = getRef();

  try {
    const existingUuid = getSavedUuid();

    // Get profile, ID token, and friendship status in parallel
    const [profile, rawIdToken, friendship] = await Promise.all([
      liff.getProfile(),
      Promise.resolve(liff.getIDToken()),
      liff.getFriendship(),
    ]);

    // 1. UUID linking (always, regardless of friendship)
    const linkPromise = apiCall('/api/liff/link', {
      method: 'POST',
      body: JSON.stringify({
        idToken: rawIdToken,
        displayName: profile.displayName,
        existingUuid: existingUuid,
        ref: ref,
      }),
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json() as { success: boolean; data?: { userId?: string } };
        if (data?.data?.userId) {
          saveUuid(data.data.userId);
        }
      }
      return res;
    }).catch(() => {
      // Silent fail — UUID linking is best-effort
    });

    // 2. Attribution tracking
    if (ref) {
      apiCall('/api/affiliates/click', {
        method: 'POST',
        body: JSON.stringify({ code: ref, url: window.location.href }),
      }).catch(() => {});
    }

    // 3. Redirect flow (for wrapped URLs)
    if (redirectUrl) {
      await Promise.race([
        linkPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      // Append LINE userId to tracking links so clicks are attributed
      if (redirectUrl.includes('/t/')) {
        const sep = redirectUrl.includes('?') ? '&' : '?';
        window.location.href = `${redirectUrl}${sep}lu=${encodeURIComponent(profile.userId)}`;
      } else {
        window.location.href = redirectUrl;
      }
      return;
    }

    // 4. Wait for UUID linking to complete
    await linkPromise;

    // 5. Friendship check — the key decision point
    if (!friendship.friendFlag) {
      // Not a friend yet → show friend-add button
      showFriendAdd(profile);
    } else {
      // Already a friend → all done
      showCompletion(profile, !!existingUuid);
    }

  } catch (err) {
    if (redirectUrl) {
      window.location.href = redirectUrl;
    } else {
      showError(err instanceof Error ? err.message : 'エラーが発生しました');
    }
  }
}

// ─── Entry Point ────────────────────────────────────────

async function main() {
  // ── LIFF_ID guard (visible error instead of silent module init failure) ──
  if (!LIFF_ID) {
    showError(
      'LIFF ID が未設定です。\n\n' +
      '・本番ビルド時: VITE_LIFF_ID を渡してください (apps/worker/.env または CI Secret)\n' +
      '・テスト時: URL に ?liffId=<LIFF_ID> を付けて再読み込みしてください',
    );
    return;
  }

  // ── タイムアウトフォールバック ──
  // LINE 内ブラウザで worker URL を直接開いた時、liff.init / liff.login が
  // 静かに hang して「読み込み中...」が永久に消えない事象 (2026-04-28 発生) を救済する。
  // 8 秒で完了しない場合は LIFF URL への手動切り替えを案内。
  let completed = false;
  const fallbackTimer = window.setTimeout(() => {
    if (!completed) showLiffFallback(LIFF_ID);
  }, 8000);

  showProgress('LINE と接続しています...');

  try {
    await liff.init({ liffId: LIFF_ID });

    if (!liff.isLoggedIn()) {
      // login() は通常リダイレクトするが、In-App ブラウザで遅延する場合があるため
      // 視覚的に何が起きているかをユーザーに伝える。
      showProgress('LINE Login に移動中...');
      try {
        liff.login({ redirectUri: window.location.href });
      } catch (loginErr) {
        completed = true;
        window.clearTimeout(fallbackTimer);
        showError(loginErr instanceof Error ? loginErr.message : 'LINE Login 起動に失敗');
      }
      return;
    }

    const page = getPage();
    if (page === 'book') {
      await initBooking();
    } else if (page === 'form') {
      const params = new URLSearchParams(window.location.search);
      const formId = params.get('id');
      await initForm(formId);
    } else if (page === 'reorder') {
      await initReorder();
    } else if (page === 'delivery') {
      await initDelivery();
    } else {
      await linkAndAddFlow();
    }
    completed = true;
    window.clearTimeout(fallbackTimer);
  } catch (err) {
    completed = true;
    window.clearTimeout(fallbackTimer);
    showError(err instanceof Error ? err.message : 'LIFF初期化エラー');
  }
}

main();
