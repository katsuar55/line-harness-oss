/**
 * Tests for /api/membership route (= Phase 4-η、 2026-05-28)
 *
 * カバー範囲:
 *   - GET /api/membership/stats (= totalMembers + byTier + tiers)
 *   - GET /api/membership/tiers
 *   - GET /api/membership/members (= filter + list)
 *   - POST /api/membership/members/:friendId/promote: happy / not found / already in tier / no body
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Hono as HonoType } from 'hono';

// ============================================================
// Mock @line-crm/db
// ============================================================

const state = {
  tiers: [
    {
      id: 'bronze',
      name: 'ブロンズ',
      displayOrder: 1,
      minTotalPurchaseJpy: 0,
      minReferralCount: 0,
      perks: {},
      badgeEmoji: '🥉',
      badgeColor: '#cd7f32',
      isActive: true,
    },
    {
      id: 'silver',
      name: 'シルバー',
      displayOrder: 2,
      minTotalPurchaseJpy: 10000,
      minReferralCount: 0,
      perks: { discountPercent: 3 },
      badgeEmoji: '🥈',
      badgeColor: '#c0c0c0',
      isActive: true,
    },
  ],
  members: new Map<string, { id: string; friendId: string; currentTierId: string }>(),
  stats: {
    totalMembers: 0,
    byTier: {} as Record<string, { count: number; totalPurchaseJpy: number }>,
  },
  upsertCalls: [] as Array<{ friendId: string; currentTierId?: string }>,
};

vi.mock('@line-crm/db', () => ({
  listMembershipTiers: vi.fn(async () => state.tiers),
  getMembershipStats: vi.fn(async () => state.stats),
  getMembersByTier: vi.fn(async () => []),
  getMemberByFriendId: vi.fn(async (_db: unknown, friendId: string) => {
    return state.members.get(friendId) ?? null;
  }),
  getMembershipTierById: vi.fn(async (_db: unknown, tierId: string) => {
    return state.tiers.find((t) => t.id === tierId) ?? null;
  }),
  upsertMember: vi.fn(async (_db: unknown, input: { friendId: string; currentTierId?: string }) => {
    state.upsertCalls.push(input);
    const existing = state.members.get(input.friendId);
    if (existing && input.currentTierId) {
      existing.currentTierId = input.currentTierId;
    }
    return { inserted: false };
  }),
  jstNow: () => '2026-05-28T01:00:00.000',
}));

async function loadRoute() {
  const mod = await import('../routes/membership.js');
  return mod.membership;
}

function makeApp(route: HonoType<any, any, any>): HonoType<any, any, any> {
  return new Hono().route('/', route as any);
}

function fakeDb(rows: Record<string, unknown>[] = []): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success: true }),
      }),
      first: async () => rows[0] ?? null,
    }),
  } as unknown as D1Database;
}

// ============================================================
// Stats
// ============================================================

describe('GET /api/membership/stats', () => {
  beforeEach(() => {
    state.stats = {
      totalMembers: 1,
      byTier: { bronze: { count: 1, totalPurchaseJpy: 0 } },
    };
  });

  it('returns total + byTier + tiers', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request('http://x/api/membership/stats', {}, { DB: fakeDb() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: any };
    expect(json.success).toBe(true);
    expect(json.data.totalMembers).toBe(1);
    expect(json.data.tiers).toHaveLength(2);
    expect(json.data.byTier.bronze.count).toBe(1);
  });
});

// ============================================================
// Tiers
// ============================================================

describe('GET /api/membership/tiers', () => {
  it('returns active tier list', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request('http://x/api/membership/tiers', {}, { DB: fakeDb() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: any[] };
    expect(json.data.map((t: any) => t.id)).toEqual(['bronze', 'silver']);
  });
});

// ============================================================
// Members
// ============================================================

describe('GET /api/membership/members', () => {
  it('returns list + total', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const db = fakeDb([
      {
        id: 'm-1',
        friend_id: 'f-1',
        current_tier_id: 'bronze',
        total_purchase_jpy: 0,
        total_referral_count: 0,
        last_purchase_at: null,
        last_promotion_at: null,
        joined_at: '2026-05-01T00:00:00.000',
        display_name: 'Katsu',
        line_user_id: 'U123',
      },
    ]);
    // total query は first() のため、 同じ db で first({n:1}) を返したい:
    const dbWithTotal = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({
            results: sql.includes('FROM members m')
              ? [
                  {
                    id: 'm-1',
                    friend_id: 'f-1',
                    current_tier_id: 'bronze',
                    total_purchase_jpy: 0,
                    total_referral_count: 0,
                    last_purchase_at: null,
                    last_promotion_at: null,
                    joined_at: '2026-05-01T00:00:00.000',
                    display_name: 'Katsu',
                    line_user_id: 'U123',
                  },
                ]
              : [],
          }),
          first: async () => ({ n: 1 }),
          run: async () => ({ success: true }),
        }),
        first: async () => ({ n: 1 }),
      }),
    } as unknown as D1Database;

    const res = await app.request('http://x/api/membership/members', {}, { DB: dbWithTotal });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: any };
    expect(json.data.members).toHaveLength(1);
    expect(json.data.total).toBe(1);
  });
});

// ============================================================
// Promote
// ============================================================

describe('POST /api/membership/members/:friendId/promote', () => {
  beforeEach(() => {
    state.members.clear();
    state.upsertCalls = [];
    state.members.set('f-1', {
      id: 'm-1',
      friendId: 'f-1',
      currentTierId: 'bronze',
    });
  });

  it('promotes to silver, records audit', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request(
      'http://x/api/membership/members/f-1/promote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toTierId: 'silver', reason: 'test' }),
      },
      { DB: fakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: any };
    expect(json.data.fromTier).toBe('bronze');
    expect(json.data.toTier).toBe('silver');
    expect(json.data.promoted).toBe(true);
    expect(state.upsertCalls).toHaveLength(1);
  });

  it('no-op when already in tier', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request(
      'http://x/api/membership/members/f-1/promote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toTierId: 'bronze' }),
      },
      { DB: fakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: any };
    expect(json.data.promoted).toBe(false);
    expect(state.upsertCalls).toHaveLength(0);
  });

  it('400 when toTierId missing', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request(
      'http://x/api/membership/members/f-1/promote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      { DB: fakeDb() },
    );
    expect(res.status).toBe(400);
  });

  it('404 when tier not found', async () => {
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request(
      'http://x/api/membership/members/f-1/promote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toTierId: 'unknown' }),
      },
      { DB: fakeDb() },
    );
    expect(res.status).toBe(404);
  });

  it('404 when member not found', async () => {
    state.members.clear();
    const route = await loadRoute();
    const app = makeApp(route);
    const res = await app.request(
      'http://x/api/membership/members/missing/promote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toTierId: 'silver' }),
      },
      { DB: fakeDb() },
    );
    expect(res.status).toBe(404);
  });
});
