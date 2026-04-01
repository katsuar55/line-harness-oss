/**
 * Tests for friends routes (/api/friends/*).
 *
 * Covers:
 *   1. Authentication — 401 without valid Bearer token
 *   2. GET /api/friends — list friends with pagination
 *   3. GET /api/friends/count — friend count (with/without lineAccountId)
 *   4. GET /api/friends/ref-stats — referral code stats
 *   5. GET /api/friends/:id — single friend (found / not found)
 *   6. POST /api/friends/:id/tags — add tag to friend
 *   7. DELETE /api/friends/:id/tags/:tagId — remove tag from friend
 *   8. PUT /api/friends/:id/metadata — merge metadata
 *   9. GET /api/friends/:id/messages — message history
 *  10. POST /api/friends/:id/messages — send message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — vi.mock is hoisted; avoid referencing top-level vars
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getFriends: vi.fn(),
    getFriendById: vi.fn(),
    getFriendCount: vi.fn(),
    addTagToFriend: vi.fn(),
    removeTagFromFriend: vi.fn(),
    getFriendTags: vi.fn(),
    getScenarios: vi.fn(),
    enrollFriendInScenario: vi.fn(),
    jstNow: vi.fn(() => '2025-06-01T12:00:00+09:00'),
    getLineAccountById: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
  };
});

// Mock event-bus
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(async () => {}),
}));

// Mock step-delivery
vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((_type: string, content: string) => ({ type: 'text', text: content })),
  processStepDeliveries: vi.fn(async () => {}),
}));

// Mock auto-track
vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db: unknown, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));

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
// Import after mocks — pull out mocked functions via the module reference
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { friends } from '../routes/friends.js';
import type { Env } from '../index.js';
import {
  getFriendById,
  getFriendCount,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
} from '@line-crm/db';

// Cast mocked functions for assertion usage
const mockGetFriendById = getFriendById as ReturnType<typeof vi.fn>;
const mockGetFriendCount = getFriendCount as ReturnType<typeof vi.fn>;
const mockAddTagToFriend = addTagToFriend as ReturnType<typeof vi.fn>;
const mockRemoveTagFromFriend = removeTagFromFriend as ReturnType<typeof vi.fn>;
const mockGetFriendTags = getFriendTags as ReturnType<typeof vi.fn>;
const mockGetScenarios = getScenarios as ReturnType<typeof vi.fn>;
const mockEnrollFriendInScenario = enrollFriendInScenario as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const FRIEND_ROW = {
  id: 'friend-1',
  line_user_id: 'U1234567890abcdef',
  display_name: 'Taro',
  picture_url: 'https://example.com/pic.jpg',
  status_message: 'Hello',
  is_following: 1,
  user_id: null,
  line_account_id: null,
  metadata: '{"plan":"free"}',
  ref_code: null,
  created_at: '2025-01-01T00:00:00+09:00',
  updated_at: '2025-01-01T00:00:00+09:00',
};

const TAG_ROW = {
  id: 'tag-1',
  name: 'VIP',
  color: '#ff0000',
  created_at: '2025-01-01T00:00:00+09:00',
};

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', friends);
  return app;
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn((..._args: unknown[]) => ({
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

function authHeaders() {
  return { headers: { Authorization: `Bearer ${TEST_API_KEY}` } };
}

function jsonHeaders() {
  return {
    headers: {
      Authorization: `Bearer ${TEST_API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Friends Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();

    // Default mock returns
    mockGetFriendById.mockResolvedValue(null);
    mockGetFriendCount.mockResolvedValue(0);
    mockGetFriendTags.mockResolvedValue([]);
    mockGetScenarios.mockResolvedValue([]);
    mockAddTagToFriend.mockResolvedValue(undefined);
    mockRemoveTagFromFriend.mockResolvedValue(undefined);
    mockEnrollFriendInScenario.mockResolvedValue(undefined);
  });

  // =========================================================================
  // Auth guard
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await app.request('/api/friends', {}, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request(
        '/api/friends',
        { headers: { Authorization: 'Bearer wrong-token' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/friends
  // =========================================================================

  describe('GET /api/friends', () => {
    it('returns paginated friend list', async () => {
      const db = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };

      const countFirst = vi.fn(async () => ({ count: 1 }));
      const listAll = vi.fn(async () => ({ results: [FRIEND_ROW] }));

      let callCount = 0;
      db.prepare = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return {
            bind: vi.fn(() => ({ first: countFirst, all: vi.fn(), run: vi.fn() })),
            first: countFirst,
            all: vi.fn(),
            run: vi.fn(),
          };
        }
        return {
          bind: vi.fn(() => ({ first: vi.fn(), all: listAll, run: vi.fn() })),
          first: vi.fn(),
          all: listAll,
          run: vi.fn(),
        };
      });

      mockGetFriendTags.mockResolvedValue([TAG_ROW]);

      const res = await app.request('/api/friends', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: {
          items: unknown[];
          total: number;
          page: number;
          limit: number;
          hasNextPage: boolean;
        };
      };
      expect(body.success).toBe(true);
      expect(body.data.total).toBe(1);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.page).toBe(1);
      expect(body.data.hasNextPage).toBe(false);

      const item = body.data.items[0] as Record<string, unknown>;
      expect(item.lineUserId).toBe('U1234567890abcdef');
      expect(item.displayName).toBe('Taro');
      expect((item.tags as unknown[]).length).toBe(1);
    });

    it('returns empty list when no friends exist', async () => {
      const countFirst = vi.fn(async () => ({ count: 0 }));
      const listAll = vi.fn(async () => ({ results: [] }));

      let callCount = 0;
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return {
            bind: vi.fn(() => ({ first: countFirst, all: vi.fn(), run: vi.fn() })),
            first: countFirst,
          };
        }
        return {
          bind: vi.fn(() => ({ first: vi.fn(), all: listAll, run: vi.fn() })),
          all: listAll,
        };
      });

      const res = await app.request('/api/friends', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: { items: unknown[]; total: number } };
      expect(body.data.items).toHaveLength(0);
      expect(body.data.total).toBe(0);
    });
  });

  // =========================================================================
  // GET /api/friends/count
  // =========================================================================

  describe('GET /api/friends/count', () => {
    it('returns friend count', async () => {
      mockGetFriendCount.mockResolvedValue(42);

      const res = await app.request('/api/friends/count', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: { count: number } };
      expect(body.success).toBe(true);
      expect(body.data.count).toBe(42);
    });

    it('returns count filtered by lineAccountId', async () => {
      const first = vi.fn(async () => ({ count: 10 }));
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
        bind: vi.fn(() => ({ first })),
        first,
      }));

      const res = await app.request('/api/friends/count?lineAccountId=acct-1', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: { count: number } };
      expect(body.data.count).toBe(10);
    });
  });

  // =========================================================================
  // GET /api/friends/ref-stats
  // =========================================================================

  describe('GET /api/friends/ref-stats', () => {
    it('returns referral stats', async () => {
      const allResult = vi.fn(async () => ({
        results: [{ ref_code: 'REF001', count: 5 }],
      }));
      const totalFirst = vi.fn(async () => ({ count: 5 }));

      let callCount = 0;
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return {
            bind: vi.fn().mockReturnThis(),
            all: allResult,
          };
        }
        return {
          bind: vi.fn().mockReturnThis(),
          first: totalFirst,
        };
      });

      const res = await app.request('/api/friends/ref-stats', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { routes: { refCode: string; friendCount: number }[]; totalWithRef: number };
      };
      expect(body.success).toBe(true);
      expect(body.data.routes).toHaveLength(1);
      expect(body.data.routes[0].refCode).toBe('REF001');
      expect(body.data.totalWithRef).toBe(5);
    });
  });

  // =========================================================================
  // GET /api/friends/:id
  // =========================================================================

  describe('GET /api/friends/:id', () => {
    it('returns friend with tags when found', async () => {
      mockGetFriendById.mockResolvedValue(FRIEND_ROW);
      mockGetFriendTags.mockResolvedValue([TAG_ROW]);

      const res = await app.request('/api/friends/friend-1', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; displayName: string; tags: unknown[] };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('friend-1');
      expect(body.data.displayName).toBe('Taro');
      expect(body.data.tags).toHaveLength(1);
    });

    it('returns 404 when friend not found', async () => {
      mockGetFriendById.mockResolvedValue(null);

      const res = await app.request('/api/friends/nonexistent', authHeaders(), env);
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Friend not found');
    });
  });

  // =========================================================================
  // POST /api/friends/:id/tags
  // =========================================================================

  describe('POST /api/friends/:id/tags', () => {
    it('adds tag and returns 201', async () => {
      mockGetScenarios.mockResolvedValue([]);

      const res = await app.request(
        '/api/friends/friend-1/tags',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({ tagId: 'tag-1' }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
      expect(mockAddTagToFriend).toHaveBeenCalledWith(env.DB, 'friend-1', 'tag-1');
    });

    it('returns 400 when tagId is missing', async () => {
      const res = await app.request(
        '/api/friends/friend-1/tags',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('tagId is required');
    });

    it('enrolls friend in matching tag_added scenario', async () => {
      const scenario = {
        id: 'scenario-1',
        trigger_type: 'tag_added',
        is_active: 1,
        trigger_tag_id: 'tag-1',
      };
      mockGetScenarios.mockResolvedValue([scenario]);

      // Mock: no existing enrollment
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const res = await app.request(
        '/api/friends/friend-1/tags',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({ tagId: 'tag-1' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(mockEnrollFriendInScenario).toHaveBeenCalledWith(env.DB, 'friend-1', 'scenario-1');
    });
  });

  // =========================================================================
  // DELETE /api/friends/:id/tags/:tagId
  // =========================================================================

  describe('DELETE /api/friends/:id/tags/:tagId', () => {
    it('removes tag and returns success', async () => {
      const res = await app.request(
        '/api/friends/friend-1/tags/tag-1',
        { method: 'DELETE', ...authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
      expect(mockRemoveTagFromFriend).toHaveBeenCalledWith(env.DB, 'friend-1', 'tag-1');
    });
  });

  // =========================================================================
  // PUT /api/friends/:id/metadata
  // =========================================================================

  describe('PUT /api/friends/:id/metadata', () => {
    it('merges metadata and returns updated friend', async () => {
      const updatedRow = {
        ...FRIEND_ROW,
        metadata: '{"plan":"free","level":"gold"}',
      };
      mockGetFriendById
        .mockResolvedValueOnce(FRIEND_ROW) // first call: check existence
        .mockResolvedValueOnce(updatedRow); // second call: return updated
      mockGetFriendTags.mockResolvedValue([]);

      // Mock DB prepare for the UPDATE statement
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const res = await app.request(
        '/api/friends/friend-1/metadata',
        {
          method: 'PUT',
          ...jsonHeaders(),
          body: JSON.stringify({ level: 'gold' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; metadata: Record<string, unknown> };
      };
      expect(body.success).toBe(true);
      expect(body.data.metadata).toEqual({ plan: 'free', level: 'gold' });
    });

    it('returns 404 when friend not found', async () => {
      mockGetFriendById.mockResolvedValue(null);

      const res = await app.request(
        '/api/friends/nonexistent/metadata',
        {
          method: 'PUT',
          ...jsonHeaders(),
          body: JSON.stringify({ key: 'value' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('Friend not found');
    });
  });

  // =========================================================================
  // GET /api/friends/:id/messages
  // =========================================================================

  describe('GET /api/friends/:id/messages', () => {
    it('returns message history', async () => {
      const messages = [
        {
          id: 'msg-1',
          direction: 'incoming',
          messageType: 'text',
          content: 'Hello',
          createdAt: '2025-01-01T00:00:00+09:00',
        },
      ];

      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: messages })),
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: messages })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const res = await app.request('/api/friends/friend-1/messages', authHeaders(), env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });
  });

  // =========================================================================
  // POST /api/friends/:id/messages
  // =========================================================================

  describe('POST /api/friends/:id/messages', () => {
    it('sends message and returns messageId', async () => {
      mockGetFriendById.mockResolvedValue(FRIEND_ROW);

      // Mock DB for the INSERT log
      (env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      }));

      const res = await app.request(
        '/api/friends/friend-1/messages',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({ content: 'Hi there!' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: { messageId: string } };
      expect(body.success).toBe(true);
      expect(body.data.messageId).toBeDefined();
    });

    it('returns 400 when content is missing', async () => {
      const res = await app.request(
        '/api/friends/friend-1/messages',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('content is required');
    });

    it('returns 404 when friend not found', async () => {
      mockGetFriendById.mockResolvedValue(null);

      const res = await app.request(
        '/api/friends/nonexistent/messages',
        {
          method: 'POST',
          ...jsonHeaders(),
          body: JSON.stringify({ content: 'Hello' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('Friend not found');
    });
  });
});
