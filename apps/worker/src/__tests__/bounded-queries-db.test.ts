/**
 * Unit tests for admin-list bounded queries (採点 Round1 D5, 2026-06-28)
 *
 * getBroadcasts / getAbTests / getScenarios / getReminders が unbounded SELECT * でなく
 * default LIMIT + OFFSET pagination で bound されることを実 @line-crm/db 関数で検証。
 * NOTE: 意図的に vi.mock('@line-crm/db') を呼ばない (= 実装を exercise)。
 */
import { describe, it, expect } from 'vitest';
import { getBroadcasts, getAbTests, getScenarios, getReminders } from '@line-crm/db';

interface FakeState {
  sql: string;
  params: unknown[];
}

function makeFakeDb(state: FakeState): D1Database {
  return {
    prepare(sql: string) {
      state.sql = sql;
      return {
        bind(...params: unknown[]) {
          state.params = params;
          return { async all<T>() { return { results: [] as T[], success: true }; } };
        },
        async all<T>() {
          return { results: [] as T[], success: true };
        },
      };
    },
  } as unknown as D1Database;
}

describe('admin-list bounded queries (D5)', () => {
  it('getBroadcasts は LIMIT ? OFFSET ? + default 1000/0', async () => {
    const state = { sql: '', params: [] as unknown[] };
    await getBroadcasts(makeFakeDb(state));
    expect(state.sql).toContain('LIMIT ? OFFSET ?');
    expect(state.params).toEqual([1000, 0]);
  });

  it('getBroadcasts は opts.limit/offset を bind', async () => {
    const state = { sql: '', params: [] as unknown[] };
    await getBroadcasts(makeFakeDb(state), { limit: 50, offset: 100 });
    expect(state.params).toEqual([50, 100]);
  });

  it('getAbTests は LIMIT ? OFFSET ? + default', async () => {
    const state = { sql: '', params: [] as unknown[] };
    await getAbTests(makeFakeDb(state));
    expect(state.sql).toContain('LIMIT ? OFFSET ?');
    expect(state.params).toEqual([1000, 0]);
  });

  it('getScenarios は GROUP BY 後に LIMIT ? OFFSET ? + default', async () => {
    const state = { sql: '', params: [] as unknown[] };
    await getScenarios(makeFakeDb(state));
    expect(state.sql).toContain('GROUP BY s.id');
    expect(state.sql).toContain('LIMIT ? OFFSET ?');
    expect(state.params).toEqual([1000, 0]);
  });

  it('getReminders は LIMIT ? OFFSET ? + default', async () => {
    const state = { sql: '', params: [] as unknown[] };
    await getReminders(makeFakeDb(state));
    expect(state.sql).toContain('LIMIT ? OFFSET ?');
    expect(state.params).toEqual([1000, 0]);
  });
});
