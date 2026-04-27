/**
 * Tests for `@line-crm/db` repurchase-intervals helpers (Phase 6 PR-1).
 *
 * D1 を直接モックし、bind 引数 + SQL 文の構造を検証する。
 * 実 SQLite 実行はマイグレーション統合テスト側で別途行う想定。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getProductInterval,
  upsertProductInterval,
  listProductIntervals,
  deleteProductInterval,
  computeUserPurchaseInterval,
} from '@line-crm/db';

interface CapturedCall {
  sql: string;
  bindArgs: unknown[];
}

function makeFakeDb(rows: { first?: unknown; all?: unknown[] }, captured: CapturedCall[] = []) {
  const db: unknown = {
    prepare(sql: string) {
      const call: CapturedCall = { sql, bindArgs: [] };
      captured.push(call);
      const builder = {
        bind(...args: unknown[]) {
          call.bindArgs = args;
          return builder;
        },
        async first<T>(): Promise<T | null> {
          return (rows.first as T) ?? null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: (rows.all as T[]) ?? [] };
        },
        async run() {
          return { success: true };
        },
      };
      return builder;
    },
  };
  return { db: db as D1Database, captured };
}

// ============================================================
// getProductInterval
// ============================================================

describe('getProductInterval', () => {
  it('既存レコードを返す', async () => {
    const { db, captured } = makeFakeDb({
      first: {
        shopify_product_id: 'prod-1',
        product_title: 'X',
        default_interval_days: 45,
        source: 'manual',
        sample_size: 0,
        notes: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    });
    const out = await getProductInterval(db, 'prod-1');
    expect(out?.default_interval_days).toBe(45);
    expect(captured[0]?.bindArgs).toEqual(['prod-1']);
  });

  it('未登録なら null', async () => {
    const { db } = makeFakeDb({});
    const out = await getProductInterval(db, 'missing');
    expect(out).toBeNull();
  });
});

// ============================================================
// upsertProductInterval
// ============================================================

describe('upsertProductInterval', () => {
  it('INSERT ... ON CONFLICT を発行し、デフォルト source/sample_size を埋める', async () => {
    const { db, captured } = makeFakeDb({});
    await upsertProductInterval(db, {
      shopifyProductId: 'prod-1',
      productTitle: 'マスター',
      defaultIntervalDays: 30,
    });
    expect(captured.length).toBe(1);
    expect(captured[0].sql).toMatch(/INSERT INTO product_repurchase_intervals/);
    expect(captured[0].sql).toMatch(/ON CONFLICT/);
    const args = captured[0].bindArgs;
    expect(args[0]).toBe('prod-1');           // shopifyProductId
    expect(args[1]).toBe('マスター');          // productTitle
    expect(args[2]).toBe(30);                  // intervalDays
    expect(args[3]).toBe('manual');            // default source
    expect(args[4]).toBe(0);                   // default sampleSize
    expect(args[5]).toBeNull();                // notes
  });

  it('source/sampleSize/notes を明示指定できる', async () => {
    const { db, captured } = makeFakeDb({});
    await upsertProductInterval(db, {
      shopifyProductId: 'prod-2',
      defaultIntervalDays: 60,
      source: 'auto_estimated',
      sampleSize: 8,
      notes: 'recomputed weekly',
    });
    const args = captured[0].bindArgs;
    expect(args[1]).toBeNull();                // productTitle 未指定
    expect(args[3]).toBe('auto_estimated');
    expect(args[4]).toBe(8);
    expect(args[5]).toBe('recomputed weekly');
  });
});

// ============================================================
// listProductIntervals
// ============================================================

describe('listProductIntervals', () => {
  it('全件取得して返す (デフォルト 200 limit)', async () => {
    const { db, captured } = makeFakeDb({
      all: [
        {
          shopify_product_id: 'p1',
          product_title: 'A',
          default_interval_days: 30,
          source: 'manual',
          sample_size: 0,
          notes: null,
          created_at: '',
          updated_at: '',
        },
      ],
    });
    const out = await listProductIntervals(db);
    expect(out.length).toBe(1);
    expect(captured[0].bindArgs).toEqual([200]);
  });

  it('limit を 500 で頭打ちにする', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await listProductIntervals(db, { limit: 9999 });
    expect(captured[0].bindArgs).toEqual([500]);
  });
});

// ============================================================
// deleteProductInterval
// ============================================================

describe('deleteProductInterval', () => {
  it('DELETE ... WHERE shopify_product_id = ? を発行', async () => {
    const { db, captured } = makeFakeDb({});
    await deleteProductInterval(db, 'prod-1');
    expect(captured[0].sql).toMatch(/DELETE FROM product_repurchase_intervals/);
    expect(captured[0].bindArgs).toEqual(['prod-1']);
  });
});

// ============================================================
// computeUserPurchaseInterval
// ============================================================

describe('computeUserPurchaseInterval', () => {
  it('注文 0/1 件なら null', async () => {
    const { db } = makeFakeDb({ all: [] });
    const out = await computeUserPurchaseInterval(db, 'friend-1', 'prod-1');
    expect(out).toBeNull();
  });

  it('対象 product_id を含む注文 2 件で平均間隔を返す', async () => {
    const lineItems = JSON.stringify([{ product_id: 'prod-1' }, { product_id: 'prod-2' }]);
    const { db } = makeFakeDb({
      all: [
        { created_at: '2026-01-01T00:00:00Z', line_items: lineItems },
        { created_at: '2026-02-01T00:00:00Z', line_items: lineItems },
      ],
    });
    const out = await computeUserPurchaseInterval(db, 'friend-1', 'prod-1');
    expect(out).not.toBeNull();
    expect(out!.sampleSize).toBe(1);
    // 31 日付近 (うるう年の関係なく ~31)
    expect(out!.averageDays).toBeGreaterThan(30);
    expect(out!.averageDays).toBeLessThan(32);
  });

  it('product_id が一致しない注文は除外', async () => {
    const lineItems1 = JSON.stringify([{ product_id: 'prod-other' }]);
    const lineItems2 = JSON.stringify([{ product_id: 'prod-1' }]);
    const { db } = makeFakeDb({
      all: [
        { created_at: '2026-01-01T00:00:00Z', line_items: lineItems1 },
        { created_at: '2026-02-01T00:00:00Z', line_items: lineItems2 },
      ],
    });
    // prod-1 は 1 件しかないので null
    const out = await computeUserPurchaseInterval(db, 'friend-1', 'prod-1');
    expect(out).toBeNull();
  });

  it('壊れた JSON line_items はスキップして残りを処理', async () => {
    const valid = JSON.stringify([{ product_id: 'prod-1' }]);
    const { db } = makeFakeDb({
      all: [
        { created_at: '2026-01-01T00:00:00Z', line_items: valid },
        { created_at: '2026-01-15T00:00:00Z', line_items: '{not-json' },
        { created_at: '2026-02-01T00:00:00Z', line_items: valid },
      ],
    });
    const out = await computeUserPurchaseInterval(db, 'friend-1', 'prod-1');
    expect(out).not.toBeNull();
    expect(out!.sampleSize).toBe(1); // 1 つの interval
  });

  it('product_id が number 形式でも文字列比較できる', async () => {
    const items1 = JSON.stringify([{ product_id: 12345 }]);
    const items2 = JSON.stringify([{ product_id: 12345 }]);
    const { db } = makeFakeDb({
      all: [
        { created_at: '2026-01-01T00:00:00Z', line_items: items1 },
        { created_at: '2026-02-15T00:00:00Z', line_items: items2 },
      ],
    });
    const out = await computeUserPurchaseInterval(db, 'friend-1', '12345');
    expect(out).not.toBeNull();
    expect(out!.sampleSize).toBe(1);
  });
});
