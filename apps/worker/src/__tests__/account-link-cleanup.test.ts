/**
 * Tests for services/account-link-cleanup (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 期限切れ OTP (account_link_codes) の cleanup cron を検証 (= cron-cleanup.test.ts と同パターン)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHeartbeats: { jobName: string; status: string; metrics: unknown }[] = [];
let mockHeartbeatShouldFail = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(
    async (_db: unknown, input: { jobName: string; status: string; metrics?: unknown }) => {
      if (mockHeartbeatShouldFail) throw new Error('simulated insert failure');
      mockHeartbeats.push({ jobName: input.jobName, status: input.status, metrics: input.metrics });
    },
  ),
}));

interface FakeDeleteState {
  deleteCalls: { sql: string; params: unknown[] }[];
  changesToReturn: number;
  shouldThrow?: boolean;
}

function makeFakeDb(state: FakeDeleteState): D1Database {
  return {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async first<T>() { return null as T; },
            async all<T>() { return { results: [] as T[] }; },
            async run() {
              if (sql.startsWith('DELETE FROM account_link_codes')) {
                state.deleteCalls.push(call);
                if (state.shouldThrow) throw new Error('D1 down');
                return { success: true, meta: { changes: state.changesToReturn } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

beforeEach(() => {
  mockHeartbeats.length = 0;
  mockHeartbeatShouldFail = false;
});

describe('isAccountLinkCleanupWindow', () => {
  it('JST 03:10 ジャスト → true', async () => {
    const { __test__ } = await import('../services/account-link-cleanup.js');
    // JST 03:10 = UTC 18:10 (前日)
    expect(__test__.isAccountLinkCleanupWindow(new Date('2026-04-30T18:10:00Z'))).toBe(true);
  });

  it('JST 03:14 → true (5 分窓内)', async () => {
    const { __test__ } = await import('../services/account-link-cleanup.js');
    expect(__test__.isAccountLinkCleanupWindow(new Date('2026-04-30T18:14:00Z'))).toBe(true);
  });

  it('JST 03:15 → false (窓外)', async () => {
    const { __test__ } = await import('../services/account-link-cleanup.js');
    expect(__test__.isAccountLinkCleanupWindow(new Date('2026-04-30T18:15:00Z'))).toBe(false);
  });

  it('JST 03:00 → false (cron-cleanup の窓、 本 job 窓外)', async () => {
    const { __test__ } = await import('../services/account-link-cleanup.js');
    expect(__test__.isAccountLinkCleanupWindow(new Date('2026-04-30T18:00:00Z'))).toBe(false);
  });
});

describe('processAccountLinkCleanup', () => {
  it('窓外 → triggered=false, DELETE 呼ばれない', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 0 };
    const result = await processAccountLinkCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T05:00:00+09:00') }, // JST 05:00
    );
    expect(result).toEqual({ triggered: false, deletedRows: 0 });
    expect(state.deleteCalls).toHaveLength(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('窓内 → DELETE + heartbeat (cutoff = 1 日前)', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 42 };
    const now = new Date('2026-05-01T03:11:00+09:00'); // JST 03:11
    const result = await processAccountLinkCleanup({ DB: makeFakeDb(state) }, { now });

    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(42);
    expect(state.deleteCalls).toHaveLength(1);
    expect(state.deleteCalls[0]!.sql).toContain('account_link_codes');

    const cutoff = new Date(state.deleteCalls[0]!.params[0] as string);
    const expectedCutoff = new Date(now.getTime() - 1 * 24 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);

    expect(mockHeartbeats).toHaveLength(1);
    expect(mockHeartbeats[0]).toMatchObject({
      jobName: 'account-link-cleanup',
      status: 'success',
      metrics: { deletedRows: 42, retentionDays: 1 },
    });
  });

  it('FORCE=true で窓外でも triggered=true', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 3 };
    const result = await processAccountLinkCleanup(
      { DB: makeFakeDb(state), ACCOUNT_LINK_CLEANUP_FORCE: 'true' },
      { now: new Date('2026-05-01T15:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(3);
    expect(mockHeartbeats).toHaveLength(1);
  });

  it('retentionDays=7 で cutoff が 7 日前', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 0 };
    const now = new Date('2026-05-01T03:10:00+09:00');
    await processAccountLinkCleanup({ DB: makeFakeDb(state) }, { now, retentionDays: 7 });
    const cutoff = new Date(state.deleteCalls[0]!.params[0] as string);
    const expectedCutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
  });

  it('DELETE 失敗 → deletedRows=0 + 例外を投げない + heartbeat なし', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 0, shouldThrow: true };
    const result = await processAccountLinkCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T03:10:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('heartbeat insert 失敗でも例外を投げない (fail-safe)', async () => {
    const { processAccountLinkCleanup } = await import('../services/account-link-cleanup.js');
    mockHeartbeatShouldFail = true;
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 5 };
    const result = await processAccountLinkCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T03:10:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(5);
  });
});
