/**
 * Tests for claimFriendScenarioForDelivery (= 配信前 atomic claim CAS, 2026-06-05)
 *
 * 実 @line-crm/db 関数を in-memory mock db で直接 test (= meta.changes → boolean マッピング + SQL 形)。
 * 重複 cron 実行による二重配信防止の中核。 vi.mock しない (= 実装を exercise)。
 */
import { describe, it, expect, vi } from 'vitest';
import { claimFriendScenarioForDelivery } from '@line-crm/db';

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

describe('claimFriendScenarioForDelivery (CAS)', () => {
  it('changes===1 → true (= 自分が claim 成功)', async () => {
    const r = await claimFriendScenarioForDelivery(
      makeDb(1),
      'fs-1',
      '2026-06-05T10:00:00+09:00',
      '2026-06-05T10:10:00+09:00',
    );
    expect(r).toBe(true);
  });

  it('changes===0 → false (= 別 worker が先に claim 済 → skip)', async () => {
    const r = await claimFriendScenarioForDelivery(
      makeDb(0),
      'fs-1',
      '2026-06-05T10:00:00+09:00',
      '2026-06-05T10:10:00+09:00',
    );
    expect(r).toBe(false);
  });

  it('CAS は status=active かつ next_delivery_at 一致を WHERE 条件に含む', async () => {
    let sql = '';
    const db = makeDb(1, (s) => {
      sql = s;
    });
    await claimFriendScenarioForDelivery(db, 'fs-1', 'T', 'L');
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('next_delivery_at = ?');
    expect(sql).toContain('UPDATE friend_scenarios');
  });
});
