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
  shopify_orders: Array<{ id: string; shopify_order_id: string; shopify_customer_id: string; friend_id: string | null }>;
  shopify_fulfillments: Array<{ id: string; shopify_order_id: string; friend_id: string | null }>;
}

interface FakeStmt {
  _sql: string;
  _b: unknown[];
}

function makeDb(store: Store): D1Database {
  /**
   * 修復対象 = 連携済み ∧ (customers が自分でない ∨ orders が NULL ∨ fulfillments が NULL)。
   * 🚨 customers だけを見ると「注文が出ない」状態の大半を取り逃がす (採点ループ HIGH)。
   *    fake も 3 条件の OR にしておかないと、実装から条件を削っても緑のままになる。
   */
  const pending = () =>
    store.friends
      .filter((f) => f.shopify_customer_id !== null)
      .filter((f) => {
        const cid = f.shopify_customer_id as string;
        const sc = store.shopify_customers.find((c) => c.shopify_customer_id === cid);
        const customersMissing = sc !== undefined && (sc.friend_id === null || sc.friend_id !== f.id);
        const ordersMissing = store.shopify_orders.some(
          (o) => o.shopify_customer_id === cid && o.friend_id === null,
        );
        const orderIds = new Set(
          store.shopify_orders.filter((o) => o.shopify_customer_id === cid).map((o) => o.shopify_order_id),
        );
        const fulfillmentsMissing = store.shopify_fulfillments.some(
          (sf) => orderIds.has(sf.shopify_order_id) && sf.friend_id === null,
        );
        return customersMissing || ordersMissing || fulfillmentsMissing;
      })
      .map((f) => ({ f }));

  const run = (sql: string, b: unknown[]): { meta: { changes: number } } => {
    let changes = 0;
    // 🚨 fake は WHERE 句を**実際に解釈する**。ガードをハードコードすると、
    //    実装から `AND friend_id IS NULL` を消しても緑のまま = mutation が生き残る
    //    (2026-08-28 の mutation ドリル M4 で実測。fake と本物の乖離による false green)。
    const guardsNull = /AND\s+friend_id\s+IS\s+NULL/i.test(sql);
    if (sql.includes('UPDATE shopify_customers')) {
      const fid = b[0] as string;
      const cid = b[2] as string;
      for (const c of store.shopify_customers) {
        if (c.shopify_customer_id === cid && (!guardsNull || c.friend_id === null)) {
          c.friend_id = fid;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_orders')) {
      const fid = b[0] as string;
      const cid = b[1] as string;
      for (const o of store.shopify_orders) {
        if (o.shopify_customer_id === cid && (!guardsNull || o.friend_id === null)) {
          o.friend_id = fid;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_fulfillments')) {
      // 配送追跡は customer 列を持たないので shopify_order_id 経由で結ぶ
      const fid = b[0] as string;
      const cid = b[2] as string;
      const orderIds = new Set(
        store.shopify_orders.filter((o) => o.shopify_customer_id === cid).map((o) => o.shopify_order_id),
      );
      for (const f of store.shopify_fulfillments) {
        if (orderIds.has(f.shopify_order_id) && (!guardsNull || f.friend_id === null)) {
          f.friend_id = fid;
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
        { id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null },
        { id: 'o2', shopify_order_id: 'so-o2', shopify_customer_id: '900', friend_id: null },
      ],
      shopify_fulfillments: [],
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

  it('🚨 配送追跡も復元する (customer 列が無いので shopify_order_id 経由で結ぶ)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null }],
      shopify_fulfillments: [
        { id: 'ff1', shopify_order_id: 'so-o1', friend_id: null },
        // 別 customer の注文に属する荷物は触らない
        { id: 'ff2', shopify_order_id: 'so-zzz', friend_id: null },
      ],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r.fulfillments).toBe(1);
    // 配送追跡 (WHERE sf.friend_id = ?) が引ける状態に戻る
    expect(store.shopify_fulfillments.find((f) => f.id === 'ff1')!.friend_id).toBe('f1');
    expect(store.shopify_fulfillments.find((f) => f.id === 'ff2')!.friend_id).toBeNull();
  });

  it('🚨 配送追跡だけ欠けている friend も検知する (customers/orders が埋まっていても拾う)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: 'f1' }],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: 'f1' }],
      shopify_fulfillments: [{ id: 'ff1', shopify_order_id: 'so-o1', friend_id: null }],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r.pending).toBe(1);
    expect(r.fulfillments).toBe(1);
  });

  it('欠けが無ければ no-op (書込ゼロ)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: 'f1' }],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: 'f1' }],
      shopify_fulfillments: [],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r).toMatchObject({ pending: 0, repaired: 0, friendId: null });
  });

  it('未連携の friend は対象外', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: null, updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null }],
      shopify_fulfillments: [],
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
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: 'other' }],
      shopify_fulfillments: [],
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
        { id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null },
        { id: 'o2', shopify_order_id: 'so-o2', shopify_customer_id: '999', friend_id: null },
      ],
      shopify_fulfillments: [],
    };
    await repairMissingBacklink(makeDb(store));
    expect(store.shopify_orders.find((o) => o.id === 'o1')!.friend_id).toBe('f1');
    expect(store.shopify_orders.find((o) => o.id === 'o2')!.friend_id).toBeNull();
  });

  // 2026-08-28 (採点ループ HIGH): 検知を customers 単独から 3 条件の OR へ広げた結果、
  // 「customers 行は無いが orders は埋められる」ケースも修復できるようになった。
  // 顧客から見た症状 (注文が出ない) が直るので、これは契約の改善。
  it('customers 行が無くても orders は修復する (注文一覧が引けるようになる)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null }],
      shopify_fulfillments: [],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r.repaired).toBe(1);
    expect(r.customers).toBe(0); // 埋める先が無いので 0
    expect(r.orders).toBe(1);
    expect(store.shopify_orders[0].friend_id).toBe('f1');
  });

  it('修復すべき列が 1 つも無ければ対象外 (連携先のデータが 1 行も無い)', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [],
      shopify_orders: [],
      shopify_fulfillments: [],
    };
    const r = await repairMissingBacklink(makeDb(store));
    expect(r).toMatchObject({ pending: 0, repaired: 0 });
  });

  it('冪等: 2 回続けて実行しても 2 回目は no-op', async () => {
    const store: Store = {
      friends: [{ id: 'f1', shopify_customer_id: '900', updated_at: '2026-08-28' }],
      shopify_customers: [{ shopify_customer_id: '900', friend_id: null }],
      shopify_orders: [{ id: 'o1', shopify_order_id: 'so-o1', shopify_customer_id: '900', friend_id: null }],
      shopify_fulfillments: [],
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
      shopify_fulfillments: [],
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
