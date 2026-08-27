/**
 * Tests for repairMissingBacklink (= 逆方向リンクの自己修復、2026-08-28 Codex P1)
 *
 * ## なぜこの機能が要るか
 * 連携の書込は 2 段構え:
 *   ① friends.shopify_customer_id を set-once CAS で立てる (連携の真実源)
 *   ② shopify_customers.friend_id / shopify_orders.friend_id を埋める (注文一覧の唯一のキー)
 * ② が transient エラーで落ちても ① は set-once なので二度と書けず、OTP をやり直しても
 * already_linked で弾かれる。顧客は「連携済みなのに注文が 1 件も出ない」状態から抜け出せない。
 * ② は ① から完全に導出できるので、cron が冪等に埋め直す。
 *
 * 🚨 観測点: 「他人に紐付いた行を奪わないこと」を必ず観測する。
 *    奪うと **他人の注文が別の LINE に見える** = 連携解除より重い事故になる。
 */
import { describe, it, expect } from 'vitest';
import { repairMissingBacklink } from '@line-crm/db';

interface Store {
  friends: Array<{ id: string; shopify_customer_id: string | null; updated_at: string }>;
  shopify_customers: Array<{ shopify_customer_id: string; friend_id: string | null }>;
  shopify_orders: Array<{ id: string; shopify_customer_id: string; friend_id: string | null }>;
}

interface FakeStmt {
  _sql: string;
  _b: unknown[];
}

function makeDb(store: Store): D1Database {
  /** 「連携済み ∧ その customer 行の friend_id が自分でない」= 修復対象。 */
  const pending = () =>
    store.friends
      .filter((f) => f.shopify_customer_id !== null)
      .map((f) => ({ f, sc: store.shopify_customers.find((c) => c.shopify_customer_id === f.shopify_customer_id) }))
      // shopify_customers に行が無い friend は JOIN で落ちる (埋める先が無いので対象外)
      .filter((x) => x.sc !== undefined && (x.sc!.friend_id === null || x.sc!.friend_id !== x.f.id));

  const run = (sql: string, b: unknown[]): { meta: { changes: number } } => {
    let changes = 0;
    if (sql.includes('UPDATE shopify_customers')) {
      const fid = b[0] as string;
      const cid = b[2] as string;
      // 🚨 friend_id IS NULL 限定 (奪わない)
      for (const c of store.shopify_customers) {
        if (c.shopify_customer_id === cid && c.friend_id === null) {
          c.friend_id = fid;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_orders')) {
      const fid = b[0] as string;
      const cid = b[1] as string;
      for (const o of store.shopify_orders) {
        if (o.shopify_customer_id === cid && o.friend_id === null) {
          o.friend_id = fid;
          changes++;
        }
      }
    } else {
      throw new Error('unexpected SQL: ' + sql);
    }
    return { meta: { changes } };
  };

  const db = {
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _b: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._b = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('COUNT(*)')) return { n: pending().length } as unknown as T;
          if (sql.includes('LIMIT 1')) {
            const rows = pending().sort((a, b2) => (a.f.updated_at < b2.f.updated_at ? 1 : -1));
            const hit = rows[0];
            return (hit ? { id: hit.f.id, shopify_customer_id: hit.f.shopify_customer_id } : null) as unknown as T | null;
          }
          throw new Error('unexpected first(): ' + sql);
        },
        async run() {
          return run(sql, stmt._b);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
    async batch(stmts: unknown[]) {
      return stmts.map((s) => {
        const st = s as unknown as FakeStmt;
        return run(st._sql, st._b);
      });
    },
  };
  return db as unknown as D1Database;
}

describe('repairMissingBacklink', () => {
  it('🚨 連携済みなのに backlink が欠けている friend を修復する (OTP の途中失敗からの復旧)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [
        { id: 'o1', shopify_customer_id: '900', friend_id: null },
        { id: 'o2', shopify_customer_id: '900', friend_id: null },
      ],
    };
    const r = await repairMissingBacklink(makeDb(store));

    expect(r.repaired).toBe(1);
    expect(r.friendId).toBe('f1');
    expect(r.customers).toBe(1);
    expect(r.orders).toBe(2);
    // 注文一覧が引ける状態になった (= WHERE friend_id = ? がヒットする)
    expect(store.shopify_customers[0].friend_id).toBe('f1');
    expect(store.shopify_orders.every((o) => o.friend_id === 'f1')).toBe(true);
  });

  it('欠けが無ければ no-op (書込ゼロ)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: 'f1' }],
      shopify_orders: [{ id: 'o1', shopify_customer_id: '900', friend_id: 'f1' }],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r).toMatchObject({ pending: 0, repaired: 0, friendId: null });
  });

  it('未連携の friend は対象外', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: null, updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [{ id: 'o1', shopify_customer_id: '900', friend_id: null }],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r.repaired).toBe(0);
    expect(store.shopify_orders[0].friend_id).toBeNull();
  });

  it('🚨 他人に紐付いた行は奪わない (奪うと他人の注文が別の LINE に見える)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      // customer 行は別 friend が持っている (= 修復対象として拾われるが、奪ってはいけない)
      shopify_customers: [{ shopify_customer_id: '900', friend_id: 'other' }],
      shopify_orders: [{ id: 'o1', shopify_customer_id: '900', friend_id: 'other' }],
    };
    const r = await repairMissingBacklink(makeDb(store));
    // 拾いはするが 0 行更新 (IS NULL 限定なので奪わない)
    expect(r.customers).toBe(0);
    expect(r.orders).toBe(0);
    expect(store.shopify_customers[0].friend_id).toBe('other');
    expect(store.shopify_orders[0].friend_id).toBe('other');
  });

  it('別 customer の注文は触らない', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [
        { id: 'o1', shopify_customer_id: '900', friend_id: null },
        { id: 'o2', shopify_customer_id: '999', friend_id: null },
      ],
    };
    await repairMissingBacklink(makeDb(store));
    expect(store.shopify_orders.find((o) => o.id === 'o1')!.friend_id).toBe('f1');
    expect(store.shopify_orders.find((o) => o.id === 'o2')!.friend_id).toBeNull();
  });

  it('shopify_customers に行が無い friend は対象外 (埋める先が無い)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [],
      shopify_orders: [{ id: 'o1', shopify_customer_id: '900', friend_id: null }],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r).toMatchObject({ pending: 0, repaired: 0 });
  });

  it('冪等: 2 回続けて実行しても 2 回目は no-op', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [{ id: 'o1', shopify_customer_id: '900', friend_id: null }],
    };
    const db = makeDb(store);
    expect((await repairMissingBacklink(db)).repaired).toBe(1);
    expect((await repairMissingBacklink(db)).repaired).toBe(0);
  });

  it('1 run 1 friend (cron の予算を守る)', async () => {
    const store: Store = {
      friends: [
        { id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' },
        { id: 'f2', shopify_customer_id: '901', updated_at: '2026-08-27' },
      ],
      shopify_customers: [
        { shopify_customer_id: '900', friend_id: null },
        { shopify_customer_id: '901', friend_id: null },
      ],
      shopify_orders: [],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r.pending).toBe(2);
    expect(r.repaired).toBe(1);
    // 片方だけ埋まる (残りは次の run)
    expect(store.shopify_customers.filter((c) => c.friend_id !== null)).toHaveLength(1);
  });
});

describe('backlink-repair の cron 配線', () => {
  it('scheduled handler に withHeartbeat 付きで配線されている', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = dirname(fileURLToPath(import.meta.url));
    const idx = readFileSync(join(root, '..', 'index.ts'), 'utf8');
    expect(idx).toContain("withHeartbeat(env.DB, 'backlink-repair'");
    expect(idx).toMatch(/repairMissingBacklink\(env\.DB\)/);
    // metrics から「まだ残っているか」が見える (pending が減らなければ原因調査できる)
    expect(idx).toMatch(/pending: r\.pending[\s\S]{0,120}repaired: r\.repaired/);
  });
});
