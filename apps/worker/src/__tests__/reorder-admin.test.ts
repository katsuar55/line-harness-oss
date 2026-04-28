/**
 * Tests for reorder-admin routes (Phase 6 PR-5).
 *
 * Covers:
 *   - GET    /api/admin/reorder/summary           — from/to validation, totals + bySource
 *   - GET    /api/admin/reorder/cross-sell        — listCrossSellRules passthrough
 *   - PUT    /api/admin/reorder/cross-sell        — validation + upsert dispatch
 *   - DELETE /api/admin/reorder/cross-sell        — query param validation + dispatch
 *   - GET    /api/admin/reorder/product-intervals — listProductIntervals passthrough
 *   - PUT    /api/admin/reorder/product-intervals — validation + upsert dispatch + clamp
 *   - DELETE /api/admin/reorder/product-intervals/:id
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
    upsertCrossSellRule: vi.fn(),
    listCrossSellRules: vi.fn(),
    deleteCrossSellRule: vi.fn(),
    upsertProductInterval: vi.fn(),
    listProductIntervals: vi.fn(),
    deleteProductInterval: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async multicast() {}
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { reorderAdmin } from '../routes/reorder-admin.js';
import type { Env } from '../index.js';
import {
  upsertCrossSellRule,
  listCrossSellRules,
  deleteCrossSellRule,
  upsertProductInterval,
  listProductIntervals,
  deleteProductInterval,
} from '@line-crm/db';

const mockUpsertCrossSellRule = upsertCrossSellRule as ReturnType<typeof vi.fn>;
const mockListCrossSellRules = listCrossSellRules as ReturnType<typeof vi.fn>;
const mockDeleteCrossSellRule = deleteCrossSellRule as ReturnType<typeof vi.fn>;
const mockUpsertProductInterval = upsertProductInterval as ReturnType<typeof vi.fn>;
const mockListProductIntervals = listProductIntervals as ReturnType<typeof vi.fn>;
const mockDeleteProductInterval = deleteProductInterval as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', reorderAdmin);
  return app;
}

interface MockDbOptions {
  /** summary endpoint の COUNT/SUM 集計 row */
  summaryAggRow?: { enrolled: number; active: number; pushed: number } | null;
  /** summary endpoint の pushedRecent row */
  pushedRecentRow?: { n: number } | null;
  /** summary endpoint の bySource rows */
  bySourceRows?: Array<{ source: string; count: number; active: number }>;
  /** summary endpoint の recent rows */
  recentRows?: unknown[];
}

function createMockDb(opts: MockDbOptions = {}): D1Database {
  function pickFirst(sql: string): unknown | null {
    if (sql.includes('COUNT(*) AS enrolled')) return opts.summaryAggRow ?? null;
    if (sql.includes('COUNT(*) AS n') && sql.includes('last_sent_at')) {
      return opts.pushedRecentRow ?? null;
    }
    return null;
  }
  function pickAll(sql: string): { results: unknown[]; success: true } {
    if (sql.includes('GROUP BY COALESCE(interval_source')) {
      return { results: opts.bySourceRows ?? [], success: true };
    }
    if (sql.includes('LEFT JOIN friends')) {
      return { results: opts.recentRows ?? [], success: true };
    }
    return { results: [], success: true };
  }

  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => pickFirst(sql)),
        all: vi.fn(async () => pickAll(sql)),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => pickFirst(sql)),
      all: vi.fn(async () => pickAll(sql)),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env['Bindings'] {
  return {
    DB: db,
    LINE_CHANNEL_SECRET: '',
    LINE_CHANNEL_ACCESS_TOKEN: '',
    API_KEY: TEST_API_KEY,
    ANTHROPIC_API_KEY: '',
    LIFF_URL: '',
    LINE_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_SECRET: '',
    WORKER_URL: '',
    AI: {} as never,
    IMAGES: {} as never,
  } as unknown as Env['Bindings'];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/admin/reorder/summary
// ---------------------------------------------------------------------------

describe('GET /api/admin/reorder/summary', () => {
  it('400 when from/to missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/summary',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 when date format invalid', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/summary?from=bad&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 when from > to', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/summary?from=2026-02-01&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200 returns aggregated totals + bySource + recent', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        summaryAggRow: { enrolled: 50, active: 40, pushed: 10 },
        pushedRecentRow: { n: 7 },
        bySourceRows: [
          { source: 'auto_estimated', count: 30, active: 25 },
          { source: 'fallback', count: 15, active: 10 },
          { source: 'product_default', count: 5, active: 5 },
        ],
        recentRows: [
          {
            id: 'sr-1',
            friend_id: 'friend-1',
            display_name: '加藤',
            product_title: 'プロテイン30日分',
            interval_days: 30,
            interval_source: 'auto_estimated',
            next_reminder_at: '2026-02-01T00:00:00Z',
            last_sent_at: null,
            is_active: 1,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );

    const res = await app.request(
      '/api/admin/reorder/summary?from=2026-01-01&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        totals: { enrolled: number; active: number; pushed: number; pushedRecent: number };
        bySource: { source: string; count: number; active: number }[];
        recent: Array<Record<string, unknown>>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.totals).toEqual({
      enrolled: 50,
      active: 40,
      pushed: 10,
      pushedRecent: 7,
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    expect(body.data.bySource.length).toBe(3);
    expect(body.data.bySource[0]).toEqual({
      source: 'auto_estimated',
      count: 30,
      active: 25,
    });
    expect(body.data.recent.length).toBe(1);
    expect(body.data.recent[0].friendName).toBe('加藤');
    expect(body.data.recent[0].isActive).toBe(true);
  });

  it('401 when unauthenticated', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/summary?from=2026-01-01&to=2026-01-31',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Cross-sell endpoints
// ---------------------------------------------------------------------------

describe('Cross-sell endpoints', () => {
  it('GET passes sourceProductId to listCrossSellRules', async () => {
    mockListCrossSellRules.mockResolvedValueOnce([{ source_product_id: 'p1' }]);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell?sourceProductId=100',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockListCrossSellRules).toHaveBeenCalledWith(expect.anything(), {
      sourceProductId: '100',
      limit: 200,
    });
  });

  it('PUT 400 when source/recommended missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sourceProductId: '100' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockUpsertCrossSellRule).not.toHaveBeenCalled();
  });

  it('PUT 400 when source === recommended', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sourceProductId: '100', recommendedProductId: '100' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockUpsertCrossSellRule).not.toHaveBeenCalled();
  });

  it('PUT 200 dispatches with priority clamp', async () => {
    mockUpsertCrossSellRule.mockResolvedValueOnce(undefined);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourceProductId: '100',
          recommendedProductId: '200',
          reason: '相性',
          priority: 9999,
          isActive: false,
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertCrossSellRule).toHaveBeenCalledWith(expect.anything(), {
      sourceProductId: '100',
      recommendedProductId: '200',
      reason: '相性',
      priority: 1000, // clamped from 9999 to 1000
      isActive: false,
    });
  });

  it('DELETE 400 when params missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell?sourceProductId=100',
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('DELETE 200 dispatches deleteCrossSellRule', async () => {
    mockDeleteCrossSellRule.mockResolvedValueOnce(undefined);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/cross-sell?sourceProductId=100&recommendedProductId=200',
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockDeleteCrossSellRule).toHaveBeenCalledWith(expect.anything(), '100', '200');
  });
});

// ---------------------------------------------------------------------------
// Product-intervals endpoints
// ---------------------------------------------------------------------------

describe('Product-intervals endpoints', () => {
  it('GET passes through to listProductIntervals', async () => {
    mockListProductIntervals.mockResolvedValueOnce([{ shopify_product_id: 'p1' }]);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockListProductIntervals).toHaveBeenCalled();
  });

  it('PUT 400 when shopifyProductId missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ defaultIntervalDays: 30 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('PUT 400 when defaultIntervalDays not number', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ shopifyProductId: 'p1' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('PUT 400 when source is unknown', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shopifyProductId: 'p1',
          defaultIntervalDays: 30,
          source: 'INVALID',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('PUT 200 clamps defaultIntervalDays to [7,90]', async () => {
    mockUpsertProductInterval.mockResolvedValueOnce(undefined);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shopifyProductId: 'p1',
          productTitle: 'X',
          defaultIntervalDays: 999,
          source: 'manual',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertProductInterval).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shopifyProductId: 'p1',
        defaultIntervalDays: 90, // clamped
        source: 'manual',
      }),
    );
  });

  it('DELETE :id dispatches', async () => {
    mockDeleteProductInterval.mockResolvedValueOnce(undefined);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/reorder/product-intervals/p1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockDeleteProductInterval).toHaveBeenCalledWith(expect.anything(), 'p1');
  });
});
