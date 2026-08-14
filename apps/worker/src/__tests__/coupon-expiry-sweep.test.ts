/**
 * coupon-expiry-sweep (日次 JST 03:40) — gating + 失効確定 + stuck 復旧 + T2 活性化 (2026-08-13 R1)。
 * 失効確定は実 SQLite (schema.sql) で検証。活性化は referral-reward の orchestrator を mock。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/referral-reward.js', () => ({
  activateAndNotifyNextReferralCoupon: vi.fn(async () => ({ activated: true, pushed: true })),
}));

import {
  processCouponExpirySweep,
  isCouponSweepWindow,
  type CouponSweepEnv,
} from '../services/coupon-expiry-sweep.js';
import { activateAndNotifyNextReferralCoupon } from '../services/referral-reward.js';
import { enqueueReferralCoupon, findQueueRowByRewardId } from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend, insertReferralLedgerRow } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';
import type { LineClient } from '@line-crm/line-sdk';

const mockActivate = activateAndNotifyNextReferralCoupon as ReturnType<typeof vi.fn>;

// JST 03:42 = UTC 前日 18:42
const IN_WINDOW = new Date('2026-08-12T18:42:00.000Z');
const OUT_WINDOW = new Date('2026-08-12T21:00:00.000Z'); // JST 06:00

let raw: SqliteDatabase;
let db: D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  raw = createSchemaDb();
  db = asD1(raw);
  insertFriend(raw, 'F1');
});

function makeEnv(overrides: Partial<CouponSweepEnv> = {}): CouponSweepEnv {
  return {
    DB: db,
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    COUPON_SWEEP_ENABLED: 'true',
    REFERRAL_REWARD_ENABLED: 'true',
    ...overrides,
  } as CouponSweepEnv;
}

const fakeLineClient = {} as unknown as LineClient;

describe('gating', () => {
  it('COUPON_SWEEP_ENABLED off → triggered=false (完全 dormant)', async () => {
    const r = await processCouponExpirySweep(makeEnv({ COUPON_SWEEP_ENABLED: undefined }), { now: IN_WINDOW });
    expect(r.triggered).toBe(false);
  });

  it('窓外 → triggered=false / COUPON_SWEEP_FORCE で bypass', async () => {
    const r1 = await processCouponExpirySweep(makeEnv(), { now: OUT_WINDOW });
    expect(r1.triggered).toBe(false);
    const r2 = await processCouponExpirySweep(makeEnv({ COUPON_SWEEP_FORCE: 'true' }), { now: OUT_WINDOW, lineClient: fakeLineClient });
    expect(r2.triggered).toBe(true);
  });

  it('isCouponSweepWindow: JST 03:40-03:44 のみ true', () => {
    expect(isCouponSweepWindow(new Date('2026-08-12T18:40:00.000Z'))).toBe(true);  // JST 03:40
    expect(isCouponSweepWindow(new Date('2026-08-12T18:44:59.000Z'))).toBe(true);  // JST 03:44
    expect(isCouponSweepWindow(new Date('2026-08-12T18:45:00.000Z'))).toBe(false); // JST 03:45
    expect(isCouponSweepWindow(new Date('2026-08-12T18:39:59.000Z'))).toBe(false); // JST 03:39
  });
});

describe('失効確定 + stuck 復旧 + T2 (実 SQLite)', () => {
  it('期限切れ issued を expired 化し、stuck activating を waiting へ戻し、T2 候補を活性化する', async () => {
    // 失効対象 (referral 台帳)
    insertReferralLedgerRow(raw, {
      id: 'c_exp', friendId: 'F1', rewardId: 'r_exp', code: 'NREF-R-EXP',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    // stuck activating (2h 前) + waiting 1 行
    await enqueueReferralCoupon(db, {
      id: 'q_stuck', friendId: 'F1', rewardId: 'rw_stuck', plannedCode: 'NREF-R-S',
      discountValue: 500, createdAt: '2026-08-01T00:00:00.000Z',
    });
    raw.prepare(
      `UPDATE line_referral_coupon_queue SET status='activating', activation_started_at='2026-08-12T16:00:00.000Z' WHERE reward_id='rw_stuck'`,
    ).run();

    const r = await processCouponExpirySweep(makeEnv(), { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r.triggered).toBe(true);
    expect(r.expired.referral).toBe(1);
    expect(r.stuckReverted).toBe(1);
    // stuck が waiting に戻った後、その friend は T2 候補になり活性化が呼ばれる
    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(mockActivate.mock.calls[0][3]).toMatchObject({ friendId: 'F1' });
    expect(r.activated).toBe(1);
    expect(r.pushed).toBe(1);

    const q = await findQueueRowByRewardId(db, 'rw_stuck');
    expect(q?.status).toBe('waiting'); // mock 活性化なので DB 上は waiting のまま (revert の証跡)

    // cron_run_logs self-record
    const log = raw.prepare(`SELECT job_name, status FROM cron_run_logs ORDER BY rowid DESC LIMIT 1`).get() as { job_name: string; status: string };
    expect(log.job_name).toBe('coupon-expiry-sweep');
    expect(log.status).toBe('success');
  });

  it('生きた coupon を持つ friend は T2 の対象外', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c_live', friendId: 'F1', rewardId: 'r_live', code: 'NREF-R-LIVE',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    await enqueueReferralCoupon(db, {
      id: 'q_w', friendId: 'F1', rewardId: 'rw_w', plannedCode: 'NREF-R-W',
      discountValue: 500, createdAt: '2026-08-01T00:00:00.000Z',
    });
    const r = await processCouponExpirySweep(makeEnv(), { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r.activated).toBe(0);
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('活性化の個別失敗は errors に数え、他 friend を止めない (status=partial)', async () => {
    insertFriend(raw, 'F2');
    await enqueueReferralCoupon(db, {
      id: 'q1', friendId: 'F1', rewardId: 'rw1', plannedCode: 'A', discountValue: 500,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await enqueueReferralCoupon(db, {
      id: 'q2', friendId: 'F2', rewardId: 'rw2', plannedCode: 'B', discountValue: 500,
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    mockActivate
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ activated: true, pushed: false });

    const r = await processCouponExpirySweep(makeEnv(), { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r.errors).toBe(1);
    expect(r.activated).toBe(1);
    const log = raw.prepare(`SELECT status FROM cron_run_logs ORDER BY rowid DESC LIMIT 1`).get() as { status: string };
    expect(log.status).toBe('partial');
  });
});
