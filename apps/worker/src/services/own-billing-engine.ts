/**
 * Phase 3 自社課金基盤 — 課金エンジン中核 (WI-4 step 2)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md (v6, 全5次元90+)
 *
 * 実装範囲 (§13 step 2): claim ライフサイクル (§3) / resolveBillableCycle (§4.0) /
 * サイクル再同期 / 同期エラーレーン (§6.5) / due 発行の I-2 順序 (§5.1)。
 * webhook 4 系統・dunning matrix・通知は step 3。
 *
 * 原則 (設計書から):
 *   - I-2: 全発行は「canIssueAttempt → resync → resolveBillableCycle → claim → 発行」の順
 *   - no-parallel-attempt: attempt_gid を持つ claim からの CAS 再入は旧 attempt の terminal
 *     確定照会後のみ (pending/challenged → 再入不可 / succeeded → 昇格 / failed → CAS 可)
 *   - I-6: 14日 staleness は resolveBillableCycle 内で強制 + dunning_state 解放を対称化
 *   - cadence-by-scheduleEdit: 予定日列は anchor_date + k×interval 固定。success/skip 処理で
 *     次サイクルを明示スケジュール (step 2 では skip/放棄経路のみ。success は step 3)
 *   - Workers ランタイム: crypto.subtle はオブジェクト経由で直接呼ぶ (destructure 禁止)
 */

// ─── Shopify API 抽象 (実装は step 3 で adapter を接続。テストは fake を注入) ───

export interface BillingCycleInfo {
  cycleIndex: number;
  /** billingAttemptExpectedDate (ISO)。サイクル終端 = 課金予定日 (§1) */
  expectedDate: string;
  billed: boolean;
  skipped: boolean;
}

export type AttemptTerminalStatus = 'pending' | 'challenged' | 'succeeded' | 'failed';

export interface SyncAttemptResult {
  ok: boolean;
  attemptGid?: string;
  /** 同期 userError code (THROTTLED / BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE 等) */
  userErrorCode?: string;
  error?: string;
}

export interface ShopifyBillingApi {
  /** 契約の未解決サイクル列 (最古から昇順)。未 billed・未 skipped を含む */
  listCycles(contractGid: string): Promise<BillingCycleInfo[]>;
  /** 単一サイクルの課金日を明示設定 (§1 scheduleEdit) */
  scheduleCycleDate(contractGid: string, cycleIndex: number, billingDateIso: string): Promise<{ ok: boolean; error?: string }>;
  /** サイクルを skip / unskip */
  setCycleSkip(contractGid: string, cycleIndex: number, skip: boolean): Promise<{ ok: boolean; error?: string }>;
  /** subscriptionBillingAttemptCreate (idempotencyKey は Shopify exactly-once) */
  createAttempt(contractGid: string, cycleIndex: number, idempotencyKey: string): Promise<SyncAttemptResult>;
  /** attempt の現況照会 (CAS 再入前提条件・失効 sweep 用) */
  getAttemptStatus(attemptGid: string): Promise<AttemptTerminalStatus | null>;
}

export interface OwnContractRow {
  contract_gid: string;
  shopify_customer_id: string;
  status: string;
  current_cycle_index: number | null;
  current_cycle_scheduled_date: string | null;
  anchor_date: string;
  interval_unit: string;
  interval_count: number;
  dunning_state: string;
  next_retry_date: string | null;
}

export interface ClaimRow {
  contract_gid: string;
  cycle_key: string;
  status: string;
  retry_policy: string;
  attempt_no: number;
  attempt_gid: string | null;
  idempotency_key: string;
}

/** Discord 等への alert 送出 (step 2 では console + 呼び出し側 hook。実配線は step 4 監視) */
export type AlertFn = (message: string) => void | Promise<void>;

// ─── ユーティリティ ───

/** anchor_date + k×interval (DAY のみ §0)。日付は YYYY-MM-DD (JST 日付文字列) で扱う */
export function anchorPlus(anchorDate: string, k: number, intervalCount: number): string {
  const base = new Date(`${anchorDate}T00:00:00Z`);
  const d = new Date(base.getTime() + k * intervalCount * 86400_000);
  return d.toISOString().slice(0, 10);
}

/** ISO 日時 → JST の YYYY-MM-DD */
export function toJstDateOnly(iso: string): string {
  const t = new Date(iso);
  return new Date(t.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** idempotency key = SHA-256("own-billing:{gid}:{cycle_key}:{attempt_no}") (§3) */
export async function buildIdempotencyKey(
  contractGid: string,
  cycleKey: string,
  attemptNo: number,
): Promise<string> {
  const data = new TextEncoder().encode(`own-billing:${contractGid}:${cycleKey}:${attemptNo}`);
  // crypto.subtle はオブジェクト経由で直接呼ぶ (CLAUDE.md Workers ルール: destructure 禁止)
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ─── claim ライフサイクル (§3) ───

export async function getClaim(
  db: D1Database,
  contractGid: string,
  cycleKey: string,
): Promise<ClaimRow | null> {
  return db
    .prepare(`SELECT * FROM billing_cycle_claims WHERE contract_gid = ? AND cycle_key = ?`)
    .bind(contractGid, cycleKey)
    .first<ClaimRow>();
}

/**
 * 「未claim」= status ∈ {attempting, succeeded, skipped} の行が無いこと (§3)。
 * true = このサイクルへの発行はブロックされる。
 */
export function claimBlocksIssue(claim: ClaimRow | null): boolean {
  if (!claim) return false;
  if (claim.status === 'attempting' || claim.status === 'succeeded' || claim.status === 'skipped') {
    return true;
  }
  // retry_policy=hold は resolveBillableCycle の対象からも除外 (§6.5)
  if (claim.retry_policy === 'hold') return true;
  return false;
}

export type ClaimAcquireResult =
  | { acquired: true; claim: ClaimRow }
  | { acquired: false; reason: 'blocked' | 'pending_old_attempt' | 'lost_race' | 'promoted_succeeded' };

/**
 * claim 取得 (INSERT または CAS 再入 §3)。
 * - 新規: INSERT (PK 競合 = 並行敗者 → lost_race)
 * - CAS 再入 (failed/failed_no_attempt/abandoned): no-parallel-attempt 原則 —
 *   attempt_gid があれば旧 attempt を照会し、pending/challenged → 再入不可、
 *   succeeded → claim を succeeded 昇格 (発行しない)、failed 確定のみ attempt_no++ で CAS。
 * - THROTTLED next_tick 再入のみ attempt_no 据え置き・同一 key (§6.5、CAS 一般規則の明示例外)
 */
export async function acquireClaim(
  db: D1Database,
  api: ShopifyBillingApi,
  contractGid: string,
  cycleKey: string,
  nowIso: string,
): Promise<ClaimAcquireResult> {
  const existing = await getClaim(db, contractGid, cycleKey);

  if (existing && claimBlocksIssue(existing)) return { acquired: false, reason: 'blocked' };

  if (!existing) {
    const idempotencyKey = await buildIdempotencyKey(contractGid, cycleKey, 1);
    try {
      await db
        .prepare(
          `INSERT INTO billing_cycle_claims
             (contract_gid, cycle_key, status, retry_policy, attempt_no, idempotency_key, claimed_at)
           VALUES (?, ?, 'attempting', 'none', 1, ?, ?)`,
        )
        .bind(contractGid, cycleKey, idempotencyKey, nowIso)
        .run();
    } catch (e: unknown) {
      // PK 競合 (並行敗者) のみ lost_race。D1 障害は偽装せず上げる (呼び出し側の契約単位
      // try/catch が受ける — 障害を「発行済みかも」と誤読させない)
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(msg)) {
        return { acquired: false, reason: 'lost_race' };
      }
      throw e;
    }
    const claim = await getClaim(db, contractGid, cycleKey);
    if (!claim || claim.status !== 'attempting') return { acquired: false, reason: 'lost_race' };
    return { acquired: true, claim };
  }

  // CAS 再入対象: failed / failed_no_attempt / abandoned
  // no-parallel-attempt: 旧 attempt が非 terminal なら再入不可
  if (existing.attempt_gid) {
    const st = await api.getAttemptStatus(existing.attempt_gid);
    if (st === 'pending' || st === 'challenged') {
      return { acquired: false, reason: 'pending_old_attempt' };
    }
    if (st === 'succeeded') {
      await db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'succeeded', resolved_at = ?
             WHERE contract_gid = ? AND cycle_key = ? AND status = ?`,
        )
        .bind(nowIso, contractGid, cycleKey, existing.status)
        .run();
      return { acquired: false, reason: 'promoted_succeeded' };
    }
    // failed 確定 (null = 照会不能は fail-closed で再入しない)
    if (st === null) return { acquired: false, reason: 'pending_old_attempt' };
  }

  // THROTTLED next_tick: attempt_no 据え置き・同一 key (§6.5 明示例外)
  const isNextTick = existing.status === 'failed_no_attempt' && existing.retry_policy === 'next_tick';
  const nextAttemptNo = isNextTick ? existing.attempt_no : existing.attempt_no + 1;
  const idempotencyKey = isNextTick
    ? existing.idempotency_key
    : await buildIdempotencyKey(contractGid, cycleKey, nextAttemptNo);

  const res = await db
    .prepare(
      `UPDATE billing_cycle_claims
          SET status = 'attempting', retry_policy = 'none', attempt_no = ?,
              idempotency_key = ?, attempt_gid = NULL, claimed_at = ?, resolved_at = NULL
        WHERE contract_gid = ? AND cycle_key = ?
          AND status IN ('failed', 'failed_no_attempt', 'abandoned')`,
    )
    .bind(nextAttemptNo, idempotencyKey, nowIso, contractGid, cycleKey)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) return { acquired: false, reason: 'lost_race' };
  const claim = await getClaim(db, contractGid, cycleKey);
  if (!claim) return { acquired: false, reason: 'lost_race' };
  return { acquired: true, claim };
}

/** attempt 発行成功の記録 (attempt_gid を保持。結果は webhook / reconciliation が確定) */
export async function recordAttemptIssued(
  db: D1Database,
  contractGid: string,
  cycleKey: string,
  attemptGid: string,
  alert?: AlertFn,
): Promise<void> {
  const res = await db
    .prepare(
      `UPDATE billing_cycle_claims SET attempt_gid = ?
        WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
    )
    .bind(attemptGid, contractGid, cycleKey)
    .run();
  if ((res.meta?.changes ?? 0) !== 1 && alert) {
    // 並行遷移等で gid が記録できなかった — 発行済み attempt の証跡が claim に残らないため
    // alert (決着は reconciliation の idempotencyKey 逆引き。gid をログにも残す)
    await alert(
      `own-billing: 契約 ${contractGid} cycle ${cycleKey} の attempt_gid 記録に失敗 (attempt=${attemptGid}) — reconciliation 待ち`,
    );
  }
}

/**
 * 同期エラーレーン (§6.5)。attempt が同期 userError で作られなかった場合の claim 処置。
 * 戻り値 = 処置区分 (呼び出し側で alert / 状態再同期を行う)。
 */
export type SyncErrorLane = 'next_tick' | 'hold' | 'abandoned_state_resync';

export async function applySyncError(
  db: D1Database,
  contractGid: string,
  cycleKey: string,
  userErrorCode: string,
  nowIso: string,
): Promise<SyncErrorLane> {
  if (userErrorCode === 'THROTTLED') {
    await db
      .prepare(
        `UPDATE billing_cycle_claims
            SET status = 'failed_no_attempt', retry_policy = 'next_tick', resolved_at = ?
          WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
      )
      .bind(nowIso, contractGid, cycleKey)
      .run();
    return 'next_tick';
  }
  if (userErrorCode === 'CONTRACT_PAUSED' || userErrorCode === 'CONTRACT_TERMINATED') {
    await db
      .prepare(
        `UPDATE billing_cycle_claims
            SET status = 'abandoned', retry_policy = 'none', resolved_at = ?
          WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
      )
      .bind(nowIso, contractGid, cycleKey)
      .run();
    // 状態再同期 (§6.5): Shopify 実状態へ契約 status を降格 — 翌日以降の due 再列挙と
    // Shopify への無限再発行ループを止める (実状態の完全同期は contracts webhook / 日次)
    const newStatus = userErrorCode === 'CONTRACT_PAUSED' ? 'paused' : 'cancelled';
    await db
      .prepare(
        `UPDATE own_sub_contracts SET status = ?, updated_at = ?
          WHERE contract_gid = ? AND status = 'active'`,
      )
      .bind(newStatus, nowIso, contractGid)
      .run();
    return 'abandoned_state_resync';
  }
  // BCCBED / 未知同期エラー → hold (自動再発行なし + alert。ops 解除 op で復帰 §6.5)。
  // 契約側も ops_hold (S4o) にして due 対象から外す — hold claim への毎 tick 空撃ちと
  // resolve 経由の副作用を構造的に止める (解除 op が dunning_state→none を戻す §6.5)
  await db
    .prepare(
      `UPDATE billing_cycle_claims
          SET status = 'failed_no_attempt', retry_policy = 'hold', resolved_at = ?
        WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
    )
    .bind(nowIso, contractGid, cycleKey)
    .run();
  await db
    .prepare(
      `UPDATE own_sub_contracts SET dunning_state = 'ops_hold', updated_at = ?
        WHERE contract_gid = ? AND dunning_state IN ('none', 'retry_wait')`,
    )
    .bind(nowIso, contractGid)
    .run();
  return 'hold';
}

// ─── resolveBillableCycle (§4.0 — 全 attempt 発行経路が通る唯一の対象決定関数) ───

export interface ResolveResult {
  cycle: BillingCycleInfo | null;
  /** I-6 発動でサイクルを放棄した (副作用実施済み) */
  abandonedStale: boolean;
}

const STALE_DAYS = 14;

/**
 * 前提: canIssueAttempt() 通過後のみ呼ぶこと (§4.0 — step 3 の副作用を含む全動作が対象)。
 * step 3 (I-6): 最古サイクルが today より 14 日超過 → claim abandoned 化 + scheduleEdit(skip) +
 * 次アンカーへ scheduleEdit + alert + dunning_state 解放 (challenged→S5 は §5.2 の管轄のため
 * ここでは challenged 以外 — none/retry_wait — を 'none' へ戻す。v6 対称化)。
 */
export async function resolveBillableCycle(
  db: D1Database,
  api: ShopifyBillingApi,
  contract: OwnContractRow,
  todayJst: string,
  nowIso: string,
  alert: AlertFn,
  preloadedCycles?: BillingCycleInfo[],
): Promise<ResolveResult> {
  // resync 直後の呼出しは取得済み cycles を受け取り listCycles を 1 契約 1 回に統合する
  // (Workers Free 50 subrequests 対策 + 2 回照会間の不整合窓の排除)
  const cycles = preloadedCycles ?? (await api.listCycles(contract.contract_gid));
  const unresolved = cycles
    .filter((cy) => !cy.billed && !cy.skipped)
    .sort((a, b) => a.cycleIndex - b.cycleIndex);
  const oldest = unresolved[0];
  if (!oldest) return { cycle: null, abandonedStale: false };

  // §6.5: retry_policy='hold' の claim を持つサイクルは resolve の対象から除外 (I-6 判定より
  // 前に読む — ops 解除 op の管轄サイクルを 14 日経過で自動放棄しない = 課金喪失防止)
  const oldestClaim = await getClaim(db, contract.contract_gid, String(oldest.cycleIndex));
  if (oldestClaim && oldestClaim.retry_policy === 'hold') {
    return { cycle: null, abandonedStale: false };
  }

  const scheduled = toJstDateOnly(oldest.expectedDate);
  if (scheduled > todayJst) return { cycle: null, abandonedStale: false };

  const ageDays = Math.floor(
    (new Date(`${todayJst}T00:00:00Z`).getTime() - new Date(`${scheduled}T00:00:00Z`).getTime()) /
      86400_000,
  );
  if (ageDays > STALE_DAYS) {
    // I-6: 放棄。claim abandoned 化 → skip → 次アンカー schedule → dunning 解放 → alert
    const cycleKey = String(oldest.cycleIndex);
    await db
      .prepare(
        `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
          WHERE contract_gid = ? AND cycle_key = ?
            AND status IN ('attempting', 'failed', 'failed_no_attempt')`,
      )
      .bind(nowIso, contract.contract_gid, cycleKey)
      .run();
    // scheduleEdit/skip の失敗は握り潰さず cadence_repair_needed → 日次修復 (§4.0)
    const skipRes = await api.setCycleSkip(contract.contract_gid, oldest.cycleIndex, true);
    const next = unresolved[1];
    let schedRes: { ok: boolean; error?: string } = { ok: true };
    if (next) {
      schedRes = await api.scheduleCycleDate(
        contract.contract_gid,
        next.cycleIndex,
        nextAnchorAfter(contract, todayJst),
      );
    }
    if (!skipRes.ok || !schedRes.ok) {
      await markCadenceRepairNeeded(db, contract.contract_gid, nowIso);
      await alert(
        `own-billing: 契約 ${contract.contract_gid} の I-6 放棄で scheduleEdit/skip が失敗 (repair 待ち): ${skipRes.error ?? ''} ${schedRes.error ?? ''}`,
      );
    }
    // dunning 解放の対称化 (v6 §4.0): challenged は §5.2 (放棄+S5化) の管轄。それ以外は none へ
    if (contract.dunning_state !== 'challenged') {
      await db
        .prepare(
          `UPDATE own_sub_contracts
              SET dunning_state = 'none', dunning_attempts = 0, next_retry_date = NULL,
                  dunning_deadline_at = NULL, updated_at = ?
            WHERE contract_gid = ? AND dunning_state IN ('none', 'retry_wait')`,
        )
        .bind(nowIso, contract.contract_gid)
        .run();
    }
    await alert(
      `own-billing I-6: 契約 ${contract.contract_gid} の cycle ${oldest.cycleIndex} (予定 ${scheduled}) を 14日超過で放棄 (skip + 次アンカー再スケジュール)`,
    );
    return { cycle: null, abandonedStale: true };
  }

  return { cycle: oldest, abandonedStale: false };
}

export async function markCadenceRepairNeeded(
  db: D1Database,
  contractGid: string,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE own_sub_contracts SET cadence_repair_needed = 1, updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(nowIso, contractGid)
    .run();
}

/** todayJst より後の最初のアンカー日 (anchor + k×interval > today) */
export function nextAnchorAfter(contract: OwnContractRow, todayJst: string): string {
  const interval = Math.max(1, contract.interval_count);
  const anchorMs = new Date(`${contract.anchor_date}T00:00:00Z`).getTime();
  const todayMs = new Date(`${todayJst}T00:00:00Z`).getTime();
  const elapsed = Math.floor((todayMs - anchorMs) / 86400_000);
  const k = elapsed < 0 ? 0 : Math.floor(elapsed / interval) + 1;
  return anchorPlus(contract.anchor_date, k, interval);
}

// ─── サイクル再同期 (§5.4 日次 / 全 webhook 後) ───

export async function resyncContractCycle(
  db: D1Database,
  api: ShopifyBillingApi,
  contractGid: string,
  nowIso: string,
): Promise<{ cycleIndex: number | null; scheduledDate: string | null; cycles: BillingCycleInfo[] }> {
  const cycles = await api.listCycles(contractGid);
  const oldest = cycles
    .filter((cy) => !cy.billed && !cy.skipped)
    .sort((a, b) => a.cycleIndex - b.cycleIndex)[0];
  const cycleIndex = oldest ? oldest.cycleIndex : null;
  const scheduledDate = oldest ? toJstDateOnly(oldest.expectedDate) : null;
  await db
    .prepare(
      `UPDATE own_sub_contracts
          SET current_cycle_index = ?, current_cycle_scheduled_date = ?, updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(cycleIndex, scheduledDate, nowIso, contractGid)
    .run();
  return { cycleIndex, scheduledDate, cycles };
}

// ─── due 発行 (§5.1 — I-2 の順序で 1 契約を処理) ───

export type IssueOutcome =
  | 'issued'
  | 'no_due_cycle'
  | 'claim_blocked'
  | 'promoted_succeeded'
  | 'stale_abandoned'
  | 'sync_error_next_tick'
  | 'sync_error_hold'
  | 'sync_error_state_resync'
  | 'stuck_unrecorded'
  | 'unsupported_interval'
  | 'gate_denied';

/**
 * 1 契約の due 発行 (I-2: canIssue は呼び出し側で評価済みの前提で、本関数は
 * resync → resolve → claim → 発行 を行う)。gate false の契約はこの関数に到達させない
 * (claim を作らず resolve も呼ばない — §5.1 / §10.1⑨)。
 */
export async function issueForContract(
  db: D1Database,
  api: ShopifyBillingApi,
  contract: OwnContractRow,
  todayJst: string,
  nowIso: string,
  alert: AlertFn,
): Promise<IssueOutcome> {
  // §0: DAY 以外はサポート外 (移行 intake が担保するが、エンジン側でも防衛 — WEEK/MONTH 行が
  // 混入した場合に誤った日数算術で scheduleEdit を発行しない)
  if (contract.interval_unit !== 'DAY') {
    await alert(
      `own-billing: 契約 ${contract.contract_gid} は interval_unit=${contract.interval_unit} (DAY 以外) のため発行対象外 (移行保留リスト行き §0)`,
    );
    return 'unsupported_interval';
  }

  const resynced = await resyncContractCycle(db, api, contract.contract_gid, nowIso);
  const resolved = await resolveBillableCycle(
    db, api, contract, todayJst, nowIso, alert, resynced.cycles,
  );
  if (resolved.abandonedStale) return 'stale_abandoned';
  if (!resolved.cycle) return 'no_due_cycle';

  const cycleKey = String(resolved.cycle.cycleIndex);
  // §4.0 step 4: 旧サイクルの未解決 claim (failed/failed_no_attempt) は対象サイクルの
  // claim 取得前に abandoned 化する (残骸が step 3 の遅延 webhook 分類を汚染しない)。
  // hold は ops 管轄のため対象外。
  await db
    .prepare(
      `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
        WHERE contract_gid = ? AND cycle_key <> ?
          AND status IN ('failed', 'failed_no_attempt') AND retry_policy <> 'hold'`,
    )
    .bind(nowIso, contract.contract_gid, cycleKey)
    .run();

  const acquired = await acquireClaim(db, api, contract.contract_gid, cycleKey, nowIso);
  if (!acquired.acquired) {
    // 照会昇格 (取り逃した success の発見) は独立 outcome で可視化する。
    // I-4 (dunning リセット・次サイクル scheduleEdit) の接続は step 3 の success 処理に
    // 一元化する — ここで発見された昇格も step 3 実装時に同処理を呼ぶこと (TODO: step 3)
    if (acquired.reason === 'promoted_succeeded') return 'promoted_succeeded';
    return 'claim_blocked';
  }

  const result = await api.createAttempt(
    contract.contract_gid,
    resolved.cycle.cycleIndex,
    acquired.claim.idempotency_key,
  );
  if (result.ok && result.attemptGid) {
    await recordAttemptIssued(db, contract.contract_gid, cycleKey, result.attemptGid, alert);
    return 'issued';
  }
  if (result.ok) {
    // ok なのに attemptGid 欠落 (adapter 応答パース不備等) — attempt は Shopify 側に存在し得る
    // ため同期エラーレーン (failed_no_attempt) に落とさない。claim は attempting 維持で
    // stuck claim として reconciliation (§5.3、idempotencyKey 逆引き) に決着を委ねる。
    // failed 化すると CAS 再入が attempt_gid 照会をスキップし二重課金構造になる。
    await alert(
      `own-billing: 契約 ${contract.contract_gid} cycle ${cycleKey} の createAttempt が ok だが attemptGid 欠落 — attempting 維持 (reconciliation 待ち)`,
    );
    return 'stuck_unrecorded';
  }
  const lane = await applySyncError(
    db,
    contract.contract_gid,
    cycleKey,
    result.userErrorCode ?? 'UNKNOWN',
    nowIso,
  );
  if (lane === 'next_tick') return 'sync_error_next_tick';
  if (lane === 'abandoned_state_resync') return 'sync_error_state_resync';
  await alert(
    `own-billing: 契約 ${contract.contract_gid} cycle ${cycleKey} が同期エラー (${result.userErrorCode ?? result.error ?? 'UNKNOWN'}) で hold (ops 解除 op で復帰)`,
  );
  return 'sync_error_hold';
}

/**
 * §5.1 due 対象契約の候補列挙。述語 = active ∧ dunning∈{none,retry_wait} ∧ 日付到達 ∧
 * 未claim (現在サイクルにブロック claim なし) ∧ quarantine 非収載 ∧ 移行窓 phase 除外 (v6)。
 * limit は候補上限 (既定 25 — 76 契約全量でも軽量)。1 tick の発行予算は呼び出し側
 * (processOwnBilling の MAX_ISSUE_PER_TICK) が「issueForContract を実行した件数」で管理する —
 * gate_denied 契約が候補スロットを恒久占有して allowlist 収載契約を飢餓させない (採点 R2 HIGH)。
 */
export async function listDueContracts(
  db: D1Database,
  todayJst: string,
  limit = 25,
): Promise<OwnContractRow[]> {
  const rows = await db
    .prepare(
      `SELECT c.* FROM own_sub_contracts c
        WHERE c.status = 'active'
          AND (
            (c.dunning_state = 'none' AND c.current_cycle_scheduled_date <= ?)
            OR (c.dunning_state = 'retry_wait' AND c.next_retry_date <= ?)
          )
          AND NOT EXISTS (
            SELECT 1 FROM billing_cycle_claims bc
             WHERE bc.contract_gid = c.contract_gid
               AND bc.cycle_key = CAST(c.current_cycle_index AS TEXT)
               AND (bc.status IN ('attempting', 'succeeded', 'skipped')
                    OR bc.retry_policy = 'hold')
          )
          AND NOT EXISTS (
            SELECT 1 FROM own_billing_quarantine q
             WHERE q.contract_gid = c.contract_gid
          )
          AND NOT EXISTS (
            SELECT 1 FROM sub_migration_snapshots s
             WHERE s.own_contract_gid = c.contract_gid
               AND s.phase IN ('own_created_paused', 'hb_stop_requested',
                               'huckleberry_stopped', 'billing_aligned')
          )
        ORDER BY c.current_cycle_scheduled_date ASC, c.contract_gid ASC
        LIMIT ?`,
    )
    .bind(todayJst, todayJst, limit)
    .all<OwnContractRow>();
  return rows.results ?? [];
}
