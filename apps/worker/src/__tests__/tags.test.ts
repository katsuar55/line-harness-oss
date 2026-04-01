/**
 * Tests for tags route (/api/tags).
 *
 * Covers:
 *   1. Authentication: 401 without valid Bearer token
 *   2. GET /api/tags — list all tags
 *   3. POST /api/tags — create tag (success, validation error, internal error)
 *   4. DELETE /api/tags/:id — delete tag (success, internal error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getStaffByApiKey: vi.fn(async () => null),
    getTags: vi.fn(async () => []),
    createTag: vi.fn(async () => ({
      id: 'tag-1',
      name: 'VIP',
      color: '#3B82F6',
      created_at: '2026-01-01T00:00:00+09:00',
    })),
    deleteTag: vi.fn(async () => undefined),
    // Stubs needed by other imports to prevent errors
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
    getFriendById: vi.fn(async () => null),
    getLatestRiskLevel: vi.fn(async () => 'safe'),
    getAccountHealthLogs: vi.fn(async () => []),
    getAccountMigrations: vi.fn(async () => []),
    getAccountMigrationById: vi.fn(async () => null),
    createAccountMigration: vi.fn(async () => ({})),
    updateAccountMigration: vi.fn(async () => ({})),
  };
});

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
// Import modules after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { tags } from '../routes/tags.js';
import { getTags, createTag, deleteTag } from '@line-crm/db';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', tags);
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

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tags API', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Auth guard
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.request('/api/tags', {}, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request(
        '/api/tags',
        { headers: { Authorization: 'Bearer wrong-key' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/tags
  // =========================================================================

  describe('GET /api/tags', () => {
    it('returns empty array when no tags exist', async () => {
      vi.mocked(getTags).mockResolvedValueOnce([]);

      const res = await app.request('/api/tags', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns serialized tags list', async () => {
      vi.mocked(getTags).mockResolvedValueOnce([
        { id: 'tag-1', name: 'VIP', color: '#FF0000', created_at: '2026-01-01T00:00:00+09:00' },
        { id: 'tag-2', name: 'New', color: '#00FF00', created_at: '2026-01-02T00:00:00+09:00' },
      ]);

      const res = await app.request('/api/tags', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: Array<{ id: string; name: string; color: string; createdAt: string }>;
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual({
        id: 'tag-1',
        name: 'VIP',
        color: '#FF0000',
        createdAt: '2026-01-01T00:00:00+09:00',
      });
      expect(body.data[1]).toEqual({
        id: 'tag-2',
        name: 'New',
        color: '#00FF00',
        createdAt: '2026-01-02T00:00:00+09:00',
      });
    });

    it('returns 500 when getTags throws', async () => {
      vi.mocked(getTags).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request('/api/tags', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/tags
  // =========================================================================

  describe('POST /api/tags', () => {
    it('creates a tag with name only (default color)', async () => {
      vi.mocked(createTag).mockResolvedValueOnce({
        id: 'tag-new',
        name: 'Premium',
        color: '#3B82F6',
        created_at: '2026-04-01T12:00:00+09:00',
      });

      const res = await app.request(
        '/api/tags',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Premium' }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; color: string; createdAt: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('tag-new');
      expect(body.data.name).toBe('Premium');
      expect(body.data.color).toBe('#3B82F6');
      expect(body.data.createdAt).toBe('2026-04-01T12:00:00+09:00');

      expect(createTag).toHaveBeenCalledWith(env.DB, { name: 'Premium', color: undefined });
    });

    it('creates a tag with name and custom color', async () => {
      vi.mocked(createTag).mockResolvedValueOnce({
        id: 'tag-c',
        name: 'Sale',
        color: '#EF4444',
        created_at: '2026-04-01T12:00:00+09:00',
      });

      const res = await app.request(
        '/api/tags',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Sale', color: '#EF4444' }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { color: string } };
      expect(body.data.color).toBe('#EF4444');

      expect(createTag).toHaveBeenCalledWith(env.DB, { name: 'Sale', color: '#EF4444' });
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/tags',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('name is required');
    });

    it('returns 400 when name is empty string', async () => {
      const res = await app.request(
        '/api/tags',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('name is required');
    });

    it('returns 500 when createTag throws', async () => {
      vi.mocked(createTag).mockRejectedValueOnce(new Error('DB write failure'));

      const res = await app.request(
        '/api/tags',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Broken' }),
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
  // DELETE /api/tags/:id
  // =========================================================================

  describe('DELETE /api/tags/:id', () => {
    it('deletes a tag and returns success', async () => {
      vi.mocked(deleteTag).mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/tags/tag-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();

      expect(deleteTag).toHaveBeenCalledWith(env.DB, 'tag-1');
    });

    it('returns 500 when deleteTag throws', async () => {
      vi.mocked(deleteTag).mockRejectedValueOnce(new Error('DB delete failure'));

      const res = await app.request(
        '/api/tags/tag-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });

    it('requires auth for DELETE', async () => {
      const res = await app.request('/api/tags/tag-1', { method: 'DELETE' }, env);
      expect(res.status).toBe(401);
    });
  });
});
