/**
 * LIFF Reorder Page — ワンクリック再購入
 *
 * Flow:
 * 1. LIFF認証 → 注文履歴 + 商品一覧を取得
 * 2. 過去の注文をタップ → 注文内容を確認
 * 3. 「同じ内容で再注文」→ Draft Order作成 → Shopifyチェックアウトへ遷移
 * 4. または商品一覧から個別に選択して再注文
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

interface LineItem {
  variant_id: string | number;
  title: string;
  quantity: number;
  price: string;
  name?: string;
}

interface Order {
  id: string;
  orderNumber: number;
  totalPrice: number;
  lineItems: LineItem[];
  createdAt: string;
  fulfillmentStatus: string | null;
}

interface Product {
  id: string;
  shopifyProductId: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  imageUrl: string | null;
  handle: string;
  storeUrl: string;
}

interface ReorderState {
  profile: { userId: string; displayName: string; pictureUrl?: string } | null;
  orders: Order[];
  products: Product[];
  selectedOrderId: string | null;
  cart: Map<string, { product: Product; quantity: number }>;
  view: 'list' | 'order-detail' | 'cart' | 'creating' | 'success';
  loading: boolean;
  submitting: boolean;
  invoiceUrl: string | null;
  totalPrice: number;
  error: string | null;
}

const state: ReorderState = {
  profile: null,
  orders: [],
  products: [],
  selectedOrderId: null,
  cart: new Map(),
  view: 'list',
  loading: false,
  submitting: false,
  invoiceUrl: null,
  totalPrice: 0,
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

function formatPrice(price: number | string): string {
  return `¥${Number(price).toLocaleString()}`;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Styles (injected once) ───

function injectStyles(): void {
  if (document.getElementById('reorder-styles')) return;
  const style = document.createElement('style');
  style.id = 'reorder-styles';
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif;
      background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 50%, #f0f9ff 100%);
      min-height: 100vh;
      color: #1a1a2e;
    }
    .reorder-container {
      max-width: 480px;
      margin: 0 auto;
      padding: 16px;
      padding-bottom: 100px;
    }
    .reorder-header {
      text-align: center;
      padding: 20px 0 16px;
    }
    .reorder-header h1 {
      font-size: 22px;
      font-weight: 800;
      background: linear-gradient(135deg, #06C755, #00b894);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }
    .reorder-header p {
      font-size: 13px;
      color: #666;
      margin-top: 4px;
    }

    /* Glass card */
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
    .glass-card-title {
      font-size: 14px;
      font-weight: 700;
      color: #06C755;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Order card */
    .order-card {
      background: rgba(255, 255, 255, 0.9);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 12px;
      border: 1px solid rgba(6, 199, 85, 0.1);
      cursor: pointer;
      transition: all 0.2s ease;
      animation: fadeIn 0.3s ease-out;
    }
    .order-card:active {
      transform: scale(0.98);
      background: rgba(6, 199, 85, 0.05);
    }
    .order-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .order-number {
      font-size: 15px;
      font-weight: 700;
      color: #333;
    }
    .order-price {
      font-size: 16px;
      font-weight: 800;
      color: #06C755;
    }
    .order-date {
      font-size: 12px;
      color: #999;
    }
    .order-items-preview {
      font-size: 12px;
      color: #666;
      margin-top: 6px;
      line-height: 1.5;
    }
    .order-badge {
      display: inline-block;
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .badge-fulfilled {
      background: #d1fae5;
      color: #065f46;
    }
    .badge-pending {
      background: #fef3c7;
      color: #92400e;
    }

    /* Product card */
    .product-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid rgba(0, 0, 0, 0.05);
      animation: fadeIn 0.3s ease-out;
    }
    .product-row:last-child { border-bottom: none; }
    .product-img {
      width: 56px;
      height: 56px;
      border-radius: 10px;
      object-fit: cover;
      background: #f3f4f6;
    }
    .product-img-placeholder {
      width: 56px;
      height: 56px;
      border-radius: 10px;
      background: linear-gradient(135deg, #e5e7eb, #f3f4f6);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }
    .product-info {
      flex: 1;
      min-width: 0;
    }
    .product-title {
      font-size: 13px;
      font-weight: 600;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .product-price {
      font-size: 14px;
      font-weight: 700;
      color: #06C755;
      margin-top: 2px;
    }
    .product-compare-price {
      font-size: 11px;
      color: #999;
      text-decoration: line-through;
      margin-left: 6px;
    }

    /* Quantity controls */
    .qty-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .qty-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 1.5px solid #06C755;
      background: white;
      color: #06C755;
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }
    .qty-btn:active {
      background: #06C755;
      color: white;
    }
    .qty-value {
      font-size: 15px;
      font-weight: 700;
      min-width: 24px;
      text-align: center;
    }

    /* Buttons */
    .btn-primary {
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #06C755, #00b894);
      color: white;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(6, 199, 85, 0.3);
    }
    .btn-primary:active {
      transform: scale(0.98);
      opacity: 0.9;
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }
    .btn-outline {
      width: 100%;
      padding: 12px;
      border: 2px solid #06C755;
      border-radius: 12px;
      background: transparent;
      color: #06C755;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-outline:active {
      background: rgba(6, 199, 85, 0.05);
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

    /* Floating cart bar */
    .cart-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid rgba(0, 0, 0, 0.08);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 100;
      animation: slideUp 0.3s ease-out;
    }
    .cart-info {
      flex: 1;
    }
    .cart-count {
      font-size: 13px;
      color: #666;
    }
    .cart-total {
      font-size: 18px;
      font-weight: 800;
      color: #06C755;
    }
    .cart-btn {
      padding: 12px 24px;
      border: none;
      border-radius: 12px;
      background: linear-gradient(135deg, #06C755, #00b894);
      color: white;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(6, 199, 85, 0.3);
    }
    .cart-btn:active {
      opacity: 0.9;
    }

    /* Loading & success */
    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid #e5e7eb;
      border-top-color: #06C755;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 40px auto;
    }
    .success-icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: linear-gradient(135deg, #06C755, #00b894);
      color: white;
      font-size: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: #999;
    }
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .error-banner {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 12px;
      padding: 12px 16px;
      color: #dc2626;
      font-size: 13px;
      margin-bottom: 16px;
      animation: fadeIn 0.3s ease-out;
    }
    .tab-bar {
      display: flex;
      gap: 0;
      margin-bottom: 16px;
      background: rgba(255, 255, 255, 0.6);
      border-radius: 12px;
      padding: 4px;
    }
    .tab-btn {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 10px;
      background: transparent;
      color: #666;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: white;
      color: #06C755;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
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
    @keyframes scaleIn {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
}

// ─── Render Functions ───

function renderLoading(): string {
  return `
    <div class="reorder-container">
      <div class="reorder-header">
        <h1>再購入</h1>
        <p>読み込み中...</p>
      </div>
      <div class="loading-spinner"></div>
    </div>
  `;
}

function renderOrdersList(): string {
  const ordersHtml = state.orders.length > 0
    ? state.orders.map((o, i) => {
        const itemsPreview = o.lineItems
          .slice(0, 3)
          .map((li) => escapeHtml(li.name || li.title))
          .join('、');
        const more = o.lineItems.length > 3 ? ` 他${o.lineItems.length - 3}点` : '';
        const statusBadge = o.fulfillmentStatus === 'fulfilled'
          ? '<span class="order-badge badge-fulfilled">配送済み</span>'
          : '<span class="order-badge badge-pending">処理中</span>';

        return `
          <div class="order-card" data-order-id="${escapeHtml(o.id)}" style="animation-delay: ${i * 0.05}s">
            <div class="order-header">
              <span class="order-number">注文 #${escapeHtml(String(o.orderNumber))}</span>
              <span class="order-price">${formatPrice(o.totalPrice)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span class="order-date">${formatDate(o.createdAt)}</span>
              ${statusBadge}
            </div>
            <div class="order-items-preview">${escapeHtml(itemsPreview + more)}</div>
          </div>
        `;
      }).join('')
    : `<div class="empty-state">
        <div class="empty-state-icon">📦</div>
        <p>まだ注文履歴がありません</p>
      </div>`;

  return ordersHtml;
}

function renderProductsList(): string {
  if (state.products.length === 0) {
    return `<div class="empty-state">
      <div class="empty-state-icon">🛍️</div>
      <p>商品がありません</p>
    </div>`;
  }

  return state.products.map((p) => {
    const cartItem = state.cart.get(p.shopifyProductId);
    const qty = cartItem ? cartItem.quantity : 0;

    return `
      <div class="product-row">
        ${p.imageUrl
          ? `<img src="${escapeHtml(p.imageUrl)}" alt="" class="product-img" loading="lazy">`
          : '<div class="product-img-placeholder">🧴</div>'}
        <div class="product-info">
          <div class="product-title">${escapeHtml(p.title)}</div>
          <div>
            <span class="product-price">${formatPrice(p.price)}</span>
            ${p.compareAtPrice && Number(p.compareAtPrice) > Number(p.price)
              ? `<span class="product-compare-price">${formatPrice(p.compareAtPrice)}</span>`
              : ''}
          </div>
        </div>
        <div class="qty-controls">
          ${qty > 0
            ? `<button class="qty-btn" data-action="decrease" data-product-id="${escapeHtml(p.shopifyProductId)}">−</button>
               <span class="qty-value">${qty}</span>`
            : ''}
          <button class="qty-btn" data-action="increase" data-product-id="${escapeHtml(p.shopifyProductId)}" style="${qty === 0 ? 'background:#06C755;color:white;' : ''}">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderOrderDetail(): string {
  const order = state.orders.find((o) => o.id === state.selectedOrderId);
  if (!order) return '';

  const itemsHtml = order.lineItems.map((li) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600;color:#333">${escapeHtml(li.name || li.title)}</div>
        <div style="font-size:12px;color:#999">× ${li.quantity}</div>
      </div>
      <div style="font-size:14px;font-weight:700;color:#06C755">${formatPrice(Number(li.price) * li.quantity)}</div>
    </div>
  `).join('');

  return `
    <div class="reorder-container">
      <button class="btn-back" id="backBtn">← 戻る</button>
      <div class="glass-card">
        <div class="order-header">
          <span class="order-number">注文 #${escapeHtml(String(order.orderNumber))}</span>
          <span class="order-price">${formatPrice(order.totalPrice)}</span>
        </div>
        <div class="order-date" style="margin-bottom:16px">${formatDate(order.createdAt)}</div>
        ${itemsHtml}
      </div>
      <button class="btn-primary" id="reorderBtn" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? '処理中...' : '同じ内容で再注文する'}
      </button>
      <div style="height:12px"></div>
      <button class="btn-outline" id="storeBtn">Shopifyストアで見る</button>
    </div>
  `;
}

function renderCreating(): string {
  return `
    <div class="reorder-container">
      <div style="text-align:center;padding:60px 20px">
        <div class="loading-spinner"></div>
        <p style="margin-top:16px;color:#666;font-size:14px">注文を作成中...</p>
      </div>
    </div>
  `;
}

function renderSuccess(): string {
  return `
    <div class="reorder-container">
      <div class="glass-card" style="text-align:center;padding:40px 20px">
        <div class="success-icon">✓</div>
        <h2 style="font-size:20px;font-weight:800;margin-bottom:8px">注文準備完了!</h2>
        <p style="font-size:14px;color:#666;margin-bottom:8px">
          合計 <strong style="color:#06C755">${formatPrice(state.totalPrice)}</strong>
        </p>
        <p style="font-size:13px;color:#999;margin-bottom:24px">
          決済ページに移動してお支払いを完了してください
        </p>
        <a href="${state.invoiceUrl || '#'}" class="btn-primary" style="display:block;text-decoration:none;text-align:center" target="_blank">
          お支払いへ進む
        </a>
        <div style="height:12px"></div>
        <button class="btn-outline" id="backToListBtn">注文一覧に戻る</button>
      </div>
    </div>
  `;
}

function renderCartBar(): string {
  if (state.cart.size === 0 || state.view !== 'list') return '';

  let totalItems = 0;
  let totalPrice = 0;
  state.cart.forEach((item) => {
    totalItems += item.quantity;
    totalPrice += Number(item.product.price) * item.quantity;
  });

  return `
    <div class="cart-bar">
      <div class="cart-info">
        <div class="cart-count">${totalItems}点</div>
        <div class="cart-total">${formatPrice(totalPrice)}</div>
      </div>
      <button class="cart-btn" id="cartOrderBtn">注文する</button>
    </div>
  `;
}

function render(): void {
  const app = getApp();

  if (state.loading) {
    app.innerHTML = renderLoading();
    return;
  }

  if (state.view === 'order-detail') {
    app.innerHTML = renderOrderDetail();
    attachOrderDetailEvents();
    return;
  }

  if (state.view === 'creating') {
    app.innerHTML = renderCreating();
    return;
  }

  if (state.view === 'success') {
    app.innerHTML = renderSuccess();
    attachSuccessEvents();
    return;
  }

  // Default: list view with tabs
  const activeTab = document.querySelector('.tab-btn.active')?.getAttribute('data-tab') || 'orders';

  app.innerHTML = `
    <div class="reorder-container">
      <div class="reorder-header">
        <h1>再購入</h1>
        <p>${state.profile ? escapeHtml(state.profile.displayName) + ' さん' : ''}</p>
      </div>

      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

      <div class="tab-bar">
        <button class="tab-btn ${activeTab === 'orders' ? 'active' : ''}" data-tab="orders">注文履歴</button>
        <button class="tab-btn ${activeTab === 'products' ? 'active' : ''}" data-tab="products">商品から選ぶ</button>
      </div>

      <div id="tab-content">
        ${activeTab === 'orders' ? renderOrdersList() : renderProductsList()}
      </div>
    </div>
    ${renderCartBar()}
  `;

  attachListEvents();
}

// ─── Event Handlers ───

function attachListEvents(): void {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab') || 'orders';
      const content = document.getElementById('tab-content');
      if (content) {
        content.innerHTML = tab === 'orders' ? renderOrdersList() : renderProductsList();
        if (tab === 'orders') attachOrderClickEvents();
        if (tab === 'products') attachProductEvents();
      }
    });
  });

  attachOrderClickEvents();
  attachProductEvents();

  // Cart order button
  const cartBtn = document.getElementById('cartOrderBtn');
  if (cartBtn) {
    cartBtn.addEventListener('click', () => submitCartOrder());
  }
}

function attachOrderClickEvents(): void {
  document.querySelectorAll('.order-card').forEach((card) => {
    card.addEventListener('click', () => {
      const orderId = card.getAttribute('data-order-id');
      if (orderId) {
        state.selectedOrderId = orderId;
        state.view = 'order-detail';
        render();
      }
    });
  });
}

function attachProductEvents(): void {
  document.querySelectorAll('.qty-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = (btn as HTMLElement).getAttribute('data-action');
      const productId = (btn as HTMLElement).getAttribute('data-product-id');
      if (!productId) return;

      const product = state.products.find((p) => p.shopifyProductId === productId);
      if (!product) return;

      const current = state.cart.get(productId);

      if (action === 'increase') {
        const qty = current ? current.quantity + 1 : 1;
        state.cart.set(productId, { product, quantity: Math.min(99, qty) });
      } else if (action === 'decrease' && current) {
        if (current.quantity <= 1) {
          state.cart.delete(productId);
        } else {
          state.cart.set(productId, { product, quantity: current.quantity - 1 });
        }
      }

      render();
    });
  });
}

function attachOrderDetailEvents(): void {
  const backBtn = document.getElementById('backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state.view = 'list';
      state.selectedOrderId = null;
      render();
    });
  }

  const reorderBtn = document.getElementById('reorderBtn');
  if (reorderBtn) {
    reorderBtn.addEventListener('click', () => submitReorder());
  }

  const storeBtn = document.getElementById('storeBtn');
  if (storeBtn) {
    storeBtn.addEventListener('click', () => {
      const domain = 'naturism-diet.com';
      window.open(`https://${domain}`, '_blank');
    });
  }
}

function attachSuccessEvents(): void {
  const backBtn = document.getElementById('backToListBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state.view = 'list';
      state.invoiceUrl = null;
      state.error = null;
      render();
    });
  }
}

// ─── API Actions ───

async function fetchReorderData(): Promise<void> {
  state.loading = true;
  render();

  try {
    const res = await apiCall('/api/liff/reorder', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to fetch data');
    const json = await res.json() as { success: boolean; data?: { recentOrders: Order[]; products: Product[] } };
    if (json.success && json.data) {
      state.orders = json.data.recentOrders;
      state.products = json.data.products;
    }
  } catch {
    state.error = 'データの読み込みに失敗しました';
  }

  state.loading = false;
  render();
}

async function submitReorder(): Promise<void> {
  if (state.submitting || !state.selectedOrderId) return;
  state.submitting = true;
  state.view = 'creating';
  render();

  try {
    const res = await apiCall('/api/liff/reorder/create', {
      method: 'POST',
      body: JSON.stringify({ orderId: state.selectedOrderId }),
    });

    const json = await res.json() as {
      success: boolean;
      data?: { invoiceUrl: string; totalPrice: number };
      error?: string;
    };

    if (json.success && json.data) {
      state.invoiceUrl = json.data.invoiceUrl;
      state.totalPrice = json.data.totalPrice;
      state.view = 'success';
    } else {
      state.error = json.error || '注文の作成に失敗しました';
      state.view = 'order-detail';
    }
  } catch {
    state.error = '通信エラーが発生しました';
    state.view = 'order-detail';
  }

  state.submitting = false;
  render();
}

async function submitCartOrder(): Promise<void> {
  if (state.submitting || state.cart.size === 0) return;
  state.submitting = true;
  state.view = 'creating';
  render();

  try {
    const items = Array.from(state.cart.values()).map((item) => ({
      variantId: item.product.shopifyProductId,
      quantity: item.quantity,
    }));

    const res = await apiCall('/api/liff/reorder/create', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });

    const json = await res.json() as {
      success: boolean;
      data?: { invoiceUrl: string; totalPrice: number };
      error?: string;
    };

    if (json.success && json.data) {
      state.invoiceUrl = json.data.invoiceUrl;
      state.totalPrice = json.data.totalPrice;
      state.cart.clear();
      state.view = 'success';
    } else {
      state.error = json.error || '注文の作成に失敗しました';
      state.view = 'list';
    }
  } catch {
    state.error = '通信エラーが発生しました';
    state.view = 'list';
  }

  state.submitting = false;
  render();
}

// ─── Entry Point ───

export async function initReorder(): Promise<void> {
  injectStyles();

  try {
    state.profile = await liff.getProfile();
  } catch {
    // Profile fetch failed — continue without it
  }

  await fetchReorderData();
}
