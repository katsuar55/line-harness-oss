/**
 * Tests for services/membership-promotion-cron (= Phase 4-δ、 2026-05-28)
 *
 * カバー範囲:
 *   - gating: 月初 1 日 09:00-09:04 JST のみ実行、 それ以外 skip
 *   - MEMBERSHIP_CRON_FORCE='true' で bypass
 *   - 全 members で promoteMemberIfEligible
 *   - 個別 error は count + continue
 *   - audit log best-effort
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const promoteMock = vi.fn();
const auditMock = vi.fn();

vi.mock('@line-crm/db', () => ({
  promoteMemberIfEligible: (...args: unknown[]) => promoteMock(...args),
}));

vi.mock('../services/audit-logger.js', () => ({
  auditSystem: (...args: unknown[]) => auditMock(...args),
}));

async function loadCron() {
  return await import('../services/membership-promotion-cron.js');
}

interface MemberRow {
  friend_id: string;
}

function makeDb(rows: MemberRow[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
      all: async () => ({ results: rows }),
    }),
  } as unknown as D1Database;
}

describe('processMembershipPromotionSanity', () => {
  beforeEach(() => {
    promoteMock.mockReset();
    auditMock.mockReset();
  });

  it('skips when not on gating window (= 2nd of month)', async () => {
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-1' }]) },
      { now: new Date('2026-06-02T00:00:00Z') }, // = JST 06-02 09:00、 day=2 で skip
    );
    expect(result.skippedDueToGating).toBe(true);
    expect(result.candidates).toBe(0);
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it('skips when on day 1 but wrong hour (= 10:00 JST)', async () => {
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([]) },
      { now: new Date('2026-06-01T01:00:00Z') }, // = JST 06-01 10:00、 hour=10 で skip
    );
    expect(result.skippedDueToGating).toBe(true);
  });

  it('runs when in gating window (= 09:00 JST on day 1)', async () => {
    promoteMock.mockResolvedValue({ promoted: false, fromTier: 'bronze', toTier: 'bronze' });
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-1' }, { friend_id: 'f-2' }]) },
      { now: new Date('2026-06-01T00:02:00Z') }, // = JST 06-01 09:02、 ok
    );
    expect(result.skippedDueToGating).toBe(false);
    expect(result.candidates).toBe(2);
    expect(result.promoted).toBe(0);
    expect(result.unchanged).toBe(2);
    expect(promoteMock).toHaveBeenCalledTimes(2);
  });

  it('counts promoted members', async () => {
    promoteMock
      .mockResolvedValueOnce({ promoted: true, fromTier: 'bronze', toTier: 'silver' })
      .mockResolvedValueOnce({ promoted: false, fromTier: 'bronze', toTier: 'bronze' });
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-1' }, { friend_id: 'f-2' }]) },
      { now: new Date('2026-06-01T00:00:00Z') },
    );
    expect(result.promoted).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.promotedFriendIds).toEqual(['f-1']);
  });

  it('individual error does not stop processing', async () => {
    promoteMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ promoted: true, fromTier: 'bronze', toTier: 'silver' });
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-err' }, { friend_id: 'f-2' }]) },
      { now: new Date('2026-06-01T00:00:00Z') },
    );
    expect(result.errors).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('MEMBERSHIP_CRON_FORCE bypasses gating', async () => {
    promoteMock.mockResolvedValue({ promoted: false, fromTier: 'bronze', toTier: 'bronze' });
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-1' }]), MEMBERSHIP_CRON_FORCE: 'true' },
      { now: new Date('2026-06-15T00:00:00Z') }, // = JST 06-15、 通常 skip
    );
    expect(result.skippedDueToGating).toBe(false);
    expect(result.candidates).toBe(1);
  });

  it('records audit log on completion', async () => {
    promoteMock.mockResolvedValue({ promoted: false, fromTier: 'bronze', toTier: 'bronze' });
    const { processMembershipPromotionSanity } = await loadCron();
    await processMembershipPromotionSanity(
      { DB: makeDb([{ friend_id: 'f-1' }]) },
      { now: new Date('2026-06-01T00:00:00Z') },
    );
    expect(auditMock).toHaveBeenCalledOnce();
    const auditArgs = auditMock.mock.calls[0];
    expect(auditArgs[1].action).toBe('membership.monthly_sanity_completed');
    expect(auditArgs[1].result).toBe('success');
    expect(auditArgs[1].metadata.candidates).toBe(1);
  });

  it('handles empty members table', async () => {
    const { processMembershipPromotionSanity } = await loadCron();
    const result = await processMembershipPromotionSanity(
      { DB: makeDb([]) },
      { now: new Date('2026-06-01T00:00:00Z') },
    );
    expect(result.candidates).toBe(0);
    expect(result.promoted).toBe(0);
    expect(promoteMock).not.toHaveBeenCalled();
  });
});
