/**
 * Tests for health routes: AI test, account health, and account migrations.
 *
 * Covers:
 *   1. GET /api/ai-test — AI response test (success / error / custom query)
 *   2. GET /api/accounts/:id/health — account risk level and health logs
 *   3. GET /api/accounts/migrations — list all migrations
 *   4. POST /api/accounts/:id/migrate — create a migration
 *   5. GET /api/accounts/migrations/:migrationId — get migration by ID
 *   6. Error handling — each route returns 500 on unexpected errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — all vi.fn() inline (no top-level variable refs)
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async () => null),
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
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
    getFriendById: vi.fn(async () => null),
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

// Mock ai-response service
vi.mock('../services/ai-response.js', () => ({
  testAiResponse: vi.fn(async () => ({ text: 'mock', layer: 'ai' })),
}));

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { health } from '../routes/health.js';
import type { Env } from '../index.js';
import {
  getLatestRiskLevel,
  getAccountHealthLogs,
  getAccountMigrations,
  getAccountMigrationById,
  createAccountMigration,
  updateAccountMigration,
} from '@line-crm/db';
import { testAiResponse } from '../services/ai-response.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-health-12345';

const mockedTestAiResponse = testAiResponse as ReturnType<typeof vi.fn>;
const mockedGetLatestRiskLevel = getLatestRiskLevel as ReturnType<typeof vi.fn>;
const mockedGetAccountHealthLogs = getAccountHealthLogs as ReturnType<typeof vi.fn>;
const mockedGetAccountMigrations = getAccountMigrations as ReturnType<typeof vi.fn>;
const mockedGetAccountMigrationById = getAccountMigrationById as ReturnType<typeof vi.fn>;
const mockedCreateAccountMigration = createAccountMigration as ReturnType<typeof vi.fn>;
const mockedUpdateAccountMigration = updateAccountMigration as ReturnType<typeof vi.fn>;

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

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', health);
  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Health Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /api/ai-test
  // =========================================================================

  describe('GET /api/ai-test', () => {
    it('returns AI test result with default query', async () => {
      mockedTestAiResponse.mockResolvedValueOnce({
        text: 'こんにちは！',
        layer: 'ai',
        model: '@cf/qwen/qwen3-30b-a3b-fp8',
      });

      const res = await app.request('/api/ai-test', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; data: { text: string } };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.text).toBe('こんにちは！');
      expect(mockedTestAiResponse).toHaveBeenCalledWith(
        env.AI,
        'こんにちは',
        undefined,
        env.AI_MODEL_PRIMARY,
        env.AI_MODEL_FALLBACK,
      );
    });

    it('passes custom query parameter to AI', async () => {
      mockedTestAiResponse.mockResolvedValueOnce({
        text: 'テスト応答',
        layer: 'ai',
      });

      const res = await app.request('/api/ai-test?q=テスト', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; data: { text: string } };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockedTestAiResponse).toHaveBeenCalledWith(
        env.AI,
        'テスト',
        undefined,
        env.AI_MODEL_PRIMARY,
        env.AI_MODEL_FALLBACK,
      );
    });

    it('returns 500 when AI throws an error', async () => {
      mockedTestAiResponse.mockRejectedValueOnce(new Error('AI model unavailable'));

      const res = await app.request('/api/ai-test', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('AI model unavailable');
    });

    it('handles non-Error thrown values', async () => {
      mockedTestAiResponse.mockRejectedValueOnce('string error');

      const res = await app.request('/api/ai-test', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('string error');
    });

    it('requires authentication', async () => {
      const res = await app.request('/api/ai-test', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/accounts/:id/health
  // =========================================================================

  describe('GET /api/accounts/:id/health', () => {
    it('returns risk level and health logs', async () => {
      mockedGetLatestRiskLevel.mockResolvedValueOnce('warning');
      mockedGetAccountHealthLogs.mockResolvedValueOnce([
        {
          id: 'log-1',
          error_code: 'RATE_LIMIT',
          error_count: 5,
          check_period: '2026-04-01',
          risk_level: 'warning',
          created_at: '2026-04-01T00:00:00Z',
        },
      ]);

      const res = await app.request('/api/accounts/acct-123/health', { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          lineAccountId: string;
          riskLevel: string;
          logs: Array<{
            id: string;
            errorCode: string;
            errorCount: number;
            checkPeriod: string;
            riskLevel: string;
            createdAt: string;
          }>;
        };
      };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.lineAccountId).toBe('acct-123');
      expect(body.data.riskLevel).toBe('warning');
      expect(body.data.logs).toHaveLength(1);
      expect(body.data.logs[0].errorCode).toBe('RATE_LIMIT');
      expect(body.data.logs[0].errorCount).toBe(5);
    });

    it('returns empty logs when no health records exist', async () => {
      mockedGetLatestRiskLevel.mockResolvedValueOnce('safe');
      mockedGetAccountHealthLogs.mockResolvedValueOnce([]);

      const res = await app.request('/api/accounts/acct-456/health', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; data: { logs: unknown[] } };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.logs).toHaveLength(0);
    });

    it('returns 500 on database error', async () => {
      mockedGetLatestRiskLevel.mockRejectedValueOnce(new Error('DB error'));

      const res = await app.request('/api/accounts/acct-err/health', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('requires authentication', async () => {
      const res = await app.request('/api/accounts/acct-1/health', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/accounts/migrations
  // =========================================================================

  describe('GET /api/accounts/migrations', () => {
    it('returns list of migrations', async () => {
      mockedGetAccountMigrations.mockResolvedValueOnce([
        {
          id: 'mig-1',
          from_account_id: 'acct-a',
          to_account_id: 'acct-b',
          status: 'completed',
          migrated_count: 100,
          total_count: 100,
          created_at: '2026-03-01T00:00:00Z',
          completed_at: '2026-03-01T01:00:00Z',
        },
      ]);

      const res = await app.request('/api/accounts/migrations', { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          fromAccountId: string;
          toAccountId: string;
          status: string;
          migratedCount: number;
          totalCount: number;
        }>;
      };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('mig-1');
      expect(body.data[0].fromAccountId).toBe('acct-a');
      expect(body.data[0].toAccountId).toBe('acct-b');
      expect(body.data[0].status).toBe('completed');
      expect(body.data[0].migratedCount).toBe(100);
    });

    it('returns empty array when no migrations exist', async () => {
      mockedGetAccountMigrations.mockResolvedValueOnce([]);

      const res = await app.request('/api/accounts/migrations', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; data: unknown[] };

      expect(res.status).toBe(200);
      expect(body.data).toHaveLength(0);
    });

    it('returns 500 on error', async () => {
      mockedGetAccountMigrations.mockRejectedValueOnce(new Error('DB error'));

      const res = await app.request('/api/accounts/migrations', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('requires authentication', async () => {
      const res = await app.request('/api/accounts/migrations', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // POST /api/accounts/:id/migrate
  // =========================================================================

  describe('POST /api/accounts/:id/migrate', () => {
    it('creates a migration and returns 201', async () => {
      const mockDb = createMockDb();
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(async () => ({ count: 50 })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      const envWithDb = { ...env, DB: mockDb };

      mockedCreateAccountMigration.mockResolvedValueOnce({
        id: 'mig-new',
        from_account_id: 'acct-from',
        to_account_id: 'acct-to',
        status: 'pending',
        total_count: 50,
        created_at: '2026-04-02T00:00:00Z',
      });
      mockedUpdateAccountMigration.mockResolvedValueOnce({});

      const res = await app.request(
        '/api/accounts/acct-from/migrate',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ toAccountId: 'acct-to' }),
        },
        envWithDb,
      );
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          fromAccountId: string;
          toAccountId: string;
          status: string;
          totalCount: number;
        };
      };

      expect(res.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('mig-new');
      expect(body.data.status).toBe('in_progress');
      expect(body.data.totalCount).toBe(50);
      expect(mockedCreateAccountMigration).toHaveBeenCalledWith(mockDb, {
        fromAccountId: 'acct-from',
        toAccountId: 'acct-to',
        totalCount: 50,
      });
      expect(mockedUpdateAccountMigration).toHaveBeenCalledWith(mockDb, 'mig-new', {
        status: 'in_progress',
      });
    });

    it('returns 400 when toAccountId is missing', async () => {
      const res = await app.request(
        '/api/accounts/acct-1/migrate',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toBe('toAccountId is required');
    });

    it('returns 500 on error', async () => {
      const mockDb = createMockDb();
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(async () => ({ count: 0 })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      mockedCreateAccountMigration.mockRejectedValueOnce(new Error('DB error'));

      const res = await app.request(
        '/api/accounts/acct-1/migrate',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ toAccountId: 'acct-2' }),
        },
        { ...env, DB: mockDb },
      );
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('requires authentication', async () => {
      const res = await app.request(
        '/api/accounts/acct-1/migrate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toAccountId: 'acct-2' }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/accounts/migrations/:migrationId
  // =========================================================================

  describe('GET /api/accounts/migrations/:migrationId', () => {
    it('returns migration details when found', async () => {
      mockedGetAccountMigrationById.mockResolvedValueOnce({
        id: 'mig-42',
        from_account_id: 'acct-x',
        to_account_id: 'acct-y',
        status: 'in_progress',
        migrated_count: 30,
        total_count: 100,
        created_at: '2026-04-01T00:00:00Z',
        completed_at: null,
      });

      const res = await app.request('/api/accounts/migrations/mig-42', { headers: authHeaders() }, env);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          fromAccountId: string;
          toAccountId: string;
          status: string;
          migratedCount: number;
          totalCount: number;
          completedAt: string | null;
        };
      };

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('mig-42');
      expect(body.data.fromAccountId).toBe('acct-x');
      expect(body.data.status).toBe('in_progress');
      expect(body.data.migratedCount).toBe(30);
      expect(body.data.totalCount).toBe(100);
      expect(body.data.completedAt).toBeNull();
    });

    it('returns 404 when migration not found', async () => {
      mockedGetAccountMigrationById.mockResolvedValueOnce(null);

      const res = await app.request('/api/accounts/migrations/mig-nonexist', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(404);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Migration not found');
    });

    it('returns 500 on error', async () => {
      mockedGetAccountMigrationById.mockRejectedValueOnce(new Error('DB error'));

      const res = await app.request('/api/accounts/migrations/mig-err', { headers: authHeaders() }, env);
      const body = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('requires authentication', async () => {
      const res = await app.request('/api/accounts/migrations/mig-1', {}, env);
      expect(res.status).toBe(401);
    });
  });
});
