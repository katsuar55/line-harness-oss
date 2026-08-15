/**
 * coupon-expiry-sweep (日次 JST 03:40) — gating + 失効確定 + stuck 復旧 + T2 活性化 (2026-08-13 R1)。
 * 失効確定は実 SQLite (schema.sql) で検証。活性化は referral-reward の orchestrator を mock。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/referral-reward.js', () => ({
  activateAndNotifyNextReferralCoupon: vi.fn(async () => ({ activated: true, pushed: true })),
}));
// ④ ランクコード deactivate (PR-D): Shopify 呼出は mock、DB 遷移は実 SQLite で検証
vi.mock('../services/shopify-discount-admin.js', () => ({
  deactivateDiscountCode: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));

import {
  processCouponExpirySweep,
  isCouponSweepWindow,
  type CouponSweepEnv,
} from '../services/coupon-expiry-sweep.js';
import { activateAndNotifyNextReferralCoupon } from '../services/referral-reward.js';
import { deactivateDiscountCode } from '../services/shopify-discount-admin.js';
import { enqueueReferralCoupon, findQueueRowByRewardId } from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend, insertReferralLedgerRow } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';
import type { LineClient } from '@line-crm/line-sdk';

const mockActivate = activateAndNotifyNextReferralCoupon as ReturnType<typeof vi.fn>;
const mockDeactivate = deactivateDiscountCode as ReturnType<typeof vi.fn>;

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

  it('④ superseded ランクコード: 生きた行は deactivate + マーク / 期限切れ・node無しはマークのみ (PR-D)', async () => {
    const seed = (id: string, code: string, nodeId: string | null, expiresAt: string | null) =>
      raw.prepare(
        `INSERT INTO loyalty_rank_discounts
           (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, superseded_at)
         VALUES (?, 'F1', 'silver', ?, ?, 4, 'superseded', '2026-07-01T00:00:00.000Z', ?, '2026-08-01T00:00:00.000Z')`,
      ).run(id, code, nodeId, expiresAt);
    seed('rd_live', 'NLR-S-LIVE', 'gid://d/1', '2026-09-30T00:00:00.000Z'); // 生きてる → API + マーク
    seed('rd_dead', 'NLR-S-DEAD', 'gid://d/2', '2026-08-01T00:00:00.000Z'); // 期限切れ → マークのみ
    seed('rd_null', 'NLR-S-NULL', null, '2026-09-30T00:00:00.000Z');        // node 無し → マークのみ
    // active 行は対象外であることも同時に固定
    raw.prepare(
      `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at)
       VALUES ('rd_act', 'F1', 'gold', 'NLR-G-ACT', 'gid://d/9', 6, 'active', '2026-08-10T00:00:00.000Z', '2026-09-30T00:00:00.000Z')`,
    ).run();

    const env = makeEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' });
    const r = await processCouponExpirySweep(env, { now: IN_WINDOW, lineClient: fakeLineClient });

    expect(r.rankDeactivated).toBe(3);
    expect(mockDeactivate).toHaveBeenCalledTimes(1); // API は生きた行の 1 回だけ
    expect(mockDeactivate.mock.calls[0][2]).toBe('gid://d/1');
    const marks = raw.prepare(
      `SELECT id, shopify_deactivated_at FROM loyalty_rank_discounts ORDER BY id`,
    ).all() as Array<{ id: string; shopify_deactivated_at: string | null }>;
    const byId = Object.fromEntries(marks.map((m) => [m.id, m.shopify_deactivated_at]));
    expect(byId.rd_live).not.toBeNull();
    expect(byId.rd_dead).not.toBeNull();
    expect(byId.rd_null).not.toBeNull();
    expect(byId.rd_act).toBeNull(); // active は触らない
  });

  it('④ deactivate 失敗 → マーカー NULL 温存 (次回 sweep が再試行) + errors/partial', async () => {
    raw.prepare(
      `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, superseded_at)
       VALUES ('rd_f', 'F1', 'silver', 'NLR-S-F', 'gid://d/1', 4, 'superseded', '2026-07-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    mockDeactivate.mockResolvedValueOnce({ ok: false, error: 'HTTP 500' });

    const env = makeEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' });
    const r = await processCouponExpirySweep(env, { now: IN_WINDOW, lineClient: fakeLineClient });

    expect(r.rankDeactivated).toBe(0);
    expect(r.errors).toBe(1);
    const row = raw.prepare(`SELECT shopify_deactivated_at FROM loyalty_rank_discounts WHERE id='rd_f'`).get() as { shopify_deactivated_at: string | null };
    expect(row.shopify_deactivated_at).toBeNull();
    const log = raw.prepare(`SELECT status FROM cron_run_logs ORDER BY rowid DESC LIMIT 1`).get() as { status: string };
    expect(log.status).toBe('partial');
  });

  it('④ Shopify creds 無し env → 走査ごと skip (API も マークも呼ばない)', async () => {
    raw.prepare(
      `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, superseded_at)
       VALUES ('rd_s', 'F1', 'silver', 'NLR-S-S', 'gid://d/1', 4, 'superseded', '2026-07-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    const r = await processCouponExpirySweep(makeEnv(), { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r.rankDeactivated).toBe(0);
    expect(mockDeactivate).not.toHaveBeenCalled();
    const row = raw.prepare(`SELECT shopify_deactivated_at FROM loyalty_rank_discounts WHERE id='rd_s'`).get() as { shopify_deactivated_at: string | null };
    expect(row.shopify_deactivated_at).toBeNull();
  });

  it('④ 冪等: マーク済み行は再実行で再走査されない (API 追撃なし)', async () => {
    raw.prepare(
      `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, superseded_at)
       VALUES ('rd_i', 'F1', 'silver', 'NLR-S-I', 'gid://d/1', 4, 'superseded', '2026-07-01T00:00:00.000Z', '2026-09-30T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    const env = makeEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' });
    const r1 = await processCouponExpirySweep(env, { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r1.rankDeactivated).toBe(1);
    const r2 = await processCouponExpirySweep(env, { now: IN_WINDOW, lineClient: fakeLineClient });
    expect(r2.rankDeactivated).toBe(0);
    expect(mockDeactivate).toHaveBeenCalledTimes(1); // 2 run 通算で 1 回だけ
  });

  it('④ rankDeactivationCap で 1 run の処理数を制限 (残りは次回)', async () => {
    for (const [id, code] of [['rd_1', 'NLR-S-1'], ['rd_2', 'NLR-S-2']]) {
      raw.prepare(
        `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, superseded_at)
         VALUES (?, 'F1', 'silver', ?, NULL, 4, 'superseded', '2026-07-01T00:00:00.000Z', NULL, '2026-08-01T00:00:00.000Z')`,
      ).run(id, code);
    }
    const env = makeEnv({ SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'i', SHOPIFY_CLIENT_SECRET: 's' });
    const r = await processCouponExpirySweep(env, { now: IN_WINDOW, lineClient: fakeLineClient, rankDeactivationCap: 1 });
    expect(r.rankDeactivated).toBe(1);
    const remaining = raw.prepare(
      `SELECT COUNT(*) AS n FROM loyalty_rank_discounts WHERE status='superseded' AND shopify_deactivated_at IS NULL`,
    ).get() as { n: number };
    expect(remaining.n).toBe(1);
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
