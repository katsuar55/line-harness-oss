/**
 * 固定額 3 issuer の mutation payload 契約 (Ultraplan PR-C) — 実 SQLite + fetch body 実測。
 *
 * 🚨 最重要は recurringCycleLimit:1 の存在。appliesOnSubscription を付けた固定額券で
 * これを欠くと、契約に保存されたコードが**毎サイクル永久に**引かれ続け、契約からは
 * 我々の app では外せない (owner=Huckleberry のみ)。採点ループ abuse CRITICAL #1。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));

import { issueCouponForFriend } from '../services/shopify-coupon-issuer.js';
import { issueReferralCoupon } from '../services/referral-coupon-issuer.js';
import { issueLinkRewardCoupon } from '../services/link-reward-coupon-issuer.js';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';

const FIXED_NOW = Date.parse('2026-08-13T12:00:00.000Z');

interface BasicInput {
  code?: string;
  combinesWith?: { productDiscounts?: boolean; orderDiscounts?: boolean };
  minimumRequirement?: { subtotal?: { greaterThanOrEqualToSubtotal?: string } };
  recurringCycleLimit?: number;
  customerGets?: {
    appliesOnSubscription?: boolean;
    appliesOnOneTimePurchase?: boolean;
    value?: { discountAmount?: { amount?: number } };
  };
}

function captureFetch() {
  const captured: BasicInput[] = [];
  const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { variables?: { basicCodeDiscount?: BasicInput } };
    const input = body.variables?.basicCodeDiscount;
    if (input) captured.push(input);
    const code = input?.code ?? 'X';
    return new Response(
      JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://n', codeDiscount: { codes: { nodes: [{ code }] } } }, userErrors: [] } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, captured };
}

/** 3 issuer 共通の契約 (固定額券) */
function assertFixedAmountContract(input: BasicInput, amount: number) {
  expect(input.recurringCycleLimit).toBe(1); // 🚨 初回サイクルのみ (欠落 = 毎サイクル垂れ流し)
  expect(input.customerGets?.appliesOnSubscription).toBe(true);
  expect(input.customerGets?.appliesOnOneTimePurchase).toBe(true);
  expect(input.minimumRequirement?.subtotal?.greaterThanOrEqualToSubtotal).toBe('2000');
  expect(input.combinesWith?.productDiscounts).toBe(true);
  expect(input.combinesWith?.orderDiscounts).toBe(true);
  expect(input.customerGets?.value?.discountAmount?.amount).toBe(amount);
}

beforeEach(() => vi.clearAllMocks());

describe('固定額 3 issuer の payload 契約 (min¥2,000 / サブスク初回のみ / 併用ON)', () => {
  it('welcome: ¥500 + combinesWith (2026-08-24 に ¥300 → ¥500 へ戻す・併用ON は 2026-08-13 Katsu 決定)', async () => {
    const raw = createSchemaDb(); insertFriend(raw, 'F1');
    const { fn, captured } = captureFetch();
    const r = await issueCouponForFriend(asD1(raw), { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' }, {
      friendId: 'F1', fetchImpl: fn, now: () => FIXED_NOW,
    });
    expect(r?.discountValue).toBe(500);
    assertFixedAmountContract(captured[0], 500);
  });

  it('紹介: ¥500 (60日・活性化起点は queue 側で検証済み)', async () => {
    const raw = createSchemaDb(); insertFriend(raw, 'F1');
    const { fn, captured } = captureFetch();
    const r = await issueReferralCoupon(asD1(raw), { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's', REFERRAL_REWARD_ENABLED: 'true' }, {
      friendId: 'F1', role: 'referrer', rewardId: 'rw1', fetchImpl: fn, now: () => FIXED_NOW,
    });
    expect(r?.discountValue).toBe(500);
    assertFixedAmountContract(captured[0], 500);
  });

  it('連携: ¥300 / 30日 (2026-08-13 Katsu 確定)', async () => {
    const raw = createSchemaDb(); insertFriend(raw, 'F1');
    const { fn, captured } = captureFetch();
    const r = await issueLinkRewardCoupon(asD1(raw), { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's', LINK_REWARD_ENABLED: 'true' }, {
      friendId: 'F1', shopifyCustomerId: 'sc1', linkPath: 'sub_link', fetchImpl: fn, now: () => FIXED_NOW,
    });
    expect(r?.discountValue).toBe(300);
    expect(r?.expiresAt).toBe(new Date(FIXED_NOW + 30 * 86_400_000).toISOString());
    assertFixedAmountContract(captured[0], 300);
  });
});
