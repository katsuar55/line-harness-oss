/**
 * Phase 3 自社課金基盤 — own-billing cron 骨格 (WI-4 step 1)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md (v6, 全5次元90+)
 *
 * 本ファイルは §8 の gate 機構 (canIssueAttempt の完全定義) と 5分 tick の heartbeat のみを
 * 実装する。課金ロジック (resolveBillableCycle / claim / attempt 発行) は §13 step 2 以降。
 *
 * live-safety (migration 071 未適用の本番でも安全):
 *   - SELF_BILLING_ENABLED !== 'true' の間は 071 の新テーブルへ一切アクセスしない
 *     (heartbeat の cron_run_logs は既存テーブル)。
 *   - gate ON 後も新テーブル読取は try/catch で fail-closed (エラー = 発行不可扱い)。
 *
 * §8 gate 仕様の要点:
 *   - canIssueAttempt() = SELF_BILLING_ENABLED='true' ∧ SELF_BILLING_ARMED_AT 設定済み
 *     ∧ ¬breaker_tripped (D1) ∧ allowlist match ∧ ¬excludelist match
 *   - allowlist: fail-closed (未設定/空/parse 不能 = ゼロ)。sentinel 'ALL'。trim (\r)
 *   - excludelist: secret リスト ∪ D1 quarantine の和集合。secret 側 parse 不能 =
 *     全契約除外 (fail-closed 側)
 */
import { insertCronRunLog } from '@line-crm/db';
import {
  listDueContracts,
  issueForContract,
  type ShopifyBillingApi,
} from './own-billing-engine.js';

export const OWN_BILLING_JOB_NAME = 'own-billing';

/**
 * 1 tick の発行予算 (issueForContract 実行数)。1 契約 ≈ Shopify 2 fetch + D1 ~7 query。
 * 同一 invocation を他 cron job と共有するため保守的に 3 (発行窓は 36 tick あるので
 * 76 契約の通常運用 ~2.5 due/日には十分。catch-up 時も窓内で捌ける)。
 */
export const MAX_ISSUE_PER_TICK = 3;

export interface OwnBillingEnv {
  DB: D1Database;
  SELF_BILLING_ENABLED?: string;
  SELF_BILLING_ARMED_AT?: string;
  SELF_BILLING_ALLOWLIST?: string;
  SELF_BILLING_EXCLUDELIST?: string;
  SUB_MIGRATION_ENABLED?: string;
}

/** 契約リスト secret の parse 結果 (§8 allowlist/excludelist 共通 parser) */
export type ContractListParse =
  | { kind: 'all' }
  | { kind: 'list'; set: Set<string> }
  | { kind: 'empty' }
  | { kind: 'invalid' };

/**
 * トークンとして許容する文字。Shopify gid (gid://shopify/SubscriptionContract/123) と
 * 素の数値 ID を通し、JSON 断片・空白入り・制御文字は invalid に落とす。
 */
const TOKEN_RE = /^[A-Za-z0-9:/_.-]+$/;

export function parseContractList(raw: string | undefined | null): ContractListParse {
  if (raw === undefined || raw === null) return { kind: 'empty' };
  // 改行も区切り文字として扱う (review HIGH: token 内の \r\n を除去する方式だと改行区切り
  // リストが 1 個の偽トークンに結合され excludelist が fail-open になる)。
  // PowerShell パイプ投入の末尾 CRLF trap ('ALL\r' 等) もこの分割で自然に吸収される。
  const tokens = raw
    .split(/[,\r\n]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { kind: 'empty' };
  if (tokens.length === 1 && tokens[0] === 'ALL') return { kind: 'all' };
  const set = new Set<string>();
  for (const t of tokens) {
    // 'ALL' が他トークンと併記された場合も invalid (意図の曖昧な設定を通さない)
    if (t === 'ALL' || !TOKEN_RE.test(t)) return { kind: 'invalid' };
    set.add(t);
  }
  return { kind: 'list', set };
}

/** gate の静的 (env のみ・D1 非依存) 評価結果 */
export interface StaticGateStatus {
  enabled: boolean;
  armed: boolean;
  allowlist: ContractListParse;
  excludelistSecret: ContractListParse;
}

export function readStaticGates(env: OwnBillingEnv): StaticGateStatus {
  return {
    // \r\n のみ除去して厳密一致 (PowerShell CRLF trap で 'true\r' が silent no-op になるのを
    // 防ぐ。空白は除去しない — ' true' 等の曖昧値は従来どおり OFF)
    enabled: (env.SELF_BILLING_ENABLED ?? '').replace(/[\r\n]/g, '') === 'true',
    armed: typeof env.SELF_BILLING_ARMED_AT === 'string' && env.SELF_BILLING_ARMED_AT.trim() !== '',
    allowlist: parseContractList(env.SELF_BILLING_ALLOWLIST),
    excludelistSecret: parseContractList(env.SELF_BILLING_EXCLUDELIST),
  };
}

/** D1 側 gate 状態 (breaker + quarantine)。migration 071 適用前は error に落ちる */
export interface D1GateStatus {
  breakerTripped: boolean;
  quarantine: Set<string>;
  error?: string;
}

export async function readD1Gates(db: D1Database): Promise<D1GateStatus> {
  try {
    const breaker = await db
      .prepare(`SELECT value FROM own_billing_state WHERE key = 'breaker_tripped_at'`)
      .first<{ value: string }>();
    const rows = await db
      .prepare(`SELECT contract_gid FROM own_billing_quarantine`)
      .all<{ contract_gid: string }>();
    const quarantine = new Set<string>((rows.results ?? []).map((r) => r.contract_gid));
    return { breakerTripped: breaker !== null, quarantine };
  } catch (e: unknown) {
    // fail-closed: 状態が読めない間は「breaker trip 中」と同等に扱い発行を止める
    const msg = e instanceof Error ? e.message : String(e);
    return { breakerTripped: true, quarantine: new Set(), error: msg };
  }
}

/**
 * §8 canIssueAttempt() の完全定義。全 attempt 発行経路 (§4.0 resolveBillableCycle の呼出しと
 * その副作用を含む) の唯一のガード。d1Gates は tick 冒頭で 1 回読み、契約ループへ渡す。
 */
export function canIssueAttempt(
  statics: StaticGateStatus,
  d1: D1GateStatus,
  contractGid: string,
): boolean {
  if (!statics.enabled) return false;
  if (!statics.armed) return false;
  if (d1.breakerTripped) return false;
  // allowlist: fail-closed — empty/invalid はゼロ収載と同義
  if (statics.allowlist.kind === 'empty' || statics.allowlist.kind === 'invalid') return false;
  if (statics.allowlist.kind === 'list' && !statics.allowlist.set.has(contractGid)) return false;
  // excludelist secret: parse 不能 = 全契約除外 (fail-closed 側)
  if (statics.excludelistSecret.kind === 'invalid') return false;
  if (statics.excludelistSecret.kind === 'list' && statics.excludelistSecret.set.has(contractGid)) {
    return false;
  }
  // excludelist の 'ALL' は全停止として尊重 (billing-kill 相当の契約単位表現)
  if (statics.excludelistSecret.kind === 'all') return false;
  if (d1.quarantine.has(contractGid)) return false;
  return true;
}

export interface OwnBillingResult {
  skippedGating?: boolean;
  armed?: boolean;
  breakerTripped?: boolean;
  allowlistKind?: ContractListParse['kind'];
  allowlistParsed?: number;
  excludelistKind?: ContractListParse['kind'];
  quarantineCount?: number;
  d1Error?: string;
  dueContracts?: number;
  processedContracts?: number;
  issueOutcomes?: Record<string, number>;
}

/** due 発行窓 (§5.1): JST 05:00-07:59 */
export function isIssueWindow(nowMs: number): boolean {
  const jstHour = new Date(nowMs + 9 * 3600_000).getUTCHours();
  return jstHour >= 5 && jstHour < 8;
}

/**
 * 5分 tick (§5)。step 2 = due 発行 (I-2 順序) まで実装。
 * sweep / reconciliation / 監視 / 通知は step 3-4。
 * gate OFF の間は 071 新テーブルに一切アクセスしない (migration 未適用でも安全)。
 * api 未注入 (本番 adapter は step 3 で接続) の間は発行系を実行しない。
 */
export async function processOwnBilling(
  env: OwnBillingEnv,
  deps: { api?: ShopifyBillingApi; nowMs?: number; alert?: (m: string) => void } = {},
): Promise<OwnBillingResult> {
  const statics = readStaticGates(env);

  if (!statics.enabled) {
    const result: OwnBillingResult = { skippedGating: true };
    await logRun(env.DB, 'skipped', result);
    return result;
  }

  // gate ON: D1 側 gate を読み、状態を heartbeat metrics へ可視化する。
  const d1 = await readD1Gates(env.DB);
  const result: OwnBillingResult = {
    armed: statics.armed,
    breakerTripped: d1.breakerTripped,
    allowlistKind: statics.allowlist.kind,
    allowlistParsed: statics.allowlist.kind === 'list' ? statics.allowlist.set.size : 0,
    excludelistKind: statics.excludelistSecret.kind,
    quarantineCount: d1.quarantine.size,
  };
  if (d1.error !== undefined) result.d1Error = d1.error;

  // ── due 発行 (§5.1、step 2)。I-2: gate false の契約は claim を作らず resolve も呼ばない
  const nowMs = deps.nowMs ?? Date.now();
  if (deps.api && d1.error === undefined && isIssueWindow(nowMs)) {
    const todayJst = new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
    const nowIso = new Date(nowMs + 9 * 3600_000).toISOString().replace('Z', '+09:00');
    const alert = deps.alert ?? ((m: string) => console.error(m));
    try {
      const due = await listDueContracts(env.DB, todayJst);
      const outcomes: Record<string, number> = {};
      // 発行予算 = issueForContract を実際に実行した件数 (Workers Free 50 subrequests 対策。
      // gate_denied は予算を消費しない — 候補スロット占有による allowlist 契約の飢餓を防ぐ)
      let processed = 0;
      for (const contract of due) {
        if (processed >= MAX_ISSUE_PER_TICK) break;
        if (!canIssueAttempt(statics, d1, contract.contract_gid)) {
          outcomes.gate_denied = (outcomes.gate_denied ?? 0) + 1;
          continue;
        }
        // ゼロコスト分岐は予算非消費 (R3): 非 DAY 契約が毎 tick 予算を食い潰して
        // 正常契約を飢餓させない (エンジン側の同ガードは防衛として残置)
        if (contract.interval_unit !== 'DAY') {
          outcomes.unsupported_interval = (outcomes.unsupported_interval ?? 0) + 1;
          continue;
        }
        processed++;
        // 契約単位のエラー隔離: 1 契約の決定的失敗が後続契約の発行を阻止しない
        try {
          const outcome = await issueForContract(env.DB, deps.api, contract, todayJst, nowIso, alert);
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        } catch (e: unknown) {
          outcomes.error = (outcomes.error ?? 0) + 1;
          alert(
            `own-billing: 契約 ${contract.contract_gid} の発行処理が失敗: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      result.dueContracts = due.length;
      result.processedContracts = processed;
      result.issueOutcomes = outcomes;
    } catch (e: unknown) {
      result.d1Error = e instanceof Error ? e.message : String(e);
    }
  }

  await logRun(env.DB, result.d1Error === undefined ? 'success' : 'partial', result, result.d1Error);
  return result;
}

async function logRun(
  db: D1Database,
  status: 'success' | 'skipped' | 'partial',
  metrics: OwnBillingResult,
  errorSummary?: string,
): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: OWN_BILLING_JOB_NAME,
      status,
      metrics,
      ...(errorSummary !== undefined ? { errorSummary } : {}),
    });
  } catch (e: unknown) {
    // heartbeat 失敗で cron 全体を落とさない (他 job と同じ best-effort)
    console.error(`own-billing: heartbeat write failed: ${e instanceof Error ? e.message : e}`);
  }
}
