/**
 * Tests for rank-discount-issuer (= 自社内製ロイヤリティ PR5-5a, 2026-06-04)
 *
 * ランク割引の発行 (discountCodeBasicCreate) を検証:
 *   - 本番ガード (RANK_DISCOUNT_ENABLED) で no-op
 *   - regular 0% は発行しない
 *   - 新規発行 → Shopify 作成 + DB 記録 + GraphQL body (percentage/combinesWith/items.all/NLR)
 *   - 冪等 (同 rank 再利用) / ランク変更 (supersede + 新規)
 *   - Shopify userErrors → null・DB 記録なし
 * getShopifyAccessToken は vi.mock (= issuer は static import のみで dynamic import 干渉トラップなし)。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token_xxx'),
}));

import { issueRankDiscountForFriend, __test__ } from '../services/rank-discount-issuer.js';
import { getActiveRankDiscountCode, insertRankDiscount } from '@line-crm/db';

// ─── stateful fake D1 (loyalty_rank_discounts のみ) ───
interface FakeRow {
  id: string;
  friend_id: string;
  rank_id: string;
  code: string;
  shopify_discount_node_id: string | null;
  discount_percent: number;
  status: string;
  brand_id: string | null;
  issued_at: string;
  expires_at: string | null;
  superseded_at: string | null;
}

function makeDb(): D1Database & { rows: FakeRow[] } {
  const rows: FakeRow[] = [];
  const db = {
    rows,
    prepare(sql: string) {
      const stmt = {
        _binds: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._binds = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM loyalty_rank_discounts') && sql.includes("status = 'active'")) {
            const fid = stmt._binds[0];
            const active = rows
              .filter((r) => r.friend_id === fid && r.status === 'active')
              .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1));
            return (active[0] ? { ...active[0] } : null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          const b = stmt._binds;
          if (sql.includes('INSERT INTO loyalty_rank_discounts')) {
            if (rows.some((r) => r.code === b[3])) {
              throw new Error('UNIQUE constraint failed: loyalty_rank_discounts.code');
            }
            rows.push({
              id: b[0] as string,
              friend_id: b[1] as string,
              rank_id: b[2] as string,
              code: b[3] as string,
              shopify_discount_node_id: (b[4] as string) ?? null,
              discount_percent: b[5] as number,
              status: 'active',
              brand_id: (b[6] as string) ?? null,
              issued_at: b[7] as string,
              expires_at: (b[8] as string) ?? null,
              superseded_at: null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE loyalty_rank_discounts') && sql.includes("status = 'superseded'")) {
            const exceptId = b[2] as string | undefined; // insert→supersede 順序で新 id を除外
            let changes = 0;
            for (const r of rows) {
              if (
                r.friend_id === b[1] &&
                r.status === 'active' &&
                (exceptId === undefined || r.id !== exceptId)
              ) {
                r.status = 'superseded';
                r.superseded_at = b[0] as string;
                changes++;
              }
            }
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { rows: FakeRow[] };
}

const ENV_ON = {
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'sec',
  RANK_DISCOUNT_ENABLED: 'true',
};

function mockFetchOk(code = 'NLR-SILVER-ABCD2345', id = 'gid://shopify/DiscountCodeNode/1') {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: { id, codeDiscount: { codes: { nodes: [{ code }] } } },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      ),
  );
}

describe('issueRankDiscountForFriend', () => {
  it('本番ガード off (RANK_DISCOUNT_ENABLED!=true) → null・本番未書込', async () => {
    const db = makeDb();
    const fetchImpl = mockFetchOk();
    const r = await issueRankDiscountForFriend(
      db,
      { ...ENV_ON, RANK_DISCOUNT_ENABLED: undefined },
      { friendId: 'f1', rankId: 'silver', discountPercent: 4, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r).toBeNull();
    expect(db.rows).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('regular (0%) → 割引コード発行しない', async () => {
    const db = makeDb();
    const fetchImpl = mockFetchOk();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f1',
      rankId: 'regular',
      discountPercent: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('新規発行: Shopify 作成 + DB 記録 + active 化', async () => {
    const db = makeDb();
    const fetchImpl = mockFetchOk('NLR-SILVER-ABCD2345', 'gid://shopify/DiscountCodeNode/9');
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f1',
      rankId: 'silver',
      discountPercent: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).not.toBeNull();
    expect(r?.code).toBe('NLR-SILVER-ABCD2345');
    expect(r?.discountPercent).toBe(4);
    expect(r?.isExisting).toBe(false);
    expect(r?.shopifyDiscountNodeId).toBe('gid://shopify/DiscountCodeNode/9');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].status).toBe('active');
  });

  it('GraphQL body: percentage=0.06 / combinesWith / items.all / NLR コード / 再利用可', async () => {
    const db = makeDb();
    let captured: { variables: { basicCodeDiscount: Record<string, unknown> } } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: 'gid://x/1',
                codeDiscount: { codes: { nodes: [{ code: 'NLR-GOLD-ZZZZ2345' }] } },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200 },
      );
    });
    await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f2',
      rankId: 'gold',
      discountPercent: 6,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const input = captured!.variables.basicCodeDiscount as {
      customerGets: {
        value: { percentage: number };
        items: { all: boolean };
        appliesOnSubscription: boolean;
        appliesOnOneTimePurchase: boolean;
      };
      combinesWith: Record<string, boolean>;
      code: string;
      usageLimit: number | null;
      appliesOncePerCustomer: boolean;
      recurringCycleLimit: number;
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: string } };
      customerSelection: Record<string, unknown>;
    };
    expect(input.customerGets.value.percentage).toBeCloseTo(0.06);
    expect(input.customerGets.items.all).toBe(true);
    // PR-D: 定期便対応 (appliesOnSubscription は customerGets の中) + cycle 0 = 契約に無期限固着
    expect(input.customerGets.appliesOnSubscription).toBe(true);
    expect(input.customerGets.appliesOnOneTimePurchase).toBe(true);
    expect(input.recurringCycleLimit).toBe(0); // 🚨 固定額券の 1 と逆 — ランク%は毎サイクル継続が仕様
    expect(input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe('2000');
    // 未連携 friend (fake db は friends を返さない) → 従来どおり all
    expect(input.customerSelection).toEqual({ all: true });
    expect(input.combinesWith).toEqual({
      productDiscounts: true,
      orderDiscounts: true,
      shippingDiscounts: false,
    });
    expect(input.code).toMatch(/^NLR-GOLD-/);
    expect(input.usageLimit).toBeNull();
    expect(input.appliesOncePerCustomer).toBe(false);
  });

  it('冪等: 同 rank の active があれば再利用 (Shopify 呼ばない)', async () => {
    const db = makeDb();
    const first = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f3',
      rankId: 'silver',
      discountPercent: 4,
      fetchImpl: mockFetchOk('NLR-SILVER-FIRST234') as unknown as typeof fetch,
    });
    const fetch2 = mockFetchOk('NLR-SILVER-SECOND23');
    const second = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f3',
      rankId: 'silver',
      discountPercent: 4,
      fetchImpl: fetch2 as unknown as typeof fetch,
    });
    expect(second?.code).toBe(first?.code);
    expect(second?.isExisting).toBe(true);
    expect(fetch2).not.toHaveBeenCalled();
    expect(db.rows.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('ランク変更: 旧 active を superseded 化 + 新規発行', async () => {
    const db = makeDb();
    await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f4',
      rankId: 'silver',
      discountPercent: 4,
      fetchImpl: mockFetchOk('NLR-SILVER-OLD12345') as unknown as typeof fetch,
      now: () => 1000,
    });
    const up = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f4',
      rankId: 'gold',
      discountPercent: 6,
      fetchImpl: mockFetchOk('NLR-GOLD-NEW123456') as unknown as typeof fetch,
      now: () => 2000,
    });
    expect(up?.rankId).toBe('gold');
    expect(up?.code).toBe('NLR-GOLD-NEW123456');
    expect(db.rows.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(db.rows.find((r) => r.status === 'active')?.rank_id).toBe('gold');
    expect(db.rows.filter((r) => r.status === 'superseded')).toHaveLength(1);
  });

  it('Shopify userErrors → null・DB 記録なし', async () => {
    const db = makeDb();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: null,
                userErrors: [{ code: 'TAKEN', message: 'code taken' }],
              },
            },
          }),
          { status: 200 },
        ),
    );
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'f5',
      rankId: 'silver',
      discountPercent: 4,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
    expect(db.rows).toHaveLength(0);
  });

  it('generateRankCode: NLR-{RANK}-{8文字 base31}', () => {
    const code = __test__.generateRankCode('silver');
    expect(code).toMatch(/^NLR-SILVER-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(__test__.rankLabel('platinum')).toBe('PLATINUM');
  });
});

describe('getActiveRankDiscountCode (5b アクセサ)', () => {
  const NOW_ISO = '2026-08-15T00:00:00.000Z';

  it('active があれば {code, discountPercent}', async () => {
    const db = makeDb();
    await insertRankDiscount(db, {
      id: 'i1',
      friendId: 'fa',
      rankId: 'gold',
      code: 'NLR-GOLD-AAAA2345',
      shopifyDiscountNodeId: 'gid://x/1',
      discountPercent: 6,
      issuedAt: '2026-06-04T00:00:00Z',
      expiresAt: null,
    });
    expect(await getActiveRankDiscountCode(db, 'fa', NOW_ISO)).toEqual({
      code: 'NLR-GOLD-AAAA2345',
      discountPercent: 6,
    });
  });

  it('無ければ null', async () => {
    const db = makeDb();
    expect(await getActiveRankDiscountCode(db, 'none', NOW_ISO)).toBeNull();
  });

  it('期限切れコードは null (PR-D: 死んだコードを permalink に出さない → lazy 再発行が発火)', async () => {
    const db = makeDb();
    await insertRankDiscount(db, {
      id: 'i2',
      friendId: 'fb',
      rankId: 'gold',
      code: 'NLR-GOLD-DEAD2345',
      shopifyDiscountNodeId: 'gid://x/2',
      discountPercent: 6,
      issuedAt: '2026-06-04T00:00:00Z',
      expiresAt: '2026-07-19T00:00:00.000Z', // NOW より過去
    });
    expect(await getActiveRankDiscountCode(db, 'fb', NOW_ISO)).toBeNull();
  });
});
