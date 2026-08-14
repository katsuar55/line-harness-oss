/**
 * Tests for welcome クーポン redemption 追跡 — 第2波-⑤ (2026-07-01)
 *
 * Covers:
 *   db (packages/db/src/coupon-redemption.ts):
 *     - redeemFriendCouponByCode: 未一致 / 初回 redeem / 既 redeemed (冪等) / 並行で負け / 空 code
 *     - getCouponRedemptionStats: 転換率計算 / issued=0 / outstanding 下限
 *   service (apps/worker/src/services/coupon-redemption.ts):
 *     - extractDiscountCodes: 純関数 (空 / 非配列 / 非文字列 / trim / 大小無視 dedup)
 *     - processOrderCouponRedemption: code なし no-op / 一致+redeem で audit / 既 redeemed で audit なし
 */

import { describe, it, expect } from 'vitest';
import {
  redeemFriendCouponByCode,
  getCouponRedemptionStats,
} from '@line-crm/db';
import {
  extractDiscountCodes,
  processOrderCouponRedemption,
} from '../services/coupon-redemption.js';

// ============================================================
// Programmable Fake D1
// ============================================================

interface CouponRow {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  coupon_code: string;
  redeemed_at: string | null;
  status: string;
  discount_value: number;
}

class FakeDb {
  coupons: CouponRow[];
  auditInserts: unknown[][] = [];
  /** force the conditional UPDATE to report changes=0 (並行で負けた simulate) */
  forceUpdateLoss = false;
  /** simulate a transient D1 error when the coupon SELECT binds this code */
  throwOnSelectCode: string | null = null;

  constructor(coupons: CouponRow[] = []) {
    this.coupons = coupons;
  }

  prepare(sql: string) {
    const isSelectCoupon =
      sql.includes('SELECT id, friend_id') && sql.includes('FROM line_friend_coupons');
    const isUpdateCoupon = sql.includes('UPDATE line_friend_coupons');
    const isStats = sql.includes('COUNT(*) AS issued');
    const isAuditInsert = sql.includes('INSERT INTO audit_logs');
    const isAuditReadback = sql.includes('FROM audit_logs') && sql.includes('WHERE id');

    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isAuditReadback) {
            // insertAuditLog reads back the inserted row; return a truthy stub
            return { id: String(params[0]) };
          }
          if (isSelectCoupon) {
            if (this.throwOnSelectCode !== null && String(params[0]) === this.throwOnSelectCode) {
              throw new Error('transient D1 error');
            }
            const code = String(params[0]).toUpperCase();
            const row = this.coupons.find((r) => r.coupon_code.toUpperCase() === code);
            if (!row) return null;
            return {
              id: row.id,
              friend_id: row.friend_id,
              line_account_id: row.line_account_id,
              redeemed_at: row.redeemed_at,
              status: row.status,
            };
          }
          if (isStats) {
            const issued = this.coupons.length;
            const isRedeemed = (r: CouponRow) => r.status === 'redeemed' || r.redeemed_at !== null;
            const redeemed = this.coupons.filter(isRedeemed).length;
            const expired = this.coupons.filter((r) => r.status === 'expired').length;
            const revoked = this.coupons.filter((r) => r.status === 'revoked').length;
            const redeemed_value = this.coupons
              .filter(isRedeemed)
              .reduce((s, r) => s + r.discount_value, 0);
            return { issued, redeemed, expired, revoked, redeemed_value };
          }
          return null;
        },
        run: async () => {
          if (isUpdateCoupon) {
            const redeemedAt = params[0] as string;
            const id = params[2] as string;
            const row = this.coupons.find((r) => r.id === id);
            if (this.forceUpdateLoss || !row || row.redeemed_at !== null) {
              return { success: true, meta: { changes: 0 } };
            }
            row.redeemed_at = redeemedAt;
            row.status = 'redeemed';
            return { success: true, meta: { changes: 1 } };
          }
          if (isAuditInsert) {
            this.auditInserts.push(params);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      }),
    };
  }
}

function coupon(overrides: Partial<CouponRow> = {}): CouponRow {
  return {
    id: 'c1',
    friend_id: 'f1',
    line_account_id: null,
    coupon_code: 'LINE-ABCD2345',
    redeemed_at: null,
    status: 'issued',
    discount_value: 500,
    ...overrides,
  };
}

// ============================================================
// extractDiscountCodes (pure)
// ============================================================

describe('extractDiscountCodes', () => {
  it('returns [] when discount_codes is missing', () => {
    expect(extractDiscountCodes({})).toEqual([]);
  });

  it('returns [] when discount_codes is not an array', () => {
    expect(extractDiscountCodes({ discount_codes: 'LINE-X' })).toEqual([]);
  });

  it('extracts code strings from discount_codes entries', () => {
    const body = {
      discount_codes: [
        { code: 'LINE-ABCD2345', amount: '500.00', type: 'fixed_amount' },
        { code: 'NLR-GOLD10', amount: '10.0', type: 'percentage' },
      ],
    };
    expect(extractDiscountCodes(body)).toEqual(['LINE-ABCD2345', 'NLR-GOLD10']);
  });

  it('trims whitespace and skips empty/non-string codes', () => {
    const body = {
      discount_codes: [
        { code: '  LINE-TRIM23  ' },
        { code: '' },
        { code: null },
        { amount: '5' },
        { code: 42 },
      ],
    };
    expect(extractDiscountCodes(body)).toEqual(['LINE-TRIM23']);
  });

  it('dedups case-insensitively (keeps first form)', () => {
    const body = {
      discount_codes: [{ code: 'LINE-ABcd2345' }, { code: 'line-abcd2345' }],
    };
    expect(extractDiscountCodes(body)).toEqual(['LINE-ABcd2345']);
  });
});

// ============================================================
// redeemFriendCouponByCode
// ============================================================

describe('redeemFriendCouponByCode', () => {
  it('returns matched=false when code not found', async () => {
    const db = new FakeDb([coupon()]);
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, 'NOPE-9999', '2026-07-01T00:00:00.000Z');
    expect(r.matched).toBe(false);
    expect(r.redeemed).toBe(false);
    expect(r.friendId).toBeNull();
  });

  it('returns matched=false for empty/whitespace code (no query)', async () => {
    const db = new FakeDb([coupon()]);
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, '   ', '2026-07-01T00:00:00.000Z');
    expect(r.matched).toBe(false);
  });

  it('redeems an issued coupon on first call (atomic win)', async () => {
    const db = new FakeDb([coupon()]);
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, 'LINE-ABCD2345', '2026-07-01T03:04:05.000Z');
    expect(r.matched).toBe(true);
    expect(r.redeemed).toBe(true);
    expect(r.alreadyRedeemed).toBe(false);
    expect(r.friendId).toBe('f1');
    expect(db.coupons[0].redeemed_at).toBe('2026-07-01T03:04:05.000Z');
    expect(db.coupons[0].status).toBe('redeemed');
  });

  it('matches case-insensitively', async () => {
    const db = new FakeDb([coupon()]);
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, 'line-abcd2345', '2026-07-01T00:00:00.000Z');
    expect(r.matched).toBe(true);
    expect(r.redeemed).toBe(true);
  });

  it('is idempotent when already redeemed (redeemed_at set)', async () => {
    const db = new FakeDb([coupon({ redeemed_at: '2026-06-30T00:00:00.000Z', status: 'redeemed' })]);
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, 'LINE-ABCD2345', '2026-07-01T00:00:00.000Z');
    expect(r.matched).toBe(true);
    expect(r.redeemed).toBe(false);
    expect(r.alreadyRedeemed).toBe(true);
    // 既存 redeemed_at は上書きしない
    expect(db.coupons[0].redeemed_at).toBe('2026-06-30T00:00:00.000Z');
  });

  it('reports alreadyRedeemed when the conditional UPDATE loses the race (changes=0)', async () => {
    const db = new FakeDb([coupon()]);
    db.forceUpdateLoss = true;
    const r = await redeemFriendCouponByCode(db as unknown as D1Database, 'LINE-ABCD2345', '2026-07-01T00:00:00.000Z');
    expect(r.matched).toBe(true);
    expect(r.redeemed).toBe(false);
    expect(r.alreadyRedeemed).toBe(true);
  });
});

// ============================================================
// getCouponRedemptionStats
// ============================================================

describe('getCouponRedemptionStats', () => {
  it('computes conversion rate and outstanding', async () => {
    const db = new FakeDb([
      coupon({ id: 'a', status: 'issued', redeemed_at: null }),
      coupon({ id: 'b', status: 'redeemed', redeemed_at: '2026-07-01T00:00:00.000Z' }),
      coupon({ id: 'c', status: 'redeemed', redeemed_at: '2026-07-01T00:00:00.000Z' }),
      coupon({ id: 'd', status: 'expired', redeemed_at: null }),
    ]);
    const s = await getCouponRedemptionStats(db as unknown as D1Database);
    expect(s.issued).toBe(4);
    expect(s.redeemed).toBe(2);
    expect(s.expired).toBe(1);
    expect(s.outstanding).toBe(1); // 4 - 2 - 1 - 0
    expect(s.conversionRate).toBe(0.5);
    expect(s.redeemedDiscountValue).toBe(1000);
  });

  it('returns conversionRate=0 when nothing issued', async () => {
    const db = new FakeDb([]);
    const s = await getCouponRedemptionStats(db as unknown as D1Database);
    expect(s.issued).toBe(0);
    expect(s.redeemed).toBe(0);
    expect(s.conversionRate).toBe(0);
    expect(s.outstanding).toBe(0);
  });

  it('counts redeemed_at-present rows as redeemed even if status drifted', async () => {
    const db = new FakeDb([coupon({ status: 'issued', redeemed_at: '2026-07-01T00:00:00.000Z' })]);
    const s = await getCouponRedemptionStats(db as unknown as D1Database);
    expect(s.redeemed).toBe(1);
    expect(s.conversionRate).toBe(1);
  });
});

// ============================================================
// processOrderCouponRedemption (service integration)
// ============================================================

describe('processOrderCouponRedemption', () => {
  it('no-ops when the order carries no discount codes', async () => {
    const db = new FakeDb([coupon()]);
    const r = await processOrderCouponRedemption(db as unknown as D1Database, {
      body: { id: 1, total_price: '3980.00' },
      shopifyOrderId: '1',
      topic: 'orders/create',
    });
    expect(r).toEqual({
      codesChecked: 0,
      matched: 0,
      redeemed: 0,
      redeemedFriendIds: [],
      redeemedReferralFriendIds: [],
      // 台帳別の内訳は「code が 0 件」でも形を保つ (呼び出し側が常に同じ shape を読める)
      byLedger: {
        friend: { matched: 0, redeemed: 0 },
        referral: { matched: 0, redeemed: 0 },
        link: { matched: 0, redeemed: 0 },
      },
    });
    expect(db.auditInserts.length).toBe(0);
  });

  it('redeems a matching welcome coupon and writes an audit row', async () => {
    const db = new FakeDb([coupon()]);
    const r = await processOrderCouponRedemption(db as unknown as D1Database, {
      body: {
        id: 555,
        order_number: 1001,
        financial_status: 'paid',
        discount_codes: [
          { code: 'LINE-ABCD2345', amount: '500.00', type: 'fixed_amount' },
          { code: 'OTHER-CODE', amount: '0', type: 'percentage' },
        ],
      },
      shopifyOrderId: '555',
      topic: 'orders/create',
    });
    expect(r.codesChecked).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.redeemed).toBe(1);
    // 紹介報酬の起点: 初回 redeem した coupon の所有 friend_id を返す (referred がクーポン利用)
    expect(r.redeemedFriendIds).toEqual(['f1']);
    expect(db.coupons[0].status).toBe('redeemed');
    // 1 audit insert for the single redemption
    expect(db.auditInserts.length).toBe(1);
    // action is bind param index 5 (id, line_account_id, actor_type, actor_id, actor_name, action, ...)
    expect(db.auditInserts[0][5]).toBe('line_friend_coupon.redeemed');
  });

  it('does not re-audit an already-redeemed coupon (idempotent re-receipt)', async () => {
    const db = new FakeDb([coupon({ redeemed_at: '2026-06-30T00:00:00.000Z', status: 'redeemed' })]);
    const r = await processOrderCouponRedemption(db as unknown as D1Database, {
      body: { id: 1, discount_codes: [{ code: 'LINE-ABCD2345' }] },
      shopifyOrderId: '1',
      topic: 'orders/updated',
    });
    expect(r.matched).toBe(1);
    expect(r.redeemed).toBe(0);
    expect(r.redeemedFriendIds).toEqual([]); // 既 redeemed → 新規 friend なし
    expect(db.auditInserts.length).toBe(0);
  });

  it('isolates a failure in one code from the others', async () => {
    const db = new FakeDb([coupon()]);
    // the SELECT for 'LINE-BAD' throws; 'LINE-ABCD2345' must still process
    db.throwOnSelectCode = 'LINE-BAD';

    const r = await processOrderCouponRedemption(db as unknown as D1Database, {
      body: { id: 1, discount_codes: [{ code: 'LINE-BAD' }, { code: 'LINE-ABCD2345' }] },
      shopifyOrderId: '1',
      topic: 'orders/create',
    });
    // 2 codes checked; first threw (excluded from matched tally), second matched+redeemed
    expect(r.codesChecked).toBe(2);
    expect(r.matched).toBe(1); // thrown 'LINE-BAD' must not be counted as matched
    expect(r.redeemed).toBe(1);
  });
});
