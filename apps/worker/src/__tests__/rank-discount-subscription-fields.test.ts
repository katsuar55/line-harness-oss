/**
 * ランク NLR- issuer の mutation payload 契約 (Ultraplan PR-D) — 実 SQLite + fetch body 実測。
 *
 * 🚨 最重要 2 点:
 *   - recurringCycleLimit は **0** (固定額 3 券の 1 と逆)。契約に保存された%は再評価なしで
 *     毎サイクル適用され続ける (公式確定) — 「2回目以降 5% + ランク%継続」はこの 0 が実現する。
 *   - customerSelection は連携済み (shopify_customer_id 保有) なら **customer 限定**。
 *     従来の all + usageLimit 無制限は SNS 漏洩で止血不能な唯一の非有界リークだった
 *     (採点ループ abuse CRITICAL #2)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));

import { issueRankDiscountForFriend } from '../services/rank-discount-issuer.js';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';

const FIXED_NOW = Date.parse('2026-08-15T00:00:00.000Z');

interface BasicInput {
  code?: string;
  customerSelection?: Record<string, unknown>;
  combinesWith?: { productDiscounts?: boolean; orderDiscounts?: boolean; shippingDiscounts?: boolean };
  minimumRequirement?: { subtotal?: { greaterThanOrEqualToSubtotal?: string } };
  recurringCycleLimit?: number;
  usageLimit?: number | null;
  appliesOncePerCustomer?: boolean;
  customerGets?: {
    appliesOnSubscription?: boolean;
    appliesOnOneTimePurchase?: boolean;
    value?: { percentage?: number };
    items?: { all?: boolean };
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
      JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://n/1', codeDiscount: { codes: { nodes: [{ code }] } } }, userErrors: [] } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, captured };
}

const ENV_ON = {
  SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
  SHOPIFY_CLIENT_ID: 'i',
  SHOPIFY_CLIENT_SECRET: 's',
  RANK_DISCOUNT_ENABLED: 'true',
};

beforeEach(() => vi.clearAllMocks());

describe('ランク NLR- の payload 契約 (定期便固着 / 顧客限定 / min¥2,000)', () => {
  it('連携済み friend → customer 限定 + cycle:0 + サブスク可 + min¥2,000 (契約の全量)', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, 'F1');
    raw.prepare(`UPDATE friends SET shopify_customer_id = '777' WHERE id = 'F1'`).run();
    const { fn, captured } = captureFetch();

    const r = await issueRankDiscountForFriend(asD1(raw), ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4,
      fetchImpl: fn, now: () => FIXED_NOW,
    });

    expect(r?.code).toMatch(/^NLR-SILVER-/);
    const input = captured[0];
    // 顧客限定 (リーク止血の本丸)
    expect(input.customerSelection).toEqual({ customers: { add: ['gid://shopify/Customer/777'] } });
    // 定期便固着の 3 点セット
    expect(input.customerGets?.appliesOnSubscription).toBe(true);
    expect(input.customerGets?.appliesOnOneTimePurchase).toBe(true);
    expect(input.recurringCycleLimit).toBe(0); // 🚨 固定額券の 1 と逆 — 毎サイクル継続が仕様
    // 共通ガード
    expect(input.minimumRequirement?.subtotal?.greaterThanOrEqualToSubtotal).toBe('2000');
    expect(input.combinesWith).toEqual({ productDiscounts: true, orderDiscounts: true, shippingDiscounts: false });
    // ランク割引の従来性質 (再利用可・無制限)
    expect(input.usageLimit).toBeNull();
    expect(input.appliesOncePerCustomer).toBe(false);
    expect(input.customerGets?.value?.percentage).toBeCloseTo(0.04);
    expect(input.customerGets?.items?.all).toBe(true);
  });

  it('未連携 friend (shopify_customer_id NULL) → 従来どおり all で発行', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, 'F2');
    const { fn, captured } = captureFetch();

    const r = await issueRankDiscountForFriend(asD1(raw), ENV_ON, {
      friendId: 'F2', rankId: 'gold', discountPercent: 6,
      fetchImpl: fn, now: () => FIXED_NOW,
    });

    expect(r).not.toBeNull();
    expect(captured[0].customerSelection).toEqual({ all: true });
  });

  it('friend lookup 失敗 → fail-closed (発行しない・Shopify 未呼出)。連携済みの コードを transient エラーで all に落とさない', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, 'F3');
    const inner = asD1(raw);
    // friends の SELECT だけ落とすラッパ (D1 transient エラーの再現)
    const throwing = {
      prepare(sql: string) {
        if (sql.includes('FROM friends')) {
          return {
            bind: () => ({ first: async () => { throw new Error('D1_ERROR: network'); } }),
          };
        }
        return inner.prepare(sql);
      },
    } as unknown as D1Database;
    const { fn } = captureFetch();

    const r = await issueRankDiscountForFriend(throwing, ENV_ON, {
      friendId: 'F3', rankId: 'gold', discountPercent: 6,
      fetchImpl: fn, now: () => FIXED_NOW,
    });

    expect(r).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
