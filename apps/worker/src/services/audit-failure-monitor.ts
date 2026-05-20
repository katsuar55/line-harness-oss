/**
 * Audit Failure Spike Monitor (Phase 5β-1d-2f-followup-2)
 *
 * 役割:
 *   - audit_logs の result='failure' を 5 min 毎に集計
 *   - 直近 windowMinutes 内の failure count が threshold を超えたら logger.error で alert
 *   - alert は logger.ts 経由で Discord webhook + Axiom に通知
 *   - 重複 alert 防止: 直近 cooldownHours 以内に同 alert 済なら skip
 *
 * 設計:
 *   - **best-effort**: D1 / logger 失敗時も throw しない (cron 全停止しない)
 *   - **冪等**: cron が 5 min 毎に走るが、 cooldown で 1 alert / hour に制限
 *   - **self-tracking**: alert 発火を audit_logs.action='audit_failure_monitor.spike_detected' で記録
 *     → 次回 cron で重複 alert skip 判定
 *
 * 想定 trigger event:
 *   - line_friend_coupon.issue_failed が同時に複数発生 (= Shopify scope 問題等)
 *   - cron.<job>.failed が連続 (= D1 / LINE API outage 等)
 *   - admin.dangerous_action.failed (= 認証エラー連続等)
 *
 * 関連:
 *   - apps/worker/src/services/logger.ts (= Discord webhook)
 *   - apps/worker/src/services/audit-logger.ts (= audit_logs INSERT)
 *   - packages/db/src/audit-logs.ts (= insertAuditLog)
 */

import { insertAuditLog } from '@line-crm/db';
import type { Logger } from './logger.js';

const DEFAULT_WINDOW_MINUTES = 5;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_HOURS = 1;
const SPIKE_ACTION = 'audit_failure_monitor.spike_detected';

export interface CheckAuditFailureSpikeOptions {
  /** 何分以内の failure を集計するか (default 5 min) */
  windowMinutes?: number;
  /** alert を出す failure 件数の閾値 (default 3) */
  threshold?: number;
  /** alert 重複防止 cooldown (default 1 hour) */
  cooldownHours?: number;
  /** テスト用: 現在時刻固定 */
  nowFn?: () => number;
}

export interface AuditFailureSpikeResult {
  failureCount: number;
  alerted: boolean;
  /** 'cooldown' | 'below_threshold' | undefined (= alerted=true 時) */
  skipReason?: 'cooldown' | 'below_threshold';
  /** alert を構成する action 内訳 (= 最大 5 件) */
  topActions?: Array<{ action: string; count: number }>;
}

/**
 * 直近 windowMinutes 内の audit_logs failure を集計し、 threshold 超なら alert。
 *
 * @returns 集計結果 + alerted フラグ
 */
export async function checkAuditFailureSpike(
  db: D1Database,
  logger: Logger,
  options: CheckAuditFailureSpikeOptions = {},
): Promise<AuditFailureSpikeResult> {
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const cooldownHours = options.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const nowMs = options.nowFn ? options.nowFn() : Date.now();
  const since = new Date(nowMs - windowMinutes * 60 * 1000).toISOString();
  const cooldownSince = new Date(nowMs - cooldownHours * 60 * 60 * 1000).toISOString();

  // ── 1. 直近 N 分の failure count (= 自分の alert 自体は除外) ──
  const failureRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_logs
       WHERE result = 'failure'
         AND created_at >= ?
         AND action != ?`,
    )
    .bind(since, SPIKE_ACTION)
    .first<{ n: number }>();

  const failureCount = failureRow?.n ?? 0;

  if (failureCount < threshold) {
    return { failureCount, alerted: false, skipReason: 'below_threshold' };
  }

  // ── 2. 直近 cooldownHours 以内に既に alert 済なら skip ──
  const lastAlert = await db
    .prepare(
      `SELECT created_at FROM audit_logs
       WHERE action = ?
         AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(SPIKE_ACTION, cooldownSince)
    .first<{ created_at: string }>();

  if (lastAlert) {
    return { failureCount, alerted: false, skipReason: 'cooldown' };
  }

  // ── 3. top actions の内訳取得 (= alert message に含める) ──
  const topActionsResult = await db
    .prepare(
      `SELECT action, COUNT(*) AS count FROM audit_logs
       WHERE result = 'failure'
         AND created_at >= ?
         AND action != ?
       GROUP BY action
       ORDER BY count DESC
       LIMIT 5`,
    )
    .bind(since, SPIKE_ACTION)
    .all<{ action: string; count: number }>();

  const topActions = topActionsResult.results ?? [];

  // ── 4. logger.error で alert (= Discord + Axiom 自動通知) ──
  try {
    logger.error('audit_logs failure spike detected', {
      severity: 'CRITICAL',
      failureCount,
      windowMinutes,
      threshold,
      topActions: topActions.map((a) => `${a.action} (${a.count})`).join(', '),
      hint: '/audit-logs page で詳細確認、 action prefix で絞り込み可能',
    });
  } catch (err) {
    console.error('[audit-failure-monitor] logger.error failed:', err);
  }

  // ── 5. alert 発火を audit_logs に記録 (= 次回 cooldown 判定用) ──
  try {
    await insertAuditLog(db, {
      action: SPIKE_ACTION,
      actorType: 'cron',
      result: 'success',
      metadata: { failureCount, windowMinutes, threshold, topActions },
    });
  } catch (err) {
    // INSERT 失敗時も alert は既に出している (= ベスト努力)
    console.error('[audit-failure-monitor] insertAuditLog failed:', err);
  }

  return { failureCount, alerted: true, topActions };
}
