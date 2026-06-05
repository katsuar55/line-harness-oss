/**
 * Tests for @line-crm/db membership (= Phase 4-κ hardening、 2026-05-29)
 *
 * 既存 membership.test.ts は services 層を db mock で test するため、
 * 本ファイルは **実 @line-crm/db 関数** を in-memory D1 mock で直接 test する
 * (= addPurchaseEvent の atomic 加算 / 冪等性 / 金額正規化 + determineEligibleTier の tier 判定)。
 *
 * カバー対象 (= 予防 review で発見した bug):
 *   - F-4: total_purchase_jpy lost-update race → atomic ON CONFLICT 加算
 *   - F-5: applied_at CAS claim による二重加算防止
 *   - F-2: NaN / 負数 amount の 0 正規化
 *   - determineEligibleTier: OR 判定 + active tier ゼロ時の明示 throw
 *
 * NOTE: 本ファイルは意図的に `vi.mock('@line-crm/db')` を **呼ばない**
 *       (= 実装を exercise するため)。 vi.mock は file scope なので他 test に影響なし。
 */
import { describe, it, expect } from 'vitest';
import {
  addPurchaseEvent,
  determineEligibleTier,
  getMemberByFriendId,
  getPurchaseEventByOrderId,
  type MembershipTier,
} from '@line-crm/db';

// ============================================================
// in-memory D1 mock (= member_purchase_events + members の SQL を解釈)
// ============================================================

interface EventRow {
  id: string;
  shopify_order_id: string;
  friend_id: string | null;
  amount_jpy: number;
  currency: string;
  order_number: number | null;
  email: string | null;
  phone: string | null;
  applied_at: string | null;
  source: string;
  occurred_at: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  id: string;
  friend_id: string;
  current_tier_id: string;
  total_purchase_jpy: number;
  total_referral_count: number;
  last_purchase_at: string | null;
  last_promotion_at: string | null;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

function makeDb() {
  const eventsById = new Map<string, EventRow>();
  const eventsByOrder = new Map<string, string>();
  const members = new Map<string, MemberRow>();

  function prepare(sql: string) {
    const params: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        params.push(...args);
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (sql.includes('FROM member_purchase_events') && sql.includes('shopify_order_id = ?')) {
          const id = eventsByOrder.get(params[0] as string);
          return ((id ? eventsById.get(id) : null) ?? null) as T | null;
        }
        if (sql.includes('FROM members') && sql.includes('friend_id = ?')) {
          return ((members.get(params[0] as string) ?? null) as T) ?? null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[]; success: boolean }> {
        return { results: [], success: true };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        // INSERT event
        if (sql.includes('INSERT INTO member_purchase_events')) {
          const [id, orderId, friendId, amount] = params as [string, string, string | null, number];
          // bind 順: id,order,friend,amount,currency,order_number,email,phone,source,occurred_at,metadata,...
          const source = (params[8] as string) ?? 'webhook';
          const occurredAt = (params[9] as string | null) ?? null;
          const row: EventRow = {
            id,
            shopify_order_id: orderId,
            friend_id: friendId,
            amount_jpy: amount,
            currency: 'JPY',
            order_number: null,
            email: null,
            phone: null,
            applied_at: null,
            source,
            occurred_at: occurredAt,
            metadata: null,
            created_at: '',
            updated_at: '',
          };
          eventsById.set(id, row);
          eventsByOrder.set(orderId, id);
          return { success: true, meta: { changes: 1 } };
        }
        // CAS claim: applied_at NULL → now、 既 applied なら changes=0
        if (sql.includes('UPDATE member_purchase_events') && sql.includes('applied_at IS NULL')) {
          const [appliedAt, friendId, , id] = params as [string, string, string, string];
          const row = eventsById.get(id);
          if (row && row.applied_at == null) {
            row.applied_at = appliedAt;
            row.friend_id = friendId;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        // members atomic upsert (= ON CONFLICT 加算)
        if (sql.includes('INSERT INTO members') && sql.includes('ON CONFLICT')) {
          const [id, friendId, amount, lastPurchase] = params as [string, string, number, string];
          const existing = members.get(friendId);
          if (existing) {
            existing.total_purchase_jpy += amount;
            existing.last_purchase_at = lastPurchase;
          } else {
            members.set(friendId, {
              id,
              friend_id: friendId,
              current_tier_id: 'bronze',
              total_purchase_jpy: amount,
              total_referral_count: 0,
              last_purchase_at: lastPurchase,
              last_promotion_at: null,
              joined_at: '',
              created_at: '',
              updated_at: '',
            });
          }
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
    return stmt;
  }

  return { prepare } as unknown as D1Database;
}

// ============================================================
// tier fixtures (= 本番 seed と一致: migration 058)
// ============================================================

function tier(
  id: string,
  displayOrder: number,
  minTotalPurchaseJpy: number,
  minReferralCount: number,
  isActive = true,
): MembershipTier {
  return {
    id,
    name: id,
    displayOrder,
    minTotalPurchaseJpy,
    minReferralCount,
    perks: {},
    badgeEmoji: null,
    badgeColor: null,
    isActive,
  };
}

const SEED_TIERS: MembershipTier[] = [
  tier('bronze', 1, 0, 0),
  tier('silver', 2, 10000, 0),
  tier('gold', 3, 30000, 0),
  tier('platinum', 4, 100000, 3),
  tier('ambassador', 5, 200000, 10),
];

// ============================================================
// addPurchaseEvent
// ============================================================

describe('addPurchaseEvent', () => {
  it('first purchase: member を seed + 金額加算 + applied', async () => {
    const db = makeDb();
    const r = await addPurchaseEvent(db, {
      shopifyOrderId: 'o1',
      friendId: 'f1',
      amountJpy: 1980,
    });
    expect(r.applied).toBe(true);
    expect(r.inserted).toBe(true);
    expect(r.newTotalPurchaseJpy).toBe(1980);
    const m = await getMemberByFriendId(db, 'f1');
    expect(m?.totalPurchaseJpy).toBe(1980);
  });

  it('2 件目の異なる order は overwrite せず加算 (= F-4 lost-update fix)', async () => {
    const db = makeDb();
    await addPurchaseEvent(db, { shopifyOrderId: 'o1', friendId: 'f1', amountJpy: 1980 });
    const r2 = await addPurchaseEvent(db, { shopifyOrderId: 'o2', friendId: 'f1', amountJpy: 3000 });
    expect(r2.newTotalPurchaseJpy).toBe(4980);
    const m = await getMemberByFriendId(db, 'f1');
    expect(m?.totalPurchaseJpy).toBe(4980);
  });

  it('同一 order の再実行は冪等 (= 二重加算しない)', async () => {
    const db = makeDb();
    await addPurchaseEvent(db, { shopifyOrderId: 'o1', friendId: 'f1', amountJpy: 1980 });
    const dup = await addPurchaseEvent(db, { shopifyOrderId: 'o1', friendId: 'f1', amountJpy: 1980 });
    expect(dup.applied).toBe(true);
    expect(dup.inserted).toBe(false);
    expect(dup.reason).toContain('duplicate');
    const m = await getMemberByFriendId(db, 'f1');
    expect(m?.totalPurchaseJpy).toBe(1980); // 加算は 1 回だけ
  });

  it('NaN 金額は 0 に正規化 (= F-2 money guard)', async () => {
    const db = makeDb();
    const r = await addPurchaseEvent(db, {
      shopifyOrderId: 'o-nan',
      friendId: 'f2',
      amountJpy: Number('not-a-number'),
    });
    expect(r.applied).toBe(true);
    expect(r.amountJpy).toBe(0);
    const m = await getMemberByFriendId(db, 'f2');
    expect(m?.totalPurchaseJpy).toBe(0);
  });

  it('負数 / 小数金額は floor + 0 下限', async () => {
    const db = makeDb();
    await addPurchaseEvent(db, { shopifyOrderId: 'neg', friendId: 'f3', amountJpy: -500 });
    expect((await getMemberByFriendId(db, 'f3'))?.totalPurchaseJpy).toBe(0);
    await addPurchaseEvent(db, { shopifyOrderId: 'dec', friendId: 'f4', amountJpy: 1980.9 });
    expect((await getMemberByFriendId(db, 'f4'))?.totalPurchaseJpy).toBe(1980);
  });

  it('friend 未マッチは event のみ記録、 member 加算なし', async () => {
    const db = makeDb();
    const r = await addPurchaseEvent(db, {
      shopifyOrderId: 'o-nomatch',
      friendId: null,
      amountJpy: 5000,
    });
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('friend not matched');
    expect(await getMemberByFriendId(db, 'nobody')).toBeNull();
  });

  it('未適用 event の後追い friend マッチで claim + 加算 (= retry/enrichment path)', async () => {
    const db = makeDb();
    // 1 回目: friend 未マッチ → event だけ applied_at NULL で記録
    await addPurchaseEvent(db, { shopifyOrderId: 'o-late', friendId: null, amountJpy: 2500 });
    expect(await getMemberByFriendId(db, 'f-late')).toBeNull();
    // 2 回目: 同 order に friend が判明 → claim 成功 + 加算
    const r = await addPurchaseEvent(db, { shopifyOrderId: 'o-late', friendId: 'f-late', amountJpy: 2500 });
    expect(r.applied).toBe(true);
    expect(r.inserted).toBe(false); // 既存 event を再利用
    expect((await getMemberByFriendId(db, 'f-late'))?.totalPurchaseJpy).toBe(2500);
  });

  it('occurredAt を渡すと occurred_at 列に保存される (= PR3-B backfill 経路、 実注文日)', async () => {
    const db = makeDb();
    await addPurchaseEvent(db, {
      shopifyOrderId: 'o-bf',
      friendId: 'f-bf',
      amountJpy: 5000,
      source: 'backfill',
      occurredAt: '2025-08-01T00:00:00.000+09:00',
    });
    const row = await getPurchaseEventByOrderId(db, 'o-bf');
    expect(row?.occurred_at).toBe('2025-08-01T00:00:00.000+09:00');
    expect(row?.source).toBe('backfill');
  });

  it('occurredAt 未指定なら occurred_at は NULL (= webhook 後方互換 / created_at fallback)', async () => {
    const db = makeDb();
    await addPurchaseEvent(db, { shopifyOrderId: 'o-wh', friendId: 'f-wh', amountJpy: 1980 });
    const row = await getPurchaseEventByOrderId(db, 'o-wh');
    expect(row?.occurred_at ?? null).toBeNull();
    expect(row?.source).toBe('webhook');
  });
});

// ============================================================
// determineEligibleTier (= 純関数)
// ============================================================

describe('determineEligibleTier', () => {
  it('購入 0 / 紹介 0 → bronze', () => {
    expect(determineEligibleTier(SEED_TIERS, 0, 0).id).toBe('bronze');
  });

  it('購入 10000 → silver、 25000 → silver (< gold 閾値)', () => {
    expect(determineEligibleTier(SEED_TIERS, 10000, 0).id).toBe('silver');
    expect(determineEligibleTier(SEED_TIERS, 25000, 0).id).toBe('silver');
  });

  it('購入 30000 → gold、 100000 → platinum、 200000 → ambassador', () => {
    expect(determineEligibleTier(SEED_TIERS, 30000, 0).id).toBe('gold');
    expect(determineEligibleTier(SEED_TIERS, 100000, 0).id).toBe('platinum');
    expect(determineEligibleTier(SEED_TIERS, 200000, 0).id).toBe('ambassador');
  });

  it('紹介 path (= OR): 購入 0 + 紹介 3 → platinum、 紹介 10 → ambassador', () => {
    expect(determineEligibleTier(SEED_TIERS, 0, 3).id).toBe('platinum');
    expect(determineEligibleTier(SEED_TIERS, 0, 10).id).toBe('ambassador');
  });

  it('min_referral_count=0 の tier は紹介数で昇格しない (= purchase only)', () => {
    // silver は min_referral_count=0 → 紹介 5 でも購入 0 なら bronze 止まり
    expect(determineEligibleTier(SEED_TIERS, 0, 5).id).toBe('platinum'); // platinum(ref3) は満たす
    expect(determineEligibleTier([tier('bronze', 1, 0, 0), tier('silver', 2, 10000, 0)], 0, 99).id).toBe(
      'bronze',
    );
  });

  it('active tier が 1 つも無い → 明示 throw (= undefined crash 防止)', () => {
    const allInactive = SEED_TIERS.map((t) => ({ ...t, isActive: false }));
    expect(() => determineEligibleTier(allInactive, 99999, 0)).toThrow(/no active membership tiers/);
  });
});
