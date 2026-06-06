/**
 * Tests for reminder 配信の blacklist 除外 (H2, 2026-06-06, Katsu=Option A: 全停止)
 *
 * ブラックリスト (= do-not-contact) の友だちには、 本人が設定した opt-in リマインダーも
 * 含めて配信しない。 H (一斉配信) / step-delivery (シナリオ) と挙動を統一する。
 * クエリのフィルタ方式なので、 ブラックリスト解除で配信は自動再開する (= 可逆)。
 *
 * 実 @line-crm/db 関数を SQL-capture mock db で直接 test (= tags-blacklist.test.ts と同様式)。
 */
import { describe, it, expect, vi } from 'vitest';
import { getActiveIntakeReminders, getDueReminderDeliveries } from '@line-crm/db';

/** prepare された全 SQL を記録する db (.all / .bind().all 両対応、 results 空)。 */
function makeCapturingDb(): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  const stmt = (sql: string) => ({
    bind: vi.fn(() => stmt(sql)),
    all: vi.fn(async () => ({ results: [] as unknown[] })),
  });
  const db = {
    prepare: vi.fn((sql: string) => {
      sqls.push(sql);
      return stmt(sql);
    }),
  } as unknown as D1Database;
  return { db, sqls };
}

const norm = (s: string) => s.replace(/\s+/g, ' ');

describe('reminder 配信の blacklist 除外 (H2)', () => {
  it('getActiveIntakeReminders は is_blacklisted を除外する', async () => {
    const { db, sqls } = makeCapturingDb();
    await getActiveIntakeReminders(db, '09:00');

    const q = sqls.map(norm).find((s) => s.includes('intake_reminders'));
    expect(q).toBeDefined();
    expect(q).toContain('JOIN friends');
    expect(q).toContain('COALESCE(f.is_blacklisted, 0) = 0');
  });

  it('getDueReminderDeliveries は friends を JOIN して is_blacklisted を除外する', async () => {
    const { db, sqls } = makeCapturingDb();
    await getDueReminderDeliveries(db, '2026-06-06T09:00:00+09:00');

    const q = sqls.map(norm).find((s) => s.includes('friend_reminders'));
    expect(q).toBeDefined();
    expect(q).toContain('JOIN friends');
    expect(q).toContain('COALESCE(f.is_blacklisted, 0) = 0');
  });
});
