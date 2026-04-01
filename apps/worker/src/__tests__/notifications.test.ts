/**
 * Tests for notifications routes.
 *
 * Covers:
 *   1. GET /api/notifications/rules — list all rules
 *   2. GET /api/notifications/rules?lineAccountId=xxx — filter by account
 *   3. GET /api/notifications/rules/:id — get single rule
 *   4. GET /api/notifications/rules/:id — 404 not found
 *   5. POST /api/notifications/rules — create rule
 *   6. POST /api/notifications/rules — 400 missing required fields
 *   7. PUT /api/notifications/rules/:id — update rule
 *   8. PUT /api/notifications/rules/:id — 404 not found after update
 *   9. DELETE /api/notifications/rules/:id — delete rule
 *   10. GET /api/notifications — list notifications (no filter)
 *   11. GET /api/notifications?status=sent — filter by status
 *   12. GET /api/notifications?lineAccountId=xxx — filter by account
 *   13. GET /api/notifications?lineAccountId=xxx&status=sent — combined filter
 *   14. Error handling — 500 on DB failure
 *   15. Auth required — 401 without token
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
    getNotificationRules: vi.fn(),
    getNotificationRuleById: vi.fn(),
    createNotificationRule: vi.fn(),
    updateNotificationRule: vi.fn(),
    deleteNotificationRule: vi.fn(),
    getNotifications: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
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

import {
  getNotificationRules,
  getNotificationRuleById,
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  getNotifications,
} from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { notifications } from '../routes/notifications.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

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
  app.route('/', notifications);
  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const RULE_1 = {
  id: 'rule-1',
  name: 'New friend alert',
  event_type: 'friend_add',
  conditions: '{"tag":"vip"}',
  channels: '["dashboard","email"]',
  line_account_id: 'acct-1',
  is_active: 1,
  created_at: '2025-01-01T00:00:00',
  updated_at: '2025-01-01T00:00:00',
};

const RULE_2 = {
  id: 'rule-2',
  name: 'Purchase alert',
  event_type: 'purchase',
  conditions: '{}',
  channels: '["dashboard"]',
  line_account_id: null,
  is_active: 0,
  created_at: '2025-01-02T00:00:00',
  updated_at: '2025-01-02T00:00:00',
};

const NOTIFICATION_1 = {
  id: 'notif-1',
  rule_id: 'rule-1',
  event_type: 'friend_add',
  title: 'New friend',
  body: 'A new friend was added',
  channel: 'dashboard',
  status: 'sent',
  metadata: '{"friendId":"usr-1"}',
  created_at: '2025-01-01T12:00:00',
};

const NOTIFICATION_2 = {
  id: 'notif-2',
  rule_id: null,
  event_type: 'purchase',
  title: 'Purchase completed',
  body: 'Order #123',
  channel: 'email',
  status: 'pending',
  metadata: null,
  created_at: '2025-01-02T12:00:00',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Notifications Routes', () => {
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

  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/api/notifications/rules', {}, env);
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // GET /api/notifications/rules
  // =========================================================================

  describe('GET /api/notifications/rules', () => {
    it('returns all rules', async () => {
      vi.mocked(getNotificationRules).mockResolvedValue([RULE_1, RULE_2]);

      const res = await app.request(
        '/api/notifications/rules',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0]).toEqual({
        id: 'rule-1',
        name: 'New friend alert',
        eventType: 'friend_add',
        conditions: { tag: 'vip' },
        channels: ['dashboard', 'email'],
        isActive: true,
        createdAt: '2025-01-01T00:00:00',
        updatedAt: '2025-01-01T00:00:00',
      });
      expect(json.data[1]).toMatchObject({ id: 'rule-2', isActive: false });
    });

    it('filters by lineAccountId via raw SQL', async () => {
      const mockAll = vi.fn(async () => ({ results: [RULE_1] }));
      const mockBind = vi.fn(() => ({ all: mockAll }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind }));
      (env.DB as unknown as { prepare: typeof mockPrepare }).prepare = mockPrepare;

      const res = await app.request(
        '/api/notifications/rules?lineAccountId=acct-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('line_account_id'),
      );
      expect(mockBind).toHaveBeenCalledWith('acct-1');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getNotificationRules).mockRejectedValue(new Error('DB down'));

      const res = await app.request(
        '/api/notifications/rules',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // GET /api/notifications/rules/:id
  // =========================================================================

  describe('GET /api/notifications/rules/:id', () => {
    it('returns a single rule', async () => {
      vi.mocked(getNotificationRuleById).mockResolvedValue(RULE_1);

      const res = await app.request(
        '/api/notifications/rules/rule-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rule-1');
      expect(json.data.eventType).toBe('friend_add');
      expect(json.data.conditions).toEqual({ tag: 'vip' });
      expect(json.data.channels).toEqual(['dashboard', 'email']);
      expect(json.data.isActive).toBe(true);
    });

    it('returns 404 when rule not found', async () => {
      vi.mocked(getNotificationRuleById).mockResolvedValue(null);

      const res = await app.request(
        '/api/notifications/rules/nonexistent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getNotificationRuleById).mockRejectedValue(new Error('fail'));

      const res = await app.request(
        '/api/notifications/rules/rule-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/notifications/rules
  // =========================================================================

  describe('POST /api/notifications/rules', () => {
    it('creates a rule and returns 201', async () => {
      const created = {
        ...RULE_1,
        id: 'new-rule',
        name: 'Test rule',
        event_type: 'message_received',
        channels: '["dashboard"]',
      };
      vi.mocked(createNotificationRule).mockResolvedValue(created);

      const res = await app.request(
        '/api/notifications/rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test rule', eventType: 'message_received' }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('new-rule');
      expect(json.data.name).toBe('Test rule');
      expect(json.data.eventType).toBe('message_received');
      expect(json.data.channels).toEqual(['dashboard']);
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/notifications/rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventType: 'friend_add' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('required');
    });

    it('returns 400 when eventType is missing', async () => {
      const res = await app.request(
        '/api/notifications/rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Rule' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(createNotificationRule).mockRejectedValue(new Error('insert fail'));

      const res = await app.request(
        '/api/notifications/rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Rule', eventType: 'friend_add' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // PUT /api/notifications/rules/:id
  // =========================================================================

  describe('PUT /api/notifications/rules/:id', () => {
    it('updates a rule', async () => {
      vi.mocked(updateNotificationRule).mockResolvedValue(undefined);
      vi.mocked(getNotificationRuleById).mockResolvedValue({
        ...RULE_1,
        name: 'Updated name',
      });

      const res = await app.request(
        '/api/notifications/rules/rule-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated name' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated name');
      expect(json.data.isActive).toBe(true);
    });

    it('returns 404 when rule not found after update', async () => {
      vi.mocked(updateNotificationRule).mockResolvedValue(undefined);
      vi.mocked(getNotificationRuleById).mockResolvedValue(null);

      const res = await app.request(
        '/api/notifications/rules/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(updateNotificationRule).mockRejectedValue(new Error('update fail'));

      const res = await app.request(
        '/api/notifications/rules/rule-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /api/notifications/rules/:id
  // =========================================================================

  describe('DELETE /api/notifications/rules/:id', () => {
    it('deletes a rule', async () => {
      vi.mocked(deleteNotificationRule).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/notifications/rules/rule-1',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(deleteNotificationRule).toHaveBeenCalledWith(env.DB, 'rule-1');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(deleteNotificationRule).mockRejectedValue(new Error('delete fail'));

      const res = await app.request(
        '/api/notifications/rules/rule-1',
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
  // GET /api/notifications
  // =========================================================================

  describe('GET /api/notifications', () => {
    it('returns all notifications without filters', async () => {
      vi.mocked(getNotifications).mockResolvedValue([NOTIFICATION_1, NOTIFICATION_2]);

      const res = await app.request(
        '/api/notifications',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0]).toEqual({
        id: 'notif-1',
        ruleId: 'rule-1',
        eventType: 'friend_add',
        title: 'New friend',
        body: 'A new friend was added',
        channel: 'dashboard',
        status: 'sent',
        metadata: { friendId: 'usr-1' },
        createdAt: '2025-01-01T12:00:00',
      });
      expect(json.data[1].metadata).toBeNull();
      expect(getNotifications).toHaveBeenCalledWith(env.DB, { status: undefined, limit: 100 });
    });

    it('filters by status', async () => {
      vi.mocked(getNotifications).mockResolvedValue([NOTIFICATION_1]);

      const res = await app.request(
        '/api/notifications?status=sent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.data).toHaveLength(1);
      expect(getNotifications).toHaveBeenCalledWith(env.DB, { status: 'sent', limit: 100 });
    });

    it('respects limit parameter', async () => {
      vi.mocked(getNotifications).mockResolvedValue([NOTIFICATION_1]);

      const res = await app.request(
        '/api/notifications?limit=5',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      expect(getNotifications).toHaveBeenCalledWith(env.DB, { status: undefined, limit: 5 });
    });

    it('filters by lineAccountId via raw SQL', async () => {
      const mockAll = vi.fn(async () => ({ results: [NOTIFICATION_1] }));
      const mockBind = vi.fn(() => ({ all: mockAll }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind }));
      (env.DB as unknown as { prepare: typeof mockPrepare }).prepare = mockPrepare;

      const res = await app.request(
        '/api/notifications?lineAccountId=acct-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(mockPrepare).toHaveBeenCalledWith(
        expect.stringContaining('line_account_id'),
      );
    });

    it('filters by lineAccountId and status combined', async () => {
      const mockAll = vi.fn(async () => ({ results: [NOTIFICATION_1] }));
      const mockBind = vi.fn(() => ({ all: mockAll }));
      const mockPrepare = vi.fn(() => ({ bind: mockBind }));
      (env.DB as unknown as { prepare: typeof mockPrepare }).prepare = mockPrepare;

      const res = await app.request(
        '/api/notifications?lineAccountId=acct-1&status=sent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      expect(mockBind).toHaveBeenCalledWith('acct-1', 'sent', 100);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getNotifications).mockRejectedValue(new Error('DB down'));

      const res = await app.request(
        '/api/notifications',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });
});
