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

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    it('updates waiting restock_requests to notified when stock available', async () => {
      mockGetRestockRequestsByVariant.mockResolvedValueOnce([
        { id: 'rr-1', friend_id: 'f-1', product_title: 'naturism サプリ' },
        { id: 'rr-2', friend_id: 'f-2', product_title: 'naturism サプリ' },
      ]);

      const rawBody = JSON.stringify(makeInventoryBody({ available: 5 }));
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/inventory',
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
      const body = (await res.json()) as { success: boolean; data: { message: string; variantId: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toContain('2 restock notification(s) queued');
      expect(body.data.variantId).toBe('variant_001');
    });

    it('returns success with no-op when no waiting restock_requests', async () => {
      mockGetRestockRequestsByVariant.mockResolvedValueOnce([]);

      const rawBody = JSON.stringify(makeInventoryBody({ available: 5 }));
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/inventory',
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
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('No waiting restock requests');
    });

    it('returns success with no notifications when available is 0', async () => {
      const rawBody = JSON.stringify(makeInventoryBody({ available: 0 }));
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook/inventory',
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
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('Stock not available');
      expect(mockGetRestockRequestsByVariant).not.toHaveBeenCalled();
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
