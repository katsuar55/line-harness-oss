/**
 * line_referral_coupon_queue DB 層 (migration 079) — 実 SQLite 検証 (2026-08-13 R1)。
 *
 * queue の心臓部は claimNextReferralCouponForActivation の単文 UPDATE の WHERE:
 *   ① 最古 waiting 1 行 (FIFO) ② 生きた issued 台帳行なし ③ fresh activating 他になし。
 * fake で述語を再実装すると実装のガード欠落を検出できない (#252 mutation の教訓) ため、
 * packages/db/schema.sql をそのまま流した実 SQLite で検証する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  enqueueReferralCoupon,
  findQueueRowByRewardId,
  claimNextReferralCouponForActivation,
  markQueueRowActivated,
  revertQueueRowToWaiting,
  countWaitingReferralCoupons,
  listFriendsWithActivatableQueue,
  listStuckActivatingRows,
  markExpiredCoupons,
} from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend, insertReferralLedgerRow } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';

const NOW = '2026-08-13T12:00:00.000Z';
const PAST = '2026-08-13T10:00:00.000Z';   // NOW - 2h (> stale 閾値 60min)
const FRESH = '2026-08-13T11:30:00.000Z';  // NOW - 30min (< stale 閾値)

let raw: SqliteDatabase;
let db: D1Database;

beforeEach(() => {
  raw = createSchemaDb();
  db = asD1(raw);
  insertFriend(raw, 'F1');
  insertFriend(raw, 'F2');
});

async function enqueue(rewardId: string, friendId = 'F1', createdAt = '2026-08-10T00:00:00.000Z') {
  return enqueueReferralCoupon(db, {
    id: `q_${rewardId}`,
    friendId,
    rewardId,
    plannedCode: `NREF-R-${rewardId.toUpperCase()}`,
    discountValue: 500,
    createdAt,
  });
}

describe('enqueueReferralCoupon', () => {
  it('挿入成功 → inserted / 同 reward_id 再挿入 → duplicate (冪等)', async () => {
    expect(await enqueue('rw1')).toBe('inserted');
    expect(await enqueue('rw1')).toBe('duplicate');
    const row = await findQueueRowByRewardId(db, 'rw1');
    expect(row?.status).toBe('waiting');
    expect(row?.planned_code).toBe('NREF-R-RW1');
  });
});

describe('claimNextReferralCouponForActivation — 単文 UPDATE の述語 (実 SQLite)', () => {
  it('生きた issued 台帳行が無ければ最古 waiting を claim (FIFO)', async () => {
    await enqueue('rw_old', 'F1', '2026-08-01T00:00:00.000Z');
    await enqueue('rw_new', 'F1', '2026-08-05T00:00:00.000Z');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed?.reward_id).toBe('rw_old'); // FIFO
    expect(claimed?.status).toBe('activating');
    expect(claimed?.activation_started_at).toBe(NOW);
  });

  it('生きた issued 台帳行があると claim できない (= 1 枚不変条件)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_live', code: 'NREF-R-LIVE',
      expiresAt: '2026-09-30T00:00:00.000Z',
    });
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed).toBeNull();
  });

  it('issued でも redeemed 済みなら塞がない (T1: 使用 → 次を活性化)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_used', code: 'NREF-R-USED',
      status: 'redeemed', redeemedAt: NOW, expiresAt: '2026-09-30T00:00:00.000Z',
    });
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed?.reward_id).toBe('rw1');
  });

  it("防御状態: status='issued' なのに redeemed_at が立っている行も塞がない (redeemed_at IS NULL 述語の意図固定)", async () => {
    // redeemCouponByCode は status と redeemed_at を同一 UPDATE で立てるため通常この状態は
    // 発生しないが、述語は「使用の事実 (redeemed_at) > 状態機械 (status)」の防御として置いている。
    // この意図を実行で固定する (mutation M5 の kill 根拠)。
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_odd', code: 'NREF-R-ODD',
      status: 'issued', redeemedAt: NOW, expiresAt: '2026-09-30T00:00:00.000Z',
    });
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed?.reward_id).toBe('rw1');
  });

  it('issued でも期限切れなら塞がない (T2/T3: sweep 前の read 時判定で自己修復)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_exp', code: 'NREF-R-EXP',
      expiresAt: '2026-08-01T00:00:00.000Z', // < NOW、status はまだ 'issued' (sweep 未走)
    });
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed?.reward_id).toBe('rw1');
  });

  it('fresh な activating が居ると claim できない (= 二重活性化防止)、stale なら claim できる', async () => {
    await enqueue('rw1', 'F1', '2026-08-01T00:00:00.000Z');
    await enqueue('rw2', 'F1', '2026-08-02T00:00:00.000Z');

    // rw1 を fresh activating に
    raw.prepare(
      `UPDATE line_referral_coupon_queue SET status='activating', activation_started_at=? WHERE reward_id='rw1'`,
    ).run(FRESH);
    expect(await claimNextReferralCouponForActivation(db, 'F1', NOW)).toBeNull();

    // stale activating (crash 相当) なら他の行を claim できる
    raw.prepare(
      `UPDATE line_referral_coupon_queue SET activation_started_at=? WHERE reward_id='rw1'`,
    ).run(PAST);
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(claimed?.reward_id).toBe('rw2');
  });

  it('連続 claim: 1 回目勝ち → 2 回目は fresh activating に阻まれ null (並行の直列化)', async () => {
    await enqueue('rw1');
    await enqueue('rw2', 'F1', '2026-08-11T00:00:00.000Z');
    const first = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(first?.reward_id).toBe('rw1');
    const second = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(second).toBeNull();
  });

  it('friend 単位で独立 (F1 の live coupon は F2 の claim を阻まない)', async () => {
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F1', rewardId: 'rw_live', code: 'NREF-R-LIVE',
      expiresAt: '2026-09-30T00:00:00.000Z',
    });
    await enqueue('rw_f2', 'F2');
    const claimed = await claimNextReferralCouponForActivation(db, 'F2', NOW);
    expect(claimed?.reward_id).toBe('rw_f2');
  });
});

describe('遷移 (markActivated / revertToWaiting)', () => {
  it('activating → activated (activated_coupon_id 記録)、waiting からは遷移しない', async () => {
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(await markQueueRowActivated(db, claimed!.id, NOW, 'coupon-row-id')).toBe(true);
    const row = await findQueueRowByRewardId(db, 'rw1');
    expect(row?.status).toBe('activated');
    expect(row?.activated_coupon_id).toBe('coupon-row-id');
    // 冪等: 再度は changes 0
    expect(await markQueueRowActivated(db, claimed!.id, NOW, 'x')).toBe(false);
  });

  it('activating → waiting (補償)。activation_started_at はクリアされ再 claim 可能', async () => {
    await enqueue('rw1');
    const claimed = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(await revertQueueRowToWaiting(db, claimed!.id, 'shopify failed')).toBe(true);
    const row = await findQueueRowByRewardId(db, 'rw1');
    expect(row?.status).toBe('waiting');
    expect(row?.activation_started_at).toBeNull();
    // 再 claim できる (fresh activating が消えている)
    const again = await claimNextReferralCouponForActivation(db, 'F1', NOW);
    expect(again?.reward_id).toBe('rw1');
  });
});

describe('走査系', () => {
  it('countWaitingReferralCoupons は waiting のみ数える', async () => {
    await enqueue('rw1');
    await enqueue('rw2', 'F1', '2026-08-11T00:00:00.000Z');
    await claimNextReferralCouponForActivation(db, 'F1', NOW); // rw1 → activating
    expect(await countWaitingReferralCoupons(db, 'F1')).toBe(1);
  });

  it('listFriendsWithActivatableQueue は「waiting あり + 生きた coupon なし」の friend のみ', async () => {
    await enqueue('rw1', 'F1');
    await enqueue('rw2', 'F2');
    insertReferralLedgerRow(raw, {
      id: 'c1', friendId: 'F2', rewardId: 'rw_live', code: 'NREF-R-LIVE',
      expiresAt: '2026-09-30T00:00:00.000Z',
    });
    const list = await listFriendsWithActivatableQueue(db, NOW);
    expect(list.map((x) => x.friend_id)).toEqual(['F1']);
  });

  it('listStuckActivatingRows は stale activating のみ返す', async () => {
    await enqueue('rw1');
    await enqueue('rw2', 'F2');
    raw.prepare(`UPDATE line_referral_coupon_queue SET status='activating', activation_started_at=? WHERE reward_id='rw1'`).run(PAST);
    raw.prepare(`UPDATE line_referral_coupon_queue SET status='activating', activation_started_at=? WHERE reward_id='rw2'`).run(FRESH);
    const stuck = await listStuckActivatingRows(db, NOW);
    expect(stuck.map((x) => x.reward_id)).toEqual(['rw1']);
  });
});

describe('markExpiredCoupons (sweep ①) — 実 SQLite', () => {
  it("期限切れ issued → expired。redeemed は上書きしない (stats 破壊防止)、未来の issued は残す", async () => {
    insertReferralLedgerRow(raw, { id: 'c1', friendId: 'F1', rewardId: 'r1', code: 'A', expiresAt: PAST });
    insertReferralLedgerRow(raw, {
      id: 'c2', friendId: 'F1', rewardId: 'r2', code: 'B',
      status: 'redeemed', redeemedAt: PAST, expiresAt: PAST,
    });
    insertReferralLedgerRow(raw, { id: 'c3', friendId: 'F2', rewardId: 'r3', code: 'C', expiresAt: '2026-12-31T00:00:00.000Z' });

    const changed = await markExpiredCoupons(db, 'referral', NOW);
    expect(changed).toBe(1);
    const statuses = raw.prepare(`SELECT id, status FROM line_referral_coupons ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(statuses).toEqual([
      { id: 'c1', status: 'expired' },
      { id: 'c2', status: 'redeemed' },
      { id: 'c3', status: 'issued' },
    ]);
  });
});
