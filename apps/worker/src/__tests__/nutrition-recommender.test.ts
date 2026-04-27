/**
 * Tests for nutrition-recommender (Phase 4 PR-3).
 *
 * Covers:
 *   1. deficits 空 → null + DB insert されない
 *   2. SKU map 全件不在 → null
 *   3. SKU map あり / apiKey 無し → template フォールバック / source='template' / insert される
 *   4. AI 成功 → source='ai' / SKU 紐付き / insert される
 *   5. AI が薬機 NG ワードを含む → redaction される
 *   6. AI 例外 → template フォールバック (insert はされる)
 *   7. AI タイムアウト (AbortError) → template フォールバック
 *   8. 複数 deficit (protein_low + calorie_low) → suggestions に両方
 *
 * 加えて純粋関数の単体テスト (templateMessage / pickTopDeficit / redactProhibited / clip)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateAndStoreRecommendation,
  templateMessage,
  __test__,
} from '../services/nutrition-recommender.js';
import type { NutritionDeficit, SkuMapRow } from '@line-crm/db';

const {
  redactProhibited,
  clip,
  pickTopDeficit,
  REDACTION_TOKEN,
  AI_MESSAGE_MAX_LEN,
} = __test__;

// ============================================================
// Mock setup
// ============================================================

interface SkuMapStore {
  // deficit_key -> row | null
  [key: string]: SkuMapRow | null;
}

interface MockDb {
  db: D1Database;
  insertSpy: ReturnType<typeof vi.fn>;
  prepareSpy: ReturnType<typeof vi.fn>;
}

/**
 * D1 mock。`getSkuMapByDeficit` (SELECT first) と
 * `insertNutritionRecommendation` (INSERT run) の両方をエミュレートする。
 *
 * SQL の中身で分岐:
 *   - "SELECT * FROM nutrition_sku_map" → bind の deficit_key で skuMap を引いて first 返す
 *   - "INSERT INTO nutrition_recommendations" → run で insertSpy を呼ぶ
 */
function makeMockDb(skuMap: SkuMapStore): MockDb {
  const insertSpy = vi.fn().mockResolvedValue({
    success: true,
    meta: { duration: 1, changes: 1 },
  });

  const prepareSpy = vi.fn((sql: string) => {
    if (/SELECT \* FROM nutrition_sku_map/i.test(sql)) {
      return {
        bind: (key: string) => ({
          first: vi.fn().mockResolvedValue(skuMap[key] ?? null),
        }),
      };
    }
    if (/INSERT INTO nutrition_recommendations/i.test(sql)) {
      return {
        bind: (...args: unknown[]) => ({
          run: () => insertSpy(...args),
        }),
      };
    }
    // 想定外 SQL — テストミスを早期検出するため throw
    throw new Error(`Unexpected SQL in mock: ${sql.slice(0, 60)}...`);
  });

  return {
    db: { prepare: prepareSpy } as unknown as D1Database,
    insertSpy,
    prepareSpy,
  };
}

function makeSkuRow(overrides: Partial<SkuMapRow> & { deficit_key: string }): SkuMapRow {
  return {
    deficit_key: overrides.deficit_key,
    shopify_product_id: overrides.shopify_product_id ?? `gid://shopify/Product/${overrides.deficit_key}`,
    product_title: overrides.product_title ?? `naturism ${overrides.deficit_key}`,
    copy_template: overrides.copy_template ?? '日々のバランスを意識する選択肢に',
    is_active: overrides.is_active ?? 1,
    created_at: overrides.created_at ?? '2026-04-27T00:00:00.000',
  };
}

function fakeAiClient(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 50 },
      }),
    },
  };
}

const PROTEIN_LOW: NutritionDeficit = {
  key: 'protein_low',
  observedAvg: 40,
  targetAvg: 65,
  severity: 'moderate',
};

const CALORIE_LOW: NutritionDeficit = {
  key: 'calorie_low',
  observedAvg: 1200,
  targetAvg: 2000,
  severity: 'moderate',
};

const FIBER_LOW: NutritionDeficit = {
  key: 'fiber_low',
  observedAvg: 100,
  targetAvg: 280,
  severity: 'mild',
};

// ============================================================
// 純粋関数: redactProhibited / clip / pickTopDeficit
// ============================================================

describe('redactProhibited', () => {
  it('passes through clean text', () => {
    expect(redactProhibited('たんぱく質を意識してみませんか')).toBe(
      'たんぱく質を意識してみませんか',
    );
  });

  it('redacts Japanese phrase', () => {
    expect(redactProhibited('病気が改善します')).toBe(
      `${REDACTION_TOKEN}します`,
    );
  });

  it('redacts case-insensitive English (cure / heal)', () => {
    const r = redactProhibited('It will Cure and HEAL.');
    expect(r).not.toMatch(/cure/i);
    expect(r).not.toMatch(/heal/i);
    expect(r).toContain(REDACTION_TOKEN);
  });
});

describe('clip', () => {
  it('returns the same string when length <= max', () => {
    expect(clip('abc', 5)).toBe('abc');
  });

  it('clips to max characters', () => {
    expect(clip('abcdefghij', 4)).toBe('abcd');
  });

  it('counts surrogate pairs as 1 character (emoji)', () => {
    // 4 visible chars: 'a' '🍎' 'b' 'c'
    expect(clip('a🍎bc', 3)).toBe('a🍎b');
  });
});

describe('pickTopDeficit', () => {
  it('picks the highest severity', () => {
    const top = pickTopDeficit([
      { key: 'fiber_low', observedAvg: 1, targetAvg: 1, severity: 'mild' },
      { key: 'protein_low', observedAvg: 1, targetAvg: 1, severity: 'severe' },
      { key: 'calorie_low', observedAvg: 1, targetAvg: 1, severity: 'moderate' },
    ]);
    expect(top.key).toBe('protein_low');
  });

  it('falls back to first when severities tie', () => {
    const top = pickTopDeficit([
      { key: 'fiber_low', observedAvg: 1, targetAvg: 1, severity: 'mild' },
      { key: 'protein_low', observedAvg: 1, targetAvg: 1, severity: 'mild' },
    ]);
    expect(top.key).toBe('fiber_low');
  });
});

// ============================================================
// templateMessage
// ============================================================

describe('templateMessage', () => {
  it('uses たんぱく質 label for protein_low', () => {
    const msg = templateMessage([PROTEIN_LOW]);
    expect(msg).toContain('たんぱく質');
    expect(msg).toContain('控えめ');
    // 60 字以内ではないが AI_MESSAGE_MAX_LEN 内
    expect(Array.from(msg).length).toBeLessThanOrEqual(AI_MESSAGE_MAX_LEN);
  });

  it('switches phrasing for calorie_high', () => {
    const msg = templateMessage([
      { key: 'calorie_high', observedAvg: 2800, targetAvg: 2000, severity: 'moderate' },
    ]);
    expect(msg).toContain('多め');
  });

  it('embeds friend name when provided', () => {
    const msg = templateMessage([PROTEIN_LOW], '花子');
    expect(msg).toContain('花子さん');
  });

  it('falls back to a safe message when deficits is empty', () => {
    expect(templateMessage([])).toContain('ありがとう');
  });
});

// ============================================================
// generateAndStoreRecommendation
// ============================================================

describe('generateAndStoreRecommendation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when deficits is empty (no DB insert)', async () => {
    const { db, insertSpy, prepareSpy } = makeMockDb({});
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      deficits: [],
    });
    expect(r).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('returns null when no SKU map row exists for any deficit', async () => {
    const { db, insertSpy } = makeMockDb({}); // no entries
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      deficits: [PROTEIN_LOW, FIBER_LOW],
    });
    expect(r).toBeNull();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('falls back to template when apiKey is absent (source=template, insert succeeds)', async () => {
    const { db, insertSpy } = makeMockDb({
      protein_low: makeSkuRow({ deficit_key: 'protein_low' }),
    });
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      deficits: [PROTEIN_LOW],
      // apiKey omitted, no clientOverride
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('template');
    expect(r!.suggestions).toHaveLength(1);
    expect(r!.suggestions[0].deficitKey).toBe('protein_low');
    expect(r!.aiMessage).toContain('たんぱく質');
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('uses AI message when apiKey provided and AI succeeds (source=ai)', async () => {
    const { db, insertSpy } = makeMockDb({
      protein_low: makeSkuRow({ deficit_key: 'protein_low' }),
    });
    const aiText = '今週はたんぱく質が少し控えめでした。明日は卵や豆類を一品足してみませんか。';
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      apiKey: 'sk-test',
      deficits: [PROTEIN_LOW],
      clientOverride: fakeAiClient(aiText),
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('ai');
    expect(r!.aiMessage).toContain('たんぱく質');
    expect(r!.suggestions).toHaveLength(1);
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('redacts prohibited phrases from AI output', async () => {
    const { db } = makeMockDb({
      protein_low: makeSkuRow({ deficit_key: 'protein_low' }),
    });
    // PROHIBITED_PHRASES に含まれるワード ("病気が改善" / "治る" / "効く" / "cure") を
    // AI がうっかり混ぜて返したケースを想定。
    const naughty = 'たんぱく質を取れば病気が改善し、不調が治る。It will Cure you.';
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      apiKey: 'sk-test',
      deficits: [PROTEIN_LOW],
      clientOverride: fakeAiClient(naughty),
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('ai');
    expect(r!.aiMessage).not.toContain('病気が改善');
    expect(r!.aiMessage).not.toContain('治る');
    expect(r!.aiMessage).not.toMatch(/cure/i);
    expect(r!.aiMessage).toContain(REDACTION_TOKEN);
  });

  it('falls back to template when the AI call throws (still inserts)', async () => {
    const { db, insertSpy } = makeMockDb({
      protein_low: makeSkuRow({ deficit_key: 'protein_low' }),
    });
    const failingClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      },
    };
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      apiKey: 'sk-test',
      deficits: [PROTEIN_LOW],
      clientOverride: failingClient,
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('template');
    expect(r!.aiMessage).toContain('たんぱく質');
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('falls back to template on AbortError (timeout)', async () => {
    const { db, insertSpy } = makeMockDb({
      protein_low: makeSkuRow({ deficit_key: 'protein_low' }),
    });
    const abortingClient = {
      messages: {
        create: vi.fn().mockImplementation(() => {
          const err = new Error('Request was aborted');
          err.name = 'AbortError';
          return Promise.reject(err);
        }),
      },
    };
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      apiKey: 'sk-test',
      deficits: [PROTEIN_LOW],
      clientOverride: abortingClient,
      timeoutMs: 50,
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('template');
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('includes one suggestion per distinct deficit (protein_low + calorie_low)', async () => {
    const { db, insertSpy } = makeMockDb({
      protein_low: makeSkuRow({
        deficit_key: 'protein_low',
        shopify_product_id: 'gid://shopify/Product/PROTEIN',
        product_title: 'naturism プロテイン',
      }),
      calorie_low: makeSkuRow({
        deficit_key: 'calorie_low',
        shopify_product_id: 'gid://shopify/Product/ENERGY',
        product_title: 'naturism ベイクドオーツ',
      }),
    });
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      deficits: [PROTEIN_LOW, CALORIE_LOW],
    });
    expect(r).not.toBeNull();
    expect(r!.suggestions).toHaveLength(2);
    const keys = r!.suggestions.map((s) => s.deficitKey).sort();
    expect(keys).toEqual(['calorie_low', 'protein_low']);
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('deduplicates suggestions when two deficit keys map to the same product', async () => {
    const sameProduct = makeSkuRow({
      deficit_key: 'protein_low',
      shopify_product_id: 'gid://shopify/Product/SAME',
      product_title: 'naturism マルチ',
    });
    const { db } = makeMockDb({
      protein_low: sameProduct,
      iron_low: { ...sameProduct, deficit_key: 'iron_low' },
    });
    const r = await generateAndStoreRecommendation({
      db,
      friendId: 'f1',
      deficits: [
        PROTEIN_LOW,
        { key: 'iron_low', observedAvg: 0, targetAvg: 10.5, severity: 'mild' },
      ],
    });
    expect(r).not.toBeNull();
    expect(r!.suggestions).toHaveLength(1);
    expect(r!.suggestions[0].shopifyProductId).toBe('gid://shopify/Product/SAME');
  });

  it('throws when DB insert fails (caller catches)', async () => {
    // SKU lookup succeeds but INSERT throws.
    const failingPrepare = vi.fn((sql: string) => {
      if (/SELECT \* FROM nutrition_sku_map/i.test(sql)) {
        return {
          bind: () => ({
            first: vi.fn().mockResolvedValue(makeSkuRow({ deficit_key: 'protein_low' })),
          }),
        };
      }
      return {
        bind: () => ({
          run: vi.fn().mockRejectedValue(new Error('disk full')),
        }),
      };
    });
    const db = { prepare: failingPrepare } as unknown as D1Database;

    await expect(
      generateAndStoreRecommendation({
        db,
        friendId: 'f1',
        deficits: [PROTEIN_LOW],
      }),
    ).rejects.toThrow('disk full');
  });
});
