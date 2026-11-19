/**
 * Tests for Shopify Phase 2A integration routes.
 *
 * Covers:
 *   1. Webhook: checkouts/create → abandoned_carts
 *   2. Webhook: fulfillments/create → shopify_fulfillments
 *   3. Webhook: inventory_levels/update → restock_request notification
 *   4. Webhook: orders/paid → payment_notification
 *   5. CRUD: Restock Requests (POST / GET / DELETE)
 *   6. CRUD: Coupons (POST / GET / PUT / DELETE / assign / assignments)
 *   7. CRUD: Member Ranks (GET / POST / PUT / DELETE / friend rank / calculate)
 *   8. CRUD: Abandoned Carts (GET / stats)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const {
  mockUpsertAbandonedCart,
  mockGetAbandonedCartByCheckoutId,
  mockUpsertShopifyFulfillment,
  mockGetPaymentNotificationByOrder,
  mockCreatePaymentNotification,
  mockCreateRestockRequest,
  mockGetRestockRequestsByFriend,
  mockGetRestockRequestsByVariant,
  mockGetRestockRequestsByInventoryItem,
  mockCancelRestockRequest,
  mockUpdateRestockRequestStatus,
  mockGetShopifyCoupons,
  mockCreateShopifyCoupon,
  mockUpdateShopifyCoupon,
  mockDeleteShopifyCoupon,
  mockAssignCoupon,
  mockGetCouponAssignmentsByFriend,
  mockGetMemberRanks,
  mockCreateMemberRank,
  mockUpdateMemberRank,
  mockDeleteMemberRank,
  mockGetFriendRank,
  mockCalculateAndUpdateFriendRank,
  mockGetShopifyOrderByShopifyId,
  mockFireEvent,
} = vi.hoisted(() => ({
  mockUpsertAbandonedCart: vi.fn(),
  mockGetAbandonedCartByCheckoutId: vi.fn(),
  mockUpsertShopifyFulfillment: vi.fn(),
  mockGetPaymentNotificationByOrder: vi.fn(),
  mockCreatePaymentNotification: vi.fn(),
  mockCreateRestockRequest: vi.fn(),
  mockGetRestockRequestsByFriend: vi.fn(),
  mockGetRestockRequestsByVariant: vi.fn(),
  mockGetRestockRequestsByInventoryItem: vi.fn(),
  mockCancelRestockRequest: vi.fn(),
  mockUpdateRestockRequestStatus: vi.fn(),
  mockGetShopifyCoupons: vi.fn(),
  mockCreateShopifyCoupon: vi.fn(),
  mockUpdateShopifyCoupon: vi.fn(),
  mockDeleteShopifyCoupon: vi.fn(),
  mockAssignCoupon: vi.fn(),
  mockGetCouponAssignmentsByFriend: vi.fn(),
  mockGetMemberRanks: vi.fn(),
  mockCreateMemberRank: vi.fn(),
  mockUpdateMemberRank: vi.fn(),
  mockDeleteMemberRank: vi.fn(),
  mockGetFriendRank: vi.fn(),
  mockCalculateAndUpdateFriendRank: vi.fn(),
  mockGetShopifyOrderByShopifyId: vi.fn(),
  mockFireEvent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async (_db: unknown, apiKey: string) => {
      if (apiKey === 'test-api-key-secret-12345') return { id: 'env-owner', name: 'Owner', role: 'owner', is_active: 1, api_key: apiKey };
      return null;
    }),
    upsertAbandonedCart: mockUpsertAbandonedCart,
    getAbandonedCartByCheckoutId: mockGetAbandonedCartByCheckoutId,
    upsertShopifyFulfillment: mockUpsertShopifyFulfillment,
    getPaymentNotificationByOrder: mockGetPaymentNotificationByOrder,
    createPaymentNotification: mockCreatePaymentNotification,
    createRestockRequest: mockCreateRestockRequest,
    getRestockRequestsByFriend: mockGetRestockRequestsByFriend,
    getRestockRequestsByVariant: mockGetRestockRequestsByVariant,
    getRestockRequestsByInventoryItem: mockGetRestockRequestsByInventoryItem,
    cancelRestockRequest: mockCancelRestockRequest,
    updateRestockRequestStatus: mockUpdateRestockRequestStatus,
    getShopifyCoupons: mockGetShopifyCoupons,
    createShopifyCoupon: mockCreateShopifyCoupon,
    updateShopifyCoupon: mockUpdateShopifyCoupon,
    deleteShopifyCoupon: mockDeleteShopifyCoupon,
    assignCoupon: mockAssignCoupon,
    getCouponAssignmentsByFriend: mockGetCouponAssignmentsByFriend,
    getMemberRanks: mockGetMemberRanks,
    createMemberRank: mockCreateMemberRank,
    updateMemberRank: mockUpdateMemberRank,
    deleteMemberRank: mockDeleteMemberRank,
    getFriendRank: mockGetFriendRank,
    calculateAndUpdateFriendRank: mockCalculateAndUpdateFriendRank,
    getShopifyOrderByShopifyId: mockGetShopifyOrderByShopifyId,
    jstNow: vi.fn(() => '2026-01-01T00:00:00+09:00'),
    // Stubs needed by other mounted routes
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
    getFriendById: vi.fn(async () => null),
    getLatestRiskLevel: vi.fn(async () => 'safe'),
    getAccountHealthLogs: vi.fn(async () => []),
    getAccountMigrations: vi.fn(async () => []),
    getAccountMigrationById: vi.fn(async () => null),
    createAccountMigration: vi.fn(async () => ({
      id: 'mig-1', from_account_id: 'acct-1', to_account_id: 'acct-2',
      status: 'pending', total_count: 0, created_at: new Date().toISOString(),
    })),
    updateAccountMigration: vi.fn(async () => ({})),
  };
});

// Mock line-sdk
vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async getProfile(userId: string) {
      return { displayName: 'Test', userId, pictureUrl: '', statusMessage: '' };
    }
    async showLoadingAnimation() {}
  },
}));

// Mock event-bus
vi.mock('../services/event-bus.js', () => ({
  fireEvent: mockFireEvent,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { shopifyPhase2a } from '../routes/shopify-phase2a.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', shopifyPhase2a);
  return app;
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(overrides: Record<string, unknown> = {}): Env['Bindings'] {
  return {
    DB: createMockDb(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
    ...overrides,
  } as Env['Bindings'];
}

/** Generate a valid Shopify HMAC-SHA256 signature (base64 encoded) */
async function generateShopifyHmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---------------------------------------------------------------------------
// Webhook body factories
// ---------------------------------------------------------------------------

function makeCheckoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'checkout_001',
    token: 'tok_abc123',
    cart_token: 'cart_abc123',
    email: 'test@example.com',
    phone: '+81-90-1234-5678',
    total_price: '3980.00',
    currency: 'JPY',
    abandoned_checkout_url: 'https://shop.example.com/checkouts/abc123/recover',
    line_items: [
      { id: 1, title: 'naturism サプリメント', quantity: 1, price: '3980.00' },
    ],
    customer: {
      id: 7771234567890,
      email: 'test@example.com',
      phone: '+81-90-1234-5678',
    },
    ...overrides,
  };
}

function makeFulfillmentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ful_001',
    order_id: '5551234567890',
    tracking_number: 'TRACK123456',
    tracking_url: 'https://tracking.example.com/TRACK123456',
    tracking_company: 'Yamato Transport',
    status: 'success',
    line_items: [
      { id: 1, title: 'naturism サプリメント', quantity: 1 },
    ],
    ...overrides,
  };
}

function makeInventoryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inventory_item_id: 'variant_001',
    location_id: 'loc_001',
    available: 10,
    ...overrides,
  };
}

function makePaymentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5551234567890,
    order_number: 1001,
    email: 'test@example.com',
    phone: '+81-90-1234-5678',
    financial_status: 'paid',
    total_price: '3980.00',
    currency: 'JPY',
    customer: {
      id: 7771234567890,
      email: 'test@example.com',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shopify Phase 2A Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];
  const SHOPIFY_SECRET = 'shopify_webhook_test_secret';

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET });
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. checkouts/create Webhook
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook/checkout', () => {
    it('saves checkout to abandoned_carts with valid HMAC', async () => {
      mockGetAbandonedCartByCheckoutId.mockResolvedValueOnce(null);
      mockUpsertAbandonedCart.mockResolvedValueOnce({
        id: 'ac-1',
        shopify_checkout_id: 'checkout_001',
      });

      const rawBody = JSON.stringify(makeCheckoutBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/checkout',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; shopifyCheckoutId: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('ac-1');
      expect(body.data.shopifyCheckoutId).toBe('checkout_001');
    });

    it('sets notification_scheduled_at to ~1 hour from now', async () => {
      mockGetAbandonedCartByCheckoutId.mockResolvedValueOnce(null);
      mockUpsertAbandonedCart.mockResolvedValueOnce({
        id: 'ac-2',
        shopify_checkout_id: 'checkout_001',
      });

      const rawBody = JSON.stringify(makeCheckoutBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const beforeTime = Date.now();
      await app.request(
        '/api/integrations/shopify/webhook/checkout',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(mockUpsertAbandonedCart).toHaveBeenCalledTimes(1);
      const callArgs = mockUpsertAbandonedCart.mock.calls[0][1];
      const scheduledAt = new Date(callArgs.notificationScheduledAt).getTime();
      const expectedMinTime = beforeTime + 59 * 60 * 1000; // ~59 min
      const expectedMaxTime = beforeTime + 61 * 60 * 1000; // ~61 min
      expect(scheduledAt).toBeGreaterThan(expectedMinTime);
      expect(scheduledAt).toBeLessThan(expectedMaxTime);
    });

    it('returns 401 with invalid signature', async () => {
      const rawBody = JSON.stringify(makeCheckoutBody());

      const res = await app.request(
        '/api/integrations/shopify/webhook/checkout',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': 'invalid_signature',
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Shopify signature verification failed');
    });
  });

  // =========================================================================
  // 2. fulfillments/create Webhook
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook/fulfillment', () => {
    it('saves fulfillment to shopify_fulfillments', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce({ id: 'so-1', shopify_order_id: '5551234567890' });
      mockUpsertShopifyFulfillment.mockResolvedValueOnce({
        id: 'sf-1',
        shopify_fulfillment_id: 'ful_001',
      });

      const rawBody = JSON.stringify(makeFulfillmentBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/fulfillment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; shopifyFulfillmentId: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('sf-1');
      expect(body.data.shopifyFulfillmentId).toBe('ful_001');
    });

    it('passes tracking_number and tracking_url to upsert', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockUpsertShopifyFulfillment.mockResolvedValueOnce({
        id: 'sf-2',
        shopify_fulfillment_id: 'ful_001',
      });

      const rawBody = JSON.stringify(makeFulfillmentBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      await app.request(
        '/api/integrations/shopify/webhook/fulfillment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(mockUpsertShopifyFulfillment).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          shopifyFulfillmentId: 'ful_001',
          shopifyOrderId: '5551234567890',
          trackingNumber: 'TRACK123456',
          trackingUrl: 'https://tracking.example.com/TRACK123456',
          trackingCompany: 'Yamato Transport',
          status: 'success',
        }),
      );
    });

    it('order.friend_id 既存時も fulfillment に friend_id を書く (2026-07-30 障害修正: LIFF 配送状況が常に空)', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce({ id: 'so-1', shopify_order_id: '5551234567890' });
      mockUpsertShopifyFulfillment.mockResolvedValueOnce({ id: 'sf-1', shopify_fulfillment_id: 'ful_001' });

      // sql 認識モック: 注文行は friend_id 済み。UPDATE shopify_fulfillments SET friend_id を捕捉
      const sqls: string[] = [];
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(async () => ({ email: 'a@example.com', phone: null, friend_id: 'f-99', line_user_id: 'U_test' })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      };
      const db = { prepare: vi.fn((sql: string) => { sqls.push(sql); return stmt; }) } as unknown as D1Database;
      const envLinked = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: db });

      const rawBody = JSON.stringify(makeFulfillmentBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/fulfillment',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac },
          body: rawBody,
        },
        envLinked,
      );
      expect(res.status).toBe(200);
      // 非同期処理 (waitUntil 相当) の完了を待つ
      await new Promise((r) => setTimeout(r, 20));
      expect(sqls.some((s) => s.includes('UPDATE shopify_fulfillments SET friend_id'))).toBe(true);
    });

    describe('発送の LINE 通知 (領収書のページへの案内つき・1 発送 1 通)', () => {
      const pushes: Array<{ url: string; body: { to: string; messages: Array<{ type: string; text: string }> } }> = [];
      let pushStatus = 200;

      beforeEach(() => {
        pushes.length = 0;
        pushStatus = 200;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
          pushes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
          return new Response('{}', { status: pushStatus });
        }));
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      type OrderRow = { email: string | null; phone: string | null; friend_id: string | null; order_number?: number | null };

      /**
       * SQL を見て答える DB。
       * - 注文の SELECT は order_number を列に含むときだけ order_number を返す (SELECT から列が消えたら落ちる)
       * - shopify_fulfillments.notified_at を状態として持ち、条件つき UPDATE の changes を返す
       */
      function statefulDb(orderRow: OrderRow | null, initialNotifiedAt: string | null = null) {
        const state = { notifiedAt: initialNotifiedAt };
        const db = {
          prepare: vi.fn((sql: string) => {
            let args: unknown[] = [];
            const stmt = {
              bind: vi.fn((...a: unknown[]) => { args = a; return stmt; }),
              first: vi.fn(async () => {
                if (sql.includes('FROM shopify_orders')) {
                  if (!orderRow) return null;
                  const { order_number, ...rest } = orderRow;
                  return /\border_number\b/.test(sql) ? { ...rest, order_number } : rest;
                }
                if (sql.includes('FROM friends')) return { line_user_id: 'U_test' };
                return null;
              }),
              all: vi.fn(async () => ({ results: [] })),
              run: vi.fn(async () => {
                if (sql.includes('SET notified_at = ?') && sql.includes('notified_at IS NULL')) {
                  if (state.notifiedAt !== null) return { success: true, meta: { changes: 0 } };
                  state.notifiedAt = String(args[0]);
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes('SET notified_at = NULL')) {
                  if (state.notifiedAt === args[2]) {
                    state.notifiedAt = null;
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                return { success: true, meta: { changes: 1 } };
              }),
            };
            return stmt;
          }),
        } as unknown as D1Database;
        return { db, state };
      }

      /** 非同期処理 (waitUntil) を実際に待ってから返す */
      async function postFulfillment(targetEnv: Env['Bindings'], overrides: Record<string, unknown> = {}) {
        mockGetShopifyOrderByShopifyId.mockResolvedValueOnce({ id: 'so-1', shopify_order_id: '5551234567890' });
        mockUpsertShopifyFulfillment.mockResolvedValueOnce({ id: 'sf-1', shopify_fulfillment_id: 'ful_001' });
        const rawBody = JSON.stringify(makeFulfillmentBody(overrides));
        const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);
        const pending: Promise<unknown>[] = [];
        const executionCtx = {
          waitUntil: (p: Promise<unknown>) => { pending.push(p); },
          passThroughOnException: () => {},
          props: {},
        } as unknown as ExecutionContext;
        const res = await app.request(
          '/api/integrations/shopify/webhook/fulfillment',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac },
            body: rawBody,
          },
          targetEnv,
          executionCtx,
        );
        expect(res.status).toBe(200);
        expect(pending).toHaveLength(1); // 待つべき処理を本当に待っている
        await Promise.all(pending);
      }

      const order: OrderRow = { email: 'a@example.com', phone: null, friend_id: 'f-99', order_number: 4625 };
      const envWith = (db: D1Database, notify: string | null = 'true') =>  // null = 未設定
        createMockEnv({
          SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET,
          ...(notify === null ? {} : { SHOPIFY_LINE_NOTIFY_ENABLED: notify }),
          DB: db,
        });

      it('1 通の文に追跡番号・注文番号・領収書のページのリンクが入る', async () => {
        const { db, state } = statefulDb(order);
        await postFulfillment(envWith(db), { name: '#4625.1' });

        expect(pushes).toHaveLength(1);
        expect(pushes[0].url).toBe('https://api.line.me/v2/bot/message/push');
        expect(pushes[0].body.to).toBe('U_test');
        // 吹き出しは 1 つのまま (通数 = 費用を増やさない)
        expect(pushes[0].body.messages).toHaveLength(1);
        const text = pushes[0].body.messages[0].text;
        expect(text).toContain('追跡番号: TRACK123456');
        expect(text).toContain('注文番号 (#4625) と、ご注文のときのメールアドレス');
        expect(text).toContain('https://app.2clover.biz/receipt/lookup');
        expect(state.notifiedAt).not.toBeNull();
      });

      it('webhook に name が無ければ D1 の order_number から注文番号を出す', async () => {
        const { db } = statefulDb(order);
        await postFulfillment(envWith(db));

        expect(pushes).toHaveLength(1);
        expect(pushes[0].body.messages[0].text).toContain('注文番号 (#4625) と、');
      });

      it('注文番号が取れないときは番号の部分を省いてリンクは出す', async () => {
        const { db } = statefulDb({ ...order, order_number: null });
        await postFulfillment(envWith(db));

        expect(pushes).toHaveLength(1);
        const text = pushes[0].body.messages[0].text;
        expect(text).toContain('領収書が必要なお客様は、注文番号と、');
        expect(text).toContain('https://app.2clover.biz/receipt/lookup');
      });

      it('同じ発送の fulfillments/update が続いても 2 通目は送らない', async () => {
        const { db } = statefulDb(order);
        await postFulfillment(envWith(db), { name: '#4625.1' });
        await postFulfillment(envWith(db), { name: '#4625.1', shipment_status: 'in_transit' });
        await postFulfillment(envWith(db), { name: '#4625.1', shipment_status: 'delivered' });

        expect(pushes).toHaveLength(1);
      });

      it('既に送った印のある発送には送らない', async () => {
        const { db } = statefulDb(order, '2026-11-18T10:00:00.000');
        await postFulfillment(envWith(db), { name: '#4625.1' });

        expect(pushes).toHaveLength(0);
      });

      it('LINE への送信が失敗したら印を戻し、次の update で送り直す', async () => {
        const { db, state } = statefulDb(order);
        pushStatus = 500;
        await postFulfillment(envWith(db), { name: '#4625.1' });
        expect(pushes).toHaveLength(1);
        expect(state.notifiedAt).toBeNull();

        pushStatus = 200;
        await postFulfillment(envWith(db), { name: '#4625.1', shipment_status: 'in_transit' });
        expect(pushes).toHaveLength(2);
        expect(state.notifiedAt).not.toBeNull();
      });

      it('LINE への送信が例外で落ちても印を戻し、次の update で送り直す', async () => {
        const { db, state } = statefulDb(order);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('network')));
        await postFulfillment(envWith(db), { name: '#4625.1' });
        expect(state.notifiedAt).toBeNull();

        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
          pushes.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
          return new Response('{}', { status: 200 });
        }));
        await postFulfillment(envWith(db), { name: '#4625.1', shipment_status: 'in_transit' });
        expect(pushes).toHaveLength(1);
        expect(state.notifiedAt).not.toBeNull();
      });

      it('SHOPIFY_LINE_NOTIFY_ENABLED が true でなければ送らない (今のまま)', async () => {
        await postFulfillment(envWith(statefulDb(order).db, null), { name: '#4625.1' });
        await postFulfillment(envWith(statefulDb(order).db, 'false'), { name: '#4625.1' });

        expect(pushes).toHaveLength(0);
      });

      it('追跡番号が無ければ送らない (今のまま)', async () => {
        await postFulfillment(envWith(statefulDb(order).db), { tracking_number: undefined, name: '#4625.1' });

        expect(pushes).toHaveLength(0);
      });

      it('LINE の友だちにひも付いていなければ送らない (注文が無い / 照合でも見つからない)', async () => {
        await postFulfillment(envWith(statefulDb(null).db), { name: '#4625.1' });
        await postFulfillment(
          envWith(statefulDb({ email: 'nobody@example.com', phone: '09000000000', friend_id: null, order_number: 4625 }).db),
          { name: '#4625.1' },
        );

        expect(pushes).toHaveLength(0);
      });
    });

    it('returns 401 with invalid signature', async () => {
      const rawBody = JSON.stringify(makeFulfillmentBody());

      const res = await app.request(
        '/api/integrations/shopify/webhook/fulfillment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': 'invalid_signature',
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 3. inventory_levels/update Webhook
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook/inventory', () => {
    // Task#3 完動化後の挙動: inventory_item_id 照合 + gated 温存 + 通知有効時のみ消費
    const enabledEnv = () =>
      createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, SHOPIFY_LINE_NOTIFY_ENABLED: 'true' });

    async function postInventory(targetEnv: Env['Bindings'], overrides: Record<string, unknown> = {}) {
      const rawBody = JSON.stringify(makeInventoryBody(overrides));
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);
      return app.request(
        '/api/integrations/shopify/webhook/inventory',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        targetEnv,
      );
    }

    it('queues notifications matched by inventory_item_id when enabled', async () => {
      mockGetRestockRequestsByInventoryItem.mockResolvedValueOnce([
        { id: 'rr-1', friend_id: 'f-1', product_title: 'naturism サプリ' },
        { id: 'rr-2', friend_id: 'f-2', product_title: 'naturism サプリ' },
      ]);

      const res = await postInventory(enabledEnv(), { available: 5 });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string; inventoryItemId: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toContain('2 restock notification(s) queued');
      expect(body.data.inventoryItemId).toBe('variant_001');
      // 照合は inventory_item_id (旧 variant_id 照合バグの再発防止)
      expect(mockGetRestockRequestsByInventoryItem).toHaveBeenCalledWith(expect.anything(), 'variant_001', 'waiting');
    });

    it('preserves waiting requests (no consumption, no lookup) when gated off', async () => {
      // env に SHOPIFY_LINE_NOTIFY_ENABLED なし = gated。旧実装は未送信でも notified に消費していた
      const res = await postInventory(env, { available: 5 });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('requests preserved');
      expect(mockGetRestockRequestsByInventoryItem).not.toHaveBeenCalled();
      expect(mockUpdateRestockRequestStatus).not.toHaveBeenCalled();
    });

    it('returns success with no-op when no waiting restock_requests', async () => {
      mockGetRestockRequestsByInventoryItem.mockResolvedValueOnce([]);

      const res = await postInventory(enabledEnv(), { available: 5 });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('No waiting restock requests');
    });

    it('returns success with no notifications when available is 0', async () => {
      const res = await postInventory(enabledEnv(), { available: 0 });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('Stock not available');
      expect(mockGetRestockRequestsByInventoryItem).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. orders/paid Webhook
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook/payment', () => {
    it('creates payment_notification log on orders/paid', async () => {
      mockGetPaymentNotificationByOrder.mockResolvedValueOnce(null);
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockCreatePaymentNotification.mockResolvedValueOnce({
        id: 'pn-1',
        shopify_order_id: '5551234567890',
      });

      const rawBody = JSON.stringify(makePaymentBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/payment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; shopifyOrderId: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('pn-1');
      expect(mockCreatePaymentNotification).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          shopifyOrderId: '5551234567890',
          financialStatus: 'paid',
        }),
      );
    });

    it('skips duplicate notification (idempotency)', async () => {
      mockGetPaymentNotificationByOrder.mockResolvedValueOnce({
        id: 'pn-existing',
        shopify_order_id: '5551234567890',
      });

      const rawBody = JSON.stringify(makePaymentBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/payment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string; id: string } };
      expect(body.data.message).toBe('Already notified');
      expect(body.data.id).toBe('pn-existing');
      expect(mockCreatePaymentNotification).not.toHaveBeenCalled();
    });

    it('returns 401 with invalid signature', async () => {
      const rawBody = JSON.stringify(makePaymentBody());

      const res = await app.request(
        '/api/integrations/shopify/webhook/payment',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Hmac-Sha256': 'invalid_signature',
          },
          body: rawBody,
        },
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 5. CRUD: Restock Requests
  // =========================================================================

  describe('Restock Requests CRUD', () => {
    it('POST creates a restock request', async () => {
      mockCreateRestockRequest.mockResolvedValueOnce({
        id: 'rr-new',
        friend_id: 'f-1',
        shopify_product_id: 'prod_001',
        shopify_variant_id: 'var_001',
        status: 'waiting',
      });

      const res = await app.request(
        '/api/integrations/shopify/restock-requests',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({
            friendId: 'f-1',
            shopifyProductId: 'prod_001',
            shopifyVariantId: 'var_001',
            productTitle: 'naturism サプリ',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('rr-new');
    });

    it('GET returns list filtered by friendId', async () => {
      mockGetRestockRequestsByFriend.mockResolvedValueOnce([
        { id: 'rr-1', friend_id: 'f-1', shopify_product_id: 'prod_001', status: 'waiting' },
      ]);

      const res = await app.request(
        '/api/integrations/shopify/restock-requests?friendId=f-1',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(body.data).toHaveLength(1);
      expect(mockGetRestockRequestsByFriend).toHaveBeenCalledWith(env.DB, 'f-1');
    });

    it('DELETE cancels a restock request', async () => {
      // Mock the DB prepare chain for existence check
      const mockFirst = vi.fn(async () => ({ id: 'rr-1', status: 'waiting' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: vi.fn() }));
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: mockBind,
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });
      mockCancelRestockRequest.mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/integrations/shopify/restock-requests/rr-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        envWithDb,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toBe('Restock request cancelled');
    });

    it('DELETE returns 404 for non-existent ID', async () => {
      const res = await app.request(
        '/api/integrations/shopify/restock-requests/non-existent',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('Restock request not found');
    });
  });

  // =========================================================================
  // 6. CRUD: Coupons
  // =========================================================================

  describe('Coupons CRUD', () => {
    it('POST creates a coupon', async () => {
      mockCreateShopifyCoupon.mockResolvedValueOnce({
        id: 'cp-1',
        code: 'WELCOME10',
        discount_type: 'percentage',
        discount_value: 10,
        status: 'active',
      });

      const res = await app.request(
        '/api/integrations/shopify/coupons',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({
            code: 'WELCOME10',
            discountType: 'percentage',
            discountValue: 10,
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; code: string } };
      expect(body.success).toBe(true);
      expect(body.data.code).toBe('WELCOME10');
    });

    it('GET returns coupon list', async () => {
      mockGetShopifyCoupons.mockResolvedValueOnce([
        { id: 'cp-1', code: 'WELCOME10', discount_type: 'percentage', discount_value: 10 },
        { id: 'cp-2', code: 'SUMMER20', discount_type: 'percentage', discount_value: 20 },
      ]);

      const res = await app.request(
        '/api/integrations/shopify/coupons',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(body.data).toHaveLength(2);
    });

    it('PUT updates a coupon', async () => {
      mockUpdateShopifyCoupon.mockResolvedValueOnce({
        id: 'cp-1',
        code: 'WELCOME10',
        discount_type: 'percentage',
        discount_value: 15,
      });

      const res = await app.request(
        '/api/integrations/shopify/coupons/cp-1',
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({ discountValue: 15 }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { discount_value: number } };
      expect(body.data.discount_value).toBe(15);
    });

    it('DELETE deletes a coupon', async () => {
      // Mock DB to return existing coupon
      const mockFirst = vi.fn(async () => ({ id: 'cp-1' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: vi.fn() }));
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: mockBind,
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });
      mockDeleteShopifyCoupon.mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/integrations/shopify/coupons/cp-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        envWithDb,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toBe('Coupon deleted');
    });

    it('POST /:id/assign assigns coupon to a friend', async () => {
      // Mock DB to return existing active coupon
      const mockFirst = vi.fn(async () => ({ id: 'cp-1', status: 'active' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: vi.fn() }));
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: mockBind,
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });
      mockAssignCoupon.mockResolvedValueOnce({
        id: 'ca-1',
        coupon_id: 'cp-1',
        friend_id: 'f-1',
      });

      const res = await app.request(
        '/api/integrations/shopify/coupons/cp-1/assign',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({ friendId: 'f-1' }),
        },
        envWithDb,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; coupon_id: string } };
      expect(body.data.coupon_id).toBe('cp-1');
    });

    it('GET /assignments returns assignment list', async () => {
      mockGetCouponAssignmentsByFriend.mockResolvedValueOnce([
        { id: 'ca-1', coupon_id: 'cp-1', friend_id: 'f-1', code: 'WELCOME10' },
      ]);

      const res = await app.request(
        '/api/integrations/shopify/coupons/assignments?friendId=f-1',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(body.data).toHaveLength(1);
    });
  });

  // =========================================================================
  // 7. CRUD: Member Ranks
  // =========================================================================

  describe('Member Ranks CRUD', () => {
    it('GET returns rank list', async () => {
      mockGetMemberRanks.mockResolvedValueOnce([
        { id: 'rank_regular', name: 'レギュラー', sort_order: 1 },
        { id: 'rank_bronze', name: 'ブロンズ', sort_order: 2 },
        { id: 'rank_silver', name: 'シルバー', sort_order: 3 },
        { id: 'rank_gold', name: 'ゴールド', sort_order: 4 },
        { id: 'rank_platinum', name: 'プラチナ', sort_order: 5 },
      ]);

      const res = await app.request(
        '/api/integrations/shopify/ranks',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(body.data).toHaveLength(5);
    });

    it('POST creates a rank', async () => {
      mockCreateMemberRank.mockResolvedValueOnce({
        id: 'rank_new',
        name: 'ダイヤモンド',
        min_total_spent: 200000,
        min_orders_count: 30,
        sort_order: 6,
      });

      const res = await app.request(
        '/api/integrations/shopify/ranks',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({
            name: 'ダイヤモンド',
            minTotalSpent: 200000,
            minOrdersCount: 30,
            sortOrder: 6,
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; name: string } };
      expect(body.data.name).toBe('ダイヤモンド');
    });

    it('PUT updates a rank', async () => {
      mockUpdateMemberRank.mockResolvedValueOnce({
        id: 'rank_gold',
        name: 'ゴールド',
        min_total_spent: 40000,
      });

      const res = await app.request(
        '/api/integrations/shopify/ranks/rank_gold',
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({ minTotalSpent: 40000 }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { min_total_spent: number } };
      expect(body.data.min_total_spent).toBe(40000);
    });

    it('DELETE deletes a rank', async () => {
      // Mock DB to return existing rank
      const mockFirst = vi.fn(async () => ({ id: 'rank_test' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: vi.fn() }));
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: mockBind,
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });
      mockDeleteMemberRank.mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/integrations/shopify/ranks/rank_test',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        envWithDb,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toBe('Rank deleted');
    });

    it('GET /friend/:friendId returns 404 when no rank set', async () => {
      mockGetFriendRank.mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/integrations/shopify/ranks/friend/f-1',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('Friend rank not found');
    });

    it('POST /calculate/:friendId calculates and returns rank', async () => {
      mockCalculateAndUpdateFriendRank.mockResolvedValueOnce({
        friend_id: 'f-1',
        rank_id: 'rank_silver',
        rank_name: 'シルバー',
        total_spent: 20000,
        orders_count: 7,
      });

      const res = await app.request(
        '/api/integrations/shopify/ranks/calculate/f-1',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { rank_name: string; total_spent: number } };
      expect(body.data.rank_name).toBe('シルバー');
      expect(body.data.total_spent).toBe(20000);
    });
  });

  // =========================================================================
  // 8. CRUD: Abandoned Carts
  // =========================================================================

  describe('Abandoned Carts CRUD', () => {
    it('GET returns list filtered by status', async () => {
      // Mock DB prepare chain for the dynamic query
      const mockResults = [
        { id: 'ac-1', shopify_checkout_id: 'checkout_001', status: 'pending' },
        { id: 'ac-2', shopify_checkout_id: 'checkout_002', status: 'pending' },
      ];
      const mockAll = vi.fn(async () => ({ results: mockResults }));
      const mockBind = vi.fn(() => ({ first: vi.fn(), all: mockAll, run: vi.fn() }));
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: mockBind,
          first: vi.fn(async () => null),
          all: mockAll,
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });

      const res = await app.request(
        '/api/integrations/shopify/abandoned-carts?status=pending',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        envWithDb,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(body.data).toHaveLength(2);
    });

    it('GET /stats returns count by status', async () => {
      // Mock DB for stats queries
      let callIndex = 0;
      const mockFirstFn = vi.fn(async () => {
        const counts = [{ count: 5 }, { count: 3 }, { count: 2 }];
        return counts[callIndex++] ?? { count: 0 };
      });
      const dbMock = {
        ...createMockDb(),
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ first: mockFirstFn, all: vi.fn(), run: vi.fn() })),
          first: mockFirstFn,
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
      } as unknown as D1Database;

      const envWithDb = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET, DB: dbMock });

      const res = await app.request(
        '/api/integrations/shopify/abandoned-carts/stats',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        envWithDb,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { pending: number; notified: number; recovered: number } };
      expect(body.success).toBe(true);
      expect(body.data.pending).toBe(5);
      expect(body.data.notified).toBe(3);
      expect(body.data.recovered).toBe(2);
    });
  });

  // =========================================================================
  // Auth: webhook endpoints bypass auth, CRUD requires auth
  // =========================================================================

  describe('Auth requirements', () => {
    it('webhook/checkout rejects when no signing secret is configured', async () => {
      // No SHOPIFY_WEBHOOK_SECRET or SHOPIFY_CLIENT_SECRET -> rejected for security
      const envNoSecret = createMockEnv();
      const res = await app.request(
        '/api/integrations/shopify/webhook/checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(makeCheckoutBody()),
        },
        envNoSecret,
      );

      // Should be rejected — no signing secret means no verification possible
      expect(res.status).toBe(401);
      expect(mockUpsertAbandonedCart).not.toHaveBeenCalled();
    });

    it('CRUD endpoints require auth', async () => {
      const res = await app.request(
        '/api/integrations/shopify/restock-requests',
        {},
        env,
      );
      expect(res.status).toBe(401);
    });
  });
});
