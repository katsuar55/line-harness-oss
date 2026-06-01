/**
 * Tests for マイランク LIFF API (= 自社内製ロイヤリティ, 2026-06-01, PR4)
 *
 * `/api/liff/my-rank` の rank 解決 + レスポンス整形 + 認証を検証。
 * liffUser は middleware で注入 (= liffAuthMiddleware 相当)、 DB は trailing SUM + snapshot を mock。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { liffMyRank } from '../routes/liff-my-rank.js';

interface SnapshotRowLike {
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

function makeDb(trailingTotal: number, snapshot: SnapshotRowLike | null = null): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: trailingTotal } as unknown as T;
          }
          if (sql.includes('loyalty_rank_snapshots')) {
            return (snapshot ?? null) as unknown as T | null;
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

function makeApp(liffUser: { lineUserId: string; friendId: string } | null) {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    if (liffUser !== null) {
      (c as { set: (k: string, v: unknown) => void }).set('liffUser', liffUser);
    }
    await next();
  });
  app.route('/', liffMyRank);
  return app;
}

const USER = { lineUserId: 'U1', friendId: 'f1' };

async function callApi(app: ReturnType<typeof makeApp>, db: D1Database) {
  const res = await app.request('/api/liff/my-rank', undefined, { DB: db } as unknown as Env['Bindings']);
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string; data?: any } };
}

describe('GET /api/liff/my-rank', () => {
  it('silver (¥15,000): rank + 次ランク進捗を返す', async () => {
    const { status, body } = await callApi(makeApp(USER), makeDb(15000));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.rank.id).toBe('silver');
    expect(body.data.rank.discountPercent).toBe(4);
    expect(body.data.rank.badgeEmoji).toBe('🥈');
    expect(body.data.trailing12moJpy).toBe(15000);
    expect(body.data.next.id).toBe('gold');
    expect(body.data.next.remainingJpy).toBe(9000);
    expect(body.data.official).toBeNull();
  });

  it('regular (¥0): 0% + 次=bronze', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(0));
    expect(body.data.rank.id).toBe('regular');
    expect(body.data.rank.discountPercent).toBe(0);
    expect(body.data.next.id).toBe('bronze');
  });

  it('platinum (¥50,000): 8% + next=null (最高ランク)', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(50000));
    expect(body.data.rank.id).toBe('platinum');
    expect(body.data.rank.discountPercent).toBe(8);
    expect(body.data.next).toBeNull();
    expect(body.data.progressRatio).toBe(1);
  });

  it('snapshot あり → official に rank/period/direction を返す', async () => {
    const snap: SnapshotRowLike = {
      id: 's1', friend_id: 'f1', period: '2026-06', rank_id: 'gold', trailing_12mo_jpy: 30000,
      prev_rank_id: 'silver', direction: 'up', brand_id: null,
      evaluated_at: '2026-06-01T09:05:00.000+09:00', created_at: '2026-06-01T09:05:00.000+09:00',
    };
    const { body } = await callApi(makeApp(USER), makeDb(30000, snap));
    expect(body.data.official).toEqual({ rankId: 'gold', period: '2026-06', direction: 'up' });
  });

  it('liffUser 未設定 → 401', async () => {
    const { status, body } = await callApi(makeApp(null), makeDb(15000));
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });
});
