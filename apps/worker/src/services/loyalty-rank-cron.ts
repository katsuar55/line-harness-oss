/**
 * Loyalty rank monthly re-evaluation cron (= 自社内製ロイヤリティ, 2026-06-01, PR2)
 *
 * 役割:
 *   月初 1 日 09:05 JST ± 5 分 に、 全 member の trailing-12ヶ月 rank を再判定し、
 *   loyalty_rank_snapshots に「その月の official rank」 を記録する。
 *   前月 snapshot と比較して 昇格 (up) / 降格 (down) / 同 (same) を検知。
 *
 * cb-admin 仕様の再現:
 *   - 過去12ヶ月 rolling・月次再判定・**降格あり** (= cb-admin と同じ)
 *   - 月次 snapshot がその月の確定 rank (= 月内は安定、 表示の進捗バーのみ live)
 *
 * 設計原則 (= membership-promotion-cron.ts に倣う):
 *   - gating: JST 1 日 09:05-09:09 のみ (= membership 09:00 / birthday 10:00 / broadcast 11:00 と分離)
 *   - idempotent: recordRankSnapshot が UNIQUE(friend_id, period) ON CONFLICT で同月 1 行に収束
 *   - fail-safe: 個別 member 失敗は errors count + continue
 *   - audit: 集計を audit_logs に 1 件 (= loyalty_rank.monthly_reeval_completed)
 *
 * 環境変数:
 *   - LOYALTY_RANK_CRON_FORCE='true' で gating bypass (= テスト/手動 trigger)
 *
 * 関連:
 *   - packages/db/src/loyalty-rank.ts resolveFriendRank / compareRanks (= 判定 純関数)
 *   - packages/db/src/loyalty-rank-snapshots.ts (= snapshot CRUD、 migration 061)
 *   - apps/worker/src/index.ts scheduled handler から呼出
 *   - PR8 (将来): direction=down の gold/platinum へ降格通知
 */
import {
  NATURISM_RANK_DEFS,
  compareRanks,
  getPreviousRankSnapshot,
  recordRankSnapshot,
  resolveFriendRank,
  toJstString,
  type RankDirection,
} from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

export interface LoyaltyRankCronEnv {
  DB: D1Database;
  LOYALTY_RANK_CRON_FORCE?: string;
}

export interface LoyaltyRankCronResult {
  readonly skippedDueToGating: boolean;
  readonly period: string;
  readonly candidates: number;
  readonly promoted: number;
  readonly demoted: number;
  readonly unchanged: number;
  readonly errors: number;
  readonly demotedFriendIds: string[];
  readonly promotedFriendIds: string[];
}

interface ProcessOptions {
  /** test 用に「現在時刻」 を override 可能 */
  now?: Date;
}

/**
 * JST_OFFSET shift 済 Date から 'YYYY-MM' period 文字列を作る。
 * getUTC* で JST wall-clock の年月を読む (= toJstString と同パターン、 将来の誤"修正"予防)。
 */
function toPeriod(jst: Date): string {
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 月次 loyalty rank 再判定 cron entry point (= scheduled handler から呼出)。
 *
 * 月初 1 日 09:05 JST ± 5 分 のみ実行、 それ以外は skip。
 * gating bypass: LOYALTY_RANK_CRON_FORCE='true'
 */
export async function processLoyaltyRankReeval(
  env: LoyaltyRankCronEnv,
  options: ProcessOptions = {},
): Promise<LoyaltyRankCronResult> {
  const now = options.now ?? new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstDay = jst.getUTCDate();
  const jstHour = jst.getUTCHours();
  const jstMinute = jst.getUTCMinutes();
  const period = toPeriod(jst);
  // trailing-12mo は cron 実行時点 (= now) を asOf に算出 (= 月次再判定の基準時刻、 test 決定性も担保)。
  const asOf = toJstString(now);

  // membership cron (09:00, minute<5) と分離するため 09:05-09:09 window を使う。
  const isGatingWindow = jstDay === 1 && jstHour === 9 && jstMinute >= 5 && jstMinute < 10;
  const forceRun = env.LOYALTY_RANK_CRON_FORCE === 'true';

  if (!isGatingWindow && !forceRun) {
    return {
      skippedDueToGating: true,
      period,
      candidates: 0,
      promoted: 0,
      demoted: 0,
      unchanged: 0,
      errors: 0,
      demotedFriendIds: [],
      promotedFriendIds: [],
    };
  }

  // members = 購入実績のある friend (= addPurchaseEvent が seed)。 regular(購入0)は評価不要。
  // NOTE: 現 naturism 規模 (数百) は無制限 SELECT で可。 ~1,000 member 到達前に paginate +
  // direction==='same' の skip-write を検討 (= PR#94 review S-2、 D1 write 上限対策)。
  const result = await env.DB.prepare(`SELECT friend_id FROM members`).all<{ friend_id: string }>();
  const rows = result.results ?? [];

  let promoted = 0;
  let demoted = 0;
  let unchanged = 0;
  let errors = 0;
  const demotedFriendIds: string[] = [];
  const promotedFriendIds: string[] = [];

  for (const row of rows) {
    try {
      const resolved = await resolveFriendRank(env.DB, row.friend_id, NATURISM_RANK_DEFS, asOf);
      const prev = await getPreviousRankSnapshot(env.DB, row.friend_id, period);
      const prevRankId = prev?.rankId ?? null;

      let direction: RankDirection;
      if (!prevRankId) {
        direction = 'initial';
      } else {
        const cmp = compareRanks(NATURISM_RANK_DEFS, prevRankId, resolved.rankId);
        direction = cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'same';
      }

      await recordRankSnapshot(env.DB, {
        friendId: row.friend_id,
        period,
        rankId: resolved.rankId,
        trailing12moJpy: resolved.trailing12moJpy,
        prevRankId,
        direction,
      });

      if (direction === 'up') {
        promoted += 1;
        promotedFriendIds.push(row.friend_id);
      } else if (direction === 'down') {
        demoted += 1;
        demotedFriendIds.push(row.friend_id);
      } else {
        // 'same' と 'initial' (= 新規 baseline) は rank 変化イベント無しとして unchanged。
        unchanged += 1;
      }
    } catch (err) {
      errors += 1;
      console.error(
        `[loyalty-rank-cron] friend ${row.friend_id} failed:`,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // audit log (= best-effort)
  try {
    await auditSystem(env.DB, {
      action: 'loyalty_rank.monthly_reeval_completed',
      result: 'success',
      metadata: {
        period,
        candidates: rows.length,
        promoted,
        demoted,
        unchanged,
        errors,
        demotedFriendIds,
        promotedFriendIds,
        forceRun,
      },
    });
  } catch (auditErr) {
    console.error(
      '[loyalty-rank-cron] audit failed',
      auditErr instanceof Error ? auditErr.message : 'unknown',
    );
  }

  return {
    skippedDueToGating: false,
    period,
    candidates: rows.length,
    promoted,
    demoted,
    unchanged,
    errors,
    demotedFriendIds,
    promotedFriendIds,
  };
}
