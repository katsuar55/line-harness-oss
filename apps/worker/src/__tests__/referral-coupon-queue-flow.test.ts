/**
 * 紹介クーポン順次活性化 (queue) のサービス層フロー — 実 SQLite + fake fetch (2026-08-13 R1)。
 *
 * Covers:
 *   - issueOrEnqueue: 生きた 1 枚なし → 即発行 (issued)。queue 行は activated で閉じる
 *   - issueOrEnqueue: 生きた 1 枚あり → queued (Shopify を呼ばない)
 *   - issueOrEnqueue: 冪等 (台帳 hit → existing)
 *   - activateNext: planned_code で発行し台帳 INSERT + queue activated
 *   - activateNext: Shopify 失敗 → waiting へ補償 (再駆動可能)
 *   - activateNext: code taken → codeDiscountNodeByCode lookup で回収 (二重発行なし)
 *   - gate off → 何もしない
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token'),
}));
vi.mock('../services/audit-logger.js', () => ({
  auditSystem: vi.fn(async () => {}),
}));

import {
  issueOrEnqueueReferralCoupon,
  activateNextQueuedReferralCoupon,
  type ReferralCouponEnv,
} from '../services/referral-coupon-issuer.js';
import { findQueueRowByRewardId, enqueueReferralCoupon } from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend, insertReferralLedgerRow } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';

const FIXED_NOW = new Date('2026-08-13T12:00:00.000Z').getTime();

let raw: SqliteDatabase;
let db: D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  raw = createSchemaDb();
  db = asD1(raw);
  insertFriend(raw, 'F1');
});

function makeEnv(overrides: Partial<ReferralCouponEnv> = {}): ReferralCouponEnv {
  return {
    SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
    SHOPIFY_CLIENT_ID: 'id',
    SHOPIFY_CLIENT_SECRET: 'secret',
    REFERRAL_REWARD_ENABLED: 'true',
    ...overrides,
  };
}

/** discountCodeBasicCreate 成功を返す fake fetch (エコーされた code をそのまま返す) */
function makeCreateSuccessFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: { basicCodeDiscount?: { code?: string } };
    };
    const code = body.variables?.basicCodeDiscount?.code ?? 'NREF-R-UNKNOWN';
    return new Response(
      JSON.stringify({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: `gid://shopify/DiscountCodeNode/${code}`,
              codeDiscount: { codes: { nodes: [{ code }] } },
            },
            userErrors: [],
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

describe('issueOrEnqueueReferralCoupon', () => {
  it('生きた 1 枚なし → 即発行 (kind=issued)。queue 行は activated で閉じ、期限は 60 日', async () => {
    const fetchImpl = makeCreateSuccessFetch();
    const res = await issueOrEnqueueReferralCoupon(db, makeEnv(), {
      friendId: 'F1', role: 'referrer', rewardId: 'rw1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(res.kind).toBe('issued');
    if (res.kind !== 'issued') return;
    expect(res.coupon.expiresAt).toBe(new Date(FIXED_NOW + 60 * 86_400_000).toISOString());

    const q = await findQueueRowByRewardId(db, 'rw1');
    expect(q?.status).toBe('activated');
    // 台帳の code は queue の planned_code と一致 (= 発行は planned_code 経由)
    const ledger = raw.prepare(`SELECT coupon_code, status FROM line_referral_coupons WHERE reward_id='rw1'`).get() as { coupon_code: string; status: string };
    expect(ledger.coupon_code).toBe(q?.planned_code);
    expect(ledger.status).toBe('issued');
  });

  it('生きた 1 枚あり → kind=queued (Shopify create を呼ばない・waiting のまま)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_live', code: 'NREF-R-LIVE',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await issueOrEnqueueReferralCoupon(db, makeEnv(), {
      friendId: 'F1', role: 'referrer', rewardId: 'rw2', fetchImpl, now: () => FIXED_NOW,
    });
    expect(res).toEqual({ kind: 'queued', waitingCount: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    const q = await findQueueRowByRewardId(db, 'rw2');
    expect(q?.status).toBe('waiting');
  });

  it('台帳に既にある reward → kind=existing (冪等・Shopify 未呼び出し)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw1', code: 'NREF-R-DONE',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await issueOrEnqueueReferralCoupon(db, makeEnv(), {
      friendId: 'F1', role: 'referrer', rewardId: 'rw1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(res.kind).toBe('existing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gate off → kind=failed (何も書かない)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const res = await issueOrEnqueueReferralCoupon(db, makeEnv({ REFERRAL_REWARD_ENABLED: undefined }), {
      friendId: 'F1', role: 'referrer', rewardId: 'rw1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(res).toEqual({ kind: 'failed' });
    expect(await findQueueRowByRewardId(db, 'rw1')).toBeNull();
  });
});

describe('activateNextQueuedReferralCoupon', () => {
  async function seedWaiting(rewardId: string, plannedCode: string) {
    await enqueueReferralCoupon(db, {
      id: `q_${rewardId}`, friendId: 'F1', rewardId, plannedCode,
      discountValue: 500, createdAt: '2026-08-10T00:00:00.000Z',
    });
  }

  it('waiting を planned_code で発行 → 台帳 INSERT + queue activated + 期限は活性化時起点', async () => {
    await seedWaiting('rw1', 'NREF-R-PLANNED1');
    const fetchImpl = makeCreateSuccessFetch();
    const coupon = await activateNextQueuedReferralCoupon(db, makeEnv(), {
      friendId: 'F1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(coupon?.code).toBe('NREF-R-PLANNED1');
    expect(coupon?.expiresAt).toBe(new Date(FIXED_NOW + 60 * 86_400_000).toISOString());
    const q = await findQueueRowByRewardId(db, 'rw1');
    expect(q?.status).toBe('activated');
  });

  it('Shopify 失敗 → waiting へ補償し、次の呼び出しで再駆動できる', async () => {
    await seedWaiting('rw1', 'NREF-R-PLANNED1');
    const failFetch = vi.fn(async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
    const coupon = await activateNextQueuedReferralCoupon(db, makeEnv(), {
      friendId: 'F1', fetchImpl: failFetch, now: () => FIXED_NOW,
    });
    expect(coupon).toBeNull();
    const q = await findQueueRowByRewardId(db, 'rw1');
    expect(q?.status).toBe('waiting'); // 補償済み

    // 再駆動 → 成功
    const okFetch = makeCreateSuccessFetch();
    const retry = await activateNextQueuedReferralCoupon(db, makeEnv(), {
      friendId: 'F1', fetchImpl: okFetch, now: () => FIXED_NOW,
    });
    expect(retry?.code).toBe('NREF-R-PLANNED1');
  });

  it('code taken (前回 create 成功済み) → codeDiscountNodeByCode で回収し台帳 INSERT (二重発行なし)', async () => {
    await seedWaiting('rw1', 'NREF-R-TAKEN01');
    const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      if (body.query?.includes('discountCodeBasicCreate')) {
        return new Response(
          JSON.stringify({
            data: { discountCodeBasicCreate: { userErrors: [{ code: 'TAKEN', message: 'Discount code is already taken' }] } },
          }),
          { status: 200 },
        );
      }
      // codeDiscountNodeByCode lookup
      return new Response(
        JSON.stringify({ data: { codeDiscountNodeByCode: { id: 'gid://shopify/DiscountCodeNode/RECOVERED' } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const coupon = await activateNextQueuedReferralCoupon(db, makeEnv(), {
      friendId: 'F1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(coupon?.code).toBe('NREF-R-TAKEN01');
    expect(coupon?.shopifyDiscountCodeId).toBe('gid://shopify/DiscountCodeNode/RECOVERED');
    const ledger = raw.prepare(`SELECT coupon_code FROM line_referral_coupons WHERE reward_id='rw1'`).get() as { coupon_code: string };
    expect(ledger.coupon_code).toBe('NREF-R-TAKEN01');
  });

  it('waiting なし → null (Shopify 未呼び出し)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const coupon = await activateNextQueuedReferralCoupon(db, makeEnv(), {
      friendId: 'F1', fetchImpl, now: () => FIXED_NOW,
    });
    expect(coupon).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gate off → null (claim すらしない)', async () => {
    await seedWaiting('rw1', 'NREF-R-X');
    const coupon = await activateNextQueuedReferralCoupon(db, makeEnv({ REFERRAL_REWARD_ENABLED: undefined }), {
      friendId: 'F1', now: () => FIXED_NOW,
    });
    expect(coupon).toBeNull();
    const q = await findQueueRowByRewardId(db, 'rw1');
    expect(q?.status).toBe('waiting');
  });
});
