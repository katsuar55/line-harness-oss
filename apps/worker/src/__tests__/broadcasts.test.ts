/**
 * Tests for the broadcasts API routes.
 *
 * Covers:
 *   1. GET /api/broadcasts — list all broadcasts (empty, with data, with lineAccountId filter)
 *   2. POST /api/broadcasts — create broadcast (success, validation errors)
 *   3. GET /api/broadcasts/:id — get single broadcast (found, not found)
 *   4. PUT /api/broadcasts/:id — update broadcast (success, not found, non-draft status)
 *   5. DELETE /api/broadcasts/:id — delete broadcast
 *   6. POST /api/broadcasts/:id/send — send broadcast
 *   7. POST /api/broadcasts/:id/send-segment — segment send
 *   8. Authentication — 401 without token
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Broadcast } from '@line-crm/db';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-123';

const mockBroadcast: Broadcast = {
  id: 'bc-001',
  title: 'Test Broadcast',
  message_type: 'text',
  message_content: 'Hello everyone!',
  target_type: 'all',
  target_tag_id: null,
  status: 'draft',
  scheduled_at: null,
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-03-31T12:00:00+09:00',
};

const mockBroadcast2: Broadcast = {
  id: 'bc-002',
  title: 'Second Broadcast',
  message_type: 'flex',
  message_content: '{"type":"bubble"}',
  target_type: 'tag',
  target_tag_id: 'tag-001',
  status: 'scheduled',
  scheduled_at: '2026-04-01T10:00:00+09:00',
  sent_at: null,
  total_count: 0,
  success_count: 0,
  created_at: '2026-03-31T13:00:00+09:00',
};

// ---------------------------------------------------------------------------
// Mock function refs
// ---------------------------------------------------------------------------

const mockGetBroadcasts = vi.fn<() => Promise<Broadcast[]>>();
const mockGetBroadcastById = vi.fn<(db: unknown, id: string) => Promise<Broadcast | null>>();
const mockCreateBroadcast = vi.fn<(db: unknown, input: unknown) => Promise<Broadcast>>();
const mockUpdateBroadcast = vi.fn<(db: unknown, id: string, updates: unknown) => Promise<Broadcast | null>>();
const mockDeleteBroadcast = vi.fn<(db: unknown, id: string) => Promise<void>>();
const mockProcessBroadcastSend = vi.fn<() => Promise<void>>();
const mockProcessSegmentSend = vi.fn<() => Promise<void>>();

// ---------------------------------------------------------------------------
// Top-level mocks (for initial import resolution)
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', () => ({
  getBroadcasts: (...args: unknown[]) => mockGetBroadcasts(),
  getBroadcastById: (db: unknown, id: string) => mockGetBroadcastById(db, id),
  createBroadcast: (db: unknown, input: unknown) => mockCreateBroadcast(db, input),
  updateBroadcast: (db: unknown, id: string, updates: unknown) => mockUpdateBroadcast(db, id, updates),
  deleteBroadcast: (db: unknown, id: string) => mockDeleteBroadcast(db, id),
  getStaffByApiKey: vi.fn(async () => null),
}));

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async pushMessage() {}
    async broadcastMessage() {}
  },
  verifySignature: vi.fn(() => true),
}));

vi.mock('../services/broadcast.js', () => ({
  processBroadcastSend: (...args: unknown[]) => mockProcessBroadcastSend(),
}));

vi.mock('../services/segment-send.js', () => ({
  processSegmentSend: (...args: unknown[]) => mockProcessSegmentSend(),
}));

// ---------------------------------------------------------------------------
// App + env setup
// ---------------------------------------------------------------------------

let app: Hono<Env>;
let env: Env['Bindings'];

function createMockD1(): D1Database {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStmt),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: createMockD1(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.example.com',
    LINE_CHANNEL_ID: 'ch-001',
    LINE_LOGIN_CHANNEL_ID: 'login-ch-001',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

beforeEach(async () => {
  vi.resetModules();

  vi.doMock('@line-crm/db', () => ({
    getBroadcasts: (...args: unknown[]) => mockGetBroadcasts(),
    getBroadcastById: (db: unknown, id: string) => mockGetBroadcastById(db, id),
    createBroadcast: (db: unknown, input: unknown) => mockCreateBroadcast(db, input),
    updateBroadcast: (db: unknown, id: string, updates: unknown) => mockUpdateBroadcast(db, id, updates),
    deleteBroadcast: (db: unknown, id: string) => mockDeleteBroadcast(db, id),
    getStaffByApiKey: vi.fn(async () => null),
  }));

  vi.doMock('@line-crm/line-sdk', () => ({
    LineClient: class MockLineClient {
      constructor(public readonly token: string) {}
      async pushMessage() {}
      async broadcastMessage() {}
    },
    verifySignature: vi.fn(() => true),
  }));

  vi.doMock('../services/broadcast.js', () => ({
    processBroadcastSend: (...args: unknown[]) => mockProcessBroadcastSend(),
  }));

  vi.doMock('../services/segment-send.js', () => ({
    processSegmentSend: (...args: unknown[]) => mockProcessSegmentSend(),
  }));

  const { authMiddleware } = await import('../middleware/auth.js');
  const { broadcasts } = await import('../routes/broadcasts.js');

  app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', broadcasts);

  env = createMockEnv();

  mockGetBroadcasts.mockReset();
  mockGetBroadcastById.mockReset();
  mockCreateBroadcast.mockReset();
  mockUpdateBroadcast.mockReset();
  mockDeleteBroadcast.mockReset();
  mockProcessBroadcastSend.mockReset();
  mockProcessSegmentSend.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Broadcasts API', () => {
  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------
  describe('Authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await app.request('/api/broadcasts', {}, env);
      expect(res.status).toBe(401);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 401 when an invalid token is provided', async () => {
      const res = await app.request(
        '/api/broadcasts',
        { headers: { Authorization: 'Bearer wrong-key' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/broadcasts
  // -----------------------------------------------------------------------
  describe('GET /api/broadcasts', () => {
    it('returns empty list when no broadcasts exist', async () => {
      mockGetBroadcasts.mockResolvedValue([]);
      const res = await app.request(
        '/api/broadcasts',
        { headers: authHeaders },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it('returns serialized broadcasts when data exists', async () => {
      mockGetBroadcasts.mockResolvedValue([mockBroadcast, mockBroadcast2]);
      const res = await app.request(
        '/api/broadcasts',
        { headers: authHeaders },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: Array<Record<string, unknown>> };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0]).toEqual({
        id: 'bc-001',
        title: 'Test Broadcast',
        messageType: 'text',
        messageContent: 'Hello everyone!',
        targetType: 'all',
        targetTagId: null,
        status: 'draft',
        scheduledAt: null,
        sentAt: null,
        totalCount: 0,
        successCount: 0,
        createdAt: '2026-03-31T12:00:00+09:00',
        lineRequestId: null,
        insightsFetchedAt: null,
      });
    });

    it('filters by lineAccountId when query param is provided', async () => {
      // When lineAccountId is provided, the route uses DB.prepare directly
      const mockAll = vi.fn().mockResolvedValue({ results: [mockBroadcast] });
      const mockDb = createMockD1();
      (mockDb.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnValue({ all: mockAll }),
      });
      const filteredEnv = { ...env, DB: mockDb };

      const res = await app.request(
        '/api/broadcasts?lineAccountId=acc-001',
        { headers: authHeaders },
        filteredEnv,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/broadcasts/:id
  // -----------------------------------------------------------------------
  describe('GET /api/broadcasts/:id', () => {
    it('returns a broadcast when it exists', async () => {
      mockGetBroadcastById.mockResolvedValue(mockBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001',
        { headers: authHeaders },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('bc-001');
    });

    it('returns 404 when broadcast does not exist', async () => {
      mockGetBroadcastById.mockResolvedValue(null);
      const res = await app.request(
        '/api/broadcasts/nonexistent',
        { headers: authHeaders },
        env,
      );

      expect(res.status).toBe(404);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Broadcast not found');
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/broadcasts
  // -----------------------------------------------------------------------
  describe('POST /api/broadcasts', () => {
    it('creates a broadcast with valid data', async () => {
      mockCreateBroadcast.mockResolvedValue(mockBroadcast);
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Test Broadcast',
            messageType: 'text',
            messageContent: 'Hello everyone!',
            targetType: 'all',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = await res.json() as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('bc-001');
    });

    it('returns 400 when title is missing', async () => {
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageType: 'text',
            messageContent: 'Hello',
            targetType: 'all',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('title');
    });

    it('returns 400 when messageType is missing', async () => {
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Test',
            messageContent: 'Hello',
            targetType: 'all',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('messageType');
    });

    it('returns 400 when messageContent is missing', async () => {
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Test',
            messageType: 'text',
            targetType: 'all',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('messageContent');
    });

    it('returns 400 when targetType is missing', async () => {
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Test',
            messageType: 'text',
            messageContent: 'Hello',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('targetType');
    });

    it('returns 400 when targetType is tag but targetTagId is missing', async () => {
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Tag Broadcast',
            messageType: 'text',
            messageContent: 'Hello tag users!',
            targetType: 'tag',
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('targetTagId');
    });

    it('creates a tag-targeted broadcast when targetTagId is provided', async () => {
      mockCreateBroadcast.mockResolvedValue(mockBroadcast2);
      const res = await app.request(
        '/api/broadcasts',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: 'Tag Broadcast',
            messageType: 'flex',
            messageContent: '{"type":"bubble"}',
            targetType: 'tag',
            targetTagId: 'tag-001',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = await res.json() as { success: boolean; data: { targetType: string; targetTagId: string } };
      expect(json.success).toBe(true);
      expect(json.data.targetType).toBe('tag');
      expect(json.data.targetTagId).toBe('tag-001');
    });
  });

  // -----------------------------------------------------------------------
  // PUT /api/broadcasts/:id
  // -----------------------------------------------------------------------
  describe('PUT /api/broadcasts/:id', () => {
    it('updates a draft broadcast', async () => {
      const updatedBroadcast = { ...mockBroadcast, title: 'Updated Title' };
      mockGetBroadcastById.mockResolvedValueOnce(mockBroadcast);
      mockUpdateBroadcast.mockResolvedValue(updatedBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001',
        {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated Title' }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { title: string } };
      expect(json.success).toBe(true);
      expect(json.data.title).toBe('Updated Title');
    });

    it('returns 404 when broadcast does not exist', async () => {
      mockGetBroadcastById.mockResolvedValue(null);
      const res = await app.request(
        '/api/broadcasts/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
        },
        env,
      );

      expect(res.status).toBe(404);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Broadcast not found');
    });

    it('returns 400 when trying to update a sent broadcast', async () => {
      const sentBroadcast: Broadcast = { ...mockBroadcast, status: 'sent' };
      mockGetBroadcastById.mockResolvedValue(sentBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001',
        {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('draft or scheduled');
    });

    it('returns 400 when trying to update a sending broadcast', async () => {
      const sendingBroadcast: Broadcast = { ...mockBroadcast, status: 'sending' };
      mockGetBroadcastById.mockResolvedValue(sendingBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001',
        {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Updated' }),
        },
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/broadcasts/:id
  // -----------------------------------------------------------------------
  describe('DELETE /api/broadcasts/:id', () => {
    it('deletes a broadcast and returns success', async () => {
      mockDeleteBroadcast.mockResolvedValue(undefined);
      const res = await app.request(
        '/api/broadcasts/bc-001',
        { method: 'DELETE', headers: authHeaders },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/broadcasts/:id/send
  // -----------------------------------------------------------------------
  describe('POST /api/broadcasts/:id/send', () => {
    it('returns 404 when broadcast does not exist', async () => {
      mockGetBroadcastById.mockResolvedValue(null);
      const res = await app.request(
        '/api/broadcasts/nonexistent/send',
        { method: 'POST', headers: authHeaders },
        env,
      );

      expect(res.status).toBe(404);
    });

    it('returns 400 when broadcast is already sent', async () => {
      const sentBroadcast: Broadcast = { ...mockBroadcast, status: 'sent' };
      mockGetBroadcastById.mockResolvedValue(sentBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001/send',
        { method: 'POST', headers: authHeaders },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toContain('already sent or sending');
    });

    it('returns 400 when broadcast is already sending', async () => {
      const sendingBroadcast: Broadcast = { ...mockBroadcast, status: 'sending' };
      mockGetBroadcastById.mockResolvedValue(sendingBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001/send',
        { method: 'POST', headers: authHeaders },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('sends a draft broadcast successfully', async () => {
      const sentResult: Broadcast = { ...mockBroadcast, status: 'sent' };
      mockGetBroadcastById
        .mockResolvedValueOnce(mockBroadcast)
        .mockResolvedValueOnce(sentResult);
      mockProcessBroadcastSend.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/broadcasts/bc-001/send',
        { method: 'POST', headers: authHeaders },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/broadcasts/:id/send-segment
  // -----------------------------------------------------------------------
  describe('POST /api/broadcasts/:id/send-segment', () => {
    it('returns 404 when broadcast does not exist', async () => {
      mockGetBroadcastById.mockResolvedValue(null);
      const res = await app.request(
        '/api/broadcasts/nonexistent/send-segment',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ conditions: { operator: 'and', rules: [] } }),
        },
        env,
      );

      expect(res.status).toBe(404);
    });

    it('returns 400 when conditions are missing', async () => {
      mockGetBroadcastById.mockResolvedValue(mockBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001/send-segment',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toContain('conditions');
    });

    it('returns 400 when conditions lack operator', async () => {
      mockGetBroadcastById.mockResolvedValue(mockBroadcast);
      const res = await app.request(
        '/api/broadcasts/bc-001/send-segment',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ conditions: { rules: [] } }),
        },
        env,
      );

      expect(res.status).toBe(400);
    });

    it('sends a segment broadcast successfully', async () => {
      const sentResult: Broadcast = { ...mockBroadcast, status: 'sent' };
      mockGetBroadcastById
        .mockResolvedValueOnce(mockBroadcast)
        .mockResolvedValueOnce(sentResult);
      mockProcessSegmentSend.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/broadcasts/bc-001/send-segment',
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conditions: { operator: 'and', rules: [{ field: 'tag', op: 'eq', value: 'vip' }] },
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);
    });
  });
});
