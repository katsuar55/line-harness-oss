/**
 * Tests for Phase 6 PR-3 cross-sell:
 *   - @line-crm/db cross-sell helpers
 *   - buildCrossSellComponents (UI 組み立て関数)
 */

import { describe, it, expect } from 'vitest';
import {
  getCrossSellSuggestions,
  upsertCrossSellRule,
  listCrossSellRules,
  deleteCrossSellRule,
} from '@line-crm/db';
import { buildCrossSellComponents } from '../services/subscription-reminder.js';

interface CapturedCall {
  sql: string;
  bindArgs: unknown[];
}

function makeFakeDb(rows: { all?: unknown[] }, captured: CapturedCall[] = []) {
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
          return null;
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
// getCrossSellSuggestions
// ============================================================

describe('getCrossSellSuggestions', () => {
  it('priority DESC で結果を返す + デフォルト limit 2', async () => {
    const { db, captured } = makeFakeDb({
      all: [
        {
          source_product_id: '100',
          recommended_product_id: '200',
          reason: '相性◎',
          priority: 10,
          is_active: 1,
          created_at: '',
          updated_at: '',
        },
      ],
    });
    const out = await getCrossSellSuggestions(db, '100');
    expect(out.length).toBe(1);
    expect(captured[0].bindArgs).toEqual(['100', 2]);
    expect(captured[0].sql).toMatch(/priority DESC/);
    expect(captured[0].sql).toMatch(/is_active = 1/);
  });

  it('limit を 5 で頭打ちにする', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await getCrossSellSuggestions(db, '100', { limit: 999 });
    expect(captured[0].bindArgs).toEqual(['100', 5]);
  });

  it('limit 1 未満は 1 にクランプ', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await getCrossSellSuggestions(db, '100', { limit: 0 });
    expect(captured[0].bindArgs).toEqual(['100', 1]);
  });

  it('該当なしは空配列', async () => {
    const { db } = makeFakeDb({ all: [] });
    const out = await getCrossSellSuggestions(db, 'nope');
    expect(out).toEqual([]);
  });
});

// ============================================================
// upsertCrossSellRule
// ============================================================

describe('upsertCrossSellRule', () => {
  it('INSERT ... ON CONFLICT を発行 + デフォルト priority/isActive', async () => {
    const { db, captured } = makeFakeDb({});
    await upsertCrossSellRule(db, {
      sourceProductId: '100',
      recommendedProductId: '200',
    });
    expect(captured[0].sql).toMatch(/INSERT INTO purchase_cross_sell_map/);
    expect(captured[0].sql).toMatch(/ON CONFLICT/);
    const args = captured[0].bindArgs;
    expect(args[0]).toBe('100');         // sourceProductId
    expect(args[1]).toBe('200');         // recommendedProductId
    expect(args[2]).toBeNull();          // reason
    expect(args[3]).toBe(0);             // default priority
    expect(args[4]).toBe(1);             // default isActive (1)
  });

  it('明示指定: reason / priority / isActive=false', async () => {
    const { db, captured } = makeFakeDb({});
    await upsertCrossSellRule(db, {
      sourceProductId: '100',
      recommendedProductId: '200',
      reason: '同梱で送料無料',
      priority: 50,
      isActive: false,
    });
    const args = captured[0].bindArgs;
    expect(args[2]).toBe('同梱で送料無料');
    expect(args[3]).toBe(50);
    expect(args[4]).toBe(0);
  });
});

// ============================================================
// listCrossSellRules
// ============================================================

describe('listCrossSellRules', () => {
  it('全件取得時は ORDER BY source_product_id ASC ...', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await listCrossSellRules(db);
    expect(captured[0].sql).toMatch(/ORDER BY source_product_id ASC/);
    expect(captured[0].bindArgs).toEqual([200]);
  });

  it('sourceProductId 指定時はフィルタ済み SQL', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await listCrossSellRules(db, { sourceProductId: '100' });
    expect(captured[0].sql).toMatch(/WHERE source_product_id = \?/);
    expect(captured[0].bindArgs).toEqual(['100', 200]);
  });

  it('limit を 500 で頭打ち', async () => {
    const { db, captured } = makeFakeDb({ all: [] });
    await listCrossSellRules(db, { limit: 9999 });
    expect(captured[0].bindArgs).toEqual([500]);
  });
});

// ============================================================
// deleteCrossSellRule
// ============================================================

describe('deleteCrossSellRule', () => {
  it('複合 PK で DELETE を発行', async () => {
    const { db, captured } = makeFakeDb({});
    await deleteCrossSellRule(db, '100', '200');
    expect(captured[0].sql).toMatch(/DELETE FROM purchase_cross_sell_map/);
    expect(captured[0].bindArgs).toEqual(['100', '200']);
  });
});

// ============================================================
// buildCrossSellComponents
// ============================================================

describe('buildCrossSellComponents', () => {
  it('候補なしは空配列', () => {
    expect(buildCrossSellComponents([])).toEqual([]);
  });

  it('1 件の候補で separator + heading + 1 box を生成', () => {
    const out = buildCrossSellComponents([
      { recommendedProductId: '200', recommendedTitle: '鉄サプリ', reason: null },
    ]);
    expect(out.length).toBe(3); // separator + heading + 1 entry box
    const heading = out[1] as Record<string, unknown>;
    expect(heading.text).toMatch(/おすすめ/);
    const entry = out[2] as Record<string, unknown>;
    expect(entry.type).toBe('box');
  });

  it('reason 付きは entry box 内に reason テキストを含む', () => {
    const out = buildCrossSellComponents([
      { recommendedProductId: '200', recommendedTitle: 'コラーゲン', reason: '美容にもおすすめ' },
    ]);
    const entry = out[2] as { contents: { text: string }[] };
    const texts = entry.contents.map((c) => c.text);
    expect(texts).toContain('・コラーゲン');
    expect(texts).toContain('美容にもおすすめ');
  });

  it('2 件の候補は separator + heading + 2 box (合計 4 要素)', () => {
    const out = buildCrossSellComponents([
      { recommendedProductId: '200', recommendedTitle: 'A', reason: null },
      { recommendedProductId: '300', recommendedTitle: 'B', reason: 'おすすめ' },
    ]);
    expect(out.length).toBe(4);
  });
});
