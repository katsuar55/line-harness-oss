/**
 * own-billing-shopify-adapter (WI-4 step 3) — 設計書 §1 前提の実 API 適合。
 *
 * 重点:
 *   - **API 2026-04 の `state` 判別 union** の解釈 (Pending/ActionRequired/Failed/Success)。
 *     未知 __typename は pending (= 非 terminal) に倒す — no-parallel-attempt の fail-closed 側。
 *   - listCycles の billed/skipped 判定と昇順ソート
 *   - userErrors の code 抽出 (同期エラーレーン §6.5 の入力になる)
 *   - HTTP / GraphQL errors を「サイクル無し」に化けさせない (課金漏れの静音化を防ぐ)
 *   - JST 日付 → DateTime の正午固定 (§10.1⑦ JST/UTC 境界)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createShopifyBillingAdapter,
  parseAttemptNode,
  toDateTime,
} from '../services/own-billing-shopify-adapter.js';

const GID = 'gid://shopify/SubscriptionContract/111';

function jsonFetch(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function makeAdapter(fetchImpl: typeof fetch) {
  return createShopifyBillingAdapter({
    storeDomain: 'shop.myshopify.com',
    accessToken: 'tok',
    fetchImpl,
    nowMs: () => Date.parse('2026-08-05T00:00:00Z'),
  });
}

describe('parseAttemptNode — state 判別 union (2026-04)', () => {
  it('SuccessState → succeeded + orderGid', () => {
    const d = parseAttemptNode({
      id: 'gid://shopify/SubscriptionBillingAttempt/1',
      idempotencyKey: 'k1',
      state: {
        __typename: 'SubscriptionBillingAttemptSuccessState',
        order: { id: 'gid://shopify/Order/9' },
      },
    });
    expect(d.status).toBe('succeeded');
    expect(d.orderGid).toBe('gid://shopify/Order/9');
    expect(d.idempotencyKey).toBe('k1');
  });

  it('SuccessState で order が null (削除済み) でも succeeded は保つ', () => {
    const d = parseAttemptNode({
      id: 'a',
      state: { __typename: 'SubscriptionBillingAttemptSuccessState', order: null },
    });
    expect(d.status).toBe('succeeded');
    expect(d.orderGid).toBeNull();
  });

  it('ActionRequiredState → challenged + nextActionUrl', () => {
    const d = parseAttemptNode({
      id: 'a',
      state: {
        __typename: 'SubscriptionBillingAttemptActionRequiredState',
        action: {
          __typename: 'SubscriptionBillingAttemptPaymentChallenge',
          nextActionUrl: 'https://3ds.example/verify',
          status: 'ON_SESSION_CHALLENGED',
        },
      },
    });
    expect(d.status).toBe('challenged');
    expect(d.nextActionUrl).toBe('https://3ds.example/verify');
  });

  it('FailedState は 3 種の alias いずれからも code を取れる', () => {
    const payment = parseAttemptNode({
      id: 'a',
      state: {
        __typename: 'SubscriptionBillingAttemptFailedState',
        error: { __typename: 'SubscriptionBillingAttemptPaymentError', paymentCode: 'EXPIRED_CARD' },
      },
    });
    expect(payment).toMatchObject({ status: 'failed', errorCode: 'EXPIRED_CARD' });

    const inventory = parseAttemptNode({
      id: 'a',
      state: {
        __typename: 'SubscriptionBillingAttemptFailedState',
        error: {
          __typename: 'SubscriptionBillingAttemptInventoryError',
          inventoryCode: 'INSUFFICIENT_INVENTORY',
        },
      },
    });
    expect(inventory.errorCode).toBe('INSUFFICIENT_INVENTORY');

    const general = parseAttemptNode({
      id: 'a',
      state: {
        __typename: 'SubscriptionBillingAttemptFailedState',
        error: {
          __typename: 'SubscriptionBillingAttemptGeneralError',
          generalCode: 'PAYMENT_METHOD_NOT_FOUND',
        },
      },
    });
    expect(general.errorCode).toBe('PAYMENT_METHOD_NOT_FOUND');
  });

  it('UnexpectedError は code を持たないので既知の F クラス値へ寄せる', () => {
    const d = parseAttemptNode({
      id: 'a',
      state: {
        __typename: 'SubscriptionBillingAttemptFailedState',
        error: { __typename: 'SubscriptionBillingAttemptUnexpectedError', message: 'boom' },
      },
    });
    expect(d.status).toBe('failed');
    expect(d.errorCode).toBe('UNEXPECTED_ERROR');
  });

  it('PendingState / state 欠落 / 未知 __typename はすべて pending (fail-closed)', () => {
    expect(
      parseAttemptNode({ id: 'a', state: { __typename: 'SubscriptionBillingAttemptPendingState', processing: true } })
        .status,
    ).toBe('pending');
    expect(parseAttemptNode({ id: 'a' }).status).toBe('pending');
    expect(parseAttemptNode({ id: 'a', state: null }).status).toBe('pending');
    // Shopify が将来 state 型を増やしても「terminal と誤認して再発行」しない
    expect(parseAttemptNode({ id: 'a', state: { __typename: 'BrandNewState' } }).status).toBe(
      'pending',
    );
  });
});

describe('listCycles', () => {
  it('billed / skipped を判定し cycleIndex 昇順で返す', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingCycles: {
            edges: [
              { node: { cycleIndex: 3, billingAttemptExpectedDate: '2026-09-04T03:00:00Z', skipped: false, status: 'UNBILLED' } },
              { node: { cycleIndex: 1, billingAttemptExpectedDate: '2026-07-05T03:00:00Z', skipped: false, status: 'BILLED' } },
              { node: { cycleIndex: 2, billingAttemptExpectedDate: '2026-08-05T03:00:00Z', skipped: true, status: 'UNBILLED' } },
            ],
          },
        },
      }),
    );
    const cycles = await api.listCycles(GID);
    expect(cycles.map((c) => c.cycleIndex)).toEqual([1, 2, 3]);
    expect(cycles[0]).toMatchObject({ billed: true, skipped: false });
    expect(cycles[1]).toMatchObject({ billed: false, skipped: true });
    expect(cycles[2]).toMatchObject({ billed: false, skipped: false });
  });

  it('壊れた node は捨てる (index/日付が無いものを 0 番サイクル扱いしない)', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingCycles: {
            edges: [
              { node: { cycleIndex: 'x', billingAttemptExpectedDate: '2026-08-05T03:00:00Z' } },
              { node: { cycleIndex: 2 } },
              { node: { cycleIndex: 4, billingAttemptExpectedDate: '2026-10-05T03:00:00Z', status: 'UNBILLED' } },
            ],
          },
        },
      }),
    );
    const cycles = await api.listCycles(GID);
    expect(cycles.map((c) => c.cycleIndex)).toEqual([4]);
  });

  it('HTTP エラーは throw する (「サイクル無し」に化けさせない)', async () => {
    const api = makeAdapter(jsonFetch({}, 500));
    await expect(api.listCycles(GID)).rejects.toThrow(/listCycles failed/);
  });

  it('GraphQL errors も throw する', async () => {
    const api = makeAdapter(jsonFetch({ errors: [{ message: 'Throttled' }] }));
    await expect(api.listCycles(GID)).rejects.toThrow(/Throttled/);
  });

  it('照会窓は過去 90 日 / 未来 120 日で送る', async () => {
    const spy = jsonFetch({ data: { subscriptionBillingCycles: { edges: [] } } });
    const api = makeAdapter(spy);
    await api.listCycles(GID);
    const body = JSON.parse(((spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.startDate).toBe('2026-05-07T00:00:00.000Z');
    expect(body.variables.endDate).toBe('2026-12-03T00:00:00.000Z');
  });
});

describe('scheduleCycleDate / setCycleSkip', () => {
  it('userErrors があれば ok:false + メッセージ', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingCycleScheduleEdit: {
            userErrors: [{ code: 'INVALID', message: 'bad date' }],
          },
        },
      }),
    );
    const res = await api.scheduleCycleDate(GID, 2, '2026-09-04');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('bad date');
  });

  it('YYYY-MM-DD は JST 正午に固定して送る (UTC 変換の前日ずれ防止)', async () => {
    const spy = jsonFetch({ data: { subscriptionBillingCycleScheduleEdit: { userErrors: [] } } });
    const api = makeAdapter(spy);
    await api.scheduleCycleDate(GID, 2, '2026-09-04');
    const body = JSON.parse(((spy as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.date).toBe('2026-09-04T12:00:00+09:00');
  });

  it('skip の成功は ok:true', async () => {
    const api = makeAdapter(
      jsonFetch({ data: { subscriptionBillingCycleScheduleEdit: { billingCycle: { cycleIndex: 2, skipped: true }, userErrors: [] } } }),
    );
    await expect(api.setCycleSkip(GID, 2, true)).resolves.toEqual({ ok: true });
  });
});

describe('createAttempt (同期エラーレーン §6.5 の入力)', () => {
  it('成功で attemptGid を返す', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingAttemptCreate: {
            subscriptionBillingAttempt: { id: 'gid://shopify/SubscriptionBillingAttempt/7' },
            userErrors: [],
          },
        },
      }),
    );
    const res = await api.createAttempt(GID, 2, 'key');
    expect(res).toEqual({ ok: true, attemptGid: 'gid://shopify/SubscriptionBillingAttempt/7' });
  });

  it('THROTTLED の userError code をそのまま渡す (next_tick レーンへ)', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingAttemptCreate: {
            userErrors: [{ code: 'THROTTLED', message: 'too many' }],
          },
        },
      }),
    );
    const res = await api.createAttempt(GID, 2, 'key');
    expect(res.ok).toBe(false);
    expect(res.userErrorCode).toBe('THROTTLED');
  });

  it('ネットワーク障害は userErrorCode を付けない (= hold レーン: 自動再発行しない)', async () => {
    const failing = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const api = makeAdapter(failing);
    const res = await api.createAttempt(GID, 2, 'key');
    expect(res.ok).toBe(false);
    expect(res.userErrorCode).toBeUndefined();
    expect(res.error).toContain('network down');
  });

  it('userErrors なし + id なし は ok:true / gid なし (stuck_unrecorded へ委ねる)', async () => {
    const api = makeAdapter(
      jsonFetch({ data: { subscriptionBillingAttemptCreate: { subscriptionBillingAttempt: null, userErrors: [] } } }),
    );
    const res = await api.createAttempt(GID, 2, 'key');
    expect(res.ok).toBe(true);
    expect(res.attemptGid).toBeUndefined();
  });
});

describe('getAttemptStatus / getAttemptDetail', () => {
  it('照会不能 (HTTP エラー) は null = 「terminal 確定せず」', async () => {
    const api = makeAdapter(jsonFetch({}, 500));
    await expect(api.getAttemptStatus('gid://x')).resolves.toBeNull();
    await expect(api.getAttemptDetail('gid://x')).resolves.toBeNull();
  });

  it('attempt が存在しない (null) も null', async () => {
    const api = makeAdapter(jsonFetch({ data: { subscriptionBillingAttempt: null } }));
    await expect(api.getAttemptStatus('gid://x')).resolves.toBeNull();
  });

  it('state から terminal 状態を導出する', async () => {
    const api = makeAdapter(
      jsonFetch({
        data: {
          subscriptionBillingAttempt: {
            id: 'gid://a',
            idempotencyKey: 'k',
            state: {
              __typename: 'SubscriptionBillingAttemptFailedState',
              error: { __typename: 'SubscriptionBillingAttemptPaymentError', paymentCode: 'DO_NOT_HONOR' },
            },
          },
        },
      }),
    );
    await expect(api.getAttemptStatus('gid://a')).resolves.toBe('failed');
  });
});

describe('toDateTime', () => {
  it('日付のみは JST 正午、日時はそのまま', () => {
    expect(toDateTime('2026-09-04')).toBe('2026-09-04T12:00:00+09:00');
    expect(toDateTime('2026-09-04T01:02:03Z')).toBe('2026-09-04T01:02:03Z');
  });
});
