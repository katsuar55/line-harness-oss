/**
 * Tests for lazy rank-discount issuance in the my-rank LIFF (Task#2).
 *
 * Verifies the wiring: when a member views their card and is eligible (non-regular rank)
 * but has no active discount, the issuer is invoked; it is skipped for regular (0%) ranks
 * and when an active discount already exists. The issuer is mocked (no Shopify/gate logic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const { mockIssue } = vi.hoisted(() => ({ mockIssue: vi.fn() }));

vi.mock('../services/rank-discount-issuer.js', () => ({
  issueRankDiscountForFriend: mockIssue,
}));

import { liffMyRank } from '../routes/liff-my-rank.js';

interface RankDiscountRowLike {
  id: string;
  friend_id: string;
  rank_id: string;
  code: string;
  shopify_discount_node_id: string | null;
  discount_percent: number;
  status: string;
  brand_id: string | null;
  issued_at: string;
  expires_at: string | null;
}

function makeDb(trailingTotal: number, rankDiscount: RankDiscountRowLike | null = null): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends')) {
            return { id: 'f1', line_user_id: 'U1', shopify_customer_id: '123', line_account_id: null } as unknown as T;
          }
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: trailingTotal } as unknown as T;
          }
          if (sql.includes('loyalty_rank_discounts') && sql.includes("status = 'active'")) {
            return (rankDiscount ?? null) as unknown as T | null;
          }
          if (sql.includes('loyalty_rank_snapshots')) {
            return null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeApp() {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    (c as { set: (k: string, v: unknown) => void }).set('liffUser', { lineUserId: 'U1', friendId: 'f1' });
    await next();
  });
  app.route('/', liffMyRank);
  return app;
}

async function callApi(db: D1Database) {
  const res = await makeApp().request(
    '/api/liff/my-rank',
    undefined,
    { DB: db, RANK_DISCOUNT_ENABLED: 'true' } as unknown as Env['Bindings'],
  );
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any } };
}

describe('my-rank LIFF — lazy rank discount issuance', () => {
  beforeEach(() => {
    mockIssue.mockReset();
    mockIssue.mockResolvedValue(null); // simulate gated-off / no-op by default
  });

  it('issues lazily for an eligible (silver) member with no active discount', async () => {
    const { status } = await callApi(makeDb(15000, null));
    expect(status).toBe(200);
    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue.mock.calls[0][2]).toMatchObject({
      friendId: 'f1',
      rankId: 'silver',
      discountPercent: 4,
    });
  });

  it('does NOT issue for a regular (¥0) member', async () => {
    await callApi(makeDb(0, null));
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it('does NOT issue when an active discount already exists', async () => {
    const existing: RankDiscountRowLike = {
      id: 'd1', friend_id: 'f1', rank_id: 'silver', code: 'NLR-SILVER-OLD',
      shopify_discount_node_id: 'gid', discount_percent: 4, status: 'active',
      brand_id: null, issued_at: '2026-06-01T00:00:00+09:00', expires_at: null,
    };
    const { body } = await callApi(makeDb(15000, existing));
    expect(mockIssue).not.toHaveBeenCalled();
    expect(body.data.rankDiscount).toEqual({ discountPercent: 4 });
  });
});
