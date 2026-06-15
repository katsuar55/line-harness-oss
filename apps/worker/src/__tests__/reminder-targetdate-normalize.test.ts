/**
 * Tests for reminder target_date JST normalization (2026-06-15).
 *
 * `POST /api/reminders/:id/enroll/:friendId` (API-only; not wired into the admin UI) accepts a
 * free-form `targetDate`. A bare `YYYY-MM-DD` is parsed as **UTC** midnight by both SQLite
 * `unixepoch()` and JS `new Date()` — 9h off from the intended JST midnight (this brand operates
 * in JST; jstNow() emits +09:00). We normalize at the server boundary so the stored value always
 * carries an explicit +09:00 offset and fires at the intended JST wall-clock time.
 *
 * SQL/JS already AGREE on the stored value (PR #127); this fixes the *semantics* (which instant).
 */
import { describe, it, expect, vi } from 'vitest';
import { normalizeReminderTargetDate, enrollFriendInReminder } from '@line-crm/db';

describe('normalizeReminderTargetDate', () => {
  it('bare YYYY-MM-DD → JST midnight (+09:00), NOT UTC midnight', () => {
    expect(normalizeReminderTargetDate('2026-03-01')).toBe('2026-03-01T00:00:00+09:00');
    // intended instant = 2026-02-28T15:00:00Z (JST midnight), not 2026-03-01T00:00:00Z
    expect(new Date(normalizeReminderTargetDate('2026-03-01')!).toISOString()).toBe(
      '2026-02-28T15:00:00.000Z',
    );
  });

  it('bare date と JST-offset 形式は同一 fire time に正規化される (regression)', () => {
    const fromBare = normalizeReminderTargetDate('2026-03-01');
    const fromOffset = normalizeReminderTargetDate('2026-03-01T00:00:00+09:00');
    expect(fromBare).toBe(fromOffset);
    expect(new Date(fromBare!).getTime()).toBe(new Date(fromOffset!).getTime());
  });

  it('naive datetime (offset 無し) は JST (+09:00) として扱う', () => {
    expect(normalizeReminderTargetDate('2026-03-01T10:30:00')).toBe('2026-03-01T10:30:00+09:00');
  });

  it('naive datetime で秒を省略しても秒を補完して +09:00 を付与する', () => {
    expect(normalizeReminderTargetDate('2026-03-01T10:30')).toBe('2026-03-01T10:30:00+09:00');
  });

  it('ミリ秒付き naive datetime も保持する', () => {
    expect(normalizeReminderTargetDate('2026-03-01T10:30:00.250')).toBe('2026-03-01T10:30:00.250+09:00');
  });

  it('明示 offset / Z はそのまま保持する', () => {
    expect(normalizeReminderTargetDate('2026-03-01T00:00:00+09:00')).toBe('2026-03-01T00:00:00+09:00');
    expect(normalizeReminderTargetDate('2026-02-28T15:00:00Z')).toBe('2026-02-28T15:00:00Z');
    expect(normalizeReminderTargetDate('2026-03-01T09:00:00+05:30')).toBe('2026-03-01T09:00:00+05:30');
  });

  it('前後の空白は trim する', () => {
    expect(normalizeReminderTargetDate('  2026-03-01  ')).toBe('2026-03-01T00:00:00+09:00');
  });

  it('不正な入力は null を返す', () => {
    expect(normalizeReminderTargetDate('')).toBeNull();
    expect(normalizeReminderTargetDate('   ')).toBeNull();
    expect(normalizeReminderTargetDate('not-a-date')).toBeNull();
    expect(normalizeReminderTargetDate('2026/03/01')).toBeNull();
    expect(normalizeReminderTargetDate('03-01-2026')).toBeNull();
    // 実在しない暦日 (JS Date は 02-30 → 03-02 へ silent roll-over するので明示拒否)
    expect(normalizeReminderTargetDate('2026-02-30')).toBeNull();
    expect(normalizeReminderTargetDate('2026-13-01')).toBeNull();
    // 範囲外の時刻成分: 25:00 は JS Date も NaN だが、 24:00 は翌日扱いで受理されてしまうため明示拒否
    expect(normalizeReminderTargetDate('2026-03-01T25:00:00')).toBeNull();
    expect(normalizeReminderTargetDate('2026-03-01T24:00:00')).toBeNull();
    expect(normalizeReminderTargetDate('2026-03-01T10:60:00')).toBeNull();
    expect(normalizeReminderTargetDate('2026-03-01T10:30:60')).toBeNull();
    // 範囲外 offset
    expect(normalizeReminderTargetDate('2026-03-01T10:00:00+25:00')).toBeNull();
    // offset の区切り無し (ISO だが本 API は ±HH:MM のみ許容)
    expect(normalizeReminderTargetDate('2026-03-01T10:00:00+0900')).toBeNull();
    // 非文字列 (unknown を受け、 内部で型ガード)
    expect(normalizeReminderTargetDate(null)).toBeNull();
    expect(normalizeReminderTargetDate(123)).toBeNull();
    expect(normalizeReminderTargetDate(undefined)).toBeNull();
  });
});

/** enrollFriendInReminder の INSERT bind を捕捉し、 SELECT で同じ target_date を返す mock db。 */
function makeEnrollDb() {
  const binds: unknown[][] = [];
  let storedTargetDate: unknown = null;
  const db = {
    prepare: vi.fn((_sql: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        binds.push(args);
        if (args.length === 6) storedTargetDate = args[3]; // INSERT bind の target_date を記録
        return {
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          first: vi.fn(async () => ({
            id: args[0],
            friend_id: 'f1',
            reminder_id: 'r1',
            target_date: storedTargetDate,
            status: 'active',
            created_at: '',
            updated_at: '',
          })),
        };
      }),
    })),
  } as unknown as D1Database;
  return { db, binds };
}

describe('enrollFriendInReminder normalizes target_date', () => {
  it('bare date を JST midnight に正規化して保存する', async () => {
    const { db, binds } = makeEnrollDb();
    const row = await enrollFriendInReminder(db, {
      friendId: 'f1',
      reminderId: 'r1',
      targetDate: '2026-03-01',
    });
    // INSERT bind = [id, friendId, reminderId, target_date, now, now]
    const insertBind = binds.find((b) => b.length === 6);
    expect(insertBind).toBeDefined();
    expect(insertBind![3]).toBe('2026-03-01T00:00:00+09:00');
    expect(row.target_date).toBe('2026-03-01T00:00:00+09:00');
  });

  it('明示 offset 付きはそのまま保存する (冪等)', async () => {
    const { db, binds } = makeEnrollDb();
    await enrollFriendInReminder(db, {
      friendId: 'f1',
      reminderId: 'r1',
      targetDate: '2026-03-01T09:00:00+09:00',
    });
    const insertBind = binds.find((b) => b.length === 6);
    expect(insertBind![3]).toBe('2026-03-01T09:00:00+09:00');
  });

  it('不正な targetDate は throw する (route は事前検証で 400 を返す)', async () => {
    const { db } = makeEnrollDb();
    await expect(
      enrollFriendInReminder(db, { friendId: 'f1', reminderId: 'r1', targetDate: 'bogus' }),
    ).rejects.toThrow(/targetDate/);
  });
});
