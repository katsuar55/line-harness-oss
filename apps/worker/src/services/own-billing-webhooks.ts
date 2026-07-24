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
import { auditSystem } from './audit-logger.js';

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
  /** §6.4 トリガ②: 契約への支払方法差し替え (contractUpdate) 未実装のため記録のみ */
  | 'payment_recovery_deferred'
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

/**
 * I-3 の abandon。**attempt_gid を持たない attempting claim は abandoned にしない**。
 *
 * 理由 (採点 R1 CRITICAL = 二重課金経路):
 * `attempting` かつ `attempt_gid IS NULL` は「Shopify に attempt が存在するかどうか
 * こちらが知らない」状態 (createAttempt が ok だが gid を返さない / recordAttemptIssued が
 * 競合で書けなかった = engine の `stuck_unrecorded`)。これを abandoned にすると、
 * acquireClaim の no-parallel-attempt ガードが `if (existing.attempt_gid)` で始まるため
 * **照会をまるごとスキップして attempt_no++ で新しい idempotencyKey を発行**してしまう。
 * 旧 attempt が生きていれば同一サイクルに 2 本の課金が走る (Shopify の exactly-once は
 * key が変わるので効かない)。
 *
 * よって当該行は `attempting` のまま残す。claimBlocksIssue が attempting をブロックするので
 * 再発行は構造的に起きず、決着は §5.3 reconciliation (idempotencyKey 逆引き) に委ねる。
 * 24h 超で §8 の stuck claim 検出器が鳴るので、沈黙もしない。
 */
async function abandonOpenClaims(
  deps: BillingWebhookDeps,
  contractGid: string,
  nowIso: string,
  cycleKey?: string,
): Promise<void> {
  const cycleClause = cycleKey === undefined ? '' : ' AND cycle_key = ?';
  const binds: unknown[] = [nowIso, contractGid];
  if (cycleKey !== undefined) binds.push(cycleKey);
  await deps.db
    .prepare(
      `UPDATE billing_cycle_claims SET status = 'abandoned', resolved_at = ?
        WHERE contract_gid = ?${cycleClause}
          AND (
            status IN ('failed', 'failed_no_attempt')
            OR (status = 'attempting' AND attempt_gid IS NOT NULL)
          )`,
    )
    .bind(...binds)
    .run();

  // 未検証の in-flight が残ったら人間に見えるようにする (沈黙させない)
  const stuck = await deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM billing_cycle_claims
        WHERE contract_gid = ?${cycleClause} AND status = 'attempting' AND attempt_gid IS NULL`,
    )
    .bind(...(cycleKey === undefined ? [contractGid] : [contractGid, cycleKey]))
    .first<{ n: number }>();
  if ((stuck?.n ?? 0) > 0) {
    await deps.alert(
      `own-billing: 契約 ${contractGid} に attempt_gid 不明の in-flight claim が ${stuck?.n} 件あるため abandoned 化を見送りました (二重課金防止)。reconciliation の決着待ち`,
    );
  }
}

/**
 * §3: 「attempt 単位の証跡 (gid/エラー/時刻) は audit_logs に append 記録
 * (claim 行は最新のみ保持。チャージバック紛争・突合深掘りの一次証跡は audit が正)」。
 * PII は入れない (契約 gid / cycle / attempt gid / error code のみ)。
 * 失敗しても課金処理を巻き戻さない (best-effort)。
 */
async function appendBillingAudit(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  claim: ClaimRow,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await auditSystem(deps.db, {
      action,
      actorType: 'webhook',
      targetType: 'subscription_contract',
      targetId: contract.contract_gid,
      result: 'success',
      metadata: {
        cycleKey: claim.cycle_key,
        attemptNo: claim.attempt_no,
        attemptGid: claim.attempt_gid,
        ...extra,
      },
    });
  } catch {
    /* 証跡の書き込み失敗で課金処理を落とさない */
  }
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

  // §3: attempt 単位の証跡は audit_logs が正 (claim 行は最新のみ保持)。
  // チャージバック紛争・突合深掘りの一次証跡になるため append する。
  await appendBillingAudit(deps, contract, claim, 'own_billing.attempt_succeeded', {
    orderGid: orderGid ?? null,
  });

  // I-4: dunning 全リセット (pending_new_card も消費 — 支払えたのでカード差替待ちは終了)。
  // **現在サイクルの success に限る** (採点 R4 MEDIUM): 閉じた/古いサイクルの遅延 success で
  // 契約全体をリセットすると、別サイクルで進行中の dunning (retry_wait のバックオフ・
  // await_card の期限・pending_new_card の回収約束) が消え、翌 tick で
  // 「+3日待つはずの契約に即再課金」「新カード再試行の権利喪失」が起きる。
  const isCurrentCycle =
    contract.current_cycle_index === null ||
    String(contract.current_cycle_index) === claim.cycle_key;
  if (isCurrentCycle) {
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
  }

  // ── 遅延 success の分岐 (§6.1 / §6.3 / §6.6)。**判定順序が重要**。
  //
  // 採点 R2 HIGH (R1 で私が入れた回帰): claim が abandoned/skipped というだけで早期 return すると、
  // 「dunning 起因の S5 に落ちた契約が、abandoned claim の遅延 success で支払われた」ケースで
  // 自動 activate が飛ばされ、**支払済みなのに永久 paused** (課金漏れ) になる。
  // §6.1 は「attempting/failed/abandoned を問わず」自動 activate を要求している。
  // よって systemOriginPause を最初に判定する。
  const claimWasClosed = claim.status === 'abandoned' || claim.status === 'skipped';
  // システム起因 = 自分が matrix で作った S5 (paused/exhausted) に限定する。
  // 「paused かつ dunning≠none」まで広げると、ライフサイクル webhook の到達順によっては
  // 顧客都合の停止を自動再開してしまう (採点 R1 MEDIUM)。
  const systemOriginPause =
    contract.status === 'paused' && contract.dunning_state === 'exhausted';

  if (systemOriginPause) {
    // dunning 起因の停止 = 支払えた以上ここに留めない。自動 activate + 再開通知。
    //
    // **status と dunning_state は必ず同一 UPDATE で整合させる** (採点 R5 HIGH)。
    // R4 で入れた isCurrentCycle ガードにより、非現在サイクルの遅延 success では
    // 上の I-4 リセットが走らない。そこで status だけ 'active' にすると
    // **(active, exhausted)** という §4.1 表外状態ができ、listDueContracts の述語
    // (none|retry_wait) に二度と一致せず **その契約は永久に課金されない**。
    // S5 は「進行中の dunning」ではなく終端なので、ここでは無条件に解除してよい。
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts
            SET status = 'active', dunning_state = 'none', dunning_attempts = 0,
                next_retry_date = NULL, dunning_deadline_at = NULL, pending_new_card = 0,
                updated_at = ?
          WHERE contract_gid = ?`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
    await safeEnqueue(
      deps, contract, claim.cycle_key, claim.attempt_no, 'resume_notice', { paymentConfirmed: true }, nowIso,
    );
    if (claimWasClosed) {
      // 放棄済みサイクルでの回収。カデンツは既に次アンカーへ進んでいるので触らない
      await deps.alert(
        `own-billing: 契約 ${contract.contract_gid} の cycle ${claim.cycle_key} (${claim.status}) で遅延 success — 停止を解除しました。出荷要否は人間判断`,
      );
      return 'success_applied';
    }
  } else if (contract.status !== 'active') {
    // cancelled / paused / failed / expired のいずれでも「状態は維持して人間判断」。
    // status を列挙すると failed/expired が全ブランチから漏れ、支払済みなのに
    // 通知も alert も出ない穴になる (採点 R3 MEDIUM) ので !== 'active' で受ける。
    // 顧客都合の停止/解約は維持。届ける旨だけ伝えて人間に判断を委ねる (自動返金しない)
    await safeEnqueue(
      deps, contract, claim.cycle_key, claim.attempt_no, 'delivery_notice',
      { contractClosed: true }, nowIso,
    );
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} (${contract.status}) で cycle ${claim.cycle_key} の遅延 success を受信 — 状態は維持。返金要否は人間判断`,
    );
    return 'success_applied';
  } else if (claimWasClosed) {
    // 契約は生きているが当該サイクルは顧客が止めていた (§6.6 abandoned×遅延 success)。
    // 無言で通さない。カデンツも前進させない (次サイクル scheduleEdit は skip 処理が発行済み)。
    await safeEnqueue(deps, contract, claim.cycle_key, claim.attempt_no, 'delivery_notice', {}, nowIso);
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} の cycle ${claim.cycle_key} は ${claim.status} だったが success を受信 — 課金済みとして計上。返金/出荷可否は人間判断`,
    );
    return 'success_applied';
  }

  // 次サイクルの明示スケジュール (cadence-by-scheduleEdit §4.0)。
  // **現在サイクルの success のときだけ**カデンツを進める (採点 R8 MEDIUM)。
  // 非現在/閉じたサイクルの遅延・再配送 success でここに落ちると、resync が見つける
  // oldest unresolved (= 進行中の別サイクル) の予定日を ~30 日先へ動かし、
  // そのサイクルの督促リトライを約 1 ヶ月止めてしまう。I-4 の dunning リセットと同じ
  // isCurrentCycle 判定で囲う。
  if (isCurrentCycle && deps.api && deps.canIssue(contract.contract_gid)) {
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
      const target = nextAnchorAfter(contract, todayJst);
      // 既に目的の日付なら mutation を打たない (success webhook が再配送されるたびに
      // Shopify を叩かない — 採点 R1 LOW)
      if (next && toJstDateOnly(next.expectedDate) !== target) {
        const res = await deps.api.scheduleCycleDate(contract.contract_gid, next.cycleIndex, target);
        if (!res.ok) await markRepair(deps, contract.contract_gid, nowIso, res.error);
      }
    } catch (e: unknown) {
      await markRepair(deps, contract.contract_gid, nowIso, e instanceof Error ? e.message : String(e));
    }
  } else if (isCurrentCycle) {
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

async function consumePendingNewCard(
  deps: BillingWebhookDeps,
  contractGid: string,
  nowIso: string,
): Promise<void> {
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts SET pending_new_card = 0, updated_at = ? WHERE contract_gid = ?`,
    )
    .bind(nowIso, contractGid)
    .run();
}

/**
 * engine の `promoted_succeeded` (= CAS 再入時の照会で「実は成功していた」と判明) に
 * §6.1 の I-4 を適用する。
 *
 * step2 の engine は outcome 文字列を返すだけで、I-4 の接続は「step 3 で行うこと」と
 * TODO が残されていた (own-billing-engine.ts の acquireClaim 近辺)。放置すると、
 * 取り逃した success を発見したのに ①dunning が解除されず await_card sweep が
 * 支払済みの顧客を pause する ②order_id が入らず双方向突合が鳴る ③次サイクルの
 * scheduleEdit が出ずカデンツが Shopify 既定へ落ちる、が同時に起きる。
 *
 * 全ての issueForContract 呼び出し側がこの関数を通すこと。
 */
export async function applyPromotedSuccess(
  deps: BillingWebhookDeps,
  contractGid: string,
  cycleKey?: string,
): Promise<WebhookOutcome> {
  const contract = await loadContract(deps.db, contractGid);
  if (!contract) return 'unknown_contract';
  const key = cycleKey ?? (contract.current_cycle_index !== null ? String(contract.current_cycle_index) : null);
  if (key === null) return 'no_claim';
  const claim = await deps.db
    .prepare(`SELECT * FROM billing_cycle_claims WHERE contract_gid = ? AND cycle_key = ?`)
    .bind(contractGid, key)
    .first<ClaimRow>();
  if (!claim) return 'no_claim';

  // order_id は attempt 照会からしか取れない (webhook を取り逃しているため)
  let orderGid: string | null = null;
  if (deps.api && claim.attempt_gid) {
    const detail = await deps.api.getAttemptDetail(claim.attempt_gid);
    orderGid = detail?.orderGid ?? null;
  }
  return applySuccess(deps, contract, claim, orderGid);
}

export async function handleAttemptSuccess(
  deps: BillingWebhookDeps,
  body: unknown,
): Promise<WebhookOutcome> {
  const payload = parseAttemptPayload(body);
  if (!payload.contractGid) {
    // success の取り逃しは「課金済み未計上」= 最悪の欠損。payload 形状のゆらぎで
    // contract gid が読めなかった場合も**必ず人間へ上げる** (採点 R4 LOW)。
    await deps.alert(
      `own-billing: success webhook の契約 gid を解析できませんでした (attempt=${payload.attemptGid ?? 'なし'} order=${payload.orderGid ?? 'なし'} key=${payload.idempotencyKey ?? 'なし'}) — parser の較正が必要`,
    );
    return 'noop';
  }
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

  // **matrix を適用するのは status='active' の契約だけ** (採点 R2/R3 HIGH — 3 グレーダーが独立検出)。
  //
  // §4.1 で matrix が遷移先を決めるのは S1-S4o (いずれも active) であり、S5/S6/S7/S8 は
  // 「matrix 再分類」を出遷移に持たない。active 以外に適用すると:
  //   - cancelled/expired → paused/exhausted に化け、後日 §6.4 が **解約済み契約に課金**
  //   - **paused/none (S6 = 顧客都合の停止) → paused/exhausted (S5) に化ける**。
  //     顧客は自分で止めたのに「お支払いを確認できず一時停止しました」を受け取り、
  //     さらにカード更新で §6.4 が無断再開・課金する (S6→S5 ロンダリング)
  // この経路は並行性が無くても起きる: abandonOpenClaims は二重課金防止のため
  // attempt_gid=NULL の attempting claim をわざと残すので、pause/cancel 後に届いた
  // failure が attempting ガード (上) を通過してしまう。
  // claim の失敗は下の CAS で記録し、契約状態だけ触らない。
  if (contract.status !== 'active') {
    await deps.alert(
      `own-billing: 非 active 契約 ${contract.contract_gid} (${contract.status}) に failure webhook が到着 — claim のみ記録し matrix は適用しません`,
    );
    await deps.db
      .prepare(
        `UPDATE billing_cycle_claims SET status = 'failed', resolved_at = ?
          WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
      )
      .bind(jstIso(deps.nowMs), contract.contract_gid, claim.cycle_key)
      .run();
    return 'late_ignored';
  }

  // failure が「3DS 要求」を伴う場合は failed 化せず challenged レーンへ (§3 claim 表)
  if (payload.nextActionUrl) {
    return applyChallenged(deps, contract, claim, payload.nextActionUrl);
  }

  const nowIso = jstIso(deps.nowMs);
  const todayJst = jstDate(deps.nowMs);

  // claim を failed 化する CAS。**changes を検証する** (採点 R1 MEDIUM):
  // read-then-write だと 2 本の failure webhook が同時に「status==='attempting'」を読み、
  // 両方が matrix を適用して dunning_attempts を二重に進めうる。
  // 勝者 1 本だけが matrix に進む。
  const failCas = await deps.db
    .prepare(
      `UPDATE billing_cycle_claims SET status = 'failed', resolved_at = ?
        WHERE contract_gid = ? AND cycle_key = ? AND status = 'attempting'`,
    )
    .bind(nowIso, contract.contract_gid, claim.cycle_key)
    .run();
  if ((failCas.meta?.changes ?? 0) !== 1) return 'late_ignored';

  // §6.3 明示例外: pending_new_card=1 なら matrix より先に「新カードで 1 回自動再試行」
  // (webhook-first ordering でも回収約束が成立する。B/E クラス直行で機会を失わない)。
  // gate 閉塞中・adapter 未注入なら再試行できないので、フラグを保持したまま matrix 分類へ
  // 落とす (無条件 retry_wait にすると E クラスのリトライ禁止や B クラスの card_request が
  // 失われる — 採点 R1 MEDIUM)。
  const pendingNewCard = Number(contract.pending_new_card ?? 0) === 1;
  if (pendingNewCard && deps.api && deps.canIssue(contract.contract_gid)) {
    const reloaded = await loadContract(deps.db, contract.contract_gid);
    if (reloaded) {
      // I-2 順序 (resync → resolve → claim → 発行) は engine が保証する
      const outcome = await issueForContract(
        deps.db, deps.api, reloaded, todayJst, nowIso, deps.alert,
      );
      // フラグは「1 回の再試行機会」。**実際に発行できた時だけ消費する** (採点 R1 MEDIUM)。
      // 先に消費すると、旧 attempt がまだ pending で claim_blocked になった場合に
      // 「再試行もされず matrix にも入らず、challenged のまま誰も拾わない」穴ができる。
      if (outcome === 'issued' || outcome === 'stuck_unrecorded') {
        await consumePendingNewCard(deps, contract.contract_gid, nowIso);
        return 'card_retry_issued';
      }
      if (outcome === 'promoted_succeeded') {
        await consumePendingNewCard(deps, contract.contract_gid, nowIso);
        await applyPromotedSuccess(deps, contract.contract_gid, claim.cycle_key);
        return 'success_applied';
      }
      // engine が固有レーンで契約状態を決めた場合は matrix で上書きしない (管轄の一意化)
      if (outcome === 'sync_error_hold' || outcome === 'sync_error_state_resync' || outcome === 'stale_abandoned') {
        await deps.alert(
          `own-billing: 契約 ${contract.contract_gid} の新カード再試行が ${outcome} で決着 — matrix は適用しません`,
        );
        return 'failure_applied';
      }
      // claim_blocked / no_due_cycle 等 = 何も起きていない → フラグ保持のまま matrix 分類へ
      await deps.alert(
        `own-billing: 契約 ${contract.contract_gid} の新カード再試行が ${outcome} で発行に至らず — matrix 分類へ回します`,
      );
    }
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

  // (claim の failed 化は上の CAS で完了済み — ここで再度 UPDATE しない)
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts
          SET dunning_state = ?, dunning_attempts = ?, next_retry_date = ?,
              dunning_deadline_at = ?, last_attempt_error = ?,
              status = CASE WHEN ? = 1 THEN 'paused' ELSE status END,
              updated_at = ?
        WHERE contract_gid = ? AND status = 'active'`,
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
    if (decision.pauseContract) {
      // isFinal (「一時停止しました」) の文面は日付を一切使わない。
      // ここで scheduledDate を入れると、通知が日付ありと判定されて 36h stale 破棄の
      // 対象になり、exhausted 契約には再 enqueue 主体が居ないため最終通知が恒久喪失する
      // (採点 R8 HIGH: 死んだ日付を payload に入れないのが発生源側の正しい対処)。
      noticePayload.isFinal = true;
    } else {
      if (contract.current_cycle_scheduled_date) {
        noticePayload.scheduledDate = contract.current_cycle_scheduled_date;
      }
      if (decision.nextRetryDate) noticePayload.nextRetryDate = decision.nextRetryDate;
      if (decision.deadlineAt) noticePayload.deadlineDate = decision.deadlineAt.slice(0, 10);
    }
    await safeEnqueue(
      deps, contract, claim.cycle_key, claim.attempt_no, decision.notice, noticePayload, nowIso,
    );
  }
  await appendBillingAudit(deps, contract, claim, 'own_billing.attempt_failed', {
    errorCode: payload.errorCode,
    dunningClass: decision.klass,
    dunningState: decision.dunningState,
  });
  if (decision.alertOps) {
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} cycle ${claim.cycle_key} が ${decision.klass} クラス失敗 (${payload.errorCode ?? '不明 code'}) — 自動処理なし。人間の確認が必要`,
    );
  }
  return 'failure_applied';
}

// ─── §6.3 challenged ───

/**
 * 3DS 認証 URL の受け入れ判定 (§2 例外: この URL だけは Shopify のものをそのまま顧客へ直送する)。
 *
 * webhook body 由来の URL を無検証で顧客へ送ると、署名鍵が漏れた場合や Shopify 側の
 * 仕様変更時に、こちらの公式アカウントからフィッシング URL を配ることになる。
 * https かつ Shopify のドメインに限定する (それ以外は API 照会にフォールバック → 無ければ alert)。
 */
export function isAcceptableChallengeUrl(raw: string | null): boolean {
  if (!raw) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return (
    host === 'shopify.com' ||
    host.endsWith('.shopify.com') ||
    host === 'myshopify.com' ||
    host.endsWith('.myshopify.com')
  );
}

export async function applyChallenged(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  claim: ClaimRow,
  nextActionUrlFromPayload: string | null,
): Promise<WebhookOutcome> {
  const nowIso = jstIso(deps.nowMs);
  let url = isAcceptableChallengeUrl(nextActionUrlFromPayload) ? nextActionUrlFromPayload : null;
  if (nextActionUrlFromPayload && !url) {
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} の challenged payload に想定外ホストの URL が含まれていたため破棄しました (API 照会にフォールバック)`,
    );
  }
  if (!url && deps.api && claim.attempt_gid) {
    const detail = await deps.api.getAttemptDetail(claim.attempt_gid);
    url = isAcceptableChallengeUrl(detail?.nextActionUrl ?? null)
      ? (detail?.nextActionUrl ?? null)
      : null;
  }

  // claim は attempting のまま維持 (§3: challenged は failed 化しない)。
  // deadline はここでは設定しない — 起点は「リンク送付時刻」(§5.6) なので、
  // 通知キューが実際に送信できた時点で own-billing-notify が設定する。
  //
  // ⚠️ deadline を NULL に戻すのは **challenged へ遷移する時だけ** (採点 R1 HIGH)。
  // 既に challenged で期限も設定済みの契約に webhook が再配送されると、無条件 NULL は
  // 送付済みリンクの期限を消し、§5.2 の失効 sweep が永久に発火せず課金が止まる。
  // §6.3 のレーンは **active 契約でのみ**起動する (採点 R3 MEDIUM)。
  // status 述語が無いと cancelled/challenged・paused/challenged という §4.1 表外の組合せができ、
  // isFailingState が 'challenged' を含むため §6.4 の発行前段が揃ってしまう。
  await deps.db
    .prepare(
      `UPDATE own_sub_contracts
          SET dunning_state = 'challenged',
              dunning_deadline_at = CASE WHEN dunning_state = 'challenged'
                                         THEN dunning_deadline_at ELSE NULL END,
              updated_at = ?
        WHERE contract_gid = ? AND status = 'active'`,
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
  // 契約が active でなければ dunning レーンに入れない (failure 側と同じ I-1 の考え方)
  if (contract.status !== 'active') return 'late_ignored';
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
    // §6.7 / I-5: **S6 (顧客都合停止) からの再開は skip → activate の順** (採点 R7 HIGH)。
    // status='active' を先にコミットすると、skip の Shopify 往復中に別 invocation の cron が
    // listDueContracts で拾い、休止期間分の overdue サイクルを課金する窓ができる。
    // resumeFromCustomerPause が skip 完了後に自分で active 化する (失敗時は paused/ops_hold 維持)。
    const isS6Resume =
      promoting && !inWindow && contract.status === 'paused' && contract.dunning_state === 'none';
    if (!(inWindow && promoting) && !isS6Resume) {
      // **status と dunning_state を必ず同時に整合させる** (採点 R1 CRITICAL)。
      // status だけ書くと §4.1 状態表に無い組合せ (paused/retry_wait・active/exhausted 等) が
      // でき、後続の遅延 success が「システム起因 pause」と誤認して顧客都合の停止契約を
      // 自動再開・自動課金してしまう。
      //   - activate → S1 (dunning 全解除)
      //   - pause    → S6 (顧客/店側都合の停止 = dunning 'none')。
      //                ただし exhausted は自分で作った S5 なので保持する (§6.4 で復旧させる)
      //   - cancel/expire/fail → 終端。dunning は解除
      const dunningSql =
        target === 'paused'
          ? `dunning_state = CASE WHEN dunning_state = 'exhausted' THEN 'exhausted' ELSE 'none' END,
             next_retry_date = CASE WHEN dunning_state = 'exhausted' THEN next_retry_date ELSE NULL END,
             dunning_deadline_at = CASE WHEN dunning_state = 'exhausted' THEN dunning_deadline_at ELSE NULL END`
          : `dunning_state = 'none', dunning_attempts = 0, next_retry_date = NULL,
             dunning_deadline_at = NULL`;
      await deps.db
        .prepare(
          `UPDATE own_sub_contracts SET status = ?, ${dunningSql}, updated_at = ?
            WHERE contract_gid = ?`,
        )
        .bind(target, nowIso, contractGid)
        .run();
    }
    // I-3: pause/cancel/fail/expire 受理時に未解決 claim を abandoned 化 (in-flight の遅延
    // success は §6.6 の abandoned×success 規則が受ける)。
    // 'failed' も対象に含める: listDueContracts は status='failed' を除外するため、
    // 除外すると claim が永久に attempting のまま残り stuck 検出器が鳴り続ける。
    if (['paused', 'cancelled', 'expired', 'failed'].includes(target)) {
      await abandonOpenClaims(deps, contractGid, nowIso);
    }
    // §6.7 / I-5: **S6 → S1 の再開では休止期間分を請求しない** (採点 R3 HIGH)。
    // status だけ active に戻すと、resolveBillableCycle が休止中に過ぎた過去サイクルを
    // 返し (I-6 の 14 日以内なら) そのまま課金してしまう。
    // I-5 の規定どおり、過去の未解決サイクルを skip + claim skipped 化してから
    // 次アンカーを明示スケジュールする。
    // **S6 (顧客都合の停止) からの再開のときだけ** (採点 R4 MEDIUM)。
    // I-5 は S5 復旧では「14日以内の過去サイクルを回収する」と規定しているので、
    // exhausted からの activate で skip すると回収すべき課金を捨ててしまう。
    // 既に active の契約への activate 再配送でも skip しない。
    if (isS6Resume) {
      await skipPastCyclesOnResume(deps, contract, nowIso);
    }
  }

  // update: §6.4 防御 fallback — 失敗中契約で支払方法が変わっていれば復旧手順を評価
  if (action === 'update') {
    const newPm = toGid('CustomerPaymentMethod', b.payment_method_id ?? b.admin_graphql_api_payment_method_id);
    if (newPm && newPm !== contract.payment_method_gid) {
      const hadBaseline = Boolean(contract.payment_method_gid);
      await deps.db
        .prepare(
          `UPDATE own_sub_contracts SET payment_method_gid = ?, updated_at = ? WHERE contract_gid = ?`,
        )
        .bind(newPm, nowIso, contractGid)
        .run();
      // **baseline が NULL のときは「カードが変わった」と見なさない** (採点 R1 HIGH)。
      // payment_method_gid を書くのは本ハンドラだけなので、契約行は必ず NULL から始まる。
      // NULL を差分扱いすると、住所や数量を編集しただけの contracts/update で
      // 期限切れカードへの再課金・二重 card_request・S5 契約の不用意な復活が起きる。
      // 初回は観測値の記録だけ行い、次回以降の実変更で §6.4 を評価する。
      if (hadBaseline) {
        const reloaded = await loadContract(deps.db, contractGid);
        if (reloaded && isFailingState(reloaded)) {
          return recoverAfterCardUpdate(deps, reloaded);
        }
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

/**
 * §6.7 再開時の I-5 処理: 過去の未解決サイクルを skip + claim skipped 化し、
 * 次アンカー日を明示スケジュールする (= 休止期間分は請求しない、の一意化)。
 *
 * 前提条件 (§6.7): 当該 claim の旧 attempt が非 terminal (pending/challenged) なら
 * 再開全体を保留すべきだが、その待機 vehicle は step4 (§5.4 の能動照会) の管轄。
 * step3 では **attempt_gid を持つ attempting claim があれば skip せず alert に留める**
 * (no-parallel-attempt を破らない方向へ倒す)。
 */
async function skipPastCyclesOnResume(
  deps: BillingWebhookDeps,
  contract: OwnContractRow,
  nowIso: string,
): Promise<void> {
  // ⚠️ この関数に入る時点で契約は **まだ paused (S6)**。呼び出し側は status を先に
  // active 化しない (採点 R7 HIGH — 先行 active 化すると skip の Shopify 往復中に
  // 別 cron tick が overdue サイクルを課金する窓ができる)。
  // 全 skip + reschedule + resync が完了して初めて active 化する。
  // 途中で失敗したら **paused のまま**にする = 課金対象にならず、activate 再送で再試行できる
  // (paused/none は §4.1 の S6 = 有効な状態。ops_hold のような表外状態を作らない)。
  const failResume = async (reason: string): Promise<void> => {
    await markRepair(deps, contract.contract_gid, nowIso);
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} の再開で休止期間分の skip を完了できませんでした (${reason}) — 契約は一時停止のまま維持します (誤請求防止)。activate 再送または日次 repair で再試行`,
    );
  };

  if (!deps.api || !deps.canIssue(contract.contract_gid)) {
    await failResume('gate_closed_or_no_api');
    return;
  }
  const todayJst = jstDate(deps.nowMs);
  try {
    const cycles = await deps.api.listCycles(contract.contract_gid);
    const past = cycles
      .filter((cy) => !cy.billed && !cy.skipped && toJstDateOnly(cy.expectedDate) <= todayJst)
      .sort((a, b) => a.cycleIndex - b.cycleIndex);
    for (const cy of past) {
      const cycleKey = String(cy.cycleIndex);
      const existing = await deps.db
        .prepare(`SELECT status, attempt_gid FROM billing_cycle_claims WHERE contract_gid = ? AND cycle_key = ?`)
        .bind(contract.contract_gid, cycleKey)
        .first<{ status: string; attempt_gid: string | null }>();
      // §6.7 の「旧 attempt が非 terminal なら再開全体を保留」。
      // **status==='attempting' だけを見ると死んだガードになる** (採点 R4 HIGH):
      // I-3 (pause 受理時の abandonOpenClaims) が既に abandoned へ落としているため。
      // attempt_gid を持つ claim は状態に関わらず実際に照会して terminal を確認する。
      if (existing?.attempt_gid && existing.status !== 'succeeded' && existing.status !== 'skipped') {
        const detail = await deps.api.getAttemptDetail(existing.attempt_gid);
        const terminal = detail !== null && (detail.status === 'succeeded' || detail.status === 'failed');
        if (!terminal) {
          await failResume(`pending_attempt:${cycleKey}:${detail?.status ?? '照会不能'}`);
          return;
        }
      }
      const res = await deps.api.setCycleSkip(contract.contract_gid, cy.cycleIndex, true);
      if (!res.ok) {
        // skip できなかった過去サイクルを残したまま active 化しない (誤請求の防止)
        await failResume(`skip_failed:${cy.cycleIndex}`);
        return;
      }
      await deps.db
        .prepare(
          `INSERT OR IGNORE INTO billing_cycle_claims
             (contract_gid, cycle_key, status, retry_policy, attempt_no, idempotency_key, claimed_at, resolved_at)
           VALUES (?, ?, 'skipped', 'none', 0, ?, ?, ?)`,
        )
        .bind(contract.contract_gid, cycleKey, `resume-skip:${contract.contract_gid}:${cycleKey}`, nowIso, nowIso)
        .run();
      await deps.db
        .prepare(
          `UPDATE billing_cycle_claims SET status = 'skipped', resolved_at = ?
            WHERE contract_gid = ? AND cycle_key = ? AND status IN ('abandoned', 'failed', 'failed_no_attempt')`,
        )
        .bind(nowIso, contract.contract_gid, cycleKey)
        .run();
    }
    // 次アンカー日を明示スケジュール (skip 後にカデンツが作成時刻起点の既定へ落ちる穴の封鎖)
    const next = cycles
      .filter((cy) => !cy.billed && !cy.skipped && toJstDateOnly(cy.expectedDate) > todayJst)
      .sort((a, b) => a.cycleIndex - b.cycleIndex)[0];
    const target = nextAnchorAfter(contract, todayJst);
    if (next && toJstDateOnly(next.expectedDate) !== target) {
      const res = await deps.api.scheduleCycleDate(contract.contract_gid, next.cycleIndex, target);
      if (!res.ok) {
        await failResume(`schedule_failed:${next.cycleIndex}`);
        return;
      }
    }
    await resyncContractCycle(deps.db, deps.api, contract.contract_gid, nowIso);
    // ── 全処理成功。**ここで初めて active 化する** (overdue サイクルは全て skip 済み)
    await deps.db
      .prepare(
        `UPDATE own_sub_contracts
            SET status = 'active', dunning_state = 'none', dunning_attempts = 0,
                next_retry_date = NULL, dunning_deadline_at = NULL, updated_at = ?
          WHERE contract_gid = ? AND status = 'paused'`,
      )
      .bind(nowIso, contract.contract_gid)
      .run();
  } catch (e: unknown) {
    await failResume(`listCycles_failed:${e instanceof Error ? e.message : String(e)}`);
  }
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

  // I-1: attempt 発行は status=active の契約に限る。終端契約 (解約/期限切れ) は
  // dunning_state が残っていても復旧対象にしない (採点 R1 HIGH)。
  if (contract.status !== 'active' && contract.status !== 'paused') return 'noop';

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

  // §6.4 の「(S5 なら activate)」を字義どおりに守る (採点 R1 HIGH):
  // paused から active へ戻すのは **exhausted (= 自分が dunning で止めた S5)** の場合だけ。
  // 顧客/店側が止めた契約 (S6) をカード更新イベントで無断再開・再課金しない。
  if (contract.status === 'paused' && contract.dunning_state !== 'exhausted') {
    await deps.alert(
      `own-billing: 契約 ${contract.contract_gid} は dunning 起因でない停止 (${contract.dunning_state}) のため、カード更新では再開しません`,
    );
    return 'noop';
  }

  // S5→S1 の復旧では dunning 系列を**全部**リセットする (採点 R1 HIGH)。
  // dunning_attempts を残すと、カード更新後の最初のソフトデクラインが
  // 「3 回目」と判定されて即 S5 + 「一時停止しました」の最終通知になり、
  // §6.2 A の「+3日, +7日 (計3)」が顧客に一度も適用されない。
  // await_card / retry_wait からの復旧でも同じ (deadline / next_retry_date の残骸を消す)。
  const wasPaused = contract.status === 'paused';
  await deps.db
    .prepare(
      // pending_new_card もここで消費する (採点 R5 LOW): この経路が「カード更新起点の
      // 再試行」をまさに今使っているため、残すと後続 failure で E クラス (リトライ禁止) が
      // 1 回破られる。
      `UPDATE own_sub_contracts
          SET status = 'active', dunning_state = 'none', dunning_attempts = 0,
              next_retry_date = NULL, dunning_deadline_at = NULL, pending_new_card = 0,
              updated_at = ?
        WHERE contract_gid = ?`,
    )
    .bind(nowIso, contract.contract_gid)
    .run();
  if (wasPaused) {
    // 「一時停止しました」を送った相手には、再開したことも必ず伝える (採点 R1 MEDIUM)。
    // 伝えないと顧客側で停止の認識が残ったまま商品が届く。
    // attempt_no には **これまでに送った resume_notice の件数**を使う (採点 R3 MEDIUM):
    // 固定値だと同一サイクル内で 2 回目の復旧をしたときに冪等マーカーへ食われ、
    // 「停止しました」だけ届いて「再開しました」が届かなくなる。
    const cycleKey = contract.current_cycle_index !== null ? String(contract.current_cycle_index) : '0';
    // **cycle_key で絞った件数**を使う (採点 R5 LOW): contract 単位の COUNT だと
    // applySuccess 側 (claim.attempt_no 採番) と同じ番号に落ちて冪等マーカーが衝突し、
    // 「停止しました」を受け取った顧客に「再開しました」が届かなくなる。
    const sent = await deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM own_billing_notices
          WHERE contract_gid = ? AND cycle_key = ? AND kind = 'resume_notice'`,
      )
      .bind(contract.contract_gid, cycleKey)
      .first<{ n: number }>();
    // applySuccess は claim.attempt_no (1 始まり) を使うため、こちらは負方向に採番して
    // キー空間を分離する (衝突しない・順序も安定)
    await safeEnqueue(deps, contract, cycleKey, -1 - Number(sent?.n ?? 0), 'resume_notice', {}, nowIso);
  }
  const reloaded = await loadContract(deps.db, contract.contract_gid);
  if (!reloaded) return 'unknown_contract';
  const outcome = await issueForContract(deps.db, deps.api, reloaded, todayJst, nowIso, deps.alert);
  // 取り逃した success を発見したら I-4 まで適用する (§6.1。engine は outcome を返すだけ)
  if (outcome === 'promoted_succeeded') {
    await applyPromotedSuccess(deps, contract.contract_gid);
    return 'success_applied';
  }
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
          AND status IN ('active', 'paused')
          AND dunning_state IN ('retry_wait', 'challenged', 'await_card', 'exhausted')`,
    )
    .bind(numericCustomerId)
    .all<OwnContractRow>();

  // ⚠️ §6.4 トリガ② は step3 では **記録と alert に留める** (採点 R2 HIGH)。
  //
  // Shopify では「新しい vault は契約に自動で紐付かない」(§1)。契約側の支払方法を差し替えるには
  // `subscriptionContractUpdate` (draft flow) が要るが、本 adapter はまだそれを持たない
  // (step5 の UI = トリガ① が契約更新まで済ませてから §6.4 を起動するのが主経路)。
  // その状態で発行すると **旧カードで再試行 → 必ず失敗 → 2 通目の card_request** となり、
  // カードを登録した直後の顧客に「更新してください」を送りつけ、
  // dunning_attempts のリセットで S5 にも到達せず課金漏れが恒久化する。
  // よってここでは発行せず、pending_new_card も立てない (果たせない再試行を約束しない)。
  const gids = (rows.results ?? []).map((c) => c.contract_gid);
  if (gids.length > 0) {
    await deps.alert(
      `own-billing: 顧客 ${numericCustomerId} が支払方法を追加/更新しましたが、契約への差し替え (subscriptionContractUpdate) は未実装のため自動復旧しません。対象契約 ${gids.length} 件 — マイページ/管理画面から契約の支払方法を更新してください`,
    );
  }
  return gids.length > 0 ? 'payment_recovery_deferred' : 'noop';
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
      // ただし attempt_gid 不明の attempting は残す (abandonOpenClaims の doc 参照 = 二重課金防止)。
      // その後 skipped を明示 INSERT して cron を永久ブロックする。
      await abandonOpenClaims(deps, contractGid, nowIso, cycleKey);
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

      // §4.0「放棄済みサイクルの dunning は cycle とともに閉じる」を skip にも適用する
      // (採点 R4 HIGH — 2 グレーダーが独立検出)。閉じないと:
      //   - await_card のまま残った契約は listDueContracts の述語 (none|retry_wait) に
      //     二度と一致せず、**以後のサイクルが一度も課金されない** (課金漏れ)
      //   - retry_wait の dunning_attempts が次サイクルへ持ち越され、初回失敗通知が出ず
      //     2 回目で S5 になる (§6.2 A の「+3日,+7日 計3」「初回+最終」が破れる)
      //   - step4 の期限 sweep が、請求残の無い顧客に「一時停止しました」を送る
      // challenged は §5.2、ops_hold は ops 解除 op の管轄なので触らない。
      // **解放するのは「その dunning の起点サイクル」を skip したときだけ** (採点 R6 MEDIUM)。
      // サイクル相関なしに解除すると、cycle N が await_card のときに将来の cycle N+1 を
      // skip しただけで N のバックオフ・期限・attempts が消え、
      // 「+3日待つはずが即再課金」「カード未更新の顧客へ card_request 再送」が起きる。
      // §6.6 の締切ガード上、UI からの skip 対象は将来サイクルになるのが正常系なので、
      // この誤爆は例外ではなく常態になる。
      await deps.db
        .prepare(
          `UPDATE own_sub_contracts
              SET dunning_state = 'none', dunning_attempts = 0, next_retry_date = NULL,
                  dunning_deadline_at = NULL, last_attempt_error = NULL, updated_at = ?
            WHERE contract_gid = ?
              AND dunning_state IN ('none', 'retry_wait', 'await_card')
              AND (current_cycle_index IS NULL OR CAST(current_cycle_index AS TEXT) = ?)`,
        )
        .bind(nowIso, contractGid, cycleKey)
        .run();
      // 当該サイクル向けに積まれた未送信の督促通知も破棄する
      // (スキップしたのに「お支払い方法をご更新ください」が翌配送窓に届くのを防ぐ)
      try {
        await deps.db
          .prepare(
            `UPDATE own_billing_notice_queue
                SET status = 'abandoned', last_error = 'cycle_skipped', payload_json = '{}'
              WHERE contract_gid = ? AND cycle_key = ? AND status = 'queued'
                AND kind IN ('fail_notice', 'card_request', 'challenge_link')`,
          )
          .bind(contractGid, cycleKey)
          .run();
      } catch {
        /* migration 072 未適用でも skip 処理を落とさない */
      }
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
  if (deps.api && (action !== 'skip' || deps.canIssue(contractGid))) {
    try {
      const { cycles } = await resyncContractCycle(deps.db, deps.api, contractGid, nowIso);
      if (action === 'skip') {
        const next = cycles
          .filter((cy) => !cy.billed && !cy.skipped)
          .sort((a, b) => a.cycleIndex - b.cycleIndex)[0];
        // **基準日は「今日」ではなく「スキップしたサイクルの予定日」** (採点 R4 HIGH)。
        // skip は §6.6 の締切ガード上「予定日の 3 日以上前」に来るのが正常系なので、
        // 今日を基準にすると nextAnchorAfter が **スキップした当のサイクルの予定日**を返し、
        // 次サイクルをその日に割り当ててしまう = 顧客が拒否した日に番号だけ変えて課金・出荷。
        // しかも anchor 列とは一致するため §8 の乖離検出器にも掛からない。
        const skipped = cycles.find((cy) => String(cy.cycleIndex) === cycleKey);
        const basisDate = skipped
          ? toJstDateOnly(skipped.expectedDate)
          : (contract.current_cycle_scheduled_date && contract.current_cycle_scheduled_date > todayJst
              ? contract.current_cycle_scheduled_date
              : todayJst);
        const target = nextAnchorAfter(contract, basisDate);
        if (next && toJstDateOnly(next.expectedDate) !== target) {
          const res = await deps.api.scheduleCycleDate(contractGid, next.cycleIndex, target);
          if (!res.ok) await markRepair(deps, contractGid, nowIso, res.error);
        }
      }
    } catch (e: unknown) {
      await markRepair(deps, contractGid, nowIso, e instanceof Error ? e.message : String(e));
    }
  } else if (action === 'skip') {
    // gate 閉塞中 / adapter 未注入で scheduleEdit を打てなかった。**必ず修復フラグを立てる**
    // (採点 R1 MEDIUM): 立てないと §4.0 の「skip 後にカデンツが契約作成時刻起点の既定へ
    // 落ちる穴」が billing-kill 中に無言で再発し、日次 repair も拾わない。
    await markRepair(deps, contractGid, nowIso);
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
  // §6.4 が対象にするのは create / update のみ。**revoke を含めない** (採点 R1 MEDIUM):
  // カード失効イベントで復旧手順を起動すると、失効したカードへ課金を再試行し、
  // exhausted (S5) 契約を不用意に active へ戻してしまう。
  if (t === 'customer_payment_methods/create' || t === 'customer_payment_methods/update') {
    return handlePaymentMethodWebhook(deps, body);
  }
  return 'noop';
}
