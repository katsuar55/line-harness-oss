/**
 * Tests for services/webhook-delivery-cleanup (= webhook_deliveries TTL prune cron、 2026-06-26)
 *
 * 窓 gating / cutoff 計算 / fail-safe / self-record を検証 (= account-link-cleanup.test.ts と同パターン)。
 * 実 DELETE SQL は webhook-deliveries-db.test.ts でカバーするため、 ここでは @line-crm/db を mock する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockHeartbeats: { jobName: string; status: string; metrics: unknown }[] = [];
let mockHeartbeatShouldFail = false;
const pruneCalls: { cutoffIso: string }[] = [];
let pruneChangesToReturn = 0;
let pruneShouldThrow = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(
    async (_db: unknown, input: { jobName: string; status: string; metrics?: unknown }) => {
      if (mockHeartbeatShouldFail) throw new Error('simulated insert failure');
      mockHeartbeats.push({ jobName: input.jobName, status: input.status, metrics: input.metrics });
    },
  ),
  pruneWebhookDeliveries: vi.fn(async (_db: unknown, cutoffIso: string) => {
    pruneCalls.push({ cutoffIso });
    if (pruneShouldThrow) throw new Error('D1 down (table missing?)');
    return pruneChangesToReturn;
  }),
}));

const fakeDb = {} as unknown as D1Database;

beforeEach(() => {
  mockHeartbeats.length = 0;
  mockHeartbeatShouldFail = false;
  pruneCalls.length = 0;
  pruneChangesToReturn = 0;
  pruneShouldThrow = false;
});

describe('isWebhookDeliveryCleanupWindow', () => {
  it('JST 03:20 ジャスト → true', async () => {
    const { __test__ } = await import('../services/webhook-delivery-cleanup.js');
    // JST 03:20 = UTC 18:20 (前日)
    expect(__test__.isWebhookDeliveryCleanupWindow(new Date('2026-04-30T18:20:00Z'))).toBe(true);
  });

  it('JST 03:24 → true (5 分窓内)', async () => {
    const { __test__ } = await import('../services/webhook-delivery-cleanup.js');
    expect(__test__.isWebhookDeliveryCleanupWindow(new Date('2026-04-30T18:24:00Z'))).toBe(true);
  });

  it('JST 03:25 → false (窓外)', async () => {
    const { __test__ } = await import('../services/webhook-delivery-cleanup.js');
    expect(__test__.isWebhookDeliveryCleanupWindow(new Date('2026-04-30T18:25:00Z'))).toBe(false);
  });

  it('JST 03:10 → false (account-link-cleanup の窓、 本 job 窓外で非衝突)', async () => {
    const { __test__ } = await import('../services/webhook-delivery-cleanup.js');
    expect(__test__.isWebhookDeliveryCleanupWindow(new Date('2026-04-30T18:10:00Z'))).toBe(false);
  });
});

describe('processWebhookDeliveryCleanup', () => {
  it('窓外 → triggered=false, prune 呼ばれない', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    const result = await processWebhookDeliveryCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T05:00:00+09:00') }, // JST 05:00
    );
    expect(result).toEqual({ triggered: false, deletedRows: 0 });
    expect(pruneCalls).toHaveLength(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('窓内 → prune + heartbeat (cutoff = 72h 前)', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    pruneChangesToReturn = 42;
    const now = new Date('2026-05-01T03:21:00+09:00'); // JST 03:21
    const result = await processWebhookDeliveryCleanup({ DB: fakeDb }, { now });

    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(42);
    expect(pruneCalls).toHaveLength(1);

    const cutoff = new Date(pruneCalls[0]!.cutoffIso);
    const expectedCutoff = new Date(now.getTime() - 72 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);

    expect(mockHeartbeats).toHaveLength(1);
    expect(mockHeartbeats[0]).toMatchObject({
      jobName: 'webhook-delivery-cleanup',
      status: 'success',
      metrics: { deletedRows: 42, retentionHours: 72 },
    });
  });

  it('FORCE=true で窓外でも triggered=true', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    pruneChangesToReturn = 3;
    const result = await processWebhookDeliveryCleanup(
      { DB: fakeDb, WEBHOOK_DELIVERY_CLEANUP_FORCE: 'true' },
      { now: new Date('2026-05-01T15:00:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(3);
    expect(pruneCalls).toHaveLength(1);
  });

  it('retentionHours=12 で cutoff が 12h 前', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    const now = new Date('2026-05-01T03:20:00+09:00');
    await processWebhookDeliveryCleanup({ DB: fakeDb }, { now, retentionHours: 12 });
    const cutoff = new Date(pruneCalls[0]!.cutoffIso);
    const expectedCutoff = new Date(now.getTime() - 12 * 3600 * 1000);
    expect(Math.abs(cutoff.getTime() - expectedCutoff.getTime())).toBeLessThan(1000);
  });

  it('prune 失敗 (= migration 066 未適用想定) → deletedRows=0 + 例外を投げない + heartbeat なし', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    pruneShouldThrow = true;
    const result = await processWebhookDeliveryCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:20:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(0);
    expect(mockHeartbeats).toHaveLength(0);
  });

  it('heartbeat insert 失敗でも例外を投げない (fail-safe)', async () => {
    const { processWebhookDeliveryCleanup } = await import('../services/webhook-delivery-cleanup.js');
    mockHeartbeatShouldFail = true;
    pruneChangesToReturn = 5;
    const result = await processWebhookDeliveryCleanup(
      { DB: fakeDb },
      { now: new Date('2026-05-01T03:20:00+09:00') },
    );
    expect(result.triggered).toBe(true);
    expect(result.deletedRows).toBe(5);
  });
});
