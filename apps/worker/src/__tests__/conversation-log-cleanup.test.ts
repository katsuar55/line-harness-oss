/**
 * Tests for services/conversation-log-cleanup (= PII 2年 retention prune cron、 2026-06-28、 D6)
 *
 * 窓 gating / retentionMonths / fail-safe / self-record を検証。 実 DELETE SQL は
 * log-retention-db.test.ts でカバーするため、 ここでは @line-crm/db を mock する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHeartbeats: { jobName: string; status: string; metrics: unknown }[] = [];
let mockHeartbeatShouldFail = false;
const pruneCalls: { fn: string; months: number }[] = [];
let messagesDeleted = 0;
let conversationsDeleted = 0;
let pruneShouldThrow = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(
    async (_db: unknown, input: { jobName: string; status: string; metrics?: unknown }) => {
      if (mockHeartbeatShouldFail) throw new Error('simulated insert failure');
      mockHeartbeats.push({ jobName: input.jobName, status: input.status, metrics: input.metrics });
    },
  ),
  pruneOldMessagesLog: vi.fn(async (_db: unknown, months: number) => {
    pruneCalls.push({ fn: 'messages', months });
    if (pruneShouldThrow) throw new Error('D1 down');
    return messagesDeleted;
  }),
  pruneOldConversationLogs: vi.fn(async (_db: unknown, months: number) => {
    pruneCalls.push({ fn: 'conversations', months });
    if (pruneShouldThrow) throw new Error('D1 down');
    return conversationsDeleted;
  }),
}));

const fakeDb = {} as unknown as D1Database;

beforeEach(() => {
  mockHeartbeats.length = 0;
  mockHeartbeatShouldFail = false;
  pruneCalls.length = 0;
  messagesDeleted = 0;
  conversationsDeleted = 0;
  pruneShouldThrow = false;
});

describe('isConversationLogCleanupWindow', () => {
  it('JST 03:30 → true', async () => {
    const { __test__ } = await import('../services/conversation-log-cleanup.js');
    expect(__test__.isConversationLogCleanupWindow(new Date('2026-04-30T18:30:00Z'))).toBe(true);
  });
  it('JST 03:34 → true (窓内)', async () => {
    const { __test__ } = await import('../services/conversation-log-cleanup.js');
    expect(__test__.isConversationLogCleanupWindow(new Date('2026-04-30T18:34:00Z'))).toBe(true);
  });
  it('JST 03:35 → false (窓外)', async () => {
    const { __test__ } = await import('../services/conversation-log-cleanup.js');
    expect(__test__.isConversationLogCleanupWindow(new Date('2026-04-30T18:35:00Z'))).toBe(false);
  });
  it('JST 03:20 → false (webhook-delivery-cleanup の窓、 非衝突)', async () => {
    const { __test__ } = await import('../services/conversation-log-cleanup.js');
    expect(__test__.isConversationLogCleanupWindow(new Date('2026-04-30T18:20:00Z'))).toBe(false);
  });
});

describe('processConversationLogCleanup', () => {
  it('窓外 → triggered=false, prune 呼ばれない', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    const result = await processConversationLogCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T05:00:00+09:00') },
    );
    expect(result).toEqual({ triggered: false, deletedMessages: 0, deletedConversations: 0 });
    expect(pruneCalls).toHaveLength(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('窓内 → 両テーブル prune (default 24ヶ月) + heartbeat', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    messagesDeleted = 7;
    conversationsDeleted = 4;
    const result = await processConversationLogCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:31:00+09:00') },
    );
    expect(result).toEqual({ triggered: true, deletedMessages: 7, deletedConversations: 4 });
    expect(pruneCalls).toEqual([
      { fn: 'messages', months: 24 },
      { fn: 'conversations', months: 24 },
    ]);
    expect(mockHeartbeats).toHaveLength(1);
    expect(mockHeartbeats[0]).toMatchObject({
      jobName: 'conversation-log-cleanup',
      status: 'success',
      metrics: { deletedMessages: 7, deletedConversations: 4, retentionMonths: 24 },
    });
  });

  it('FORCE=true で窓外でも triggered=true', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    const result = await processConversationLogCleanup(
      { DB: fakeDb, CONVERSATION_LOG_CLEANUP_FORCE: 'true' },
      { now: new Date('2026-05-01T15:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(pruneCalls).toHaveLength(2);
  });

  it('retentionMonths=12 を prune に渡す', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    await processConversationLogCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:30:00+09:00'), retentionMonths: 12 },
    );
    expect(pruneCalls).toEqual([
      { fn: 'messages', months: 12 },
      { fn: 'conversations', months: 12 },
    ]);
  });

  it('prune 失敗 → 例外を投げない + heartbeat なし', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    pruneShouldThrow = true;
    const result = await processConversationLogCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:30:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('heartbeat insert 失敗でも例外を投げない (fail-safe)', async () => {
    const { processConversationLogCleanup } = await import('../services/conversation-log-cleanup.js');
    mockHeartbeatShouldFail = true;
    messagesDeleted = 1;
    const result = await processConversationLogCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:30:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedMessages).toBe(1);
  });
});
