/**
 * クーポン期限 sweep + 紹介 queue の T2 活性化 (2026-08-13, 順次活性化 R1 の自己修復層)
 *
 * 役割 (日次 JST 03:40-03:44、cron 5 分毎の 1 tick に載る):
 *   ① 3 クーポン台帳 (welcome / 紹介 / 連携) の期限切れを status='expired' に確定する。
 *      従来は誰も 'expired' を書かず read 時の expires_at 判定だけだった。表示は困らないが、
 *      紹介 queue の「生きた 1 枚が消えた → 次を活性化」の T2 判定と stats の正確性に必要。
 *   ② stuck な activating 行 (>60min = Shopify create 中の crash 等) を waiting へ戻す。
 *      次の活性化は planned_code で再 create し、code 重複エラーは「前回成功済み」として回収される。
 *   ③ 待機 queue を持ち生きた紹介クーポンが無い friend へ、次の 1 枚を活性化 + LINE push。
 *      (T1 = webhook 検知の取りこぼし・失効による解放の両方をここで救済する)
 *
 * gate: COUPON_SWEEP_ENABLED='true' (既定 off)。COUPON_SWEEP_FORCE='true' で時刻 gating bypass。
 *   ⚠️ ②③ の活性化は REFERRAL_REWARD_ENABLED も要求する (Shopify 書込ガードは issuer 層が持つ)。
 *   sweep gate が未開放でも queue がデッドロックしないよう、T2 相当の活性化は
 *   T3 (ポータル閲覧 pull) にも内蔵されている (routes/liff-portal.ts)。
 *
 * 設計方針 (= webhook-delivery-cleanup.ts と同パターン):
 *   - JST 03:40-03:44 窓 (03:00 cron-cleanup / 03:10 account-link / 03:20 webhook-delivery /
 *     03:30 conversation-log と stagger)。
 *   - fail-safe: 各台帳・各 friend の失敗は隔離し、cron 全体を止めない。
 *   - self-record: cron_run_logs (cron-monitor の silent 監視対象)。
 *
 * 関連: packages/db/src/coupon-redemption.ts (markExpiredCoupons)、
 *       packages/db/src/referral-coupon-queue.ts (T2 候補列挙 / stuck 検出)、
 *       services/referral-reward.ts (activateAndNotifyNextReferralCoupon)
 */

import {
  insertCronRunLog,
  markExpiredCoupons,
  listFriendsWithActivatableQueue,
  listStuckActivatingRows,
  revertQueueRowToWaiting,
  COUPON_LEDGERS,
  type CouponLedger,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import {
  activateAndNotifyNextReferralCoupon,
  type ReferralRewardEnv,
} from './referral-reward.js';

export interface CouponSweepEnv extends ReferralRewardEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** 'true' で sweep 有効化 (既定 off = 完全 dormant) */
  COUPON_SWEEP_ENABLED?: string;
  /** 'true' で時刻 gating bypass (テスト/手動) */
  COUPON_SWEEP_FORCE?: string;
}

export interface CouponSweepOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** 1 run で活性化する friend 数の上限 (Shopify write 暴発防止) */
  activationCap?: number;
  /** test 用 LineClient 注入 */
  lineClient?: LineClient;
}

export interface CouponSweepResult {
  triggered: boolean;
  /** 台帳別の失効確定行数 */
  expired: Record<CouponLedger, number>;
  /** waiting へ戻した stuck activating 行数 */
  stuckReverted: number;
  /** T2 で活性化した枚数 */
  activated: number;
  /** 活性化時の LINE push 成功数 */
  pushed: number;
  /** 個別失敗の数 (全体は止めない) */
  errors: number;
}

export const COUPON_SWEEP_JOB_NAME = 'coupon-expiry-sweep';
const TRIGGER_HOUR = 3;
const TRIGGER_MINUTE_FROM = 40;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 45;
const DEFAULT_ACTIVATION_CAP = 20;

export function isCouponSweepWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return (
    jst.getUTCHours() === TRIGGER_HOUR &&
    jst.getUTCMinutes() >= TRIGGER_MINUTE_FROM &&
    jst.getUTCMinutes() < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

export async function processCouponExpirySweep(
  env: CouponSweepEnv,
  options: CouponSweepOptions = {},
): Promise<CouponSweepResult> {
  const emptyExpired = (): Record<CouponLedger, number> =>
    COUPON_LEDGERS.reduce(
      (acc, l) => { acc[l] = 0; return acc; },
      {} as Record<CouponLedger, number>,
    );

  const result: CouponSweepResult = {
    triggered: false,
    expired: emptyExpired(),
    stuckReverted: 0,
    activated: 0,
    pushed: 0,
    errors: 0,
  };

  if (env.COUPON_SWEEP_ENABLED !== 'true') return result;

  const now = options.now ?? new Date();
  const force = env.COUPON_SWEEP_FORCE === 'true';
  if (!force && !isCouponSweepWindow(now)) return result;

  result.triggered = true;
  const nowIso = now.toISOString();

  // ① 3 台帳の失効確定 (台帳ごとに隔離 — pre-migration のテーブル欠如でも他を止めない)
  for (const ledger of COUPON_LEDGERS) {
    try {
      result.expired[ledger] = await markExpiredCoupons(env.DB, ledger, nowIso);
    } catch (err) {
      result.errors += 1;
      console.error(
        `[coupon-sweep] markExpiredCoupons failed (ledger ${ledger}):`,
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  // ② stuck activating の再駆動準備 (waiting へ戻す — 実際の再 create は ③ or T1/T3 が行う)
  try {
    const stuck = await listStuckActivatingRows(env.DB, nowIso);
    for (const row of stuck) {
      try {
        const reverted = await revertQueueRowToWaiting(env.DB, row.id, 'stuck activating (sweep)');
        if (reverted) result.stuckReverted += 1;
      } catch (err) {
        result.errors += 1;
        console.error('[coupon-sweep] revert stuck failed:', err instanceof Error ? err.name : 'unknown');
      }
    }
  } catch (err) {
    // queue テーブル未作成 (migration 079 未適用) → ②③ は静かに skip
    console.error('[coupon-sweep] stuck scan failed (pre-migration?):', err instanceof Error ? err.name : 'unknown');
  }

  // ③ T2 活性化: 待機ありかつ生きた紹介クーポンが無い friend へ次の 1 枚 (cap で Shopify write を抑制)
  const cap = options.activationCap ?? DEFAULT_ACTIVATION_CAP;
  try {
    const candidates = await listFriendsWithActivatableQueue(env.DB, nowIso, cap);
    if (candidates.length > 0) {
      const lineClient =
        options.lineClient ?? new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
      for (const cand of candidates) {
        try {
          const r = await activateAndNotifyNextReferralCoupon(env.DB, env, lineClient, {
            friendId: cand.friend_id,
          });
          if (r.activated) result.activated += 1;
          if (r.pushed) result.pushed += 1;
        } catch (err) {
          result.errors += 1;
          console.error(
            '[coupon-sweep] activate failed friend=',
            cand.friend_id,
            err instanceof Error ? err.name : 'unknown',
          );
        }
      }
    }
  } catch (err) {
    console.error('[coupon-sweep] T2 scan failed (pre-migration?):', err instanceof Error ? err.name : 'unknown');
  }

  // self-record (= cron-monitor で silent 検知できるよう記録)
  try {
    await insertCronRunLog(env.DB, {
      jobName: COUPON_SWEEP_JOB_NAME,
      status: result.errors > 0 ? 'partial' : 'success',
      metrics: {
        expiredFriend: result.expired.friend,
        expiredReferral: result.expired.referral,
        expiredLink: result.expired.link,
        stuckReverted: result.stuckReverted,
        activated: result.activated,
        pushed: result.pushed,
        errors: result.errors,
      },
    });
  } catch (err) {
    console.error('[coupon-sweep] self-record failed:', err instanceof Error ? err.name : 'unknown');
  }

  return result;
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isCouponSweepWindow,
  TRIGGER_HOUR,
  TRIGGER_MINUTE_FROM,
  TRIGGER_MINUTE_TO_EXCLUSIVE,
  DEFAULT_ACTIVATION_CAP,
};
