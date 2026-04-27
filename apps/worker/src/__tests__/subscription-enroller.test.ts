/**
 * Tests for subscription-enroller (Phase 6 PR-2).
 *
 * 設計:
 *   - DB は in-memory のフェイクで bind 引数 + SQL を捕捉
 *   - estimateRepurchaseInterval はモジュール内で呼ばれるが、
 *     DB が空なので fallback (30日) に倒れる前提でテスト
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  enrollSubscriptionsFromOrder,
  extractEnrollableItems,
} from '../services/subscription-enroller.js';

interface CapturedCall {
  sql: string;
  bindArgs: unknown[];
}

interface FakeStore {
  // friend_id|product_id -> existing reminder id
  existingReminders: Map<string, string>;
  // friend_id -> orders rows for computeUserPurchaseInterval
  orders: { created_at: string; line_items: string | null }[];
  // shopify_product_id -> product master row
  productMaster: Map<string, Record<string, unknown>>;
  inserted: { sql: string; args: unknown[] }[];
  captured: CapturedCall[];
}

function makeFakeDb(store: FakeStore): D1Database {
  const dbObj: unknown = {
    prepare(sql: string) {
      const call: CapturedCall = { sql, bindArgs: [] };
      store.captured.push(call);
      const builder = {
        bind(...args: unknown[]) {
          call.bindArgs = args;
          return builder;
        },
        async first<T>(): Promise<T | null> {
          // existing reminder check
          if (/FROM subscription_reminders/.test(sql) && /is_active = 1/.test(sql)) {
            const friendId = call.bindArgs[0] as string;
            const productId = call.bindArgs[1] as string;
            const key = `${friendId}|${productId}`;
            const id = store.existingReminders.get(key);
            return id ? ({ id } as T) : null;
          }
          // product master lookup
          if (/FROM product_repurchase_intervals/.test(sql)) {
            const productId = call.bindArgs[0] as string;
            const row = store.productMaster.get(productId);
            return (row as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM shopify_orders/.test(sql)) {
            return { results: store.orders as T[] };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO subscription_reminders/.test(sql)) {
            store.inserted.push({ sql, args: call.bindArgs });
          }
          return { success: true };
        },
      };
      return builder;
    },
  };
  return dbObj as D1Database;
}

let store: FakeStore;
let db: D1Database;

beforeEach(() => {
  store = {
    existingReminders: new Map(),
    orders: [],
    productMaster: new Map(),
    inserted: [],
    captured: [],
  };
  db = makeFakeDb(store);
});

// ============================================================
// extractEnrollableItems (pure)
// ============================================================

describe('extractEnrollableItems', () => {
  it('正常な line_items から (id, title, variant) を抽出', () => {
    const out = extractEnrollableItems([
      { product_id: 100, title: 'プロテイン30日分', variant_id: 200 },
      { product_id: 101, name: '鉄サプリ', variant_id: null },
    ]);
    expect(out).toEqual([
      { shopifyProductId: '100', productTitle: 'プロテイン30日分', variantId: '200' },
      { shopifyProductId: '101', productTitle: '鉄サプリ', variantId: null },
    ]);
  });

  it('product_id 重複は最初の 1 件のみ', () => {
    const out = extractEnrollableItems([
      { product_id: 100, title: 'A' },
      { product_id: 100, title: 'B' },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].productTitle).toBe('A');
  });

  it('product_id 欠落 / null / 空文字はスキップ', () => {
    const out = extractEnrollableItems([
      { product_id: null, title: 'X' },
      { product_id: '', title: 'Y' },
      { title: 'Z' },
      { product_id: 100, title: 'OK' },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].shopifyProductId).toBe('100');
  });

  it('title 欠落時は product_id 文字列を fallback に使う', () => {
    const out = extractEnrollableItems([{ product_id: 100 }]);
    expect(out[0].productTitle).toBe('100');
  });

  it('非オブジェクト要素は無視', () => {
    const out = extractEnrollableItems([null, 'string', 42, { product_id: 100, title: 'OK' }]);
    expect(out.length).toBe(1);
  });

  it('空配列は空を返す', () => {
    expect(extractEnrollableItems([])).toEqual([]);
  });
});

// ============================================================
// enrollSubscriptionsFromOrder
// ============================================================

describe('enrollSubscriptionsFromOrder', () => {
  it('friendId なしは何もしない', async () => {
    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: '',
      shopifyOrderId: 'order-1',
      lineItems: [{ product_id: 100, title: 'A' }],
    });
    expect(out.enrolled).toEqual([]);
    expect(store.inserted.length).toBe(0);
  });

  it('shopifyOrderId なしは何もしない', async () => {
    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: '',
      lineItems: [{ product_id: 100, title: 'A' }],
    });
    expect(out.enrolled).toEqual([]);
  });

  it('lineItems 空は no-op', async () => {
    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [],
    });
    expect(out.enrolled).toEqual([]);
    expect(store.inserted.length).toBe(0);
  });

  it('新規商品は INSERT され、source は fallback (DB 空のため)', async () => {
    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [{ product_id: 100, title: 'プロテイン' }],
    });

    expect(out.enrolled.length).toBe(1);
    expect(out.enrolled[0].action).toBe('inserted');
    expect(out.enrolled[0].source).toBe('fallback');
    expect(out.enrolled[0].intervalDays).toBe(30);
    expect(store.inserted.length).toBe(1);

    const args = store.inserted[0].args;
    expect(args[1]).toBe('friend-1');             // friend_id
    expect(args[2]).toBe('プロテイン');           // product_title
    expect(args[4]).toBe(30);                     // interval_days
    expect(args[6]).toBe('order-1');              // source_order_id
    expect(args[7]).toBe('100');                  // shopify_product_id
    expect(args[8]).toBe('fallback');             // interval_source
  });

  it('商品名から日数抽出 (auto_estimated)', async () => {
    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [{ product_id: 100, title: 'コラーゲン60日分' }],
    });

    expect(out.enrolled[0].source).toBe('auto_estimated');
    expect(out.enrolled[0].intervalDays).toBe(60);
  });

  it('既存の active リマインダーがあれば skip', async () => {
    store.existingReminders.set('friend-1|100', 'existing-reminder-id');

    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [{ product_id: 100, title: 'A' }],
    });

    expect(out.enrolled.length).toBe(1);
    expect(out.enrolled[0].action).toBe('skipped_existing');
    expect(out.enrolled[0].subscriptionReminderId).toBe('existing-reminder-id');
    expect(store.inserted.length).toBe(0);
  });

  it('複数商品を独立して処理 (1 つ skip / 1 つ insert)', async () => {
    store.existingReminders.set('friend-1|100', 'existing-1');

    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [
        { product_id: 100, title: 'A' },
        { product_id: 200, title: 'B30日分' },
      ],
    });

    expect(out.enrolled.length).toBe(2);
    expect(out.enrolled[0].action).toBe('skipped_existing');
    expect(out.enrolled[1].action).toBe('inserted');
    expect(out.enrolled[1].source).toBe('auto_estimated');
    expect(out.enrolled[1].intervalDays).toBe(30);
    expect(store.inserted.length).toBe(1);
  });

  it('商品マスタ登録済みなら product_default を採用', async () => {
    store.productMaster.set('100', {
      shopify_product_id: '100',
      product_title: 'マスター',
      default_interval_days: 45,
      source: 'manual',
      sample_size: 0,
      notes: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const out = await enrollSubscriptionsFromOrder({
      db,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [{ product_id: 100, title: '注文票記載タイトル' }],
    });

    expect(out.enrolled[0].source).toBe('product_default');
    expect(out.enrolled[0].intervalDays).toBe(45);
  });

  it('1 件の DB エラーは他商品の処理を止めない', async () => {
    // 100 の存在チェックで throw
    let firstCheckCallSeen = false;
    const failingDb: unknown = {
      prepare(sql: string) {
        const builder = {
          bind(..._args: unknown[]) {
            return builder;
          },
          async first() {
            if (
              /FROM subscription_reminders/.test(sql) &&
              /is_active = 1/.test(sql) &&
              !firstCheckCallSeen
            ) {
              firstCheckCallSeen = true;
              throw new Error('transient db');
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true };
          },
        };
        return builder;
      },
    };

    const out = await enrollSubscriptionsFromOrder({
      db: failingDb as D1Database,
      friendId: 'friend-1',
      shopifyOrderId: 'order-1',
      lineItems: [
        { product_id: 100, title: 'A' },
        { product_id: 200, title: 'B30日分' },
      ],
    });

    expect(out.errors.length).toBe(1);
    expect(out.errors[0].productId).toBe('100');
    expect(out.enrolled.length).toBe(1);
    expect(out.enrolled[0].shopifyProductId).toBe('200');
  });
});
