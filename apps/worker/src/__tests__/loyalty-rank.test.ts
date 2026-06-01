/**
 * Tests for @line-crm/db loyalty-rank (= 自社内製ランクエンジン, 2026-06-01, PR1)
 *
 * 純関数 (determineRank / computeRankProgress / compareRanks) + trailing-12mo 集計を
 * in-memory D1 mock で直接 test。cb-admin 互換の閾値 (¥0/1/12k/24k/45k) / 割引 (0/2/4/6/8%) を検証。
 */
import { describe, it, expect } from 'vitest';
import {
  NATURISM_RANK_DEFS,
  determineRank,
  getRankById,
  rankDiscountPercent,
  compareRanks,
  computeRankProgress,
  computeTrailing12moJpyForFriend,
  resolveFriendRank,
  isoMonthsAgo,
} from '@line-crm/db';

const DEFS = NATURISM_RANK_DEFS;

// ============================================================
// determineRank
// ============================================================

describe('determineRank (cb-admin 互換閾値)', () => {
  it('¥0 → regular (0%)', () => {
    expect(determineRank(DEFS, 0).id).toBe('regular');
  });
  it('¥1 → bronze, ¥11,999 → bronze', () => {
    expect(determineRank(DEFS, 1).id).toBe('bronze');
    expect(determineRank(DEFS, 11999).id).toBe('bronze');
  });
  it('¥12,000 → silver, ¥23,999 → silver', () => {
    expect(determineRank(DEFS, 12000).id).toBe('silver');
    expect(determineRank(DEFS, 23999).id).toBe('silver');
  });
  it('¥24,000 → gold, ¥44,999 → gold', () => {
    expect(determineRank(DEFS, 24000).id).toBe('gold');
    expect(determineRank(DEFS, 44999).id).toBe('gold');
  });
  it('¥45,000+ → platinum', () => {
    expect(determineRank(DEFS, 45000).id).toBe('platinum');
    expect(determineRank(DEFS, 9999999).id).toBe('platinum');
  });
  it('負数 / NaN は regular に正規化', () => {
    expect(determineRank(DEFS, -500).id).toBe('regular');
    expect(determineRank(DEFS, Number('x')).id).toBe('regular');
  });
  it('defs 空は throw', () => {
    expect(() => determineRank([], 1000)).toThrow(/no rank definitions/);
  });
  it('order 順不同でも最高該当を返す', () => {
    const reversed = [...DEFS].reverse();
    expect(determineRank(reversed, 30000).id).toBe('gold');
  });
});

// ============================================================
// 割引率 / lookup
// ============================================================

describe('割引率 / lookup', () => {
  it('rankDiscountPercent: cb-admin % と一致', () => {
    expect(rankDiscountPercent(DEFS, 'regular')).toBe(0);
    expect(rankDiscountPercent(DEFS, 'bronze')).toBe(2);
    expect(rankDiscountPercent(DEFS, 'silver')).toBe(4);
    expect(rankDiscountPercent(DEFS, 'gold')).toBe(6);
    expect(rankDiscountPercent(DEFS, 'platinum')).toBe(8);
  });
  it('未知 rank は 0%', () => {
    expect(rankDiscountPercent(DEFS, 'unknown')).toBe(0);
  });
  it('getRankById', () => {
    expect(getRankById(DEFS, 'gold')?.discountPercent).toBe(6);
    expect(getRankById(DEFS, 'nope')).toBeNull();
  });
});

// ============================================================
// compareRanks (降格/昇格検知)
// ============================================================

describe('compareRanks', () => {
  it('up / down / same', () => {
    expect(compareRanks(DEFS, 'silver', 'gold')).toBe(1);
    expect(compareRanks(DEFS, 'gold', 'silver')).toBe(-1);
    expect(compareRanks(DEFS, 'gold', 'gold')).toBe(0);
  });
  it('platinum → gold は降格 (-1)', () => {
    expect(compareRanks(DEFS, 'platinum', 'gold')).toBe(-1);
  });
  it('未知 id は order 0 扱い', () => {
    expect(compareRanks(DEFS, 'unknown', 'bronze')).toBe(1);
    expect(compareRanks(DEFS, 'bronze', 'unknown')).toBe(-1);
  });
});

// ============================================================
// computeRankProgress (会員証進捗)
// ============================================================

describe('computeRankProgress', () => {
  it('regular: 次=bronze、残¥1', () => {
    const p = computeRankProgress(DEFS, 0);
    expect(p.current.id).toBe('regular');
    expect(p.next?.id).toBe('bronze');
    expect(p.remainingToNextJpy).toBe(1);
  });
  it('silver の中間 ¥18,000: 次=gold、残¥6,000、ratio=0.5', () => {
    const p = computeRankProgress(DEFS, 18000);
    expect(p.current.id).toBe('silver');
    expect(p.next?.id).toBe('gold');
    expect(p.remainingToNextJpy).toBe(6000);
    expect(p.progressRatio).toBeCloseTo(0.5, 5);
  });
  it('platinum: next=null、ratio=1、残0', () => {
    const p = computeRankProgress(DEFS, 60000);
    expect(p.current.id).toBe('platinum');
    expect(p.next).toBeNull();
    expect(p.remainingToNextJpy).toBe(0);
    expect(p.progressRatio).toBe(1);
  });
});

// ============================================================
// isoMonthsAgo
// ============================================================

describe('isoMonthsAgo', () => {
  it('12ヶ月前を同形式で返す (lexical 比較可能)', () => {
    expect(isoMonthsAgo(12, '2026-06-01T00:00:00.000+09:00')).toBe(
      '2025-06-01T00:00:00.000+09:00',
    );
  });
  it('format は YYYY-MM-DDTHH:mm:ss.sss+09:00', () => {
    expect(isoMonthsAgo(12, '2026-06-01T00:00:00.000+09:00')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/,
    );
  });
  it('年跨ぎ (3ヶ月前)', () => {
    expect(isoMonthsAgo(3, '2026-02-15T12:00:00.000+09:00')).toBe(
      '2025-11-15T12:00:00.000+09:00',
    );
  });
  it('月末日 overflow を clamp (うるう日 2/29 の 12ヶ月前 → 前年 2/28)', () => {
    expect(isoMonthsAgo(12, '2028-02-29T00:00:00.000+09:00')).toBe(
      '2027-02-28T00:00:00.000+09:00',
    );
  });
  it('月末 1ヶ月前も clamp (3/31 → 2月末、 cron months=1 想定)', () => {
    expect(isoMonthsAgo(1, '2026-03-31T00:00:00.000+09:00')).toBe(
      '2026-02-28T00:00:00.000+09:00',
    );
  });
});

// ============================================================
// trailing-12mo 集計 (in-memory D1 mock)
// ============================================================

interface EvtSeed {
  friend_id: string | null;
  amount_jpy: number;
  applied_at: string | null;
  created_at: string;
}

function makeRankDb(events: EvtSeed[]): D1Database {
  return {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params.push(...args);
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SUM(amount_jpy)') && sql.includes('member_purchase_events')) {
            const [friendId, since] = params as [string, string];
            const total = events
              .filter(
                (e) =>
                  e.friend_id === friendId &&
                  e.applied_at != null &&
                  e.created_at >= since,
              )
              .reduce((s, e) => s + e.amount_jpy, 0);
            return { total } as unknown as T;
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

describe('computeTrailing12moJpyForFriend', () => {
  const asOf = '2026-06-01T00:00:00.000+09:00';

  it('窓内の applied event のみ合算 (window / applied / friend filter)', async () => {
    const db = makeRankDb([
      { friend_id: 'f1', amount_jpy: 10000, applied_at: asOf, created_at: '2026-05-01T00:00:00.000+09:00' },
      { friend_id: 'f1', amount_jpy: 5000, applied_at: asOf, created_at: '2025-12-01T00:00:00.000+09:00' },
      { friend_id: 'f1', amount_jpy: 99999, applied_at: asOf, created_at: '2025-03-01T00:00:00.000+09:00' }, // >12mo → 除外
      { friend_id: 'f1', amount_jpy: 8000, applied_at: null, created_at: '2026-05-01T00:00:00.000+09:00' }, // 未適用 → 除外
      { friend_id: 'f2', amount_jpy: 50000, applied_at: asOf, created_at: '2026-05-01T00:00:00.000+09:00' }, // 別 friend → 除外
    ]);
    expect(await computeTrailing12moJpyForFriend(db, 'f1', asOf)).toBe(15000);
  });

  it('event 無し → 0', async () => {
    const db = makeRankDb([]);
    expect(await computeTrailing12moJpyForFriend(db, 'f1', asOf)).toBe(0);
  });
});

describe('resolveFriendRank (集計→判定→進捗)', () => {
  const asOf = '2026-06-01T00:00:00.000+09:00';

  it('trailing ¥15,000 → silver + 進捗', async () => {
    const db = makeRankDb([
      { friend_id: 'f1', amount_jpy: 15000, applied_at: asOf, created_at: '2026-05-01T00:00:00.000+09:00' },
    ]);
    const r = await resolveFriendRank(db, 'f1', NATURISM_RANK_DEFS, asOf);
    expect(r.rankId).toBe('silver');
    expect(r.trailing12moJpy).toBe(15000);
    expect(r.progress.next?.id).toBe('gold');
    expect(r.rank.discountPercent).toBe(4);
  });

  it('購入なし → regular (0%)', async () => {
    const db = makeRankDb([]);
    const r = await resolveFriendRank(db, 'f-none', NATURISM_RANK_DEFS, asOf);
    expect(r.rankId).toBe('regular');
    expect(r.rank.discountPercent).toBe(0);
  });
});
