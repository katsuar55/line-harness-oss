/**
 * Tests for rank-discount issuance wiring in the monthly loyalty-rank cron (Task#2).
 *
 * Verifies the previously-DEAD backend (issueRankDiscountForFriend had zero prod callers)
 * is now invoked: non-regular ranks get a discount issued (idempotent/gated by the issuer),
 * regular (0%) ranks are skipped, and discountsIssued is counted.
 *
 * The issuer is mocked so no Shopify network/gate logic runs here — we test the WIRING.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIssue } = vi.hoisted(() => ({ mockIssue: vi.fn() }));

vi.mock('../services/rank-discount-issuer.js', () => ({
  issueRankDiscountForFriend: mockIssue,
}));

import {
  processLoyaltyRankReeval,
  type LoyaltyRankCronEnv,
} from '../services/loyalty-rank-cron.js';

interface EvtSeed {
  friend_id: string;
  amount_jpy: number;
  applied_at: string | null;
  created_at: string;
}

function makeDb(members: string[], events: EvtSeed[]): D1Database {
  function prepare(sql: string) {
    const params: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) {
        params.push(...a);
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes('SUM(amount_jpy)')) {
          const [fid, since] = params as [string, string];
          const total = events
            .filter((e) => e.friend_id === fid && e.applied_at != null && e.created_at >= since)
            .reduce((s, e) => s + e.amount_jpy, 0);
          return { total } as unknown as T;
        }
        // getPreviousRankSnapshot → none (= 'initial')
        return null;
      },
      async all<T>(): Promise<{ results: T[]; success: boolean }> {
        if (sql.includes('FROM members')) {
          return { results: members.map((friend_id) => ({ friend_id })) as unknown as T[], success: true };
        }
        return { results: [], success: true };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

const NOW = new Date('2026-06-08T00:00:00.000Z');
const RECENT = '2026-05-15T00:00:00.000+09:00';

function makeEnv(db: D1Database): LoyaltyRankCronEnv {
  return { DB: db, LOYALTY_RANK_CRON_FORCE: 'true' } as LoyaltyRankCronEnv;
}

describe('loyalty-rank cron — rank discount issuance wiring', () => {
  beforeEach(() => {
    mockIssue.mockReset();
    mockIssue.mockResolvedValue({
      code: 'NLR-SILVER-XXXX',
      discountPercent: 4,
      rankId: 'silver',
      expiresAt: null,
      isExisting: false,
      shopifyDiscountNodeId: 'gid://shopify/DiscountCodeNode/1',
    });
  });

  it('issues a discount for a non-regular (silver) member', async () => {
    const db = makeDb(
      ['f-silver'],
      [{ friend_id: 'f-silver', amount_jpy: 15000, applied_at: RECENT, created_at: RECENT }],
    );
    const result = await processLoyaltyRankReeval(makeEnv(db), { now: NOW });

    expect(mockIssue).toHaveBeenCalledTimes(1);
    const callArgs = mockIssue.mock.calls[0];
    expect(callArgs[2]).toMatchObject({ friendId: 'f-silver', rankId: 'silver', discountPercent: 4 });
    expect(result.discountsIssued).toBe(1);
  });

  it('does NOT issue for a regular (¥0, 0%) member', async () => {
    const db = makeDb(['f-regular'], []);
    const result = await processLoyaltyRankReeval(makeEnv(db), { now: NOW });

    expect(mockIssue).not.toHaveBeenCalled();
    expect(result.discountsIssued).toBe(0);
  });

  it('counts only newly-issued (isExisting=false) discounts', async () => {
    mockIssue.mockResolvedValue({
      code: 'NLR-SILVER-OLD',
      discountPercent: 4,
      rankId: 'silver',
      expiresAt: null,
      isExisting: true, // already issued previously
      shopifyDiscountNodeId: 'gid://shopify/DiscountCodeNode/1',
    });
    const db = makeDb(
      ['f-silver'],
      [{ friend_id: 'f-silver', amount_jpy: 15000, applied_at: RECENT, created_at: RECENT }],
    );
    const result = await processLoyaltyRankReeval(makeEnv(db), { now: NOW });

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(result.discountsIssued).toBe(0);
  });

  it('a thrown issuer does not break rank snapshotting (best-effort)', async () => {
    mockIssue.mockRejectedValue(new Error('shopify down'));
    const db = makeDb(
      ['f-silver'],
      [{ friend_id: 'f-silver', amount_jpy: 15000, applied_at: RECENT, created_at: RECENT }],
    );
    const result = await processLoyaltyRankReeval(makeEnv(db), { now: NOW });

    // snapshot still recorded (initial baseline), cron did not error out
    expect(result.errors).toBe(0);
    expect(result.candidates).toBe(1);
    expect(result.discountsIssued).toBe(0);
  });
});
