/**
 * Tests for link-reward-coupon-issuer (連携特典クーポン発行, Sprint A-1, 2026-08-11).
 *
 * 仕様:
 *   - 顧客自身の連携完了 (sub-link redeem 新規成功 / email OTP verify 成功) で ¥500 を 1 枚。
 *   - 冪等キーは friend_id (= 1 friend 生涯 1 枚。再連携・経路重複・並行でも増えない)。
 *
 * Covers:
 *   - gate off (LINK_REWARD_ENABLED!=true) → null、Shopify を呼ばない
 *   - 既発行 (friend_id 一致) → 冪等 return、Shopify を呼ばない
 *   - 新規発行 → 固定額¥500 / usageLimit:1 / combinesWith + DB INSERT (link_path 記録)
 *   - config/token/HTTP/userErrors 失敗系 → null
 *   - UNIQUE(friend_id) 競合 → re-fetch して既存 code
 *   - generateLinkRewardCode の形式 / getActiveLinkRewardCoupon (単一・失効除外)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  issueLinkRewardCoupon,
  getActiveLinkRewardCoupon,
  findLinkRewardCoupon,
  __test__ as t,
  type LinkRewardCouponEnv,
} from '../services/link-reward-coupon-issuer.js';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token_xxx'),
}));

import { getShopifyAccessToken } from '../services/shopify-token.js';
const mockGetToken = getShopifyAccessToken as ReturnType<typeof vi.fn>;

interface LinkCouponRow {
  id: string;
  friend_id: string;
  shopify_customer_id: string;
  link_path: string;
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
  rows: LinkCouponRow[] = [];
  failInsertOnce = false;

  prepare(sql: string) {
    const isSelectActive =
      sql.includes('FROM line_link_coupons') && sql.includes("status = 'issued'");
    const isFindByFriend =
      sql.includes('SELECT coupon_code') &&
      sql.includes('FROM line_link_coupons') &&
      sql.includes('friend_id = ?') &&
      !isSelectActive;
    const isInsertCoupon = sql.includes('INSERT INTO line_link_coupons');
    const isInsertAudit = sql.includes('INSERT INTO audit_logs');
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isFindByFriend) {
            const friendId = params[0] as string;
            const row = this.rows.find((r) => r.friend_id === friendId);
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
            const row = this.rows.find(
              (r) =>
                r.friend_id === friendId &&
                r.status === 'issued' &&
                (r.expires_at === null || r.expires_at >= iso),
            );
            if (!row) return null;
            return {
              coupon_code: row.coupon_code,
              discount_value: row.discount_value,
              expires_at: row.expires_at,
            };
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (isInsertCoupon) {
            if (this.failInsertOnce) {
              this.failInsertOnce = false;
              // 同 friend が並行 insert された状態を再現 (re-fetch で見つかる)
              this.rows.push({
                id: 'concurrent',
                friend_id: params[1] as string,
                shopify_customer_id: params[2] as string,
                link_path: params[3] as string,
                coupon_code: 'NLINK-CONCURRENT',
                shopify_discount_code_id: 'gid://concurrent',
                discount_value: 500,
                discount_currency: 'JPY',
                issued_at: params[8] as string,
                expires_at: (params[9] as string | null) ?? null,
                status: 'issued',
                line_account_id: (params[10] as string | null) ?? null,
              });
              throw new Error('UNIQUE constraint failed: line_link_coupons.friend_id');
            }
            this.rows.push({
              id: params[0] as string,
              friend_id: params[1] as string,
              shopify_customer_id: params[2] as string,
              link_path: params[3] as string,
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

const FIXED_NOW = new Date('2026-08-11T00:00:00.000Z').getTime();

function makeEnv(overrides: Partial<LinkRewardCouponEnv> = {}): LinkRewardCouponEnv {
  return {
    SHOPIFY_STORE_DOMAIN: 'naturism-diet.myshopify.com',
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    LINK_REWARD_ENABLED: 'true',
    ...overrides,
  };
}

function makeSuccessFetch(actualCode = 'NLINK-ABCD2345', discountId = 'gid://shopify/DiscountCodeNode/999') {
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

function issueOpts(overrides: Record<string, unknown> = {}) {
  return {
    friendId: 'A',
    shopifyCustomerId: '12345',
    linkPath: 'sub_link' as const,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('shpat_test_token_xxx');
});

describe('issueLinkRewardCoupon — gate / precondition', () => {
  it('gate off (LINK_REWARD_ENABLED != true) → null かつ Shopify を呼ばない', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv({ LINK_REWARD_ENABLED: undefined }),
      issueOpts({ fetchImpl }),
    );
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(0);
  });

  it("LINK_REWARD_ENABLED='true\\r' (CRLF trap) は off 扱い → null", async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv({ LINK_REWARD_ENABLED: 'true\r' }),
      issueOpts({ fetchImpl }),
    );
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('issueLinkRewardCoupon — issuance', () => {
  it('新規発行 → 固定額¥500 / usageLimit:1 / appliesOncePerCustomer:true / combinesWith + DB INSERT (link_path)', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch('NLINK-ABCD2345');
    const res = await issueLinkRewardCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ fetchImpl }));
    expect(res).not.toBeNull();
    expect(res!.code).toBe('NLINK-ABCD2345');
    expect(res!.discountValue).toBe(500);
    expect(res!.isExisting).toBe(false);
    expect(res!.expiresAt).toBe(new Date(FIXED_NOW + 7 * 86_400_000).toISOString());

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
    expect(db.rows[0].friend_id).toBe('A');
    expect(db.rows[0].shopify_customer_id).toBe('12345');
    expect(db.rows[0].link_path).toBe('sub_link');
    expect(db.rows[0].coupon_code).toBe('NLINK-ABCD2345');
  });

  it('既発行 (friend_id 一致) → 冪等 return、Shopify を呼ばない (= 再連携で 2 枚目は出ない)', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', shopify_customer_id: '12345', link_path: 'sub_link',
      coupon_code: 'NLINK-EXISTING', shopify_discount_code_id: 'gid://x',
      discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-08-01T00:00:00.000Z', expires_at: '2026-08-08T00:00:00.000Z',
      status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch();
    const res = await issueLinkRewardCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ fetchImpl }));
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NLINK-EXISTING');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(1);
  });

  it('別経路 (email_otp) で再連携しても friend_id 冪等で同じ 1 枚', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', shopify_customer_id: '12345', link_path: 'sub_link',
      coupon_code: 'NLINK-FIRST', shopify_discount_code_id: null,
      discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-08-01T00:00:00.000Z', expires_at: null,
      status: 'issued', line_account_id: null,
    });
    const fetchImpl = makeSuccessFetch('NLINK-SECOND');
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv(),
      issueOpts({ linkPath: 'email_otp', fetchImpl }),
    );
    expect(res!.code).toBe('NLINK-FIRST');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows.length).toBe(1);
  });

  it('Shopify config 未設定 → null', async () => {
    const db = new FakeDb();
    const fetchImpl = makeSuccessFetch();
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv({ SHOPIFY_STORE_DOMAIN: undefined }),
      issueOpts({ fetchImpl }),
    );
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('access token 取得失敗 → null', async () => {
    const db = new FakeDb();
    mockGetToken.mockRejectedValueOnce(new Error('token unavailable'));
    const fetchImpl = makeSuccessFetch();
    const res = await issueLinkRewardCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ fetchImpl }));
    expect(res).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Shopify HTTP error → null', async () => {
    const db = new FakeDb();
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv(),
      issueOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res).toBeNull();
    expect(db.rows.length).toBe(0);
  });

  it('Shopify userErrors → null', async () => {
    const db = new FakeDb();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { discountCodeBasicCreate: { userErrors: [{ code: 'TAKEN', message: 'code taken' }] } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const res = await issueLinkRewardCoupon(
      db as unknown as D1Database,
      makeEnv(),
      issueOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res).toBeNull();
    expect(db.rows.length).toBe(0);
  });

  it('UNIQUE(friend_id) 競合 (並行発行) → re-fetch して既存 code を返す', async () => {
    const db = new FakeDb();
    db.failInsertOnce = true;
    const fetchImpl = makeSuccessFetch('NLINK-MINE');
    const res = await issueLinkRewardCoupon(db as unknown as D1Database, makeEnv(), issueOpts({ fetchImpl }));
    expect(res!.isExisting).toBe(true);
    expect(res!.code).toBe('NLINK-CONCURRENT');
  });
});

describe('generateLinkRewardCode', () => {
  it('NLINK-<8> (ambiguous 0/1/O/I/L 除外)', () => {
    expect(t.generateLinkRewardCode()).toMatch(/^NLINK-[A-KMNP-Z2-9]{8}$/);
  });
});

describe('getActiveLinkRewardCoupon (1 friend 1 枚)', () => {
  it('未失効の issued を 1 枚返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'c1', friend_id: 'A', shopify_customer_id: '12345', link_path: 'sub_link',
      coupon_code: 'NLINK-ACTIVE', shopify_discount_code_id: null,
      discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-08-08T00:00:00.000Z', expires_at: '2026-08-16T00:00:00.000Z',
      status: 'issued', line_account_id: null,
    });
    const res = await getActiveLinkRewardCoupon(db as unknown as D1Database, 'A', '2026-08-11T00:00:00.000Z');
    expect(res!.code).toBe('NLINK-ACTIVE');
    expect(res!.discountValue).toBe(500);
  });

  it('失効済は null', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'c1', friend_id: 'A', shopify_customer_id: '12345', link_path: 'sub_link',
      coupon_code: 'NLINK-EXP', shopify_discount_code_id: null,
      discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-07-08T00:00:00.000Z',
      status: 'issued', line_account_id: null,
    });
    const res = await getActiveLinkRewardCoupon(db as unknown as D1Database, 'A', '2026-08-11T00:00:00.000Z');
    expect(res).toBeNull();
  });

  it('DB 例外 (pre-migration) は fail-safe null', async () => {
    const db = {
      prepare() {
        throw new Error('no such table: line_link_coupons');
      },
    };
    const res = await getActiveLinkRewardCoupon(db as unknown as D1Database, 'A');
    expect(res).toBeNull();
  });
});

describe('findLinkRewardCoupon (friend_id)', () => {
  it('friend_id で 1 枚返す / 不一致は null', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'x', friend_id: 'A', shopify_customer_id: '12345', link_path: 'email_otp',
      coupon_code: 'NLINK-XYZ', shopify_discount_code_id: null,
      discount_value: 500, discount_currency: 'JPY',
      issued_at: '2026-08-09T00:00:00.000Z', expires_at: null,
      status: 'issued', line_account_id: null,
    });
    expect((await findLinkRewardCoupon(db as unknown as D1Database, 'A'))!.coupon_code).toBe('NLINK-XYZ');
    expect(await findLinkRewardCoupon(db as unknown as D1Database, 'B')).toBeNull();
  });
});
