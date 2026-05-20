/**
 * Tests for /api/line-friend-coupons (Phase 5β-1d-2-followup admin UI route).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import { lineFriendCoupons } from '../routes/line-friend-coupons.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', lineFriendCoupons);
  return app;
}

function mockD1(opts: { rows?: Array<Record<string, unknown>>; total?: number } = {}) {
  const rows = opts.rows ?? [];
  const total = opts.total ?? rows.length;
  return {
    prepare: vi.fn((sql: string) => {
      const isCount = /SELECT\s+COUNT\(/i.test(sql);
      const isSelect = /SELECT\s+c\.id/i.test(sql);
      const self = {
        bind: vi.fn(() => self),
        first: vi.fn(async () => {
          if (isCount) return { n: total };
          return null;
        }),
        all: vi.fn(async () => {
          if (isSelect) return { results: rows };
          return { results: [] };
        }),
      };
      return self;
    }),
  };
}

describe('GET /api/line-friend-coupons', () => {
  beforeEach(() => vi.clearAllMocks());

  it('default pagination returns coupons + total + hasMore', async () => {
    const app = createApp();
    const fakeRows = [
      {
        id: 'c1',
        friend_id: 'f1',
        display_name: '加藤勝久',
        coupon_code: 'LINE-ABCD1234',
        discount_value: 500,
        discount_currency: 'JPY',
        issued_at: '2026-05-20T01:46:00.000+09:00',
        expires_at: '2026-08-18T01:46:00.000+09:00',
        status: 'issued',
        source: 'shopify',
        created_at: '2026-05-20T01:46:00.000+09:00',
      },
    ];
    const res = await app.request(
      'http://localhost/api/line-friend-coupons',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1({ rows: fakeRows, total: 1 }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { coupons: Array<{ id: string }>; total: number; limit: number; offset: number; hasMore: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.coupons.length).toBe(1);
    expect(json.data.coupons[0].id).toBe('c1');
    expect(json.data.total).toBe(1);
    expect(json.data.limit).toBe(100);
    expect(json.data.offset).toBe(0);
    expect(json.data.hasMore).toBe(false);
  });

  it('limit clamp max 500', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?limit=9999',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    const json = (await res.json()) as { data: { limit: number } };
    expect(json.data.limit).toBe(500);
  });

  it('limit clamp min 1', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?limit=0',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    const json = (await res.json()) as { data: { limit: number } };
    expect(json.data.limit).toBe(1);
  });

  it('hasMore=true when more rows exist', async () => {
    const app = createApp();
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      friend_id: 'f',
      display_name: 'X',
      coupon_code: `LINE-${i}`,
      discount_value: 500,
      discount_currency: 'JPY',
      issued_at: '2026-05-20T00:00:00.000+09:00',
      expires_at: null,
      status: 'issued',
      source: 'shopify',
      created_at: '2026-05-20T00:00:00.000+09:00',
    }));
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?limit=10',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1({ rows, total: 50 }) },
    );
    const json = (await res.json()) as { data: { hasMore: boolean } };
    expect(json.data.hasMore).toBe(true);
  });

  it('rejects invalid status with 400', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?status=invalid',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('invalid status');
  });

  it('rejects invalid source with 400', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?source=bogus',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('invalid source');
  });

  it('accepts valid status=issued', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?status=issued',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('accepts valid status=redeemed', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?status=redeemed',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('accepts friendId filter (= 特定 friend の coupon 一覧)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons?friendId=38215b51-9c9c',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('requires auth (401)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-friend-coupons',
      { method: 'GET' },
      { DB: mockD1() },
    );
    expect(res.status).toBe(401);
  });

  it('handles D1 error gracefully (500)', async () => {
    const app = createApp();
    const failingDb = {
      prepare: vi.fn(() => {
        throw new Error('D1 unavailable');
      }),
    };
    const res = await app.request(
      'http://localhost/api/line-friend-coupons',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: failingDb },
    );
    expect(res.status).toBe(500);
  });
});
