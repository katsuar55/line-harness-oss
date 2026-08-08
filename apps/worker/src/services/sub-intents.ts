/**
 * sub_intents state 機械 (= サブスク受理レイヤー、 §10-3、 2026-08-06)
 * docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §1 (背骨) / §4-0・§4-2 (claim と sweep の述語)
 *
 * 背骨 (§1): 顧客のタップ = 「意思の受理」であって「実行」ではない。
 *   ① 受理 (INSERT sub_intents) — 対応する op が定義されたタップは常に成功する
 *   ② 実行 executor で分岐 (human = 移行前・スタッフが HB 管理画面で代行 [2026-08-05 K4 確定] /
 *      own_billing = Phase 3 / blocked = 移行窓 / api = 存在しない [ENTERPRISE 限定・買わない])
 *   ③ 完了 or 正直な失敗を必ず通知
 *
 * state 遷移表 (ここに無い遷移は存在しない。全て CAS = changes 0 なら成功を宣言しない):
 *   received  → executing        claim (スタッフ着手。skip/date は締切前のみ = expire と相互排他)
 *   received  → expired          sweep (skip/date のみ・締切超過) + 正直な失敗通知
 *   received  → received (更新)  sweep (pause/cancel の締切超過 = 同一行を次サイクルへ繰越し §1-2)
 *   received  → superseded       繰越し先に別 open intent が既に存在 (新しい意思が優先)
 *   received  → cancelled        undo (§1-3)
 *   deferred  → cancelled        undo (§1-3。移行窓の意思も取り消せる)
 *   deferred  → received         窓明け再アンカリング (§5-4。§10-4 以降で配線 — 遷移だけ定義)
 *   executing → done             完了 CAS (0 行 = 別 claim が触った → 「確認中」+ alert §1-2)
 *   executing → failed           正直な失敗 (reason 必須)
 *   executing → received         解放。機械 executor の 30 分 timeout (自動) と
 *                                 /admin/ops の明示的な人間の判断 (誤 claim) のみ。
 *                                 **human の自動解放は存在しない** (§1-2 — 二重実行を生む)
 *   done      → cancel_requested undo_of 受理 (§1-3)
 *   cancel_requested → cancelled undo_of done (取り消し完了)
 *   cancel_requested → done      undo_of failed (取り消せなかった → 元の完了状態へ復元)
 *
 * gate: SUB_INTENT_ENABLED='true' 以外では受理/遷移/sweep とも no-op (= 本番 dormant)。
 * §10-5 (リマインドカードへのボタン内包) も同じ gate を参照する設計 (§10-5)。
 */

import type { LineClient } from '@line-crm/line-sdk';
import {
  insertSubIntent,
  getSubIntent,
  getOpenSubIntent,
  claimSubIntentCas,
  completeSubIntentCas,
  failSubIntentCas,
  releaseSubIntentClaimCas,
  undoSubIntentCas,
  markCancelRequestedCas,
  resolveUndoneOriginalCas,
  restoreCancelRequestedCas,
  expireSubIntentCas,
  carryOverSubIntentCas,
  supersedeSubIntentCas,
  markEscalatedCas,
  markStaleAlertedCas,
  markPromiseAlertedCas,
  markPredeadlineEscalatedCas,
  setVerifyPendingCas,
  setVerifyVerdictCas,
  listSubIntentsPastDeadline,
  listSubIntentsPastPromise,
  listCancelIntentsNearDeadline,
  listSubIntentsVerifyPending,
  listSubscriptionOrdersSince,
  countOtherDoneSubIntents,
  listStaleClaims,
  getSubscriptionContract,
  getFriendByShopifyCustomerId,
  insertAuditLog,
  insertCronRunLog,
  toJstString,
  type SubIntentRow,
  type SubIntentOp,
  type SubIntentExecutor,
  type SubscriptionContractRow,
} from '@line-crm/db';
import { dispatch } from './channel-dispatcher.js';
import { deterministicRetryKey } from './subscription-billing-reminder.js';
import { BILLING_DEADLINE_LEAD_DAYS } from './subscription-concierge.js';
import { addDays, parseOrderSubscriptionTags } from './subscription-contracts.js';
import { computePromisedBy } from './business-calendar.js';

export const SUB_INTENT_SWEEP_JOB_NAME = 'sub-intents-sweep';

/** 機械 executor (own_billing|api) の claim 自動解放閾値 (§1-2)。human には適用しない。 */
export const MACHINE_CLAIM_RELEASE_MINUTES = 30;
/** human executor の claim 未解決アラート閾値 (§1-2 — 解放はせずアラートのみ)。 */
export const HUMAN_CLAIM_ALERT_MINUTES = 30;
/** §4-4: cancel の締切前 強制エスカレーション閾値。§4-1 の開示判定 (promised_by > deadline_at) とは別物。 */
export const CANCEL_PREDEADLINE_ESCALATION_HOURS = 24;
/** §4-3 の検証対象 op。resume は照合表に定義がなく、undo_of は元 intent に従属するため対象外。 */
export const VERIFIABLE_OPS: readonly SubIntentOp[] = ['skip', 'date', 'pause', 'cancel'] as const;
/**
 * §4-3 の注文走査上限。走査が打ち切られた run では ok を宣言しない
 * (ASC + LIMIT は最新の注文 = miss 証拠側を落とすため。監査 CONFIRMED)。
 */
export const ORDER_SCAN_LIMIT = 200;

/** 顧客が受理カードから依頼できる op (undo_of は undoSubIntent 経由でのみ生成)。 */
export const ACCEPTABLE_OPS: readonly SubIntentOp[] = [
  'skip',
  'date',
  'pause',
  'resume',
  'cancel',
] as const;

/** op の日本語ラベル (通知・/admin/ops 表示共用)。 */
export const SUB_INTENT_OP_LABELS: Record<SubIntentOp, string> = {
  skip: '次回スキップ',
  date: 'お届け日の変更',
  pause: '一時停止',
  resume: '再開',
  cancel: '解約',
  undo_of: '取り消し',
};

export interface SubIntentGateEnv {
  SUB_INTENT_ENABLED?: string;
}

export function isSubIntentEnabled(env: SubIntentGateEnv): boolean {
  return env.SUB_INTENT_ENABLED === 'true';
}

// ============================================================
// サイクル識別子と締切 (§1 / §3-2)
// ============================================================

/**
 * target_cycle_key = 「契約 + 想定決済日」(§1)。日付不明は ':unknown'
 * (それでも partial UNIQUE により「不明サイクルの open intent は op ごとに 1 行」に畳まれる)。
 */
export function buildCycleKey(contractKey: string, scheduledDate: string | null): string {
  return `${contractKey}:${scheduledDate ?? 'unknown'}`;
}

/**
 * 変更受付期限 = 決済日の BILLING_DEADLINE_LEAD_DAYS (3) 日前の EOD (JST)。
 * HB の実仕様「次回決済日の 3 日前まで」(2026-07-26 実地確認) に一致させる。
 * 予定日不明なら null (= expire sweep も claim 締切も対象外。締切不明で顧客の意思を
 * 勝手に失効させない — 誤 expire は回復不能、無 expire はスタッフ判断で回復可能)。
 */
export function computeDeadlineAt(scheduledDate: string | null): string | null {
  if (!scheduledDate) return null;
  const dateOnly = scheduledDate.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
  return `${addDays(dateOnly, -BILLING_DEADLINE_LEAD_DAYS)}T23:59:59.999+09:00`;
}

function newIntentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `si_${hex}`;
}

// ============================================================
// 受理 (§1-1)
// ============================================================

export interface AcceptSubIntentInput {
  /** 現状 'hb' のみ ('own' は Phase 3 で解禁) */
  contractNs: 'hb';
  contractKey: string;
  op: SubIntentOp;
  requestedBy: 'customer' | 'staff' | 'system';
  /**
   * 提示時に画面へ出していた予定日 (§1 / §3-3 古い吹き出し対策)。
   * 指定があり、かつ現在の read-model の推定と異なる場合は受理せず cycle_drift を返す
   * (古いカードのタップを「承りました」と受けて別サイクルに作用させない)。
   * 未指定 (スタッフ受理等) は現在の推定を採用する。
   */
  presentedDate?: string | null;
  /** op='date' の希望日等。PII を入れない (台帳は append 的に残る) */
  payload?: Record<string, unknown> | null;
  actorStaffId?: string | null;
  actorRole?: string | null;
  executor?: SubIntentExecutor;
  /**
   * §4-1: promised_by > deadline_at の開示 (「今回は間に合いません」) を顧客が了承済み。
   * false/未指定で開示条件に当たると受理せず promise_after_deadline を返す —
   * 呼び出し側が開示して選ばせてから true で再呼び出しする (受理前開示を型で強制)。
   */
  acknowledgeLatePromise?: boolean;
  /** テスト注入用 */
  nowMs?: number;
}

export type AcceptSubIntentResult =
  | { status: 'accepted'; intent: SubIntentRow }
  /** 二重タップ (§1-1)。既存 open intent を返す = 「承り済みです」 */
  | { status: 'duplicate'; intent: SubIntentRow }
  /** 提示日が現在の推定とズレている (§3-3)。受理していない */
  | { status: 'cycle_drift'; currentEstimate: string | null }
  | { status: 'contract_not_found' }
  | { status: 'invalid_op' }
  /** presentedDate が YYYY-MM-DD 形式でない。受理していない */
  | { status: 'invalid_date' }
  /**
   * §4-1: 約束できる最短 (promised_by) が締切 (deadline_at) を超える。**受理していない** —
   * 「今回は間に合いません」を開示して顧客に選ばせ、了承なら acknowledgeLatePromise で再受理する。
   */
  | { status: 'promise_after_deadline'; promisedBy: string; deadlineAt: string }
  /**
   * skip/date の締切が**既に過ぎている**。受理しない (§10-5 監査 CONFIRMED —
   * 受理すると「承りました+反映予定」の数分後に sweep が expire し、直前の約束を機械が
   * 即時破棄する。了承 (ack) でも受理してはいけない — 開示は「間に合わない見込み」への
   * 同意であって「確実に失効する依頼を台帳に積む」ことへの同意ではない)。
   * pause/cancel は対象外 (§1-2: expire 禁止・繰越しで救済されるため締切後も受理してよい)。
   */
  | { status: 'deadline_passed'; deadlineAt: string }
  /** INSERT 0 行なのに open 行も引けない (= 競合の狭間)。受理を宣言しない */
  | { status: 'conflict' };

/** §4-3 の検証基準値 (受理時点の契約スナップショット。done 時採取だと実行と webhook の race で汚れる)。 */
export interface VerifyBaseline {
  /** 受理時の next_billing_estimate (YYYY-MM-DD) */
  estimate: string | null;
  /** 受理時の estimate_source ('flow' | 'derived' 等) */
  source: string;
  intervalDays: number | null;
  skipCount: number;
  /** null = read-model が回数を知らない (照合の count 前進判定は使えない → 保留側に倒す) */
  orderCount: number | null;
  /** 受理時刻 (JST ISO) — 注文照合の下限 */
  acceptedAt: string;
}

function buildVerifyBaseline(contract: SubscriptionContractRow, acceptedAt: string): string {
  const baseline: VerifyBaseline = {
    estimate: contract.next_billing_estimate?.slice(0, 10) ?? null,
    source: contract.estimate_source,
    intervalDays: contract.interval_days ?? null,
    skipCount: contract.skip_count ?? 0,
    orderCount: contract.order_count ?? null,
    acceptedAt,
  };
  return JSON.stringify(baseline);
}

/**
 * 受理 (§1-1)。INSERT ... ON CONFLICT DO NOTHING → 0 行なら既存 open intent を返す。
 * gate 判定は呼び出し側 (route/webhook) の責務 — service は台帳操作に徹する
 * (sweep だけは cron 直結なので内部で gate を見る)。
 */
export async function acceptSubIntent(
  db: D1Database,
  input: AcceptSubIntentInput,
): Promise<AcceptSubIntentResult> {
  if (!ACCEPTABLE_OPS.includes(input.op)) return { status: 'invalid_op' };
  if (input.contractNs !== 'hb') return { status: 'invalid_op' };

  const contract = await getSubscriptionContract(db, input.contractKey);
  if (!contract) return { status: 'contract_not_found' };

  const currentEstimate = contract.next_billing_estimate?.slice(0, 10) ?? null;
  let presentedForRecord: string | null = null;
  if (input.presentedDate !== undefined && input.presentedDate !== null) {
    const presented = input.presentedDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(presented)) {
      // 形式不正はサイクル識別子に混ぜない (任意文字列が cycle key に入ると
      // partial UNIQUE の畳み込みが崩れ、台帳が際限なく太る)
      return { status: 'invalid_date' };
    }
    if (currentEstimate !== null && presented !== currentEstimate) {
      // 古い吹き出し (§3-3): 提示時と今でサイクルが動いている。承ったと言わない。
      return { status: 'cycle_drift', currentEstimate };
    }
    presentedForRecord = presented;
  }
  // cycle key は**常に現在の read-model 推定から**構築する (推定 NULL は ':unknown' に畳む)。
  // presentedDate から構築すると、推定 NULL の契約で異なる日付を並べるだけで §1-1 の
  // 一意性を迂回して open intent を複数積めてしまう (監査 ops-safety MEDIUM)。
  // presented_scheduled_date には提示された日付を記録する (推定があれば drift 検査済みなので同値)。
  const scheduledDate = currentEstimate;

  const friend = contract.shopify_customer_id
    ? await getFriendByShopifyCustomerId(db, contract.shopify_customer_id)
    : null;

  const executor = input.executor ?? 'human';
  const nowMs = input.nowMs ?? Date.now();
  const now = toJstString(new Date(nowMs));
  const cycleKey = buildCycleKey(input.contractKey, scheduledDate);
  // resume は締切に縛られない (再開意思を期限で失効させる理由がない)
  const deadlineAt = input.op === 'resume' ? null : computeDeadlineAt(scheduledDate);

  // 既存 open intent は §4-1 の開示より**先に** duplicate で返す (監査 LOW):
  // 有効な約束が既に台帳にあるのに「今回は間に合いません」を新規に開示すると、
  // 了承を取った末に duplicate が返る矛盾したフローになる (INSERT 側の ON CONFLICT は
  // 並行受理の最終防衛として残る)
  const existing = await getOpenSubIntent(db, input.contractNs, input.contractKey, cycleKey, input.op);
  if (existing) return { status: 'duplicate', intent: existing };

  // skip/date は締切超過後の受理を拒む (即時 expire される依頼を「承りました」と言わない)。
  // blocked (移行窓) は §5-1 の「必ず受理する」が優先 (実行時期は再アンカリングが決める)
  if (
    (input.op === 'skip' || input.op === 'date') &&
    executor !== 'blocked' &&
    deadlineAt !== null &&
    deadlineAt <= now
  ) {
    return { status: 'deadline_passed', deadlineAt };
  }

  // §4-1: 受理した瞬間に所要時間を約束する。モードB (executor='blocked') は営業時間で
  // 約束しない (実行時期は移行機械が決める) — promised_by は NULL。
  const promisedBy = executor === 'blocked' ? null : computePromisedBy(nowMs);
  // §4-1 の順序: ①算出 → ②比較 → ③超過なら受理前に開示して顧客に選ばせる。
  // 判定式は promised_by > deadline_at の 1 つだけ (24h 固定閾値は使わない — 週末跨ぎで嘘になる)。
  // deadlineAt > now の条件: 開示は「まだ来ていない締切に間に合わない見込み」の話。
  // 既に過ぎた締切に対して開示すると、ここに到達しうる pause/cancel (skip/date は上で
  // deadline_passed 済み) が自明な「間に合いません」開示で 1 タップ増える — pause/cancel の
  // 救済 (繰越し・§4-4) は受理文言と sweep が担うので、そのまま受理するのが正
  if (
    promisedBy !== null &&
    deadlineAt !== null &&
    deadlineAt > now &&
    promisedBy > deadlineAt &&
    input.acknowledgeLatePromise !== true
  ) {
    return { status: 'promise_after_deadline', promisedBy, deadlineAt };
  }

  const { inserted } = await insertSubIntent(db, {
    id: newIntentId(),
    friendId: friend?.id ?? null,
    contractNs: input.contractNs,
    contractKey: input.contractKey,
    targetCycleKey: cycleKey,
    presentedScheduledDate: presentedForRecord ?? scheduledDate,
    op: input.op,
    // 移行窓 (executor='blocked') は受理だけして deferred に置く (§5-1 / §1-2)
    state: executor === 'blocked' ? 'deferred' : 'received',
    requestedBy: input.requestedBy,
    actorStaffId: input.actorStaffId ?? null,
    actorRole: input.actorRole ?? null,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    deadlineAt,
    promisedBy,
    executor,
    supersedesIntentId: null,
    // §4-3: 検証の基準値は**受理時**に採取する (done 時だとスタッフ実行 → webhook 反映の
    // 順序 race で「実行後の値」を基準にしてしまい、前進量の照合が原理的に成立しない)
    verifyBaselineJson: VERIFIABLE_OPS.includes(input.op) ? buildVerifyBaseline(contract, now) : null,
    createdAt: now,
  });

  const row = await getOpenSubIntent(db, input.contractNs, input.contractKey, cycleKey, input.op);
  if (!row) return { status: 'conflict' };
  return { status: inserted ? 'accepted' : 'duplicate', intent: row };
}

// ============================================================
// undo (§1-3): state で決める。時刻で決めない
// ============================================================

export type UndoSubIntentResult =
  /** received|deferred を CAS で取り消した (= 「取り消しました」と言ってよい) */
  | { status: 'cancelled'; intent: SubIntentRow }
  /** executing|done → undo_of intent を受理した (= 「取り消しのご依頼を承りました」止まり §1-3) */
  | { status: 'undo_accepted'; undoIntent: SubIntentRow }
  | { status: 'not_found' }
  /** 既に terminal (expired/failed/cancelled/superseded) — 取り消すものがない */
  | { status: 'not_undoable'; state: SubIntentRow['state'] };

/**
 * undo_of の一意性キー: **元 intent ごとに 1 スロット**。
 * サイクル単位 (元と同じ key) にすると、同一サイクルの別 intent への取り消し依頼が
 * 既存 undo_of に UNIQUE 吸収され「承りました」と言いながら台帳に残らない
 * (監査 state-machine/idempotency-race 両次元で CONFIRMED)。
 */
export function buildUndoCycleKey(originalCycleKey: string, originalId: string): string {
  return `${originalCycleKey}#undo:${originalId}`;
}

export async function undoSubIntent(
  db: D1Database,
  id: string,
  actor: { staffId: string | null; role: string | null },
  opts: { requestedBy?: 'customer' | 'staff'; nowMs?: number } = {},
): Promise<UndoSubIntentResult> {
  const requestedBy = opts.requestedBy ?? 'customer';
  const now = toJstString(new Date(opts.nowMs ?? Date.now()));
  const row = await getSubIntent(db, id);
  if (!row) return { status: 'not_found' };

  // 取り消し依頼 (undo_of) 自体への undo = 依頼の取り下げ。
  // 元 intent を cancel_requested に立てていた場合は done へ復元する —
  // 復元しないと元 intent が cancel_requested に永久固着する (出口が存在しない)。
  if (row.op === 'undo_of' && row.supersedes_intent_id) {
    const undoCancel = await undoSubIntentCas(db, id, actor.staffId, actor.role, now);
    if (!undoCancel.cancelled) {
      const cur = await getSubIntent(db, id);
      return { status: 'not_undoable', state: cur?.state ?? row.state };
    }
    await restoreCancelRequestedCas(db, row.supersedes_intent_id);
    const updated = await getSubIntent(db, id);
    return { status: 'cancelled', intent: updated ?? { ...row, state: 'cancelled' } };
  }

  // §1-3: received|deferred は直接 CAS。0 行なら「取り消しました」と言わない
  const { cancelled } = await undoSubIntentCas(db, id, actor.staffId, actor.role, now);
  if (cancelled) {
    const updated = await getSubIntent(db, id);
    return { status: 'cancelled', intent: updated ?? { ...row, state: 'cancelled' } };
  }

  let current = await getSubIntent(db, id);
  if (!current) return { status: 'not_found' };

  // CAS 敗北 → 再読みの間に release で received へ戻っている race: もう一度だけ CAS を試す
  // (ここで not_undoable を返すと「received なのに取り消せません」という嘘になる)
  if (current.state === 'received' || current.state === 'deferred') {
    const retry = await undoSubIntentCas(db, id, actor.staffId, actor.role, now);
    if (retry.cancelled) {
      const updated = await getSubIntent(db, id);
      return { status: 'cancelled', intent: updated ?? { ...current, state: 'cancelled' } };
    }
    current = (await getSubIntent(db, id)) ?? current;
  }

  // §1-3: 実行に踏み込んだ意思の取り消しは「新しい intent」として受理する。
  // cancel_requested を含めるのは非原子な多段遷移の残留 (mark 成功 → INSERT 失敗) からの
  // 冪等リカバリ経路 — 既存 undo_of があればそれを返し、無ければ作り直す。
  if (
    current.state === 'executing' ||
    current.state === 'done' ||
    current.state === 'cancel_requested'
  ) {
    return acceptUndoOf(db, current, actor, requestedBy, now);
  }

  return { status: 'not_undoable', state: current.state };
}

/** undo_of intent の受理 (冪等)。INSERT 成功/衝突後に「取り消し依頼あり」を立てる。 */
async function acceptUndoOf(
  db: D1Database,
  current: SubIntentRow,
  actor: { staffId: string | null; role: string | null },
  requestedBy: 'customer' | 'staff',
  now: string,
): Promise<UndoSubIntentResult> {
  const undoKey = buildUndoCycleKey(current.target_cycle_key, current.id);
  const undoExecutor = current.executor === 'blocked' ? 'blocked' : 'human';
  const { inserted } = await insertSubIntent(db, {
    id: newIntentId(),
    friendId: current.friend_id,
    contractNs: current.contract_ns,
    contractKey: current.contract_key,
    targetCycleKey: undoKey,
    presentedScheduledDate: current.presented_scheduled_date,
    op: 'undo_of',
    state: 'received',
    requestedBy,
    actorStaffId: actor.staffId,
    actorRole: actor.role,
    payloadJson: null,
    deadlineAt: null,
    // §4-1: 取り消し作業もスタッフ作業 = 顧客は待っている。同じ営業カレンダーで約束する
    // (締切なしなので promise_after_deadline の開示条件には当たらない)
    promisedBy: undoExecutor === 'blocked' ? null : computePromisedBy(Date.parse(now)),
    executor: undoExecutor,
    supersedesIntentId: current.id,
    // undo_of は §4-3 の検証対象外 (元 intent の状態に従属)
    verifyBaselineJson: null,
    createdAt: now,
  });
  void inserted; // 衝突 = 同じ元 intent への二重 undo → 冪等に既存を返す
  const undoRow = await getOpenSubIntent(
    db,
    current.contract_ns,
    current.contract_key,
    undoKey,
    'undo_of',
  );
  if (!undoRow || undoRow.supersedes_intent_id !== current.id) {
    // per-original キーなら衝突相手は同一元 intent の undo_of のみのはず。
    // 引けない/不一致は競合の狭間 — 受理を宣言しない (§1-3 の規律)
    return { status: 'not_undoable', state: current.state };
  }
  // done のときだけ「取り消し依頼あり」を立てる。**INSERT の後**に行う —
  // 先に立てると INSERT が D1 エラーで落ちた時に、undo_of 参照を持たない
  // cancel_requested が残留する (CAS 負け = 並行遷移 → undo_of は受理済みなので問題ない)
  if (current.state === 'done') {
    await markCancelRequestedCas(db, current.id, now);
  }
  return { status: 'undo_accepted', undoIntent: undoRow };
}

// ============================================================
// スタッフ卓の遷移 (claim / done / fail / release)
// ============================================================

export interface StaffActor {
  staffId: string;
  role: string;
}

export type ClaimResult =
  | { status: 'claimed'; intent: SubIntentRow }
  /** CAS 0 行 = 別スタッフが先に着手 / expire 済み / 締切超過。着手と言わない */
  | { status: 'conflict'; intent: SubIntentRow | null }
  | { status: 'not_found' };

/** 着手 (§4-0)。skip/date は「締切を過ぎていない」CAS = cron expire と相互排他。 */
export async function claimSubIntent(
  db: D1Database,
  id: string,
  actor: StaffActor,
  nowMs?: number,
): Promise<ClaimResult> {
  const now = toJstString(new Date(nowMs ?? Date.now()));
  const row = await getSubIntent(db, id);
  if (!row) return { status: 'not_found' };
  const requireDeadline = row.op === 'skip' || row.op === 'date';
  const { claimed } = await claimSubIntentCas(db, id, actor.staffId, actor.role, now, requireDeadline);
  const updated = await getSubIntent(db, id);
  if (!claimed) return { status: 'conflict', intent: updated };
  return { status: 'claimed', intent: updated ?? row };
}

export type CompleteResult =
  | { status: 'done'; intent: SubIntentRow; originalResolved: boolean }
  /**
   * CAS 0 行 (§1-2): 「完了」と表示してはいけない。呼び出し側は「確認中」に落とし
   * alert を上げる (別 claim が既に触った = 二重実行の疑いを握り潰さない)。
   */
  | { status: 'conflict'; intent: SubIntentRow | null }
  | { status: 'not_found' };

export async function completeSubIntent(
  db: D1Database,
  id: string,
  actor: StaffActor,
  nowMs?: number,
): Promise<CompleteResult> {
  const now = toJstString(new Date(nowMs ?? Date.now()));
  const row = await getSubIntent(db, id);
  if (!row) return { status: 'not_found' };
  const { completed } = await completeSubIntentCas(db, id, actor.staffId, actor.role, now);
  const updated = await getSubIntent(db, id);
  if (!completed) return { status: 'conflict', intent: updated };

  // §4-3: 完了宣言を無検証で信じない — 検証待ちに入れて sweep が op 別に照合する。
  // 基準値は受理時に採取済み (verify_baseline_json)。CAS 失敗 (二重 done 等) は握り潰してよい
  // (pending は既に立っている = 検証は行われる)。
  if (VERIFIABLE_OPS.includes(row.op)) {
    await setVerifyPendingCas(db, id);
  }

  // undo_of の完了 = 元 intent の取り消しが実行された (§1-3)
  let originalResolved = false;
  if (row.op === 'undo_of' && row.supersedes_intent_id) {
    const { resolved } = await resolveUndoneOriginalCas(db, row.supersedes_intent_id, now);
    originalResolved = resolved;
  }
  return { status: 'done', intent: updated ?? row, originalResolved };
}

/**
 * done 直後の undo 受理と setVerifyPendingCas の競合で pending 登録が漏れた元 intent を、
 * undo_of 失敗による done 復元時に救済する (監査 LOW — 漏れると永久に検証対象外)。
 * setVerifyPendingCas は verify_state IS NULL の CAS なので冪等。
 */
async function reviveVerifyPendingAfterRestore(db: D1Database, originalId: string): Promise<void> {
  const original = await getSubIntent(db, originalId);
  if (original && VERIFIABLE_OPS.includes(original.op)) {
    await setVerifyPendingCas(db, originalId);
  }
}

export type FailResult =
  | { status: 'failed'; intent: SubIntentRow; originalRestored: boolean }
  | { status: 'conflict'; intent: SubIntentRow | null }
  | { status: 'not_found' };

export async function failSubIntent(
  db: D1Database,
  id: string,
  reason: string,
  actor: StaffActor,
  nowMs?: number,
): Promise<FailResult> {
  const now = toJstString(new Date(nowMs ?? Date.now()));
  const row = await getSubIntent(db, id);
  if (!row) return { status: 'not_found' };
  const { failed } = await failSubIntentCas(db, id, reason, actor.staffId, actor.role, now);
  const updated = await getSubIntent(db, id);
  if (!failed) return { status: 'conflict', intent: updated };

  // undo_of の失敗 = 取り消せなかった → 元 intent は完了状態へ戻す (§1-3)
  let originalRestored = false;
  if (row.op === 'undo_of' && row.supersedes_intent_id) {
    const { restored } = await restoreCancelRequestedCas(db, row.supersedes_intent_id);
    originalRestored = restored;
    if (restored) await reviveVerifyPendingAfterRestore(db, row.supersedes_intent_id);
  }
  return { status: 'failed', intent: updated ?? row, originalRestored };
}

export type ReleaseResult =
  | { status: 'released'; intent: SubIntentRow }
  | { status: 'conflict'; intent: SubIntentRow | null }
  | { status: 'not_found' };

/**
 * claim の明示的解放 (誤 claim の取り下げ)。
 * **これは人間の判断による解放であり、§1-2 が禁じる「human の自動解放」ではない。**
 * /admin/ops 側で「HB 管理画面での操作を行っていないこと」の確認を挟む (confirm 必須) +
 * 監査に必ず残す。自動解放は sweep が機械 executor に対してのみ行う。
 */
export async function releaseSubIntent(
  db: D1Database,
  id: string,
  nowMs?: number,
): Promise<ReleaseResult> {
  const now = toJstString(new Date(nowMs ?? Date.now()));
  const row = await getSubIntent(db, id);
  if (!row) return { status: 'not_found' };
  const { released } = await releaseSubIntentClaimCas(db, id, now);
  const updated = await getSubIntent(db, id);
  if (!released) return { status: 'conflict', intent: updated };
  return { status: 'released', intent: updated ?? row };
}

// ============================================================
// sweep (§4-2 の締切超過 + §1-2 の claim timeout)
// ============================================================

export interface SubIntentSweepEnv extends SubIntentGateEnv {
  DB: D1Database;
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
}

export interface SubIntentSweepDeps {
  lineClient?: LineClient;
  fetchImpl?: typeof fetch;
}

export interface SubIntentSweepResult {
  skippedGating?: boolean;
  pastDeadline: number;
  expired: number;
  /** expire の正直な失敗通知を送れた件数 (未連携は通知不能 = expiredUnnotified) */
  expiredNotified: number;
  expiredUnnotified: number;
  carriedOver: number;
  /** 繰越し先に別 open intent がいて superseded に落とした件数 */
  superseded: number;
  /** 繰越し先サイクルを算出できない/算出した締切が既に過去 → deadline=NULL 保持の件数 */
  carryUnanchored: number;
  /** 締切超過エスカレーション通知を出した件数 (1 intent 1 回 §4-2) */
  escalated: number;
  staleMachineClaims: number;
  releasedMachineClaims: number;
  /** human の 30 分超 claim (解放しない §1-2 — /admin/ops とアラートで人間が解決) */
  staleHumanClaims: number;
  /** claim 滞留アラート通知を出した件数 (claim 世代ごと 1 回 §1-2。escalated とは独立) */
  staleAlerted: number;
  /** §4-2 約束破り: promised_by 超過の received (未通知のみ列挙) */
  pastPromise: number;
  /** §4-2 約束破り: マーカー CAS に勝って通知フローへ進んだ件数 (1 intent 1 回) */
  promiseAlerted: number;
  promiseNotified: number;
  /** 約束破りを顧客へ届けられなかった件数 (未連携 or 送信失敗 — Discord に区別して出す) */
  promiseUnnotified: number;
  /** §4-4: 締切 24h 前を切った未実行 cancel (未エスカレーションのみ列挙) */
  cancelNearDeadline: number;
  /** §4-4: 強制エスカレーションを出した件数 */
  predeadlineEscalated: number;
  /** §4-3: 検証待ち件数 (この run の冒頭時点) */
  verifyPending: number;
  verifyOk: number;
  verifyMiss: number;
  /** §4-3: 判定保留に確定した件数 (窓内不定 — 濡れ衣の謝罪を出さない) */
  verifyInconclusive: number;
  verifyMissNotified: number;
  verifyMissUnnotified: number;
  errors: number;
}

/**
 * 5 分 cron から呼ぶ sweep。gate OFF なら即 return (= 本番 dormant)。
 *
 * §4-2 準拠:
 *   - 対象は state='received' AND executor <> 'blocked' AND deadline_at < now のみ
 *     (executing は対象外 / deferred は対象外 / blocked 除外を落とすと移行窓の解約意思が消える)
 *   - skip/date → expired + 正直な失敗通知 (transactional なので §8 の頻度制御対象外)
 *   - pause/cancel → expire させず同一行を次サイクルへ繰越し + エスカレーション (1 intent 1 回)
 *   - 機械 executor の 30 分超 claim → 解放 (解放回数を可視化)
 *   - human の 30 分超 claim → **解放しない**。アラート (1 intent 1 回) + /admin/ops で常時可視化
 */
export async function sweepSubIntents(
  env: SubIntentSweepEnv,
  deps: SubIntentSweepDeps = {},
  nowMs?: number,
): Promise<SubIntentSweepResult> {
  const result: SubIntentSweepResult = {
    pastDeadline: 0,
    expired: 0,
    expiredNotified: 0,
    expiredUnnotified: 0,
    carriedOver: 0,
    superseded: 0,
    carryUnanchored: 0,
    escalated: 0,
    staleMachineClaims: 0,
    releasedMachineClaims: 0,
    staleHumanClaims: 0,
    staleAlerted: 0,
    pastPromise: 0,
    promiseAlerted: 0,
    promiseNotified: 0,
    promiseUnnotified: 0,
    cancelNearDeadline: 0,
    predeadlineEscalated: 0,
    verifyPending: 0,
    verifyOk: 0,
    verifyMiss: 0,
    verifyInconclusive: 0,
    verifyMissNotified: 0,
    verifyMissUnnotified: 0,
    errors: 0,
  };

  if (!isSubIntentEnabled(env)) {
    return { ...result, skippedGating: true };
  }

  const db = env.DB;
  const nowDate = new Date(nowMs ?? Date.now());
  const now = toJstString(nowDate);
  const discordLines: string[] = [];

  // ---- claim timeout (§1-2) ----
  try {
    const claimedBefore = toJstString(
      new Date(nowDate.getTime() - MACHINE_CLAIM_RELEASE_MINUTES * 60_000),
    );
    const stale = await listStaleClaims(db, claimedBefore);
    for (const intent of stale) {
      if (intent.executor === 'own_billing' || intent.executor === 'api') {
        result.staleMachineClaims += 1;
        const { released } = await releaseSubIntentClaimCas(db, intent.id, now);
        if (released) {
          result.releasedMachineClaims += 1;
          await auditSweep(db, 'sub_intent.claim.auto_released', intent, {
            executor: intent.executor,
          });
        }
      } else {
        // human: 解放しない (§1-2)。アラートは claim 世代ごと 1 回 —
        // escalated_at (締切超過用) とは別マーカー。共有すると片方の消費でもう片方が沈黙する
        result.staleHumanClaims += 1;
        const { marked } = await markStaleAlertedCas(db, intent.id, now);
        if (marked) {
          result.staleAlerted += 1;
          discordLines.push(
            `⏱ ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) の着手が ` +
              `${HUMAN_CLAIM_ALERT_MINUTES} 分を超えて未解決です (担当: ${intent.actor_staff_id ?? '不明'})。` +
              `/admin/ops で解決してください`,
          );
          await auditSweep(db, 'sub_intent.claim.stale_alert', intent, {
            claimedAt: intent.claimed_at,
          });
        }
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] stale claim sweep failed:`, err);
  }

  // ---- 締切超過 (§4-2) ----
  try {
    const due = await listSubIntentsPastDeadline(db, now);
    result.pastDeadline = due.length;
    for (const intent of due) {
      try {
        if (intent.op === 'skip' || intent.op === 'date') {
          const { expired } = await expireSubIntentCas(db, intent.id, now);
          if (!expired) continue; // 並行 claim/undo が先に触った — こちらは何も宣言しない
          result.expired += 1;
          await auditSweep(db, 'sub_intent.expired', intent, { deadlineAt: intent.deadline_at });
          const notifyOutcome = await notifyExpiredHonestly(db, deps.lineClient, intent);
          if (notifyOutcome === 'notified') result.expiredNotified += 1;
          else result.expiredUnnotified += 1;
          // 未連携と送信失敗を混同しない (どちらも要フォローだが対応が違う)
          const followUp =
            notifyOutcome === 'notified'
              ? ' (顧客へ通知済み)'
              : notifyOutcome === 'unlinked'
                ? ' (LINE 未連携のため通知不可 — 電話/メールでフォローしてください)'
                : ' (LINE 通知の送信に失敗 — 手動で顧客へ連絡してください)';
          discordLines.push(
            `⚠️ ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) が締切超過で失効しました${followUp}`,
          );
        } else {
          // pause/cancel (+防御的に resume/undo_of): expire 禁止 → 次サイクルへ繰越し (§1-2)
          const carried = await carryOverToNextCycle(db, intent, now);
          if (carried === 'lost') {
            // 並行遷移 (claim/undo) の勝者が状態を所有 — こちらは何も宣言しない
            // (エスカレーションも Discord も出さない。虚偽の「繰り越しました」を作らない)
            await auditSweep(db, 'sub_intent.carry_lost', intent, {});
            continue;
          }
          if (carried === 'superseded') {
            // 新しい依頼が既に open — 以後の通知はその依頼自身のライフサイクルが担う
            result.superseded += 1;
            await auditSweep(db, 'sub_intent.superseded', intent, {});
            continue;
          }
          result.carriedOver += 1;
          if (carried === 'unanchored') result.carryUnanchored += 1;
          await auditSweep(db, 'sub_intent.carried_over', intent, { outcome: carried });
          const { marked } = await markEscalatedCas(db, intent.id, now);
          if (marked) {
            result.escalated += 1;
            discordLines.push(
              carried === 'unanchored'
                ? `🚨 ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) が締切内に実行されず、次サイクルも確定できませんでした。/admin/ops で最優先で対応してください`
                : `🚨 ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) が締切内に実行されませんでした。意思は次サイクルへ繰り越しています。/admin/ops で最優先で対応してください`,
            );
          }
        }
      } catch (err) {
        result.errors += 1;
        console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] sweep item ${intent.id} failed:`, err);
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] deadline sweep failed:`, err);
  }

  // ---- §4-4: cancel の締切 24h 前 強制エスカレーション ----
  // 締切超過 sweep の**後**に走らせる: 超過分は繰越しで deadline が前進し
  // (predeadline マーカーもリセットされ)、新しい締切に対して次 run 以降で再判定される。
  try {
    const threshold = toJstString(
      new Date(nowDate.getTime() + CANCEL_PREDEADLINE_ESCALATION_HOURS * 3600_000),
    );
    const createdBefore = toJstString(
      new Date(nowDate.getTime() - CANCEL_PREDEADLINE_ESCALATION_HOURS * 3600_000),
    );
    const nearDeadline = await listCancelIntentsNearDeadline(db, threshold, createdBefore);
    result.cancelNearDeadline = nearDeadline.length;
    for (const intent of nearDeadline) {
      const { marked } = await markPredeadlineEscalatedCas(db, intent.id, now);
      if (!marked) continue; // 並行遷移 (done/undo) の勝者が状態を所有
      result.predeadlineEscalated += 1;
      const situation =
        intent.deadline_at === null
          ? `の受付期限を確定できないまま受理から ${CANCEL_PREDEADLINE_ESCALATION_HOURS} 時間が経過しました (締切系の自動監視が効かない対象です)`
          : `が受付期限の ${CANCEL_PREDEADLINE_ESCALATION_HOURS} 時間前になっても未完了です`;
      discordLines.push(
        `🚨【最優先】解約 (${intent.contract_key}) ${situation}` +
          `${intent.state === 'executing' ? ` (担当: ${intent.actor_staff_id ?? '不明'} が対応中のまま)` : ''}。` +
          `Huckleberry 管理画面で実行してください。間に合わなかった場合は当該サイクルの注文をキャンセルまたは返金で救済します (§4-4)`,
      );
      await auditSweep(db, 'sub_intent.predeadline_escalated', intent, {
        deadlineAt: intent.deadline_at,
      });
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] predeadline sweep failed:`, err);
  }

  // ---- §4-2 一段目: 約束破り (promised_by 超過) ----
  // 締切超過 sweep の**後**に走らせる: 両方超過した skip/date は expire の正直な失敗通知が
  // 正であり、そちらで state が received でなくなるため本 sweep には現れない
  // (「お時間をいただいています」の直後に「間に合いませんでした」を届けない)。
  try {
    const pastPromise = await listSubIntentsPastPromise(db, now);
    result.pastPromise = pastPromise.length;
    for (const intent of pastPromise) {
      const { marked } = await markPromiseAlertedCas(db, intent.id, now);
      if (!marked) continue; // 並行遷移 (claim/undo/expire) の勝者が状態を所有
      result.promiseAlerted += 1;
      const outcome = await notifySubIntentCustomer(
        db,
        deps.lineClient,
        intent,
        buildPromiseBrokenMessage(intent.op),
        `sub-intent-promise-broken:${intent.id}`,
      );
      if (outcome === 'notified') result.promiseNotified += 1;
      else result.promiseUnnotified += 1;
      const followUp =
        outcome === 'notified'
          ? ' (顧客へ「お時間をいただいています」を通知済み)'
          : outcome === 'unlinked'
            ? ' (LINE 未連携のため通知不可 — 電話/メールでフォローしてください)'
            : ' (LINE 通知の送信に失敗 — 手動で顧客へ連絡してください)';
      discordLines.push(
        `⏰ ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) が約束期限 ` +
          `(${String(intent.promised_by).slice(0, 16).replace('T', ' ')}) を超えて未着手です${followUp}`,
      );
      await auditSweep(db, 'sub_intent.promise_broken', intent, {
        promisedBy: intent.promised_by,
        notifyOutcome: outcome,
      });
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] promise sweep failed:`, err);
  }

  // ---- §4-3: 実行漏れの機械検出 (done の op 別照合・3 値) ----
  try {
    const pendingVerify = await listSubIntentsVerifyPending(db);
    result.verifyPending = pendingVerify.length;
    for (const intent of pendingVerify) {
      try {
        await verifyOneIntent(db, env, deps, intent, now, result, discordLines);
      } catch (err) {
        result.errors += 1;
        console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] verify item ${intent.id} failed:`, err);
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] verify sweep failed:`, err);
  }

  // ---- Discord (best-effort・まとめて 1 通) ----
  await sendSubIntentAlert(env, discordLines, deps.fetchImpl);

  // ---- cron_run_logs (可観測性 — silent-failure を作らない) ----
  try {
    await insertCronRunLog(db, {
      jobName: SUB_INTENT_SWEEP_JOB_NAME,
      status: result.errors > 0 ? 'partial' : 'success',
      metrics: { ...result },
    });
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] cron_run_logs failed:`, err);
  }

  return result;
}

/**
 * Discord への best-effort 通知 (まとめて 1 通)。sweep と /admin/ops route
 * (done CAS 敗北 = 二重対応の疑い §1-2) が共用する。失敗しても業務は止めない。
 */
export async function sendSubIntentAlert(
  env: { DISCORD_WEBHOOK_URL?: string; ACCOUNT_NAME?: string },
  lines: string[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  if (lines.length === 0 || !env.DISCORD_WEBHOOK_URL) return;
  try {
    const f = fetchImpl ?? fetch;
    await f(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `**[${env.ACCOUNT_NAME ?? 'naturism'}] サブスク受理レイヤー**\n${lines.join('\n')}`,
      }),
    });
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] discord notify failed:`, err);
  }
}

/**
 * 繰越し先サイクルの決定:
 *   1. read-model の現在推定が「繰越し元の予定日より後ろ」ならそれを採用 (最も真実に近い)
 *   2. 出せなければ 旧予定日 + interval_days
 *   3. どちらも不能、**または算出した締切が既に過去** なら deadline=NULL で保持
 *      (= sweep に再ヒットしない。エスカレーション済みなので人間が /admin/ops で解決する。
 *      締切を捏造して意思を expire させるより誠実)。
 *      「算出できたが依然過去」を carried にすると、同じ計算を毎 run 繰り返して sweep に
 *      毎 5 分再ヒットする無限ループになる (監査 CONFIRMED — sweep 長期停止後の再開等で成立)
 *
 * 例外規律: carryOverSubIntentCas の throw は **UNIQUE 違反と確認できた場合のみ**
 * supersede へ落とす。それ以外 (D1 の transient エラー等) を supersede すると、
 * 後継の存在しない解約意思が terminal 化する = §1-2 が禁じた解約妨害の迂回 (監査 CONFIRMED)。
 * 非 UNIQUE は rethrow して sweep の per-item catch で errors に計上する。
 */
async function carryOverToNextCycle(
  db: D1Database,
  intent: SubIntentRow,
  now: string,
): Promise<'carried' | 'superseded' | 'unanchored' | 'lost'> {
  const contract = await getSubscriptionContract(db, intent.contract_key);
  const oldDate = intent.presented_scheduled_date?.slice(0, 10) ?? null;
  const estimate = contract?.next_billing_estimate?.slice(0, 10) ?? null;

  let nextDate: string | null = null;
  if (estimate && (!oldDate || estimate > oldDate)) {
    nextDate = estimate;
  } else if (oldDate && contract?.interval_days && contract.interval_days > 0) {
    nextDate = addDays(oldDate, contract.interval_days);
  }

  let newDeadline = computeDeadlineAt(nextDate);
  let anchored = nextDate !== null;
  if (newDeadline !== null && newDeadline <= now) {
    // 算出できたが既に過去 = このサイクルにも間に合っていない。締切なしで人間へ
    newDeadline = null;
    anchored = false;
  }
  const newCycleKey = buildCycleKey(intent.contract_key, nextDate);
  try {
    const { carried } = await carryOverSubIntentCas(
      db,
      intent.id,
      newCycleKey,
      newDeadline,
      nextDate,
      now,
    );
    if (!carried) return 'lost'; // 並行遷移 (claim/undo) が先に触った
    return anchored ? 'carried' : 'unanchored';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('UNIQUE constraint failed')) throw err;
    // UNIQUE = 繰越し先に open intent が既に存在するはず。実在を確認してから
    // supersede する (throw ↔ supersede 間の race・エラー誤分類の二重防御)
    const successor = await getOpenSubIntent(
      db,
      intent.contract_ns,
      intent.contract_key,
      newCycleKey,
      intent.op,
    );
    if (!successor) throw err;
    const { superseded } = await supersedeSubIntentCas(db, intent.id, now);
    return superseded ? 'superseded' : 'lost';
  }
}

// ============================================================
// 顧客通知 (§8-2: 顧客の操作起点 = transactional。頻度制御の対象外)
// ============================================================

export type SubIntentNotifyOutcome = 'notified' | 'unlinked' | 'failed';

/**
 * 顧客への LINE push (共通経路)。未連携 (届けようがない) と送信失敗 (届くはずが失敗) を
 * 区別する — どちらも要フォローだが対応が違う (§10-3 採点の教訓)。
 * retrySeed は intent 単位の決定的キー = 再実行/並行 run での二重送信を dispatch 層で抑止。
 */
export async function notifySubIntentCustomer(
  db: D1Database,
  lineClient: LineClient | undefined,
  intent: SubIntentRow,
  text: string,
  retrySeed: string,
): Promise<SubIntentNotifyOutcome> {
  if (!lineClient || !intent.friend_id) return 'unlinked';
  // friend 引きも try 内に置く — マーカー/verdict CAS 消費後にここで throw すると
  // 「通知したことになっているのに届いていない」が無記録で確定する (監査 MEDIUM)。
  // 失敗は 'failed' で返し、呼び出し側の Discord フォロー行に載せる
  let friend: { id: string; line_user_id: string | null } | null;
  try {
    friend = await getFriendRowById(db, intent.friend_id);
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] friend lookup failed for ${intent.id}:`, err);
    return 'failed';
  }
  if (!friend || !friend.line_user_id) return 'unlinked';
  try {
    await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'transactional',
        linePayload: {
          messages: [{ type: 'text', text }],
          retryKey: await deterministicRetryKey(retrySeed),
        },
      },
    );
    return 'notified';
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] notify failed for ${intent.id}:`, err);
    return 'failed';
  }
}

/** expire の正直な失敗通知 (§4-2)。 */
async function notifyExpiredHonestly(
  db: D1Database,
  lineClient: LineClient | undefined,
  intent: SubIntentRow,
): Promise<SubIntentNotifyOutcome> {
  const label = SUB_INTENT_OP_LABELS[intent.op];
  return notifySubIntentCustomer(
    db,
    lineClient,
    intent,
    `【お手続きが完了できませんでした】\n` +
      `承っていた「${label}」を、変更受付期限 (次回決済日の3日前) までに完了できませんでした。誠に申し訳ございません。\n\n` +
      `今回の定期便は通常どおりのお手続きとなります。ご要望がございましたら、このトークルームでご連絡ください。スタッフが必ず対応いたします。`,
    `sub-intent-expired:${intent.id}`,
  );
}

/**
 * §4-2 約束破り (1 intent 1 回)。「黙って遅れる」を構造的に不可能にする。
 * ⚠️ 文言は op の terminal 規則と一致させる (監査 CONFIRMED):
 *   - pause/cancel は expire しない (繰越し §1-2) → 「必ず完了」と言ってよい
 *   - skip/date は締切超過で expired になりうる → 「必ず完了」は嘘になる
 *     (この通知の直後に expire の「完了できませんでした」が届く経路が同居している)
 */
export function buildPromiseBrokenMessage(op: SubIntentOp): string {
  const label = SUB_INTENT_OP_LABELS[op];
  const head =
    `【お手続きの進捗のご連絡】\n` +
    `承っております「${label}」のお手続きに、お約束したお時間よりお時間をいただいています。誠に申し訳ございません。\n\n`;
  if (op === 'pause' || op === 'cancel') {
    return (
      head +
      `お手続きは必ず完了し、完了しましたらあらためてご連絡いたします。お急ぎの場合は、このトークルームでご連絡ください。`
    );
  }
  return (
    head +
    `受付期限までに完了できるよう対応を進めています。万一間に合わなかった場合も、必ずご連絡いたします。お急ぎの場合は、このトークルームでご連絡ください。`
  );
}

/** §8-2: 完了 push (1 通・失敗 push と CAS で排他)。/admin/ops の done 記録後に route が送る。 */
export async function notifySubIntentDone(
  db: D1Database,
  lineClient: LineClient | undefined,
  intent: SubIntentRow,
): Promise<SubIntentNotifyOutcome> {
  const label = SUB_INTENT_OP_LABELS[intent.op];
  return notifySubIntentCustomer(
    db,
    lineClient,
    intent,
    `【お手続き完了のお知らせ】\n` +
      `ご依頼いただいていた「${label}」のお手続きが完了しました。\n\n` +
      `ご不明な点がございましたら、このトークルームでいつでもご連絡ください。`,
    `sub-intent-done:${intent.id}`,
  );
}

/** §8-2: 失敗 push (正直な失敗)。fail_reason は自由記述 (PII リスク) のため顧客文言に埋めない。 */
export async function notifySubIntentFailed(
  db: D1Database,
  lineClient: LineClient | undefined,
  intent: SubIntentRow,
): Promise<SubIntentNotifyOutcome> {
  const label = SUB_INTENT_OP_LABELS[intent.op];
  return notifySubIntentCustomer(
    db,
    lineClient,
    intent,
    `【お手続きが完了できませんでした】\n` +
      `ご依頼いただいていた「${label}」のお手続きを完了できませんでした。誠に申し訳ございません。\n\n` +
      `スタッフよりあらためてご連絡し、対応方法をご案内いたします。お急ぎの場合は、このトークルームでご連絡ください。`,
    `sub-intent-failed:${intent.id}`,
  );
}

/** §4-3 検出時アクション①: 謝罪 + 是正案内 (返金/再送の判断は人間 = 断定しない)。 */
export function buildVerifyMissMessage(op: SubIntentOp): string {
  const label = SUB_INTENT_OP_LABELS[op];
  return (
    `【お手続きの確認のお願い】\n` +
    `承っておりました「${label}」の反映状況に、確認が必要な点が見つかりました。誠に申し訳ございません。\n\n` +
    `スタッフが状況を確認し、必要な場合は返金や是正のご対応をいたします。確認でき次第、あらためてご連絡いたします。`
  );
}

// ============================================================
// 受理時の顧客向け文言 (§4-1 の約束 + §4-4 の救済手順。§10-5 のカード返信も共用する)
// ============================================================

/** promised_by (`YYYY-MM-DDT17:00:00.000+09:00`) → 「M月D日 17:00」 */
export function formatPromisedBy(promisedBy: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(promisedBy);
  if (!m) return promisedBy;
  return `${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}`;
}

/**
 * 受理時に顧客へ伝える文言 (§8-2: 受理 = reply / 画面内表示)。
 * - §4-1: 反映予定 (promised_by) を必ず含める — 「承りました」だけの受理は約束ではない
 * - §4-4: cancel には救済手順を必ず含める (間に合わなければ必ず連絡・発送済みは返金)
 * - モードB (executor='blocked'): 営業時間ベースの約束を出さない (§4-1)
 */
export function buildAcceptanceMessage(
  op: SubIntentOp,
  promisedBy: string | null,
  executor: SubIntentExecutor,
): string {
  const label = SUB_INTENT_OP_LABELS[op];
  let text = `「${label}」のご依頼を承りました。\n`;
  if (executor === 'blocked') {
    text += `お切り替え手続きの都合で、反映までお時間をいただきます。反映しましたら必ずご連絡いたします。`;
  } else if (promisedBy) {
    text += `${formatPromisedBy(promisedBy)} までに反映予定です。完了しましたら必ずご連絡いたします。`;
  } else {
    text += `スタッフが順に対応し、完了しましたら必ずご連絡いたします。`;
  }
  if (op === 'cancel') {
    text +=
      `\n\n解約のご依頼が期限切れで無効になることはありません。` +
      `万が一お手続きが間に合わなかった場合は必ずご連絡し、すでに発送済みのときは返金でご対応いたします。`;
  }
  return text;
}

/**
 * §4-1 の受理前開示 (「今回は間に合いません」)。受理せずこれを提示し、顧客に選ばせる。
 * 判定式は promised_by > deadline_at の 1 つだけ (§4-1)。
 */
export function buildLatePromiseDisclosure(
  op: SubIntentOp,
  promisedBy: string,
  deadlineAt: string,
): string {
  const label = SUB_INTENT_OP_LABELS[op];
  const deadlineDate = deadlineAt.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(deadlineDate);
  const deadlineJa = m ? `${Number(m[2])}月${Number(m[3])}日` : deadlineDate;
  let text =
    `申し訳ございません。「${label}」の反映をお約束できる最短が ${formatPromisedBy(promisedBy)} となり、` +
    `今回の変更受付期限 (${deadlineJa}) に間に合わない見込みです。\n\n`;
  if (op === 'cancel' || op === 'pause') {
    text +=
      `ご依頼が期限切れで無効になることはありません。間に合わなかった場合は当該サイクルのご注文をキャンセルまたは返金でご対応いたします。それでもよろしければ承ります。`;
  } else {
    text +=
      `その場合、今回の定期便は通常どおりのお手続きとなる可能性があります。それでもよろしければ承り、できる限り早く対応いたします。`;
  }
  return text;
}

/** friends を id で引く最小クエリ (既存 DB 層に by-id 取得が無いためここで直接引く)。 */
async function getFriendRowById(
  db: D1Database,
  friendId: string,
): Promise<{ id: string; line_user_id: string | null } | null> {
  return db
    .prepare(`SELECT id, line_user_id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ id: string; line_user_id: string | null }>();
}

// ============================================================
// §4-3: 実行漏れの機械検出 — op 別に、窓で、第3値ありで
// ============================================================

/** 契約突合済みの注文証拠 (parseOrderSubscriptionTags で厳密一致させたもののみ)。 */
export interface OrderEvidence {
  /** subscription-count タグ (無ければ null = count 前進判定に使えない) */
  orderCount: number | null;
  /** shopify_orders.created_at (= 初回 import 時刻。新規注文は webhook 到着 ≈ 実注文時刻) */
  createdAt: string;
}

export type VerifyOutcome =
  | { verdict: 'pending' }
  | { verdict: 'ok' | 'miss' | 'inconclusive'; reason: string };

export interface EvaluateExecutionInput {
  op: SubIntentOp;
  /** intent.presented_scheduled_date (= 対象サイクルの予定日) */
  presentedDate: string | null;
  /** op='date' の希望日 (payload.requestedDate)。無ければ照合不能 = 判定保留 */
  requestedDate: string | null;
  /** done 時刻 (intent.resolved_at) */
  doneAt: string;
  baseline: VerifyBaseline;
  contract: Pick<
    SubscriptionContractRow,
    'next_billing_estimate' | 'estimate_source' | 'interval_days' | 'skip_count' | 'cancelled_at' | 'paused_at'
  > | null;
  /** 契約一致済みの注文 (baseline.acceptedAt 以降) */
  orders: OrderEvidence[];
  /** skip 用: 同一契約の他の done skip 件数 (>0 なら前進量 2 周期は二重 skip と断定できない) */
  otherDoneSameOp: number;
  /** pause/cancel 用: done 後に再開 (resume) が done になっている (以後の注文は正当でありうる) */
  resumedAfterDone: boolean;
  nowJst: string;
}

const DAY_MS = 86_400_000;

function dayDiff(fromDate: string, toDate: string): number | null {
  const a = Date.parse(`${fromDate.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * op 別照合 (§4-3 の表)。判定は ok / miss / inconclusive(判定保留) の 3 値 + pending (窓が
 * まだ閉じていない)。**窓内不定は保留にして誤検知を出さない** — miss の謝罪 push は
 * 「新サイクルの課金が実際に走った」強い証拠 (subscription-count の前進) があるときだけ。
 *
 * 濡れ衣 (誤 miss) の主な防御:
 *   - 注文は subscription-count > baseline.orderCount のものだけを「新しい課金」と数える。
 *     count タグの無い注文・古い注文の遅延 import (orders/updated 経由) は課金の証拠にしない
 *     (60 日窓の外の旧注文が webhook で今 INSERT されると created_at が今になる — import 時刻
 *     だけで判定すると旧注文の返金 1 件で謝罪 push が飛ぶ)
 *   - 前進量ベースの二重 skip 判定は estimate_source='flow' 前提 (derived は判定保留)、
 *     かつ他の done skip が同一契約にあれば保留 (正当な 2 回スキップと区別できない)
 */
export function evaluateExecution(input: EvaluateExecutionInput): VerifyOutcome {
  const { op, baseline, contract, orders, nowJst } = input;
  const today = nowJst.slice(0, 10);

  // 「新しい課金」と数えてよい注文 (count 前進 + 受理後に出現)。
  // baseline の回数が不明 (null/欠落) なら count 前進は判定不能 = 課金の証拠を立てない
  const baselineCount = typeof baseline.orderCount === 'number' ? baseline.orderCount : null;
  const newCycleOrders =
    baselineCount === null
      ? []
      : orders.filter(
          (o) =>
            o.orderCount !== null && o.orderCount > baselineCount && o.createdAt >= baseline.acceptedAt,
        );
  const untaggedOrders = orders.filter((o) => o.orderCount === null);

  if (op === 'skip') {
    const presented = input.presentedDate?.slice(0, 10) ?? null;
    if (!presented || !/^\d{4}-\d{2}-\d{2}$/.test(presented)) {
      return { verdict: 'inconclusive', reason: 'no_presented_date' };
    }
    const lo = addDays(presented, baseline.source === 'flow' ? -2 : -3);
    const hi = addDays(presented, 7);
    const inWindow = (d: string) => {
      const day = d.slice(0, 10);
      return day >= lo && day <= hi;
    };
    // ① スキップ対象サイクルの窓に課金が出た = スキップ漏れ (即 miss)
    if (newCycleOrders.some((o) => inWindow(o.createdAt))) {
      return { verdict: 'miss', reason: 'order_in_skip_window' };
    }
    // ② 前進量: flow 実測でだけ測る (derived は判定保留 — §4-3)
    const interval = baseline.intervalDays ?? contract?.interval_days ?? null;
    const flowEstimate =
      baseline.source === 'flow' && contract?.estimate_source === 'flow'
        ? (contract.next_billing_estimate?.slice(0, 10) ?? null)
        : null;
    const delta =
      flowEstimate !== null && interval !== null && interval > 0
        ? dayDiff(presented, flowEstimate)
        : null;
    if (delta !== null && interval !== null && delta >= 2 * interval - 2) {
      // 二重 skip の疑い — ただし他の done skip があるなら正当な 2 回 (保留)
      if (input.otherDoneSameOp > 0) {
        return { verdict: 'inconclusive', reason: 'multiple_skips_executed' };
      }
      // 顧客が HB マイページ等で直接スキップした分 (intent を経ない) も二重 skip ではない —
      // read-model の skip 累計が 2 以上進んでいるなら「2 回スキップされた事実」があるだけ (監査 MEDIUM)
      const skipAdvance =
        contract && typeof baseline.skipCount === 'number'
          ? (contract.skip_count ?? 0) - baseline.skipCount
          : null;
      if (skipAdvance !== null && skipAdvance >= 2) {
        return { verdict: 'inconclusive', reason: 'multiple_skips_observed' };
      }
      return { verdict: 'miss', reason: 'double_skip' };
    }
    // 窓の終端: 「推定日 + 周期の半分」まで open のまま監視 (§4-3。1 点判定にしない)
    const evalAt = addDays(presented, interval && interval > 0 ? Math.max(8, Math.ceil(interval / 2)) : 14);
    if (today <= evalAt) return { verdict: 'pending' };
    if (untaggedOrders.some((o) => inWindow(o.createdAt))) {
      return { verdict: 'inconclusive', reason: 'untagged_order_in_window' };
    }
    if (delta !== null && interval !== null) {
      if (Math.abs(delta - interval) <= 2) {
        return { verdict: 'ok', reason: 'estimate_advanced_one_cycle' };
      }
      return { verdict: 'inconclusive', reason: 'estimate_not_advanced' };
    }
    return { verdict: 'inconclusive', reason: 'no_flow_measurement' };
  }

  if (op === 'date') {
    const oldDate = input.presentedDate?.slice(0, 10) ?? null;
    const newDate = input.requestedDate?.slice(0, 10) ?? null;
    if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return { verdict: 'inconclusive', reason: 'no_requested_date' };
    }
    if (!oldDate || !/^\d{4}-\d{2}-\d{2}$/.test(oldDate)) {
      return { verdict: 'inconclusive', reason: 'no_presented_date' };
    }
    const nearNew = (d: string) => {
      const diff = dayDiff(newDate, d);
      return diff !== null && Math.abs(diff) <= 2;
    };
    const oldLo = addDays(oldDate, -2);
    const oldHi = addDays(oldDate, 7);
    const inOldWindow = (d: string) => {
      const day = d.slice(0, 10);
      return day >= oldLo && day <= oldHi;
    };
    // 旧予定日側にのみ出た課金 = 変更漏れ (新予定日の近傍は正当なので除外 — 小幅の変更で両窓が重なる)
    if (newCycleOrders.some((o) => inOldWindow(o.createdAt) && !nearNew(o.createdAt))) {
      return { verdict: 'miss', reason: 'order_on_old_date' };
    }
    const evalAt = addDays(oldDate > newDate ? oldDate : newDate, 7);
    if (today <= evalAt) return { verdict: 'pending' };
    if (newCycleOrders.some((o) => nearNew(o.createdAt))) {
      return { verdict: 'ok', reason: 'order_on_new_date' };
    }
    if (untaggedOrders.length > 0) {
      return { verdict: 'inconclusive', reason: 'untagged_order_in_window' };
    }
    return { verdict: 'inconclusive', reason: 'no_order_observed' };
  }

  if (op === 'pause' || op === 'cancel') {
    // タグ由来の直接証拠 (webhook が read-model に反映済み) があれば即 ok
    const tagDate = op === 'cancel' ? contract?.cancelled_at : contract?.paused_at;
    if (tagDate && tagDate.slice(0, 10) >= baseline.acceptedAt.slice(0, 10)) {
      return { verdict: 'ok', reason: `${op}_tag_present` };
    }
    // 「以後の注文が出ないこと」(§4-3) — done 後の新しい課金は miss。
    // ただし done 後に再開 (resume) が実行済みなら正当でありうる (保留)
    const afterDone = newCycleOrders.filter((o) => o.createdAt >= input.doneAt);
    if (afterDone.length > 0) {
      if (input.resumedAfterDone) {
        return { verdict: 'inconclusive', reason: 'resumed_after_done' };
      }
      return { verdict: 'miss', reason: `order_after_${op}` };
    }
    // 窓 = 次サイクル 1 周期分 (周期不明は 30 日で判定保留に落とす — 窓を捏造して ok を出さない)
    const interval = baseline.intervalDays ?? contract?.interval_days ?? null;
    const evalAt = addDays(input.doneAt.slice(0, 10), interval && interval > 0 ? interval : 30);
    if (today <= evalAt) return { verdict: 'pending' };
    if (untaggedOrders.some((o) => o.createdAt >= input.doneAt)) {
      return { verdict: 'inconclusive', reason: 'untagged_order_observed' };
    }
    if (!interval || interval <= 0) {
      return { verdict: 'inconclusive', reason: 'interval_unknown' };
    }
    return { verdict: 'ok', reason: 'no_order_in_cycle' };
  }

  // resume / undo_of は検証対象外 (VERIFIABLE_OPS が入口で弾く) — 防御的に保留
  return { verdict: 'inconclusive', reason: 'op_not_verifiable' };
}

/** intent.payload_json から op='date' の希望日を取り出す (受理時に形式検証済み)。 */
export function requestedDateFromPayload(payloadJson: string | null): string | null {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson) as { requestedDate?: unknown };
    return typeof p.requestedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.requestedDate)
      ? p.requestedDate
      : null;
  } catch {
    return null;
  }
}

/**
 * 検証待ち 1 件の照合 → verdict 確定 (CAS) → 検出時アクション (§4-3)。
 * verdict CAS の勝者だけが通知する = miss の謝罪 push は 1 intent 1 回 (別マーカー不要)。
 */
async function verifyOneIntent(
  db: D1Database,
  env: SubIntentSweepEnv,
  deps: SubIntentSweepDeps,
  intent: SubIntentRow,
  now: string,
  result: SubIntentSweepResult,
  discordLines: string[],
): Promise<void> {
  let baseline: VerifyBaseline | null = null;
  try {
    baseline = intent.verify_baseline_json
      ? (JSON.parse(intent.verify_baseline_json) as VerifyBaseline)
      : null;
  } catch {
    baseline = null;
  }

  let outcome: VerifyOutcome;
  let ordersTruncated = false;
  if (!baseline || typeof baseline.acceptedAt !== 'string') {
    outcome = { verdict: 'inconclusive', reason: 'baseline_unreadable' };
  } else {
    const contract = await getSubscriptionContract(db, intent.contract_key);
    const rawOrders = await listSubscriptionOrdersSince(db, baseline.acceptedAt, ORDER_SCAN_LIMIT);
    // LIMIT (ASC) は**最新側**を切り捨てる = pause/cancel の miss 証拠がまさに落ちる側 (監査 CONFIRMED)。
    // 打ち切りが起きた走査で「注文なし」を根拠に ok を宣言してはいけない (miss は実在証拠なので有効)
    ordersTruncated = rawOrders.length >= ORDER_SCAN_LIMIT;
    const orders: OrderEvidence[] = [];
    for (const o of rawOrders) {
      const parsed = parseOrderSubscriptionTags(o.tags);
      if (parsed && parsed.contractId === intent.contract_key) {
        orders.push({ orderCount: parsed.orderCount, createdAt: o.created_at });
      }
    }
    const doneAt = intent.resolved_at ?? intent.created_at;
    const otherDoneSameOp =
      intent.op === 'skip'
        ? await countOtherDoneSubIntents(
            db, intent.contract_ns, intent.contract_key, 'skip', intent.id, baseline.acceptedAt,
          )
        : 0;
    const resumedAfterDone =
      intent.op === 'pause' || intent.op === 'cancel'
        ? (await countOtherDoneSubIntents(
            db, intent.contract_ns, intent.contract_key, 'resume', intent.id, doneAt,
          )) > 0
        : false;
    outcome = evaluateExecution({
      op: intent.op,
      presentedDate: intent.presented_scheduled_date,
      requestedDate: requestedDateFromPayload(intent.payload_json),
      doneAt,
      baseline,
      contract,
      orders,
      otherDoneSameOp,
      resumedAfterDone,
      nowJst: now,
    });
  }

  if (outcome.verdict === 'ok' && ordersTruncated) {
    outcome = { verdict: 'inconclusive', reason: 'order_scan_truncated' };
  }

  if (outcome.verdict === 'pending') return;

  const { set } = await setVerifyVerdictCas(db, intent.id, outcome.verdict, now);
  if (!set) return; // 並行 run の勝者が通知を所有

  if (outcome.verdict === 'ok') result.verifyOk += 1;
  else if (outcome.verdict === 'miss') result.verifyMiss += 1;
  else result.verifyInconclusive += 1;

  await auditSweep(db, `sub_intent.verify.${outcome.verdict}`, intent, { reason: outcome.reason });

  if (outcome.verdict === 'miss') {
    // 検出時アクション (§4-3): ① 顧客へ謝罪 + 是正案内 (transactional) ② Discord
    // ③ 返金/再送の判断は人間 (通知でも断定しない)
    const notifyOutcome = await notifySubIntentCustomer(
      db,
      deps.lineClient,
      intent,
      buildVerifyMissMessage(intent.op),
      `sub-intent-verify-miss:${intent.id}`,
    );
    if (notifyOutcome === 'notified') result.verifyMissNotified += 1;
    else result.verifyMissUnnotified += 1;
    const followUp =
      notifyOutcome === 'notified'
        ? ' (顧客へ謝罪と是正案内を通知済み)'
        : notifyOutcome === 'unlinked'
          ? ' (LINE 未連携のため通知不可 — 電話/メールでフォローしてください)'
          : ' (LINE 通知の送信に失敗 — 手動で顧客へ連絡してください)';
    discordLines.push(
      `🚨 実行漏れの疑い: ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) — ` +
        `${outcome.reason}${followUp}。返金/是正の判断をお願いします (§4-3)`,
    );
  } else if (outcome.verdict === 'inconclusive' && INCONCLUSIVE_NEEDS_HUMAN.has(outcome.reason)) {
    // 濡れ衣を避けて保留にしたが、顧客影響がありうる保留は人間の目に必ず載せる —
    // 特に multiple_skips_* (二重 skip の疑い。直接スキップと区別できないため謝罪は
    // 送らないが、§4-3 の「前倒し是正の判断は人間」はここから始まる)
    discordLines.push(
      `⚠️ 判定保留: ${SUB_INTENT_OP_LABELS[intent.op]} (${intent.contract_key}) — ${outcome.reason}。` +
        `Huckleberry 管理画面で実状を確認してください (§4-3)`,
    );
  }
}

/**
 * 判定保留のうち「顧客影響がありうる = 人間の確認が必要」な理由 (Discord に載せる)。
 * データ不足系 (no_requested_date / no_flow_measurement / interval_unknown 等) は
 * 構造的にどうにもならないためノイズにしない。
 */
const INCONCLUSIVE_NEEDS_HUMAN: ReadonlySet<string> = new Set([
  'untagged_order_in_window',
  'untagged_order_observed',
  'multiple_skips_observed',
  'multiple_skips_executed',
  'estimate_not_advanced',
  'order_scan_truncated',
]);

/** sweep 遷移の監査 (§4 — 全遷移を audit_logs に残す)。best-effort。 */
async function auditSweep(
  db: D1Database,
  action: string,
  intent: SubIntentRow,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditLog(db, {
      actorType: 'cron',
      actorId: SUB_INTENT_SWEEP_JOB_NAME,
      action,
      targetType: 'sub_intent',
      targetId: intent.id,
      // PII を残さない (§1-4): contract_key と op のみ
      metadata: { contractKey: intent.contract_key, op: intent.op, ...metadata },
    });
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] audit failed for ${intent.id}:`, err);
  }
}
