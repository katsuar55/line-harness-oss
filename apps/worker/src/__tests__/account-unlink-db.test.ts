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
    current_tier_id: string;
  }>;
  subscription_reminders: Array<{ id: string; friend_id: string; is_active: number }>;
  /** 解除の境界マーカー (batch 内で書かれる) */
  audit_logs: Array<{ id: string; action: string; target_id: string; created_at: string; viaBatch: boolean }>;
  membership_tiers: Array<{ id: string; display_order: number; min_total_purchase_jpy: number; min_referral_count: number }>;
  loyalty_rank_discounts: Array<{ id: string; friend_id: string; status: string; superseded_at: string | null }>;
  line_link_coupons: Array<{ friend_id: string; shopify_customer_id: string; coupon_code: string }>;
}

function seed(): Store {
  return {
    friends: [
      { id: 'f1', shopify_customer_id: '900' },
      { id: 'f2', shopify_customer_id: null },
    ],
    shopify_customers: [
      { shopify_customer_id: '900', friend_id: 'f1' },
      // 過去の連携 / webhook の取りこぼしで残った別行 (絞ると漏れ続ける)
      { shopify_customer_id: '800', friend_id: 'f1' },
      { shopify_customer_id: '700', friend_id: 'other' },
    ],
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
      { friend_id: 'f1', total_purchase_jpy: 3000, last_purchase_at: '2026-08-01', total_referral_count: 2, current_tier_id: 'gold' },
    ],
    loyalty_rank_discounts: [
      { id: 'd1', friend_id: 'f1', status: 'active', superseded_at: null },
      { id: 'd2', friend_id: 'f1', status: 'superseded', superseded_at: '2026-07-01' },
    ],
    line_link_coupons: [{ friend_id: 'f1', shopify_customer_id: '900', coupon_code: 'NLINK-ABC' }],
    audit_logs: [],
    subscription_reminders: [
      { id: 'sr1', friend_id: 'f1', is_active: 1 },
      { id: 'sr2', friend_id: 'other', is_active: 1 },
    ],
    // 紹介だけでも到達できる tier を含む (= 選択的経路。silver は紹介 3 人で到達可)
    membership_tiers: [
      { id: 'bronze', display_order: 1, min_total_purchase_jpy: 0, min_referral_count: 0 },
      { id: 'silver', display_order: 2, min_total_purchase_jpy: 12000, min_referral_count: 3 },
      { id: 'gold', display_order: 3, min_total_purchase_jpy: 24000, min_referral_count: 0 },
    ],
  };
}

interface FakeStmt {
  _sql: string;
  _b: unknown[];
}

/** SQL 文字列で分岐する fake D1。batch は本物と同じく順に適用する。 */
function makeDb(store: Store): D1Database {
  const run = (sql: string, b: unknown[], viaBatch = false): { meta: { changes: number } } => {
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
      // 🚨 WHERE 句を解釈する (採点ループ HIGH: fake がガードをハードコードすると
      //    実装から述語を消しても緑のままになる)。連携先 1 行に絞る変異を殺すため、
      //    「customer 指定があるか」も SQL から読む。
      const scopedToCustomer = /shopify_customer_id\s*=\s*\?/.test(sql);
      const fid = b[1] as string;
      for (const c of store.shopify_customers) {
        if (scopedToCustomer) continue; // 絞る実装 = 他の customer 行が残る (テストが検出する)
        if (c.friend_id === fid) {
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
      // 🚨 tier は再計算する実装。fake も determineEligibleTier と同じ判定を写す
      //    (bronze 決め打ちを期待すると、紹介で得た tier を奪う実装が緑になる)
      const recomputesTier = /current_tier_id\s*=\s*COALESCE/i.test(sql);
      const fid = b[1] as string;
      for (const m of store.members) {
        if (m.friend_id === fid) {
          if (clearsTotal) m.total_purchase_jpy = 0;
          if (clearsLast) m.last_purchase_at = null;
          if (recomputesTier) {
            const eligible = store.membership_tiers
              .filter((t) => t.min_total_purchase_jpy <= 0 || (t.min_referral_count > 0 && t.min_referral_count <= m.total_referral_count))
              .sort((a, b) => b.display_order - a.display_order)[0];
            const lowest = [...store.membership_tiers].sort((a, b) => a.display_order - b.display_order)[0];
            m.current_tier_id = (eligible ?? lowest)?.id ?? m.current_tier_id;
          }
          changes++;
        }
      }
    } else if (sql.includes('UPDATE subscription_reminders')) {
      const fid = b[1] as string;
      const onlyActive = /is_active\s*=\s*1/.test(sql);
      for (const r of store.subscription_reminders) {
        if (r.friend_id === fid && (!onlyActive || r.is_active === 1)) {
          r.is_active = 0;
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
    } else if (sql.includes('INSERT INTO audit_logs')) {
      // 🚨 解除の境界マーカー (2026-08-28 Codex P1)。**batch の中**で書かれることが要点。
      store.audit_logs.push({
        id: b[0] as string,
        action: 'account_link.unlink_boundary',
        target_id: b[1] as string,
        created_at: b[2] as string,
        viaBatch,
      });
      changes++;
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
          return run(sql, stmt._b, false);
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
    async batch(stmts: unknown[]) {
      return stmts.map((s) => {
        const st = s as unknown as FakeStmt;
        return run(st._sql, st._b, true);
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

  it('🚨 購入で得た tier は落ちる (¥0 なのに上位 tier で凍結させない)', async () => {
    const store = seed();
    // 紹介 2 人 = silver の閾値 (3 人) に届かない → 購入額 0 では bronze まで落ちる
    expect(store.members[0].current_tier_id).toBe('gold');
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(store.members[0].current_tier_id).toBe('bronze');
  });

  it('🚨 紹介で得た tier は奪わない (tier は再計算する。bronze 決め打ちにしない)', async () => {
    const store = seed();
    // 紹介 3 人 = silver の閾値を満たす → 購入額 0 でも silver は維持されるべき
    store.members[0].total_referral_count = 3;
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(store.members[0].current_tier_id).toBe('silver');
    // 紹介実績そのものも温存 (連携と無関係なので)
    expect(store.members[0].total_referral_count).toBe(3);
  });

  it('🚨 その friend を指す shopify_customers 行を全部外す (連携先 1 行に絞ると購入額が漏れ続ける)', async () => {
    const store = seed();
    await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    // '900' (連携先) だけでなく '800' (過去の取りこぼし) も外れる
    expect(store.shopify_customers.filter((c) => c.friend_id === 'f1')).toHaveLength(0);
    // 他人の行は無傷
    expect(store.shopify_customers.find((c) => c.shopify_customer_id === '700')!.friend_id).toBe('other');
  });

  it('🚨 再注文リマインダーを止める (残すと稼働定期便への「再購入時期です」push の抑止が反転して発火する)', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(r.cleared.reorderReminders).toBe(1);
    expect(store.subscription_reminders.find((x) => x.id === 'sr1')!.is_active).toBe(0);
    // 他人のリマインダーは触らない
    expect(store.subscription_reminders.find((x) => x.id === 'sr2')!.is_active).toBe(1);
    // 行は消さない (顧客が再設定できる・監査も残る)
    expect(store.subscription_reminders).toHaveLength(2);
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

  // 🚨 2026-08-28 Codex P1: 境界マーカーを worker 側の auditSystem (best-effort) に任せると、
  //    「解除は成功したのに記録だけ書けなかった」瞬間に境界が消え、再連携後の取り込み判定が
  //    前回の完了記録を拾って**ランクが永久に ¥0** になる。解除→再連携は顧客に案内している
  //    復旧手順なので、境界は状態変更と**原子的**でなければならない。
  it('🚨 解除の境界マーカーを batch の中で書く (best-effort の監査に依存しない)', async () => {
    const store = seed();
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(r.unlinked).toBe(true);

    const boundary = store.audit_logs.filter((a) => a.action === 'account_link.unlink_boundary');
    expect(boundary).toHaveLength(1);
    expect(boundary[0].target_id).toBe('f1');
    // 観測点は「batch を通ったこと」。単発 run() で書くと状態変更と原子的でなくなる。
    expect(boundary[0].viaBatch).toBe(true);
    // 取り込み判定は created_at の大小で比べるので、時刻が入っていること
    expect(boundary[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('連携していない friend には境界マーカーを書かない (no-op)', async () => {
    const store = seed();
    store.friends.find((f) => f.id === 'f1')!.shopify_customer_id = null;
    const r = await unlinkFriendFromShopifyCustomer(makeDb(store), 'f1');
    expect(r.unlinked).toBe(false);
    expect(store.audit_logs).toHaveLength(0);
  });
});
