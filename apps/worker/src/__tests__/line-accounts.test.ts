/**
 * Tests for LINE accounts routes.
 *
 * Covers:
 *   1. GET /api/line-accounts — list all accounts with stats and profile
 *   2. GET /api/line-accounts/:id — get single account (role-based serialization)
 *   3. POST /api/line-accounts — create account (owner only)
 *   4. PUT /api/line-accounts/:id — update account (owner only)
 *   5. DELETE /api/line-accounts/:id — delete account (owner only)
 *   6. Role-based access control (staff vs owner/admin)
 *   7. Error handling (404, 400, 500)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_ACCOUNT = {
  id: 'acct-1',
  channel_id: 'ch-123',
  name: 'Test Account',
  channel_access_token: 'token-secret-abc',
  channel_secret: 'secret-xyz',
  login_channel_id: null,
  login_channel_secret: null,
  liff_id: null,
  bot_user_id: null,
  is_active: 1,
  token_expires_at: null,
  created_at: '2025-01-01T00:00:00+09:00',
  updated_at: '2025-01-01T00:00:00+09:00',
};

const MOCK_ACCOUNT_2 = {
  ...MOCK_ACCOUNT,
  id: 'acct-2',
  channel_id: 'ch-456',
  name: 'Second Account',
};

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getLineAccounts: vi.fn(),
    getLineAccountById: vi.fn(),
    createLineAccount: vi.fn(),
    updateLineAccount: vi.fn(),
    deleteLineAccount: vi.fn(),
    getStaffByApiKey: vi.fn(),
  };
});

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

// Mock global fetch for fetchBotProfile
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

import {
  getLineAccounts,
  getLineAccountById,
  createLineAccount,
  updateLineAccount,
  deleteLineAccount,
  getStaffByApiKey,
} from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { lineAccounts } from '../routes/line-accounts.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';
const STAFF_API_KEY = 'staff-key-abc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', lineAccounts);
  return app;
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => ({ count: 0 })),
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

function ownerHeaders() {
  return { headers: { Authorization: `Bearer ${TEST_API_KEY}` } };
}

function staffHeaders() {
  return { headers: { Authorization: `Bearer ${STAFF_API_KEY}` } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LINE Accounts Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();

    // Default: env API_KEY acts as owner
    (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Default: fetch for bot profile returns empty
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
  });

  // =========================================================================
  // GET /api/line-accounts — list all
  // =========================================================================

  describe('GET /api/line-accounts', () => {
    it('returns empty array when no accounts exist', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns accounts with stats and profile info', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ACCOUNT]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          displayName: 'Bot Name',
          pictureUrl: 'https://example.com/pic.png',
          basicId: '@bot123',
        }),
      });

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          channelId: string;
          name: string;
          displayName: string;
          pictureUrl: string | null;
          basicId: string | null;
          stats: { friendCount: number; activeScenarios: number; messagesThisMonth: number };
        }[];
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);

      const account = body.data[0];
      expect(account.id).toBe('acct-1');
      expect(account.channelId).toBe('ch-123');
      expect(account.name).toBe('Test Account');
      expect(account.displayName).toBe('Bot Name');
      expect(account.pictureUrl).toBe('https://example.com/pic.png');
      expect(account.basicId).toBe('@bot123');
      expect(account.stats).toEqual({
        friendCount: 0,
        activeScenarios: 0,
        messagesThisMonth: 0,
      });
    });

    it('omits channelAccessToken and channelSecret from list response', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ACCOUNT]);

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
      const account = body.data[0];
      expect(account).not.toHaveProperty('channelAccessToken');
      expect(account).not.toHaveProperty('channelSecret');
    });

    it('falls back to account name when bot profile fetch fails', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ACCOUNT]);

      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({}),
      });

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { displayName: string; pictureUrl: string | null; basicId: string | null }[];
      };
      expect(body.data[0].displayName).toBe('Test Account');
      expect(body.data[0].pictureUrl).toBeNull();
      expect(body.data[0].basicId).toBeNull();
    });

    it('returns multiple accounts', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ACCOUNT, MOCK_ACCOUNT_2]);

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string }[] };
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe('acct-1');
      expect(body.data[1].id).toBe('acct-2');
    });

    it('returns 401 without authorization', async () => {
      const res = await app.request('/api/line-accounts', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns 500 when getLineAccounts throws', async () => {
      (getLineAccounts as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/line-accounts', ownerHeaders(), env);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // GET /api/line-accounts/:id — get single
  // =========================================================================

  describe('GET /api/line-accounts/:id', () => {
    it('returns full account details for owner', async () => {
      (getLineAccountById as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACCOUNT);

      const res = await app.request('/api/line-accounts/acct-1', ownerHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          channelAccessToken: string;
          channelSecret: string;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('acct-1');
      expect(body.data.channelAccessToken).toBe('token-secret-abc');
      expect(body.data.channelSecret).toBe('secret-xyz');
    });

    it('omits secrets for staff role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'staff-1',
        name: 'Staff User',
        role: 'staff',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });
      (getLineAccountById as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACCOUNT);

      const res = await app.request('/api/line-accounts/acct-1', staffHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('acct-1');
      expect(body.data).not.toHaveProperty('channelAccessToken');
      expect(body.data).not.toHaveProperty('channelSecret');
    });

    it('returns full details for admin role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'admin-1',
        name: 'Admin User',
        role: 'admin',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });
      (getLineAccountById as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ACCOUNT);

      const res = await app.request('/api/line-accounts/acct-1', staffHeaders(), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(body.data).toHaveProperty('channelAccessToken');
      expect(body.data).toHaveProperty('channelSecret');
    });

    it('returns 404 when account not found', async () => {
      (getLineAccountById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.request('/api/line-accounts/nonexistent', ownerHeaders(), env);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('LINE account not found');
    });

    it('returns 500 when getLineAccountById throws', async () => {
      (getLineAccountById as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/line-accounts/acct-1', ownerHeaders(), env);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/line-accounts — create
  // =========================================================================

  describe('POST /api/line-accounts', () => {
    const validBody = {
      channelId: 'new-ch-789',
      name: 'New Account',
      channelAccessToken: 'new-token',
      channelSecret: 'new-secret',
    };

    it('creates an account and returns 201', async () => {
      const created = {
        ...MOCK_ACCOUNT,
        id: 'new-acct',
        channel_id: 'new-ch-789',
        name: 'New Account',
        channel_access_token: 'new-token',
        channel_secret: 'new-secret',
      };
      (createLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; channelAccessToken: string; channelSecret: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('new-acct');
      expect(body.data.channelAccessToken).toBe('new-token');
      expect(body.data.channelSecret).toBe('new-secret');
    });

    it('returns 400 when channelId is missing', async () => {
      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'X', channelAccessToken: 'T', channelSecret: 'S' }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('channelId');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channelId: 'C', channelAccessToken: 'T', channelSecret: 'S' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when channelAccessToken is missing', async () => {
      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channelId: 'C', name: 'N', channelSecret: 'S' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when channelSecret is missing', async () => {
      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channelId: 'C', name: 'N', channelAccessToken: 'T' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 403 for staff role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'staff-1',
        name: 'Staff User',
        role: 'staff',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });

      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STAFF_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('returns 403 for admin role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'admin-1',
        name: 'Admin User',
        role: 'admin',
        is_active: 1,
        api_key: 'admin-key',
      });

      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('returns 500 when createLineAccount throws', async () => {
      (createLineAccount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const res = await app.request(
        '/api/line-accounts',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(validBody),
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // PUT /api/line-accounts/:id — update
  // =========================================================================

  describe('PUT /api/line-accounts/:id', () => {
    it('updates an account and returns full details', async () => {
      const updated = { ...MOCK_ACCOUNT, name: 'Updated Name' };
      (updateLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Updated Name' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { name: string; channelAccessToken: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated Name');
      expect(body.data.channelAccessToken).toBe('token-secret-abc');
    });

    it('updates isActive field correctly', async () => {
      (updateLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_ACCOUNT,
        is_active: 0,
      });

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ isActive: false }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { isActive: boolean } };
      expect(body.data.isActive).toBe(false);
    });

    it('returns 404 when account not found', async () => {
      (updateLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const res = await app.request(
        '/api/line-accounts/nonexistent',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('LINE account not found');
    });

    it('returns 403 for staff role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'staff-1',
        name: 'Staff User',
        role: 'staff',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${STAFF_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('returns 500 when updateLineAccount throws', async () => {
      (updateLineAccount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${TEST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // DELETE /api/line-accounts/:id — delete
  // =========================================================================

  describe('DELETE /api/line-accounts/:id', () => {
    it('deletes an account and returns success', async () => {
      (deleteLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });

    it('calls deleteLineAccount with correct id', async () => {
      (deleteLineAccount as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );
      expect(deleteLineAccount).toHaveBeenCalledWith(env.DB, 'acct-1');
    });

    it('returns 403 for staff role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'staff-1',
        name: 'Staff User',
        role: 'staff',
        is_active: 1,
        api_key: STAFF_API_KEY,
      });

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${STAFF_API_KEY}` },
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('returns 403 for admin role', async () => {
      (getStaffByApiKey as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'admin-1',
        name: 'Admin User',
        role: 'admin',
        is_active: 1,
        api_key: 'admin-key',
      });

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-key' },
        },
        env,
      );
      expect(res.status).toBe(403);
    });

    it('returns 500 when deleteLineAccount throws', async () => {
      (deleteLineAccount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));

      const res = await app.request(
        '/api/line-accounts/acct-1',
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });
});
