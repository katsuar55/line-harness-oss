/**
 * Cron 死活監視 (Phase 5 PR-4)
 *
 * 目的:
 * - Phase 4 PR-5 の週次栄養コーチ push (火曜 10:00 JST) や
 *   Phase 3 PR-7 の月次食事レポート (毎月 1 日) のような低頻度 cron が、
 *   gating 以外の理由で長期間 0 件になった場合に Discord で気づく。
 * - cron_run_logs テーブルの「最終成功時刻」と現在時刻を比較し、
 *   rule の `maxSilentHours` を超えていたらアラート候補とする。
 *
 * 設計方針:
 * - **gating**: cron 5 分毎発火で連続アラートを出さないため、
 *   JST 09:00-09:04 のウィンドウのみ trigger。`CRON_MONITOR_FORCE='true'` で bypass。
 * - **fail-safe**: DB 失敗 / fetch 失敗で例外を投げない。cron 全体を止めない。
 * - **DISCORD_WEBHOOK_URL 未設定**: alert は record されるが fetch は呼ばれない。
 * - **自身も cron_run_logs に記録**: status='success' で履歴を残す
 *   (ただし self-record の失敗は無視)。
 */

import {
  getLastSuccessfulRun,
  insertCronRunLog,
  type CronRunLog,
} from '@line-crm/db';

// ============================================================
// 型
// ============================================================

export interface CronMonitorEnv {
  DB: D1Database;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
  /** 'true' で gating bypass (テスト/手動実行用) */
  CRON_MONITOR_FORCE?: string;
}

export interface CronMonitorRule {
  jobName: string;
  /** この時間より長く成功していなかったらアラート */
  maxSilentHours: number;
  /** 監視を起動する曜日 (JST 0=Sun..6=Sat)。指定しなければ毎日チェック */
  runOnDays?: number[];
}

export interface CronMonitorAlert {
  jobName: string;
  lastSuccessAt: string | null;
  silentHours: number;
}

export interface CronMonitorResult {
  /** gating 通過したか */
  triggered: boolean;
  alerts: CronMonitorAlert[];
}

export interface CronMonitorOptions {
  /** 現在時刻 (テスト用 override) */
  now?: Date;
  /** rule override */
  rules?: CronMonitorRule[];
  /** Discord 送信を抑制する fetch 実装 (テスト用) */
  fetchImpl?: typeof fetch;
}

// ============================================================
// 定数 / デフォルト rule
// ============================================================

/** この job 自身を識別するための名前 (cron_run_logs に記録される) */
export const CRON_MONITOR_JOB_NAME = 'cron-monitor';

/** JST gating window: 09:00-09:04 */
const TRIGGER_HOUR = 9;
const TRIGGER_MINUTE_FROM = 0;
const TRIGGER_MINUTE_TO_EXCLUSIVE = 5;

export const DEFAULT_RULES: CronMonitorRule[] = [
  // 週次 push: 7 日 + 12 時間で許容
  { jobName: 'weekly-coach-push', maxSilentHours: 7 * 24 + 12 },
  // 月次レポート: 31 日 + 12 時間で許容
  { jobName: 'monthly-food-report', maxSilentHours: 31 * 24 + 12 },
];

// ============================================================
// 公開 API
// ============================================================

export async function processCronMonitor(
  env: CronMonitorEnv,
  options: CronMonitorOptions = {},
): Promise<CronMonitorResult> {
  const now = options.now ?? new Date();
  const rules = options.rules ?? DEFAULT_RULES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const force = env.CRON_MONITOR_FORCE === 'true';

  if (!force && !isMonitorWindow(now)) {
    return { triggered: false, alerts: [] };
  }

  const alerts: CronMonitorAlert[] = [];

  for (const rule of rules) {
    if (rule.runOnDays && rule.runOnDays.length > 0) {
      const { day } = jstParts(now);
      if (!rule.runOnDays.includes(day)) {
        continue;
      }
    }

    let lastRun: CronRunLog | null = null;
    try {
      lastRun = await getLastSuccessfulRun(env.DB, rule.jobName);
    } catch (err) {
      // DB 失敗は監視自体を止めない。alert 判定はスキップ。
      console.error(
        '[cron-monitor] getLastSuccessfulRun failed for',
        rule.jobName,
        err instanceof Error ? err.name : 'unknown',
      );
      continue;
    }

    const silentHours = computeSilentHours(now, lastRun?.ran_at ?? null);
    if (lastRun === null || silentHours > rule.maxSilentHours) {
      alerts.push({
        jobName: rule.jobName,
        lastSuccessAt: lastRun?.ran_at ?? null,
        silentHours,
      });
    }
  }

  if (alerts.length > 0 && env.DISCORD_WEBHOOK_URL) {
    try {
      await sendDiscordAlert(
        env.DISCORD_WEBHOOK_URL,
        env.ACCOUNT_NAME ?? 'naturism',
        alerts,
        fetchImpl,
      );
    } catch (err) {
      // 通知先障害でアプリは止めない
      console.error(
        '[cron-monitor] discord notification failed',
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  // 自身の実行も cron_run_logs に記録 (alert 0 でも success として記録)
  try {
    await insertCronRunLog(env.DB, {
      jobName: CRON_MONITOR_JOB_NAME,
      status: 'success',
      metrics: {
        rulesChecked: rules.length,
        alerts: alerts.length,
      },
    });
  } catch (err) {
    console.error(
      '[cron-monitor] self-record failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }

  return { triggered: true, alerts };
}

// ============================================================
// 時刻計算
// ============================================================

export function jstParts(now: Date): { day: number; hour: number; minute: number } {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return {
    day: jst.getUTCDay(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  };
}

export function isMonitorWindow(now: Date): boolean {
  const { hour, minute } = jstParts(now);
  return (
    hour === TRIGGER_HOUR &&
    minute >= TRIGGER_MINUTE_FROM &&
    minute < TRIGGER_MINUTE_TO_EXCLUSIVE
  );
}

/**
 * 経過時間を時間 (hour) 単位で返す。
 * lastSuccessIso が null の場合は Number.POSITIVE_INFINITY を返す。
 */
export function computeSilentHours(now: Date, lastSuccessIso: string | null): number {
  if (!lastSuccessIso) return Number.POSITIVE_INFINITY;
  const last = new Date(lastSuccessIso);
  if (Number.isNaN(last.getTime())) return Number.POSITIVE_INFINITY;
  const diffMs = now.getTime() - last.getTime();
  if (diffMs <= 0) return 0;
  return diffMs / 3_600_000;
}

// ============================================================
// Discord
// ============================================================

async function sendDiscordAlert(
  webhookUrl: string,
  account: string,
  alerts: CronMonitorAlert[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const lines = alerts.map((a) => {
    const last = a.lastSuccessAt ?? '(no successful run recorded)';
    const silent =
      a.silentHours === Number.POSITIVE_INFINITY
        ? 'never'
        : `${a.silentHours.toFixed(1)}h`;
    return `- \`${a.jobName}\`: last success **${last}** (silent for ${silent})`;
  });

  const content = [
    `:rotating_light: **Cron silence detected** \`${account}\``,
    'The following scheduled jobs have not succeeded within their expected window:',
    ...lines,
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
  jstParts,
  isMonitorWindow,
  computeSilentHours,
  TRIGGER_HOUR,
};
