/**
 * Tests for shopify-customer-sync (2026-05-10 enrichment):
 *  - parseNextUrl (Link header parsing)
 *  - paging (Link header の rel="next" を辿る)
 *  - email_marketing_consent.state の集計
 *  - metadata に opt-in 関連 field が保存される
 *  - 途中 page の API エラーで既存件数を保持
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  syncShopifyCustomers,
  parseNextUrl,
  toFiniteNumber,
} from '../services/shopify-customer-sync.js';

vi.mock('@line-crm/db', () => ({
  upsertShopifyCustomer: vi.fn(async () => undefined),
}));

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token'),
}));

const fakeDb = {} as unknown as D1Database;

const baseEnv = {
  SHOPIFY_STORE_DOMAIN: 'naturism-test.myshopify.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('parseNextUrl', () => {
  it('Link header が null / 空 / next 無しなら null', () => {
    expect(parseNextUrl(null)).toBeNull();
    expect(parseNextUrl('')).toBeNull();
    expect(parseNextUrl('<https://x>; rel="previous"')).toBeNull();
  });

  it('rel="next" の URL を抽出', () => {
    const link = '<https://example.com/customers?page=2>; rel="next"';
    expect(parseNextUrl(link)).toBe('https://example.com/customers?page=2');
  });

  it('previous + next の組合せでも next のみ抽出', () => {
    const link =
      '<https://example.com/customers?page=1>; rel="previous", <https://example.com/customers?page=3>; rel="next"';
    expect(parseNextUrl(link)).toBe('https://example.com/customers?page=3');
  });
});

describe('toFiniteNumber', () => {
  it('有限な数値はそのまま返す (数値 / 数値文字列)', () => {
    expect(toFiniteNumber(0)).toBe(0);
    expect(toFiniteNumber(123)).toBe(123);
    expect(toFiniteNumber('0')).toBe(0);
    expect(toFiniteNumber('1234.5')).toBe(1234.5);
  });

  it('null / undefined / 空文字 は undefined', () => {
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber(undefined)).toBeUndefined();
    expect(toFiniteNumber('')).toBeUndefined();
  });

  it('非数値文字列 / NaN / Infinity は undefined (= DB に NaN を書かない)', () => {
    expect(toFiniteNumber('abc')).toBeUndefined();
    expect(toFiniteNumber('12abc')).toBeUndefined();
    expect(toFiniteNumber(Number.NaN)).toBeUndefined();
    expect(toFiniteNumber(Infinity)).toBeUndefined();
    expect(toFiniteNumber(-Infinity)).toBeUndefined();
  });
});

describe('syncShopifyCustomers', () => {
  it('SHOPIFY_STORE_DOMAIN 未設定なら early error return + 件数 0', async () => {
    const r = await syncShopifyCustomers(fakeDb, {});
    expect(r.error).toMatch(/SHOPIFY_STORE_DOMAIN not configured/);
    expect(r.synced).toBe(0);
    expect(r.pages).toBe(0);
  });

  it('SHOPIFY_STORE_DOMAIN フォーマット不正なら error', async () => {
    const r = await syncShopifyCustomers(fakeDb, {
      SHOPIFY_STORE_DOMAIN: 'invalid.com',
    });
    expect(r.error).toMatch(/Invalid SHOPIFY_STORE_DOMAIN format/);
  });

  it('1 page (Link header 無し) で完了 + email_marketing_consent.state を集計', async () => {
    const customers = [
      { id: 1, email: 'a@x', email_marketing_consent: { state: 'subscribed' } },
      { id: 2, email: 'b@x', email_marketing_consent: { state: 'not_subscribed' } },
      { id: 3, email: 'c@x', email_marketing_consent: { state: 'pending' } },
      { id: 4, email: 'd@x', email_marketing_consent: { state: 'unsubscribed' } },
      { id: 5, email: 'e@x', email_marketing_consent: null },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ customers }), {
          status: 200,
          headers: new Headers(),
        }),
      ),
    );

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.error).toBeUndefined();
    expect(r.synced).toBe(5);
    expect(r.subscribed).toBe(1);
    expect(r.notSubscribed).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.unsubscribed).toBe(1);
    expect(r.pages).toBe(1);
  });

  it('2 page (Link header rel="next") で paging が動作', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        callCount++;
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              customers: [
                { id: 1, email: 'a@x', email_marketing_consent: { state: 'subscribed' } },
              ],
            }),
            {
              status: 200,
              headers: new Headers({
                Link: '<https://naturism-test.myshopify.com/admin/api/2025-07/customers.json?page_info=next123>; rel="next"',
              }),
            },
          );
        }
        expect(urlStr).toContain('page_info=next123');
        return new Response(
          JSON.stringify({
            customers: [
              { id: 2, email: 'b@x', email_marketing_consent: { state: 'subscribed' } },
            ],
          }),
          { status: 200, headers: new Headers() },
        );
      }),
    );

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.error).toBeUndefined();
    expect(r.synced).toBe(2);
    expect(r.subscribed).toBe(2);
    expect(r.pages).toBe(2);
    expect(callCount).toBe(2);
  });

  it('途中 page で API エラー → 既存件数を保持して error 報告', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              customers: [
                { id: 1, email: 'a@x', email_marketing_consent: { state: 'subscribed' } },
              ],
            }),
            {
              status: 200,
              headers: new Headers({ Link: '<https://x>; rel="next"' }),
            },
          );
        }
        return new Response('{}', { status: 500 });
      }),
    );

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.error).toMatch(/Shopify Customers API returned 500 on page 2/);
    expect(r.synced).toBe(1); // page 1 の結果は保持
    expect(r.subscribed).toBe(1);
    expect(r.pages).toBe(1);
  });

  it('metadata に email_marketing_consent / sms / accepts_marketing 等が保存される', async () => {
    const dbModule = await import('@line-crm/db');
    const upsertMock = dbModule.upsertShopifyCustomer as ReturnType<typeof vi.fn>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            customers: [
              {
                id: 100,
                email: 'tester@example.com',
                email_marketing_consent: {
                  state: 'subscribed',
                  opt_in_level: 'single_opt_in',
                  consent_updated_at: '2026-01-01T00:00:00Z',
                },
                sms_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in' },
                accepts_marketing: true,
                accepts_marketing_updated_at: '2026-01-01T00:00:00Z',
                marketing_opt_in_level: 'single_opt_in',
              },
            ],
          }),
          { status: 200, headers: new Headers() },
        ),
      ),
    );

    await syncShopifyCustomers(fakeDb, baseEnv);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0]![1] as { metadata: string };
    const meta = JSON.parse(arg.metadata) as Record<string, unknown>;
    expect(meta.source).toBe('cron_sync');
    expect((meta.email_marketing_consent as { state?: string }).state).toBe('subscribed');
    expect((meta.sms_marketing_consent as { state?: string }).state).toBe('subscribed');
    expect(meta.accepts_marketing).toBe(true);
    expect(meta.marketing_opt_in_level).toBe('single_opt_in');
    expect(meta.sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('非数値の total_spent / orders_count は undefined で upsert (DB に NaN を書かない)', async () => {
    const dbModule = await import('@line-crm/db');
    const upsertMock = dbModule.upsertShopifyCustomer as ReturnType<typeof vi.fn>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            customers: [
              { id: 200, email: 'g@x', total_spent: 'not-a-number', orders_count: '3' },
            ],
          }),
          { status: 200, headers: new Headers() },
        ),
      ),
    );

    await syncShopifyCustomers(fakeDb, baseEnv);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0]![1] as { totalSpent?: number; ordersCount?: number };
    expect(arg.totalSpent).toBeUndefined(); // 'not-a-number' → NaN → undefined (= 書かない)
    expect(arg.ordersCount).toBe(3); // '3' → 3 (有効値は維持)
  });
});
