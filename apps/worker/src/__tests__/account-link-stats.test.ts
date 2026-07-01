/**
 * Tests for アカウント連携 現況集計 — 第2波-③ 支援 (2026-07-01)
 *   - getAccountLinkStats: 各 query の結果を正しく組み立てるか (unlinked=total-linked 等)
 *   - GET /api/admin/account-link/stats: 200/data・401(認証)・500(D1 error)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { getAccountLinkStats } from '@line-crm/db';
import { accountLinkAdmin } from '../routes/account-link-admin.js';

const API_KEY = 'test-api-key';

interface StatsFixture {
  total: number;
  following: number;
  linked: number;
  withEmail: number;
  candidates: number;
  ambiguous: number;
  members: number;
  withPurchaseEvents: number;
  shopifyCustomers: number;
  scope: string | null;
}

function fakeDb(fx: StatsFixture) {
  const route = (s: string): Record<string, unknown> => {
    if (s.includes('WITH friend_email')) return { candidates: fx.candidates, ambiguous: fx.ambiguous };
    if (s.includes('FROM shopify_tokens')) return { scope: fx.scope };
    if (s.includes('member_purchase_events')) return { n: fx.withPurchaseEvents };
    if (s.includes('FROM members')) return { n: fx.members };
    if (s.includes('FROM shopify_customers')) return { n: fx.shopifyCustomers };
    if (s.includes('is_following = 1')) return { n: fx.following };
    if (s.includes('shopify_customer_id IS NOT NULL')) return { n: fx.linked };
    if (s.includes('LEFT JOIN users')) return { n: fx.withEmail };
    return { n: fx.total }; // plain COUNT(*) FROM friends
  };
  return {
    prepare(sql: string) {
      const result = route(sql);
      const stmt = {
        bind: () => stmt,
        first: async () => result,
      };
      return stmt;
    },
  } as unknown as D1Database;
}

const BASE: StatsFixture = {
  total: 6583,
  following: 6400,
  linked: 120,
  withEmail: 1850,
  candidates: 300,
  ambiguous: 5,
  members: 1891,
  withPurchaseEvents: 90,
  shopifyCustomers: 1891,
  scope: 'read_orders,write_orders',
};

describe('getAccountLinkStats', () => {
  it('assembles counts and derives unlinked = total - linked', async () => {
    const stats = await getAccountLinkStats(fakeDb(BASE));
    expect(stats.friends.total).toBe(6583);
    expect(stats.friends.following).toBe(6400);
    expect(stats.friends.linked).toBe(120);
    expect(stats.friends.unlinked).toBe(6583 - 120);
    expect(stats.friends.withEmail).toBe(1850);
    expect(stats.bulkEmailMatch.candidates).toBe(300);
    expect(stats.bulkEmailMatch.ambiguous).toBe(5);
    expect(stats.members.count).toBe(1891);
    expect(stats.members.withPurchaseEvents).toBe(90);
    expect(stats.shopify.customers).toBe(1891);
    expect(stats.shopify.scope).toBe('read_orders,write_orders');
  });

  it('unlinked floors at 0 and scope null passes through', async () => {
    const stats = await getAccountLinkStats(fakeDb({ ...BASE, total: 100, linked: 200, scope: null }));
    expect(stats.friends.unlinked).toBe(0);
    expect(stats.shopify.scope).toBeNull();
  });
});

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', accountLinkAdmin);
  return app;
}

describe('GET /api/admin/account-link/stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the stats payload (200)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/account-link/stats',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: fakeDb(BASE) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { friends: { unlinked: number } } };
    expect(json.success).toBe(true);
    expect(json.data.friends.unlinked).toBe(6583 - 120);
  });

  it('requires auth (401)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/account-link/stats',
      { method: 'GET' },
      { DB: fakeDb(BASE) },
    );
    expect(res.status).toBe(401);
  });

  it('handles D1 error gracefully (500)', async () => {
    const app = createApp();
    const failingDb = {
      prepare: vi.fn(() => {
        throw new Error('D1 unavailable');
      }),
    } as unknown as D1Database;
    const res = await app.request(
      'http://localhost/api/admin/account-link/stats',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: failingDb },
    );
    expect(res.status).toBe(500);
  });
});
