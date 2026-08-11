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
  getLastLiveRun,
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
  /** teiki-flow ingest 監視の起動条件 (下記 conditionalRules を参照) */
  SUBSCRIPTION_INGEST_ENABLED?: string;
  SUBSCRIPTION_MENU_ENABLED?: string;
  TEIKI_FLOW_SECRET?: string;
  /** ai-models-catalog-sync 監視の起動条件 (下記 conditionalRules を参照) */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** shopify-customer-sync 監視の起動条件 (下記 conditionalRules を参照) */
  SHOPIFY_STORE_DOMAIN?: string;
}

export interface CronMonitorRule {
  jobName: string;
  /** この時間より長く成功していなかったらアラート */
  maxSilentHours: number;
  /** 監視を起動する曜日 (JST 0=Sun..6=Sat)。指定しなければ毎日チェック */
  runOnDays?: number[];
  /**
   * partial も「生存」とみなす (2026-08-11)。複数 feed の job は 1 feed だけの
   * 恒久失敗で partial が定常になり得る — それは劣化であって沈黙ではない。
   * 劣化自体は cron_run_logs の errorSummary / metrics で追う。
   */
  treatPartialAsAlive?: boolean;
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
  // 再購入リマインダー (Phase 6 PR-6): cron は 5 分間隔。24 時間 silent で異常。
  // deploy 直後など短期間 stale を許容する余裕を含む。
  { jobName: 'subscription-reminder', maxSilentHours: 24 },
  // Phase 7 (2026-04-29): 5 分間隔 cron 群を heartbeat 化。2 時間 silent = 異常。
  // 各 job は 5 分毎に走るため 2 時間 (= 24 ティック分) 失敗が連続したら検知。
  { jobName: 'step-delivery', maxSilentHours: 2 },
  { jobName: 'scheduled-broadcasts', maxSilentHours: 2 },
  { jobName: 'reminder-delivery', maxSilentHours: 2 },
  { jobName: 'scheduled-ab-tests', maxSilentHours: 2 },
  { jobName: 'abandoned-cart-notify', maxSilentHours: 2 },
  { jobName: 'tag-elapsed-deliveries', maxSilentHours: 2 },
  { jobName: 'ban-monitor', maxSilentHours: 2 },
  // shopify-customer-sync は conditionalRules へ移動 (2026-08-11):
  // SHOPIFY_STORE_DOMAIN 未設定の環境 (OSS 既定) では毎 tick skipped になるため、
  // 静的ルールだと dormant 環境で永久にアラートが鳴り続ける。
  // 週次レポート: 内部 gating があるため 7 日 + 12 時間
  { jobName: 'weekly-reports', maxSilentHours: 7 * 24 + 12 },
  // token-refresh: LINE access token は 30 日有効、1 日 1 回更新で十分。
  // 内部で 27 日経過してから更新する gating の可能性を考慮し 30 日 + 12 時間。
  { jobName: 'token-refresh', maxSilentHours: 30 * 24 + 12 },
  // Phase 7 (2026-05-01): cron_run_logs auto cleanup (1 日 1 回 03:00 JST)。
  // deploy 直後の取りこぼし (1 日のみ skip) を許容する余裕を含む。
  { jobName: 'cron-cleanup', maxSilentHours: 30 },
  // 自前 friend↔Shopify customer 連携 (2026-06-06, Phase 3): account_link_codes 期限切れ OTP cleanup
  // (1 日 1 回 03:10 JST)。 機能 gate off でも空テーブルに対し毎日 heartbeat を記録するため監視可。
  { jobName: 'account-link-cleanup', maxSilentHours: 30 },
  // ③ webhook 冪等テーブル TTL prune (2026-06-26): webhook_deliveries の 72h 超を削除
  // (1 日 1 回 03:20 JST)。 毎日 heartbeat を記録するため、 停止すれば 30h で検知。
  { jobName: 'webhook-delivery-cleanup', maxSilentHours: 30 },
  // 会話ログ retention prune (2026-06-28, D6): messages_log/conversation_logs の 24ヶ月超を削除
  // (1 日 1 回 03:30 JST)。 毎日 heartbeat を記録するため、 停止すれば 30h で検知。
  { jobName: 'conversation-log-cleanup', maxSilentHours: 30 },
  // ai-models-catalog-sync は conditionalRules へ移動 (2026-08-11):
  // secret 未設定 = 意図的 dormant の環境で毎朝アラートが鳴り続けるのは
  // 可視化でなくノイズだった (2026-08-09〜 実発生)。secret が揃うと自動で監視復帰。
  // 自動 update 戦略 #2 (2026-05-26): Cloudflare developer changelog sync
  // 1 日 1 回 04:30 JST。 認証不要なので production で sync 失敗が継続的に発生したら
  // RSS feed の URL 変更 or 大規模障害の signal。
  // 2026-08-11: 4 feed 購読化に伴い partial を生存扱いに。1 feed だけの恒久 404
  // (今回の URL 再編と同種のイベント) で毎朝の silence 誤警報が再発するのを防ぐ。
  // 全 feed 失敗 (= error) は引き続き沈黙として検知される。
  { jobName: 'cloudflare-changelog-sync', maxSilentHours: 30, treatPartialAsAlive: true },
  // 採点ループ Round 1 (2026-06-28, D10): withHeartbeat 済だが DEFAULT_RULES 未登録だった 7 本を追加。
  // いずれも index.ts scheduled() で毎 tick (5分毎) jobs.push される (gating は service 内部の
  // no-op success のため heartbeat は毎 tick 記録) → 2h silent で異常。
  { jobName: 'broadcast-insights-fetch', maxSilentHours: 2 }, // 配信済 broadcast の Insight 集計 (per-tick)
  { jobName: 'audit-failure-monitor', maxSilentHours: 2 },    // audit_logs failure spike 監視 (per-tick)
  { jobName: 'birthday-greetings', maxSilentHours: 2 },       // 誕生月 push (per-tick, 内部 gating)
  { jobName: 'membership-promotion-sanity', maxSilentHours: 2 }, // 月次 promotion safety net (per-tick, 内部 gating)
  { jobName: 'loyalty-rank-reeval', maxSilentHours: 2 },      // 月次 rank 再判定 (per-tick, 内部 gating)
  { jobName: 'friend-customer-link', maxSilentHours: 2 },     // friend↔customer 自動リンク (per-tick, 内部 gating)
  // line-quota-monitor は JST 時刻境界 (毎時 0-4 分窓) のみ push = ~毎時 1 回 heartbeat。
  // 単発の hourly 取りこぼし (deploy 等) で誤検知しないよう 3h 許容。
  { jobName: 'line-quota-monitor', maxSilentHours: 3 },
  // WI-2 (2026-07-14, 採点R3): サブスク決済リマインド + 決済失敗リカバリ。gate OFF /
  // 送信窓外でも毎 tick heartbeat (skippedGating / skippedWindow メトリクス) を記録する
  // ため常時監視可。2h silent = 異常 (他の per-tick cron と同基準)。
  { jobName: 'teiki-billing-reminder', maxSilentHours: 2 },
];

/**
 * 条件付きルール: **Flow 連携を実際に配線した環境でだけ**有効になる監視。
 *
 * `teiki-flow-ingest` は cron ではなく Shopify Flow からの受信 (routes/shopify.ts) で
 * 記録される。DEFAULT_RULES に静的に置くと、Flow を使わない環境 (OSS の既定・他ブランド) で
 * 「一度も記録が無い = 即アラート」になり永久に鳴り続ける。
 *
 * 逆に配線済みの環境では沈黙こそが最重要のシグナルになる: 受信口は secret 不一致で 401 を
 * 返し続けても Flow 側のログにしか出ないため、**全送信が失敗していても D1 からは
 * 「まだ発火していない」と区別できない** (実測 0 件と同じ見え方)。
 * 稼働契約数 × 周期からは日に数件の受信が期待できるので、72h の沈黙は異常と断定してよい。
 */
export function conditionalRules(env: CronMonitorEnv): CronMonitorRule[] {
  const rules: CronMonitorRule[] = [];

  const ingestOn =
    env.SUBSCRIPTION_INGEST_ENABLED === 'true' || env.SUBSCRIPTION_MENU_ENABLED === 'true';
  // secret 未設定 = 受信口が全て 401 を返す = そもそも配線されていない
  if (ingestOn && env.TEIKI_FLOW_SECRET) {
    rules.push({ jobName: 'teiki-flow-ingest', maxSilentHours: 72 });
  }

  // 自動 update 戦略 #1 (2026-05-26): Cloudflare AI models catalog sync (1 日 1 回 04:00 JST)。
  // secret 未設定の環境では sync が skipped heartbeat のみで success が永久に出ないため、
  // 静的ルールだと「意図的に dormant」な環境で毎朝アラートが鳴り続ける
  // (2026-08-09〜 CLOUDFLARE_API_TOKEN 待ちの期間に実発生)。
  // secret が両方揃った環境 = sync が実走する設計の環境でのみ監視する。
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) {
    rules.push({ jobName: 'ai-models-catalog-sync', maxSilentHours: 30 });
  }

  // shopify-customer-sync (2026-08-11 cron silence 調査): per-tick 差分同期。
  // SHOPIFY_STORE_DOMAIN 未設定の環境では毎 tick skipped が記録されるだけなので監視しない。
  // 設定済み環境で 2h クリーン成功が無い = 差分同期が 24 tick 連続で完走していない = 異常。
  // treatPartialAsAlive は付けない: この job の partial 定常は「同期が完了しない」そのもの
  // なので、沈黙として検知されるべき (changelog-sync の 1-feed 恒久 404 とは性質が異なる)。
  if (env.SHOPIFY_STORE_DOMAIN) {
    rules.push({ jobName: 'shopify-customer-sync', maxSilentHours: 2 });
  }

  return rules;
}

// ============================================================
// 公開 API
// ============================================================

export async function processCronMonitor(
  env: CronMonitorEnv,
  options: CronMonitorOptions = {},
): Promise<CronMonitorResult> {
  const now = options.now ?? new Date();
  const rules = options.rules ?? [...DEFAULT_RULES, ...conditionalRules(env)];
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
      lastRun = rule.treatPartialAsAlive
        ? await getLastLiveRun(env.DB, rule.jobName)
        : await getLastSuccessfulRun(env.DB, rule.jobName);
    } catch (err) {
      // DB 失敗は監視自体を止めない。alert 判定はスキップ。
      console.error(
        '[cron-monitor] last-run lookup failed for',
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
