/**
 * Tests for chats routes (operators CRUD + chats CRUD + send message + loading).
 *
 * Covers:
 *   1. Authentication: 401 without valid Bearer token
 *   2. GET  /api/operators        — list operators
 *   3. POST /api/operators        — create operator (+ validation)
 *   4. PUT  /api/operators/:id    — update operator (+ 404)
 *   5. DELETE /api/operators/:id  — delete operator
 *   6. GET  /api/chats            — list chats (+ query filters)
 *   7. GET  /api/chats/:id        — single chat with messages (+ 404)
 *   8. POST /api/chats            — create chat (+ validation)
 *   9. PUT  /api/chats/:id        — update chat (+ 404)
 *  10. POST /api/chats/:id/loading — start loading animation (+ 404)
 *  11. POST /api/chats/:id/send   — send message text/flex (+ 404 + validation)
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
    getOperators: vi.fn(async () => []),
    getOperatorById: vi.fn(async () => null),
    createOperator: vi.fn(async () => ({ id: 'op-1', name: 'Test Op', email: 'op@test.com', role: 'operator' })),
    updateOperator: vi.fn(async () => {}),
    deleteOperator: vi.fn(async () => {}),
    getChats: vi.fn(async () => []),
    getChatById: vi.fn(async () => null),
    createChat: vi.fn(async () => ({ id: 'chat-1', friend_id: 'friend-1', status: 'open' })),
    updateChat: vi.fn(async () => {}),
    jstNow: vi.fn(() => '2026-01-01T00:00:00+09:00'),
    getLineAccounts: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Mock @line-crm/line-sdk
// ---------------------------------------------------------------------------

const mockPushTextMessage = vi.fn(async () => {});
const mockPushFlexMessage = vi.fn(async () => {});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    pushTextMessage = mockPushTextMessage;
    pushFlexMessage = mockPushFlexMessage;
    async replyMessage() {}
    async pushMessage() {}
    async getProfile(userId: string) {
      return { displayName: 'Test', userId, pictureUrl: '', statusMessage: '' };
    }
    async showLoadingAnimation() {}
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch (for startLoadingAnimation)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn(async () => new Response('{}', { status: 200 }));
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { chats as chatsRoute } from '../routes/chats.js';
import type { Env } from '../index.js';
import {
  getOperators,
  getOperatorById,
  createOperator,
  getChatById,
  createChat,
  updateChat,
} from '@line-crm/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-chats-api-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', chatsRoute);
  return app;
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return this; }),
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

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Chats Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  // =========================================================================
  // Auth guard
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/chats', {}, env);
      expect(res.status).toBe(401);
      const body = await jsonBody<{ success: boolean }>(res);
      expect(body.success).toBe(false);
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request('/api/chats', {
        headers: { Authorization: 'Bearer wrong-key' },
      }, env);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Operators CRUD
  // =========================================================================

  describe('GET /api/operators', () => {
    it('returns operator list', async () => {
      vi.mocked(getOperators).mockResolvedValueOnce([
        { id: 'op-1', name: 'Alice', email: 'alice@test.com', role: 'admin', is_active: 1, created_at: '2026-01-01', updated_at: '2026-01-01' },
      ]);

      const res = await app.request('/api/operators', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: unknown[] }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toEqual(expect.objectContaining({ id: 'op-1', name: 'Alice', isActive: true }));
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getOperators).mockRejectedValueOnce(new Error('DB fail'));
      const res = await app.request('/api/operators', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/operators', () => {
    it('creates an operator', async () => {
      const res = await app.request('/api/operators', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bob', email: 'bob@test.com' }),
      }, env);
      expect(res.status).toBe(201);
      const body = await jsonBody<{ success: boolean; data: { id: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('op-1');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request('/api/operators', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bob@test.com' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('returns 400 when email is missing', async () => {
      const res = await app.request('/api/operators', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bob' }),
      }, env);
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/operators/:id', () => {
    it('updates and returns the operator', async () => {
      vi.mocked(getOperatorById).mockResolvedValueOnce({
        id: 'op-1', name: 'Updated', email: 'up@test.com', role: 'admin', is_active: 1, created_at: '2026-01-01', updated_at: '2026-01-02',
      });

      const res = await app.request('/api/operators/op-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { name: string } }>(res);
      expect(body.data.name).toBe('Updated');
    });

    it('returns 404 when operator not found after update', async () => {
      vi.mocked(getOperatorById).mockResolvedValueOnce(null);

      const res = await app.request('/api/operators/op-missing', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }, env);
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/operators/:id', () => {
    it('deletes and returns success', async () => {
      const res = await app.request('/api/operators/op-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: null }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });
  });

  // =========================================================================
  // Chats CRUD
  // =========================================================================

  describe('GET /api/chats', () => {
    it('returns chat list with friend info from raw SQL', async () => {
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      const mockAll = vi.fn(async () => ({
        results: [{
          id: 'chat-1',
          friend_id: 'f-1',
          display_name: 'Taro',
          picture_url: 'https://pic.test/taro.png',
          operator_id: null,
          status: 'open',
          notes: null,
          last_message_at: '2026-01-01',
          created_at: '2026-01-01',
          updated_at: '2026-01-01',
        }],
      }));
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ all: mockAll }),
        all: mockAll,
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: unknown[] }>(res);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toEqual(expect.objectContaining({
        id: 'chat-1',
        friendName: 'Taro',
        friendPictureUrl: 'https://pic.test/taro.png',
      }));
    });

    it('filters by status query parameter', async () => {
      const mockBind = vi.fn().mockReturnValue({
        all: vi.fn(async () => ({ results: [] })),
      });
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: mockBind,
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => null),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats?status=open', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      expect(mockBind).toHaveBeenCalled();
    });
  });

  describe('GET /api/chats/:id', () => {
    it('returns 404 when chat not found', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce(null);

      const res = await app.request('/api/chats/chat-missing', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);
    });

    it('returns chat with messages and friend info', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockFirst = vi.fn(async () => ({ display_name: 'Taro', picture_url: 'https://pic.test/taro.png', line_user_id: 'U123' }));
      const mockAll = vi.fn(async () => ({
        results: [{ id: 'msg-1', friend_id: 'f-1', direction: 'incoming', message_type: 'text', content: 'Hello', created_at: '2026-01-01' }],
      }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: mockAll }),
        first: mockFirst,
        all: mockAll,
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats/chat-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { id: string; friendName: string; messages: unknown[] } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.friendName).toBe('Taro');
      expect(body.data.messages).toHaveLength(1);
    });
  });

  describe('POST /api/chats', () => {
    it('creates a new chat', async () => {
      const res = await app.request('/api/chats', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendId: 'f-1' }),
      }, env);
      expect(res.status).toBe(201);
      const body = await jsonBody<{ success: boolean; data: { id: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('chat-1');
    });

    it('returns 400 when friendId is missing', async () => {
      const res = await app.request('/api/chats', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
    });

    it('sets lineAccountId when provided', async () => {
      const mockRun = vi.fn(async () => ({ success: true }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ run: mockRun, first: vi.fn(async () => null), all: vi.fn(async () => ({ results: [] })) }),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: mockRun,
      });

      const res = await app.request('/api/chats', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendId: 'f-1', lineAccountId: 'la-1' }),
      }, env);
      expect(res.status).toBe(201);
      // Verify UPDATE query was called for lineAccountId
      expect(mockDb.prepare).toHaveBeenCalled();
    });
  });

  describe('PUT /api/chats/:id', () => {
    it('updates and returns the chat', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: 'op-1', status: 'in_progress', notes: 'note', last_message_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-02',
      });

      const res = await app.request('/api/chats/chat-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in_progress', notes: 'note' }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { status: string; notes: string } }>(res);
      expect(body.data.status).toBe('in_progress');
      expect(body.data.notes).toBe('note');
    });

    it('returns 404 when chat not found after update', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce(null);

      const res = await app.request('/api/chats/chat-missing', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved' }),
      }, env);
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // Loading animation
  // =========================================================================

  describe('POST /api/chats/:id/loading', () => {
    it('returns 404 when chat not found', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce(null);

      const res = await app.request('/api/chats/chat-missing/loading', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(404);
    });

    it('starts loading animation successfully', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockFirst = vi.fn(async () => ({ id: 'f-1', line_user_id: 'U123' }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({ success: true })) }),
        first: mockFirst,
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats/chat-1/loading', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadingSeconds: 10 }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { started: boolean; loadingSeconds: number } }>(res);
      expect(body.data.started).toBe(true);
      expect(body.data.loadingSeconds).toBe(10);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.line.me/v2/bot/chat/loading/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns 404 when friend not found', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-missing', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn(async () => null), all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({ success: true })) }),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats/chat-1/loading', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(404);
      const body = await jsonBody<{ success: boolean; error: string }>(res);
      expect(body.error).toBe('Friend not found');
    });

    it('clamps loadingSeconds to minimum 5', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockFirst = vi.fn(async () => ({ id: 'f-1', line_user_id: 'U123' }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({ success: true })) }),
        first: mockFirst,
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats/chat-1/loading', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ loadingSeconds: 1 }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { loadingSeconds: number } }>(res);
      expect(body.data.loadingSeconds).toBe(5);
    });

    it('returns 500 when LINE API fails', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockFirst = vi.fn(async () => ({ id: 'f-1', line_user_id: 'U123' }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({ success: true })) }),
        first: mockFirst,
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      mockFetch.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      const res = await app.request('/api/chats/chat-1/loading', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(500);
      const body = await jsonBody<{ success: boolean; error: string }>(res);
      expect(body.error).toContain('LINE API error');
    });
  });

  // =========================================================================
  // Send message
  // =========================================================================

  describe('POST /api/chats/:id/send', () => {
    it('returns 404 when chat not found', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce(null);

      const res = await app.request('/api/chats/chat-missing/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('returns 400 when content is missing', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const res = await app.request('/api/chats/chat-1/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
    });

    it('returns 404 when friend not found', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-missing', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: vi.fn(async () => null), all: vi.fn(async () => ({ results: [] })), run: vi.fn(async () => ({ success: true })) }),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      });

      const res = await app.request('/api/chats/chat-1/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      }, env);
      expect(res.status).toBe(404);
      const body = await jsonBody<{ success: boolean; error: string }>(res);
      expect(body.error).toBe('Friend not found');
    });

    it('sends a text message successfully', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockRun = vi.fn(async () => ({ success: true }));
      const mockFirst = vi.fn(async () => ({ id: 'f-1', line_user_id: 'U123' }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: vi.fn(async () => ({ results: [] })), run: mockRun }),
        first: mockFirst,
        all: vi.fn(async () => ({ results: [] })),
        run: mockRun,
      });

      const res = await app.request('/api/chats/chat-1/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Hello!' }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { sent: boolean; messageId: string } }>(res);
      expect(body.success).toBe(true);
      expect(body.data.sent).toBe(true);
      expect(body.data.messageId).toBeDefined();
      expect(mockPushTextMessage).toHaveBeenCalledWith('U123', 'Hello!');
      expect(vi.mocked(updateChat)).toHaveBeenCalled();
    });

    it('sends a flex message successfully', async () => {
      vi.mocked(getChatById).mockResolvedValueOnce({
        id: 'chat-1', friend_id: 'f-1', operator_id: null, status: 'open', notes: null, last_message_at: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      });

      const mockRun = vi.fn(async () => ({ success: true }));
      const mockFirst = vi.fn(async () => ({ id: 'f-1', line_user_id: 'U123' }));
      const mockDb = env.DB as unknown as { prepare: ReturnType<typeof vi.fn> };
      mockDb.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({ first: mockFirst, all: vi.fn(async () => ({ results: [] })), run: mockRun }),
        first: mockFirst,
        all: vi.fn(async () => ({ results: [] })),
        run: mockRun,
      });

      const flexContent = { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'Flex!' }] } };

      const res = await app.request('/api/chats/chat-1/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageType: 'flex', content: JSON.stringify(flexContent) }),
      }, env);
      expect(res.status).toBe(200);
      const body = await jsonBody<{ success: boolean; data: { sent: boolean } }>(res);
      expect(body.data.sent).toBe(true);
      expect(mockPushFlexMessage).toHaveBeenCalledWith('U123', 'Flex!', flexContent);
    });
  });
});
