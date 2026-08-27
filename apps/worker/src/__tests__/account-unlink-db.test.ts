/**
 * Tests for @line-crm/db unlinkFriendFromShopifyCustomer (= 連携解除の巻き戻し、2026-08-28)
 *
 * 🚨 観測点は「friends が NULL になったか」ではなく **露出面 4 列がすべて外れたか**。
 *    実装当初は「friends を NULL にすれば全露出が止まる」と誤解していたが、注文一覧と配送追跡は
 *    friends を一切参照せず denormalized な friend_id 列を直接読む
 *    (routes/liff-portal.ts の `FROM shopify_orders WHERE friend_id = ?` /
 *     `FROM shopify_fulfillments sf ... WHERE sf.friend_id = ?`)。
 *    friends だけ見るテストだと「解除したのに注文履歴が見え続ける」欠陥が素通りする。
 *
 * あわせて「残すべきもの」も固定する: line_link_coupons を消すと連携特典 ¥300 の
 * 生涯 1 枚保証が壊れ、解除→再連携で 2 枚目が出る (= 実費)。
 */
import { describe, it, expect } from 'vitest';
import { unlinkFriendFromShopifyCustomer } from '@line-crm/db';

interface Store {
  friends: Array<{ id: string; shopify_customer_id: string | null }>;
  shopify_customers: Array<{ shopify_customer_id: string; friend_id: string | null }>;
  shopify_orders: Array<{ id: string; shopify_customer_id: string; friend_id: string | null }>;
  shopify_fulfillments: Array<{ id: string; friend_id: string | null }>;
  member_purchase_events: Array<{ id: string; friend_id: string | null; applied_at: string | null }>;
  members: Array<{
    friend_id: string;
    total_purchase_jpy: number;
    last_purchase_at: string | null;
    total_referral_count: number;
  }>;
  loyalty_rank_discounts: Array<{ id: string; friend_id: string; status: string; superseded_at: string | null }>;
  line_link_coupons: Array<{ friend_id: string; shopify_customer_id: string; coupon_code: string }>;
}

function seed(): Store {
  return {
    friends: [
      { id: 'f1', shopify_customer_id: '900' },
      { id: 'f2', shopify_customer_id: null },
    ],
    shopify_customers: [{ shopify_customer_id: '900', friend_id: 'f1' }],
    shopify_orders: [
      { id: 'o1', shopify_customer_id: '900', friend_id: 'f1' },
      { id: 'o2', shopify_customer_id: '900', friend_id: 'f1' },
      { id: 'o3', shopify_customer_id: '999', friend_id: 'other' },
    ],
    shopify_fulfillments: [
      { id: 'ff1', friend_id: 'f1' },
      { id: 'ff2', friend_id: 'other' },
    ],
    member_purchase_events: [
      { id: 'e1', friend_id: 'f1', applied_at: '2026-08-01T00:00:00.000+09:00' },
      { id: 'e2', friend_id: 'other', applied_at: '2026-08-01T00:00:00.000+09:00' },
    ],
    members: [
      { friend_id: 'f1', total_purchase_jpy: 3000, last_purchase_at: '2026-08-01', total_referral_count: 2 },
    ],
    loyalty_rank_discounts: [
      { id: 'd1', friend_id: 'f1', status: 'active', superseded_at: null },
      { id: 'd2', friend_id: 'f1', status: 'superseded', superseded_at: '2026-07-01' },
    ],
    line_link_coupons: [{ friend_id: 'f1', shopify_customer_id: '900', coupon_code: 'NLINK-ABC' }],
  };
}

interface FakeStmt {
  _sql: string;
  _b: unknown[];
}

/** SQL 文字列で分岐する fake D1。batch は本物と同じく順に適用する。 */
function makeDb(store: Store): D1Database {
  const run = (sql: string, b: unknown[]): { meta: { changes: number } } => {
    let changes = 0;
    if (sql.includes('UPDATE friends')) {
      const id = b[1] as string;
      for (const f of store.friends) {
        if (f.id === id && f.shopify_customer_id !== null) {
          f.shopify_customer_id = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_customers')) {
      const cid = b[1] as string;
      const fid = b[2] as string;
      for (const c of store.shopify_customers) {
        if (c.shopify_customer_id === cid && c.friend_id === fid) {
          c.friend_id = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_orders')) {
      const fid = b[0] as string;
      for (const o of store.shopify_orders) {
        if (o.friend_id === fid) {
          o.friend_id = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE shopify_fulfillments')) {
      const fid = b[1] as string;
      for (const f of store.shopify_fulfillments) {
        if (f.friend_id === fid) {
          f.friend_id = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE member_purchase_events')) {
      // 🚨 fake は SQL の SET 句を**実際に解釈する**。無条件に両方 NULL にすると、
      //    実装から `applied_at = NULL` を消しても緑のまま = mutation が生き残る
      //    (2026-08-28 の mutation ドリルで実測。fake と本物の乖離による false green)。
      const clearsFriend = /SET[^W]*friend_id\s*=\s*NULL/i.test(sql);
      const clearsApplied = /applied_at\s*=\s*NULL/i.test(sql);
      const fid = b[1] as string;
      for (const e of store.member_purchase_events) {
        if (e.friend_id === fid) {
          if (clearsApplied) e.applied_at = null;
          if (clearsFriend) e.friend_id = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE members')) {
      // 同上: SET 句を解釈する (累計だけ戻して last_purchase_at を忘れる変異を殺す)
      const clearsTotal = /total_purchase_jpy\s*=\s*0/i.test(sql);
      const clearsLast = /last_purchase_at\s*=\s*NULL/i.test(sql);
      const fid = b[1] as string;
      for (const m of store.members) {
        if (m.friend_id === fid) {
          if (clearsTotal) m.total_purchase_jpy = 0;
          if (clearsLast) m.last_purchase_at = null;
          changes++;
        }
      }
    } else if (sql.includes('UPDATE loyalty_rank_discounts')) {
      const now = b[0] as string;
      const fid = b[1] as string;
      for (const d of store.loyalty_rank_discounts) {
        if (d.friend_id === fid && d.status === 'active') {
          d.status = 'superseded';
          d.superseded_at = now;
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
          if (sql.includes('SELECT shopify_customer_id FROM friends')) {
            const id = stmt._b[0] as string;
            const f = store.friends.find((x) => x.id === id);
            return (f ? { shopify_customer_id: f.shopify_customer_id } : null) as unknown as T | null;
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

describe('unlinkFriendFromShopifyCustomer', () => {
  it('🚨 露出面 4 列がすべて外れる (friends だけでは注文履歴と配送追跡が残る)', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');

    expect(r.unlinked).toBe(true);
    expect(r.shopifyCustomerId).toBe('900');
    // ① 連携の真実源
    expect(store.friends.find((f) => f.id === 'f1')!.shopify_customer_id).toBeNull();
    // ② 逆方向リンク
    expect(store.shopify_customers[0].friend_id).toBeNull();
    // ③ 注文一覧の唯一のキー (WHERE friend_id = ?)
    expect(store.shopify_orders.filter((o) => o.friend_id === 'f1')).toHaveLength(0);
    // ④ 配送追跡の唯一のキー
    expect(store.shopify_fulfillments.filter((f) => f.friend_id === 'f1')).toHaveLength(0);
  });

  it('他人のデータには触れない', async () => {
    const store = seed();
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(store.shopify_orders.find((o) => o.id === 'o3')!.friend_id).toBe('other');
    expect(store.shopify_fulfillments.find((f) => f.id === 'ff2')!.friend_id).toBe('other');
    expect(store.member_purchase_events.find((e) => e.id === 'e2')!.friend_id).toBe('other');
  });

  it('ランクの原資を外し、再連携で復元できる形にする (applied_at も NULL へ)', async () => {
    const store = seed();
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    const ev = store.member_purchase_events.find((e) => e.id === 'e1')!;
    expect(ev.friend_id).toBeNull();
    // 🚨 applied_at も戻す: addPurchaseEvent の CAS は `WHERE applied_at IS NULL` なので、
    //    ここが残ると再連携しても二度と claim されずランクが永久に戻らない
    expect(ev.applied_at).toBeNull();
    // 行自体は消さない (監査保全)
    expect(store.member_purchase_events).toHaveLength(2);
  });

  it('members の累計は 0 に戻すが、購入と無関係な紹介カウントは温存する', async () => {
    const store = seed();
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    const m = store.members[0];
    expect(m.total_purchase_jpy).toBe(0);
    expect(m.last_purchase_at).toBeNull();
    expect(m.total_referral_count).toBe(2);
  });

  it('active なランク割引だけ superseded にする (既に superseded の行は触らない)', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(r.cleared.rankDiscounts).toBe(1);
    expect(store.loyalty_rank_discounts.find((d) => d.id === 'd1')!.status).toBe('superseded');
    expect(store.loyalty_rank_discounts.find((d) => d.id === 'd2')!.superseded_at).toBe('2026-07-01');
  });

  it('🚨 連携特典 ¥300 の台帳は残す (消すと解除→再連携で 2 枚目 = 実費)', async () => {
    const store = seed();
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(store.line_link_coupons).toHaveLength(1);
    expect(store.line_link_coupons[0].coupon_code).toBe('NLINK-ABC');
  });

  it('未連携の friend は no-op (1 行も書かない・冪等)', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f2');
    expect(r.unlinked).toBe(false);
    expect(r.shopifyCustomerId).toBeNull();
    expect(store.shopify_orders.filter((o) => o.friend_id === 'f1')).toHaveLength(2);
  });

  it('存在しない friend も no-op', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'nope');
    expect(r.unlinked).toBe(false);
  });

  it('二度実行しても壊れない (冪等)', async () => {
    const store = seed();
    const db = makeDb(store);
    await unlinkFriendFromShopifyCustomer(db, 'f1');
    const second = await unlinkFriendFromShopifyCustomer(db, 'f1');
    expect(second.unlinked).toBe(false);
  });
});
