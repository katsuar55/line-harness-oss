/**
 * Tests for referral-coupon-issuer (友だち紹介の両側実クーポン発行, 2026-07-10).
 *
 * Covers:
 *   - gate off (REFERRAL_REWARD_ENABLED!=true) → null、 Shopify を呼ばない (本番未書込)
 *   - 既発行 (friend × role) → 再発行せず既存 code を返す (冪等)
 *   - 新規発行 → Shopify mutation に固定額 ¥500 / usageLimit:1 / appliesOncePerCustomer:true /
 *     combinesWith.orderDiscounts:true を含む + DB INSERT (role 付き)
 *   - Shopify config 未設定 → null / access token 失敗 → null / HTTP error → null / userErrors → null
 *   - 並行 INSERT 競合 (UNIQUE(friend_id,role)) → re-fetch して既存 code
 *   - generateReferralCode の形式 / getActiveReferralCoupon の表示 read
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  issueReferralCoupon,
  getActiveReferralCoupon,
  findReferralCoupon,
  __test__ as t,
  type ReferralCouponEnv,
} from '../services/referral-coupon-issuer.js';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token_xxx'),
}));

import { getShopifyAccessToken } from '../services/shopify-token.js';
const mockGetToken = getShopifyAccessToken as ReturnType<typeof vi.fn>;

interface ReferralCouponRow {
  id: string;
  friend_id: string;
  reward_id: string | null;
  role: string;
  coupon_code: string;
  shopify_discount_code_id: string | null;
  discount_value: number;
  discount_currency: string;
  issued_at: string;
  expires_at: string | null;
  status: string;
  line_account_id: string | null;
}

class FakeDb {
  rows: ReferralCouponRow[] = [];
  failInsertOnce = false;

  prepare(sql: string) {
    const isSelectCoupon =
      sql.includes('SELECT coupon_code') && sql.includes('FROM line_referral_coupons') && sql.includes('role = ?');
    const isSelectActive =
      sql.includes('FROM line_referral_coupons') && sql.includes("status = 'issued'");
    const isInsertCoupon = sql.includes('INSERT INTO line_referral_coupons');
    const isInsertAudit = sql.includes('INSERT INTO audit_logs');
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isSelectCoupon) {
            const friendId = params[0] as string;
            const role = params[1] as string;
            const row = this.rows.find((r) => r.friend_id === friendId && r.role === role);
            if (!row) return null;
            return {
              coupon_code: row.coupon_code,
              discount_value: row.discount_value,
              discount_currency: row.discount_currency,
              expires_at: row.expires_at,
              shopify_discount_code_id: row.shopify_discount_code_id,
            };
          }
          if (isSelectActive) {
            const friendId = params[0] as string;
            const iso = params[1] as string;
            const active = this.rows
              .filter(
                (r) =>
                  r.friend_id === friendId &&
                  r.status === 'issued' &&
                  (r.expires_at === null || r.expires_at >= iso),
              )
              .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1))[0];
            if (!active) return null;
            return {
              coupon_code: active.coupon_code,
              discount_value: active.discount_value,
              role: active.role,
              expires_at: active.expires_at,
            };
          }
          return null;
        },
        run: async () => {
          if (isInsertCoupon) {
            if (this.failInsertOnce) {
              this.failInsertOnce = false;
              // 並行 insert が先に成功した状態を再現 (re-fetch で見つかる)
              this.rows.push({
                id: 'concurrent',
                friend_id: params[1] as string,
                reward_id: (params[2] as string | null) ?? null,
                role: params[3] as string,
                coupon_code: 'NREF-D-CONCURRENT',
                shopify_discount_code_id: 'gid://concurrent',
                discount_value: 500,
                discount_currency: 'JPY',
                issued_at: params[8] as string,
                expires_at: (params[9] as string | null) ?? null,
                status: 'issued',
                line_account_id: (params[10] as string | null) ?? null,
              });
              throw new Error('UNIQUE constraint failed: line_referral_coupons.friend_id, line_referral_coupons.role');
            }
            this.rows.push({
              id: params[0] as string,
              friend_id: params[1] as string,
              reward_id: (params[2] as string | null) ?? null,
              role: params[3] as string,
              coupon_code: params[4] as string,
              shopify_discount_code_id: (params[5] as string | null) ?? null,
              discount_value: params[6] as number,
              discount_currency: params[7] as string,
              issued_at: params[8] as string,
              expires_at: (params[9] as string | null) ?? null,
              status: 'issued',
              line_account_id: (params[10] as string | null) ?? null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (isInsertAudit) {
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true };
        },
      }),
    };
  }
}

const FIXED_NOW = new Date('2026-07-10T00:00:00.000Z').getTime();

function makeEnv(overrides: Partial<ReferralCouponEnv> = {}): ReferralCouponEnv {
  return {
    SHOPIFY_STORE_DOMAIN: 'naturism-diet.myshopify.com',
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    REFERRAL_REWARD_ENABLED: 'true',
    ...overrides,
  };
}

function makeSuccessFetch(actualCode = 'NREF-D-ABCD2345', discountId = 'gid://shopify/DiscountCodeNode/999') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: discountId,
              codeDiscount: { codes: { nodes: [{ code: actualCode }] } },
            },
            userErrors: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('shpat_test_token_xxx');
});

describe('issueReferralCoupon — gate', () => {
  it('gate off (REFERRAL_REWARD_ENABLED != true) → null かつ Shopify を呼ばない', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ REFERRAL_REWARD_ENABLED: undefined }), {
      friendId: 'f1',
      role: 'referred',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(0);
  });

  it("REFERRAL_REWARD_ENABLED='true\\r' (CRLF trap) は off 扱い → null", async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ REFERRAL_REWARD_ENABLED: 'true\r' }), {
      friendId: 'f1',
      role: 'referred',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('issueReferralCoupon — issuance', () => {
  it('新規 referred → Shopify mutation に 固定額¥500 / usageLimit:1 / appliesOncePerCustomer:true / combinesWith.orderDiscounts:true を含み、 DB に role=referred で INSERT', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch('NREF-D-ABCD2345');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1',
      role: 'referred',
      rewardId: 'rw1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(res).not.toBeNull();
    expect(res!.code).toBe('NREF-D-ABCD2345');
    expect(res!.role).toBe('referred');
    expect(res!.discountValue).toBe(500);
    expect(res!.isExisting).toBe(false);
    // 7日後 expiry
    expect(res!.expiresAt).toBe(new Date(FIXED_NOW + 7 * 86_400_000).toISOString());

    // Shopify mutation body の検証
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    const input = body.variables.basicCodeDiscount;
    expect(input.customerGets.value.discountAmount.amount).toBe(500);
    expect(input.usageLimit).toBe(1);
    expect(input.appliesOncePerCustomer).toBe(true);
    expect(input.combinesWith.orderDiscounts).toBe(true);
    expect(input.combinesWith.productDiscounts).toBe(true);
    expect(input.combinesWith.shippingDiscounts).toBe(false);

    // DB 行
    expect(db.rows.length).toBe(1);
    expect(db.rows[0].role).toBe('referred');
    expect(db.rows[0].reward_id).toBe('rw1');
    expect(db.rows[0].coupon_code).toBe('NREF-D-ABCD2345');
  });

  it('既発行 (friend × role) → 冪等 return、 Shopify を呼ばない', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'f1', reward_id: 'rw1', role: 'referred', coupon_code: 'NREF-D-EXISTING',
      shopify_discount_code_id: 'gid://x', discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-07-08T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NREF-D-EXISTING');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('同 friend でも role が違えば別途発行できる (referred と referrer 共存)', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'f1', reward_id: null, role: 'referred', coupon_code: 'NREF-D-AAA',
      shopify_discount_code_id: 'gid://x', discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-01T00:00:00.000Z', expires_at: null, status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch('NREF-R-BBB');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referrer', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res!.role).toBe('referrer');
    expect(res!.code).toBe('NREF-R-BBB');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(db.rows.length).toBe(2);
  });

  it('Shopify config 未設定 → null', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ SHOPIFY_STORE_DOMAIN: undefined }), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('access token 取得失敗 → null', async () => {
    const db = new FakeDb();
    mockGetToken.mockRejectedValueOnce(new Error('token unavailable'));
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Shopify HTTP error → null', async () => {
    const db = new FakeDb();
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(db.rows.length).toBe(0);
  });

  it('Shopify userErrors → null', async () => {
    const db = new FakeDb();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { discountCodeBasicCreate: { userErrors: [{ code: 'TAKEN', message: 'code taken' }] } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res).toBeNull();
    expect(db.rows.length).toBe(0);
  });

  it('UNIQUE 競合 (並行発行) → re-fetch して既存 code を返す', async () => {
    const db = new FakeDb();
    db.failInsertOnce = true;
    const fetchImpl = makeSuccessFetch('NREF-D-MINE');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), {
      friendId: 'f1', role: 'referred', fetchImpl: fetchImpl as unknown as typeof fetch, now: () => FIXED_NOW,
    });
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NREF-D-CONCURRENT');
  });
});

describe('generateReferralCode', () => {
  it('referred → NREF-D-<8>, referrer → NREF-R-<8> (ambiguous 0/1/O/I/L 除外)', () => {
    const d = t.generateReferralCode('referred');
    const r = t.generateReferralCode('referrer');
    expect(d).toMatch(/^NREF-D-[A-KMNP-Z2-9]{8}$/);
    expect(r).toMatch(/^NREF-R-[A-KMNP-Z2-9]{8}$/);
  });
});

describe('getActiveReferralCoupon', () => {
  it('未失効の issued を最新発行順で1枚返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'f1', reward_id: null, role: 'referred', coupon_code: 'NREF-D-ACTIVE',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-09T00:00:00.000Z', expires_at: '2026-07-16T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const res = await getActiveReferralCoupon(db as unknown as D1Database, 'f1', '2026-07-10T00:00:00.000Z');
    expect(res!.code).toBe('NREF-D-ACTIVE');
    expect(res!.role).toBe('referred');
  });

  it('失効済 → null', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'f1', reward_id: null, role: 'referred', coupon_code: 'NREF-D-EXPIRED',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-06-01T00:00:00.000Z', expires_at: '2026-06-08T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const res = await getActiveReferralCoupon(db as unknown as D1Database, 'f1', '2026-07-10T00:00:00.000Z');
    expect(res).toBeNull();
  });
});

describe('findReferralCoupon', () => {
  it('friend × role で 1 枚返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'f1', reward_id: null, role: 'referrer', coupon_code: 'NREF-R-XYZ',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-09T00:00:00.000Z', expires_at: null, status: 'issued', line_account_id: null,
    });
    const row = await findReferralCoupon(db as unknown as D1Database, 'f1', 'referrer');
    expect(row!.coupon_code).toBe('NREF-R-XYZ');
    const none = await findReferralCoupon(db as unknown as D1Database, 'f1', 'referred');
    expect(none).toBeNull();
  });
});
