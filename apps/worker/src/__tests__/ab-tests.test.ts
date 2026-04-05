import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock DB functions
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async () => null),
    getAbTests: vi.fn(async () => []),
    getAbTestById: vi.fn(async () => null),
    createAbTest: vi.fn(async () => null),
    updateAbTest: vi.fn(async () => null),
    deleteAbTest: vi.fn(async () => undefined),
    getLatestRiskLevel: vi.fn(async () => 'safe'),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async multicast() {}
    async broadcast() {}
    async pushMessage() {}
    pushTextMessage = vi.fn(async () => {});
  },
}));

vi.mock('../services/ab-test.js', () => ({
  processAbTestSend: vi.fn(async () => ({})),
  processAbTestWinnerSend: vi.fn(async () => ({})),
  getAbTestStats: vi.fn(async () => ({
    variantA: { sent: 50, clicks: 10, clickRate: 20 },
    variantB: { sent: 50, clicks: 15, clickRate: 30 },
    winner: null,
  })),
  processScheduledAbTests: vi.fn(async () => {}),
}));

import {
  getAbTests,
  getAbTestById,
  createAbTest,
  updateAbTest,
  deleteAbTest,
} from '@line-crm/db';
import { processAbTestSend, processAbTestWinnerSend, getAbTestStats } from '../services/ab-test.js';
import { authMiddleware } from '../middleware/auth.js';
import { abTests } from '../routes/ab-tests.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-ab-12345';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
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

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', abTests);
  return app;
}

function makeSampleAbTest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ab-1',
    title: 'Test AB',
    variant_a_message_type: 'text',
    variant_a_message_content: 'Hello A',
    variant_a_alt_text: null,
    variant_b_message_type: 'text',
    variant_b_message_content: 'Hello B',
    variant_b_alt_text: null,
    target_type: 'all',
    target_tag_id: null,
    split_ratio: 50,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    variant_a_total: 0,
    variant_a_success: 0,
    variant_b_total: 0,
    variant_b_success: 0,
    winner: null,
    winner_total: 0,
    winner_success: 0,
    variant_a_tracked_link_ids: null,
    variant_b_tracked_link_ids: null,
    line_account_id: null,
    created_at: '2026-04-05T10:00:00.000',
    ...overrides,
  };
}

describe('AB Tests Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];
  const mockedGetAbTests = getAbTests as ReturnType<typeof vi.fn>;
  const mockedGetAbTestById = getAbTestById as ReturnType<typeof vi.fn>;
  const mockedCreateAbTest = createAbTest as ReturnType<typeof vi.fn>;
  const mockedUpdateAbTest = updateAbTest as ReturnType<typeof vi.fn>;
  const mockedDeleteAbTest = deleteAbTest as ReturnType<typeof vi.fn>;
  const mockedProcessAbTestSend = processAbTestSend as ReturnType<typeof vi.fn>;
  const mockedProcessAbTestWinnerSend = processAbTestWinnerSend as ReturnType<typeof vi.fn>;
  const mockedGetAbTestStats = getAbTestStats as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // ---------- Authentication ----------

  describe('Authentication', () => {
    it('should return 401 without auth header', async () => {
      const res = await app.request('/api/ab-tests', {}, env);
      expect(res.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const res = await app.request('/api/ab-tests', {
        headers: { Authorization: 'Bearer wrong-token' },
      }, env);
      expect(res.status).toBe(401);
    });
  });

  // ---------- GET /api/ab-tests ----------

  describe('GET /api/ab-tests', () => {
    it('should return empty list', async () => {
      mockedGetAbTests.mockResolvedValueOnce([]);
      const res = await app.request('/api/ab-tests', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('should return list with data', async () => {
      mockedGetAbTests.mockResolvedValueOnce([makeSampleAbTest()]);
      const res = await app.request('/api/ab-tests', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('should filter by lineAccountId', async () => {
      const res = await app.request('/api/ab-tests?lineAccountId=acc-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
    });
  });

  // ---------- GET /api/ab-tests/:id ----------

  describe('GET /api/ab-tests/:id', () => {
    it('should return 404 if not found', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(null);
      const res = await app.request('/api/ab-tests/nonexistent', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);
    });

    it('should return AB test when found', async () => {
      const sample = makeSampleAbTest();
      mockedGetAbTestById.mockResolvedValueOnce(sample);
      const res = await app.request('/api/ab-tests/ab-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { id: string; title: string; splitRatio: number } };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('ab-1');
      expect(body.data.title).toBe('Test AB');
      expect(body.data.splitRatio).toBe(50);
    });
  });

  // ---------- POST /api/ab-tests ----------

  describe('POST /api/ab-tests', () => {
    it('should create AB test', async () => {
      const sample = makeSampleAbTest();
      mockedCreateAbTest.mockResolvedValueOnce(sample);

      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test AB',
          variantA: { messageType: 'text', messageContent: 'Hello A' },
          variantB: { messageType: 'text', messageContent: 'Hello B' },
          targetType: 'all',
        }),
      }, env);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should return 400 if title is missing', async () => {
      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantA: { messageType: 'text', messageContent: 'A' },
          variantB: { messageType: 'text', messageContent: 'B' },
          targetType: 'all',
        }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should return 400 if variantA is missing', async () => {
      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test',
          variantB: { messageType: 'text', messageContent: 'B' },
          targetType: 'all',
        }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should return 400 if targetType is tag but no targetTagId', async () => {
      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test',
          variantA: { messageType: 'text', messageContent: 'A' },
          variantB: { messageType: 'text', messageContent: 'B' },
          targetType: 'tag',
        }),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('targetTagId');
    });

    it('should return 400 if splitRatio is out of range', async () => {
      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test',
          variantA: { messageType: 'text', messageContent: 'A' },
          variantB: { messageType: 'text', messageContent: 'B' },
          targetType: 'all',
          splitRatio: 0,
        }),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('splitRatio');
    });

    it('should return 400 if splitRatio is 100', async () => {
      const res = await app.request('/api/ab-tests', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test',
          variantA: { messageType: 'text', messageContent: 'A' },
          variantB: { messageType: 'text', messageContent: 'B' },
          targetType: 'all',
          splitRatio: 100,
        }),
      }, env);
      expect(res.status).toBe(400);
    });
  });

  // ---------- PUT /api/ab-tests/:id ----------

  describe('PUT /api/ab-tests/:id', () => {
    it('should update a draft AB test', async () => {
      const sample = makeSampleAbTest();
      mockedGetAbTestById.mockResolvedValueOnce(sample);
      mockedUpdateAbTest.mockResolvedValueOnce({ ...sample, title: 'Updated' });

      const res = await app.request('/api/ab-tests/ab-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }, env);
      expect(res.status).toBe(200);
    });

    it('should return 404 if not found', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(null);
      const res = await app.request('/api/ab-tests/nonexistent', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('should return 400 if status is not draft/scheduled', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(makeSampleAbTest({ status: 'test_sent' }));
      const res = await app.request('/api/ab-tests/ab-1', {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      }, env);
      expect(res.status).toBe(400);
    });
  });

  // ---------- DELETE /api/ab-tests/:id ----------

  describe('DELETE /api/ab-tests/:id', () => {
    it('should delete AB test', async () => {
      mockedDeleteAbTest.mockResolvedValueOnce(undefined);
      const res = await app.request('/api/ab-tests/ab-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  // ---------- POST /api/ab-tests/:id/send ----------

  describe('POST /api/ab-tests/:id/send', () => {
    it('should return 404 if not found', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(null);
      const res = await app.request('/api/ab-tests/nonexistent/send', {
        method: 'POST',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(404);
    });

    it('should return 400 if already sent', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(makeSampleAbTest({ status: 'test_sent' }));
      const res = await app.request('/api/ab-tests/ab-1/send', {
        method: 'POST',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should send AB test successfully', async () => {
      const sample = makeSampleAbTest();
      mockedGetAbTestById
        .mockResolvedValueOnce(sample) // route check
        .mockResolvedValueOnce({ ...sample, status: 'test_sent' }); // after send
      mockedProcessAbTestSend.mockResolvedValueOnce({ ...sample, status: 'test_sent' });

      const res = await app.request('/api/ab-tests/ab-1/send', {
        method: 'POST',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);
      expect(mockedProcessAbTestSend).toHaveBeenCalled();
    });
  });

  // ---------- POST /api/ab-tests/:id/stats ----------

  describe('POST /api/ab-tests/:id/stats', () => {
    it('should return 404 if not found', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(null);
      const res = await app.request('/api/ab-tests/nonexistent/stats', {
        method: 'POST',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(404);
    });

    it('should return stats', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(makeSampleAbTest({ status: 'test_sent' }));
      mockedGetAbTestStats.mockResolvedValueOnce({
        variantA: { sent: 50, clicks: 10, clickRate: 20 },
        variantB: { sent: 50, clicks: 15, clickRate: 30 },
        winner: null,
      });

      const res = await app.request('/api/ab-tests/ab-1/stats', {
        method: 'POST',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { variantA: { clickRate: number } } };
      expect(body.data.variantA.clickRate).toBe(20);
    });
  });

  // ---------- POST /api/ab-tests/:id/send-winner ----------

  describe('POST /api/ab-tests/:id/send-winner', () => {
    it('should return 404 if not found', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(null);
      const res = await app.request('/api/ab-tests/nonexistent/send-winner', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ winner: 'A' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('should return 400 if not in test_sent status', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(makeSampleAbTest({ status: 'draft' }));
      const res = await app.request('/api/ab-tests/ab-1/send-winner', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ winner: 'A' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should return 400 if winner is not A or B', async () => {
      mockedGetAbTestById.mockResolvedValueOnce(makeSampleAbTest({ status: 'test_sent' }));
      const res = await app.request('/api/ab-tests/ab-1/send-winner', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ winner: 'C' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('should send winner successfully', async () => {
      const sample = makeSampleAbTest({ status: 'test_sent' });
      mockedGetAbTestById
        .mockResolvedValueOnce(sample) // route check
        .mockResolvedValueOnce({ ...sample, status: 'winner_sent', winner: 'B' }); // after send
      mockedProcessAbTestWinnerSend.mockResolvedValueOnce({ ...sample, status: 'winner_sent' });

      const res = await app.request('/api/ab-tests/ab-1/send-winner', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ winner: 'B' }),
      }, env);
      expect(res.status).toBe(200);
      expect(mockedProcessAbTestWinnerSend).toHaveBeenCalled();
    });
  });

  // ---------- Serialization ----------

  describe('Serialization', () => {
    it('should serialize AB test with camelCase keys', async () => {
      const sample = makeSampleAbTest({
        variant_a_message_type: 'flex',
        split_ratio: 70,
        target_tag_id: 'tag-1',
      });
      mockedGetAbTestById.mockResolvedValueOnce(sample);

      const res = await app.request('/api/ab-tests/ab-1', { headers: authHeaders() }, env);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data.splitRatio).toBe(70);
      expect(body.data.targetTagId).toBe('tag-1');
      expect(body.data).toHaveProperty('variantA');
      expect(body.data).toHaveProperty('variantB');
      // Ensure snake_case keys are NOT in response
      expect(body.data).not.toHaveProperty('split_ratio');
      expect(body.data).not.toHaveProperty('target_tag_id');
    });
  });
});
