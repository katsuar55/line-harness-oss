/**
 * Tests for authentication middleware and health check routes.
 *
 * Covers:
 *   1. Health-related routes behind auth middleware
 *   2. Protected routes require valid Bearer token
 *   3. Correct Bearer token grants access (env API_KEY fallback)
 *   4. Staff API key authentication via DB lookup
 *   5. Invalid token returns 401
 *   6. Missing Authorization header returns 401
 *   7. Missing Bearer prefix returns 401
 *   8. Public routes bypass auth (webhook, docs, LIFF, etc.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — stub getStaffByApiKey and other DB functions
// ---------------------------------------------------------------------------

const mockStaffDb = new Map<string, { id: string; name: string; role: string; is_active: number; api_key: string }>();

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn(async (_db: unknown, apiKey: string) => {
    return mockStaffDb.get(apiKey) ?? null;
  }),
  getLatestRiskLevel: vi.fn(async () => 'safe'),
  getAccountHealthLogs: vi.fn(async () => []),
  getAccountMigrations: vi.fn(async () => []),
  getAccountMigrationById: vi.fn(async () => null),
  createAccountMigration: vi.fn(async () => ({
    id: 'mig-1',
    from_account_id: 'acct-1',
    to_account_id: 'acct-2',
    status: 'pending',
    total_count: 0,
    created_at: new Date().toISOString(),
  })),
  updateAccountMigration: vi.fn(async () => ({})),
  // Friends route stubs (for protected route tests)
  getFriendsCount: vi.fn(async () => 42),
  getFriends: vi.fn(async () => []),
  getFriendById: vi.fn(async () => null),
  // Stubs needed by other mounted routes (prevent import errors)
  getLineAccounts: vi.fn(async () => []),
  getAutoReplies: vi.fn(async () => []),
  getScenarios: vi.fn(async () => []),
  getTags: vi.fn(async () => []),
  getBroadcasts: vi.fn(async () => []),
}));

// Mock line-sdk to prevent import failures
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
// Import app modules after mocks are set up
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { health } from '../routes/health.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';
const STAFF_API_KEY = 'staff-key-abc';

// ---------------------------------------------------------------------------
// Build a minimal Hono app with auth middleware + routes
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', health);

  // A simple protected route for testing auth on generic /api/* paths
  app.get('/api/friends/count', (c) => {
    return c.json({ success: true, data: { count: 42 } });
  });

  // Public routes that auth middleware skips
  app.post('/webhook', (c) => c.json({ ok: true }));
  app.get('/docs', (c) => c.text('docs'));
  app.get('/openapi.json', (c) => c.json({}));
  app.get('/api/liff/profile', (c) => c.json({ ok: true }));

  return app;
}

// ---------------------------------------------------------------------------
// Mock D1Database binding
// ---------------------------------------------------------------------------

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

function createMockEnv(): Env['Bindings'] {
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
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth Middleware', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    mockStaffDb.clear();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Protected route tests
  // =========================================================================

  describe('Protected routes (/api/*)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.request('/api/friends/count', {}, env);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('returns 401 when Authorization header has no Bearer prefix', async () => {
      const res = await app.request(
        '/api/friends/count',
        { headers: { Authorization: TEST_API_KEY } },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('returns 401 when Bearer token is invalid', async () => {
      const res = await app.request(
        '/api/friends/count',
        { headers: { Authorization: 'Bearer wrong-token' } },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('returns 200 with correct env API_KEY Bearer token', async () => {
      const res = await app.request(
        '/api/friends/count',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, data: { count: 42 } });
    });

    it('returns 200 with valid staff API key', async () => {
      mockStaffDb.set(STAFF_API_KEY, {
        id: 'staff-1',
        name: 'Test Staff',
        role: 'admin',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });

      const res = await app.request(
        '/api/friends/count',
        { headers: { Authorization: `Bearer ${STAFF_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, data: { count: 42 } });
    });

    it('returns 401 when Bearer prefix has wrong casing', async () => {
      const res = await app.request(
        '/api/friends/count',
        { headers: { Authorization: `bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Health routes behind auth
  // =========================================================================

  describe('Health routes (require auth)', () => {
    it('GET /api/accounts/:id/health returns 401 without auth', async () => {
      const res = await app.request('/api/accounts/acct-1/health', {}, env);
      expect(res.status).toBe(401);
    });

    it('GET /api/accounts/:id/health returns 200 with valid auth', async () => {
      const res = await app.request(
        '/api/accounts/acct-1/health',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { lineAccountId: string } };
      expect(body.success).toBe(true);
      expect(body.data.lineAccountId).toBe('acct-1');
    });

    it('GET /api/accounts/migrations returns 401 without auth', async () => {
      const res = await app.request('/api/accounts/migrations', {}, env);
      expect(res.status).toBe(401);
    });

    it('GET /api/accounts/migrations returns 200 with valid auth', async () => {
      const res = await app.request(
        '/api/accounts/migrations',
        { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // =========================================================================
  // Public routes (auth bypass)
  // =========================================================================

  describe('Public routes (no auth required)', () => {
    it('POST /webhook is accessible without auth', async () => {
      const res = await app.request('/webhook', { method: 'POST' }, env);
      expect(res.status).toBe(200);
    });

    it('GET /docs is accessible without auth', async () => {
      const res = await app.request('/docs', {}, env);
      expect(res.status).toBe(200);
    });

    it('GET /openapi.json is accessible without auth', async () => {
      const res = await app.request('/openapi.json', {}, env);
      expect(res.status).toBe(200);
    });

    it('GET /api/liff/* is accessible without auth', async () => {
      const res = await app.request('/api/liff/profile', {}, env);
      expect(res.status).toBe(200);
    });
  });
});
