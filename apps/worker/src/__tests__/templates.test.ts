/**
 * Tests for templates API routes.
 *
 * Covers:
 *   1. Authentication required (401 without Bearer token)
 *   2. GET /api/templates — list all templates
 *   3. GET /api/templates?category=xxx — filter by category
 *   4. GET /api/templates/:id — get single template
 *   5. GET /api/templates/:id — 404 when not found
 *   6. POST /api/templates — create template (success)
 *   7. POST /api/templates — validation error (missing fields)
 *   8. PUT /api/templates/:id — update template
 *   9. PUT /api/templates/:id — 404 when not found after update
 *   10. DELETE /api/templates/:id — delete template
 *   11. GET /api/templates — 500 on DB error
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
    getTemplates: vi.fn(async () => []),
    getTemplateById: vi.fn(async () => null),
    createTemplate: vi.fn(async () => ({
      id: 'tpl-1',
      name: 'Test Template',
      category: 'general',
      message_type: 'text',
      message_content: 'Hello',
      created_at: '2026-01-01T00:00:00+09:00',
      updated_at: '2026-01-01T00:00:00+09:00',
    })),
    updateTemplate: vi.fn(async () => undefined),
    deleteTemplate: vi.fn(async () => undefined),
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
// Import after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { templates } from '../routes/templates.js';
import type { Env } from '../index.js';
import {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from '@line-crm/db';

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-templates';

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

function createTestApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', templates);
  return app;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Templates API', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Auth
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/templates', {}, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request(
        '/api/templates',
        { headers: { Authorization: 'Bearer wrong-key' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/templates
  // =========================================================================

  describe('GET /api/templates', () => {
    it('returns empty list when no templates exist', async () => {
      vi.mocked(getTemplates).mockResolvedValueOnce([]);

      const res = await app.request('/api/templates', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
      expect(getTemplates).toHaveBeenCalledWith(env.DB, undefined);
    });

    it('returns list of templates with camelCase fields', async () => {
      vi.mocked(getTemplates).mockResolvedValueOnce([
        {
          id: 'tpl-1',
          name: 'Welcome',
          category: 'greeting',
          message_type: 'text',
          message_content: 'Hello!',
          created_at: '2026-01-01T00:00:00+09:00',
          updated_at: '2026-01-02T00:00:00+09:00',
        },
        {
          id: 'tpl-2',
          name: 'Farewell',
          category: 'general',
          message_type: 'text',
          message_content: 'Bye!',
          created_at: '2026-01-03T00:00:00+09:00',
          updated_at: '2026-01-04T00:00:00+09:00',
        },
      ]);

      const res = await app.request('/api/templates', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          name: string;
          category: string;
          messageType: string;
          messageContent: string;
          createdAt: string;
          updatedAt: string;
        }>;
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].id).toBe('tpl-1');
      expect(body.data[0].messageType).toBe('text');
      expect(body.data[0].messageContent).toBe('Hello!');
      expect(body.data[0].createdAt).toBe('2026-01-01T00:00:00+09:00');
    });

    it('passes category query parameter to getTemplates', async () => {
      vi.mocked(getTemplates).mockResolvedValueOnce([]);

      const res = await app.request(
        '/api/templates?category=greeting',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      expect(getTemplates).toHaveBeenCalledWith(env.DB, 'greeting');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getTemplates).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request('/api/templates', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // GET /api/templates/:id
  // =========================================================================

  describe('GET /api/templates/:id', () => {
    it('returns a single template by id', async () => {
      vi.mocked(getTemplateById).mockResolvedValueOnce({
        id: 'tpl-1',
        name: 'Welcome',
        category: 'greeting',
        message_type: 'text',
        message_content: 'Hello!',
        created_at: '2026-01-01T00:00:00+09:00',
        updated_at: '2026-01-02T00:00:00+09:00',
      });

      const res = await app.request('/api/templates/tpl-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; messageType: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('tpl-1');
      expect(body.data.name).toBe('Welcome');
      expect(body.data.messageType).toBe('text');
      expect(getTemplateById).toHaveBeenCalledWith(env.DB, 'tpl-1');
    });

    it('returns 404 when template not found', async () => {
      vi.mocked(getTemplateById).mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/templates/nonexistent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Template not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getTemplateById).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request('/api/templates/tpl-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/templates
  // =========================================================================

  describe('POST /api/templates', () => {
    it('creates a template successfully', async () => {
      vi.mocked(createTemplate).mockResolvedValueOnce({
        id: 'tpl-new',
        name: 'New Template',
        category: 'promo',
        message_type: 'text',
        message_content: 'Check this out!',
        created_at: '2026-01-05T00:00:00+09:00',
        updated_at: '2026-01-05T00:00:00+09:00',
      });

      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'New Template',
            category: 'promo',
            messageType: 'text',
            messageContent: 'Check this out!',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; category: string; messageType: string; createdAt: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('tpl-new');
      expect(body.data.name).toBe('New Template');
      expect(body.data.category).toBe('promo');
      expect(body.data.messageType).toBe('text');
      expect(createTemplate).toHaveBeenCalledWith(env.DB, {
        name: 'New Template',
        category: 'promo',
        messageType: 'text',
        messageContent: 'Check this out!',
      });
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageType: 'text', messageContent: 'Hello' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('required');
    });

    it('returns 400 when messageType is missing', async () => {
      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', messageContent: 'Hello' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('required');
    });

    it('returns 400 when messageContent is missing', async () => {
      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', messageType: 'text' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('required');
    });

    it('creates template without optional category', async () => {
      vi.mocked(createTemplate).mockResolvedValueOnce({
        id: 'tpl-no-cat',
        name: 'No Category',
        category: 'general',
        message_type: 'text',
        message_content: 'Hello',
        created_at: '2026-01-05T00:00:00+09:00',
        updated_at: '2026-01-05T00:00:00+09:00',
      });

      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'No Category',
            messageType: 'text',
            messageContent: 'Hello',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as { success: boolean; data: { category: string } };
      expect(body.success).toBe(true);
      expect(body.data.category).toBe('general');
    });

    it('returns 500 on DB error during creation', async () => {
      vi.mocked(createTemplate).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/templates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Fail',
            messageType: 'text',
            messageContent: 'Hello',
          }),
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
  // PUT /api/templates/:id
  // =========================================================================

  describe('PUT /api/templates/:id', () => {
    it('updates a template and returns updated data', async () => {
      vi.mocked(updateTemplate).mockResolvedValueOnce(undefined);
      vi.mocked(getTemplateById).mockResolvedValueOnce({
        id: 'tpl-1',
        name: 'Updated Name',
        category: 'updated',
        message_type: 'text',
        message_content: 'Updated content',
        created_at: '2026-01-01T00:00:00+09:00',
        updated_at: '2026-01-06T00:00:00+09:00',
      });

      const res = await app.request(
        '/api/templates/tpl-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name', category: 'updated' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; category: string; messageType: string; messageContent: string };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('tpl-1');
      expect(body.data.name).toBe('Updated Name');
      expect(body.data.category).toBe('updated');
      expect(body.data.messageContent).toBe('Updated content');
      expect(updateTemplate).toHaveBeenCalledWith(env.DB, 'tpl-1', {
        name: 'Updated Name',
        category: 'updated',
      });
    });

    it('returns 404 when template not found after update', async () => {
      vi.mocked(updateTemplate).mockResolvedValueOnce(undefined);
      vi.mocked(getTemplateById).mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/templates/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Not found');
    });

    it('returns 500 on DB error during update', async () => {
      vi.mocked(updateTemplate).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/templates/tpl-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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
  // DELETE /api/templates/:id
  // =========================================================================

  describe('DELETE /api/templates/:id', () => {
    it('deletes a template and returns success', async () => {
      vi.mocked(deleteTemplate).mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/templates/tpl-1',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
      expect(deleteTemplate).toHaveBeenCalledWith(env.DB, 'tpl-1');
    });

    it('returns 500 on DB error during delete', async () => {
      vi.mocked(deleteTemplate).mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/templates/tpl-1',
        {
          method: 'DELETE',
          headers: authHeaders(),
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
