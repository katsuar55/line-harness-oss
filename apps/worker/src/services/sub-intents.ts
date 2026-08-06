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
  listSubIntentsPastDeadline,
  listStaleClaims,
  getSubscriptionContract,
  getFriendByShopifyCustomerId,
  insertAuditLog,
  insertCronRunLog,
  toJstString,
  type SubIntentRow,
  type SubIntentOp,
  type SubIntentExecutor,
} from '@line-crm/db';
import { dispatch } from './channel-dispatcher.js';
import { deterministicRetryKey } from './subscription-billing-reminder.js';
import { BILLING_DEADLINE_LEAD_DAYS } from './subscription-concierge.js';
import { addDays } from './subscription-contracts.js';

export const SUB_INTENT_SWEEP_JOB_NAME = 'sub-intents-sweep';

/** 機械 executor (own_billing|api) の claim 自動解放閾値 (§1-2)。human には適用しない。 */
export const MACHINE_CLAIM_RELEASE_MINUTES = 30;
/** human executor の claim 未解決アラート閾値 (§1-2 — 解放はせずアラートのみ)。 */
export const HUMAN_CLAIM_ALERT_MINUTES = 30;

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
  /** INSERT 0 行なのに open 行も引けない (= 競合の狭間)。受理を宣言しない */
  | { status: 'conflict' };

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
  const now = toJstString(new Date(input.nowMs ?? Date.now()));
  const cycleKey = buildCycleKey(input.contractKey, scheduledDate);
  // resume は締切に縛られない (再開意思を期限で失効させる理由がない)
  const deadlineAt = input.op === 'resume' ? null : computeDeadlineAt(scheduledDate);

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
    executor,
    supersedesIntentId: null,
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
    executor: current.executor === 'blocked' ? 'blocked' : 'human',
    supersedesIntentId: current.id,
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

  // undo_of の完了 = 元 intent の取り消しが実行された (§1-3)
  let originalResolved = false;
  if (row.op === 'undo_of' && row.supersedes_intent_id) {
    const { resolved } = await resolveUndoneOriginalCas(db, row.supersedes_intent_id, now);
    originalResolved = resolved;
  }
  return { status: 'done', intent: updated ?? row, originalResolved };
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

/** expire の正直な失敗通知 (§4-2)。未連携 (届けようがない) と送信失敗 (届くはずが失敗) を区別する。 */
async function notifyExpiredHonestly(
  db: D1Database,
  lineClient: LineClient | undefined,
  intent: SubIntentRow,
): Promise<'notified' | 'unlinked' | 'failed'> {
  if (!lineClient || !intent.friend_id) return 'unlinked';
  const friend = await getFriendRowById(db, intent.friend_id);
  if (!friend || !friend.line_user_id) return 'unlinked';
  try {
    const label = SUB_INTENT_OP_LABELS[intent.op];
    await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'transactional',
        linePayload: {
          messages: [
            {
              type: 'text',
              text:
                `【お手続きが完了できませんでした】\n` +
                `承っていた「${label}」を、変更受付期限 (次回決済日の3日前) までに完了できませんでした。誠に申し訳ございません。\n\n` +
                `今回の定期便は通常どおりのお手続きとなります。ご要望がございましたら、このトークルームでご連絡ください。スタッフが必ず対応いたします。`,
            },
          ],
          retryKey: await deterministicRetryKey(`sub-intent-expired:${intent.id}`),
        },
      },
    );
    return 'notified';
  } catch (err) {
    console.error(`[${SUB_INTENT_SWEEP_JOB_NAME}] expire notify failed for ${intent.id}:`, err);
    return 'failed';
  }
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
