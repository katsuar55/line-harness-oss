/**
 * Tests for event-bus processAutomations — per-row 堅牢性 (= 配信整合性 hardening, 2026-06-05)
 *
 * バグ: conditions/actions の JSON.parse が per-automation try/catch の外にあり、
 *   1 行の壊れた JSON が throw すると外側 catch に飛び、 同 event の **以降の全 automation が実行されない**。
 * 修正: parse + match + execute + log を per-automation try/catch で囲み、 壊れた行は failed log を残して skip、
 *   loop は継続する。
 *
 * processAutomations を直接 test (= fireEvent の dynamic import path は通らないので
 *   vi.mock('@line-crm/db') の dynamic import 干渉トラップは無関係)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getActiveAutomationsByEvent, createAutomationLog, addTagToFriend } = vi.hoisted(() => ({
  getActiveAutomationsByEvent: vi.fn(),
  createAutomationLog: vi.fn(async () => {}),
  addTagToFriend: vi.fn(async () => {}),
}));

vi.mock('@line-crm/db', () => ({
  getActiveOutgoingWebhooksByEvent: vi.fn(async () => []),
  applyScoring: vi.fn(async () => {}),
  getActiveAutomationsByEvent,
  createAutomationLog,
  getActiveNotificationRulesByEvent: vi.fn(async () => []),
  createNotification: vi.fn(async () => {}),
  addTagToFriend,
  removeTagFromFriend: vi.fn(async () => {}),
  enrollFriendInScenario: vi.fn(async () => {}),
  jstNow: () => '2026-06-05T00:00:00.000+09:00',
  getFriendScore: vi.fn(async () => 0),
}));

import { processAutomations } from '../services/event-bus.js';

const db = {} as D1Database;

beforeEach(() => {
  getActiveAutomationsByEvent.mockReset();
  createAutomationLog.mockReset();
  addTagToFriend.mockReset();
});

describe('processAutomations — per-row 堅牢性', () => {
  it('先頭 automation の actions JSON が壊れていても 後続 automation は実行される', async () => {
    getActiveAutomationsByEvent.mockResolvedValue([
      { id: 'bad', line_account_id: null, conditions: '{}', actions: 'NOT_JSON{' },
      {
        id: 'good',
        line_account_id: null,
        conditions: '{}',
        actions: JSON.stringify([{ type: 'add_tag', params: { tagId: 'vip' } }]),
      },
    ]);
    await processAutomations(db, 'friend_add', { friendId: 'f1' });
    // 後続 good の action が実行された (= loop が中断していない)
    expect(addTagToFriend).toHaveBeenCalledWith(db, 'f1', 'vip');
    expect(createAutomationLog).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ automationId: 'good', status: 'success' }),
    );
  });

  it('壊れた automation は failed log を残す (= 可観測性、 silent skip しない)', async () => {
    getActiveAutomationsByEvent.mockResolvedValue([
      { id: 'bad', line_account_id: null, conditions: '{}', actions: 'NOT_JSON{' },
    ]);
    await processAutomations(db, 'friend_add', { friendId: 'f1' });
    expect(createAutomationLog).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ automationId: 'bad', status: 'failed' }),
    );
  });

  it('conditions 不一致 → action も log も無し (= continue path、 try 内 continue が正しく loop 継続)', async () => {
    getActiveAutomationsByEvent.mockResolvedValue([
      {
        id: 'nomatch',
        line_account_id: null,
        conditions: JSON.stringify({ score_threshold: 100 }),
        actions: JSON.stringify([{ type: 'add_tag', params: { tagId: 'x' } }]),
      },
    ]);
    // currentScore 10 < 閾値 100 → matchConditions false → continue (= log も action も無し)
    await processAutomations(db, 'friend_add', { friendId: 'f1', eventData: { currentScore: 10 } });
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(createAutomationLog).not.toHaveBeenCalled();
  });

  it('正常系: conditions マッチ時に action 実行 + success log', async () => {
    getActiveAutomationsByEvent.mockResolvedValue([
      {
        id: 'a1',
        line_account_id: null,
        conditions: '{}',
        actions: JSON.stringify([{ type: 'add_tag', params: { tagId: 't1' } }]),
      },
    ]);
    await processAutomations(db, 'friend_add', { friendId: 'f1' });
    expect(addTagToFriend).toHaveBeenCalledWith(db, 'f1', 't1');
    expect(createAutomationLog).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ automationId: 'a1', status: 'success' }),
    );
  });
});
