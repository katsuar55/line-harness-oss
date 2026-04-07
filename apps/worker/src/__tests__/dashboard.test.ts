/**
 * Tests for Dashboard routes (Phase 3 Stage 7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, jstNow: vi.fn(() => '2026-04-07T10:00:00+09:00') };
});

import { dashboard } from '../routes/dashboard.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', dashboard);
  return app;
}

function mockD1() {
  return {
    prepare: vi.fn(() => {
      const self = {
        bind: vi.fn(() => self),
        first: vi.fn(async () => ({ total: 100, following: 85, new_7d: 5, total_orders: 50, total_revenue: 250000, orders_30d: 12, revenue_30d: 60000, active_users: 30, total_logs: 200, logs_7d: 45 })),
        all: vi.fn(async () => ({
          results: [
            { date: '2026-04-05', new_friends: 3, unfollowed: 1, orders: 2, revenue: 15000, name: 'Silver', color: '#C0C0C0', count: 10 },
            { date: '2026-04-06', new_friends: 5, unfollowed: 0, orders: 3, revenue: 22000, name: 'Gold', color: '#FFD700', count: 5 },
          ],
        })),
      };
      return self;
    }),
  };
}

function req(app: Hono, path: string) {
  return app.request(`http://localhost${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${API_KEY}` },
  }, { DB: mockD1() });
}

describe('Dashboard API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /api/dashboard/summary returns stats', async () => {
    const app = createApp();
    const res = await req(app, '/api/dashboard/summary');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
    const data = json.data as Record<string, unknown>;
    expect(data.friends).toBeDefined();
    expect(data.orders).toBeDefined();
    expect(data.intake).toBeDefined();
    expect(data.referrals).toBeDefined();
  });

  it('GET /api/dashboard/friends-trend returns trend data', async () => {
    const app = createApp();
    const res = await req(app, '/api/dashboard/friends-trend?days=30');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
    const data = json.data as { trend: unknown[] };
    expect(Array.isArray(data.trend)).toBe(true);
  });

  it('GET /api/dashboard/revenue-trend returns revenue data', async () => {
    const app = createApp();
    const res = await req(app, '/api/dashboard/revenue-trend?days=30');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  it('GET /api/dashboard/rank-distribution returns distribution', async () => {
    const app = createApp();
    const res = await req(app, '/api/dashboard/rank-distribution');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  it('clamps days parameter to 7-90', async () => {
    const app = createApp();
    const res = await req(app, '/api/dashboard/friends-trend?days=200');
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { days: number } };
    expect(json.data.days).toBe(90);
  });

  it('requires auth', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/api/dashboard/summary', {}, { DB: mockD1() });
    expect(res.status).toBe(401);
  });
});
