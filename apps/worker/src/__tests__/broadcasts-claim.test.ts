/**
 * Tests for claimBroadcastForSending (= broadcast 送信前 atomic claim CAS, 2026-06-06, E)
 *
 * 実 @line-crm/db 関数を in-memory mock db で直接 test (= scenarios-claim.test.ts と同様式)。
 * 重複 cron / 手動送信の二重送信防止の中核。 vi.mock しない (= 実装を exercise)。
 */
import { describe, it, expect, vi } from 'vitest';
import { claimBroadcastForSending } from '@line-crm/db';

function makeDb(changes: number, onSql?: (sql: string) => void) {
  return {
    prepare: vi.fn((sql: string) => {
      onSql?.(sql);
      return {
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ success: true, meta: { changes } })),
        })),
      };
    }),
  } as unknown as D1Database;
}

describe('claimBroadcastForSending (CAS)', () => {
  it('changes===1 → true (= 自分が claim 成功)', async () => {
    expect(await claimBroadcastForSending(makeDb(1), 'bc-1')).toBe(true);
  });

  it('changes===0 → false (= 別実行が先に claim 済 → skip)', async () => {
    expect(await claimBroadcastForSending(makeDb(0), 'bc-1')).toBe(false);
  });

  it('CAS は status IN (scheduled, draft) → sending を WHERE 条件に含む', async () => {
    let sql = '';
    await claimBroadcastForSending(makeDb(1, (s) => (sql = s)), 'bc-1');
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('UPDATE broadcasts');
    expect(normalized).toContain("status = 'sending'");
    expect(normalized).toContain("status IN ('scheduled', 'draft')");
  });
});
