import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@line-crm/db', () => ({
  getIntakeStreak: vi.fn(),
  getHealthSummary: vi.fn(),
  jstNow: vi.fn(),
}));

vi.mock('./stealth.js', () => ({
  addJitter: vi.fn(() => 50),
  sleep: vi.fn(),
}));

import { processWeeklyReports } from '../services/weekly-report.js';
import { getIntakeStreak, getHealthSummary, jstNow } from '@line-crm/db';

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
  run: vi.fn(),
  first: vi.fn(),
} as unknown as D1Database;

const mockLineClient = {
  pushMessage: vi.fn().mockResolvedValue(undefined),
} as any;

describe('processWeeklyReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips on non-Monday', async () => {
    // Tuesday
    vi.mocked(jstNow).mockReturnValue('2026-04-07T10:00:00+09:00');
    // Override Date to make it Tuesday (day 2)
    const realDate = globalThis.Date;
    const mockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) super();
        else super(...(args as [any]));
      }
      getDay() { return 2; } // Tuesday
    };
    globalThis.Date = mockDate as any;

    const result = await processWeeklyReports(mockDb, mockLineClient);
    expect(result).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(mockLineClient.pushMessage).not.toHaveBeenCalled();

    globalThis.Date = realDate;
  });

  it('sends reports on Monday for friends with data', async () => {
    // Mock Monday
    vi.mocked(jstNow).mockReturnValue('2026-04-06T09:00:00+09:00');
    const realDate = globalThis.Date;
    const mockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) super();
        else super(...(args as [any]));
      }
      getDay() { return 1; } // Monday
    };
    globalThis.Date = mockDate as any;

    // Mock friends list
    (mockDb.prepare as any).mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          { id: 'f1', line_user_id: 'U001', display_name: 'テスト太郎' },
        ],
      }),
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    });

    vi.mocked(getIntakeStreak).mockResolvedValue({
      currentStreak: 5,
      longestStreak: 10,
      totalDays: 30,
    });

    vi.mocked(getHealthSummary).mockResolvedValue({
      totalLogs: 7,
      avgWeight: 55.3,
      goodDays: 4,
      normalDays: 2,
      badDays: 1,
      latestWeight: 55.0,
    });

    const result = await processWeeklyReports(mockDb, mockLineClient);
    expect(result.sent).toBe(1);
    expect(mockLineClient.pushMessage).toHaveBeenCalledTimes(1);

    const message = mockLineClient.pushMessage.mock.calls[0][1][0];
    expect(message.type).toBe('flex');
    expect(message.altText).toContain('テスト太郎');

    globalThis.Date = realDate;
  });

  it('skips friends with no data', async () => {
    vi.mocked(jstNow).mockReturnValue('2026-04-06T09:00:00+09:00');
    const realDate = globalThis.Date;
    const mockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) super();
        else super(...(args as [any]));
      }
      getDay() { return 1; }
    };
    globalThis.Date = mockDate as any;

    (mockDb.prepare as any).mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          { id: 'f1', line_user_id: 'U001', display_name: 'New User' },
        ],
      }),
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    });

    vi.mocked(getIntakeStreak).mockResolvedValue({
      currentStreak: 0,
      longestStreak: 0,
      totalDays: 0,
    });

    vi.mocked(getHealthSummary).mockResolvedValue({
      totalLogs: 0,
      avgWeight: null,
      goodDays: 0,
      normalDays: 0,
      badDays: 0,
      latestWeight: null,
    });

    const result = await processWeeklyReports(mockDb, mockLineClient);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);

    globalThis.Date = realDate;
  });

  it('handles push message errors gracefully', async () => {
    vi.mocked(jstNow).mockReturnValue('2026-04-06T09:00:00+09:00');
    const realDate = globalThis.Date;
    const mockDate = class extends realDate {
      constructor(...args: any[]) {
        if (args.length === 0) super();
        else super(...(args as [any]));
      }
      getDay() { return 1; }
    };
    globalThis.Date = mockDate as any;

    (mockDb.prepare as any).mockReturnValue({
      all: vi.fn().mockResolvedValue({
        results: [
          { id: 'f1', line_user_id: 'U001', display_name: 'Error User' },
        ],
      }),
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({}),
    });

    vi.mocked(getIntakeStreak).mockResolvedValue({
      currentStreak: 3,
      longestStreak: 5,
      totalDays: 10,
    });

    vi.mocked(getHealthSummary).mockResolvedValue({
      totalLogs: 0, avgWeight: null, goodDays: 0,
      normalDays: 0, badDays: 0, latestWeight: null,
    });

    mockLineClient.pushMessage.mockRejectedValueOnce(new Error('API Error'));

    const result = await processWeeklyReports(mockDb, mockLineClient);
    expect(result.errors).toBe(1);
    expect(result.sent).toBe(0);

    globalThis.Date = realDate;
  });
});
