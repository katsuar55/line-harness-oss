/**
 * LIFF Delivery Status Page — 配送状況確認
 *
 * Flow:
 * 1. LIFF認証 → 配送情報を取得
 * 2. 配送ステータスをタイムライン表示
 * 3. 追跡番号リンクで配送業者サイトへ
 */

declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  getIDToken(): string | null;
  isInClient(): boolean;
  closeWindow(): void;
};

// ─── Types ───

interface Fulfillment {
  id: string;
  orderNumber: number;
  trackingNumber: string | null;
  trackingUrl: string | null;
  trackingCompany: string | null;
  status: string;
  lineItems: Array<{ title?: string; name?: string; quantity?: number }>;
  createdAt: string;
}

interface DeliveryState {
  profile: { userId: string; displayName: string; pictureUrl?: string } | null;
  fulfillments: Fulfillment[];
  loading: boolean;
  error: string | null;
}

const state: DeliveryState = {
  profile: null,
  fulfillments: [],
  loading: false,
  error: null,
};

// ─── Utilities ───

function getApp(): HTMLElement {
  return document.getElementById('app')!;
}

function apiCall(path: string, options?: RequestInit): Promise<Response> {
  const idToken = liff.getIDToken();
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      ...options?.headers,
    },
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Status helpers ───

interface StatusInfo {
  label: string;
  color: string;
  bgColor: string;
  icon: string;
  step: number;
}

function getStatusInfo(status: string): StatusInfo {
  switch (status) {
    case 'delivered':
      return { label: '配達完了', color: '#059669', bgColor: '#d1fae5', icon: '✓', step: 3 };
    case 'in_transit':
      return { label: '配送中', color: '#d97706', bgColor: '#fef3c7', icon: '🚚', step: 2 };
    case 'out_for_delivery':
      return { label: '配達中', color: '#2563eb', bgColor: '#dbeafe', icon: '📦', step: 2 };
    default:
      return { label: '準備中', color: '#6b7280', bgColor: '#f3f4f6', icon: '⏳', step: 1 };
  }
}

// ─── Styles ───

function injectStyles(): void {
  if (document.getElementById('delivery-styles')) return;
  const style = document.createElement('style');
  style.id = 'delivery-styles';
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif;
      background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #f0f9ff 100%);
      min-height: 100vh;
      color: #1a1a2e;
    }
    .delivery-container {
      max-width: 480px;
      margin: 0 auto;
      padding: 16px;
      padding-bottom: 40px;
    }
    .delivery-header {
      text-align: center;
      padding: 20px 0 16px;
    }
    .delivery-header h1 {
      font-size: 22px;
      font-weight: 800;
      background: linear-gradient(135deg, #06C755, #00b894);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .delivery-header p {
      font-size: 13px;
      color: #666;
      margin-top: 4px;
    }

    .glass-card {
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.6);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06);
      padding: 20px;
      margin-bottom: 16px;
      animation: slideUp 0.4s ease-out;
    }

    /* Fulfillment card */
    .fulfillment-card {
      background: rgba(255, 255, 255, 0.9);
      border-radius: 14px;
      padding: 16px;
      margin-bottom: 14px;
      border: 1px solid rgba(0, 0, 0, 0.04);
      animation: fadeIn 0.3s ease-out;
    }
    .fulfillment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .fulfillment-order {
      font-size: 15px;
      font-weight: 700;
      color: #333;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 20px;
    }

    /* Progress bar */
    .progress-track {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 16px 0;
      position: relative;
    }
    .progress-track::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 24px;
      right: 24px;
      height: 3px;
      background: #e5e7eb;
      transform: translateY(-50%);
      z-index: 0;
    }
    .progress-track .progress-fill {
      position: absolute;
      top: 50%;
      left: 24px;
      height: 3px;
      background: linear-gradient(90deg, #06C755, #00b894);
      transform: translateY(-50%);
      z-index: 1;
      transition: width 0.5s ease;
      border-radius: 2px;
    }
    .progress-step {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      z-index: 2;
      transition: all 0.3s;
    }
    .progress-step.active {
      background: linear-gradient(135deg, #06C755, #00b894);
      color: white;
      box-shadow: 0 2px 8px rgba(6, 199, 85, 0.3);
    }
    .progress-step.inactive {
      background: #e5e7eb;
      color: #9ca3af;
    }
    .progress-labels {
      display: flex;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .progress-label {
      font-size: 10px;
      color: #9ca3af;
      text-align: center;
      flex: 1;
    }
    .progress-label.active {
      color: #06C755;
      font-weight: 600;
    }

    /* Tracking info */
    .tracking-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(6, 199, 85, 0.04);
      border-radius: 10px;
      margin-top: 10px;
    }
    .tracking-icon {
      font-size: 16px;
    }
    .tracking-info {
      flex: 1;
      min-width: 0;
    }
    .tracking-company {
      font-size: 11px;
      color: #999;
    }
    .tracking-number {
      font-size: 13px;
      font-weight: 600;
      color: #333;
    }
    .tracking-link {
      color: #06C755;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      white-space: nowrap;
    }

    /* Items preview */
    .items-list {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(0, 0, 0, 0.05);
    }
    .item-row {
      font-size: 12px;
      color: #666;
      padding: 3px 0;
      display: flex;
      justify-content: space-between;
    }
    .fulfillment-date {
      font-size: 11px;
      color: #999;
      margin-top: 8px;
    }

    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: #999;
    }
    .empty-state-icon {
      font-size: 56px;
      margin-bottom: 16px;
    }
    .empty-state p {
      font-size: 14px;
      line-height: 1.6;
    }
    .error-banner {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 12px;
      padding: 12px 16px;
      color: #dc2626;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #e5e7eb;
      border-top-color: #06C755;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 60px auto;
    }
    .btn-back {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      color: #06C755;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      padding: 8px 0;
      margin-bottom: 8px;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Render ───

function renderFulfillmentCard(f: Fulfillment, index: number): string {
  const info = getStatusInfo(f.status);
  const steps = [
    { label: '注文確認', num: 1 },
    { label: '配送中', num: 2 },
    { label: '配達完了', num: 3 },
  ];
  const fillWidth = info.step === 1 ? '0%' : info.step === 2 ? '50%' : '100%';

  const itemsHtml = f.lineItems.length > 0
    ? `<div class="items-list">
        ${f.lineItems.map((li) =>
          `<div class="item-row">
            <span>${escapeHtml(li.name || li.title || '商品')}</span>
            <span>× ${li.quantity || 1}</span>
          </div>`
        ).join('')}
      </div>`
    : '';

  const trackingHtml = f.trackingNumber
    ? `<div class="tracking-row">
        <span class="tracking-icon">📋</span>
        <div class="tracking-info">
          ${f.trackingCompany ? `<div class="tracking-company">${escapeHtml(f.trackingCompany)}</div>` : ''}
          <div class="tracking-number">${escapeHtml(f.trackingNumber)}</div>
        </div>
        ${f.trackingUrl
          ? `<a href="${escapeHtml(f.trackingUrl)}" target="_blank" class="tracking-link">追跡する →</a>`
          : ''}
      </div>`
    : '';

  return `
    <div class="fulfillment-card" style="animation-delay: ${index * 0.08}s">
      <div class="fulfillment-header">
        <span class="fulfillment-order">注文 #${escapeHtml(String(f.orderNumber))}</span>
        <span class="status-badge" style="color:${info.color};background:${info.bgColor}">
          ${info.icon} ${info.label}
        </span>
      </div>

      <div class="progress-track">
        <div class="progress-fill" style="width:${fillWidth}"></div>
        ${steps.map((s) => `
          <div class="progress-step ${s.num <= info.step ? 'active' : 'inactive'}">
            ${s.num <= info.step ? (s.num === info.step ? info.icon : '✓') : s.num}
          </div>
        `).join('')}
      </div>
      <div class="progress-labels">
        ${steps.map((s) => `
          <div class="progress-label ${s.num <= info.step ? 'active' : ''}">${s.label}</div>
        `).join('')}
      </div>

      ${trackingHtml}
      ${itemsHtml}
      <div class="fulfillment-date">${formatDate(f.createdAt)}</div>
    </div>
  `;
}

function render(): void {
  const app = getApp();

  if (state.loading) {
    app.innerHTML = `
      <div class="delivery-container">
        <div class="delivery-header">
          <h1>配送状況</h1>
          <p>読み込み中...</p>
        </div>
        <div class="loading-spinner"></div>
      </div>
    `;
    return;
  }

  const content = state.fulfillments.length > 0
    ? state.fulfillments.map((f, i) => renderFulfillmentCard(f, i)).join('')
    : `<div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <p>配送情報はまだありません</p>
        <p style="font-size:12px;margin-top:8px">注文が発送されると、ここに表示されます</p>
      </div>`;

  app.innerHTML = `
    <div class="delivery-container">
      <div class="delivery-header">
        <h1>配送状況</h1>
        <p>${state.profile ? escapeHtml(state.profile.displayName) + ' さんの配送情報' : ''}</p>
      </div>

      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
      ${content}
    </div>
  `;
}

// ─── Data fetch ───

async function fetchDeliveryData(): Promise<void> {
  state.loading = true;
  render();

  try {
    const res = await apiCall('/api/liff/fulfillments', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to fetch');
    const json = await res.json() as { success: boolean; data?: { fulfillments: Fulfillment[] } };
    if (json.success && json.data) {
      state.fulfillments = json.data.fulfillments;
    }
  } catch {
    state.error = 'データの読み込みに失敗しました';
  }

  state.loading = false;
  render();
}

// ─── Entry ───

export async function initDelivery(): Promise<void> {
  injectStyles();

  try {
    state.profile = await liff.getProfile();
  } catch {
    // continue without profile
  }

  await fetchDeliveryData();
}
