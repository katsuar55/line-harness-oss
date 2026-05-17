/**
 * Tests for GET /api/admin/email/opt-in/kpi (Phase 5β-1d-3).
 *
 * Covers:
 *   - days param validation (missing / non-numeric / 0 / 366)
 *   - aggregates outcome / channel counts from audit_logs (web/liff/new/re_consent/reactivated)
 *   - trend は window 全日 zero-pad (no opt-in 日も含む)
 *   - candidatesRemaining が shopify_customers JOIN クエリの結果を反映
 *   - buildZeroPaddedTrend 単体 (helper export)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    upsertEmailSubscriber: vi.fn(),
    unsubscribeById: vi.fn(),
    resubscribeById: vi.fn(),
    listEmailTemplates: vi.fn(),
    upsertEmailTemplate: vi.fn(),
    deleteEmailTemplate: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {},
}));

import { authMiddleware } from '../middleware/auth.js';
import { emailAdmin, __test__ as kpiTest } from '../routes/email-admin.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-kpi-12345';

interface MockKpiDbRows {
  totalsRow?: {
    all_count: number;
    new_count: number;
    re_consent_count: number;
    reactivated_count: number;
    web_count: number;
    liff_count: number;
  } | null;
  trendRows?: Array<{ date: string; count: number }>;
  candidatesRow?: { count: number } | null;
}

function createMockDb(rows: MockKpiDbRows = {}): D1Database {
  function pickFirst(sql: string): unknown | null {
    if (sql.includes("action = 'email.opt_in'") && sql.includes("SUM(CASE WHEN JSON_EXTRACT")) {
      return rows.totalsRow ?? null;
    }
    if (sql.includes('FROM shopify_customers sc') && sql.includes('LEFT JOIN email_subscribers')) {
      return rows.candidatesRow ?? null;
    }
    return null;
  }
  function pickAll(sql: string): { results: unknown[]; success: true } {
    if (sql.includes("action = 'email.opt_in'") && sql.includes('GROUP BY date')) {
      return { results: rows.trendRows ?? [], success: true };
    }
    return { results: [], success: true };
  }

  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => pickFirst(sql)),
        all: vi.fn(async () => pickAll(sql)),
      })),
      first: vi.fn(async () => pickFirst(sql)),
      all: vi.fn(async () => pickAll(sql)),
    })),
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

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', emailAdmin);
  return app;
}

const AUTH = { Authorization: `Bearer ${TEST_API_KEY}` };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/email/opt-in/kpi — validation', () => {
  it('200 when days omitted (default 30)', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb({ totalsRow: null, trendRows: [], candidatesRow: { count: 0 } }));
    const res = await app.request('/api/admin/email/opt-in/kpi', { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { window: { days: number } } };
    expect(body.data.window.days).toBe(30);
  });

  it('400 when days is non-numeric', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request('/api/admin/email/opt-in/kpi?days=abc', { headers: AUTH }, env);
    expect(res.status).toBe(400);
  });

  it('400 when days=0 (below min)', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request('/api/admin/email/opt-in/kpi?days=0', { headers: AUTH }, env);
    expect(res.status).toBe(400);
  });

  it('400 when days=366 (above max)', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request('/api/admin/email/opt-in/kpi?days=366', { headers: AUTH }, env);
    expect(res.status).toBe(400);
  });

  it('200 when days=365 (max boundary)', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({ totalsRow: null, trendRows: [], candidatesRow: { count: 0 } }),
    );
    const res = await app.request('/api/admin/email/opt-in/kpi?days=365', { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { window: { days: number } } };
    expect(body.data.window.days).toBe(365);
  });

  it('401 when no auth header', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request('/api/admin/email/opt-in/kpi', {}, env);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/email/opt-in/kpi — aggregates', () => {
  it('200 returns totals + zero-padded trend + candidatesRemaining', async () => {
    const app = createTestApp();
    const today = new Date().toISOString().slice(0, 10);

    const env = makeEnv(
      createMockDb({
        totalsRow: {
          all_count: 10,
          new_count: 6,
          re_consent_count: 3,
          reactivated_count: 1,
          web_count: 7,
          liff_count: 3,
        },
        trendRows: [{ date: today, count: 10 }],
        candidatesRow: { count: 1700 },
      }),
    );

    const res = await app.request('/api/admin/email/opt-in/kpi?days=7', { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        window: { days: number; fromDate: string; toDate: string };
        totals: {
          all: number;
          new: number;
          reConsent: number;
          reactivated: number;
          web: number;
          liff: number;
          other: number;
        };
        trend: Array<{ date: string; count: number }>;
        candidatesRemaining: number;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.window.days).toBe(7);
    expect(body.data.window.toDate).toBe(today);

    expect(body.data.totals).toEqual({
      all: 10,
      new: 6,
      reConsent: 3,
      reactivated: 1,
      web: 7,
      liff: 3,
      other: 0,
    });

    // Trend は 7 日分 zero-padded、 今日のみ 10、 他は 0
    expect(body.data.trend.length).toBe(7);
    expect(body.data.trend[body.data.trend.length - 1]).toEqual({ date: today, count: 10 });
    // First 6 days are zero
    for (let i = 0; i < 6; i++) {
      expect(body.data.trend[i].count).toBe(0);
    }

    expect(body.data.candidatesRemaining).toBe(1700);
  });

  it('200 handles null totalsRow as all-zero', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({ totalsRow: null, trendRows: [], candidatesRow: { count: 0 } }),
    );
    const res = await app.request('/api/admin/email/opt-in/kpi?days=3', { headers: AUTH }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        totals: { all: number; new: number; reConsent: number; reactivated: number; other: number };
        trend: Array<{ count: number }>;
        candidatesRemaining: number;
      };
    };
    expect(body.data.totals).toEqual({
      all: 0,
      new: 0,
      reConsent: 0,
      reactivated: 0,
      web: 0,
      liff: 0,
      other: 0,
    });
    expect(body.data.trend.length).toBe(3);
    expect(body.data.trend.every((d) => d.count === 0)).toBe(true);
    expect(body.data.candidatesRemaining).toBe(0);
  });

  it('computes "other" correctly when outcome metadata missing (all - known)', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        totalsRow: {
          all_count: 10,
          new_count: 3,
          re_consent_count: 2,
          reactivated_count: 1,
          web_count: 5,
          liff_count: 5,
        },
        trendRows: [],
        candidatesRow: { count: 0 },
      }),
    );
    const res = await app.request('/api/admin/email/opt-in/kpi?days=7', { headers: AUTH }, env);
    const body = (await res.json()) as { data: { totals: { other: number } } };
    // 10 - (3 + 2 + 1) = 4
    expect(body.data.totals.other).toBe(4);
  });
});

describe('buildZeroPaddedTrend (helper)', () => {
  it('produces N entries with zero-pad for missing dates', () => {
    const fromMs = new Date('2026-05-01T00:00:00.000Z').getTime();
    const rows = [
      { date: '2026-05-02', count: 3 },
      { date: '2026-05-04', count: 7 },
    ];
    const out = kpiTest.buildZeroPaddedTrend(fromMs, 5, rows);
    expect(out).toEqual([
      { date: '2026-05-01', count: 0 },
      { date: '2026-05-02', count: 3 },
      { date: '2026-05-03', count: 0 },
      { date: '2026-05-04', count: 7 },
      { date: '2026-05-05', count: 0 },
    ]);
  });

  it('returns empty array when days=0 (defensive, although endpoint clamps min=1)', () => {
    const out = kpiTest.buildZeroPaddedTrend(Date.now(), 0, []);
    expect(out).toEqual([]);
  });

  it('coerces non-numeric counts to 0', () => {
    const fromMs = new Date('2026-05-01T00:00:00.000Z').getTime();
    const rows = [{ date: '2026-05-01', count: Number.NaN as unknown as number }];
    const out = kpiTest.buildZeroPaddedTrend(fromMs, 1, rows);
    expect(out).toEqual([{ date: '2026-05-01', count: 0 }]);
  });
});

describe('kpi constants', () => {
  it('exports sensible defaults', () => {
    expect(kpiTest.KPI_DAYS_DEFAULT).toBe(30);
    expect(kpiTest.KPI_DAYS_MIN).toBe(1);
    expect(kpiTest.KPI_DAYS_MAX).toBe(365);
  });
});
