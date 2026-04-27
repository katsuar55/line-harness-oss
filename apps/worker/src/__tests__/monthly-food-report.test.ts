/**
 * Tests for monthly-food-report (Phase 3 PR-7).
 *
 * Covers:
 *   - previousMonthRange: 月初・月末・年跨ぎ・閏年
 *   - templateSummary: 0 日 / 通常
 *   - redactProhibited: 薬機ワード redaction
 *   - processMonthlyFoodReports: gating (1日でない時 noop) / 既存 skip /
 *     生成成功 (template fallback) / API key 未設定 / 集計 0 メッセージ
 */

import { describe, it, expect, vi } from 'vitest';
import {
  processMonthlyFoodReports,
  templateSummary,
  __test__,
} from '../services/monthly-food-report.js';

const { previousMonthRange, redactProhibited, REDACTION_TOKEN } = __test__;

// ---------- previousMonthRange ----------
describe('previousMonthRange', () => {
  it('returns the previous month for a typical date', () => {
    const r = previousMonthRange('2026-04-01T03:00:00');
    expect(r.yearMonth).toBe('2026-03');
    expect(r.fromDate).toBe('2026-03-01');
    expect(r.toDate).toBe('2026-03-31');
  });

  it('crosses year boundary correctly', () => {
    const r = previousMonthRange('2026-01-01T03:00:00');
    expect(r.yearMonth).toBe('2025-12');
    expect(r.fromDate).toBe('2025-12-01');
    expect(r.toDate).toBe('2025-12-31');
  });

  it('handles February in leap year (2024)', () => {
    const r = previousMonthRange('2024-03-01T03:00:00');
    expect(r.yearMonth).toBe('2024-02');
    expect(r.toDate).toBe('2024-02-29'); // leap
  });

  it('handles February in non-leap year (2026)', () => {
    const r = previousMonthRange('2026-03-01T03:00:00');
    expect(r.yearMonth).toBe('2026-02');
    expect(r.toDate).toBe('2026-02-28');
  });

  it('handles 30-day month (April → March 31)', () => {
    const r = previousMonthRange('2026-05-01T03:00:00');
    expect(r.yearMonth).toBe('2026-04');
    expect(r.toDate).toBe('2026-04-30');
  });
});

// ---------- redactProhibited ----------
describe('redactProhibited', () => {
  it('preserves clean text', () => {
    expect(redactProhibited('野菜とタンパク質のバランスが良いです')).toBe(
      '野菜とタンパク質のバランスが良いです',
    );
  });

  it('redacts prohibited Japanese phrase phrase-level', () => {
    const r = redactProhibited('健康になり病気が改善しました');
    expect(r).toBe(`健康になり${REDACTION_TOKEN}しました`);
  });

  it('redacts case-insensitive english (cure / heal)', () => {
    const r = redactProhibited('It will Cure your woes and HEAL fast.');
    expect(r).toContain(REDACTION_TOKEN);
    expect(r).not.toMatch(/cure/i);
    expect(r).not.toMatch(/heal/i);
  });
});

// ---------- templateSummary ----------
describe('templateSummary', () => {
  it('handles zero-days case', () => {
    const t = templateSummary({
      yearMonth: '2026-03',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      mealCount: 0,
      avgCalories: null,
      avgProteinG: null,
      avgFatG: null,
      avgCarbsG: null,
      daysLogged: 0,
    });
    expect(t).toContain('2026-03');
    expect(t).toContain('記録がありませんでした');
  });

  it('contains numbers in normal case', () => {
    const t = templateSummary({
      yearMonth: '2026-03',
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
      mealCount: 60,
      avgCalories: 1800,
      avgProteinG: 80,
      avgFatG: 60,
      avgCarbsG: 230,
      daysLogged: 30,
    });
    expect(t).toContain('30 日');
    expect(t).toContain('60 回');
    expect(t).toContain('1800');
    expect(t).toContain('80');
  });
});

// ---------- processMonthlyFoodReports ----------

interface MockDB {
  prepare: ReturnType<typeof vi.fn>;
}

function makeStubDb(distinctFriends: string[], statsRows: Array<Record<string, unknown>>): MockDB {
  return {
    prepare: vi.fn((_sql: string) => ({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: distinctFriends.map((f) => ({ friend_id: f })) }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({}),
      }),
    })),
  };
}

describe('processMonthlyFoodReports — gating', () => {
  it('returns no-op when day is not 1', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const r = await processMonthlyFoodReports(db, undefined, {
      nowOverride: '2026-04-15T10:00:00',
    });
    expect(r).toEqual({ generated: 0, skipped: 0, errors: 0 });
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe('processMonthlyFoodReports — generation flow', () => {
  // We need to mock @line-crm/db in-place; vitest hoists vi.mock to top of file.
  // Inject behavior via the mocked module.
  it('skips friends whose report already exists', async () => {
    vi.resetModules();
    vi.doMock('@line-crm/db', () => ({
      jstNow: () => '2026-04-01T03:00:00',
      getMonthlyFoodReport: vi.fn().mockResolvedValue({
        friend_id: 'f1',
        year_month: '2026-03',
        summary_text: 'already',
        meal_count: 10,
        avg_calories: 1800,
        generated_at: '2026-03-31T10:00:00',
      }),
      getDailyFoodStatsRange: vi.fn().mockResolvedValue([]),
      insertMonthlyFoodReport: vi.fn().mockResolvedValue({}),
    }));

    const mod = await import('../services/monthly-food-report.js');

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [{ friend_id: 'f1' }] }),
        })),
      })),
    } as unknown as D1Database;

    const r = await mod.processMonthlyFoodReports(db, 'fake', {
      nowOverride: '2026-04-01T03:00:00',
      forceTemplateOnly: true,
    });
    expect(r.skipped).toBe(1);
    expect(r.generated).toBe(0);

    vi.doUnmock('@line-crm/db');
  });

  it('generates with template fallback when forceTemplateOnly', async () => {
    vi.resetModules();
    const insertSpy = vi.fn().mockResolvedValue({
      friend_id: 'f1',
      year_month: '2026-03',
      summary_text: 'x',
      meal_count: 30,
      avg_calories: 1800,
      generated_at: '2026-04-01T03:00:00',
    });
    vi.doMock('@line-crm/db', () => ({
      jstNow: () => '2026-04-01T03:00:00',
      getMonthlyFoodReport: vi.fn().mockResolvedValue(null),
      getDailyFoodStatsRange: vi.fn().mockResolvedValue([
        {
          friend_id: 'f1',
          date: '2026-03-01',
          total_calories: 1800,
          total_protein_g: 80,
          total_fat_g: 60,
          total_carbs_g: 230,
          meal_count: 3,
          last_updated: '2026-03-01T20:00:00',
        },
      ]),
      insertMonthlyFoodReport: insertSpy,
    }));

    const mod = await import('../services/monthly-food-report.js');

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [{ friend_id: 'f1' }] }),
        })),
      })),
    } as unknown as D1Database;

    const r = await mod.processMonthlyFoodReports(db, undefined, {
      nowOverride: '2026-04-01T03:00:00',
      forceTemplateOnly: true,
    });
    expect(r.generated).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(0);
    expect(insertSpy).toHaveBeenCalledOnce();
    const call = insertSpy.mock.calls[0][1];
    expect(call.yearMonth).toBe('2026-03');
    expect(call.mealCount).toBe(3);
    expect(call.summaryText).toContain('2026-03');

    vi.doUnmock('@line-crm/db');
  });

  it('skips when meal_count is 0 even with friend listed', async () => {
    vi.resetModules();
    vi.doMock('@line-crm/db', () => ({
      jstNow: () => '2026-04-01T03:00:00',
      getMonthlyFoodReport: vi.fn().mockResolvedValue(null),
      getDailyFoodStatsRange: vi.fn().mockResolvedValue([]), // empty range
      insertMonthlyFoodReport: vi.fn(),
    }));

    const mod = await import('../services/monthly-food-report.js');

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [{ friend_id: 'f1' }] }),
        })),
      })),
    } as unknown as D1Database;

    const r = await mod.processMonthlyFoodReports(db, undefined, {
      nowOverride: '2026-04-01T03:00:00',
      forceTemplateOnly: true,
    });
    expect(r.generated).toBe(0);
    expect(r.skipped).toBe(1);

    vi.doUnmock('@line-crm/db');
  });

  it('counts errors and continues on individual failures', async () => {
    vi.resetModules();
    const getReport = vi.fn();
    getReport.mockResolvedValueOnce(null); // f1: not yet
    getReport.mockResolvedValueOnce(null); // f2: not yet

    const insertSpy = vi.fn();
    insertSpy.mockRejectedValueOnce(new Error('write failed')); // f1 throws
    insertSpy.mockResolvedValueOnce({}); // f2 ok

    vi.doMock('@line-crm/db', () => ({
      jstNow: () => '2026-04-01T03:00:00',
      getMonthlyFoodReport: getReport,
      getDailyFoodStatsRange: vi.fn().mockResolvedValue([
        {
          friend_id: 'fX',
          date: '2026-03-01',
          total_calories: 1800,
          total_protein_g: 80,
          total_fat_g: 60,
          total_carbs_g: 230,
          meal_count: 3,
          last_updated: '2026-03-01T20:00:00',
        },
      ]),
      insertMonthlyFoodReport: insertSpy,
    }));

    const mod = await import('../services/monthly-food-report.js');

    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi
            .fn()
            .mockResolvedValue({ results: [{ friend_id: 'f1' }, { friend_id: 'f2' }] }),
        })),
      })),
    } as unknown as D1Database;

    const r = await mod.processMonthlyFoodReports(db, undefined, {
      nowOverride: '2026-04-01T03:00:00',
      forceTemplateOnly: true,
    });
    expect(r.errors).toBe(1);
    expect(r.generated).toBe(1);

    vi.doUnmock('@line-crm/db');
  });
});
