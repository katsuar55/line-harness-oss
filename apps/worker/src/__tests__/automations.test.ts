/**
 * Tests for automations routes.
 *
 * Covers:
 *   1. Authentication — 401 without Bearer token
 *   2. GET /api/automations — list automations
 *   3. GET /api/automations?lineAccountId=xxx — filter by line account
 *   4. POST /api/automations — create automation (success)
 *   5. POST /api/automations — validation error (missing fields)
 *   6. POST /api/automations — with lineAccountId
 *   7. GET /api/automations/:id — get single automation with logs
 *   8. GET /api/automations/:id — 404 when not found
 *   9. PUT /api/automations/:id — update automation
 *  10. PUT /api/automations/:id — 404 when not found after update
 *  11. DELETE /api/automations/:id — delete automation
 *  12. GET /api/automations/:id/logs — get automation logs
 *  13. GET /api/automations/:id/logs?limit=10 — logs with custom limit
 *  14. Error handling — 500 on DB failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getStaffByApiKey: vi.fn(async () => null),
    getAutomations: vi.fn(async () => []),
    getAutomationById: vi.fn(async () => null),
    createAutomation: vi.fn(async () => ({
      id: 'auto-1',
      name: 'Test Automation',
      description: null,
      event_type: 'friend_add',
      conditions: '{}',
      actions: '[{"type":"send_message","message":"Welcome!"}]',
      line_account_id: null,
      is_active: 1,
      priority: 0,
      created_at: '2026-01-01T00:00:00+09:00',
      updated_at: '2026-01-01T00:00:00+09:00',
    })),
    updateAutomation: vi.fn(async () => undefined),
    deleteAutomation: vi.fn(async () => undefined),
    getAutomationLogs: vi.fn(async () => []),
    // Stubs needed by other imports
    getLineAccounts: vi.fn(async () => []),
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
import { automations } from '../routes/automations.js';
import type { Env } from '../index.js';
import {
  getAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
} from '@line-crm/db';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', automations);
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

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// Sample automation row for reuse
const sampleAutomation = {
  id: 'auto-1',
  name: 'Welcome Automation',
  description: 'Send welcome message on friend add',
  event_type: 'friend_add',
  conditions: '{"tag":"new"}',
  actions: '[{"type":"send_message","message":"Welcome!"}]',
  line_account_id: null,
  is_active: 1,
  priority: 10,
  created_at: '2026-01-01T00:00:00+09:00',
  updated_at: '2026-01-01T00:00:00+09:00',
};

const sampleLog = {
  id: 'log-1',
  automation_id: 'auto-1',
  friend_id: 'friend-1',
  event_data: '{"source":"webhook"}',
  actions_result: '{"sent":true}',
  status: 'success',
  created_at: '2026-01-02T00:00:00+09:00',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Automations Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Authentication
  // =========================================================================

  describe('Authentication', () => {
    it('should return 401 without Authorization header', async () => {
      const res = await app.request('/api/automations', {}, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 with invalid token', async () => {
      const res = await app.request(
        '/api/automations',
        { headers: { Authorization: 'Bearer wrong-token' } },
        env,
      );
      expect(res.status).toBe(401);
    });

    it('should return 401 without Bearer prefix', async () => {
      const res = await app.request(
        '/api/automations',
        { headers: { Authorization: TEST_API_KEY } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 2. GET /api/automations
  // =========================================================================

  describe('GET /api/automations', () => {
    it('should return empty list when no automations exist', async () => {
      vi.mocked(getAutomations).mockResolvedValueOnce([]);

      const res = await app.request(
        '/api/automations',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('should return automations list with parsed JSON fields', async () => {
      vi.mocked(getAutomations).mockResolvedValueOnce([sampleAutomation]);

      const res = await app.request(
        '/api/automations',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ id: string; name: string; eventType: string; conditions: unknown; actions: unknown; isActive: boolean; priority: number }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('auto-1');
      expect(body.data[0].name).toBe('Welcome Automation');
      expect(body.data[0].eventType).toBe('friend_add');
      expect(body.data[0].conditions).toEqual({ tag: 'new' });
      expect(body.data[0].actions).toEqual([{ type: 'send_message', message: 'Welcome!' }]);
      expect(body.data[0].isActive).toBe(true);
      expect(body.data[0].priority).toBe(10);
    });

    it('should filter by lineAccountId when query param is provided', async () => {
      // When lineAccountId is provided, the route uses raw DB query instead of getAutomations
      const mockPrepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [sampleAutomation] })),
        })),
      }));
      env.DB = { ...env.DB, prepare: mockPrepare } as unknown as D1Database;

      const res = await app.request(
        '/api/automations?lineAccountId=acct-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getAutomations).mockRejectedValueOnce(new Error('DB connection lost'));

      const res = await app.request(
        '/api/automations',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // 3. POST /api/automations
  // =========================================================================

  describe('POST /api/automations', () => {
    it('should create an automation successfully', async () => {
      const created = {
        ...sampleAutomation,
        id: 'auto-new',
        description: null,
      };
      vi.mocked(createAutomation).mockResolvedValueOnce(created);

      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Welcome Automation',
            eventType: 'friend_add',
            actions: [{ type: 'send_message', message: 'Welcome!' }],
          }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; name: string; eventType: string } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('auto-new');
      expect(body.data.name).toBe('Welcome Automation');
      expect(body.data.eventType).toBe('friend_add');
    });

    it('should return 400 when name is missing', async () => {
      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventType: 'friend_add',
            actions: [{ type: 'send_message' }],
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('required');
    });

    it('should return 400 when eventType is missing', async () => {
      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test',
            actions: [{ type: 'send_message' }],
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('should return 400 when actions is missing', async () => {
      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test',
            eventType: 'friend_add',
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('should save lineAccountId when provided', async () => {
      const created = { ...sampleAutomation, id: 'auto-la' };
      vi.mocked(createAutomation).mockResolvedValueOnce(created);

      const mockRun = vi.fn(async () => ({ success: true }));
      const mockBind = vi.fn(() => ({ run: mockRun }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind }));
      env.DB = { ...env.DB, prepare: mockPrepare } as unknown as D1Database;

      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Account Specific',
            eventType: 'message_received',
            actions: [{ type: 'reply' }],
            lineAccountId: 'acct-1',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);
      // Verify the UPDATE query was called to set line_account_id
      expect(mockPrepare).toHaveBeenCalled();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(createAutomation).mockRejectedValueOnce(new Error('Insert failed'));

      const res = await app.request(
        '/api/automations',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Fail',
            eventType: 'friend_add',
            actions: [{ type: 'noop' }],
          }),
        },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });
  });

  // =========================================================================
  // 4. GET /api/automations/:id
  // =========================================================================

  describe('GET /api/automations/:id', () => {
    it('should return automation with logs', async () => {
      vi.mocked(getAutomationById).mockResolvedValueOnce(sampleAutomation);
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([sampleLog]);

      const res = await app.request(
        '/api/automations/auto-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          name: string;
          conditions: unknown;
          actions: unknown;
          isActive: boolean;
          logs: Array<{ id: string; friendId: string; eventData: unknown; actionsResult: unknown; status: string }>;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('auto-1');
      expect(body.data.name).toBe('Welcome Automation');
      expect(body.data.conditions).toEqual({ tag: 'new' });
      expect(body.data.actions).toEqual([{ type: 'send_message', message: 'Welcome!' }]);
      expect(body.data.isActive).toBe(true);
      expect(body.data.logs).toHaveLength(1);
      expect(body.data.logs[0].friendId).toBe('friend-1');
      expect(body.data.logs[0].eventData).toEqual({ source: 'webhook' });
      expect(body.data.logs[0].actionsResult).toEqual({ sent: true });
      expect(body.data.logs[0].status).toBe('success');
    });

    it('should return 404 when automation not found', async () => {
      vi.mocked(getAutomationById).mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/automations/nonexistent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Automation not found');
    });

    it('should handle logs with null event_data and actions_result', async () => {
      vi.mocked(getAutomationById).mockResolvedValueOnce(sampleAutomation);
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([
        { ...sampleLog, event_data: null, actions_result: null },
      ]);

      const res = await app.request(
        '/api/automations/auto-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { logs: Array<{ eventData: unknown; actionsResult: unknown }> } };
      expect(body.data.logs[0].eventData).toBeNull();
      expect(body.data.logs[0].actionsResult).toBeNull();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getAutomationById).mockRejectedValueOnce(new Error('DB read fail'));

      const res = await app.request(
        '/api/automations/auto-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // 5. PUT /api/automations/:id
  // =========================================================================

  describe('PUT /api/automations/:id', () => {
    it('should update automation and return updated data', async () => {
      const updated = { ...sampleAutomation, name: 'Updated Name', is_active: 0 };
      vi.mocked(updateAutomation).mockResolvedValueOnce(undefined);
      vi.mocked(getAutomationById).mockResolvedValueOnce(updated);

      const res = await app.request(
        '/api/automations/auto-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Name', isActive: false }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; name: string; isActive: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Updated Name');
      expect(body.data.isActive).toBe(false);
    });

    it('should return 404 when automation not found after update', async () => {
      vi.mocked(updateAutomation).mockResolvedValueOnce(undefined);
      vi.mocked(getAutomationById).mockResolvedValueOnce(null);

      const res = await app.request(
        '/api/automations/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Name' }),
        },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Not found');
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(updateAutomation).mockRejectedValueOnce(new Error('Update fail'));

      const res = await app.request(
        '/api/automations/auto-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Fail' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // 6. DELETE /api/automations/:id
  // =========================================================================

  describe('DELETE /api/automations/:id', () => {
    it('should delete automation and return success', async () => {
      vi.mocked(deleteAutomation).mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/automations/auto-1',
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
    });

    it('should call deleteAutomation with correct id', async () => {
      vi.mocked(deleteAutomation).mockResolvedValueOnce(undefined);

      await app.request(
        '/api/automations/auto-xyz',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );
      expect(deleteAutomation).toHaveBeenCalledWith(env.DB, 'auto-xyz');
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(deleteAutomation).mockRejectedValueOnce(new Error('Delete fail'));

      const res = await app.request(
        '/api/automations/auto-1',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // 7. GET /api/automations/:id/logs
  // =========================================================================

  describe('GET /api/automations/:id/logs', () => {
    it('should return automation logs', async () => {
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([sampleLog]);

      const res = await app.request(
        '/api/automations/auto-1/logs',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          automationId: string;
          friendId: string;
          eventData: unknown;
          actionsResult: unknown;
          status: string;
        }>;
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].automationId).toBe('auto-1');
      expect(body.data[0].friendId).toBe('friend-1');
      expect(body.data[0].status).toBe('success');
    });

    it('should return empty logs array', async () => {
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([]);

      const res = await app.request(
        '/api/automations/auto-1/logs',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('should pass custom limit from query param', async () => {
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([]);

      await app.request(
        '/api/automations/auto-1/logs?limit=10',
        { headers: authHeaders() },
        env,
      );
      expect(getAutomationLogs).toHaveBeenCalledWith(env.DB, 'auto-1', 10);
    });

    it('should default limit to 100 when not specified', async () => {
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([]);

      await app.request(
        '/api/automations/auto-1/logs',
        { headers: authHeaders() },
        env,
      );
      expect(getAutomationLogs).toHaveBeenCalledWith(env.DB, 'auto-1', 100);
    });

    it('should handle logs with null fields', async () => {
      vi.mocked(getAutomationLogs).mockResolvedValueOnce([
        { ...sampleLog, friend_id: null, event_data: null, actions_result: null },
      ]);

      const res = await app.request(
        '/api/automations/auto-1/logs',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ friendId: string | null; eventData: unknown; actionsResult: unknown }> };
      expect(body.data[0].friendId).toBeNull();
      expect(body.data[0].eventData).toBeNull();
      expect(body.data[0].actionsResult).toBeNull();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getAutomationLogs).mockRejectedValueOnce(new Error('Logs query fail'));

      const res = await app.request(
        '/api/automations/auto-1/logs',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });
  });
});
