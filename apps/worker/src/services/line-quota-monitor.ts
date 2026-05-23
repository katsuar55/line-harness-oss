/**
 * LINE Message Quota Monitor (LSTEP audit H4、 2026-05-22)
 *
 * 役割:
 *   - LINE Messaging API の月次 quota (= Free plan 200/月、 Light/Standard plan 等) を監視
 *   - usage / limit 比率を算出、 80%/95%/100% 閾値で Discord alert
 *   - alert は audit_logs に記録、 同 severity の alert は cooldown 内で重複防止
 *
 * 設計:
 *   - **best-effort**: LINE API / D1 / logger 失敗時も throw しない (cron 全停止しない)
 *   - **cooldown**: 同じ severity (= warning/critical/reached) は cooldownHours 内 skip
 *   - **type='none' (= unlimited plan) は skip**
 *
 * LINE API:
 *   - GET /v2/bot/message/quota → { type: 'none' | 'limited', value?: number }
 *   - GET /v2/bot/message/quota/consumption → { totalUsage: number }
 *
 * 関連:
 *   - apps/worker/src/services/audit-failure-monitor.ts (同じ pattern)
 *   - apps/worker/src/services/logger.ts (Discord webhook)
 *   - packages/db/src/audit-logs.ts (insertAuditLog)
 */

import { insertAuditLog } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Logger } from './logger.js';

const ACTION_PREFIX = 'line_quota_monitor';
const ACTION_WARNING = `${ACTION_PREFIX}.warning`;
const ACTION_CRITICAL = `${ACTION_PREFIX}.critical`;
const ACTION_REACHED = `${ACTION_PREFIX}.reached`;
const ACTION_API_FAILED = `${ACTION_PREFIX}.api_failed`;

const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_CRITICAL_THRESHOLD = 0.95;
const DEFAULT_REACHED_THRESHOLD = 1.0;
const DEFAULT_COOLDOWN_HOURS = 24;

export type QuotaSeverity = 'warning' | 'critical' | 'reached';

export interface CheckLineQuotaOptions {
  warningThreshold?: number;
  criticalThreshold?: number;
  reachedThreshold?: number;
  cooldownHours?: number;
  /** テスト用: 現在時刻固定 */
  nowFn?: () => number;
}

export interface LineQuotaResult {
  /** 'none' プラン (= 無制限) なら skip */
  unlimited: boolean;
  /** 月間上限 (= unlimited なら undefined) */
  limit?: number;
  /** 今月の使用数 */
  usage?: number;
  /** usage / limit (= unlimited なら undefined) */
  ratio?: number;
  /** 判定された severity (= 閾値未満なら undefined) */
  severity?: QuotaSeverity;
  /** alert を発火したか */
  alerted: boolean;
  /** skip の理由 */
  skipReason?: 'unlimited' | 'below_threshold' | 'cooldown' | 'api_failed';
}

/**
 * LINE quota を取得して閾値判定 + alert。
 *
 * @param db     D1 (audit_logs INSERT 用)
 * @param line   LineClient (= channel access token 注入済)
 * @param logger logger (= Discord webhook + Axiom)
 */
export async function checkLineQuota(
  db: D1Database,
  line: LineClient,
  logger: Logger,
  options: CheckLineQuotaOptions = {},
): Promise<LineQuotaResult> {
  const warningThreshold = options.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
  const criticalThreshold = options.criticalThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
  const reachedThreshold = options.reachedThreshold ?? DEFAULT_REACHED_THRESHOLD;
  const cooldownHours = options.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;
  const nowMs = options.nowFn ? options.nowFn() : Date.now();

  // ── 1. LINE API で quota + consumption 取得 ──
  let quota;
  let consumption;
  try {
    [quota, consumption] = await Promise.all([
      line.getMessageQuota(),
      line.getMessageQuotaConsumption(),
    ]);
  } catch (err) {
    // LINE API 失敗は best-effort、 警告ログのみ
    try {
      logger.warn('LINE quota API call failed', {
        action: ACTION_API_FAILED,
        error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
    } catch {
      // logger 自体が failed しても続行
    }
    return { unlimited: false, alerted: false, skipReason: 'api_failed' };
  }

  // ── 2. type='none' (= Pro/Premium plan) は skip ──
  if (quota.type === 'none' || quota.value === undefined || quota.value <= 0) {
    return { unlimited: true, alerted: false, skipReason: 'unlimited' };
  }

  const limit = quota.value;
  const usage = consumption.totalUsage;
  const ratio = usage / limit;

  // ── 3. severity 判定 (= 高い順、 reached > critical > warning) ──
  let severity: QuotaSeverity | undefined;
  let action: string | undefined;
  if (ratio >= reachedThreshold) {
    severity = 'reached';
    action = ACTION_REACHED;
  } else if (ratio >= criticalThreshold) {
    severity = 'critical';
    action = ACTION_CRITICAL;
  } else if (ratio >= warningThreshold) {
    severity = 'warning';
    action = ACTION_WARNING;
  }

  if (!severity || !action) {
    return { unlimited: false, limit, usage, ratio, alerted: false, skipReason: 'below_threshold' };
  }

  // ── 4. cooldown 判定 (= 同 severity の前 alert が cooldownHours 以内なら skip) ──
  const cooldownSince = new Date(nowMs - cooldownHours * 60 * 60 * 1000).toISOString();
  const lastAlert = await db
    .prepare(
      `SELECT created_at FROM audit_logs
       WHERE action = ?
         AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(action, cooldownSince)
    .first<{ created_at: string }>()
    .catch(() => null);

  if (lastAlert) {
    return { unlimited: false, limit, usage, ratio, severity, alerted: false, skipReason: 'cooldown' };
  }

  // ── 5. logger.error (= critical/reached) or logger.warn (= warning) で alert ──
  const isLoggerError = severity === 'critical' || severity === 'reached';
  const alertFields = {
    severity: severity === 'warning' ? 'WARN' : 'CRITICAL',
    usage,
    limit,
    ratio: Math.round(ratio * 1000) / 1000,
    percentDisplay: `${(ratio * 100).toFixed(1)}%`,
    hint:
      severity === 'reached'
        ? 'LINE plan upgrade が必要、 broadcast / push は今月停止される可能性あり'
        : severity === 'critical'
          ? 'LINE plan upgrade を要検討、 残枠で broadcast 停止 risk 高い'
          : '今月の配信量が増加傾向、 残枠を確認',
  };
  try {
    if (isLoggerError) {
      logger.error(`LINE quota ${severity}: ${alertFields.percentDisplay}`, alertFields);
    } else {
      logger.warn(`LINE quota ${severity}: ${alertFields.percentDisplay}`, alertFields);
    }
  } catch (err) {
    console.error('[line-quota-monitor] logger call failed:', err);
  }

  // ── 6. audit_logs に記録 (= 次回 cooldown 判定用) ──
  try {
    await insertAuditLog(db, {
      action,
      actorType: 'cron',
      result: 'success',
      metadata: { usage, limit, ratio, severity, thresholds: { warningThreshold, criticalThreshold, reachedThreshold } },
    });
  } catch (err) {
    console.error('[line-quota-monitor] insertAuditLog failed:', err);
  }

  return { unlimited: false, limit, usage, ratio, severity, alerted: true };
}
