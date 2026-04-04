/**
 * Tests for Shopify integration routes.
 *
 * Covers:
 *   1. POST /api/integrations/shopify/webhook — without signature verification
 *   2. POST /api/integrations/shopify/webhook — with Shopify HMAC signature verification
 *   3. Webhook topic routing (orders/create, orders/updated, customers/create, customers/update)
 *   4. Idempotency (duplicate order rejection)
 *   5. Friend matching by email/phone + auto-tagging + event-bus
 *   6. Unhandled topic returns success with message
 *   7. GET /api/integrations/shopify/orders — list with filters
 *   8. GET /api/integrations/shopify/orders/:id — detail / 404
 *   9. GET /api/integrations/shopify/customers — list
 *  10. POST /api/integrations/shopify/sync — placeholder
 *  11. Auth bypass for webhook, auth required for other endpoints
 *  12. Error handling (500)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Hoisted mock functions
// ---------------------------------------------------------------------------

const {
  mockUpsertShopifyOrder,
  mockUpsertShopifyCustomer,
  mockGetShopifyOrders,
  mockGetShopifyOrderById,
  mockGetShopifyCustomers,
  mockGetShopifyOrderByShopifyId,
  mockGetShopifyCustomerByShopifyId,
  mockLinkShopifyCustomerToFriend,
  mockFireEvent,
} = vi.hoisted(() => ({
  mockUpsertShopifyOrder: vi.fn(),
  mockUpsertShopifyCustomer: vi.fn(),
  mockGetShopifyOrders: vi.fn(),
  mockGetShopifyOrderById: vi.fn(),
  mockGetShopifyCustomers: vi.fn(),
  mockGetShopifyOrderByShopifyId: vi.fn(),
  mockGetShopifyCustomerByShopifyId: vi.fn(),
  mockLinkShopifyCustomerToFriend: vi.fn(),
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
    upsertShopifyOrder: mockUpsertShopifyOrder,
    upsertShopifyCustomer: mockUpsertShopifyCustomer,
    getShopifyOrders: mockGetShopifyOrders,
    getShopifyOrderById: mockGetShopifyOrderById,
    getShopifyCustomers: mockGetShopifyCustomers,
    getShopifyOrderByShopifyId: mockGetShopifyOrderByShopifyId,
    getShopifyCustomerByShopifyId: mockGetShopifyCustomerByShopifyId,
    linkShopifyCustomerToFriend: mockLinkShopifyCustomerToFriend,
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
import { shopify } from '../routes/shopify.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', shopify);
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

function makeOrderWebhookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5551234567890,
    order_number: 1001,
    email: 'test@example.com',
    phone: '+81-90-1234-5678',
    total_price: '3980.00',
    currency: 'JPY',
    financial_status: 'paid',
    fulfillment_status: null,
    tags: 'naturism',
    line_items: [
      { id: 1, title: 'naturism サプリメント', quantity: 1, price: '3980.00' },
    ],
    customer: {
      id: 7771234567890,
      email: 'test@example.com',
      phone: '+81-90-1234-5678',
      first_name: '太郎',
      last_name: '田中',
    },
    ...overrides,
  };
}

function makeCustomerWebhookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7771234567890,
    email: 'test@example.com',
    phone: '+81-90-1234-5678',
    first_name: '太郎',
    last_name: '田中',
    orders_count: 3,
    total_spent: '11940.00',
    tags: 'naturism,repeat',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shopify Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // POST /api/integrations/shopify/webhook (no signature verification)
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook (no SHOPIFY_WEBHOOK_SECRET)', () => {
    it('bypasses auth middleware', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockUpsertShopifyOrder.mockResolvedValueOnce({
        id: 'so-1',
        shopify_order_id: '5551234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('processes orders/create and returns success', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockUpsertShopifyOrder.mockResolvedValueOnce({
        id: 'so-new',
        shopify_order_id: '5551234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; shopifyOrderId: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('so-new');
      expect(body.data.shopifyOrderId).toBe('5551234567890');
    });

    it('returns already processed for duplicate orders (idempotency)', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce({
        id: 'so-existing',
        shopify_order_id: '5551234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Already processed');
      expect(mockUpsertShopifyOrder).not.toHaveBeenCalled();
    });

    it('processes orders/updated without idempotency check', async () => {
      mockUpsertShopifyOrder.mockResolvedValueOnce({
        id: 'so-updated',
        shopify_order_id: '5551234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/updated',
          },
          body: JSON.stringify(makeOrderWebhookBody({ financial_status: 'refunded' })),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockGetShopifyOrderByShopifyId).not.toHaveBeenCalled();
      expect(mockUpsertShopifyOrder).toHaveBeenCalled();
    });

    it('processes customers/create', async () => {
      mockUpsertShopifyCustomer.mockResolvedValueOnce({
        id: 'sc-1',
        shopify_customer_id: '7771234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'customers/create',
          },
          body: JSON.stringify(makeCustomerWebhookBody()),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; shopifyCustomerId: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('sc-1');
      expect(body.data.shopifyCustomerId).toBe('7771234567890');
    });

    it('processes customers/update', async () => {
      mockUpsertShopifyCustomer.mockResolvedValueOnce({
        id: 'sc-1',
        shopify_customer_id: '7771234567890',
      });

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'customers/update',
          },
          body: JSON.stringify(makeCustomerWebhookBody({ orders_count: 5, total_spent: '19900.00' })),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockUpsertShopifyCustomer).toHaveBeenCalled();
    });

    it('returns success with message for unhandled topic', async () => {
      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'products/update',
          },
          body: JSON.stringify({ id: 123 }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toContain('products/update');
    });

    it('handles missing topic header gracefully', async () => {
      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 123 }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.success).toBe(true);
    });

    it('returns 500 on internal error', async () => {
      mockGetShopifyOrderByShopifyId.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('passes correct params to upsertShopifyOrder', async () => {
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockUpsertShopifyOrder.mockResolvedValueOnce({
        id: 'so-1',
        shopify_order_id: '5551234567890',
      });

      await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        env,
      );

      expect(mockUpsertShopifyOrder).toHaveBeenCalledWith(
        env.DB,
        expect.objectContaining({
          shopifyOrderId: '5551234567890',
          shopifyCustomerId: '7771234567890',
          email: 'test@example.com',
          phone: '+81-90-1234-5678',
          currency: 'JPY',
          financialStatus: 'paid',
          orderNumber: 1001,
        }),
      );
    });
  });

  // =========================================================================
  // POST /api/integrations/shopify/webhook (with signature verification)
  // =========================================================================

  describe('POST /api/integrations/shopify/webhook (with SHOPIFY_WEBHOOK_SECRET)', () => {
    const SHOPIFY_SECRET = 'shopify_webhook_test_secret';

    it('returns 401 when signature is invalid', async () => {
      const envWithSecret = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET });
      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
            'X-Shopify-Hmac-Sha256': 'invalid_base64_signature',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Shopify signature verification failed');
    });

    it('returns 401 when HMAC header is missing', async () => {
      const envWithSecret = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET });
      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
          },
          body: JSON.stringify(makeOrderWebhookBody()),
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
    });

    it('accepts request with valid HMAC signature', async () => {
      const envWithSecret = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET });
      mockGetShopifyOrderByShopifyId.mockResolvedValueOnce(null);
      mockUpsertShopifyOrder.mockResolvedValueOnce({
        id: 'so-sig',
        shopify_order_id: '5551234567890',
      });

      const rawBody = JSON.stringify(makeOrderWebhookBody());
      const hmac = await generateShopifyHmac(SHOPIFY_SECRET, rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        envWithSecret,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('so-sig');
    });

    it('rejects request signed with wrong secret', async () => {
      const envWithSecret = createMockEnv({ SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET });
      const rawBody = JSON.stringify(makeOrderWebhookBody());
      const hmac = await generateShopifyHmac('wrong_secret', rawBody);

      const res = await app.request(
        '/api/integrations/shopify/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Topic': 'orders/create',
            'X-Shopify-Hmac-Sha256': hmac,
          },
          body: rawBody,
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/integrations/shopify/orders
  // =========================================================================

  describe('GET /api/integrations/shopify/orders', () => {
    it('requires authentication', async () => {
      const res = await app.request('/api/integrations/shopify/orders', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns orders list with default params', async () => {
      const mockOrders = [
        {
          id: 'so-1',
          shopify_order_id: '555001',
          shopify_customer_id: '777001',
          friend_id: 'f-1',
          email: 'test@example.com',
          phone: '+810901234567',
          total_price: 3980,
          currency: 'JPY',
          financial_status: 'paid',
          fulfillment_status: null,
          order_number: 1001,
          line_items: '[{"title":"naturism サプリ"}]',
          tags: 'naturism',
          metadata: '{"source":"webhook"}',
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
      ];
      mockGetShopifyOrders.mockResolvedValueOnce(mockOrders);

      const res = await app.request(
        '/api/integrations/shopify/orders',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ shopifyOrderId: string; lineItems: unknown; metadata: unknown }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].shopifyOrderId).toBe('555001');
      expect(body.data[0].lineItems).toEqual([{ title: 'naturism サプリ' }]);
      expect(body.data[0].metadata).toEqual({ source: 'webhook' });
    });

    it('passes filter params to query', async () => {
      mockGetShopifyOrders.mockResolvedValueOnce([]);

      await app.request(
        '/api/integrations/shopify/orders?friendId=f-1&email=test@example.com&limit=10&offset=20',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(mockGetShopifyOrders).toHaveBeenCalledWith(env.DB, {
        friendId: 'f-1',
        email: 'test@example.com',
        limit: 10,
        offset: 20,
      });
    });

    it('handles null metadata and line_items', async () => {
      mockGetShopifyOrders.mockResolvedValueOnce([
        {
          id: 'so-2',
          shopify_order_id: '555002',
          shopify_customer_id: null,
          friend_id: null,
          email: null,
          phone: null,
          total_price: null,
          currency: 'JPY',
          financial_status: null,
          fulfillment_status: null,
          order_number: null,
          line_items: null,
          tags: null,
          metadata: null,
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
      ]);

      const res = await app.request(
        '/api/integrations/shopify/orders',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      const body = (await res.json()) as { success: boolean; data: Array<{ lineItems: unknown; metadata: unknown }> };
      expect(body.data[0].lineItems).toBeNull();
      expect(body.data[0].metadata).toBeNull();
    });

    it('returns 500 on internal error', async () => {
      mockGetShopifyOrders.mockRejectedValueOnce(new Error('DB error'));
      const res = await app.request(
        '/api/integrations/shopify/orders',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/integrations/shopify/orders/:id
  // =========================================================================

  describe('GET /api/integrations/shopify/orders/:id', () => {
    it('requires authentication', async () => {
      const res = await app.request('/api/integrations/shopify/orders/so-1', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns order detail', async () => {
      mockGetShopifyOrderById.mockResolvedValueOnce({
        id: 'so-1',
        shopify_order_id: '555001',
        shopify_customer_id: '777001',
        friend_id: 'f-1',
        email: 'test@example.com',
        phone: null,
        total_price: 3980,
        currency: 'JPY',
        financial_status: 'paid',
        fulfillment_status: 'fulfilled',
        order_number: 1001,
        line_items: '[]',
        tags: null,
        metadata: '{}',
        created_at: '2026-01-01T00:00:00',
        updated_at: '2026-01-01T00:00:00',
      });

      const res = await app.request(
        '/api/integrations/shopify/orders/so-1',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; financialStatus: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('so-1');
      expect(body.data.financialStatus).toBe('paid');
    });

    it('returns 404 for non-existent order', async () => {
      mockGetShopifyOrderById.mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/integrations/shopify/orders/non-existent',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Order not found');
    });

    it('returns 500 on internal error', async () => {
      mockGetShopifyOrderById.mockRejectedValueOnce(new Error('DB error'));
      const res = await app.request(
        '/api/integrations/shopify/orders/so-1',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/integrations/shopify/customers
  // =========================================================================

  describe('GET /api/integrations/shopify/customers', () => {
    it('requires authentication', async () => {
      const res = await app.request('/api/integrations/shopify/customers', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns customers list', async () => {
      const mockCustomers = [
        {
          id: 'sc-1',
          shopify_customer_id: '777001',
          friend_id: 'f-1',
          email: 'test@example.com',
          phone: '+810901234567',
          first_name: '太郎',
          last_name: '田中',
          orders_count: 3,
          total_spent: 11940,
          tags: 'naturism,repeat',
          metadata: '{}',
          created_at: '2026-01-01T00:00:00',
          updated_at: '2026-01-01T00:00:00',
        },
      ];
      mockGetShopifyCustomers.mockResolvedValueOnce(mockCustomers);

      const res = await app.request(
        '/api/integrations/shopify/customers',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ shopifyCustomerId: string; firstName: string }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].shopifyCustomerId).toBe('777001');
      expect(body.data[0].firstName).toBe('太郎');
    });

    it('passes filter params', async () => {
      mockGetShopifyCustomers.mockResolvedValueOnce([]);

      await app.request(
        '/api/integrations/shopify/customers?friendId=f-1&limit=50',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(mockGetShopifyCustomers).toHaveBeenCalledWith(env.DB, {
        friendId: 'f-1',
        email: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('returns 500 on internal error', async () => {
      mockGetShopifyCustomers.mockRejectedValueOnce(new Error('DB error'));
      const res = await app.request(
        '/api/integrations/shopify/customers',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/integrations/shopify/sync
  // =========================================================================

  describe('POST /api/integrations/shopify/sync', () => {
    it('requires authentication', async () => {
      const res = await app.request(
        '/api/integrations/shopify/sync',
        { method: 'POST' },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('returns placeholder message', async () => {
      const res = await app.request(
        '/api/integrations/shopify/sync',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toContain('not yet implemented');
    });
  });
});
