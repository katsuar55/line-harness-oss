/**
 * Tests for shopify-customer-sync:
 *  - parseNextUrl (Link header parsing)
 *  - paging (Link header の rel="next" を辿る)
 *  - email_marketing_consent.state の集計
 *  - metadata に opt-in 関連 field が保存される
 *  - 途中 page の API エラーで既存件数を保持
 *
 * 2026-08-11 incremental 化 (cron silence 再発防止):
 *  - resolveWatermark (旧形式 metrics はフル同期に倒す)
 *  - updated_at_min が URL に付く / 付かない
 *  - ページ単位 batch upsert (batchUpsertShopifyCustomers)
 *  - 未設定環境は skipped フラグ
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  syncShopifyCustomers,
  parseNextUrl,
  toFiniteNumber,
  resolveWatermark,
  SYNC_JOB_NAME,
} from '../services/shopify-customer-sync.js';

vi.mock('@line-crm/db', () => ({
  batchUpsertShopifyCustomers: vi.fn(async () => undefined),
  getLastSuccessfulRun: vi.fn(async () => null),
}));

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token'),
}));

import { batchUpsertShopifyCustomers, getLastSuccessfulRun } from '@line-crm/db';

const batchMock = batchUpsertShopifyCustomers as ReturnType<typeof vi.fn>;
const lastSuccessMock = getLastSuccessfulRun as ReturnType<typeof vi.fn>;

const fakeDb = {} as unknown as D1Database;

const baseEnv = {
  SHOPIFY_STORE_DOMAIN: 'naturism-test.myshopify.com',
};

/** batch 呼び出し全体から upsert 行を平坦化して取り出す */
function allBatchedRows(): Array<Record<string, unknown>> {
  return batchMock.mock.calls.flatMap(
    (call: unknown[]) => call[1] as Array<Record<string, unknown>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  lastSuccessMock.mockResolvedValue(null);
  batchMock.mockResolvedValue(undefined);
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

describe('resolveWatermark', () => {
  const ranAt = '2026-08-11T12:00:00.000+09:00';

  it('成功 run 無し / metrics 無しなら null (= フル同期)', () => {
    expect(resolveWatermark(null)).toBeNull();
    expect(resolveWatermark({ ran_at: ranAt, metrics_json: null })).toBeNull();
  });

  it('🚨旧形式 metrics (mode 無し) は null — error 付き success 時代のカバレッジを信用しない', () => {
    // 2026-08-11 以前の本番実データの形そのまま
    expect(
      resolveWatermark({
        ran_at: ranAt,
        metrics_json: '{"synced":261,"error":"D1_ERROR: Network connection lost."}',
      }),
    ).toBeNull();
  });

  it('metrics parse 不能 / ran_at 不正なら null', () => {
    expect(resolveWatermark({ ran_at: ranAt, metrics_json: 'not-json' })).toBeNull();
    expect(
      resolveWatermark({ ran_at: 'garbage', metrics_json: '{"mode":"full"}' }),
    ).toBeNull();
  });

  it('新形式 (mode あり) は ran_at - 15 分の UTC ISO を返す', () => {
    // 12:00 JST = 03:00 UTC → -15min = 02:45 UTC
    expect(
      resolveWatermark({ ran_at: ranAt, metrics_json: '{"mode":"full","synced":100}' }),
    ).toBe('2026-08-11T02:45:00.000Z');
    expect(
      resolveWatermark({ ran_at: ranAt, metrics_json: '{"mode":"incremental","synced":0}' }),
    ).toBe('2026-08-11T02:45:00.000Z');
  });
});

describe('syncShopifyCustomers', () => {
  it('SHOPIFY_STORE_DOMAIN 未設定なら skipped + error return + 件数 0', async () => {
    const r = await syncShopifyCustomers(fakeDb, {});
    expect(r.skipped).toBe(true);
    expect(r.error).toMatch(/SHOPIFY_STORE_DOMAIN not configured/);
    expect(r.synced).toBe(0);
    expect(r.pages).toBe(0);
  });

  it('SHOPIFY_STORE_DOMAIN フォーマット不正なら skipped + error', async () => {
    const r = await syncShopifyCustomers(fakeDb, {
      SHOPIFY_STORE_DOMAIN: 'invalid.com',
    });
    expect(r.skipped).toBe(true);
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
    expect(r.skipped).toBeUndefined();
    expect(r.synced).toBe(5);
    expect(r.subscribed).toBe(1);
    expect(r.notSubscribed).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.unsubscribed).toBe(1);
    expect(r.pages).toBe(1);
    // ページ単位で 1 回だけ batch upsert
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect(allBatchedRows()).toHaveLength(5);
  });

  it('🚨前回クリーン成功なし → フル同期 (updated_at_min を付けない)', async () => {
    lastSuccessMock.mockResolvedValue(null);
    const fetchSpy = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ customers: [] }), { status: 200, headers: new Headers() }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.mode).toBe('full');
    expect(r.updatedAtMin).toBeNull();
    expect(lastSuccessMock).toHaveBeenCalledWith(fakeDb, SYNC_JOB_NAME);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).not.toContain('updated_at_min');
  });

  it('🚨前回クリーン成功 (新形式 metrics) あり → updated_at_min 付き差分同期', async () => {
    lastSuccessMock.mockResolvedValue({
      ran_at: '2026-08-11T12:00:00.000+09:00',
      metrics_json: '{"mode":"full","synced":2750}',
    });
    const fetchSpy = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ customers: [] }), { status: 200, headers: new Headers() }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.mode).toBe('incremental');
    expect(r.updatedAtMin).toBe('2026-08-11T02:45:00.000Z');
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain(`updated_at_min=${encodeURIComponent('2026-08-11T02:45:00.000Z')}`);
  });

  it('前回成功が旧形式 metrics (mode 無し) → フル同期に倒す', async () => {
    lastSuccessMock.mockResolvedValue({
      ran_at: '2026-08-11T01:23:32.906+09:00',
      metrics_json: '{"synced":261,"error":"D1_ERROR: Network connection lost."}',
    });
    const fetchSpy = vi.fn(async (_url: string | URL | Request) =>
      new Response(JSON.stringify({ customers: [] }), { status: 200, headers: new Headers() }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.mode).toBe('full');
    expect(String(fetchSpy.mock.calls[0]![0])).not.toContain('updated_at_min');
  });

  it('watermark 読み取りが throw してもフル同期で続行 (安全側)', async () => {
    lastSuccessMock.mockRejectedValue(new Error('D1 down'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ customers: [{ id: 1, email: 'a@x' }] }), {
          status: 200,
          headers: new Headers(),
        }),
      ),
    );

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe('full');
    expect(r.synced).toBe(1);
  });

  it('2 page (Link header rel="next") で paging が動作 + ページ毎に batch', async () => {
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
    expect(batchMock).toHaveBeenCalledTimes(2);
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

  it('batch upsert が throw → 失敗 page を synced に数えず error 報告', async () => {
    batchMock.mockRejectedValue(new Error('D1_ERROR: Network connection lost.'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ customers: [{ id: 1, email: 'a@x' }] }), {
          status: 200,
          headers: new Headers(),
        }),
      ),
    );

    const r = await syncShopifyCustomers(fakeDb, baseEnv);
    expect(r.error).toMatch(/Network connection lost/);
    expect(r.synced).toBe(0); // batch が atomic に失敗した page は数えない
  });

  it('metadata に email_marketing_consent / sms / accepts_marketing 等が保存される', async () => {
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
    const rows = allBatchedRows();
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.metadata as string) as Record<string, unknown>;
    expect(meta.source).toBe('cron_sync');
    expect((meta.email_marketing_consent as { state?: string }).state).toBe('subscribed');
    expect((meta.sms_marketing_consent as { state?: string }).state).toBe('subscribed');
    expect(meta.accepts_marketing).toBe(true);
    expect(meta.marketing_opt_in_level).toBe('single_opt_in');
    expect(meta.sync_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('非数値の total_spent / orders_count は undefined で upsert (DB に NaN を書かない)', async () => {
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
    const rows = allBatchedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalSpent).toBeUndefined(); // 'not-a-number' → NaN → undefined (= 書かない)
    expect(rows[0]!.ordersCount).toBe(3); // '3' → 3 (有効値は維持)
  });
});
