/**
 * Tests for nutrition-coach DB layer (Phase 4 PR-1).
 *
 * 実 D1 (better-sqlite3 経由のローカル wrangler) は worker パッケージ側で
 * テストする。ここでは型 + シリアライズ周りの単体テストのみ。
 *
 * クエリ関数は worker 側の統合テスト (PR-2 以降) で実 D1 にあたって検証する。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  insertNutritionRecommendation,
  getLatestActiveRecommendation,
  markRecommendationStatus,
  getSkuMapByDeficit,
  getCoachAnalytics,
  countStaleActiveRecommendations,
  upsertSkuMap,
  type NutritionDeficit,
  type SkuSuggestion,
} from '@line-crm/db';

// ============================================================
// 軽量 D1 モック
// ============================================================
function makeMockDb(opts: {
  firstResult?: unknown;
  allResults?: unknown[];
  runMeta?: Record<string, unknown>;
} = {}) {
  const runSpy = vi.fn().mockResolvedValue({
    success: true,
    meta: opts.runMeta ?? { duration: 1, changes: 1 },
  });
  const firstSpy = vi.fn().mockResolvedValue(opts.firstResult ?? null);
  const allSpy = vi.fn().mockResolvedValue({
    results: opts.allResults ?? [],
    success: true,
  });

  const bindSpy = vi.fn().mockReturnValue({
    run: runSpy,
    first: firstSpy,
    all: allSpy,
  });
  const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });

  return {
    db: { prepare: prepareSpy } as unknown as D1Database,
    spies: { runSpy, firstSpy, allSpy, bindSpy, prepareSpy },
  };
}

// ============================================================
// insertNutritionRecommendation
// ============================================================
describe('insertNutritionRecommendation', () => {
  it('serializes deficits and suggestions to JSON', async () => {
    const { db, spies } = makeMockDb({});

    const deficits: NutritionDeficit[] = [
      { key: 'protein_low', observedAvg: 55, targetAvg: 80, severity: 'mild' },
      { key: 'fiber_low', observedAvg: 10, targetAvg: 18, severity: 'moderate' },
    ];
    const suggestions: SkuSuggestion[] = [
      {
        shopifyProductId: 'gid://shopify/Product/123',
        productTitle: 'naturism プロテイン',
        copy: 'バランスを意識する選択肢に',
        deficitKey: 'protein_low',
      },
    ];

    const result = await insertNutritionRecommendation(
      db,
      {
        friendId: 'friend-1',
        deficits,
        suggestions,
        aiMessage: 'いつも記録ありがとうございます。',
      },
      'reco-1',
    );

    expect(result.id).toBe('reco-1');
    expect(result.friend_id).toBe('friend-1');
    expect(result.status).toBe('active');
    expect(JSON.parse(result.deficit_json)).toEqual(deficits);
    expect(JSON.parse(result.sku_suggestions_json)).toEqual(suggestions);
    expect(spies.runSpy).toHaveBeenCalledOnce();
  });

  it('records sentAt when provided', async () => {
    const { db, spies } = makeMockDb({});
    const sentAt = '2026-04-27T10:00:00.000';
    const result = await insertNutritionRecommendation(db, {
      friendId: 'f1',
      deficits: [{ key: 'iron_low', observedAvg: 5, targetAvg: 10, severity: 'mild' }],
      suggestions: [
        {
          shopifyProductId: 'p',
          productTitle: 't',
          copy: 'c',
          deficitKey: 'iron_low',
        },
      ],
      aiMessage: 'msg',
      sentAt,
    });
    expect(result.sent_at).toBe(sentAt);
    // bind 引数: [id, friendId, now, deficitJson, suggestionsJson, aiMessage, sentAt]
    const bindArgs = spies.bindSpy.mock.calls[0];
    expect(bindArgs).toHaveLength(7);
    expect(bindArgs[6]).toBe(sentAt);
  });

  it('generates uuid when id not provided', async () => {
    const { db } = makeMockDb({});
    const r = await insertNutritionRecommendation(db, {
      friendId: 'f1',
      deficits: [{ key: 'protein_low', observedAvg: 1, targetAvg: 2, severity: 'mild' }],
      suggestions: [
        { shopifyProductId: 'p', productTitle: 't', copy: 'c', deficitKey: 'protein_low' },
      ],
      aiMessage: 'm',
    });
    expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

// ============================================================
// getLatestActiveRecommendation
// ============================================================
describe('getLatestActiveRecommendation', () => {
  it('returns the row when active reco exists', async () => {
    const row = {
      id: 'r1',
      friend_id: 'f1',
      generated_at: '2026-04-27T00:00:00',
      deficit_json: '[]',
      sku_suggestions_json: '[]',
      ai_message: 'hi',
      status: 'active',
      sent_at: null,
      clicked_at: null,
      converted_at: null,
      conversion_event_id: null,
    };
    const { db, spies } = makeMockDb({ firstResult: row });
    const r = await getLatestActiveRecommendation(db, 'f1');
    expect(r).toEqual(row);
    expect(spies.firstSpy).toHaveBeenCalledOnce();
  });

  it('returns null when no active reco', async () => {
    const { db } = makeMockDb({ firstResult: null });
    expect(await getLatestActiveRecommendation(db, 'fX')).toBeNull();
  });
});

// ============================================================
// markRecommendationStatus
// ============================================================
describe('markRecommendationStatus', () => {
  it('dismissed: only updates status (no timestamp)', async () => {
    const { db, spies } = makeMockDb({});
    await markRecommendationStatus(db, 'r1', 'dismissed');
    expect(spies.prepareSpy).toHaveBeenCalledOnce();
    const sql = spies.prepareSpy.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'dismissed'");
    expect(sql).toContain("status = 'active'");
  });

  it('clicked: sets clicked_at and gates on active', async () => {
    const { db, spies } = makeMockDb({});
    await markRecommendationStatus(db, 'r2', 'clicked');
    const sql = spies.prepareSpy.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'clicked'");
    expect(sql).toContain('clicked_at');
    expect(sql).toContain("status = 'active'");
    // bind: now + id
    const bindArgs = spies.bindSpy.mock.calls[0];
    expect(bindArgs).toHaveLength(2);
    expect(bindArgs[1]).toBe('r2');
  });

  it('converted: sets converted_at + conversion_event_id, allows from active or clicked', async () => {
    const { db, spies } = makeMockDb({});
    await markRecommendationStatus(db, 'r3', 'converted', 'cv-99');
    const sql = spies.prepareSpy.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'converted'");
    expect(sql).toContain('converted_at');
    expect(sql).toContain('conversion_event_id');
    expect(sql).toContain("status IN ('active', 'clicked')");
    const bindArgs = spies.bindSpy.mock.calls[0];
    // [now, conversionEventId, id]
    expect(bindArgs[1]).toBe('cv-99');
    expect(bindArgs[2]).toBe('r3');
  });

  it('converted without conversion_event_id binds null', async () => {
    const { db, spies } = makeMockDb({});
    await markRecommendationStatus(db, 'r4', 'converted');
    const bindArgs = spies.bindSpy.mock.calls[0];
    expect(bindArgs[1]).toBeNull();
  });
});

// ============================================================
// SKU map
// ============================================================
describe('getSkuMapByDeficit', () => {
  it('only returns active entries', async () => {
    const row = {
      deficit_key: 'protein_low',
      shopify_product_id: 'p',
      product_title: 't',
      copy_template: 'c',
      is_active: 1,
      created_at: '2026-04-27T00:00:00',
    };
    const { db, spies } = makeMockDb({ firstResult: row });
    const r = await getSkuMapByDeficit(db, 'protein_low');
    expect(r).toEqual(row);
    const sql = spies.prepareSpy.mock.calls[0][0] as string;
    expect(sql).toContain('is_active = 1');
  });

  it('returns null for unknown key', async () => {
    const { db } = makeMockDb({ firstResult: null });
    expect(await getSkuMapByDeficit(db, 'nope_low')).toBeNull();
  });
});

describe('upsertSkuMap', () => {
  it('binds is_active = 1 by default and 0 when false', async () => {
    const { db, spies } = makeMockDb({});
    await upsertSkuMap(db, {
      deficitKey: 'iron_low',
      shopifyProductId: 'p',
      productTitle: 't',
      copyTemplate: 'c',
    });
    expect(spies.bindSpy.mock.calls[0][4]).toBe(1);

    spies.bindSpy.mockClear();
    await upsertSkuMap(db, {
      deficitKey: 'iron_low',
      shopifyProductId: 'p',
      productTitle: 't',
      copyTemplate: 'c',
      isActive: false,
    });
    expect(spies.bindSpy.mock.calls[0][4]).toBe(0);
  });
});

// ============================================================
// Analytics
// ============================================================
describe('getCoachAnalytics', () => {
  it('returns 0 ctr/cvr when generated is 0 (no NaN)', async () => {
    const { db } = makeMockDb({
      firstResult: { generated: 0, clicked: 0, converted: 0 },
    });
    const r = await getCoachAnalytics(db, '2026-04-01', '2026-04-30');
    expect(r.generated).toBe(0);
    expect(r.ctr).toBe(0);
    expect(r.cvr).toBe(0);
    expect(Number.isNaN(r.ctr)).toBe(false);
    expect(Number.isNaN(r.cvr)).toBe(false);
  });

  it('computes ctr / cvr correctly', async () => {
    const { db } = makeMockDb({
      firstResult: { generated: 100, clicked: 25, converted: 5 },
    });
    const r = await getCoachAnalytics(db, '2026-04-01', '2026-04-30');
    expect(r.ctr).toBe(0.25);
    expect(r.cvr).toBe(0.05);
  });

  it('handles SQL SUM null (when no rows match) by coalescing to 0', async () => {
    const { db } = makeMockDb({
      firstResult: { generated: 0, clicked: null, converted: null },
    });
    const r = await getCoachAnalytics(db, '2030-01-01', '2030-01-02');
    expect(r.clicked).toBe(0);
    expect(r.converted).toBe(0);
  });
});

describe('countStaleActiveRecommendations', () => {
  it('returns 0 when no stale rows', async () => {
    const { db } = makeMockDb({ firstResult: { n: 0 } });
    expect(await countStaleActiveRecommendations(db, '2026-01-01')).toBe(0);
  });

  it('returns n from row', async () => {
    const { db } = makeMockDb({ firstResult: { n: 3 } });
    expect(await countStaleActiveRecommendations(db, '2026-01-01')).toBe(3);
  });
});
