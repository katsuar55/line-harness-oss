/**
 * Tests for Shopify OAuth authentication routes.
 *
 * Covers:
 *   1. GET /auth/shopify — starts OAuth flow, redirects to Shopify
 *   2. GET /auth/shopify — fails if SHOPIFY_CLIENT_ID is missing
 *   3. GET /auth/shopify/callback — fails with missing parameters
 *   4. GET /auth/shopify/callback — fails with invalid state
 *   5. GET /api/integrations/shopify/status — returns connected: false when no token
 *   6. GET /api/integrations/shopify/status — returns connected: true when token exists
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    jstNow: vi.fn(() => '2026-01-01T00:00:00+09:00'),
    getStaffByApiKey: vi.fn(async (_db: unknown, apiKey: string) => {
      if (apiKey === 'test-api-key-secret-12345') return { id: 'env-owner', name: 'Owner', role: 'owner', is_active: 1, api_key: apiKey };
      return null;
    }),
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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { shopifyAuth } from '../routes/shopify-auth.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.route('/', shopifyAuth);
  return app;
}

function createMockDb(overrides?: {
  prepareReturn?: ReturnType<typeof vi.fn>;
}): D1Database {
  const defaultPrepare = vi.fn(() => ({
    bind: vi.fn(() => ({
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ success: true })),
  }));

  return {
    prepare: overrides?.prepareReturn ?? defaultPrepare,
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
    API_KEY: 'test-api-key-secret-12345',
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
    SHOPIFY_CLIENT_ID: 'test-shopify-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-shopify-client-secret',
    SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com',
    ...overrides,
  } as Env['Bindings'];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shopify Auth Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /auth/shopify
  // =========================================================================

  describe('GET /auth/shopify', () => {
    it('should redirect (302) to Shopify OAuth URL', async () => {
      const res = await app.request('/auth/shopify', {}, env);

      expect(res.status).toBe(302);

      const location = res.headers.get('Location');
      expect(location).toBeTruthy();
      expect(location).toContain('https://test-store.myshopify.com/admin/oauth/authorize');
      expect(location).toContain('client_id=test-shopify-client-id');
      expect(location).toContain('redirect_uri=');
      expect(location).toContain('state=');
      expect(location).toContain('scope=');
    });

    it('should include correct redirect_uri from WORKER_URL', async () => {
      const res = await app.request('/auth/shopify', {}, env);
      const location = res.headers.get('Location') ?? '';

      const redirectUri = encodeURIComponent('https://worker.example.com/auth/shopify/callback');
      expect(location).toContain(`redirect_uri=${redirectUri}`);
    });

    it('should use shop query parameter when provided', async () => {
      const res = await app.request('/auth/shopify?shop=custom-store.myshopify.com', {}, env);

      expect(res.status).toBe(302);
      const location = res.headers.get('Location') ?? '';
      expect(location).toContain('https://custom-store.myshopify.com/admin/oauth/authorize');
    });

    it('should save nonce state to D1', async () => {
      const mockPrepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const envWithMockDb = createMockEnv({ DB: createMockDb({ prepareReturn: mockPrepare }) });

      await app.request('/auth/shopify', {}, envWithMockDb);

      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO shopify_oauth_states'),
      );
    });

    it('should fail with 500 if SHOPIFY_CLIENT_ID is missing', async () => {
      const envNoClientId = createMockEnv({
        SHOPIFY_CLIENT_ID: undefined,
      });

      const res = await app.request('/auth/shopify', {}, envNoClientId);

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Shopify credentials not configured');
    });

    it('should fail with 500 if SHOPIFY_STORE_DOMAIN is missing', async () => {
      const envNoStoreDomain = createMockEnv({
        SHOPIFY_STORE_DOMAIN: undefined,
      });

      const res = await app.request('/auth/shopify', {}, envNoStoreDomain);

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Shopify credentials not configured');
    });
  });

  // =========================================================================
  // GET /auth/shopify/callback
  // =========================================================================

  describe('GET /auth/shopify/callback', () => {
    it('should fail with 400 when code parameter is missing', async () => {
      const res = await app.request(
        '/auth/shopify/callback?shop=test-store.myshopify.com&state=test-nonce&hmac=abc123',
        {},
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing required parameters');
    });

    it('should fail with 400 when shop parameter is missing', async () => {
      const res = await app.request(
        '/auth/shopify/callback?code=test-code&state=test-nonce&hmac=abc123',
        {},
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing required parameters');
    });

    it('should fail with 400 when state parameter is missing', async () => {
      const res = await app.request(
        '/auth/shopify/callback?code=test-code&shop=test-store.myshopify.com&hmac=abc123',
        {},
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing required parameters');
    });

    it('should fail with 400 when all parameters are missing', async () => {
      const res = await app.request('/auth/shopify/callback', {}, env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Missing required parameters');
    });

    it('should fail with 400 when state is invalid (not found in D1)', async () => {
      // Generate a valid HMAC so we get past HMAC verification
      const params = new URLSearchParams({
        code: 'test-code',
        shop: 'test-store.myshopify.com',
        state: 'invalid-nonce',
        timestamp: '1234567890',
      });

      // Sort params and compute HMAC
      const message = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');

      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode('test-shopify-client-secret'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(message),
      );
      const hmac = Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      params.set('hmac', hmac);

      // D1 mock returns null for the state lookup (state not found)
      const res = await app.request(
        `/auth/shopify/callback?${params.toString()}`,
        {},
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Invalid state parameter');
    });

    it('should fail with 500 when SHOPIFY_CLIENT_ID is missing', async () => {
      const envNoClientId = createMockEnv({
        SHOPIFY_CLIENT_ID: undefined,
      });

      const res = await app.request(
        '/auth/shopify/callback?code=test-code&shop=test.myshopify.com&state=nonce',
        {},
        envNoClientId,
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Shopify credentials not configured');
    });

    it('should fail with 401 when HMAC verification fails', async () => {
      const res = await app.request(
        '/auth/shopify/callback?code=test-code&shop=test.myshopify.com&state=nonce&hmac=invalid_hmac',
        {},
        env,
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('HMAC verification failed');
    });
  });

  // =========================================================================
  // GET /api/integrations/shopify/status
  // =========================================================================

  describe('GET /api/integrations/shopify/status', () => {
    it('should return connected: false when no token exists', async () => {
      // Default mock DB returns null for first() — no token stored
      const res = await app.request('/api/integrations/shopify/status', {}, env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { connected: boolean; storeDomain: string | null };
      };
      expect(body.success).toBe(true);
      expect(body.data.connected).toBe(false);
      expect(body.data.storeDomain).toBe('test-store.myshopify.com');
    });

    it('should return connected: true when token exists', async () => {
      // Create a mock DB where first() returns a token row
      const mockPrepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({
            access_token: 'shpat_test_token',
            scope: 'read_products,write_products',
            expires_at: '2099-12-31T23:59:59.000Z',
          })),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => ({
          access_token: 'shpat_test_token',
          scope: 'read_products,write_products',
          expires_at: '2099-12-31T23:59:59.000Z',
        })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const envWithToken = createMockEnv({
        DB: createMockDb({ prepareReturn: mockPrepare }),
      });

      // Mock global fetch for Shopify API shop.json call
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ shop: { name: 'Test Store' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ) as typeof fetch;

      try {
        const res = await app.request('/api/integrations/shopify/status', {}, envWithToken);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          success: boolean;
          data: {
            connected: boolean;
            storeDomain: string | null;
            shopName: string | null;
            scope: string;
            expiresAt: string;
          };
        };
        expect(body.success).toBe(true);
        expect(body.data.connected).toBe(true);
        expect(body.data.storeDomain).toBe('test-store.myshopify.com');
        expect(body.data.shopName).toBe('Test Store');
        expect(body.data.scope).toBe('read_products,write_products');
        expect(body.data.expiresAt).toBe('2099-12-31T23:59:59.000Z');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return connected: true with null shopName when Shopify API fails', async () => {
      const mockPrepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => ({
            access_token: 'shpat_test_token',
            scope: 'read_products',
            expires_at: '2099-12-31T23:59:59.000Z',
          })),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => ({
          access_token: 'shpat_test_token',
          scope: 'read_products',
          expires_at: '2099-12-31T23:59:59.000Z',
        })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const envWithToken = createMockEnv({
        DB: createMockDb({ prepareReturn: mockPrepare }),
      });

      // Mock global fetch to return error
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response('Unauthorized', { status: 401 }),
      ) as typeof fetch;

      try {
        const res = await app.request('/api/integrations/shopify/status', {}, envWithToken);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          success: boolean;
          data: {
            connected: boolean;
            shopName: string | null;
          };
        };
        expect(body.success).toBe(true);
        expect(body.data.connected).toBe(true);
        expect(body.data.shopName).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should return storeDomain: null when SHOPIFY_STORE_DOMAIN is not set', async () => {
      const envNoStore = createMockEnv({
        SHOPIFY_STORE_DOMAIN: undefined,
      });

      const res = await app.request('/api/integrations/shopify/status', {}, envNoStore);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { connected: boolean; storeDomain: string | null };
      };
      expect(body.success).toBe(true);
      expect(body.data.connected).toBe(false);
      expect(body.data.storeDomain).toBeNull();
    });
  });
});
