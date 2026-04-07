/**
 * Tests for intake reminder service (Phase 3 Stage 3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getActiveIntakeReminders: vi.fn(async () => [
      { id: 'rem-1', friend_id: 'f-1', reminder_time: '08:00', reminder_type: 'morning_push', last_sent_at: null, snooze_until: null },
      { id: 'rem-2', friend_id: 'f-2', reminder_time: '07:30', reminder_type: 'morning_push', last_sent_at: null, snooze_until: null },
    ]),
    updateReminderLastSent: vi.fn(async () => undefined),
    getFriendById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'f-1') return { id: 'f-1', line_user_id: 'U_user1', is_following: 1 };
      if (id === 'f-2') return { id: 'f-2', line_user_id: 'U_user2', is_following: 0 }; // unfollowed
      return null;
    }),
    getIntakeStreak: vi.fn(async () => ({
      currentStreak: 5,
      longestStreak: 12,
      totalDays: 30,
    })),
    jstNow: vi.fn(() => '2026-04-07T08:05:00+09:00'),
    pickReminderMessage: vi.fn(async () => ({
      id: 'rm-m001',
      message: 'おはようございます！朝の1粒で今日も元気にスタート。',
      category: 'motivation',
    })),
    logReminderMessage: vi.fn(async () => undefined),
  };
});

import { processIntakeReminders } from '../services/intake-reminder.js';

describe('processIntakeReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends reminders to following friends and skips unfollowed', async () => {
    const mockLineClient = {
      pushMessage: vi.fn(async () => undefined),
    } as unknown as import('@line-crm/line-sdk').LineClient;

    const mockDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({})),
        })),
      })),
    } as unknown as D1Database;

    const result = await processIntakeReminders(mockDb, mockLineClient);

    expect(result.sent).toBe(1);    // f-1 (following)
    expect(result.skipped).toBe(1);  // f-2 (unfollowed)
    expect(result.errors).toBe(0);
    expect(mockLineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockLineClient.pushMessage).toHaveBeenCalledWith(
      'U_user1',
      expect.arrayContaining([
        expect.objectContaining({ type: 'flex', altText: expect.stringContaining('リマインド') }),
      ]),
    );
  });

  it('skips snoozed reminders', async () => {
    const { getActiveIntakeReminders } = await import('@line-crm/db');
    (getActiveIntakeReminders as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'rem-3', friend_id: 'f-1', reminder_time: '08:00', reminder_type: 'morning_push', last_sent_at: null, snooze_until: '2026-04-07T10:00:00+09:00' },
    ]);

    const mockLineClient = {
      pushMessage: vi.fn(async () => undefined),
    } as unknown as import('@line-crm/line-sdk').LineClient;

    const mockDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run: vi.fn(async () => ({})) })),
      })),
    } as unknown as D1Database;

    const result = await processIntakeReminders(mockDb, mockLineClient);

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
    expect(mockLineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('handles empty reminder list', async () => {
    const { getActiveIntakeReminders } = await import('@line-crm/db');
    (getActiveIntakeReminders as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const mockLineClient = {
      pushMessage: vi.fn(async () => undefined),
    } as unknown as import('@line-crm/line-sdk').LineClient;

    const mockDb = {} as unknown as D1Database;

    const result = await processIntakeReminders(mockDb, mockLineClient);

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('counts errors when pushMessage fails', async () => {
    const { getActiveIntakeReminders } = await import('@line-crm/db');
    (getActiveIntakeReminders as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'rem-1', friend_id: 'f-1', reminder_time: '08:00', reminder_type: 'morning_push', last_sent_at: null, snooze_until: null },
    ]);

    const mockLineClient = {
      pushMessage: vi.fn(async () => { throw new Error('API error'); }),
    } as unknown as import('@line-crm/line-sdk').LineClient;

    const mockDb = {} as unknown as D1Database;

    const result = await processIntakeReminders(mockDb, mockLineClient);

    expect(result.errors).toBe(1);
    expect(result.sent).toBe(0);
  });
});
