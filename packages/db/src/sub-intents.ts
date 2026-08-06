/**
 * sub_intents DB layer (= サブスク受理レイヤーの台帳、 §10-3、 2026-08-06)
 *
 * 役割:
 *   sub_intents テーブル (= migration 076) の純 D1 クエリ。
 *   受理 (INSERT ... ON CONFLICT DO NOTHING) と全 state 遷移 (CAS) を提供する。
 *
 * 不変条件 (= service 層 apps/worker/src/services/sub-intents.ts と協調):
 *   - 受理の一意性は partial UNIQUE `ux_sub_intents_open` が DB レベルで担保
 *     (open = received|executing|deferred)。INSERT が 0 行なら既存 open intent を返す
 *     (= 二重タップは冪等に「承り済みです」)。
 *   - **全 state 遷移は CAS** (`WHERE state = ?` / `WHERE state IN (...)`)。changes=0 は
 *     「別の遷移が先に触った」= 呼び出し側は成功を宣言してはいけない (§1-3 の規律を全遷移に適用)。
 *   - 繰越し (pause/cancel の締切超過) は**同一行の UPDATE** (§1-2)。繰越し先に別 open intent が
 *     いると UNIQUE で throw する — 呼び出し側 (service) が superseded へ落とす。
 *   - PII: friend_id / contract_key / op のみ。氏名・メール等は保存しない。
 *
 * 関連:
 *   - packages/db/migrations/076_sub_intents.sql (スキーマ + state 一覧のコメント)
 *   - docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §1 (設計)
 */

export type SubIntentOp = 'skip' | 'date' | 'pause' | 'resume' | 'cancel' | 'undo_of';

export type SubIntentState =
  | 'received'
  | 'executing'
  | 'done'
  | 'expired'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'deferred'
  | 'superseded';

export type SubIntentExecutor = 'human' | 'own_billing' | 'api' | 'blocked';

/** partial UNIQUE `ux_sub_intents_open` の対象 (= 「open」の定義。migration 076 と一致させること) */
export const SUB_INTENT_OPEN_STATES: readonly SubIntentState[] = [
  'received',
  'executing',
  'deferred',
] as const;

export interface SubIntentRow {
  id: string;
  friend_id: string | null;
  contract_ns: string;
  contract_key: string;
  target_cycle_key: string;
  presented_scheduled_date: string | null;
  op: SubIntentOp;
  state: SubIntentState;
  requested_by: string;
  actor_staff_id: string | null;
  actor_role: string | null;
  payload_json: string | null;
  deadline_at: string | null;
  promised_by: string | null;
  claimed_at: string | null;
  executor: SubIntentExecutor;
  supersedes_intent_id: string | null;
  fail_reason: string | null;
  carryover_count: number;
  escalated_at: string | null;
  /** claim 滞留アラート済み (claim 世代ごと。claim/release でクリア = escalated_at と独立 §1-2) */
  stale_alerted_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface InsertSubIntentInput {
  id: string;
  friendId: string | null;
  contractNs: string;
  contractKey: string;
  targetCycleKey: string;
  presentedScheduledDate: string | null;
  op: SubIntentOp;
  /** 'deferred' (executor='blocked') 以外は 'received' で入れる */
  state: 'received' | 'deferred';
  requestedBy: string;
  actorStaffId: string | null;
  actorRole: string | null;
  payloadJson: string | null;
  deadlineAt: string | null;
  executor: SubIntentExecutor;
  supersedesIntentId: string | null;
  createdAt: string;
}

/**
 * 受理 (§1-1)。partial UNIQUE に対する INSERT ... ON CONFLICT DO NOTHING。
 * @returns inserted=true なら本呼び出しが受理した。false なら同一 (ns,key,cycle,op) の
 *          open intent が既に存在する (= 呼び出し側は getOpenSubIntent で既存行を返すこと)。
 */
export async function insertSubIntent(
  db: D1Database,
  input: InsertSubIntentInput,
): Promise<{ inserted: boolean }> {
  const res = await db
    .prepare(
      `INSERT INTO sub_intents
         (id, friend_id, contract_ns, contract_key, target_cycle_key, presented_scheduled_date,
          op, state, requested_by, actor_staff_id, actor_role, payload_json,
          deadline_at, promised_by, claimed_at, executor, supersedes_intent_id,
          fail_reason, carryover_count, escalated_at, stale_alerted_at, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, NULL, NULL, ?, NULL)
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      input.id,
      input.friendId,
      input.contractNs,
      input.contractKey,
      input.targetCycleKey,
      input.presentedScheduledDate,
      input.op,
      input.state,
      input.requestedBy,
      input.actorStaffId,
      input.actorRole,
      input.payloadJson,
      input.deadlineAt,
      input.executor,
      input.supersedesIntentId,
      input.createdAt,
    )
    .run();
  return { inserted: (res.meta?.changes ?? 0) > 0 };
}

export async function getSubIntent(db: D1Database, id: string): Promise<SubIntentRow | null> {
  return db.prepare(`SELECT * FROM sub_intents WHERE id = ?`).bind(id).first<SubIntentRow>();
}

/** 同一 (ns,key,cycle,op) の open intent (= partial UNIQUE が守っている行) を引く。 */
export async function getOpenSubIntent(
  db: D1Database,
  contractNs: string,
  contractKey: string,
  targetCycleKey: string,
  op: SubIntentOp,
): Promise<SubIntentRow | null> {
  return db
    .prepare(
      `SELECT * FROM sub_intents
        WHERE contract_ns = ? AND contract_key = ? AND target_cycle_key = ? AND op = ?
          AND state IN ('received','executing','deferred')`,
    )
    .bind(contractNs, contractKey, targetCycleKey, op)
    .first<SubIntentRow>();
}

/**
 * claim (§4-0): received → executing。
 * requireDeadline=true (op='skip'|'date') のときだけ「締切を過ぎていないこと」を付ける —
 * cron の expire sweep (deadline_at < now) と**相互排他な述語**になり、「失敗通知の
 * 3 分後にスタッフが done を押す」を構造的に不可能にする。
 * deadline_at IS NULL (締切不明) は claim 可 — expire sweep も NULL は対象外なので
 * 「どちらも触らない」で一貫する (NULL を claim 不能にすると締切不明の依頼が永久に死ぬ)。
 * pause/cancel は §1-2 (expire 禁止・繰越し) を成立させるため締切条件を付けない。
 */
export async function claimSubIntentCas(
  db: D1Database,
  id: string,
  staffId: string,
  staffRole: string,
  now: string,
  requireDeadline: boolean,
): Promise<{ claimed: boolean }> {
  // stale_alerted_at は claim 世代ごとにリセット (新しい claim には新しい滞留アラート枠 §1-2)
  const sql = requireDeadline
    ? `UPDATE sub_intents
          SET state = 'executing', claimed_at = ?, actor_staff_id = ?, actor_role = ?, stale_alerted_at = NULL
        WHERE id = ? AND state = 'received' AND (deadline_at IS NULL OR deadline_at > ?)`
    : `UPDATE sub_intents
          SET state = 'executing', claimed_at = ?, actor_staff_id = ?, actor_role = ?, stale_alerted_at = NULL
        WHERE id = ? AND state = 'received'`;
  const stmt = requireDeadline
    ? db.prepare(sql).bind(now, staffId, staffRole, id, now)
    : db.prepare(sql).bind(now, staffId, staffRole, id);
  const res = await stmt.run();
  return { claimed: (res.meta?.changes ?? 0) > 0 };
}

/**
 * 完了 (§1-2): executing → done。
 * 0 行なら呼び出し側は**「完了」と表示してはいけない** (別 claim が既に触った = 二重実行の疑い)。
 */
export async function completeSubIntentCas(
  db: D1Database,
  id: string,
  staffId: string,
  staffRole: string,
  now: string,
): Promise<{ completed: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET state = 'done', resolved_at = ?, actor_staff_id = ?, actor_role = ?
        WHERE id = ? AND state = 'executing'`,
    )
    .bind(now, staffId, staffRole, id)
    .run();
  return { completed: (res.meta?.changes ?? 0) > 0 };
}

/** 失敗 (正直な失敗 §4): executing → failed。理由必須。 */
export async function failSubIntentCas(
  db: D1Database,
  id: string,
  reason: string,
  staffId: string,
  staffRole: string,
  now: string,
): Promise<{ failed: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET state = 'failed', fail_reason = ?, resolved_at = ?, actor_staff_id = ?, actor_role = ?
        WHERE id = ? AND state = 'executing'`,
    )
    .bind(reason, now, staffId, staffRole, id)
    .run();
  return { failed: (res.meta?.changes ?? 0) > 0 };
}

/**
 * claim 解放: executing → received (claimed_at / actor をクリア)。
 * ⚠️ 呼び出せるのは (a) 機械 executor の 30 分 timeout (sweep) と
 * (b) /admin/ops の明示的な人間の判断 (誤 claim の取り下げ) のみ。
 * **human executor を自動解放してはいけない** (§1-2 — 解放 → 再 claim が二重実行を生む)。
 * その強制は service 層が行う。ここは純 CAS。
 */
export async function releaseSubIntentClaimCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ released: boolean }> {
  void now;
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET state = 'received', claimed_at = NULL, actor_staff_id = NULL, actor_role = NULL, stale_alerted_at = NULL
        WHERE id = ? AND state = 'executing'`,
    )
    .bind(id)
    .run();
  return { released: (res.meta?.changes ?? 0) > 0 };
}

/**
 * undo (§1-3): received|deferred → cancelled。
 * 0 行なら**「取り消しました」と言わない** (executing/done へ進んでいる → 呼び出し側が
 * undo_of intent の受理へフォールバックする)。
 */
export async function undoSubIntentCas(
  db: D1Database,
  id: string,
  actorStaffId: string | null,
  actorRole: string | null,
  now: string,
): Promise<{ cancelled: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET state = 'cancelled', resolved_at = ?, actor_staff_id = ?, actor_role = ?
        WHERE id = ? AND state IN ('received','deferred')`,
    )
    .bind(now, actorStaffId, actorRole, id)
    .run();
  return { cancelled: (res.meta?.changes ?? 0) > 0 };
}

/** done → cancel_requested (undo_of intent 受理とペア §1-3)。 */
export async function markCancelRequestedCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ marked: boolean }> {
  void now;
  const res = await db
    .prepare(
      `UPDATE sub_intents SET state = 'cancel_requested' WHERE id = ? AND state = 'done'`,
    )
    .bind(id)
    .run();
  return { marked: (res.meta?.changes ?? 0) > 0 };
}

/**
 * undo_of の完了に伴う元 intent の解決: cancel_requested|done|received → cancelled。
 * 'received' を含めるのは release 経路 (claim → undo_of 受理 → release → undo_of 完了) で
 * 元 intent が received に戻っているケース — ここで解決しないと「取り消し完了」を伝えた意思が
 * open のまま残り、後日実行/expire される (§1-3 の undo CAS と同型なので received→cancelled は安全)。
 * (元が executing のままの場合のみ触らない — 人間が元 claim を解決する)
 */
export async function resolveUndoneOriginalCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ resolved: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents SET state = 'cancelled', resolved_at = ?
        WHERE id = ? AND state IN ('cancel_requested','done','received')`,
    )
    .bind(now, id)
    .run();
  return { resolved: (res.meta?.changes ?? 0) > 0 };
}

/** undo_of の失敗に伴う元 intent の復元: cancel_requested → done。 */
export async function restoreCancelRequestedCas(
  db: D1Database,
  id: string,
): Promise<{ restored: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents SET state = 'done' WHERE id = ? AND state = 'cancel_requested'`,
    )
    .bind(id)
    .run();
  return { restored: (res.meta?.changes ?? 0) > 0 };
}

/** expire (§1-2 terminal 規則): received → expired。op='skip'|'date' 限定は service 層が保証する。 */
export async function expireSubIntentCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ expired: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET state = 'expired', resolved_at = ?
        WHERE id = ? AND state = 'received' AND deadline_at IS NOT NULL AND deadline_at < ?`,
    )
    .bind(now, id, now)
    .run();
  return { expired: (res.meta?.changes ?? 0) > 0 };
}

/**
 * 繰越し (§1-2): pause/cancel の締切超過は同一行の target_cycle_key / deadline_at /
 * presented_scheduled_date を次サイクルへ UPDATE する (新規 INSERT しない)。
 * presented_scheduled_date も前進させるのは、次回の繰越し計算の基準を進めるため —
 * これを据え置くと繰越し計算が毎回同じ値を再算出する固定点になり、算出結果の締切が
 * 依然過去の場合に sweep へ毎 run 再ヒットする (監査 CONFIRMED の無限ループ)。
 * ⚠️ 繰越し先に別の open intent が既に存在すると partial UNIQUE で **throw** する —
 *    呼び出し側 (service) が UNIQUE 違反であることを確認したうえで supersede へ落とす。
 * state='received' の CAS 付き (executing へ進んだ行を巻き戻さない)。
 */
export async function carryOverSubIntentCas(
  db: D1Database,
  id: string,
  newCycleKey: string,
  newDeadlineAt: string | null,
  newScheduledDate: string | null,
  now: string,
): Promise<{ carried: boolean }> {
  void now;
  const res = await db
    .prepare(
      `UPDATE sub_intents
          SET target_cycle_key = ?, deadline_at = ?, presented_scheduled_date = ?, carryover_count = carryover_count + 1
        WHERE id = ? AND state = 'received'`,
    )
    .bind(newCycleKey, newDeadlineAt, newScheduledDate, id)
    .run();
  return { carried: (res.meta?.changes ?? 0) > 0 };
}

/** 繰越し衝突時 (§1-2): received → superseded (繰越し先の新しい意思が優先)。 */
export async function supersedeSubIntentCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ superseded: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents SET state = 'superseded', resolved_at = ?
        WHERE id = ? AND state = 'received'`,
    )
    .bind(now, id)
    .run();
  return { superseded: (res.meta?.changes ?? 0) > 0 };
}

/**
 * 締切超過エスカレーション済みマーカー (1 intent 1 回 §4-2)。CAS (escalated_at IS NULL)。
 * state 述語つき — terminal 行 (並行 undo で cancelled 等) にマーカーを付けて
 * 偽アラートを出さない。
 */
export async function markEscalatedCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ marked: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents SET escalated_at = ?
        WHERE id = ? AND escalated_at IS NULL AND state IN ('received','executing')`,
    )
    .bind(now, id)
    .run();
  return { marked: (res.meta?.changes ?? 0) > 0 };
}

/**
 * claim 滞留アラート済みマーカー (§1-2 — claim 世代ごと 1 回)。CAS (stale_alerted_at IS NULL)。
 * escalated_at (締切超過用) と分離する — 1 列共有だと片方の消費でもう片方が永久沈黙する
 * (例: claim 滞留アラート → release → 締切超過、の順で 2 つ目の通知が消える)。
 * claim/release が stale_alerted_at を NULL に戻すので、新しい claim には新しいアラート枠が立つ。
 */
export async function markStaleAlertedCas(
  db: D1Database,
  id: string,
  now: string,
): Promise<{ marked: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_intents SET stale_alerted_at = ?
        WHERE id = ? AND stale_alerted_at IS NULL AND state = 'executing'`,
    )
    .bind(now, id)
    .run();
  return { marked: (res.meta?.changes ?? 0) > 0 };
}

/**
 * 締切超過 sweep の対象 (§4-2): received かつ deadline_at < now。
 * executor='blocked' を除外しないと移行窓中の解約意思が expired で消える (§4-2)。
 * deferred は sweep 対象外 (open だが実行待ちではない §1-2)。
 */
export async function listSubIntentsPastDeadline(
  db: D1Database,
  now: string,
  limit = 50,
): Promise<SubIntentRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM sub_intents
        WHERE state = 'received' AND executor <> 'blocked'
          AND deadline_at IS NOT NULL AND deadline_at < ?
        ORDER BY deadline_at ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<SubIntentRow>();
  return res.results ?? [];
}

/**
 * claim timeout sweep の対象: executing かつ claimed_at < threshold。
 * 機械 executor (own_billing|api) のみ自動解放してよい。human は**一覧に出すだけ**
 * (自動解放は二重実行を生む §1-2)。切り分けは service 層。
 */
export async function listStaleClaims(
  db: D1Database,
  claimedBefore: string,
  limit = 50,
): Promise<SubIntentRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM sub_intents
        WHERE state = 'executing' AND claimed_at IS NOT NULL AND claimed_at < ?
        ORDER BY claimed_at ASC
        LIMIT ?`,
    )
    .bind(claimedBefore, limit)
    .all<SubIntentRow>();
  return res.results ?? [];
}

/** /admin/ops 一覧: open (received|executing|deferred) + 直近の terminal。 */
export async function listSubIntentsForOps(
  db: D1Database,
  limit = 100,
): Promise<SubIntentRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM sub_intents
        ORDER BY
          CASE state
            WHEN 'executing' THEN 0
            WHEN 'received' THEN 1
            WHEN 'cancel_requested' THEN 2
            WHEN 'deferred' THEN 3
            ELSE 4
          END,
          CASE WHEN state = 'executing' THEN claimed_at ELSE NULL END ASC,
          CASE WHEN state = 'received' THEN COALESCE(deadline_at, '9999') ELSE NULL END ASC,
          created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<SubIntentRow>();
  return res.results ?? [];
}

export interface SubIntentStats {
  received: number;
  executing: number;
  deferred: number;
  cancelRequested: number;
  doneLast7d: number;
  failedLast7d: number;
  expiredLast7d: number;
}

/** 集計 (件数のみ・PII なし)。/admin/ops のヘッダと /admin の todo が読む。 */
export async function getSubIntentStats(
  db: D1Database,
  sevenDaysAgo: string,
): Promise<SubIntentStats> {
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'received' THEN 1 ELSE 0 END) AS received,
         SUM(CASE WHEN state = 'executing' THEN 1 ELSE 0 END) AS executing,
         SUM(CASE WHEN state = 'deferred' THEN 1 ELSE 0 END) AS deferred,
         SUM(CASE WHEN state = 'cancel_requested' THEN 1 ELSE 0 END) AS cancel_requested,
         SUM(CASE WHEN state = 'done' AND resolved_at >= ? THEN 1 ELSE 0 END) AS done_7d,
         SUM(CASE WHEN state = 'failed' AND resolved_at >= ? THEN 1 ELSE 0 END) AS failed_7d,
         SUM(CASE WHEN state = 'expired' AND resolved_at >= ? THEN 1 ELSE 0 END) AS expired_7d
       FROM sub_intents`,
    )
    .bind(sevenDaysAgo, sevenDaysAgo, sevenDaysAgo)
    .first<{
      received: number | null;
      executing: number | null;
      deferred: number | null;
      cancel_requested: number | null;
      done_7d: number | null;
      failed_7d: number | null;
      expired_7d: number | null;
    }>();
  return {
    received: row?.received ?? 0,
    executing: row?.executing ?? 0,
    deferred: row?.deferred ?? 0,
    cancelRequested: row?.cancel_requested ?? 0,
    doneLast7d: row?.done_7d ?? 0,
    failedLast7d: row?.failed_7d ?? 0,
    expiredLast7d: row?.expired_7d ?? 0,
  };
}
