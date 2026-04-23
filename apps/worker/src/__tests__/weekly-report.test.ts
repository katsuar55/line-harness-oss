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

/**
 * helper: 友だち一覧 + messages_log dedup クエリを順番通りにモックする
 * weekly-report.ts は prepare() を複数回呼ぶため、呼び出し順に応じて結果を返す
 */
function buildMockDb(opts: {
  friends: Array<{ id: string; line_user_id: string; display_name: string | null }>;
  alreadySent: string[]; // 過去6日以内に送信済みの friend_id
}) {
  const bind = vi.fn().mockReturnThis();
  const run = vi.fn().mockResolvedValue({});

  // prepare() の呼び出し回数で結果を切り替える
  // 1回目: friends SELECT
  // 2回目: dedup messages_log SELECT
  // 3回目以降: INSERT messages_log (送信数分)
  let prepareCall = 0;
  const prepare = vi.fn().mockImplementation(() => {
    prepareCall++;
    if (prepareCall === 1) {
      return {
        all: vi.fn().mockResolvedValue({ results: opts.friends }),
        bind,
        run,
      };
    }
    if (prepareCall === 2) {
      return {
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: opts.alreadySent.map((id) => ({ friend_id: id })),
          }),
        }),
        run,
      };
    }
    // INSERT log
    return { bind, run, all: vi.fn() };
  });

  return { prepare, bind, run } as unknown as D1Database;
}

const mockLineClient = {
  pushMessage: vi.fn().mockResolvedValue(undefined),
} as any;

function mockJstMonday() {
  // JST 月曜 10:00 = 2026-04-20 月曜
  vi.mocked(jstNow).mockReturnValue('2026-04-20T10:00:00.000+09:00');
}

function mockJstTuesday() {
  // JST 火曜 10:00 = 2026-04-21 火曜
  vi.mocked(jstNow).mockReturnValue('2026-04-21T10:00:00.000+09:00');
}

describe('processWeeklyReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLineClient.pushMessage.mockResolvedValue(undefined);
  });

  it('skips on non-Monday (JST)', async () => {
    mockJstTuesday();
    const db = buildMockDb({ friends: [], alreadySent: [] });

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result).toEqual({ sent: 0, skipped: 0, errors: 0 });
    expect(mockLineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('handles JST Monday early morning correctly (UTC still Sunday)', async () => {
    // JST 月曜 00:30 = UTC 日曜 15:30。古い実装では getDay()=0 になりスキップされるバグ
    vi.mocked(jstNow).mockReturnValue('2026-04-20T00:30:00.000+09:00');
    const db = buildMockDb({
      friends: [{ id: 'f1', line_user_id: 'U001', display_name: 'テスト太郎' }],
      alreadySent: [],
    });
    vi.mocked(getIntakeStreak).mockResolvedValue({ currentStreak: 5, longestStreak: 10, totalDays: 30 });
    vi.mocked(getHealthSummary).mockResolvedValue({ totalLogs: 7, avgWeight: 55.3, goodDays: 4, normalDays: 2, badDays: 1, latestWeight: 55.0 });

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result.sent).toBe(1);
  });

  it('sends reports on Monday for friends with data', async () => {
    mockJstMonday();
    const db = buildMockDb({
      friends: [{ id: 'f1', line_user_id: 'U001', display_name: 'テスト太郎' }],
      alreadySent: [],
    });
    vi.mocked(getIntakeStreak).mockResolvedValue({ currentStreak: 5, longestStreak: 10, totalDays: 30 });
    vi.mocked(getHealthSummary).mockResolvedValue({ totalLogs: 7, avgWeight: 55.3, goodDays: 4, normalDays: 2, badDays: 1, latestWeight: 55.0 });

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result.sent).toBe(1);
    expect(mockLineClient.pushMessage).toHaveBeenCalledTimes(1);
    const message = mockLineClient.pushMessage.mock.calls[0][1][0];
    expect(message.type).toBe('flex');
    expect(message.altText).toContain('テスト太郎');
  });

  it('skips friends already sent in past 6 days (cron re-fire protection)', async () => {
    mockJstMonday();
    const db = buildMockDb({
      friends: [
        { id: 'f1', line_user_id: 'U001', display_name: '既送ユーザー' },
        { id: 'f2', line_user_id: 'U002', display_name: '未送ユーザー' },
      ],
      alreadySent: ['f1'],
    });
    vi.mocked(getIntakeStreak).mockResolvedValue({ currentStreak: 5, longestStreak: 10, totalDays: 30 });
    vi.mocked(getHealthSummary).mockResolvedValue({ totalLogs: 7, avgWeight: 55.3, goodDays: 4, normalDays: 2, badDays: 1, latestWeight: 55.0 });

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
    expect(mockLineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockLineClient.pushMessage.mock.calls[0][0]).toBe('U002');
  });

  it('skips friends with no data', async () => {
    mockJstMonday();
    const db = buildMockDb({
      friends: [{ id: 'f1', line_user_id: 'U001', display_name: 'New User' }],
      alreadySent: [],
    });
    vi.mocked(getIntakeStreak).mockResolvedValue({ currentStreak: 0, longestStreak: 0, totalDays: 0 });
    vi.mocked(getHealthSummary).mockResolvedValue({ totalLogs: 0, avgWeight: null, goodDays: 0, normalDays: 0, badDays: 0, latestWeight: null });

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('handles push message errors gracefully', async () => {
    mockJstMonday();
    const db = buildMockDb({
      friends: [{ id: 'f1', line_user_id: 'U001', display_name: 'Error User' }],
      alreadySent: [],
    });
    vi.mocked(getIntakeStreak).mockResolvedValue({ currentStreak: 3, longestStreak: 5, totalDays: 10 });
    vi.mocked(getHealthSummary).mockResolvedValue({ totalLogs: 0, avgWeight: null, goodDays: 0, normalDays: 0, badDays: 0, latestWeight: null });
    mockLineClient.pushMessage.mockRejectedValueOnce(new Error('API Error'));

    const result = await processWeeklyReports(db, mockLineClient);
    expect(result.errors).toBe(1);
    expect(result.sent).toBe(0);
  });
});
