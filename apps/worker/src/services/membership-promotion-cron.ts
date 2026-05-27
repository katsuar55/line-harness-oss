/**
 * Membership promotion sanity cron (= Phase 4-δ、 2026-05-28)
 *
 * 役割:
 *   月初 1 日 09:00 JST ± 5 分 に **全 members で promoteMemberIfEligible** を実行する safety net。
 *   PR #83 (Phase 4-γ) で order webhook 経由 都度 promote が実装されたが、 以下 case を fallback でカバー:
 *     - referral count update (= 後 PR で実装) で tier 条件達成したが promote 漏れ
 *     - 過去 backfill 後の tier 計算が未完了の member (= 累計だけ加算で tier mis-match)
 *     - 何らかの理由で webhook 失敗 (= 5xx / D1 outage 等) で promote 漏れ
 *
 * 設計原則:
 *   - **gating**: JST 1 日 09:00-09:04 のみ実行 (= 5 分 cron 1 window、 同月複数走行 idempotent)
 *     - birthday cron は 10:00、 monthly broadcast cron は 11:00 → 衝突回避
 *   - **idempotent**: promoteMemberIfEligible 自体が「displayOrder 上がる場合のみ update」 → 重複呼出安全
 *   - **fail-safe**: 個別 member の promote 失敗は errors count + continue
 *   - **audit**: 集計 result を audit_logs に 1 件記録 (= membership.monthly_sanity_completed)
 *
 * 環境変数:
 *   - `MEMBERSHIP_CRON_FORCE='true'` で gating bypass (= テスト/手動 trigger 用)
 *
 * 関連:
 *   - packages/db/src/membership.ts promoteMemberIfEligible (= 純関数、 displayOrder 比較で安全)
 *   - apps/worker/src/services/membership.ts checkAndNotifyForFriend (= 但し monthly では push しない、 default)
 *   - apps/worker/src/index.ts scheduled handler から呼出
 */
import { promoteMemberIfEligible } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

export interface MembershipPromotionCronEnv {
  DB: D1Database;
  MEMBERSHIP_CRON_FORCE?: string;
}

export interface MembershipPromotionCronResult {
  readonly skippedDueToGating: boolean;
  readonly month: number;
  readonly year: number;
  readonly candidates: number;
  readonly promoted: number;
  readonly unchanged: number;
  readonly errors: number;
  readonly promotedFriendIds: string[];
}

interface ProcessOptions {
  /** test 用に「現在時刻」 を override 可能 */
  now?: Date;
}

/**
 * 月次 promotion sanity cron entry point (= scheduled handler から呼出)。
 *
 * 月初 1 日 09:00 JST ± 5 分 のみ実行、 それ以外は skip。
 * gating bypass: MEMBERSHIP_CRON_FORCE='true'
 *
 * @returns 集計結果 (= skippedDueToGating / candidates / promoted / unchanged / errors)
 */
export async function processMembershipPromotionSanity(
  env: MembershipPromotionCronEnv,
  options: ProcessOptions = {},
): Promise<MembershipPromotionCronResult> {
  const now = options.now ?? new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstDay = jst.getUTCDate();
  const jstHour = jst.getUTCHours();
  const jstMinute = jst.getUTCMinutes();
  const jstMonth = jst.getUTCMonth() + 1;
  const jstYear = jst.getUTCFullYear();

  const isGatingWindow = jstDay === 1 && jstHour === 9 && jstMinute < 5;
  const forceRun = env.MEMBERSHIP_CRON_FORCE === 'true';

  if (!isGatingWindow && !forceRun) {
    return {
      skippedDueToGating: true,
      month: jstMonth,
      year: jstYear,
      candidates: 0,
      promoted: 0,
      unchanged: 0,
      errors: 0,
      promotedFriendIds: [],
    };
  }

  // SELECT all members (= MVP は 1 件、 将来 paginate)
  const result = await env.DB
    .prepare(`SELECT friend_id FROM members`)
    .all<{ friend_id: string }>();
  const rows = result.results ?? [];

  let promoted = 0;
  let unchanged = 0;
  let errors = 0;
  const promotedFriendIds: string[] = [];

  for (const row of rows) {
    try {
      const r = await promoteMemberIfEligible(env.DB, row.friend_id);
      if (r.promoted) {
        promoted += 1;
        promotedFriendIds.push(row.friend_id);
      } else {
        unchanged += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(
        `[membership-promotion-cron] friend ${row.friend_id} failed:`,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // audit log (= best-effort)
  try {
    await auditSystem(env.DB, {
      action: 'membership.monthly_sanity_completed',
      result: 'success',
      metadata: {
        month: jstMonth,
        year: jstYear,
        candidates: rows.length,
        promoted,
        unchanged,
        errors,
        promotedFriendIds,
        forceRun,
      },
    });
  } catch (auditErr) {
    console.error(
      '[membership-promotion-cron] audit failed',
      auditErr instanceof Error ? auditErr.message : 'unknown',
    );
  }

  return {
    skippedDueToGating: false,
    month: jstMonth,
    year: jstYear,
    candidates: rows.length,
    promoted,
    unchanged,
    errors,
    promotedFriendIds,
  };
}
