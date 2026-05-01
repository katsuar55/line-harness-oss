/**
 * Tests for services/cron-cleanup (Phase 7 - 2026-05-01)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHeartbeats: { jobName: string; status: string; metrics: unknown }[] = [];
let mockHeartbeatShouldFail = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(
    async (
      _db: unknown,
      input: { jobName: string; status: string; metrics?: unknown },
    ) => {
      if (mockHeartbeatShouldFail) throw new Error('simulated insert failure');
      mockHeartbeats.push({
        jobName: input.jobName,
        status: input.status,
        metrics: input.metrics,
      });
    },
  ),
}));

interface FakeDeleteState {
  /** DELETE 文の bind 値を記録 */
  deleteCalls: { sql: string; params: unknown[] }[];
  /** DELETE が返す changes 数 */
  changesToReturn: number;
  /** DELETE が throw するか */
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
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.startsWith('DELETE FROM cron_run_logs')) {
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

// ============================================================
// gating (純関数)
// ============================================================

describe('isCleanupWindow', () => {
  it('JST 03:00 ジャスト → true', async () => {
    const { __test__ } = await import('../services/cron-cleanup.js');
    // 2026-05-01 JST 03:00:00 = UTC 2026-04-30 18:00:00
    expect(__test__.isCleanupWindow(new Date('2026-04-30T18:00:00Z'))).toBe(true);
  });

  it('JST 03:04 → true (5 分窓内)', async () => {
    const { __test__ } = await import('../services/cron-cleanup.js');
    expect(__test__.isCleanupWindow(new Date('2026-04-30T18:04:00Z'))).toBe(true);
  });

  it('JST 03:05 → false (5 分窓外)', async () => {
    const { __test__ } = await import('../services/cron-cleanup.js');
    expect(__test__.isCleanupWindow(new Date('2026-04-30T18:05:00Z'))).toBe(false);
  });

  it('JST 02:59 → false', async () => {
    const { __test__ } = await import('../services/cron-cleanup.js');
    expect(__test__.isCleanupWindow(new Date('2026-04-30T17:59:00Z'))).toBe(false);
  });
});

// ============================================================
// processCronCleanup
// ============================================================

describe('processCronCleanup', () => {
  it('窓外で実行 → triggered=false, DELETE 呼ばれない', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 0 };
    const result = await processCronCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T05:00:00+09:00') }, // JST 05:00
    );
    expect(result).toEqual({ triggered: false, deletedRows: 0 });
    expect(state.deleteCalls).toHaveLength(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('窓内で実行 → DELETE + heartbeat', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 1234 };
    const now = new Date('2026-05-01T03:01:00+09:00'); // JST 03:01
    const result = await processCronCleanup(
      { DB: makeFakeDb(state) },
      { now },
    );

    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(1234);
    expect(state.deleteCalls).toHaveLength(1);

    // bind された cutoff は 30 日前
    const cutoff = new Date(state.deleteCalls[0]!.params[0] as string);
    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);

    // heartbeat 記録
    expect(mockHeartbeats).toHaveLength(1);
    expect(mockHeartbeats[0]).toMatchObject({
      jobName: 'cron-cleanup',
      status: 'success',
      metrics: { deletedRows: 1234, retentionDays: 30 },
    });
  });

  it('CRON_CLEANUP_FORCE=true で窓外でも triggered=true', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 7 };
    const result = await processCronCleanup(
      { DB: makeFakeDb(state), CRON_CLEANUP_FORCE: 'true' },
      { now: new Date('2026-05-01T15:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(7);
    expect(mockHeartbeats).toHaveLength(1);
  });

  it('retentionDays=7 で cutoff が 7 日前になる', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 0 };
    const now = new Date('2026-05-01T03:00:00+09:00');
    await processCronCleanup(
      { DB: makeFakeDb(state) },
      { now, retentionDays: 7 },
    );
    const cutoff = new Date(state.deleteCalls[0]!.params[0] as string);
    const expectedCutoff = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
  });

  it('DELETE 失敗で deletedRows=0 + 例外を投げない', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    const state: FakeDeleteState = {
      deleteCalls: [],
      changesToReturn: 0,
      shouldThrow: true,
    };
    const result = await processCronCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T03:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(0);
    // DELETE 失敗時は heartbeat も書かない
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('heartbeat insert 失敗でも例外を投げない (fail-safe)', async () => {
    const { processCronCleanup } = await import('../services/cron-cleanup.js');
    mockHeartbeatShouldFail = true;
    const state: FakeDeleteState = { deleteCalls: [], changesToReturn: 5 };
    const result = await processCronCleanup(
      { DB: makeFakeDb(state) },
      { now: new Date('2026-05-01T03:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(5); // DELETE 自体は成功
  });
});
