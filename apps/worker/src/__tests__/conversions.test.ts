/**
 * Tests for conversions routes.
 *
 * Covers:
 *   1. GET /api/conversions/points — list all conversion points
 *   2. POST /api/conversions/points — create a conversion point
 *   3. POST /api/conversions/points — validation (missing name/eventType)
 *   4. DELETE /api/conversions/points/:id — delete a conversion point
 *   5. POST /api/conversions/track — track a conversion event
 *   6. POST /api/conversions/track — validation (missing required fields)
 *   7. POST /api/conversions/track — with optional fields (userId, affiliateCode, metadata)
 *   8. GET /api/conversions/events — list events with default params
 *   9. GET /api/conversions/events — list events with query filters
 *  10. GET /api/conversions/report — aggregated report
 *  11. GET /api/conversions/report — with date filters
 *  12. Error handling — each endpoint returns 500 on DB error
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
    getConversionPoints: vi.fn(),
    getConversionPointById: vi.fn(),
    createConversionPoint: vi.fn(),
    deleteConversionPoint: vi.fn(),
    trackConversion: vi.fn(),
    getConversionEvents: vi.fn(),
    getConversionReport: vi.fn(),
    // Stubs needed by other mounted routes (prevent import errors)
    getStaffByApiKey: vi.fn(async () => null),
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
// Import after mocks — pull out mocked functions via the module reference
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { conversions } from '../routes/conversions.js';
import type { Env } from '../index.js';
import {
  getConversionPoints,
  createConversionPoint,
  deleteConversionPoint,
  trackConversion,
  getConversionEvents,
  getConversionReport,
} from '@line-crm/db';

// Cast mocked functions for assertion usage
const mockGetConversionPoints = getConversionPoints as ReturnType<typeof vi.fn>;
const mockCreateConversionPoint = createConversionPoint as ReturnType<typeof vi.fn>;
const mockDeleteConversionPoint = deleteConversionPoint as ReturnType<typeof vi.fn>;
const mockTrackConversion = trackConversion as ReturnType<typeof vi.fn>;
const mockGetConversionEvents = getConversionEvents as ReturnType<typeof vi.fn>;
const mockGetConversionReport = getConversionReport as ReturnType<typeof vi.fn>;

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
  app.route('/', conversions);
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

describe('Conversions Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createMockEnv();
  });

  // ── GET /api/conversions/points ─────────────────────────────────────────

  describe('GET /api/conversions/points', () => {
    it('returns list of conversion points', async () => {
      const mockPoints = [
        {
          id: 'cp-1',
          name: 'Purchase',
          event_type: 'purchase',
          value: 1000,
          created_at: '2025-01-01T00:00:00Z',
        },
        {
          id: 'cp-2',
          name: 'Signup',
          event_type: 'signup',
          value: null,
          created_at: '2025-01-02T00:00:00Z',
        },
      ];
      mockGetConversionPoints.mockResolvedValueOnce(mockPoints);

      const res = await app.request(
        '/api/conversions/points',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          name: string;
          eventType: string;
          value: number | null;
          createdAt: string;
        }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0].id).toBe('cp-1');
      expect(json.data[0].eventType).toBe('purchase');
      expect(json.data[0].value).toBe(1000);
      expect(json.data[1].value).toBeNull();
    });

    it('returns empty array when no points exist', async () => {
      mockGetConversionPoints.mockResolvedValueOnce([]);

      const res = await app.request(
        '/api/conversions/points',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      mockGetConversionPoints.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/points',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    it('returns 401 without auth header', async () => {
      const res = await app.request(
        '/api/conversions/points',
        { method: 'GET' },
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/conversions/points ────────────────────────────────────────

  describe('POST /api/conversions/points', () => {
    it('creates a conversion point', async () => {
      const created = {
        id: 'cp-new',
        name: 'Purchase',
        event_type: 'purchase',
        value: 500,
        created_at: '2025-01-01T00:00:00Z',
      };
      mockCreateConversionPoint.mockResolvedValueOnce(created);

      const res = await app.request(
        '/api/conversions/points',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Purchase',
            eventType: 'purchase',
            value: 500,
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          name: string;
          eventType: string;
          value: number | null;
          createdAt: string;
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('cp-new');
      expect(json.data.name).toBe('Purchase');
      expect(json.data.eventType).toBe('purchase');
      expect(json.data.value).toBe(500);
    });

    it('creates a conversion point without value', async () => {
      const created = {
        id: 'cp-no-val',
        name: 'PageView',
        event_type: 'page_view',
        value: null,
        created_at: '2025-01-01T00:00:00Z',
      };
      mockCreateConversionPoint.mockResolvedValueOnce(created);

      const res = await app.request(
        '/api/conversions/points',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'PageView',
            eventType: 'page_view',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: { value: number | null };
      };
      expect(json.success).toBe(true);
      expect(json.data.value).toBeNull();
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/conversions/points',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ eventType: 'purchase' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name and eventType are required');
    });

    it('returns 400 when eventType is missing', async () => {
      const res = await app.request(
        '/api/conversions/points',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Purchase' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name and eventType are required');
    });

    it('returns 500 on DB error', async () => {
      mockCreateConversionPoint.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/points',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Purchase',
            eventType: 'purchase',
          }),
        },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // ── DELETE /api/conversions/points/:id ──────────────────────────────────

  describe('DELETE /api/conversions/points/:id', () => {
    it('deletes a conversion point', async () => {
      mockDeleteConversionPoint.mockResolvedValueOnce(undefined);

      const res = await app.request(
        '/api/conversions/points/cp-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockDeleteConversionPoint).toHaveBeenCalledWith(env.DB, 'cp-1');
    });

    it('returns 500 on DB error', async () => {
      mockDeleteConversionPoint.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/points/cp-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // ── POST /api/conversions/track ─────────────────────────────────────────

  describe('POST /api/conversions/track', () => {
    it('tracks a conversion event with required fields only', async () => {
      const tracked = {
        id: 'ev-1',
        conversion_point_id: 'cp-1',
        friend_id: 'fr-1',
        user_id: null,
        affiliate_code: null,
        metadata: null,
        created_at: '2025-01-01T00:00:00Z',
      };
      mockTrackConversion.mockResolvedValueOnce(tracked);

      const res = await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversionPointId: 'cp-1',
            friendId: 'fr-1',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          conversionPointId: string;
          friendId: string;
          userId: string | null;
          affiliateCode: string | null;
          metadata: string | null;
          createdAt: string;
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('ev-1');
      expect(json.data.conversionPointId).toBe('cp-1');
      expect(json.data.friendId).toBe('fr-1');
      expect(json.data.userId).toBeNull();
      expect(json.data.affiliateCode).toBeNull();
      expect(json.data.metadata).toBeNull();
    });

    it('tracks a conversion event with all optional fields', async () => {
      const tracked = {
        id: 'ev-2',
        conversion_point_id: 'cp-1',
        friend_id: 'fr-1',
        user_id: 'usr-1',
        affiliate_code: 'AFF100',
        metadata: '{"source":"web"}',
        created_at: '2025-01-01T00:00:00Z',
      };
      mockTrackConversion.mockResolvedValueOnce(tracked);

      const res = await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversionPointId: 'cp-1',
            friendId: 'fr-1',
            userId: 'usr-1',
            affiliateCode: 'AFF100',
            metadata: { source: 'web' },
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          userId: string | null;
          affiliateCode: string | null;
          metadata: string | null;
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.userId).toBe('usr-1');
      expect(json.data.affiliateCode).toBe('AFF100');
      expect(json.data.metadata).toBe('{"source":"web"}');

      // Verify metadata was stringified when passed to trackConversion
      expect(mockTrackConversion).toHaveBeenCalledWith(env.DB, {
        conversionPointId: 'cp-1',
        friendId: 'fr-1',
        userId: 'usr-1',
        affiliateCode: 'AFF100',
        metadata: '{"source":"web"}',
      });
    });

    it('returns 400 when conversionPointId is missing', async () => {
      const res = await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ friendId: 'fr-1' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('conversionPointId and friendId are required');
    });

    it('returns 400 when friendId is missing', async () => {
      const res = await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ conversionPointId: 'cp-1' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('conversionPointId and friendId are required');
    });

    it('passes null metadata when not provided', async () => {
      const tracked = {
        id: 'ev-3',
        conversion_point_id: 'cp-1',
        friend_id: 'fr-1',
        user_id: null,
        affiliate_code: null,
        metadata: null,
        created_at: '2025-01-01T00:00:00Z',
      };
      mockTrackConversion.mockResolvedValueOnce(tracked);

      await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversionPointId: 'cp-1',
            friendId: 'fr-1',
          }),
        },
        env,
      );

      expect(mockTrackConversion).toHaveBeenCalledWith(env.DB, {
        conversionPointId: 'cp-1',
        friendId: 'fr-1',
        userId: undefined,
        affiliateCode: undefined,
        metadata: null,
      });
    });

    it('returns 500 on DB error', async () => {
      mockTrackConversion.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/track',
        {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            conversionPointId: 'cp-1',
            friendId: 'fr-1',
          }),
        },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // ── GET /api/conversions/events ─────────────────────────────────────────

  describe('GET /api/conversions/events', () => {
    it('returns list of events with default params', async () => {
      const mockEvents = [
        {
          id: 'ev-1',
          conversion_point_id: 'cp-1',
          friend_id: 'fr-1',
          user_id: null,
          affiliate_code: null,
          metadata: null,
          created_at: '2025-01-01T00:00:00Z',
        },
      ];
      mockGetConversionEvents.mockResolvedValueOnce(mockEvents);

      const res = await app.request(
        '/api/conversions/events',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          conversionPointId: string;
          friendId: string;
        }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].conversionPointId).toBe('cp-1');

      // Default limit=100, offset=0
      expect(mockGetConversionEvents).toHaveBeenCalledWith(env.DB, {
        conversionPointId: undefined,
        friendId: undefined,
        affiliateCode: undefined,
        startDate: undefined,
        endDate: undefined,
        limit: 100,
        offset: 0,
      });
    });

    it('passes query filters to getConversionEvents', async () => {
      mockGetConversionEvents.mockResolvedValueOnce([]);

      const params = new URLSearchParams({
        conversionPointId: 'cp-1',
        friendId: 'fr-2',
        affiliateCode: 'AFF100',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        limit: '50',
        offset: '10',
      });

      const res = await app.request(
        `/api/conversions/events?${params.toString()}`,
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockGetConversionEvents).toHaveBeenCalledWith(env.DB, {
        conversionPointId: 'cp-1',
        friendId: 'fr-2',
        affiliateCode: 'AFF100',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        limit: 50,
        offset: 10,
      });
    });

    it('returns 500 on DB error', async () => {
      mockGetConversionEvents.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/events',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // ── GET /api/conversions/report ─────────────────────────────────────────

  describe('GET /api/conversions/report', () => {
    it('returns aggregated report', async () => {
      const mockReport = [
        {
          conversionPointId: 'cp-1',
          conversionPointName: 'Purchase',
          eventType: 'purchase',
          totalCount: 10,
          totalValue: 5000,
        },
      ];
      mockGetConversionReport.mockResolvedValueOnce(mockReport);

      const res = await app.request(
        '/api/conversions/report',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{
          conversionPointId: string;
          conversionPointName: string;
          eventType: string;
          totalCount: number;
          totalValue: number;
        }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].totalCount).toBe(10);
      expect(json.data[0].totalValue).toBe(5000);
    });

    it('passes date filters to getConversionReport', async () => {
      mockGetConversionReport.mockResolvedValueOnce([]);

      const params = new URLSearchParams({
        startDate: '2025-01-01',
        endDate: '2025-06-30',
      });

      const res = await app.request(
        `/api/conversions/report?${params.toString()}`,
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockGetConversionReport).toHaveBeenCalledWith(env.DB, {
        startDate: '2025-01-01',
        endDate: '2025-06-30',
      });
    });

    it('passes undefined dates when no query params', async () => {
      mockGetConversionReport.mockResolvedValueOnce([]);

      await app.request(
        '/api/conversions/report',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(mockGetConversionReport).toHaveBeenCalledWith(env.DB, {
        startDate: undefined,
        endDate: undefined,
      });
    });

    it('returns 500 on DB error', async () => {
      mockGetConversionReport.mockRejectedValueOnce(new Error('DB failure'));

      const res = await app.request(
        '/api/conversions/report',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(500);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });
});
