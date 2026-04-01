/**
 * Tests for scoring routes.
 *
 * Covers:
 *   1. GET /api/scoring-rules — list all scoring rules
 *   2. GET /api/scoring-rules/:id — get single scoring rule
 *   3. GET /api/scoring-rules/:id — 404 when not found
 *   4. POST /api/scoring-rules — create a scoring rule
 *   5. POST /api/scoring-rules — 400 when missing required fields
 *   6. PUT /api/scoring-rules/:id — update a scoring rule
 *   7. PUT /api/scoring-rules/:id — 404 when not found after update
 *   8. DELETE /api/scoring-rules/:id — delete a scoring rule
 *   9. GET /api/friends/:id/score — get friend score and history
 *  10. POST /api/friends/:id/score — add manual score
 *  11. POST /api/friends/:id/score — 400 when missing scoreChange
 *  12. Error handling — 500 on DB errors for each endpoint
 *  13. Auth — 401 without Bearer token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_RULE = {
  id: 'rule-1',
  name: 'Message Open',
  event_type: 'message_open',
  score_value: 10,
  is_active: 1,
  created_at: '2025-01-01T00:00:00+09:00',
  updated_at: '2025-01-01T00:00:00+09:00',
};

const MOCK_SCORE_HISTORY = [
  {
    id: 'sh-1',
    friend_id: 'friend-1',
    scoring_rule_id: 'rule-1',
    score_change: 10,
    reason: 'message_open',
    created_at: '2025-01-01T00:00:00+09:00',
  },
];

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getScoringRules: vi.fn(),
    getScoringRuleById: vi.fn(),
    createScoringRule: vi.fn(),
    updateScoringRule: vi.fn(),
    deleteScoringRule: vi.fn(),
    getFriendScore: vi.fn(),
    getFriendScoreHistory: vi.fn(),
    addScore: vi.fn(),
    // Auth middleware stubs
    getStaffByApiKey: vi.fn(async () => null),
    // Stubs to prevent import errors from other routes
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
      id: 'mig-1',
      from_account_id: 'acct-1',
      to_account_id: 'acct-2',
      status: 'pending',
      total_count: 0,
      created_at: new Date().toISOString(),
    })),
    updateAccountMigration: vi.fn(async () => ({})),
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  getScoringRules,
  getScoringRuleById,
  createScoringRule,
  updateScoringRule,
  deleteScoringRule,
  getFriendScore,
  getFriendScoreHistory,
  addScore,
} from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { scoring } from '../routes/scoring.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', scoring);
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

describe('Scoring Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Auth check
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/scoring-rules', {}, env);
      expect(res.status).toBe(401);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // GET /api/scoring-rules
  // =========================================================================

  describe('GET /api/scoring-rules', () => {
    it('returns list of scoring rules', async () => {
      vi.mocked(getScoringRules).mockResolvedValue([MOCK_RULE]);

      const res = await app.request(
        '/api/scoring-rules',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          name: string;
          eventType: string;
          scoreValue: number;
          isActive: boolean;
        }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].id).toBe('rule-1');
      expect(json.data[0].name).toBe('Message Open');
      expect(json.data[0].eventType).toBe('message_open');
      expect(json.data[0].scoreValue).toBe(10);
      expect(json.data[0].isActive).toBe(true);
    });

    it('returns empty array when no rules exist', async () => {
      vi.mocked(getScoringRules).mockResolvedValue([]);

      const res = await app.request(
        '/api/scoring-rules',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getScoringRules).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/scoring-rules',
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
  // GET /api/scoring-rules/:id
  // =========================================================================

  describe('GET /api/scoring-rules/:id', () => {
    it('returns a single scoring rule', async () => {
      vi.mocked(getScoringRuleById).mockResolvedValue(MOCK_RULE);

      const res = await app.request(
        '/api/scoring-rules/rule-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; eventType: string; scoreValue: number; isActive: boolean };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rule-1');
      expect(json.data.eventType).toBe('message_open');
      expect(json.data.isActive).toBe(true);
    });

    it('returns 404 when rule not found', async () => {
      vi.mocked(getScoringRuleById).mockResolvedValue(null);

      const res = await app.request(
        '/api/scoring-rules/nonexistent',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getScoringRuleById).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/scoring-rules/rule-1',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // POST /api/scoring-rules
  // =========================================================================

  describe('POST /api/scoring-rules', () => {
    it('creates a scoring rule', async () => {
      vi.mocked(createScoringRule).mockResolvedValue(MOCK_RULE);

      const res = await app.request(
        '/api/scoring-rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Message Open', eventType: 'message_open', scoreValue: 10 }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; eventType: string; scoreValue: number };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rule-1');
      expect(json.data.name).toBe('Message Open');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/scoring-rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventType: 'message_open', scoreValue: 10 }),
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
        '/api/scoring-rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', scoreValue: 10 }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });

    it('returns 400 when scoreValue is missing', async () => {
      const res = await app.request(
        '/api/scoring-rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', eventType: 'message_open' }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(createScoringRule).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/scoring-rules',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', eventType: 'message_open', scoreValue: 5 }),
        },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // PUT /api/scoring-rules/:id
  // =========================================================================

  describe('PUT /api/scoring-rules/:id', () => {
    it('updates a scoring rule', async () => {
      const updatedRule = { ...MOCK_RULE, name: 'Updated Rule', score_value: 20 };
      vi.mocked(updateScoringRule).mockResolvedValue(undefined);
      vi.mocked(getScoringRuleById).mockResolvedValue(updatedRule);

      const res = await app.request(
        '/api/scoring-rules/rule-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Rule', scoreValue: 20 }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; scoreValue: number; isActive: boolean };
      };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated Rule');
      expect(json.data.scoreValue).toBe(20);
    });

    it('returns 404 when rule not found after update', async () => {
      vi.mocked(updateScoringRule).mockResolvedValue(undefined);
      vi.mocked(getScoringRuleById).mockResolvedValue(null);

      const res = await app.request(
        '/api/scoring-rules/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test' }),
        },
        env,
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(updateScoringRule).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/scoring-rules/rule-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test' }),
        },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // DELETE /api/scoring-rules/:id
  // =========================================================================

  describe('DELETE /api/scoring-rules/:id', () => {
    it('deletes a scoring rule', async () => {
      vi.mocked(deleteScoringRule).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/scoring-rules/rule-1',
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
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(deleteScoringRule).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/scoring-rules/rule-1',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // GET /api/friends/:id/score
  // =========================================================================

  describe('GET /api/friends/:id/score', () => {
    it('returns friend score and history', async () => {
      vi.mocked(getFriendScore).mockResolvedValue(25);
      vi.mocked(getFriendScoreHistory).mockResolvedValue(MOCK_SCORE_HISTORY);

      const res = await app.request(
        '/api/friends/friend-1/score',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          friendId: string;
          currentScore: number;
          history: Array<{
            id: string;
            scoringRuleId: string;
            scoreChange: number;
            reason: string;
            createdAt: string;
          }>;
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.friendId).toBe('friend-1');
      expect(json.data.currentScore).toBe(25);
      expect(json.data.history).toHaveLength(1);
      expect(json.data.history[0].scoringRuleId).toBe('rule-1');
      expect(json.data.history[0].scoreChange).toBe(10);
    });

    it('returns zero score when no history exists', async () => {
      vi.mocked(getFriendScore).mockResolvedValue(0);
      vi.mocked(getFriendScoreHistory).mockResolvedValue([]);

      const res = await app.request(
        '/api/friends/friend-2/score',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { friendId: string; currentScore: number; history: unknown[] };
      };
      expect(json.success).toBe(true);
      expect(json.data.currentScore).toBe(0);
      expect(json.data.history).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getFriendScore).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/friends/friend-1/score',
        { headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // POST /api/friends/:id/score
  // =========================================================================

  describe('POST /api/friends/:id/score', () => {
    it('adds manual score', async () => {
      vi.mocked(addScore).mockResolvedValue(undefined);
      vi.mocked(getFriendScore).mockResolvedValue(35);

      const res = await app.request(
        '/api/friends/friend-1/score',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ scoreChange: 10, reason: 'manual adjustment' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: { friendId: string; currentScore: number };
      };
      expect(json.success).toBe(true);
      expect(json.data.friendId).toBe('friend-1');
      expect(json.data.currentScore).toBe(35);
      expect(addScore).toHaveBeenCalledWith(env.DB, {
        friendId: 'friend-1',
        scoreChange: 10,
        reason: 'manual adjustment',
      });
    });

    it('adds score without optional reason', async () => {
      vi.mocked(addScore).mockResolvedValue(undefined);
      vi.mocked(getFriendScore).mockResolvedValue(10);

      const res = await app.request(
        '/api/friends/friend-1/score',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ scoreChange: 10 }),
        },
        env,
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: { friendId: string; currentScore: number };
      };
      expect(json.success).toBe(true);
    });

    it('returns 400 when scoreChange is missing', async () => {
      const res = await app.request(
        '/api/friends/friend-1/score',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'no score change' }),
        },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('scoreChange');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(addScore).mockRejectedValue(new Error('DB fail'));

      const res = await app.request(
        '/api/friends/friend-1/score',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ scoreChange: 5 }),
        },
        env,
      );
      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });
});
