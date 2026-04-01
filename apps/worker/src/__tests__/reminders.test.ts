/**
 * Tests for reminders routes.
 *
 * Covers:
 *   1. GET /api/reminders — list all reminders
 *   2. GET /api/reminders?lineAccountId=xxx — filter by lineAccountId
 *   3. GET /api/reminders/:id — get reminder with steps
 *   4. GET /api/reminders/:id — 404 when not found
 *   5. POST /api/reminders — create reminder
 *   6. POST /api/reminders — 400 when name missing
 *   7. POST /api/reminders — with lineAccountId
 *   8. PUT /api/reminders/:id — update reminder
 *   9. PUT /api/reminders/:id — 404 when not found after update
 *  10. DELETE /api/reminders/:id — delete reminder
 *  11. POST /api/reminders/:id/steps — create step
 *  12. POST /api/reminders/:id/steps — 400 when required fields missing
 *  13. DELETE /api/reminders/:reminderId/steps/:stepId — delete step
 *  14. POST /api/reminders/:id/enroll/:friendId — enroll friend
 *  15. POST /api/reminders/:id/enroll/:friendId — 400 when targetDate missing
 *  16. GET /api/friends/:friendId/reminders — get friend reminders
 *  17. DELETE /api/friend-reminders/:id — cancel friend reminder
 *  18. Error handling — 500 on DB error for each endpoint
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
    getStaffByApiKey: vi.fn(async (_db: unknown, apiKey: string) => {
      if (apiKey === 'test-api-key-secret-12345') {
        return { id: 'env-owner', name: 'Owner', role: 'owner', is_active: 1, api_key: apiKey };
      }
      return null;
    }),
    getReminders: vi.fn(),
    getReminderById: vi.fn(),
    createReminder: vi.fn(),
    updateReminder: vi.fn(),
    deleteReminder: vi.fn(),
    getReminderSteps: vi.fn(),
    createReminderStep: vi.fn(),
    deleteReminderStep: vi.fn(),
    enrollFriendInReminder: vi.fn(),
    getFriendReminders: vi.fn(),
    cancelFriendReminder: vi.fn(),
    // Stubs for other routes to prevent import errors
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
      id: 'mig-1', from_account_id: 'a', to_account_id: 'b',
      status: 'pending', total_count: 0, created_at: new Date().toISOString(),
    })),
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
import { reminders as remindersRoute } from '../routes/reminders.js';
import type { Env } from '../index.js';
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getReminderSteps,
  createReminderStep,
  deleteReminderStep,
  enrollFriendInReminder,
  getFriendReminders,
  cancelFriendReminder,
} from '@line-crm/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', remindersRoute);
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
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_REMINDER = {
  id: 'rem-1',
  name: 'Purchase Follow-up',
  description: 'Follow up after purchase',
  is_active: 1,
  created_at: '2026-01-01T00:00:00+09:00',
  updated_at: '2026-01-01T00:00:00+09:00',
};

const SAMPLE_STEP = {
  id: 'step-1',
  reminder_id: 'rem-1',
  offset_minutes: 60,
  message_type: 'text',
  message_content: 'Thank you for your purchase!',
  created_at: '2026-01-01T00:00:00+09:00',
};

const SAMPLE_FRIEND_REMINDER = {
  id: 'fr-1',
  friend_id: 'friend-1',
  reminder_id: 'rem-1',
  target_date: '2026-03-01',
  status: 'active',
  created_at: '2026-01-01T00:00:00+09:00',
  updated_at: '2026-01-01T00:00:00+09:00',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Reminders Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /api/reminders
  // =========================================================================

  describe('GET /api/reminders', () => {
    it('should return all reminders', async () => {
      vi.mocked(getReminders).mockResolvedValue([SAMPLE_REMINDER] as never);

      const res = await app.request('/api/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Array<{ id: string; name: string; isActive: boolean }> };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('rem-1');
      expect(json.data[0].name).toBe('Purchase Follow-up');
      expect(json.data[0].isActive).toBe(true);
    });

    it('should filter by lineAccountId when query param provided', async () => {
      const mockDb = createMockDb();
      const mockAll = vi.fn(async () => ({ results: [SAMPLE_REMINDER] }));
      const mockBind = vi.fn(() => ({ all: mockAll, first: vi.fn(), run: vi.fn() }));
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: mockBind,
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true })),
      });
      const testEnv = { ...env, DB: mockDb };

      const res = await app.request('/api/reminders?lineAccountId=acct-1', { headers: authHeaders() }, testEnv);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Array<{ id: string }> };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
    });

    it('should return empty array when no reminders', async () => {
      vi.mocked(getReminders).mockResolvedValue([] as never);

      const res = await app.request('/api/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.data).toHaveLength(0);
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getReminders).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    it('should return 401 without auth', async () => {
      const res = await app.request('/api/reminders', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/reminders/:id
  // =========================================================================

  describe('GET /api/reminders/:id', () => {
    it('should return reminder with steps', async () => {
      vi.mocked(getReminderById).mockResolvedValue(SAMPLE_REMINDER as never);
      vi.mocked(getReminderSteps).mockResolvedValue([SAMPLE_STEP] as never);

      const res = await app.request('/api/reminders/rem-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; steps: Array<{ id: string; offsetMinutes: number }> };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rem-1');
      expect(json.data.steps).toHaveLength(1);
      expect(json.data.steps[0].offsetMinutes).toBe(60);
    });

    it('should return 404 when reminder not found', async () => {
      vi.mocked(getReminderById).mockResolvedValue(null as never);
      vi.mocked(getReminderSteps).mockResolvedValue([] as never);

      const res = await app.request('/api/reminders/nonexistent', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Reminder not found');
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getReminderById).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // POST /api/reminders
  // =========================================================================

  describe('POST /api/reminders', () => {
    it('should create a reminder', async () => {
      vi.mocked(createReminder).mockResolvedValue(SAMPLE_REMINDER as never);

      const res = await app.request('/api/reminders', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Purchase Follow-up', description: 'Follow up after purchase' }),
      }, env);
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: { id: string; name: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rem-1');
      expect(json.data.name).toBe('Purchase Follow-up');
    });

    it('should return 400 when name is missing', async () => {
      const res = await app.request('/api/reminders', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'No name' }),
      }, env);
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name is required');
    });

    it('should update line_account_id when lineAccountId is provided', async () => {
      vi.mocked(createReminder).mockResolvedValue(SAMPLE_REMINDER as never);

      const mockDb = createMockDb();
      const mockRun = vi.fn(async () => ({ success: true }));
      const mockBind = vi.fn(() => ({ run: mockRun, first: vi.fn(), all: vi.fn() }));
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: mockBind,
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });
      const testEnv = { ...env, DB: mockDb };

      const res = await app.request('/api/reminders', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', lineAccountId: 'acct-1' }),
      }, testEnv);
      expect(res.status).toBe(201);
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(createReminder).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // PUT /api/reminders/:id
  // =========================================================================

  describe('PUT /api/reminders/:id', () => {
    it('should update a reminder', async () => {
      vi.mocked(updateReminder).mockResolvedValue(undefined as never);
      vi.mocked(getReminderById).mockResolvedValue({ ...SAMPLE_REMINDER, name: 'Updated' } as never);

      const res = await app.request('/api/reminders/rem-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: { id: string; name: string; isActive: boolean } };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated');
      expect(json.data.isActive).toBe(true);
    });

    it('should return 404 when reminder not found after update', async () => {
      vi.mocked(updateReminder).mockResolvedValue(undefined as never);
      vi.mocked(getReminderById).mockResolvedValue(null as never);

      const res = await app.request('/api/reminders/nonexistent', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.error).toBe('Not found');
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(updateReminder).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /api/reminders/:id
  // =========================================================================

  describe('DELETE /api/reminders/:id', () => {
    it('should delete a reminder', async () => {
      vi.mocked(deleteReminder).mockResolvedValue(undefined as never);

      const res = await app.request('/api/reminders/rem-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(deleteReminder).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/reminders/:id/steps
  // =========================================================================

  describe('POST /api/reminders/:id/steps', () => {
    it('should create a reminder step', async () => {
      vi.mocked(createReminderStep).mockResolvedValue(SAMPLE_STEP as never);

      const res = await app.request('/api/reminders/rem-1/steps', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: 60, messageType: 'text', messageContent: 'Hello' }),
      }, env);
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: { id: string; reminderId: string; offsetMinutes: number } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('step-1');
      expect(json.data.reminderId).toBe('rem-1');
      expect(json.data.offsetMinutes).toBe(60);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await app.request('/api/reminders/rem-1/steps', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: 60 }),
      }, env);
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('required');
    });

    it('should return 400 when messageContent is missing', async () => {
      const res = await app.request('/api/reminders/rem-1/steps', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: 60, messageType: 'text' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(createReminderStep).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1/steps', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: 60, messageType: 'text', messageContent: 'Hello' }),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /api/reminders/:reminderId/steps/:stepId
  // =========================================================================

  describe('DELETE /api/reminders/:reminderId/steps/:stepId', () => {
    it('should delete a reminder step', async () => {
      vi.mocked(deleteReminderStep).mockResolvedValue(undefined as never);

      const res = await app.request('/api/reminders/rem-1/steps/step-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(deleteReminderStep).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1/steps/step-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // POST /api/reminders/:id/enroll/:friendId
  // =========================================================================

  describe('POST /api/reminders/:id/enroll/:friendId', () => {
    it('should enroll a friend in a reminder', async () => {
      vi.mocked(enrollFriendInReminder).mockResolvedValue(SAMPLE_FRIEND_REMINDER as never);

      const res = await app.request('/api/reminders/rem-1/enroll/friend-1', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDate: '2026-03-01' }),
      }, env);
      expect(res.status).toBe(201);

      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; friendId: string; reminderId: string; targetDate: string; status: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('fr-1');
      expect(json.data.friendId).toBe('friend-1');
      expect(json.data.reminderId).toBe('rem-1');
      expect(json.data.targetDate).toBe('2026-03-01');
      expect(json.data.status).toBe('active');
    });

    it('should return 400 when targetDate is missing', async () => {
      const res = await app.request('/api/reminders/rem-1/enroll/friend-1', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('targetDate is required');
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(enrollFriendInReminder).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/reminders/rem-1/enroll/friend-1', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDate: '2026-03-01' }),
      }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // GET /api/friends/:friendId/reminders
  // =========================================================================

  describe('GET /api/friends/:friendId/reminders', () => {
    it('should return friend reminders', async () => {
      vi.mocked(getFriendReminders).mockResolvedValue([SAMPLE_FRIEND_REMINDER] as never);

      const res = await app.request('/api/friends/friend-1/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        success: boolean;
        data: Array<{ id: string; friendId: string; status: string }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].friendId).toBe('friend-1');
      expect(json.data[0].status).toBe('active');
    });

    it('should return empty array when no friend reminders', async () => {
      vi.mocked(getFriendReminders).mockResolvedValue([] as never);

      const res = await app.request('/api/friends/friend-1/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.data).toHaveLength(0);
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(getFriendReminders).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/friends/friend-1/reminders', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);
    });
  });

  // =========================================================================
  // DELETE /api/friend-reminders/:id
  // =========================================================================

  describe('DELETE /api/friend-reminders/:id', () => {
    it('should cancel a friend reminder', async () => {
      vi.mocked(cancelFriendReminder).mockResolvedValue(undefined as never);

      const res = await app.request('/api/friend-reminders/fr-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('should return 500 on DB error', async () => {
      vi.mocked(cancelFriendReminder).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/friend-reminders/fr-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(500);
    });
  });
});
