/**
 * Tests for Stripe integration routes.
 *
 * Covers:
 *   1. GET /api/integrations/stripe/events — list events (default, with filters)
 *   2. POST /api/integrations/stripe/webhook — without signature verification
 *   3. POST /api/integrations/stripe/webhook — with Stripe signature verification
 *   4. Idempotency (duplicate event rejection)
 *   5. payment_intent.succeeded — scoring + tag + event-bus
 *   6. customer.subscription.deleted — cancelled tag
 *   7. Auth bypass for webhook, auth required for events list
 *   8. Error handling (500)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Hoisted mock functions (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

const {
  mockGetStripeEvents,
  mockGetStripeEventByStripeId,
  mockCreateStripeEvent,
  mockApplyScoring,
  mockFireEvent,
} = vi.hoisted(() => ({
  mockGetStripeEvents: vi.fn(),
  mockGetStripeEventByStripeId: vi.fn(),
  mockCreateStripeEvent: vi.fn(),
  mockApplyScoring: vi.fn(),
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
    getStripeEvents: mockGetStripeEvents,
    getStripeEventByStripeId: mockGetStripeEventByStripeId,
    createStripeEvent: mockCreateStripeEvent,
    applyScoring: mockApplyScoring,
    jstNow: vi.fn(() => '2026-01-01T00:00:00+09:00'),
    // Stubs needed by other mounted routes (prevent import errors)
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
import { stripe } from '../routes/stripe.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', stripe);
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

/** Generate a valid HMAC-SHA256 Stripe signature header */
async function generateStripeSignature(secret: string, payload: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const hexSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestamp},v1=${hexSig}`;
}

function makeWebhookBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt_test_001',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_test_001',
        amount: 3980,
        currency: 'jpy',
        metadata: { line_friend_id: 'friend-abc', product_id: 'prod-001' },
        customer: 'cus_test',
        status: 'succeeded',
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stripe Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /api/integrations/stripe/events
  // =========================================================================

  describe('GET /api/integrations/stripe/events', () => {
    it('requires authentication', async () => {
      const res = await app.request('/api/integrations/stripe/events', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns events list with default params', async () => {
      const mockEvents = [
        {
          id: 'se-1',
          stripe_event_id: 'evt_001',
          event_type: 'payment_intent.succeeded',
          friend_id: 'f-1',
          amount: 3980,
          currency: 'jpy',
          metadata: '{"line_friend_id":"f-1"}',
          processed_at: '2026-01-01T00:00:00+09:00',
        },
      ];
      mockGetStripeEvents.mockResolvedValueOnce(mockEvents);

      const res = await app.request(
        '/api/integrations/stripe/events',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockGetStripeEvents).toHaveBeenCalledWith(env.DB, {
        friendId: undefined,
        eventType: undefined,
        limit: 100,
      });
    });

    it('passes friendId and eventType filter params', async () => {
      mockGetStripeEvents.mockResolvedValueOnce([]);
      const res = await app.request(
        '/api/integrations/stripe/events?friendId=f-1&eventType=charge.succeeded&limit=10',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockGetStripeEvents).toHaveBeenCalledWith(env.DB, {
        friendId: 'f-1',
        eventType: 'charge.succeeded',
        limit: 10,
      });
    });

    it('parses metadata JSON in response', async () => {
      mockGetStripeEvents.mockResolvedValueOnce([
        {
          id: 'se-1',
          stripe_event_id: 'evt_001',
          event_type: 'payment_intent.succeeded',
          friend_id: null,
          amount: null,
          currency: null,
          metadata: '{"key":"value"}',
          processed_at: '2026-01-01T00:00:00+09:00',
        },
      ]);
      const res = await app.request(
        '/api/integrations/stripe/events',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      const body = (await res.json()) as { success: boolean; data: { metadata: unknown }[] };
      expect(body.data[0].metadata).toEqual({ key: 'value' });
    });

    it('returns null metadata when metadata column is null', async () => {
      mockGetStripeEvents.mockResolvedValueOnce([
        {
          id: 'se-1',
          stripe_event_id: 'evt_001',
          event_type: 'charge.succeeded',
          friend_id: null,
          amount: null,
          currency: null,
          metadata: null,
          processed_at: '2026-01-01T00:00:00+09:00',
        },
      ]);
      const res = await app.request(
        '/api/integrations/stripe/events',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      const body = (await res.json()) as { success: boolean; data: { metadata: unknown }[] };
      expect(body.data[0].metadata).toBeNull();
    });

    it('returns 500 on internal error', async () => {
      mockGetStripeEvents.mockRejectedValueOnce(new Error('DB error'));
      const res = await app.request(
        '/api/integrations/stripe/events',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/integrations/stripe/webhook — unsecured webhook is rejected
  // =========================================================================
  // セキュリティ強化により STRIPE_WEBHOOK_SECRET 未設定時は 500 で拒否する。
  // 以前 "no STRIPE_WEBHOOK_SECRET" で検証していた機能テストは
  // 下記の "signed webhook" describe に集約（secret+HMAC 署名を付けて検証）。
  describe('POST /api/integrations/stripe/webhook — without secret', () => {
    it('rejects with 500 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
      const webhookBody = makeWebhookBody();
      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookBody),
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('STRIPE_WEBHOOK_SECRET');
    });

    it('bypasses auth middleware (no Authorization header needed even for rejection)', async () => {
      // 認証 middleware をスキップできているか: 401 にならず 500 になる
      const webhookBody = makeWebhookBody();
      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookBody),
        },
        env,
      );
      expect(res.status).not.toBe(401);
    });
  });

  // =========================================================================
  // POST /api/integrations/stripe/webhook — signed webhook
  // =========================================================================
  // 以前 "no secret" で検証していたビジネスロジック（冪等性/scoring/tag 等）は
  // 全て signed webhook 経由のテストに移行（secret + 有効な HMAC 署名を注入）。
  describe('POST /api/integrations/stripe/webhook — signed webhook', () => {
    const STRIPE_SECRET = 'whsec_test_secret_key';

    async function signedPost(
      body: Record<string, unknown>,
      customEnv: Env['Bindings'],
    ): Promise<Response> {
      const rawBody = JSON.stringify(body);
      const sigHeader = await generateStripeSignature(STRIPE_SECRET, rawBody, '1700000000');
      return app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': sigHeader,
          },
          body: rawBody,
        },
        customEnv,
      );
    }

    it('creates event and returns success', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-new',
        stripe_event_id: 'evt_test_001',
        event_type: 'payment_intent.succeeded',
        processed_at: '2026-01-01T00:00:00+09:00',
      });

      const res = await signedPost(makeWebhookBody(), envWithSecret);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; stripeEventId: string; eventType: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('se-new');
      expect(body.data.stripeEventId).toBe('evt_test_001');
      expect(body.data.eventType).toBe('payment_intent.succeeded');
    });

    it('returns already processed for duplicate events (idempotency)', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockResolvedValueOnce({
        id: 'se-existing',
        stripe_event_id: 'evt_test_001',
      });

      const res = await signedPost(makeWebhookBody(), envWithSecret);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.success).toBe(true);
      expect(body.data.message).toBe('Already processed');
      expect(mockCreateStripeEvent).not.toHaveBeenCalled();
    });

    it('calls applyScoring and fireEvent on payment_intent.succeeded with friendId', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-1',
        stripe_event_id: 'evt_test_001',
        event_type: 'payment_intent.succeeded',
        processed_at: '2026-01-01T00:00:00+09:00',
      });
      mockApplyScoring.mockResolvedValueOnce(100);
      mockFireEvent.mockResolvedValueOnce(undefined);

      const res = await signedPost(makeWebhookBody(), envWithSecret);
      expect(res.status).toBe(200);
      expect(mockApplyScoring).toHaveBeenCalledWith(envWithSecret.DB, 'friend-abc', 'purchase');
      expect(mockFireEvent).toHaveBeenCalledWith(envWithSecret.DB, 'cv_fire', {
        friendId: 'friend-abc',
        eventData: {
          type: 'purchase',
          amount: 3980,
          stripeEventId: 'evt_test_001',
        },
      });
    });

    it('queries tag for auto-tagging when product_id is in metadata', async () => {
      const mockDb = createMockDb();
      const mockFirst = vi.fn(async () => ({ id: 'tag-purchased-prod-001' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: vi.fn(async () => ({ success: true })) }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind, first: vi.fn(), all: vi.fn(), run: vi.fn() }));
      (mockDb as unknown as { prepare: typeof mockPrepare }).prepare = mockPrepare;

      const envWithDb = createMockEnv({ DB: mockDb, STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-1',
        stripe_event_id: 'evt_test_001',
        event_type: 'payment_intent.succeeded',
        processed_at: '2026-01-01T00:00:00+09:00',
      });
      mockApplyScoring.mockResolvedValueOnce(100);
      mockFireEvent.mockResolvedValueOnce(undefined);

      const res = await signedPost(makeWebhookBody(), envWithDb);
      expect(res.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM tags WHERE name = ?'),
      );
    });

    it('does NOT call applyScoring when friendId is absent', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-1',
        stripe_event_id: 'evt_no_friend',
        event_type: 'payment_intent.succeeded',
        processed_at: '2026-01-01T00:00:00+09:00',
      });

      const body = makeWebhookBody({
        id: 'evt_no_friend',
        data: {
          object: {
            id: 'pi_test_002',
            amount: 1000,
            currency: 'jpy',
            metadata: {},
            customer: 'cus_test',
            status: 'succeeded',
          },
        },
      });
      const res = await signedPost(body, envWithSecret);
      expect(res.status).toBe(200);
      expect(mockApplyScoring).not.toHaveBeenCalled();
      expect(mockFireEvent).not.toHaveBeenCalled();
    });

    it('handles customer.subscription.deleted with tag assignment', async () => {
      const mockDb = createMockDb();
      const mockRun = vi.fn(async () => ({ success: true }));
      const mockFirst = vi.fn(async () => ({ id: 'tag-sub-cancelled' }));
      const mockBind = vi.fn(() => ({ first: mockFirst, all: vi.fn(), run: mockRun }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind, first: vi.fn(), all: vi.fn(), run: vi.fn() }));
      (mockDb as unknown as { prepare: typeof mockPrepare }).prepare = mockPrepare;

      const envWithDb = createMockEnv({ DB: mockDb, STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });

      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-sub',
        stripe_event_id: 'evt_sub_deleted',
        event_type: 'customer.subscription.deleted',
        processed_at: '2026-01-01T00:00:00+09:00',
      });

      const body = makeWebhookBody({
        id: 'evt_sub_deleted',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_test_001',
            metadata: { line_friend_id: 'friend-xyz' },
            status: 'canceled',
          },
        },
      });

      const res = await signedPost(body, envWithDb);
      expect(res.status).toBe(200);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining("subscription_cancelled"),
      );
    });

    it('returns 500 on internal error', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockRejectedValueOnce(new Error('DB failure'));

      const res = await signedPost(makeWebhookBody(), envWithSecret);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/integrations/stripe/webhook (with Stripe signature verification)
  // =========================================================================

  describe('POST /api/integrations/stripe/webhook (with STRIPE_WEBHOOK_SECRET)', () => {
    const STRIPE_SECRET = 'whsec_test_secret_key';

    it('returns 401 when signature is invalid', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const webhookBody = makeWebhookBody();
      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': 't=1234567890,v1=invalid_signature',
          },
          body: JSON.stringify(webhookBody),
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Stripe signature verification failed');
    });

    it('returns 401 when Stripe-Signature header is missing', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const webhookBody = makeWebhookBody();
      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookBody),
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
    });

    it('accepts request with valid HMAC signature', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      mockGetStripeEventByStripeId.mockResolvedValueOnce(null);
      mockCreateStripeEvent.mockResolvedValueOnce({
        id: 'se-sig',
        stripe_event_id: 'evt_test_001',
        event_type: 'payment_intent.succeeded',
        processed_at: '2026-01-01T00:00:00+09:00',
      });
      mockApplyScoring.mockResolvedValueOnce(100);
      mockFireEvent.mockResolvedValueOnce(undefined);

      const webhookBody = makeWebhookBody();
      const rawBody = JSON.stringify(webhookBody);
      const timestamp = '1700000000';
      const sigHeader = await generateStripeSignature(STRIPE_SECRET, rawBody, timestamp);

      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': sigHeader,
          },
          body: rawBody,
        },
        envWithSecret,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('se-sig');
    });

    it('rejects request when signature is computed with wrong secret', async () => {
      const envWithSecret = createMockEnv({ STRIPE_WEBHOOK_SECRET: STRIPE_SECRET });
      const webhookBody = makeWebhookBody();
      const rawBody = JSON.stringify(webhookBody);
      const timestamp = '1700000000';
      const sigHeader = await generateStripeSignature('wrong_secret_key', rawBody, timestamp);

      const res = await app.request(
        '/api/integrations/stripe/webhook',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Stripe-Signature': sigHeader,
          },
          body: rawBody,
        },
        envWithSecret,
      );
      expect(res.status).toBe(401);
    });
  });
});
