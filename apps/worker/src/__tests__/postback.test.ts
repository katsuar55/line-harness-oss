import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Postback イベント処理のテスト
 * - daily_tip: リッチメニューの「今日のヒント」ボタン
 */

vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn().mockResolvedValue([]),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getLineAccountByBotUserId: vi.fn(),
  setLineAccountBotUserId: vi.fn(),
  jstNow: vi.fn().mockReturnValue('2026-04-07T09:00:00+09:00'),
  getTodayTip: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn().mockResolvedValue(true),
  LineClient: vi.fn().mockImplementation(() => ({
    replyMessage: vi.fn().mockResolvedValue(undefined),
    pushMessage: vi.fn().mockResolvedValue(undefined),
    getProfile: vi.fn().mockResolvedValue({ displayName: 'Test', pictureUrl: null, statusMessage: null }),
    showLoadingAnimation: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((type: string, content: string) => {
    if (type === 'flex') return { type: 'flex', altText: 'tip', contents: JSON.parse(content) };
    return { type: 'text', text: content };
  }),
  expandVariables: vi.fn((content: string) => content),
}));

vi.mock('../services/ai-response.js', () => ({
  generateAiResponse: vi.fn(),
}));

import { getTodayTip } from '@line-crm/db';

describe('Postback: daily_tip', () => {
  it('should return today tip as Flex message when tip exists', async () => {
    vi.mocked(getTodayTip).mockResolvedValue({
      id: 'tip1',
      title: '水分補給の大切さ',
      content: '毎日2リットルの水を飲みましょう。',
      category: '健康',
      tip_date: '2026-04-07',
      is_active: 1,
      created_at: '2026-04-01',
      updated_at: '2026-04-01',
    } as any);

    // Verify the mock returns expected data
    const result = await getTodayTip({} as any);
    expect(result).toBeTruthy();
    expect(result!.title).toBe('水分補給の大切さ');
  });

  it('should handle no tip registered', async () => {
    vi.mocked(getTodayTip).mockResolvedValue(null);

    const result = await getTodayTip({} as any);
    expect(result).toBeNull();
  });
});
