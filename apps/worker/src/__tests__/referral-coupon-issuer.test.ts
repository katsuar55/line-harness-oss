/**
 * Tests for referral-coupon-issuer (紹介した側=referrer の獲得クーポン発行, 2026-07-10 改訂).
 *
 * 仕様 (Katsu 確定):
 *   - referred の ¥500 = 友だち追加 welcome クーポン (= 本 issuer は使わない)。
 *   - referrer は紹介成立ごとに ¥500 を 1 枚獲得 (= 無制限)。 冪等キーは reward_id (成立1件)。
 *
 * Covers:
 *   - gate off (REFERRAL_REWARD_ENABLED!=true) → null、 Shopify を呼ばない
 *   - rewardId 未指定 → null (= 冪等キー必須)
 *   - 既発行 (reward_id 一致) → 冪等 return、 Shopify を呼ばない
 *   - 同 referrer でも別 reward なら別途発行 (= 無制限紹介)
 *   - 新規発行 → 固定額¥500 / usageLimit:1 / combinesWith.orderDiscounts の mutation + DB INSERT
 *   - config/token/HTTP/userErrors 失敗系 → null
 *   - UNIQUE(reward_id) 競合 → re-fetch して既存 code
 *   - generateReferralCode の形式 / getActiveReferralCoupons (複数) / findReferralCoupon(reward_id)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  issueReferralCoupon,
  getActiveReferralCoupons,
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
    const isSelectByReward =
      sql.includes('SELECT coupon_code') && sql.includes('FROM line_referral_coupons') && sql.includes('reward_id = ?');
    const isSelectActive =
      sql.includes('FROM line_referral_coupons') && sql.includes("status = 'issued'");
    const isInsertCoupon = sql.includes('INSERT INTO line_referral_coupons');
    const isInsertAudit = sql.includes('INSERT INTO audit_logs');
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isSelectByReward) {
            const rewardId = params[0] as string;
            const row = this.rows.find((r) => r.reward_id === rewardId);
            if (!row) return null;
            return {
              coupon_code: row.coupon_code,
              discount_value: row.discount_value,
              discount_currency: row.discount_currency,
              expires_at: row.expires_at,
              shopify_discount_code_id: row.shopify_discount_code_id,
            };
          }
          return null;
        },
        all: async () => {
          if (isSelectActive) {
            const friendId = params[0] as string;
            const iso = params[1] as string;
            const results = this.rows
              .filter(
                (r) => r.friend_id === friendId && r.status === 'issued' && (r.expires_at === null || r.expires_at >= iso),
              )
              .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1))
              .map((r) => ({ coupon_code: r.coupon_code, discount_value: r.discount_value, role: r.role, expires_at: r.expires_at }));
            return { results };
          }
          return { results: [] };
        },
        run: async () => {
          if (isInsertCoupon) {
            if (this.failInsertOnce) {
              this.failInsertOnce = false;
              // 同 reward が並行 insert された状態を再現 (re-fetch で見つかる)
              this.rows.push({
                id: 'concurrent',
                friend_id: params[1] as string,
                reward_id: (params[2] as string | null) ?? null,
                role: params[3] as string,
                coupon_code: 'NREF-R-CONCURRENT',
                shopify_discount_code_id: 'gid://concurrent',
                discount_value: 500,
                discount_currency: 'JPY',
                issued_at: params[8] as string,
                expires_at: (params[9] as string | null) ?? null,
                status: 'issued',
                line_account_id: (params[10] as string | null) ?? null,
              });
              throw new Error('UNIQUE constraint failed: line_referral_coupons.reward_id');
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

function makeSuccessFetch(actualCode = 'NREF-R-ABCD2345', discountId = 'gid://shopify/DiscountCodeNode/999') {
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

/** referrer 発行の最小 options */
function issueOpts(overrides: Record<string, unknown> = {}) {
  return { friendId: 'A', role: 'referrer' as const, rewardId: 'rw1', now: () => FIXED_NOW, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('shpat_test_token_xxx');
});

describe('issueReferralCoupon — gate / precondition', () => {
  it('gate off (REFERRAL_REWARD_ENABLED != true) → null かつ Shopify を呼ばない', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ REFERRAL_REWARD_ENABLED: undefined }),
      issueOpts({ fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(0);
  });

  it("REFERRAL_REWARD_ENABLED='true\\r' (CRLF trap) は off 扱い → null", async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ REFERRAL_REWARD_ENABLED: 'true\r' }),
      issueOpts({ fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rewardId 未指定 → null (= 冪等キー必須、 Shopify を呼ばない)', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(),
      issueOpts({ rewardId: null, fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(0);
  });
});

describe('issueReferralCoupon — issuance', () => {
  it('新規発行 → 固定額¥500 / usageLimit:1 / appliesOncePerCustomer:true / combinesWith.orderDiscounts:true + DB INSERT (reward_id)', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch('NREF-R-ABCD2345');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(),
      issueOpts({ rewardId: 'rw1', fetchImpl }));
    expect(res).not.toBeNull();
    expect(res!.code).toBe('NREF-R-ABCD2345');
    expect(res!.role).toBe('referrer');
    expect(res!.discountValue).toBe(500);
    expect(res!.isExisting).toBe(false);
    // 2026-08-13 R1: 期限 7 → 60 日 (起点 = 発行/活性化時点。待機中は走らない)
    expect(res!.expiresAt).toBe(new Date(FIXED_NOW + 60 * 86_400_000).toISOString());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit;
    const input = JSON.parse(init.body as string).variables.basicCodeDiscount;
    expect(input.customerGets.value.discountAmount.amount).toBe(500);
    expect(input.usageLimit).toBe(1);
    expect(input.appliesOncePerCustomer).toBe(true);
    expect(input.combinesWith.orderDiscounts).toBe(true);
    expect(input.combinesWith.productDiscounts).toBe(true);
    expect(input.combinesWith.shippingDiscounts).toBe(false);

    expect(db.rows.length).toBe(1);
    expect(db.rows[0].reward_id).toBe('rw1');
    expect(db.rows[0].coupon_code).toBe('NREF-R-ABCD2345');
  });

  it('既発行 (reward_id 一致) → 冪等 return、 Shopify を呼ばない', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', reward_id: 'rw1', role: 'referrer', coupon_code: 'NREF-R-EXISTING',
      shopify_discount_code_id: 'gid://x', discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-07-08T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ rewardId: 'rw1', fetchImpl }));
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NREF-R-EXISTING');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('同 referrer でも別 reward なら別途発行できる (= 無制限紹介、 friend では冪等化しない)', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', reward_id: 'rw1', role: 'referrer', coupon_code: 'NREF-R-AAA',
      shopify_discount_code_id: 'gid://x', discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-01T00:00:00.000Z', expires_at: null, status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch('NREF-R-BBB');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ friendId: 'A', rewardId: 'rw2', fetchImpl }));
    expect(res!.code).toBe('NREF-R-BBB');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(db.rows.length).toBe(2); // A は rw1 と rw2 の 2 枚
  });

  it('Shopify config 未設定 → null', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv({ SHOPIFY_STORE_DOMAIN: undefined }),
      issueOpts({ fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('access token 取得失敗 → null', async () => {
    const db = new FakeDb();
    mockGetToken.mockRejectedValueOnce(new Error('token unavailable'));
    const fetchImpl = makeSuccessFetch();
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Shopify HTTP error → null', async () => {
    const db = new FakeDb();
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(),
      issueOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
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
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(),
      issueOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(res).toBeNull();
    expect(db.rows.length).toBe(0);
  });

  it('UNIQUE(reward_id) 競合 (並行発行) → re-fetch して既存 code を返す', async () => {
    const db = new FakeDb();
    db.failInsertOnce = true;
    const fetchImpl = makeSuccessFetch('NREF-R-MINE');
    const res = await issueReferralCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ rewardId: 'rw1', fetchImpl }));
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NREF-R-CONCURRENT');
  });
});

describe('generateReferralCode', () => {
  it('referrer → NREF-R-<8>, referred → NREF-D-<8> (ambiguous 0/1/O/I/L 除外)', () => {
    expect(t.generateReferralCode('referrer')).toMatch(/^NREF-R-[A-KMNP-Z2-9]{8}$/);
    expect(t.generateReferralCode('referred')).toMatch(/^NREF-D-[A-KMNP-Z2-9]{8}$/);
  });
});

describe('getActiveReferralCoupons (referrer は複数持ちうる)', () => {
  it('未失効の issued を全件・最新発行順で返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'c1', friend_id: 'A', reward_id: 'rw1', role: 'referrer', coupon_code: 'NREF-R-OLD',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-08T00:00:00.000Z', expires_at: '2026-07-16T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    db.rows.push({
      id: 'c2', friend_id: 'A', reward_id: 'rw2', role: 'referrer', coupon_code: 'NREF-R-NEW',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-09T00:00:00.000Z', expires_at: '2026-07-16T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const res = await getActiveReferralCoupons(db as unknown as D1Database, 'A', '2026-07-10T00:00:00.000Z');
    expect(res.map((c) => c.code)).toEqual(['NREF-R-NEW', 'NREF-R-OLD']);
  });

  it('失効済は除外 → 空配列', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'c1', friend_id: 'A', reward_id: 'rw1', role: 'referrer', coupon_code: 'NREF-R-EXP',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-06-01T00:00:00.000Z', expires_at: '2026-06-08T00:00:00.000Z', status: 'issued', line_account_id: null,
    });
    const res = await getActiveReferralCoupons(db as unknown as D1Database, 'A', '2026-07-10T00:00:00.000Z');
    expect(res).toEqual([]);
  });
});

describe('findReferralCoupon (reward_id)', () => {
  it('reward_id で 1 枚返す / 不一致は null', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', reward_id: 'rw1', role: 'referrer', coupon_code: 'NREF-R-XYZ',
      shopify_discount_code_id: null, discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-09T00:00:00.000Z', expires_at: null, status: 'issued', line_account_id: null,
    });
    expect((await findReferralCoupon(db as unknown as D1Database, 'rw1'))!.coupon_code).toBe('NREF-R-XYZ');
    expect(await findReferralCoupon(db as unknown as D1Database, 'rw2')).toBeNull();
  });
});
