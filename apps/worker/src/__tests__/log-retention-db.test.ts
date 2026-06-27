/**
 * Unit tests for @line-crm/db log-retention helpers (= PII 保持期間 prune, 2026-06-28, D6)
 *
 * 実 @line-crm/db 関数 (pruneOldMessagesLog / pruneOldConversationLogs) を fake D1 で直接 test。
 * NOTE: 意図的に `vi.mock('@line-crm/db')` を呼ばない (= 実装を exercise、 membership-db.test.ts と同方針)。
 */
import { describe, it, expect } from 'vitest';
import { pruneOldMessagesLog, pruneOldConversationLogs } from '@line-crm/db';

interface FakeRunState {
  calls: { sql: string; params: unknown[] }[];
  metaToReturn?: { changes?: number };
}

function makeFakeDb(state: FakeRunState): D1Database {
  return {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async run() {
              state.calls.push(call);
              return { success: true, meta: state.metaToReturn };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe('pruneOldMessagesLog', () => {
  it('strftime cutoff (JST形式) で DELETE、 retentionMonths を modifier に bind、 削除行数を返す', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: { changes: 5 } };
    const deleted = await pruneOldMessagesLog(makeFakeDb(state), 24);
    expect(deleted).toBe(5);
    expect(state.calls[0]!.sql).toContain('DELETE FROM messages_log');
    // created_at の JST ローカル形式と整合する DB 側 strftime cutoff (UTC Z 混在を避ける)
    expect(state.calls[0]!.sql).toContain("strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', ?)");
    expect(state.calls[0]!.params).toEqual(['-24 months']);
  });

  it('meta 欠落 → 0', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: undefined };
    expect(await pruneOldMessagesLog(makeFakeDb(state), 24)).toBe(0);
  });
});

describe('pruneOldConversationLogs', () => {
  it('strftime cutoff で DELETE、 retentionMonths を modifier に bind、 削除行数を返す', async () => {
    const state: FakeRunState = { calls: [], metaToReturn: { changes: 3 } };
    const deleted = await pruneOldConversationLogs(makeFakeDb(state), 12);
    expect(deleted).toBe(3);
    expect(state.calls[0]!.sql).toContain('DELETE FROM conversation_logs');
    expect(state.calls[0]!.sql).toContain("strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours', ?)");
    expect(state.calls[0]!.params).toEqual(['-12 months']);
  });
});
