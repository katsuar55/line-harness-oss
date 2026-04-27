/**
 * Tests for nutrition-analyzer (Phase 4 PR-2).
 *
 * 純粋関数 (severityFor / evaluateDeficits / summarizeAverages) と
 * D1 を絡めた analyzeFriendNutrition の統合テスト。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  analyzeFriendNutrition,
  evaluateDeficits,
  severityFor,
  summarizeAverages,
  ANALYSIS_WINDOW_DAYS,
  MIN_DAYS_FOR_ANALYSIS,
  NUTRITION_TARGET_FEMALE_ADULT,
  __test__,
} from '../services/nutrition-analyzer.js';
import type { DailyFoodStats } from '@line-crm/db';

// ============================================================
// severityFor (純粋ロジック)
// ============================================================
describe('severityFor (low direction)', () => {
  it('returns null when ratio >= 90% of target', () => {
    expect(severityFor(90, 100, 'low')).toBeNull();
    expect(severityFor(100, 100, 'low')).toBeNull();
    expect(severityFor(120, 100, 'low')).toBeNull();
  });

  it('returns mild when ratio is 70-89%', () => {
    expect(severityFor(80, 100, 'low')).toBe('mild');
    expect(severityFor(70, 100, 'low')).toBe('mild');
    expect(severityFor(89.9, 100, 'low')).toBe('mild');
  });

  it('returns moderate when ratio is 50-69%', () => {
    expect(severityFor(50, 100, 'low')).toBe('moderate');
    expect(severityFor(60, 100, 'low')).toBe('moderate');
  });

  it('returns severe when ratio < 50%', () => {
    expect(severityFor(49, 100, 'low')).toBe('severe');
    expect(severityFor(0, 100, 'low')).toBe('severe');
  });
});

describe('severityFor (high direction)', () => {
  it('returns null when ratio <= 110%', () => {
    expect(severityFor(110, 100, 'high')).toBeNull();
    expect(severityFor(100, 100, 'high')).toBeNull();
    expect(severityFor(50, 100, 'high')).toBeNull();
  });

  it('returns mild when ratio is 110-130%', () => {
    expect(severityFor(120, 100, 'high')).toBe('mild');
    expect(severityFor(130, 100, 'high')).toBe('mild');
  });

  it('returns severe when ratio > 150%', () => {
    expect(severityFor(160, 100, 'high')).toBe('severe');
    expect(severityFor(300, 100, 'high')).toBe('severe');
  });
});

describe('severityFor (edge cases)', () => {
  it('returns null when target is 0 (avoid div by zero)', () => {
    expect(severityFor(50, 0, 'low')).toBeNull();
  });

  it('returns null when target is negative (defensive)', () => {
    expect(severityFor(50, -100, 'low')).toBeNull();
  });
});

// ============================================================
// summarizeAverages
// ============================================================
describe('summarizeAverages', () => {
  it('returns null for empty array', () => {
    expect(summarizeAverages([])).toBeNull();
  });

  it('averages calorie / protein / fat / carbs across days', () => {
    const stats = makeStats([
      { calorie: 1000, p: 30, f: 30, c: 100 },
      { calorie: 2000, p: 50, f: 50, c: 200 },
      { calorie: 3000, p: 70, f: 70, c: 300 },
    ]);
    const avg = summarizeAverages(stats);
    expect(avg).not.toBeNull();
    expect(avg!.calorie).toBe(2000);
    expect(avg!.protein_g).toBe(50);
    expect(avg!.fat_g).toBe(50);
    expect(avg!.carbs_g).toBe(200);
  });

  it('treats null PFC values as 0 in the sum', () => {
    const stats: DailyFoodStats[] = [
      makeOne({ calorie: 1000, p: 50, f: 30, c: 100 }),
      // null フィールド → 0 として加算
      {
        friend_id: 'f',
        date: '2026-04-26',
        total_calories: null as unknown as number,
        total_protein_g: null as unknown as number,
        total_fat_g: null as unknown as number,
        total_carbs_g: null as unknown as number,
        meal_count: 0,
        last_updated: '',
      },
    ];
    const avg = summarizeAverages(stats);
    expect(avg!.calorie).toBe(500); // (1000 + 0) / 2
    expect(avg!.protein_g).toBe(25);
  });
});

// ============================================================
// evaluateDeficits
// ============================================================
describe('evaluateDeficits', () => {
  it('returns empty for null averages', () => {
    expect(evaluateDeficits(null)).toEqual([]);
  });

  it('returns protein_low when protein is moderately low', () => {
    const avg = {
      calorie: NUTRITION_TARGET_FEMALE_ADULT.calorie,
      protein_g: 40, // target 65, ratio = 0.61 → moderate
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    const protein = deficits.find((d) => d.key === 'protein_low');
    expect(protein).toBeDefined();
    expect(protein!.severity).toBe('moderate');
    expect(protein!.targetAvg).toBe(65);
    expect(protein!.observedAvg).toBe(40);
  });

  it('does not flag protein when within 90% of target', () => {
    const avg = {
      calorie: NUTRITION_TARGET_FEMALE_ADULT.calorie,
      protein_g: 60, // target 65, ratio = 0.92 → no flag
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    expect(deficits.find((d) => d.key === 'protein_low')).toBeUndefined();
  });

  it('returns calorie_low for low calorie intake', () => {
    const avg = {
      calorie: 1200, // target 2000, ratio 0.6 → moderate
      protein_g: NUTRITION_TARGET_FEMALE_ADULT.protein_g,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    const cal = deficits.find((d) => d.key === 'calorie_low');
    expect(cal).toBeDefined();
    expect(cal!.severity).toBe('moderate');
  });

  it('returns calorie_high (not _low) when overshooting', () => {
    const avg = {
      calorie: 2800, // target 2000, ratio 1.4 → moderate high
      protein_g: NUTRITION_TARGET_FEMALE_ADULT.protein_g,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    expect(deficits.find((d) => d.key === 'calorie_low')).toBeUndefined();
    const high = deficits.find((d) => d.key === 'calorie_high');
    expect(high).toBeDefined();
    expect(high!.severity).toBe('moderate');
  });

  it('emits iron_low (mild) when both protein_low and calorie_low fire', () => {
    const avg = {
      calorie: 1200,
      protein_g: 40,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    const iron = deficits.find((d) => d.key === 'iron_low');
    expect(iron).toBeDefined();
    expect(iron!.severity).toBe('mild');
  });

  it('does NOT emit iron_low when only protein is low', () => {
    const avg = {
      calorie: NUTRITION_TARGET_FEMALE_ADULT.calorie,
      protein_g: 40,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    const deficits = evaluateDeficits(avg);
    expect(deficits.find((d) => d.key === 'iron_low')).toBeUndefined();
  });

  it('emits fiber_low when otherwise healthy but carbs are very low', () => {
    const avg = {
      calorie: NUTRITION_TARGET_FEMALE_ADULT.calorie,
      protein_g: NUTRITION_TARGET_FEMALE_ADULT.protein_g,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: 100, // < 60% of target 280
    };
    const deficits = evaluateDeficits(avg);
    const fiber = deficits.find((d) => d.key === 'fiber_low');
    expect(fiber).toBeDefined();
    expect(fiber!.severity).toBe('mild');
  });

  it('returns no deficits for an otherwise balanced 7-day average', () => {
    const avg = {
      calorie: NUTRITION_TARGET_FEMALE_ADULT.calorie,
      protein_g: NUTRITION_TARGET_FEMALE_ADULT.protein_g,
      fat_g: NUTRITION_TARGET_FEMALE_ADULT.fat_g,
      carbs_g: NUTRITION_TARGET_FEMALE_ADULT.carbs_g,
    };
    expect(evaluateDeficits(avg)).toEqual([]);
  });
});

// ============================================================
// analyzeFriendNutrition (D1 統合)
// ============================================================
describe('analyzeFriendNutrition', () => {
  function mockDb(rows: DailyFoodStats[]): D1Database {
    const allSpy = vi.fn().mockResolvedValue({ results: rows, success: true });
    const bindSpy = vi.fn().mockReturnValue({ all: allSpy });
    const prepareSpy = vi.fn().mockReturnValue({ bind: bindSpy });
    return { prepare: prepareSpy } as unknown as D1Database;
  }

  it('skipReason=no_data when zero rows', async () => {
    const r = await analyzeFriendNutrition({
      db: mockDb([]),
      friendId: 'f1',
      asOfDate: '2026-04-27',
    });
    expect(r.skipReason).toBe('no_data');
    expect(r.daysWithData).toBe(0);
    expect(r.averages).toBeNull();
    expect(r.deficits).toEqual([]);
  });

  it('skipReason=insufficient_data when 4 rows (< MIN_DAYS_FOR_ANALYSIS)', async () => {
    const rows = makeStats([
      { calorie: 1500, p: 50, f: 50, c: 200 },
      { calorie: 1600, p: 50, f: 50, c: 200 },
      { calorie: 1700, p: 50, f: 50, c: 200 },
      { calorie: 1800, p: 50, f: 50, c: 200 },
    ]);
    const r = await analyzeFriendNutrition({
      db: mockDb(rows),
      friendId: 'f1',
      asOfDate: '2026-04-27',
    });
    expect(r.skipReason).toBe('insufficient_data');
    expect(r.daysWithData).toBe(4);
    expect(r.averages).not.toBeNull();
    expect(r.deficits).toEqual([]);
  });

  it('returns deficits when 5+ days of data show protein shortage', async () => {
    const rows = makeStats([
      { calorie: 1900, p: 30, f: 60, c: 280 },
      { calorie: 2000, p: 35, f: 60, c: 280 },
      { calorie: 1950, p: 32, f: 60, c: 280 },
      { calorie: 2050, p: 31, f: 60, c: 280 },
      { calorie: 1980, p: 33, f: 60, c: 280 },
      { calorie: 2010, p: 34, f: 60, c: 280 },
      { calorie: 2000, p: 32, f: 60, c: 280 },
    ]);
    const r = await analyzeFriendNutrition({
      db: mockDb(rows),
      friendId: 'f1',
      asOfDate: '2026-04-27',
    });
    expect(r.skipReason).toBeUndefined();
    expect(r.daysWithData).toBe(7);
    const protein = r.deficits.find((d) => d.key === 'protein_low');
    expect(protein).toBeDefined();
    expect(['moderate', 'severe']).toContain(protein!.severity);
  });

  it('uses correct from/to range (7 days, inclusive)', async () => {
    const r = await analyzeFriendNutrition({
      db: mockDb([]),
      friendId: 'f1',
      asOfDate: '2026-04-27',
    });
    expect(r.toDate).toBe('2026-04-27');
    // 7 days window, inclusive: 2026-04-27 .. 2026-04-21
    expect(r.fromDate).toBe('2026-04-21');
  });

  it('defaults asOfDate to today JST when omitted', async () => {
    const r = await analyzeFriendNutrition({
      db: mockDb([]),
      friendId: 'f1',
    });
    expect(r.toDate).toBe(__test__.todayJst());
  });
});

// ============================================================
// constants sanity
// ============================================================
describe('constants', () => {
  it('ANALYSIS_WINDOW_DAYS = 7', () => {
    expect(ANALYSIS_WINDOW_DAYS).toBe(7);
  });
  it('MIN_DAYS_FOR_ANALYSIS = 5', () => {
    expect(MIN_DAYS_FOR_ANALYSIS).toBe(5);
  });
});

// ============================================================
// helpers
// ============================================================
function makeStats(input: Array<{ calorie: number; p: number; f: number; c: number }>): DailyFoodStats[] {
  return input.map((d, i) => makeOne({ ...d, dateIdx: i }));
}

function makeOne(d: {
  calorie: number;
  p: number;
  f: number;
  c: number;
  dateIdx?: number;
}): DailyFoodStats {
  return {
    friend_id: 'f1',
    date: `2026-04-${String(20 + (d.dateIdx ?? 0)).padStart(2, '0')}`,
    total_calories: d.calorie,
    total_protein_g: d.p,
    total_fat_g: d.f,
    total_carbs_g: d.c,
    meal_count: 3,
    last_updated: '2026-04-27T00:00:00.000',
  };
}
