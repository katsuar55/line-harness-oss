/**
 * Tests for loyalty rank monthly re-eval (= 自社内製ロイヤリティ, 2026-06-01, PR2)
 *
 * - loyalty-rank-snapshots DB: record (ON CONFLICT idempotent) / latest / previous / demotions
 * - loyalty-rank-cron: gating window / FORCE / direction (initial/up/down/same) / 冪等性
 *
 * in-memory D1 mock が members + member_purchase_events(SUM) + loyalty_rank_snapshots を解釈する。
 */
import { describe, it, expect } from 'vitest';
import {
  recordRankSnapshot,
  getLatestRankSnapshot,
  getRankSnapshotForPeriod,
  getPreviousRankSnapshot,
  listDemotionsForPeriod,
} from '@line-crm/db';
import {
  processLoyaltyRankReeval,
  type LoyaltyRankCronEnv,
} from '../services/loyalty-rank-cron.js';

interface SnapRow {
  id: string;
  friend_id: string;
  period: string;
  rank_id: string;
  trailing_12mo_jpy: number;
  prev_rank_id: string | null;
  direction: string;
  brand_id: string | null;
  evaluated_at: string;
  created_at: string;
}

interface EvtSeed {
  friend_id: string;
  amount_jpy: number;
  applied_at: string | null;
  created_at: string;
}

function makeDb(opts: { members?: string[]; events?: EvtSeed[] } = {}): {
  db: D1Database;
  snaps: SnapRow[];
} {
  const members = (opts.members ?? []).map((friend_id) => ({ friend_id }));
  const events = opts.events ?? [];
  const snaps: SnapRow[] = [];

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
        if (sql.includes('loyalty_rank_snapshots') && sql.includes('period < ?')) {
          const [fid, period] = params as [string, string];
          const rows = snaps
            .filter((s) => s.friend_id === fid && s.period < period)
            .sort((a, b) => b.period.localeCompare(a.period) || b.evaluated_at.localeCompare(a.evaluated_at));
          return (rows[0] ?? null) as unknown as T | null;
        }
        if (sql.includes('loyalty_rank_snapshots') && sql.includes('AND period = ?')) {
          const [fid, period] = params as [string, string];
          return (snaps.find((s) => s.friend_id === fid && s.period === period) ?? null) as unknown as T | null;
        }
        if (sql.includes('loyalty_rank_snapshots') && sql.includes('ORDER BY evaluated_at DESC')) {
          const [fid] = params as [string];
          const rows = snaps
            .filter((s) => s.friend_id === fid)
            .sort((a, b) => b.evaluated_at.localeCompare(a.evaluated_at));
          return (rows[0] ?? null) as unknown as T | null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[]; success: boolean }> {
        if (sql.includes('FROM members')) {
          return { results: members as unknown as T[], success: true };
        }
        if (sql.includes('loyalty_rank_snapshots') && sql.includes("direction = 'down'")) {
          const [period] = params as [string];
          return {
            results: snaps.filter((s) => s.period === period && s.direction === 'down') as unknown as T[],
            success: true,
          };
        }
        return { results: [], success: true };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (sql.includes('INSERT INTO loyalty_rank_snapshots')) {
          const [id, friend_id, period, rank_id, trailing, prev_rank_id, direction, brand_id, evaluated_at, created_at] =
            params as [string, string, string, string, number, string | null, string, string | null, string, string];
          const existing = snaps.find((s) => s.friend_id === friend_id && s.period === period);
          if (existing) {
            existing.rank_id = rank_id;
            existing.trailing_12mo_jpy = trailing;
            existing.prev_rank_id = prev_rank_id;
            existing.direction = direction;
            existing.evaluated_at = evaluated_at;
          } else {
            snaps.push({
              id,
              friend_id,
              period,
              rank_id,
              trailing_12mo_jpy: trailing,
              prev_rank_id,
              direction,
              brand_id,
              evaluated_at,
              created_at,
            });
          }
          return { success: true, meta: { changes: 1 } };
        }
        // auditSystem の INSERT 等は no-op success
        return { success: true, meta: { changes: 1 } };
      },
    };
    return stmt;
  }

  return { db: { prepare } as unknown as D1Database, snaps };
}

// ============================================================
// snapshot DB module
// ============================================================

describe('loyalty-rank-snapshots DB', () => {
  it('record + getLatest + getForPeriod', async () => {
    const { db } = makeDb();
    await recordRankSnapshot(db, {
      friendId: 'f1',
      period: '2026-05',
      rankId: 'gold',
      trailing12moJpy: 30000,
      prevRankId: null,
      direction: 'initial',
      evaluatedAt: '2026-05-01T09:05:00.000+09:00',
    });
    expect((await getLatestRankSnapshot(db, 'f1'))?.rankId).toBe('gold');
    expect((await getRankSnapshotForPeriod(db, 'f1', '2026-05'))?.trailing12moJpy).toBe(30000);
  });

  it('ON CONFLICT(friend_id, period) で同月は 1 行に上書き', async () => {
    const { db, snaps } = makeDb();
    await recordRankSnapshot(db, {
      friendId: 'f1', period: '2026-05', rankId: 'gold', trailing12moJpy: 30000, direction: 'initial',
      evaluatedAt: '2026-05-01T09:05:00.000+09:00',
    });
    await recordRankSnapshot(db, {
      friendId: 'f1', period: '2026-05', rankId: 'silver', trailing12moJpy: 13000, direction: 'same',
      evaluatedAt: '2026-05-01T09:06:00.000+09:00',
    });
    expect(snaps.filter((s) => s.friend_id === 'f1' && s.period === '2026-05').length).toBe(1);
    expect((await getRankSnapshotForPeriod(db, 'f1', '2026-05'))?.rankId).toBe('silver');
  });

  it('getPreviousRankSnapshot は period 未満の最新 (= 前月)', async () => {
    const { db } = makeDb();
    await recordRankSnapshot(db, {
      friendId: 'f1', period: '2026-04', rankId: 'gold', trailing12moJpy: 30000, direction: 'initial',
      evaluatedAt: '2026-04-01T09:05:00.000+09:00',
    });
    await recordRankSnapshot(db, {
      friendId: 'f1', period: '2026-05', rankId: 'silver', trailing12moJpy: 13000, direction: 'down',
      evaluatedAt: '2026-05-01T09:05:00.000+09:00',
    });
    expect((await getPreviousRankSnapshot(db, 'f1', '2026-05'))?.rankId).toBe('gold');
    expect(await getPreviousRankSnapshot(db, 'f1', '2026-04')).toBeNull();
  });

  it('listDemotionsForPeriod は direction=down のみ', async () => {
    const { db } = makeDb();
    await recordRankSnapshot(db, {
      friendId: 'f1', period: '2026-05', rankId: 'silver', trailing12moJpy: 13000, direction: 'down',
      evaluatedAt: '2026-05-01T09:05:00.000+09:00',
    });
    await recordRankSnapshot(db, {
      friendId: 'f2', period: '2026-05', rankId: 'gold', trailing12moJpy: 30000, direction: 'up',
      evaluatedAt: '2026-05-01T09:05:00.000+09:00',
    });
    const dem = await listDemotionsForPeriod(db, '2026-05');
    expect(dem.map((d) => d.friendId)).toEqual(['f1']);
  });
});

// ============================================================
// cron
// ============================================================

describe('processLoyaltyRankReeval', () => {
  // JST 2026-05-01 09:05 = UTC 2026-05-01 00:05
  const may1_0905 = new Date('2026-05-01T00:05:00.000Z');
  const jun1_0905 = new Date('2026-06-01T00:05:00.000Z');

  it('gating: window 外 + FORCE なし → skip', async () => {
    const { db } = makeDb({ members: ['f1'] });
    const env: LoyaltyRankCronEnv = { DB: db };
    const r = await processLoyaltyRankReeval(env, { now: new Date('2026-05-15T03:00:00.000Z') });
    expect(r.skippedDueToGating).toBe(true);
    expect(r.candidates).toBe(0);
  });

  it('FORCE 初回: snapshot 記録 + direction initial', async () => {
    const { db, snaps } = makeDb({
      members: ['f1'],
      events: [{ friend_id: 'f1', amount_jpy: 30000, applied_at: 'x', created_at: '2026-04-01T00:00:00.000+09:00' }],
    });
    const env: LoyaltyRankCronEnv = { DB: db, LOYALTY_RANK_CRON_FORCE: 'true' };
    const r = await processLoyaltyRankReeval(env, { now: may1_0905 });
    expect(r.skippedDueToGating).toBe(false);
    expect(r.candidates).toBe(1);
    expect(r.promoted + r.demoted).toBe(0);
    expect(r.unchanged).toBe(1);
    expect(snaps[0].rank_id).toBe('gold');
    expect(snaps[0].direction).toBe('initial');
    expect(snaps[0].period).toBe('2026-05');
  });

  it('2 期間で降格検知 (gold→silver, direction down)', async () => {
    const { db, snaps } = makeDb({
      members: ['f1'],
      events: [
        { friend_id: 'f1', amount_jpy: 20000, applied_at: 'x', created_at: '2025-05-15T00:00:00.000+09:00' }, // run2 で 12mo 窓外
        { friend_id: 'f1', amount_jpy: 13000, applied_at: 'x', created_at: '2026-04-01T00:00:00.000+09:00' },
      ],
    });
    const env: LoyaltyRankCronEnv = { DB: db, LOYALTY_RANK_CRON_FORCE: 'true' };
    await processLoyaltyRankReeval(env, { now: may1_0905 }); // 2026-05: 33000 → gold (initial)
    const r2 = await processLoyaltyRankReeval(env, { now: jun1_0905 }); // 2026-06: 13000 → silver (down)
    expect(r2.demoted).toBe(1);
    expect(r2.demotedFriendIds).toEqual(['f1']);
    const jun = snaps.find((s) => s.period === '2026-06');
    expect(jun?.rank_id).toBe('silver');
    expect(jun?.direction).toBe('down');
    expect(jun?.prev_rank_id).toBe('gold');
  });

  it('同 period rerun は idempotent (1 行、 前月なしで initial 維持)', async () => {
    const { db, snaps } = makeDb({
      members: ['f1'],
      events: [{ friend_id: 'f1', amount_jpy: 13000, applied_at: 'x', created_at: '2026-04-01T00:00:00.000+09:00' }],
    });
    const env: LoyaltyRankCronEnv = { DB: db, LOYALTY_RANK_CRON_FORCE: 'true' };
    await processLoyaltyRankReeval(env, { now: may1_0905 });
    await processLoyaltyRankReeval(env, { now: may1_0905 });
    expect(snaps.filter((s) => s.friend_id === 'f1' && s.period === '2026-05').length).toBe(1);
    expect(snaps[0].direction).toBe('initial');
  });
});
