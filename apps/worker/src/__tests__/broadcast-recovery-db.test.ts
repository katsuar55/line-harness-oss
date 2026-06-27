/**
 * Unit tests for broadcast stuck-recovery db helpers (採点 Round1 D1, 2026-06-28)
 *
 * 実 @line-crm/db 関数を fake D1 で直接検証 (vi.mock しない)。
 * - claimBroadcastForSending: sending_started_at を記録
 * - getDueScheduledBroadcasts / getStuckSendingBroadcasts: bounded query
 * - hasBroadcastSendEvidence / resetStuckBroadcastToScheduled: 安全自動復旧の判定/実行
 */
import { describe, it, expect } from 'vitest';
import {
  claimBroadcastForSending,
  getDueScheduledBroadcasts,
  getStuckSendingBroadcasts,
  hasBroadcastSendEvidence,
  resetStuckBroadcastToScheduled,
} from '@line-crm/db';

interface FakeState {
  sql: string;
  params: unknown[];
  meta?: { changes?: number };
  first?: unknown;
  all?: unknown[];
}

function makeFakeDb(state: FakeState): D1Database {
  return {
    prepare(sql: string) {
      state.sql = sql;
      const stmt = {
        bind(...params: unknown[]) {
          state.params = params;
          return stmt;
        },
        async run() {
          return { success: true, meta: state.meta };
        },
        async first<T>() {
          return (state.first ?? null) as T | null;
        },
        async all<T>() {
          return { results: (state.all ?? []) as T[], success: true };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe('claimBroadcastForSending', () => {
  it('CAS で sending_started_at を記録し、 changes===1 で true', async () => {
    const state: FakeState = { sql: '', params: [], meta: { changes: 1 } };
    const ok = await claimBroadcastForSending(makeFakeDb(state), 'bc-1');
    expect(ok).toBe(true);
    expect(state.sql).toContain("status = 'sending'");
    expect(state.sql).toContain('sending_started_at = ?');
    expect(state.sql).toContain("status IN ('scheduled', 'draft')");
    // bind = [jstNow, id]
    expect(state.params).toHaveLength(2);
    expect(state.params[1]).toBe('bc-1');
  });

  it('changes===0 → false (別実行が先に claim)', async () => {
    const state: FakeState = { sql: '', params: [], meta: { changes: 0 } };
    expect(await claimBroadcastForSending(makeFakeDb(state), 'bc-1')).toBe(false);
  });
});

describe('getDueScheduledBroadcasts', () => {
  it("status='scheduled' AND scheduled_at<=now、 ASC、 LIMIT で bind", async () => {
    const state: FakeState = { sql: '', params: [], all: [{ id: 'bc-due' }] };
    const rows = await getDueScheduledBroadcasts(makeFakeDb(state), '2026-06-28T00:00:00+09:00', 100);
    expect(rows).toHaveLength(1);
    expect(state.sql).toContain("status = 'scheduled'");
    expect(state.sql).toContain('scheduled_at <= ?');
    expect(state.sql).toContain('ORDER BY scheduled_at ASC LIMIT ?');
    expect(state.params).toEqual(['2026-06-28T00:00:00+09:00', 100]);
  });
});

describe('getStuckSendingBroadcasts', () => {
  it("status='sending' AND sending_started_at<cutoff、 ASC、 LIMIT で bind", async () => {
    const state: FakeState = { sql: '', params: [], all: [] };
    await getStuckSendingBroadcasts(makeFakeDb(state), '2026-06-28T00:00:00+09:00', 50);
    expect(state.sql).toContain("status = 'sending'");
    expect(state.sql).toContain('sending_started_at < ?');
    expect(state.sql).toContain('ORDER BY sending_started_at ASC LIMIT ?');
    expect(state.params).toEqual(['2026-06-28T00:00:00+09:00', 50]);
  });
});

describe('hasBroadcastSendEvidence', () => {
  it('line_request_id / messages_log / email いずれかあれば true', async () => {
    const state: FakeState = { sql: '', params: [], first: { has_req: 1, has_msg: 0, has_email: 0 } };
    expect(await hasBroadcastSendEvidence(makeFakeDb(state), 'bc-1')).toBe(true);
  });
  it('messages_log のみでも true', async () => {
    const state: FakeState = { sql: '', params: [], first: { has_req: null, has_msg: 1, has_email: 0 } };
    expect(await hasBroadcastSendEvidence(makeFakeDb(state), 'bc-1')).toBe(true);
  });
  it('全て 0/null → false (= 未送信、 安全に再送可)', async () => {
    const state: FakeState = { sql: '', params: [], first: { has_req: null, has_msg: 0, has_email: 0 } };
    expect(await hasBroadcastSendEvidence(makeFakeDb(state), 'bc-1')).toBe(false);
  });
  it('行なし → false', async () => {
    const state: FakeState = { sql: '', params: [], first: null };
    expect(await hasBroadcastSendEvidence(makeFakeDb(state), 'bc-1')).toBe(false);
  });
});

describe('resetStuckBroadcastToScheduled', () => {
  it("CAS (status='sending' のみ) で scheduled へ戻す、 sending_started_at=NULL", async () => {
    const state: FakeState = { sql: '', params: [], meta: { changes: 1 } };
    const ok = await resetStuckBroadcastToScheduled(makeFakeDb(state), 'bc-1', '2026-06-28T00:00:00+09:00');
    expect(ok).toBe(true);
    expect(state.sql).toContain("status = 'scheduled'");
    expect(state.sql).toContain('sending_started_at = NULL');
    expect(state.sql).toContain("WHERE id = ? AND status = 'sending'");
    expect(state.params).toEqual(['2026-06-28T00:00:00+09:00', 'bc-1']);
  });
  it('changes===0 → false (既に別状態)', async () => {
    const state: FakeState = { sql: '', params: [], meta: { changes: 0 } };
    expect(
      await resetStuckBroadcastToScheduled(makeFakeDb(state), 'bc-1', '2026-06-28T00:00:00+09:00'),
    ).toBe(false);
  });
});
