/**
 * Email failure monitor (Phase 5α-4)
 *
 * 目的:
 *   email_messages_log の status='failed' を直近時間ウィンドウで集計し、
 *   閾値を超えたら Discord 通知 (沈黙のメール障害を早期検知)。
 *
 * 設計方針:
 *   - **fail-soft**: DB 失敗 / Discord 失敗で例外を投げない (cron 全体を止めない)
 *   - **multi-tenant 対応**: account 別集計可能 (ただし default は全 account 合算)
 *   - **2 軸閾値**: 絶対件数 + 失敗率 (どちらか超えたら alert)
 *   - **gating**: cron-monitor と同じ JST 09:00-09:04 ウィンドウで連続 alert を抑制
 *     ただし障害は早期検知が重要なので CRON_MONITOR_FORCE='true' で常時チェックも可能
 *
 * 関連:
 *   - apps/worker/src/services/cron-monitor.ts: cron silence 検知 (similar pattern)
 *   - packages/db/migrations/042_email_channel.sql: email_messages_log
 */

import { auditSystem } from './audit-logger.js';

// ============================================================
// 型
// ============================================================

export interface EmailFailureMonitorEnv {
  DB: D1Database;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
  /** 'true' で gating bypass (即時チェック) */
  EMAIL_FAILURE_MONITOR_FORCE?: string;
  /** 監視 window (時間)、 default 1。 例: '6' で過去 6 時間を集計 */
  EMAIL_FAILURE_WINDOW_HOURS?: string;
  /** 絶対 failure 件数の閾値、 default 10。 これ以上で alert */
  EMAIL_FAILURE_COUNT_THRESHOLD?: string;
  /** failure 率閾値 (0.0-1.0)、 default 0.5。 全送信中の failure 比率 */
  EMAIL_FAILURE_RATE_THRESHOLD?: string;
  /** 集計の最小サンプル数、 default 5。 これ未満なら rate 判定スキップ (false positive 防止) */
  EMAIL_FAILURE_MIN_SAMPLE?: string;
}

export interface EmailFailureStats {
  windowHours: number;
  totalSent: number;
  failedCount: number;
  failureRate: number;
  /** alert 種別 */
  alertReason: 'count_threshold' | 'rate_threshold' | null;
  /** failure 内訳 (provider 別 / source_kind 別 上位) */
  topErrors: Array<{ summary: string; count: number }>;
}

export interface EmailFailureMonitorResult {
  triggered: boolean;
  stats: EmailFailureStats | null;
  alertSent: boolean;
}

export interface EmailFailureMonitorOptions {
  now?: Date;
  fetchImpl?: typeof fetch;
}

// ============================================================
// 実装
// ============================================================

export const EMAIL_FAILURE_MONITOR_JOB_NAME = 'email-failure-monitor';

/** JST 09:00-09:04 ウィンドウ判定 (cron-monitor と同じ pattern) */
function isInWindow(now: Date): boolean {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  return jst.getUTCHours() === 9 && jst.getUTCMinutes() < 5;
}

function parseInt10(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloat10(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function processEmailFailureMonitor(
  env: EmailFailureMonitorEnv,
  options: EmailFailureMonitorOptions = {},
): Promise<EmailFailureMonitorResult> {
  const now = options.now ?? new Date();
  const force = env.EMAIL_FAILURE_MONITOR_FORCE === 'true';
  if (!force && !isInWindow(now)) {
    return { triggered: false, stats: null, alertSent: false };
  }

  const windowHours = parseInt10(env.EMAIL_FAILURE_WINDOW_HOURS, 1);
  const countThreshold = parseInt10(env.EMAIL_FAILURE_COUNT_THRESHOLD, 10);
  const rateThreshold = parseFloat10(env.EMAIL_FAILURE_RATE_THRESHOLD, 0.5);
  const minSample = parseInt10(env.EMAIL_FAILURE_MIN_SAMPLE, 5);

  const sinceDate = new Date(now.getTime() - windowHours * 3_600_000);
  // JST 化 (DB の created_at は JST)
  const sinceJst = new Date(sinceDate.getTime() + 9 * 3_600_000)
    .toISOString()
    .replace('Z', '');

  let totalSent = 0;
  let failedCount = 0;
  let topErrors: Array<{ summary: string; count: number }> = [];
  try {
    // 全件 (sent + failed) を集計
    const totalRow = await env.DB
      .prepare(
        `SELECT
            SUM(CASE WHEN status IN ('sent', 'delivered', 'opened', 'clicked', 'failed', 'bounced', 'complained') THEN 1 ELSE 0 END) AS total,
            SUM(CASE WHEN status IN ('failed', 'bounced', 'complained') THEN 1 ELSE 0 END) AS failed
         FROM email_messages_log
         WHERE created_at >= ?`,
      )
      .bind(sinceJst)
      .first<{ total: number | null; failed: number | null }>();
    totalSent = totalRow?.total ?? 0;
    failedCount = totalRow?.failed ?? 0;

    // 失敗 上位 5 種
    const errorsResult = await env.DB
      .prepare(
        `SELECT COALESCE(error_summary, status) AS summary, COUNT(*) AS count
           FROM email_messages_log
          WHERE created_at >= ? AND status IN ('failed', 'bounced', 'complained')
          GROUP BY summary
          ORDER BY count DESC
          LIMIT 5`,
      )
      .bind(sinceJst)
      .all<{ summary: string; count: number }>();
    topErrors = errorsResult.results.map((r) => ({
      summary: (r.summary ?? '(no error_summary)').slice(0, 200),
      count: r.count,
    }));
  } catch (err) {
    console.error(
      '[email-failure-monitor] DB query failed:',
      err instanceof Error ? `${err.name}: ${err.message}` : 'unknown',
    );
    return { triggered: true, stats: null, alertSent: false };
  }

  const failureRate = totalSent > 0 ? failedCount / totalSent : 0;

  // alert 判定
  let alertReason: EmailFailureStats['alertReason'] = null;
  if (failedCount >= countThreshold) {
    alertReason = 'count_threshold';
  } else if (totalSent >= minSample && failureRate >= rateThreshold) {
    alertReason = 'rate_threshold';
  }

  const stats: EmailFailureStats = {
    windowHours,
    totalSent,
    failedCount,
    failureRate,
    alertReason,
    topErrors,
  };

  let alertSent = false;
  if (alertReason && env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordAlert(
        env.DISCORD_WEBHOOK_URL,
        env.ACCOUNT_NAME ?? 'naturism',
        stats,
        countThreshold,
        rateThreshold,
        options.fetchImpl ?? fetch,
      );
      alertSent = true;
    } catch (err) {
      console.error(
        '[email-failure-monitor] Discord notification failed:',
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  // audit log (alert 発生時のみ)
  if (alertReason) {
    await auditSystem(env.DB, {
      actorType: 'cron',
      actorId: EMAIL_FAILURE_MONITOR_JOB_NAME,
      action: 'cron.email_failure_alert',
      result: 'success',
      metadata: {
        alertReason,
        windowHours,
        totalSent,
        failedCount,
        failureRate: Number(failureRate.toFixed(3)),
        alertSent,
      },
    });
  }

  return { triggered: true, stats, alertSent };
}

async function sendDiscordAlert(
  webhookUrl: string,
  account: string,
  stats: EmailFailureStats,
  countThreshold: number,
  rateThreshold: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const reasonText =
    stats.alertReason === 'count_threshold'
      ? `failure 件数 ${stats.failedCount} >= 閾値 ${countThreshold}`
      : `failure 率 ${(stats.failureRate * 100).toFixed(1)}% >= 閾値 ${(rateThreshold * 100).toFixed(0)}%`;

  const errorLines = stats.topErrors.length
    ? stats.topErrors.map((e) => `  - ${e.count} × \`${e.summary}\``).join('\n')
    : '  - (no error_summary)';

  const content = [
    `:rotating_light: **Email failure detected** \`${account}\``,
    `Window: 過去 ${stats.windowHours}h / 送信合計 ${stats.totalSent} / 失敗 ${stats.failedCount} (${(stats.failureRate * 100).toFixed(1)}%)`,
    `Reason: ${reasonText}`,
    'Top errors:',
    errorLines,
  ].join('\n');

  await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: truncate(content, 1900) }),
  });
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  isInWindow,
  parseInt10,
  parseFloat10,
};
