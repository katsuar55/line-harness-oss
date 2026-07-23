/**
 * Phase 3 自社課金基盤 — webhook 4 系統 (WI-4 step 3)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md
 *   §6.1 success / §6.2 matrix / §6.3 challenged / §6.4 支払方法更新 /
 *   §6.6 顧客操作 / §4.1 閉包規則とその適用条件 / §3 claim ライフサイクル
 *
 * 対象 topic (4 系統):
 *   subscription_billing_attempts/{success,failure,challenged}
 *   subscription_contracts/{activate,pause,cancel,update}
 *   subscription_billing_cycles/{skip,unskip}
 *   customer_payment_methods/{create,update}
 *
 * ## 不変条件
 * - **no-parallel-attempt**: 新しい attempt を出すのは canIssue 通過 + engine の I-2 順序経由のみ。
 * - **§4.1 適用条件**: matrix を適用するのは「attempting claim を failed 化した failure」だけ。
 *   resolved 済み claim への遅延/再配送 failure は audit のみ (S5 後の遅延 decline が表外状態を
 *   作らない)。success は §6.5 の逆引きで常に救済する (取り逃し = 課金済み未計上が最悪)。
 * - **gate OFF でも受信・同期・結果回収は継続** (§8)。止まるのは Shopify を mutate する発行系のみ。
 */
import type { AlertFn, OwnContractRow, ClaimRow } from './own-billing-engine.js';
import {
  issueForContract,
  resyncContractCycle,
  nextAnchorAfter,
  toJstDateOnly,
} from './own-billing-engine.js';
import type { ShopifyBillingApiExt } from './own-billing-shopify-adapter.js';
import { decideDunning, normalizeErrorCode, type NoticeKind } from './own-billing-dunning.js';
import { enqueueNotice, type NoticePayload } from './own-billing-notify.js';

// challenged の 72h 期限は「リンク送付時刻」起点のため、設定するのは通知キューの送信成功時
// (own-billing-notify.ts の markSent)。本ファイルでは deadline を書かない。

/** 移行窓 (§7.0 / §2): この phase の間は再同期で契約 status を昇格させない */
const MIGRATION_WINDOW_PHASES = [
  'own_created_paused',
  'hb_stop_requested',
  'huckleberry_stopped',
  'billing_aligned',
];

export interface BillingWebhookDeps {
  db: D1Database;
  /** 実 API。未注入なら照会・発行を伴う分岐は縮退 (記録のみ) */
  api?: ShopifyBillingApiExt;
  /** §8 canIssueAttempt。Shopify を mutate する全経路の前段 */
  canIssue: (contractGid: string) => boolean;
  alert: AlertFn;
  nowMs: number;
}

export type WebhookOutcome =
  | 'unknown_contract'
  | 'no_claim'
  | 'claim_mismatch'
  | 'late_ignored'
  | 'success_applied'
  | 'failure_applied'
  | 'failure_as_success'
  | 'challenged_applied'
  | 'card_retry_issued'
  | 'contract_synced'
  | 'cycle_synced'
  | 'payment_recovery'
  | 'gate_denied'
  | 'noop';

// ─── payload parser (REST 形状。フィールド名のゆらぎを吸収する) ───

export interface AttemptWebhookPayload {
  attemptGid: string | null;
  contractGid: string | null;
  idempotencyKey: string | null;
  orderGid: string | null;
  errorCode: string | null;
  nextActionUrl: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 数値 ID を gid へ。既に gid ならそのまま */
function toGid(kind: string, v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  return s.startsWith('gid://') ? s : `gid://shopify/${kind}/${s}`;
}

/**
 * billing_attempts/* の payload を解析。
 * Shopify の REST webhook はフィールド名/大小文字がバージョン間で揺れるため、
 * 既知の候補を順に見る (設計書 §11「未較正は F に倒す」と同じ保守姿勢)。
 */
export function parseAttemptPayload(body: unknown): AttemptWebhookPayload {
  const b = asRecord(body) ?? {};
  const contractNested = asRecord(b.subscription_contract);
  const errNested = asRecord(b.processing_error) ?? asRecord(b.error);
  return {
    attemptGid: toGid('SubscriptionBillingAttempt', b.admin_graphql_api_id ?? b.id),
    contractGid:
      toGid(
        'SubscriptionContract',
        b.admin_graphql_api_subscription_contract_id ??
          b.subscription_contract_id ??
          contractNested?.admin_graphql_api_id ??
          contractNested?.id,
      ),
    idempotencyKey: str(b.idempotency_key ?? b.idempotencyKey),
    orderGid: toGid('Order', b.admin_graphql_api_order_id ?? b.order_id),
    errorCode: normalizeErrorCode(b.error_code ?? b.errorCode ?? errNested?.code),
    nextActionUrl: str(b.next_action_url ?? b.nextActionUrl ?? errNested?.next_action_url),
  };
}

// ─── 共通ヘルパー ───

async function loadContract(db: D1Database, contractGid: string): Promise<OwnContractRow | null> {
  return db
    .prepare(`SELECT * FROM own_sub_contracts WHERE contract_gid = ?`)
    .bind(contractGid)
    .first<OwnContractRow>();
}

async function isInMigrationWindow(db: D1Database, contractGid: string): Promise<boolean> {
  const placeholders = MIGRATION_WINDOW_PHASES.map(() => '?').join(', ');
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM sub_migration_snapshots
        WHERE own_contract_gid = ? AND phase IN (${placeholders})`,
    )
    .bind(contractGid, ...MIGRATION_WINDOW_PHASES)
    .first<{ x: number }>();
  return row !== null;
}

/**
 * §3 webhook 照合: idempotency_key 一次 + attempt_gid 検算。
 * - 両方から別々の claim が見つかったら不一致 (旧 attempt の再配送汚染) → null + mismatch
 * - どちらか一方でも一意に決まればそれを採用
 */
export async function matchClaim(
  db: D1Database,
  contractGid: string,
  payload: AttemptWebhookPayload,
): Promise<{ claim: ClaimRow | null; mismatch: boolean }> {
  let byKey: ClaimRow | null = null;
  let byGid: ClaimRow | null = null;
  if (payload.idempotencyKey) {
    byKey = await db
      .prepare(
        `SELECT * FROM billing_cycle_claims WHERE contract_gid = ? AND idempotency_key = ?`,
      )
      .bind(contractGid, payload.idempotencyKey)
      .first<ClaimRow>();
  }
  if (payload.attemptGid) {
    byGid = await db
      .prepare(`SELECT * FROM billing_cycle_claims WHERE contract_gid = ? AND attempt_gid = ?`)
      .bind(contractGid, payload.attemptGid)
      .first<ClaimRow>();
  }
  if (byKey && byGid && byKey.cycle_key !== byGid.cycle_key) {
    return { claim: null, mismatch: true };
  }
  return { claim: byKey ?? byGid, mismatch: false };
}

async function safeEnqueue(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  cycleKey: string,
  attemptNo: number,
  kind: NoticeKind,
  payload: NoticePayload,
  nowIso: string,
): Promise<void> {
  try {
    await enqueueNotice(
      deps.db,
      {
        contractGid: contract.contract_gid,
        cycleKey,
        attemptNo,
        kind,
        shopifyCustomerId: contract.shopify_customer_id,
        payload,
      },
      nowIso,
    );
  } catch (e: unknown) {
    // 通知キューが無い (migration 072 未適用) 等でも課金処理本体を巻き戻さない。
    // 「通知できなかった」ことは alert で人間に届ける。
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} の ${kind} 通知 enqueue に失敗: ${e instanceof Error ? e.message : e}`,
    );
  }
}

function jstIso(nowMs: number): string {
  return new Date(nowMs + 9 * 3600_000).toISOString().replace('Z', '+09:00');
}

function jstDate(nowMs: number): string {
  return new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
}

// ─── §6.1 success ───

/**
 * 成功処理。claim を無条件 succeeded 昇格 (attempting/failed/abandoned いずれからも) し、
 * I-4 (dunning リセット + 次サイクル scheduleEdit) を適用する。
 * システム起因 pause 中なら自動 activate + resume_notice、顧客都合 pause/cancel なら
 * 状態を維持して delivery_notice + 人間判断 alert (§6.6)。
 */
export async function applySuccess(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  claim: ClaimRow,
  orderGid: string | null,
): Promise<WebhookOutcome> {
  const nowIso = jstIso(deps.nowMs);
  const todayJst = jstDate(deps.nowMs);

  await deps.db
    .prepare(
      `UPDATE billing_cycle_claims
          SET status = 'succeeded', retry_policy = 'none', order_id = COALESCE(?, order_id),
              resolved_at = ?
        WHERE contract_gid = ? AND cycle_key = ?`,
    )
    .bind(orderGid, nowIso, contract.contract_gid, claim.cycle_key)
    .run();

  // I-4: dunning 全リセット (pending_new_card も消費 — 支払えたのでカード差替待ちは終了)
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts
          SET dunning_state = 'none', dunning_attempts = 0, next_retry_date = NULL,
              dunning_deadline_at = NULL, pending_new_card = 0, last_attempt_error = NULL,
              updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(nowIso, contract.contract_gid)
    .run();

  // pause/cancel 中の遅延 success の扱い (§6.1 / §6.3 / §6.6)
  const systemOriginPause =
    contract.status === 'paused' && contract.dunning_state !== 'none';
  if (contract.status === 'cancelled' || (contract.status === 'paused' && !systemOriginPause)) {
    // 顧客都合の停止/解約は維持。届ける旨だけ伝えて人間に判断を委ねる (自動返金しない)
    await safeEnqueue(deps, contract, claim.cycle_key, claim.attempt_no, 'delivery_notice', {}, nowIso);
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} (${contract.status}) で cycle ${claim.cycle_key} の遅延 success を受信 — 状態は維持。返金要否は人間判断`,
    );
    return 'success_applied';
  }
  if (systemOriginPause) {
    // dunning 起因の停止 = 支払えた以上ここに留めない。自動 activate + 再開通知
    await deps.db
      .prepare(`UPDATE own_sub_contracts SET status = 'active', updated_at = ? WHERE contract_gid = ?`)
      .bind(nowIso, contract.contract_gid)
      .run();
    await safeEnqueue(deps, contract, claim.cycle_key, claim.attempt_no, 'resume_notice', {}, nowIso);
  }

  // 次サイクルの明示スケジュール (cadence-by-scheduleEdit §4.0)。
  // Shopify を mutate するため canIssue 通過が前提 (kill 中は repair フラグに退避)。
  if (deps.api && deps.canIssue(contract.contract_gid)) {
    try {
      const { cycles } = await resyncContractCycle(
        deps.db,
        deps.api,
        contract.contract_gid,
        nowIso,
      );
      const next = cycles
        .filter((cy) => !cy.billed && !cy.skipped)
        .sort((a, b) => a.cycleIndex - b.cycleIndex)[0];
      if (next) {
        const target = nextAnchorAfter(contract, todayJst);
        const res = await deps.api.scheduleCycleDate(contract.contract_gid, next.cycleIndex, target);
        if (!res.ok) await markRepair(deps, contract.contract_gid, nowIso, res.error);
      }
    } catch (e: unknown) {
      await markRepair(deps, contract.contract_gid, nowIso, e instanceof Error ? e.message : String(e));
    }
  } else {
    // 発行系が止まっている間にカデンツを進めないため、修復フラグで日次ジョブに委ねる
    await markRepair(deps, contract.contract_gid, nowIso, 'gate_closed_or_no_api');
  }
  return 'success_applied';
}

async function markRepair(
  deps: BillingWebhookDeps,
  contractGid: string,
  nowIso: string,
  reason?: string,
): Promise<void> {
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts SET cadence_repair_needed = 1, updated_at = ? WHERE contract_gid = ?`,
    )
    .bind(nowIso, contractGid)
    .run();
  if (reason && reason !== 'gate_closed_or_no_api') {
    await deps.alert(
      `own-billing: 契約 ${contractGid} の次サイクル scheduleEdit が失敗 (日次 repair 待ち): ${reason}`,
    );
  }
}

export async function handleAttemptSuccess(
  deps: BillingWebhookDeps,
  body: unknown,
): Promise<WebhookOutcome> {
  const payload = parseAttemptPayload(body);
  if (!payload.contractGid) return 'noop';
  const contract = await loadContract(deps.db, payload.contractGid);
  if (!contract) return 'unknown_contract';

  const { claim, mismatch } = await matchClaim(deps.db, payload.contractGid, payload);
  if (mismatch || !claim) {
    // success の取り逃しは「課金済み未計上」= 最悪の欠損。必ず人間へ上げる (§6.5 逆引き救済)
    await deps.alert(
      `own-billing: 契約 ${payload.contractGid} の success webhook に対応する claim が特定できません (attempt=${payload.attemptGid ?? 'なし'} order=${payload.orderGid ?? 'なし'}) — 手動突合が必要`,
    );
    return mismatch ? 'claim_mismatch' : 'no_claim';
  }
  return applySuccess(deps, contract, claim, payload.orderGid);
}

// ─── §6.2 / §6.3 failure ───

export async function handleAttemptFailure(
  deps: BillingWebhookDeps,
  body: unknown,
): Promise<WebhookOutcome> {
  const payload = parseAttemptPayload(body);
  if (!payload.contractGid) return 'noop';
  const contract = await loadContract(deps.db, payload.contractGid);
  if (!contract) return 'unknown_contract';

  const { claim, mismatch } = await matchClaim(deps.db, payload.contractGid, payload);
  if (mismatch) {
    // 検算不一致の failure は**適用しない** (§3)。旧 attempt 再配送で現行サイクルを汚さない
    await deps.alert(
      `own-billing: 契約 ${payload.contractGid} の failure webhook が claim 検算不一致 — 適用せず記録のみ`,
    );
    return 'claim_mismatch';
  }
  if (!claim) return 'no_claim';

  // §4.1 適用条件: matrix を適用するのは attempting claim を failed 化する場合のみ
  if (claim.status !== 'attempting') return 'late_ignored';

  // failure が「3DS 要求」を伴う場合は failed 化せず challenged レーンへ (§3 claim 表)
  if (payload.nextActionUrl) {
    return applyChallenged(deps, contract, claim, payload.nextActionUrl);
  }

  const nowIso = jstIso(deps.nowMs);
  const todayJst = jstDate(deps.nowMs);

  // §6.3 明示例外: pending_new_card=1 なら matrix より先に「新カードで 1 回自動再試行」
  // (webhook-first ordering でも回収約束が成立する。B/E クラス直行で機会を失わない)
  const pendingNewCard = Number(contract.pending_new_card ?? 0) === 1;
  if (pendingNewCard) {
    await deps.db
      .prepare(
        `UPDATE billing_cycle_claims SET status = 'failed', resolved_at = ?
          WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
      )
      .bind(nowIso, contract.contract_gid, claim.cycle_key)
      .run();
    // フラグは「1 回の再試行機会」を表す。成否に関わらずここで消費する (無限再試行の防止)
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts SET pending_new_card = 0, updated_at = ? WHERE contract_gid = ?`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
    if (deps.api && deps.canIssue(contract.contract_gid)) {
      const reloaded = await loadContract(deps.db, contract.contract_gid);
      if (reloaded) {
        // I-2 順序 (resync → resolve → claim → 発行) は engine が保証する
        await issueForContract(deps.db, deps.api, reloaded, todayJst, nowIso, deps.alert);
        return 'card_retry_issued';
      }
    }
    // gate 閉塞中は再試行できない。次 tick の due 発行が拾えるよう retry_wait に置く
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts
            SET dunning_state = 'retry_wait', next_retry_date = ?, updated_at = ?
          WHERE contract_gid = ?`,
      )
      .bind(todayJst, nowIso, contract.contract_gid)
      .run();
    return 'gate_denied';
  }

  const decision = decideDunning({
    rawErrorCode: payload.errorCode,
    currentAttempts: Number(contract.dunning_attempts ?? 0),
    scheduledDateJst: contract.current_cycle_scheduled_date ?? todayJst,
    todayJst,
  });

  if (decision.treatAsSuccess) {
    // C クラス (INVOICE_ALREADY_PAID): 失敗として扱わず success 経路へ寄せる。
    // order_id は webhook に無いため null のまま = 双方向突合 (§8) が拾う
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} cycle ${claim.cycle_key} が INVOICE_ALREADY_PAID — success として計上 (order 突合が必要)`,
    );
    await applySuccess(deps, contract, claim, payload.orderGid);
    return 'failure_as_success';
  }

  await deps.db
    .prepare(
      `UPDATE billing_cycle_claims SET status = 'failed', resolved_at = ?
        WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
    )
    .bind(nowIso, contract.contract_gid, claim.cycle_key)
    .run();

  await deps.db
    .prepare(
      `UPDATE own_sub_contracts
          SET dunning_state = ?, dunning_attempts = ?, next_retry_date = ?,
              dunning_deadline_at = ?, last_attempt_error = ?,
              status = CASE WHEN ? = 1 THEN 'paused' ELSE status END,
              updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(
      decision.dunningState,
      decision.nextAttempts,
      decision.nextRetryDate,
      decision.deadlineAt,
      payload.errorCode,
      decision.pauseContract ? 1 : 0,
      nowIso,
      contract.contract_gid,
    )
    .run();

  if (decision.notice) {
    const noticePayload: NoticePayload = {};
    if (contract.current_cycle_scheduled_date) {
      noticePayload.scheduledDate = contract.current_cycle_scheduled_date;
    }
    if (decision.nextRetryDate) noticePayload.nextRetryDate = decision.nextRetryDate;
    if (decision.deadlineAt) noticePayload.deadlineDate = decision.deadlineAt.slice(0, 10);
    if (decision.pauseContract) noticePayload.isFinal = true;
    await safeEnqueue(
      deps, contract, claim.cycle_key, claim.attempt_no, decision.notice, noticePayload, nowIso,
    );
  }
  if (decision.alertOps) {
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} cycle ${claim.cycle_key} が ${decision.klass} クラス失敗 (${payload.errorCode ?? '不明 code'}) — 自動処理なし。人間の確認が必要`,
    );
  }
  return 'failure_applied';
}

// ─── §6.3 challenged ───

export async function applyChallenged(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  claim: ClaimRow,
  nextActionUrlFromPayload: string | null,
): Promise<WebhookOutcome> {
  const nowIso = jstIso(deps.nowMs);
  let url = nextActionUrlFromPayload;
  if (!url && deps.api && claim.attempt_gid) {
    const detail = await deps.api.getAttemptDetail(claim.attempt_gid);
    url = detail?.nextActionUrl ?? null;
  }

  // claim は attempting のまま維持 (§3: challenged は failed 化しない)。
  // deadline はここでは設定しない — 起点は「リンク送付時刻」(§5.6) なので、
  // 通知キューが実際に送信できた時点で own-billing-notify が設定する。
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts
          SET dunning_state = 'challenged', dunning_deadline_at = NULL, updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(nowIso, contract.contract_gid)
    .run();

  if (url) {
    await safeEnqueue(
      deps, contract, claim.cycle_key, claim.attempt_no, 'challenge_link', { nextActionUrl: url }, nowIso,
    );
  } else {
    // URL が取れないと顧客は認証できない。沈黙させず人間へ (§8 の「deadline 未設定 challenged」検出器と対)
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} cycle ${claim.cycle_key} が challenged だが nextActionUrl を取得できません — 認証リンクを送れていません`,
    );
  }
  return 'challenged_applied';
}

export async function handleAttemptChallenged(
  deps: BillingWebhookDeps,
  body: unknown,
): Promise<WebhookOutcome> {
  const payload = parseAttemptPayload(body);
  if (!payload.contractGid) return 'noop';
  const contract = await loadContract(deps.db, payload.contractGid);
  if (!contract) return 'unknown_contract';
  const { claim, mismatch } = await matchClaim(deps.db, payload.contractGid, payload);
  if (mismatch) return 'claim_mismatch';
  if (!claim) return 'no_claim';
  // §6.3: レーン起動は attempting claim を持つ場合のみ。resolved/abandoned への challenged は
  // 記録のみ (状態表 §4.1 に無い paused×challenged 等の組合せを作らない)
  if (claim.status !== 'attempting') return 'late_ignored';
  return applyChallenged(deps, contract, claim, payload.nextActionUrl);
}

// ─── contracts/{activate,pause,cancel,update} ───

const CONTRACT_STATUS_BY_TOPIC: Record<string, string | undefined> = {
  activate: 'active',
  pause: 'paused',
  cancel: 'cancelled',
  fail: 'failed',
  expire: 'expired',
};

export async function handleContractLifecycle(
  deps: BillingWebhookDeps,
  action: string,
  body: unknown,
): Promise<WebhookOutcome> {
  const b = asRecord(body) ?? {};
  const contractGid = toGid('SubscriptionContract', b.admin_graphql_api_id ?? b.id);
  if (!contractGid) return 'noop';
  const contract = await loadContract(deps.db, contractGid);
  if (!contract) return 'unknown_contract';
  const nowIso = jstIso(deps.nowMs);

  const target = CONTRACT_STATUS_BY_TOPIC[action];
  if (target) {
    // §2: 移行窓中は status 列を昇格させない (contracts/activate が §7 の順序制約を迂回して
    // D1 を先行 active 化する穴の封鎖)。cycle キャッシュのみ更新する。
    const inWindow = await isInMigrationWindow(deps.db, contractGid);
    const promoting = target === 'active';
    if (!(inWindow && promoting)) {
      await deps.db
        .prepare(`UPDATE own_sub_contracts SET status = ?, updated_at = ? WHERE contract_gid = ?`)
        .bind(target, nowIso, contractGid)
        .run();
    }
    // I-3: pause/cancel 受理時に未解決 claim を abandoned 化 (in-flight の遅延 success は
    // §6.6 の abandoned×success 規則が受ける)
    if (target === 'paused' || target === 'cancelled' || target === 'expired') {
      await deps.db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
            WHERE contract_gid = ? AND status IN ('attempting', 'failed', 'failed_no_attempt')`,
        )
        .bind(nowIso, contractGid)
        .run();
    }
  }

  // update: §6.4 防御 fallback — 失敗中契約で支払方法が変わっていれば復旧手順を評価
  if (action === 'update') {
    const newPm = toGid('CustomerPaymentMethod', b.payment_method_id ?? b.admin_graphql_api_payment_method_id);
    if (newPm && newPm !== contract.payment_method_gid) {
      await deps.db
        .prepare(
          `UPDATE own_sub_contracts SET payment_method_gid = ?, updated_at = ? WHERE contract_gid = ?`,
        )
        .bind(newPm, nowIso, contractGid)
        .run();
      const reloaded = await loadContract(deps.db, contractGid);
      if (reloaded && isFailingState(reloaded)) {
        return recoverAfterCardUpdate(deps, reloaded);
      }
    }
  }

  // cycle キャッシュの再同期 (照会は mutate ではないが、API 未注入なら省略)
  if (deps.api) {
    try {
      await resyncContractCycle(deps.db, deps.api, contractGid, nowIso);
    } catch {
      // 再同期失敗は webhook を落とす理由にしない (日次 §5.4 が回収)
    }
  }
  return 'contract_synced';
}

function isFailingState(contract: OwnContractRow): boolean {
  // S2/S3/S4h/S5 (§6.4 対象)
  return ['retry_wait', 'challenged', 'await_card', 'exhausted'].includes(contract.dunning_state);
}

// ─── §6.4 支払方法更新 ───

/**
 * カード更新後の復旧。S3 (challenged) は発行せず pending_new_card=1 の記録のみ (§6.3 に統一)。
 * それ以外は (S5 なら activate してから) I-2 の順序で発行する。
 */
export async function recoverAfterCardUpdate(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
): Promise<WebhookOutcome> {
  const nowIso = jstIso(deps.nowMs);
  const todayJst = jstDate(deps.nowMs);

  if (contract.dunning_state === 'challenged') {
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts SET pending_new_card = 1, updated_at = ? WHERE contract_gid = ?`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
    return 'payment_recovery';
  }

  if (!deps.canIssue(contract.contract_gid) || !deps.api) {
    // kill 中でもトリガを失わない (§5.2): フラグとして残し、解除後の tick が §6.4 を評価する
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts SET pending_new_card = 1, updated_at = ? WHERE contract_gid = ?`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
    return 'gate_denied';
  }

  if (contract.status === 'paused') {
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts SET status = 'active', dunning_state = 'none', updated_at = ?
          WHERE contract_gid = ?`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
  }
  const reloaded = await loadContract(deps.db, contract.contract_gid);
  if (!reloaded) return 'unknown_contract';
  await issueForContract(deps.db, deps.api, reloaded, todayJst, nowIso, deps.alert);
  return 'payment_recovery';
}

export async function handlePaymentMethodWebhook(
  deps: BillingWebhookDeps,
  body: unknown,
): Promise<WebhookOutcome> {
  const b = asRecord(body) ?? {};
  const customerId = str(
    b.customer_id ?? asRecord(b.customer)?.id ?? b.admin_graphql_api_customer_id,
  );
  if (!customerId) return 'noop';
  const numericCustomerId = customerId.startsWith('gid://')
    ? (customerId.split('/').pop() ?? customerId)
    : customerId;

  const rows = await deps.db
    .prepare(
      `SELECT * FROM own_sub_contracts
        WHERE shopify_customer_id = ?
          AND dunning_state IN ('retry_wait', 'challenged', 'await_card', 'exhausted')`,
    )
    .bind(numericCustomerId)
    .all<OwnContractRow>();

  let handled = 0;
  for (const contract of rows.results ?? []) {
    await recoverAfterCardUpdate(deps, contract);
    handled += 1;
  }
  return handled > 0 ? 'payment_recovery' : 'noop';
}

// ─── §6.6 cycles/{skip,unskip} ───

export async function handleCycleSkip(
  deps: BillingWebhookDeps,
  action: 'skip' | 'unskip',
  body: unknown,
): Promise<WebhookOutcome> {
  const b = asRecord(body) ?? {};
  const contractGid = toGid(
    'SubscriptionContract',
    b.admin_graphql_api_subscription_contract_id ?? b.subscription_contract_id ?? b.contract_id,
  );
  const cycleIndex = b.cycle_index ?? b.cycleIndex ?? b.billing_cycle_index;
  if (!contractGid) return 'noop';
  const contract = await loadContract(deps.db, contractGid);
  if (!contract) return 'unknown_contract';

  const nowIso = jstIso(deps.nowMs);
  const todayJst = jstDate(deps.nowMs);
  const cycleKey = str(cycleIndex);

  if (cycleKey) {
    if (action === 'skip') {
      // I-3 に統一: in-flight attempting も abandoned 化する (遅延 success は §6.6 が受ける)。
      // その後 skipped を明示 INSERT して cron を永久ブロックする。
      await deps.db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
            WHERE contract_gid = ? AND cycle_key = ?
              AND status IN ('attempting', 'failed', 'failed_no_attempt')`,
        )
        .bind(nowIso, contractGid, cycleKey)
        .run();
      await deps.db
        .prepare(
          `INSERT OR IGNORE INTO billing_cycle_claims
             (contract_gid, cycle_key, status, retry_policy, attempt_no, idempotency_key, claimed_at, resolved_at)
           VALUES (?, ?, 'skipped', 'none', 1, ?, ?, ?)`,
        )
        .bind(contractGid, cycleKey, `skip:${contractGid}:${cycleKey}`, nowIso, nowIso)
        .run();
      await deps.db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'skipped', resolved_at = ?
            WHERE contract_gid = ? AND cycle_key = ? AND status = 'abandoned'`,
        )
        .bind(nowIso, contractGid, cycleKey)
        .run();
    } else {
      // unskip: 行は残したまま abandoned へ (未 claim 定義により due 復帰できる §3)
      await deps.db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
            WHERE contract_gid = ? AND cycle_key = ? AND status = 'skipped'`,
        )
        .bind(nowIso, contractGid, cycleKey)
        .run();
    }
  }

  // skip 後は次の未解決サイクルへ明示スケジュール (§4.0 — skip 後にカデンツが
  // 契約作成時刻起点のデフォルトへ落ちる穴の封鎖)
  if (deps.api) {
    try {
      const { cycles } = await resyncContractCycle(deps.db, deps.api, contractGid, nowIso);
      if (action === 'skip' && deps.canIssue(contractGid)) {
        const next = cycles
          .filter((cy) => !cy.billed && !cy.skipped)
          .sort((a, b) => a.cycleIndex - b.cycleIndex)[0];
        if (next && toJstDateOnly(next.expectedDate) !== nextAnchorAfter(contract, todayJst)) {
          const res = await deps.api.scheduleCycleDate(
            contractGid,
            next.cycleIndex,
            nextAnchorAfter(contract, todayJst),
          );
          if (!res.ok) await markRepair(deps, contractGid, nowIso, res.error);
        }
      }
    } catch (e: unknown) {
      await markRepair(deps, contractGid, nowIso, e instanceof Error ? e.message : String(e));
    }
  }
  return 'cycle_synced';
}

// ─── topic ルーティング ───

/** Shopify topic (X-Shopify-Topic) → ハンドラ。未知 topic は noop (200 を返す) */
export async function routeBillingWebhook(
  deps: BillingWebhookDeps,
  topic: string,
  body: unknown,
): Promise<WebhookOutcome> {
  const t = topic.trim().toLowerCase();
  if (t === 'subscription_billing_attempts/success') return handleAttemptSuccess(deps, body);
  if (t === 'subscription_billing_attempts/failure') return handleAttemptFailure(deps, body);
  if (t === 'subscription_billing_attempts/challenged') return handleAttemptChallenged(deps, body);
  if (t.startsWith('subscription_contracts/')) {
    return handleContractLifecycle(deps, t.slice('subscription_contracts/'.length), body);
  }
  if (t === 'subscription_billing_cycles/skip') return handleCycleSkip(deps, 'skip', body);
  if (t === 'subscription_billing_cycles/unskip') return handleCycleSkip(deps, 'unskip', body);
  if (t.startsWith('customer_payment_methods/')) return handlePaymentMethodWebhook(deps, body);
  return 'noop';
}
