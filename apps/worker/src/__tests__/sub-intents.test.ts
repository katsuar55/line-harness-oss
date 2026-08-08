/**
 * sub_intents 受理レイヤーのテスト (§10-3、 2026-08-06)
 *
 * 検証対象 (= 顧客の意思を預かる台帳 — 誤遷移は「勝手に解約」「勝手に失効」になる):
 *   - 受理 (§1-1): partial UNIQUE の効き (二重タップ冪等) / cycle_drift 拒否 / 推定 NULL 時の
 *     一意性迂回の封鎖 / deferred (移行窓)
 *   - state 機械 (§1-2): 全 CAS の勝敗 / claim の締切述語 (expire と相互排他) /
 *     pause・cancel は expire させず同一行繰越し / human claim は自動解放しない
 *   - undo (§1-3): received|deferred は直接 CAS、executing|done|cancel_requested は
 *     元 intent ごとの undo_of intent / undo_of の取り下げで元を復元
 *   - sweep (§4-2): 正直な失敗通知 / エスカレーションと claim 滞留アラートの分離 /
 *     繰越しの無限再ヒットなし / 非 UNIQUE 例外で supersede しない / gate OFF は DB 非アクセス
 *   - /admin/ops API: requireRole / env-owner 拒否 / gate OFF 400 / 監査記録 / 可視化 (順序・年齢)
 *
 * 測定器の設計 (監査 test-integrity HIGH の反映):
 *   fake D1 は sub_intents への SQL を **正規化した全文一致 (WHERE 込み)** で照合する。
 *   DB 層の WHERE 述語を触る変異は「fake が知らない SQL」になり unhandled throw で必ず落ちる
 *   (prefix 一致だと述語削除変異が fake 内の旧述語で吸収され、全テスト素通りだった)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: vi.fn(async () => ({ results: [{ channel: 'line', ok: true }] })),
}));

import { dispatch } from '../services/channel-dispatcher.js';
import {
  acceptSubIntent,
  undoSubIntent,
  claimSubIntent,
  completeSubIntent,
  failSubIntent,
  releaseSubIntent,
  sweepSubIntents,
  buildCycleKey,
  buildUndoCycleKey,
  computeDeadlineAt,
  isSubIntentEnabled,
  evaluateExecution,
  requestedDateFromPayload,
  buildAcceptanceMessage,
  buildLatePromiseDisclosure,
  buildPromiseBrokenMessage,
  formatPromisedBy,
  SUB_INTENT_OP_LABELS,
  MACHINE_CLAIM_RELEASE_MINUTES,
  CANCEL_PREDEADLINE_ESCALATION_HOURS,
  VERIFIABLE_OPS,
  type VerifyBaseline,
  type EvaluateExecutionInput,
} from '../services/sub-intents.js';
import {
  computePromisedBy,
  isBusinessDayJst,
  SATURDAY_IS_BUSINESS_DAY,
  HOLIDAY_TABLE_VALID_THROUGH,
} from '../services/business-calendar.js';
import { handleSubIntentPostback } from '../services/sub-intent-postback.js';
import {
  subIntentPostbackData,
  buildBillingReminderMessages,
  SUB_INTENT_POSTBACK_VERSION,
} from '../services/subscription-concierge.js';
import { adminOps } from '../routes/admin-ops.js';
import { authMiddleware } from '../middleware/auth.js';
import { toJstString, SUB_INTENT_OPEN_STATES } from '@line-crm/db';
import type { SubIntentRow } from '@line-crm/db';

// ============================================================
// in-memory D1 fake — sub_intents は SQL 全文一致 (WHERE 込み) で照合
// ============================================================

interface ContractSeed {
  contract_id: string;
  shopify_customer_id: string | null;
  next_billing_estimate: string | null;
  estimate_source: string;
  interval_days: number | null;
  /** §4-3 検証で読む列 (既存テストは省略可 — 実 read-model では常に存在する) */
  order_count?: number | null;
  skip_count?: number;
  cancelled_at?: string | null;
  paused_at?: string | null;
}

interface FriendSeed {
  id: string;
  line_user_id: string | null;
  shopify_customer_id: string | null;
}

/** §4-3 の注文照合用 (shopify_orders の最小射影) */
interface OrderSeed {
  shopify_order_id: string;
  tags: string | null;
  created_at: string;
}

interface Store {
  intents: Map<string, SubIntentRow>;
  contracts: Map<string, ContractSeed>;
  friends: Map<string, FriendSeed>;
  orders: OrderSeed[];
  auditLogs: Array<{ action: string; targetId: string | null; metadata: string; errorMessage: string | null }>;
  cronLogs: Array<{ jobName: string; status: string; metrics: Record<string, unknown> }>;
  queryCount: number;
  /** expire CAS 敗者の再現: listPastDeadline の直後に呼ばれる (行を並行遷移させる) */
  hookAfterListPastDeadline?: (rows: SubIntentRow[]) => void;
  /** carry-over の非 UNIQUE 例外注入 (D1 transient エラーの再現) */
  throwOnCarryOver?: Error;
  /** migration 076 未適用の再現: 一覧/stats が no such table を投げる */
  throwNoSuchTable?: boolean;
  /** 通知経路の friend 引きで D1 transient を注入 (マーカー消費後の throw 経路の検証) */
  throwOnFriendLookup?: Error;
  /**
   * 受理 race の再現: open 検査後・INSERT 直前に 1 回だけ呼ばれる (並行受理の勝者を差し込む)。
   * duplicate 先行返し導入後、INSERT 衝突フォールバックはこの race でしか到達しない
   */
  hookBeforeInsert?: () => void;
}

// open の定義は migration 076 が単一情報源 — fake は定数経由で共有 (独立コピーにしない)
const OPEN = new Set<string>(SUB_INTENT_OPEN_STATES);

function hasOpenConflict(store: Store, ns: string, key: string, cycle: string, op: string, exceptId?: string): boolean {
  for (const row of store.intents.values()) {
    if (row.id === exceptId) continue;
    if (
      row.contract_ns === ns &&
      row.contract_key === key &&
      row.target_cycle_key === cycle &&
      row.op === op &&
      OPEN.has(row.state)
    ) {
      return true;
    }
  }
  return false;
}

function norm(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

// packages/db/src/sub-intents.ts の SQL の正規化全文 (transcribe 誤りは unhandled throw で発覚する)
const SQL = {
  insert: norm(`INSERT INTO sub_intents
    (id, friend_id, contract_ns, contract_key, target_cycle_key, presented_scheduled_date,
     op, state, requested_by, actor_staff_id, actor_role, payload_json,
     deadline_at, promised_by, claimed_at, executor, supersedes_intent_id,
     fail_reason, carryover_count, escalated_at, stale_alerted_at,
     promise_alerted_at, predeadline_escalated_at, verify_state, verify_baseline_json, verified_at,
     created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL)
    ON CONFLICT DO NOTHING`),
  getById: `SELECT * FROM sub_intents WHERE id = ?`,
  getOpen: norm(`SELECT * FROM sub_intents
    WHERE contract_ns = ? AND contract_key = ? AND target_cycle_key = ? AND op = ?
      AND state IN ('received','executing','deferred')`),
  claimDeadline: norm(`UPDATE sub_intents
    SET state = 'executing', claimed_at = ?, actor_staff_id = ?, actor_role = ?, stale_alerted_at = NULL
    WHERE id = ? AND state = 'received' AND (deadline_at IS NULL OR deadline_at > ?)`),
  claimPlain: norm(`UPDATE sub_intents
    SET state = 'executing', claimed_at = ?, actor_staff_id = ?, actor_role = ?, stale_alerted_at = NULL
    WHERE id = ? AND state = 'received'`),
  complete: norm(`UPDATE sub_intents
    SET state = 'done', resolved_at = ?, actor_staff_id = ?, actor_role = ?
    WHERE id = ? AND state = 'executing'`),
  fail: norm(`UPDATE sub_intents
    SET state = 'failed', fail_reason = ?, resolved_at = ?, actor_staff_id = ?, actor_role = ?
    WHERE id = ? AND state = 'executing'`),
  release: norm(`UPDATE sub_intents
    SET state = 'received', claimed_at = NULL, actor_staff_id = NULL, actor_role = NULL, stale_alerted_at = NULL
    WHERE id = ? AND state = 'executing'`),
  undo: norm(`UPDATE sub_intents
    SET state = 'cancelled', resolved_at = ?, actor_staff_id = ?, actor_role = ?
    WHERE id = ? AND state IN ('received','deferred')`),
  markCancelRequested: norm(`UPDATE sub_intents SET state = 'cancel_requested' WHERE id = ? AND state = 'done'`),
  resolveUndoneOriginal: norm(`UPDATE sub_intents SET state = 'cancelled', resolved_at = ?
    WHERE id = ? AND state IN ('cancel_requested','done','received')`),
  restoreCancelRequested: norm(`UPDATE sub_intents SET state = 'done' WHERE id = ? AND state = 'cancel_requested'`),
  expire: norm(`UPDATE sub_intents
    SET state = 'expired', resolved_at = ?
    WHERE id = ? AND state = 'received' AND deadline_at IS NOT NULL AND deadline_at < ?`),
  carryOver: norm(`UPDATE sub_intents
    SET target_cycle_key = ?, deadline_at = ?, presented_scheduled_date = ?, carryover_count = carryover_count + 1, predeadline_escalated_at = NULL
    WHERE id = ? AND state = 'received'`),
  supersede: norm(`UPDATE sub_intents SET state = 'superseded', resolved_at = ?
    WHERE id = ? AND state = 'received'`),
  markEscalated: norm(`UPDATE sub_intents SET escalated_at = ?
    WHERE id = ? AND escalated_at IS NULL AND state IN ('received','executing')`),
  markStaleAlerted: norm(`UPDATE sub_intents SET stale_alerted_at = ?
    WHERE id = ? AND stale_alerted_at IS NULL AND state = 'executing'`),
  markPromiseAlerted: norm(`UPDATE sub_intents SET promise_alerted_at = ?
    WHERE id = ? AND promise_alerted_at IS NULL AND state = 'received'`),
  listPastPromise: norm(`SELECT * FROM sub_intents
    WHERE state = 'received' AND executor <> 'blocked'
      AND promised_by IS NOT NULL AND promised_by < ?
      AND promise_alerted_at IS NULL
    ORDER BY promised_by ASC
    LIMIT ?`),
  markPredeadlineEscalated: norm(`UPDATE sub_intents SET predeadline_escalated_at = ?
    WHERE id = ? AND predeadline_escalated_at IS NULL AND state IN ('received','executing')`),
  listCancelNearDeadline: norm(`SELECT * FROM sub_intents
    WHERE op = 'cancel' AND state IN ('received','executing') AND executor <> 'blocked'
      AND ((deadline_at IS NOT NULL AND deadline_at <= ?)
        OR (deadline_at IS NULL AND created_at <= ?))
      AND predeadline_escalated_at IS NULL
    ORDER BY COALESCE(deadline_at, created_at) ASC
    LIMIT ?`),
  setVerifyPending: norm(`UPDATE sub_intents SET verify_state = 'pending'
    WHERE id = ? AND state = 'done' AND verify_state IS NULL`),
  listVerifyPending: norm(`SELECT * FROM sub_intents
    WHERE verify_state = 'pending' AND state = 'done'
    ORDER BY resolved_at ASC
    LIMIT ?`),
  setVerifyVerdict: norm(`UPDATE sub_intents SET verify_state = ?, verified_at = ?
    WHERE id = ? AND verify_state = 'pending'`),
  listSubscriptionOrders: norm(`SELECT shopify_order_id, tags, created_at FROM shopify_orders
    WHERE tags LIKE '%subscription-id:%' AND created_at >= ?
    ORDER BY created_at ASC
    LIMIT ?`),
  countOtherDone: norm(`SELECT COUNT(*) AS n FROM sub_intents
    WHERE contract_ns = ? AND contract_key = ? AND op = ? AND id <> ?
      AND state = 'done' AND resolved_at >= ?`),
  listPastDeadline: norm(`SELECT * FROM sub_intents
    WHERE state = 'received' AND executor <> 'blocked'
      AND deadline_at IS NOT NULL AND deadline_at < ?
    ORDER BY deadline_at ASC
    LIMIT ?`),
  listStaleClaims: norm(`SELECT * FROM sub_intents
    WHERE state = 'executing' AND claimed_at IS NOT NULL AND claimed_at < ?
    ORDER BY claimed_at ASC
    LIMIT ?`),
  listForOps: norm(`SELECT * FROM sub_intents
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
    LIMIT ?`),
  stats: norm(`SELECT
    SUM(CASE WHEN state = 'received' THEN 1 ELSE 0 END) AS received,
    SUM(CASE WHEN state = 'executing' THEN 1 ELSE 0 END) AS executing,
    SUM(CASE WHEN state = 'deferred' THEN 1 ELSE 0 END) AS deferred,
    SUM(CASE WHEN state = 'cancel_requested' THEN 1 ELSE 0 END) AS cancel_requested,
    SUM(CASE WHEN state = 'done' AND resolved_at >= ? THEN 1 ELSE 0 END) AS done_7d,
    SUM(CASE WHEN state = 'failed' AND resolved_at >= ? THEN 1 ELSE 0 END) AS failed_7d,
    SUM(CASE WHEN state = 'expired' AND resolved_at >= ? THEN 1 ELSE 0 END) AS expired_7d
    FROM sub_intents`),
};

function createDb(seed: { contracts?: ContractSeed[]; friends?: FriendSeed[]; orders?: OrderSeed[] } = {}): {
  db: D1Database;
  store: Store;
} {
  const store: Store = {
    intents: new Map(),
    // seed はコピーして持つ — 参照共有だとテスト内の契約 mutate が module 共有の
    // フィクスチャ (CONTRACT) を汚染し、後続テストへ漏れる (実 D1 の行は独立)
    contracts: new Map((seed.contracts ?? []).map((c) => [c.contract_id, { ...c }])),
    friends: new Map((seed.friends ?? []).map((f) => [f.id, { ...f }])),
    orders: (seed.orders ?? []).map((o) => ({ ...o })),
    auditLogs: [],
    cronLogs: [],
    queryCount: 0,
  };

  function exec(sqlRaw: string, args: unknown[], mode: 'first' | 'all' | 'run'): unknown {
    store.queryCount += 1;
    const sql = norm(sqlRaw);
    const a = args as (string | number | null)[];

    // ---- sub_intents (全文一致。知らない SQL = 変異/新規は throw で即発覚) ----
    if (sql === SQL.insert) {
      if (store.hookBeforeInsert) {
        const hook = store.hookBeforeInsert;
        store.hookBeforeInsert = undefined;
        hook();
      }
      const [id, friendId, ns, key, cycle, presented, op, state, requestedBy, staffId, role, payload, deadline, promisedBy, executor, supersedes, verifyBaseline, createdAt] = a as (string | null)[];
      if (OPEN.has(state as string) && hasOpenConflict(store, ns as string, key as string, cycle as string, op as string)) {
        return { meta: { changes: 0 } };
      }
      store.intents.set(id as string, {
        id: id as string,
        friend_id: friendId,
        contract_ns: ns as string,
        contract_key: key as string,
        target_cycle_key: cycle as string,
        presented_scheduled_date: presented,
        op: op as SubIntentRow['op'],
        state: state as SubIntentRow['state'],
        requested_by: requestedBy as string,
        actor_staff_id: staffId,
        actor_role: role,
        payload_json: payload,
        deadline_at: deadline,
        promised_by: promisedBy,
        claimed_at: null,
        executor: executor as SubIntentRow['executor'],
        supersedes_intent_id: supersedes,
        fail_reason: null,
        carryover_count: 0,
        escalated_at: null,
        stale_alerted_at: null,
        promise_alerted_at: null,
        predeadline_escalated_at: null,
        verify_state: null,
        verify_baseline_json: verifyBaseline,
        verified_at: null,
        created_at: createdAt as string,
        resolved_at: null,
      });
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.getById) {
      return store.intents.get(a[0] as string) ?? null;
    }

    if (sql === SQL.getOpen) {
      const [ns, key, cycle, op] = a as string[];
      for (const row of store.intents.values()) {
        if (
          row.contract_ns === ns && row.contract_key === key &&
          row.target_cycle_key === cycle && row.op === op && OPEN.has(row.state)
        ) return row;
      }
      return null;
    }

    if (sql === SQL.claimDeadline || sql === SQL.claimPlain) {
      const withDeadline = sql === SQL.claimDeadline;
      const [now, staffId, role, id, nowCmp] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      if (withDeadline && !(row.deadline_at === null || row.deadline_at > nowCmp)) {
        return { meta: { changes: 0 } };
      }
      row.state = 'executing';
      row.claimed_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      row.stale_alerted_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.complete) {
      const [now, staffId, role, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'executing') return { meta: { changes: 0 } };
      row.state = 'done';
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.fail) {
      const [reason, now, staffId, role, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'executing') return { meta: { changes: 0 } };
      row.state = 'failed';
      row.fail_reason = reason;
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.release) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'executing') return { meta: { changes: 0 } };
      row.state = 'received';
      row.claimed_at = null;
      row.actor_staff_id = null;
      row.actor_role = null;
      row.stale_alerted_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.undo) {
      const [now, staffId, role, id] = a as (string | null)[];
      const row = store.intents.get(id as string);
      if (!row || !(row.state === 'received' || row.state === 'deferred')) return { meta: { changes: 0 } };
      row.state = 'cancelled';
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.markCancelRequested) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'done') return { meta: { changes: 0 } };
      row.state = 'cancel_requested';
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.resolveUndoneOriginal) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || !(row.state === 'cancel_requested' || row.state === 'done' || row.state === 'received')) {
        return { meta: { changes: 0 } };
      }
      row.state = 'cancelled';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.restoreCancelRequested) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'cancel_requested') return { meta: { changes: 0 } };
      row.state = 'done';
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.expire) {
      const [now, id, nowCmp] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      if (!(row.deadline_at !== null && row.deadline_at < nowCmp)) return { meta: { changes: 0 } };
      row.state = 'expired';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.carryOver) {
      if (store.throwOnCarryOver) throw store.throwOnCarryOver;
      const [newCycle, newDeadline, newScheduled, id] = a as (string | null)[];
      const row = store.intents.get(id as string);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      // partial UNIQUE: 繰越し先に別の open intent がいたら throw (実 D1 と同じ)
      if (hasOpenConflict(store, row.contract_ns, row.contract_key, newCycle as string, row.op, row.id)) {
        throw new Error('UNIQUE constraint failed: sub_intents');
      }
      row.target_cycle_key = newCycle as string;
      row.deadline_at = newDeadline;
      row.presented_scheduled_date = newScheduled;
      row.carryover_count += 1;
      // §4-4: 次サイクルの締切にも 24h 前エスカレーションの枠を与える
      row.predeadline_escalated_at = null;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.supersede) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      row.state = 'superseded';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.markEscalated) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.escalated_at !== null) return { meta: { changes: 0 } };
      if (!(row.state === 'received' || row.state === 'executing')) return { meta: { changes: 0 } };
      row.escalated_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.markStaleAlerted) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.stale_alerted_at !== null || row.state !== 'executing') return { meta: { changes: 0 } };
      row.stale_alerted_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.markPromiseAlerted) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.promise_alerted_at !== null || row.state !== 'received') return { meta: { changes: 0 } };
      row.promise_alerted_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.listPastPromise) {
      const [now, limit] = a as [string, number];
      const rows = [...store.intents.values()]
        .filter(
          (r) =>
            r.state === 'received' && r.executor !== 'blocked' &&
            r.promised_by !== null && r.promised_by < now && r.promise_alerted_at === null,
        )
        .sort((x, y) => (x.promised_by! < y.promised_by! ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }

    if (sql === SQL.markPredeadlineEscalated) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.predeadline_escalated_at !== null) return { meta: { changes: 0 } };
      if (!(row.state === 'received' || row.state === 'executing')) return { meta: { changes: 0 } };
      row.predeadline_escalated_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.listCancelNearDeadline) {
      const [before, createdBefore, limit] = a as [string, string, number];
      const anchor = (r: SubIntentRow) => r.deadline_at ?? r.created_at;
      const rows = [...store.intents.values()]
        .filter(
          (r) =>
            r.op === 'cancel' && (r.state === 'received' || r.state === 'executing') &&
            r.executor !== 'blocked' &&
            ((r.deadline_at !== null && r.deadline_at <= before) ||
              (r.deadline_at === null && r.created_at <= createdBefore)) &&
            r.predeadline_escalated_at === null,
        )
        .sort((x, y) => (anchor(x) < anchor(y) ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }

    if (sql === SQL.setVerifyPending) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'done' || row.verify_state !== null) return { meta: { changes: 0 } };
      row.verify_state = 'pending';
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.listVerifyPending) {
      const [limit] = a as [number];
      const rows = [...store.intents.values()]
        .filter((r) => r.verify_state === 'pending' && r.state === 'done')
        .sort((x, y) => ((x.resolved_at ?? '') < (y.resolved_at ?? '') ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }

    if (sql === SQL.setVerifyVerdict) {
      const [verdict, now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.verify_state !== 'pending') return { meta: { changes: 0 } };
      row.verify_state = verdict as SubIntentRow['verify_state'];
      row.verified_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.listSubscriptionOrders) {
      const [since, limit] = a as [string, number];
      // LIMIT を実装する (無視すると打ち切り時の挙動 = ok 抑止ガードが観測不能になる)
      const rows = store.orders
        .filter((o) => (o.tags ?? '').includes('subscription-id:') && o.created_at >= since)
        .sort((x, y) => (x.created_at < y.created_at ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }

    if (sql === SQL.countOtherDone) {
      const [ns, key, op, excludeId, since] = a as string[];
      const n = [...store.intents.values()].filter(
        (r) =>
          r.contract_ns === ns && r.contract_key === key && r.op === op && r.id !== excludeId &&
          r.state === 'done' && (r.resolved_at ?? '') >= since,
      ).length;
      return { n };
    }

    if (sql === SQL.listPastDeadline) {
      const [now, limit] = a as [string, number];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'received' && r.executor !== 'blocked' && r.deadline_at !== null && r.deadline_at < now)
        .sort((x, y) => (x.deadline_at! < y.deadline_at! ? -1 : 1))
        .slice(0, limit);
      store.hookAfterListPastDeadline?.(rows);
      return { results: rows };
    }

    if (sql === SQL.listStaleClaims) {
      const [before, limit] = a as [string, number];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'executing' && r.claimed_at !== null && r.claimed_at < before)
        .sort((x, y) => (x.claimed_at! < y.claimed_at! ? -1 : 1))
        .slice(0, limit);
      return { results: rows };
    }

    if (sql === SQL.listForOps) {
      if (store.throwNoSuchTable) throw new Error('D1_ERROR: no such table: sub_intents');
      // 実 SQL と同じ 3 キー: state 順 → executing は claimed_at 昇順 → received は締切昇順 → 新しい順
      const order: Record<string, number> = { executing: 0, received: 1, cancel_requested: 2, deferred: 3 };
      const nullFirst = (x: string | null, y: string | null): number => {
        if (x === y) return 0;
        if (x === null) return -1;
        if (y === null) return 1;
        return x < y ? -1 : 1;
      };
      const rows = [...store.intents.values()].sort((x, y) => {
        const ox = order[x.state] ?? 4;
        const oy = order[y.state] ?? 4;
        if (ox !== oy) return ox - oy;
        const k2 = nullFirst(
          x.state === 'executing' ? x.claimed_at : null,
          y.state === 'executing' ? y.claimed_at : null,
        );
        if (k2 !== 0) return k2;
        const k3 = nullFirst(
          x.state === 'received' ? (x.deadline_at ?? '9999') : null,
          y.state === 'received' ? (y.deadline_at ?? '9999') : null,
        );
        if (k3 !== 0) return k3;
        return x.created_at < y.created_at ? 1 : -1;
      });
      return { results: rows };
    }

    if (sql === SQL.stats) {
      if (store.throwNoSuchTable) throw new Error('D1_ERROR: no such table: sub_intents');
      const [since] = a as string[];
      const all = [...store.intents.values()];
      const count = (f: (r: SubIntentRow) => boolean) => all.filter(f).length;
      return {
        received: count((r) => r.state === 'received'),
        executing: count((r) => r.state === 'executing'),
        deferred: count((r) => r.state === 'deferred'),
        cancel_requested: count((r) => r.state === 'cancel_requested'),
        done_7d: count((r) => r.state === 'done' && (r.resolved_at ?? '') >= since),
        failed_7d: count((r) => r.state === 'failed' && (r.resolved_at ?? '') >= since),
        expired_7d: count((r) => r.state === 'expired' && (r.resolved_at ?? '') >= since),
      };
    }

    // ---- 参照テーブル (忠実性の対象外 — prefix 一致で十分) ----
    if (sql.startsWith('SELECT * FROM subscription_contracts WHERE contract_id = ?')) {
      return store.contracts.get(a[0] as string) ?? null;
    }
    if (sql.startsWith('SELECT * FROM subscription_contracts WHERE shopify_customer_id = ?')) {
      const rows = [...store.contracts.values()].filter((c) => c.shopify_customer_id === a[0]);
      return { results: rows };
    }
    if (sql.startsWith('SELECT * FROM friends WHERE shopify_customer_id = ?')) {
      for (const f of store.friends.values()) {
        if (f.shopify_customer_id === a[0]) return f;
      }
      return null;
    }
    if (sql.startsWith('SELECT * FROM friends WHERE line_user_id = ?')) {
      for (const f of store.friends.values()) {
        if (f.line_user_id === a[0]) return f;
      }
      return null;
    }
    if (sql.startsWith('SELECT id, line_user_id FROM friends WHERE id = ?')) {
      if (store.throwOnFriendLookup) throw store.throwOnFriendLookup;
      return store.friends.get(a[0] as string) ?? null;
    }

    // ---- ログ類 ----
    if (sql.startsWith('INSERT INTO audit_logs')) {
      store.auditLogs.push({
        action: a[5] as string,
        targetId: (a[7] as string | null) ?? null,
        metadata: a[15] as string,
        errorMessage: (a[14] as string | null) ?? null,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('SELECT * FROM audit_logs WHERE id = ?')) {
      // insertAuditLog が INSERT 後に読み戻す分 (返り値は本テストでは未使用)
      return { id: a[0], action: 'stub' };
    }
    if (sql.startsWith('INSERT INTO cron_run_logs')) {
      store.cronLogs.push({
        jobName: a[1] as string,
        status: a[3] as string,
        metrics: JSON.parse((a[4] as string) ?? '{}'),
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`fake D1: unhandled SQL (${mode}): ${sql.slice(0, 160)}`);
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => exec(sql, args, 'run'),
            first: async () => exec(sql, args, 'first'),
            all: async () => exec(sql, args, 'all'),
          };
        },
        run: async () => exec(sql, [], 'run'),
        first: async () => exec(sql, [], 'first'),
        all: async () => exec(sql, [], 'all'),
      };
    },
  } as unknown as D1Database;

  return { db, store };
}

// ============================================================
// フィクスチャ (実時計に依存しない固定日付 + nowMs 注入)
// ============================================================

/** 2026-09-01T00:00:00Z = JST 09-01T09:00 */
const NOW_MS = Date.parse('2026-09-01T00:00:00Z');
/** 推定 09-10 → 締切 09-07T23:59:59.999+09:00 (NOW より未来) */
const CONTRACT: ContractSeed = {
  contract_id: 'C1',
  shopify_customer_id: 'CUST1',
  next_billing_estimate: '2026-09-10',
  estimate_source: 'flow',
  interval_days: 30,
  order_count: 3,
  skip_count: 0,
  cancelled_at: null,
  paused_at: null,
};
const FRIEND: FriendSeed = { id: 'F1', line_user_id: 'U1', shopify_customer_id: 'CUST1' };
/** 締切 (09-07 EOD) を過ぎた時刻 = 09-08T09:00 JST */
const AFTER_DEADLINE_MS = Date.parse('2026-09-08T00:00:00Z');

const GATE_ON = { SUB_INTENT_ENABLED: 'true' };

function fakeLineClient(): never {
  return { pushMessage: vi.fn() } as never;
}

beforeEach(() => {
  vi.mocked(dispatch).mockClear();
  vi.mocked(dispatch).mockResolvedValue({ results: [{ channel: 'line', ok: true }] } as never);
});

// ============================================================
// open 定義の単一情報源 (migration 076 ↔ 定数 ↔ fake)
// ============================================================

describe('open 状態の定義は migration 076 が単一情報源', () => {
  it('ux_sub_intents_open の WHERE state IN と SUB_INTENT_OPEN_STATES が一致する', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(
      resolve(here, '../../../../packages/db/migrations/076_sub_intents.sql'),
      'utf8',
    );
    const m = migration.match(/ux_sub_intents_open[\s\S]*?WHERE state IN \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const states = m![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(states.sort()).toEqual([...SUB_INTENT_OPEN_STATES].sort());
  });
});

// ============================================================
// 受理 (§1-1)
// ============================================================

describe('acceptSubIntent (§1-1 受理)', () => {
  it('受理成功: cycle key = 契約+推定日、締切 = 決済3日前 EOD', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'staff', nowMs: NOW_MS,
    });
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.intent.state).toBe('received');
    expect(res.intent.target_cycle_key).toBe('C1:2026-09-10');
    expect(res.intent.deadline_at).toBe('2026-09-07T23:59:59.999+09:00');
    expect(res.intent.friend_id).toBe('F1');
    expect(res.intent.executor).toBe('human');
  });

  it('二重受理は冪等 (partial UNIQUE): 2 回目は duplicate + 既存 intent + 行は 1 つ', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const first = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS });
    const second = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS + 1000 });
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    if (first.status !== 'accepted' || second.status !== 'duplicate') return;
    expect(second.intent.id).toBe(first.intent.id);
    expect(store.intents.size).toBe(1);
  });

  it('別 op は同一サイクルでも独立に受理できる', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS });
    const res = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'date', requestedBy: 'customer', nowMs: NOW_MS });
    expect(res.status).toBe('accepted');
    expect(store.intents.size).toBe(2);
  });

  it('terminal (cancelled) 後は同一サイクル×同一 op を再受理できる (partial の意味)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const first = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS });
    if (first.status !== 'accepted') throw new Error('setup');
    const undo = await undoSubIntent(db, first.intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(undo.status).toBe('cancelled');
    const again = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS });
    expect(again.status).toBe('accepted');
  });

  it('提示日が現在の推定とズレたら cycle_drift で拒否 (§3-3 古い吹き出し)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      presentedDate: '2026-08-10', nowMs: NOW_MS,
    });
    expect(res.status).toBe('cycle_drift');
    if (res.status !== 'cycle_drift') return;
    expect(res.currentEstimate).toBe('2026-09-10');
    expect(store.intents.size).toBe(0);
  });

  it('presentedDate の形式不正は invalid_date で拒否 (cycle key に混ぜない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'staff',
      presentedDate: 'garbage!!x', nowMs: NOW_MS,
    });
    expect(res.status).toBe('invalid_date');
    expect(store.intents.size).toBe(0);
  });

  it('推定 NULL の契約では presentedDate が違っても同じ unknown サイクルに畳まれる (一意性迂回の封鎖)', async () => {
    const noEstimate: ContractSeed = { ...CONTRACT, contract_id: 'C2', next_billing_estimate: null };
    const { db, store } = createDb({ contracts: [noEstimate], friends: [FRIEND] });
    const a = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C2', op: 'skip', requestedBy: 'staff', presentedDate: '2026-09-10', nowMs: NOW_MS });
    const b = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C2', op: 'skip', requestedBy: 'staff', presentedDate: '2026-09-11', nowMs: NOW_MS });
    expect(a.status).toBe('accepted');
    expect(b.status).toBe('duplicate');
    expect(store.intents.size).toBe(1);
    if (a.status !== 'accepted') return;
    expect(a.intent.target_cycle_key).toBe('C2:unknown');
  });

  it('契約不在 / 不正 op は受理しない', async () => {
    const { db } = createDb({ contracts: [CONTRACT] });
    expect((await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'NOPE', op: 'skip', requestedBy: 'staff', nowMs: NOW_MS })).status).toBe('contract_not_found');
    expect((await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'undo_of', requestedBy: 'staff', nowMs: NOW_MS })).status).toBe('invalid_op');
  });

  it('executor=blocked (移行窓) は deferred で受理する (§5-1)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.intent.state).toBe('deferred');
  });

  it('resume は締切なし / 推定不明は cycle=unknown + 締切なし', async () => {
    const noEstimate: ContractSeed = { ...CONTRACT, contract_id: 'C2', next_billing_estimate: null };
    const { db } = createDb({ contracts: [CONTRACT, noEstimate], friends: [FRIEND] });
    const resume = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'resume', requestedBy: 'staff', nowMs: NOW_MS });
    expect(resume.status).toBe('accepted');
    if (resume.status === 'accepted') expect(resume.intent.deadline_at).toBeNull();
    const unknown = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C2', op: 'skip', requestedBy: 'staff', nowMs: NOW_MS });
    expect(unknown.status).toBe('accepted');
    if (unknown.status === 'accepted') {
      expect(unknown.intent.target_cycle_key).toBe('C2:unknown');
      expect(unknown.intent.deadline_at).toBeNull();
    }
  });
});

// ============================================================
// claim / done / fail / release (§4-0 / §1-2)
// ============================================================

async function seedIntent(
  db: D1Database,
  over: Partial<{ op: 'skip' | 'date' | 'pause' | 'resume' | 'cancel'; contractKey: string }> = {},
) {
  const res = await acceptSubIntent(db, {
    contractNs: 'hb',
    contractKey: over.contractKey ?? 'C1',
    op: over.op ?? 'skip',
    requestedBy: 'customer',
    nowMs: NOW_MS,
  });
  if (res.status !== 'accepted') throw new Error(`seed failed: ${res.status}`);
  return res.intent;
}

const STAFF = { staffId: 'staff-1', role: 'admin' };

describe('claim (§4-0 着手)', () => {
  it('received → executing。担当と claim 時刻を記録', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    const res = await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    expect(res.status).toBe('claimed');
    if (res.status !== 'claimed') return;
    expect(res.intent.state).toBe('executing');
    expect(res.intent.actor_staff_id).toBe('staff-1');
    expect(res.intent.claimed_at).not.toBeNull();
  });

  it('二重 claim は敗者が conflict (着手と言わない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const loser = await claimSubIntent(db, intent.id, { staffId: 'staff-2', role: 'admin' }, NOW_MS + 1000);
    expect(loser.status).toBe('conflict');
  });

  it('skip の締切超過は claim できない (expire sweep と相互排他)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    const res = await claimSubIntent(db, intent.id, STAFF, AFTER_DEADLINE_MS);
    expect(res.status).toBe('conflict');
  });

  it('pause は締切超過でも claim できる (§4-0 — 救済すべき解約を実行不能にしない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'pause' });
    const res = await claimSubIntent(db, intent.id, STAFF, AFTER_DEADLINE_MS);
    expect(res.status).toBe('claimed');
  });

  it('締切不明 (deadline NULL) の skip は claim できる (不明で意思を殺さない)', async () => {
    const noEstimate: ContractSeed = { ...CONTRACT, contract_id: 'C2', next_billing_estimate: null };
    const { db } = createDb({ contracts: [noEstimate], friends: [FRIEND] });
    const intent = await seedIntent(db, { contractKey: 'C2' });
    const res = await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    expect(res.status).toBe('claimed');
  });
});

describe('done / fail / release (§1-2)', () => {
  it('executing → done。received からの done は conflict (完了と言わない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    const early = await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    expect(early.status).toBe('conflict');
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const done = await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    expect(done.status).toBe('done');
  });

  it('fail は理由を記録して failed', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await failSubIntent(db, intent.id, 'HB 側でエラー', STAFF, NOW_MS);
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.intent.fail_reason).toBe('HB 側でエラー');
  });

  it('release: executing → received (claim 情報をクリア)。再 claim できる', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const rel = await releaseSubIntent(db, intent.id, NOW_MS);
    expect(rel.status).toBe('released');
    if (rel.status !== 'released') return;
    expect(rel.intent.state).toBe('received');
    expect(rel.intent.claimed_at).toBeNull();
    const reclaim = await claimSubIntent(db, intent.id, { staffId: 'staff-2', role: 'admin' }, NOW_MS);
    expect(reclaim.status).toBe('claimed');
  });

  it('release → 再 claim でも skip の締切述語は再適用される', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await releaseSubIntent(db, intent.id, NOW_MS);
    // 締切超過後の再 claim は拒否される (release が締切ガードを剥がさない)
    const reclaim = await claimSubIntent(db, intent.id, { staffId: 'staff-2', role: 'admin' }, AFTER_DEADLINE_MS);
    expect(reclaim.status).toBe('conflict');
  });
});

// ============================================================
// undo (§1-3) — 元 intent ごとの undo_of + 復元
// ============================================================

describe('undoSubIntent (§1-3)', () => {
  it('received は直接 cancelled (CAS 勝者のみ)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('cancelled');
  });

  it('deferred (移行窓) も直接 cancelled — 移行窓の意思を取り消せる', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    expect(res0.intent.state).toBe('deferred');
    const res = await undoSubIntent(db, res0.intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('cancelled');
    expect(store.intents.get(res0.intent.id)?.state).toBe('cancelled');
  });

  it('executing は undo_of intent の受理に化ける (「承りました」止まり)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('undo_accepted');
    if (res.status !== 'undo_accepted') return;
    expect(res.undoIntent.op).toBe('undo_of');
    expect(res.undoIntent.supersedes_intent_id).toBe(intent.id);
    expect(res.undoIntent.target_cycle_key).toBe(buildUndoCycleKey(intent.target_cycle_key, intent.id));
    // 元 intent は executing のまま (claim 意味論を壊さない)
    expect(store.intents.get(intent.id)?.state).toBe('executing');
  });

  it('executing への二重 undo は冪等 (undo_of は 1 行だけ)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const a = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    const b = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS + 1000 });
    expect(a.status).toBe('undo_accepted');
    expect(b.status).toBe('undo_accepted');
    if (a.status !== 'undo_accepted' || b.status !== 'undo_accepted') return;
    expect(b.undoIntent.id).toBe(a.undoIntent.id);
    const undoRows = [...store.intents.values()].filter((r) => r.op === 'undo_of');
    expect(undoRows.length).toBe(1);
  });

  it('同一サイクルの別 intent への undo は別々の undo_of になる (吸収・握り潰しの禁止)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const skip = await seedIntent(db, { op: 'skip' });
    const date = await seedIntent(db, { op: 'date' });
    for (const it2 of [skip, date]) {
      await claimSubIntent(db, it2.id, STAFF, NOW_MS);
      await completeSubIntent(db, it2.id, STAFF, NOW_MS);
    }
    const undoSkip = await undoSubIntent(db, skip.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    const undoDate = await undoSubIntent(db, date.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(undoSkip.status).toBe('undo_accepted');
    expect(undoDate.status).toBe('undo_accepted');
    if (undoSkip.status !== 'undo_accepted' || undoDate.status !== 'undo_accepted') return;
    expect(undoSkip.undoIntent.id).not.toBe(undoDate.undoIntent.id);
    expect(undoSkip.undoIntent.supersedes_intent_id).toBe(skip.id);
    expect(undoDate.undoIntent.supersedes_intent_id).toBe(date.id);
    // 各 undo_of の完了は**自分の**元 intent だけを解決する
    await claimSubIntent(db, undoSkip.undoIntent.id, STAFF, NOW_MS);
    const doneA = await completeSubIntent(db, undoSkip.undoIntent.id, STAFF, NOW_MS);
    expect(doneA.status).toBe('done');
    expect(store.intents.get(skip.id)?.state).toBe('cancelled');
    expect(store.intents.get(date.id)?.state).toBe('cancel_requested'); // date は未解決のまま
    await claimSubIntent(db, undoDate.undoIntent.id, STAFF, NOW_MS);
    await completeSubIntent(db, undoDate.undoIntent.id, STAFF, NOW_MS);
    expect(store.intents.get(date.id)?.state).toBe('cancelled');
  });

  it('done は cancel_requested に立ち、undo_of の完了で cancelled / 失敗で done に戻る', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('undo_accepted');
    if (res.status !== 'undo_accepted') return;
    expect(store.intents.get(intent.id)?.state).toBe('cancel_requested');
    await claimSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    const done = await completeSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    expect(done.status).toBe('done');
    if (done.status !== 'done') return;
    expect(done.originalResolved).toBe(true);
    expect(store.intents.get(intent.id)?.state).toBe('cancelled');
  });

  it('undo_of の失敗は元 intent を done に復元する', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    if (res.status !== 'undo_accepted') throw new Error('setup');
    await claimSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    const failed = await failSubIntent(db, res.undoIntent.id, '既に発送済み', STAFF, NOW_MS);
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.originalRestored).toBe(true);
    expect(store.intents.get(intent.id)?.state).toBe('done');
  });

  it('undo_of 自体への undo = 依頼の取り下げ。元 intent は done に復元される (固着させない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    if (res.status !== 'undo_accepted') throw new Error('setup');
    expect(store.intents.get(intent.id)?.state).toBe('cancel_requested');
    // スタッフが undo_of 行を取り消す (顧客の翻意)
    const withdraw = await undoSubIntent(db, res.undoIntent.id, { staffId: 'staff-1', role: 'admin' }, { requestedBy: 'staff', nowMs: NOW_MS });
    expect(withdraw.status).toBe('cancelled');
    expect(store.intents.get(res.undoIntent.id)?.state).toBe('cancelled');
    expect(store.intents.get(intent.id)?.state).toBe('done'); // 復元された
  });

  it('cancel_requested に取り残された元 intent への undo は undo_of を作り直す (残留からの復旧)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    // 障害の残留を再現: cancel_requested だが対応する undo_of が存在しない
    store.intents.get(intent.id)!.state = 'cancel_requested';
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('undo_accepted');
    if (res.status !== 'undo_accepted') return;
    expect(res.undoIntent.supersedes_intent_id).toBe(intent.id);
    expect([...store.intents.values()].filter((r) => r.op === 'undo_of').length).toBe(1);
  });

  it('release で received に戻った元 intent も undo_of 完了で解決される (open 残留させない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    if (res.status !== 'undo_accepted') throw new Error('setup');
    // スタッフ A が HB 未操作に気づき release → 元 intent は received に戻る
    await releaseSubIntent(db, intent.id, NOW_MS);
    expect(store.intents.get(intent.id)?.state).toBe('received');
    // スタッフ B が undo_of を完了 → 元 intent (received) も cancelled に解決される
    await claimSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    const done = await completeSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    expect(done.status).toBe('done');
    if (done.status !== 'done') return;
    expect(done.originalResolved).toBe(true);
    expect(store.intents.get(intent.id)?.state).toBe('cancelled');
  });

  it('expired からは取り消せない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    store.intents.get(intent.id)!.state = 'expired';
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(res.status).toBe('not_undoable');
  });
});

// ============================================================
// sweep (§4-2 / §1-2)
// ============================================================

describe('sweepSubIntents (§4-2 sweep)', () => {
  it('gate OFF (既定) は DB に一切アクセスしない (= migration 076 未適用でも安全)', async () => {
    const { db, store } = createDb();
    const res = await sweepSubIntents({ DB: db }, {}, NOW_MS);
    expect(res.skippedGating).toBe(true);
    expect(store.queryCount).toBe(0);
  });

  it('skip の締切超過 → expired + 正直な失敗通知 (連携済み) + cron log + 監査', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    const res = await sweepSubIntents(
      { DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, AFTER_DEADLINE_MS,
    );
    expect(res.expired).toBe(1);
    expect(res.expiredNotified).toBe(1);
    expect(store.intents.get(intent.id)?.state).toBe('expired');
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatch).mock.calls[0][1];
    expect(call.category).toBe('transactional');
    expect(JSON.stringify(call.linePayload?.messages)).toContain('完了できませんでした');
    expect(store.cronLogs.length).toBe(1);
    expect(store.cronLogs[0].jobName).toBe('sub-intents-sweep');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.expired')).toBe(true);
  });

  it('未連携の expire は通知不能として可視化 (expiredUnnotified)', async () => {
    const contract: ContractSeed = { ...CONTRACT, shopify_customer_id: null };
    const { db } = createDb({ contracts: [contract] });
    await seedIntent(db);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, AFTER_DEADLINE_MS);
    expect(res.expired).toBe(1);
    expect(res.expiredUnnotified).toBe(1);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('通知の送信失敗は expiredUnnotified に計上 (成功と言わない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedIntent(db, { op: 'skip' });
    vi.mocked(dispatch).mockRejectedValueOnce(new Error('LINE down'));
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, AFTER_DEADLINE_MS);
    expect(res.expired).toBe(1);
    expect(res.expiredNotified).toBe(0);
    expect(res.expiredUnnotified).toBe(1);
  });

  it('expire の CAS 敗者 (list 後に並行 claim) は何も宣言しない (通知ゼロ)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedIntent(db, { op: 'skip' });
    store.hookAfterListPastDeadline = (rows) => {
      for (const r of rows) r.state = 'executing'; // list→expire の間にスタッフが claim
    };
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, AFTER_DEADLINE_MS);
    expect(res.pastDeadline).toBe(1);
    expect(res.expired).toBe(0);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('pause の締切超過 → expire せず同一行を次サイクルへ繰越し + エスカレーション (§1-2)', async () => {
    const moved: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-10-10' };
    const { db, store } = createDb({ contracts: [moved], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', presentedDate: '2026-10-10', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.target_cycle_key = 'C1:2026-09-10';
    row.presented_scheduled_date = '2026-09-10';
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';

    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.expired).toBe(0);
    expect(res.carriedOver).toBe(1);
    expect(res.escalated).toBe(1);
    const after = store.intents.get(res0.intent.id)!;
    expect(after.state).toBe('received'); // expire していない
    expect(after.target_cycle_key).toBe('C1:2026-10-10');
    expect(after.presented_scheduled_date).toBe('2026-10-10'); // 繰越し計算の基準も前進
    expect(after.deadline_at).toBe('2026-10-07T23:59:59.999+09:00');
    expect(after.carryover_count).toBe(1);

    // 2 回目の sweep で再ヒットしない (無限エスカレーションを防ぐ §1-2)
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res2.pastDeadline).toBe(0);
    expect(res2.escalated).toBe(0);
  });

  it('繰越し先の締切も既に過去なら unanchored (締切なし保持) — 同一値の無限再ヒットを作らない', async () => {
    // sweep が長期停止して再開した状況: presented 09-10 / interval 30 → 次は 10-10 だが
    // now は 11-20 = その締切 (10-07) も過去 → carried にすると毎 run 同じ計算で再ヒットする
    const stale: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-10' };
    const { db, store } = createDb({ contracts: [stale], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const LONG_AFTER_MS = Date.parse('2026-11-20T00:00:00Z');
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, LONG_AFTER_MS);
    expect(res.carriedOver).toBe(1);
    expect(res.carryUnanchored).toBe(1);
    const after = store.intents.get(res0.intent.id)!;
    expect(after.state).toBe('received');
    expect(after.deadline_at).toBeNull(); // 過去の締切を捏造しない
    expect(after.presented_scheduled_date).toBe('2026-10-10'); // 基準は前進している
    // 再ヒットしない
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, LONG_AFTER_MS);
    expect(res2.pastDeadline).toBe(0);
  });

  it('推定が動かない場合は interval_days で次サイクルを算出する', async () => {
    const noEstimate: ContractSeed = { ...CONTRACT, next_billing_estimate: null, interval_days: 30 };
    const { db, store } = createDb({ contracts: [noEstimate], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.target_cycle_key = 'C1:2026-09-10';
    row.presented_scheduled_date = '2026-09-10';
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.carriedOver).toBe(1);
    expect(res.carryUnanchored).toBe(0);
    const after = store.intents.get(res0.intent.id)!;
    expect(after.target_cycle_key).toBe('C1:2026-10-10'); // 09-10 + 30日
    expect(after.deadline_at).toBe('2026-10-07T23:59:59.999+09:00');
  });

  it('繰越し先に別 open intent がいたら superseded (新しい意思が優先・エスカレーションは出さない)', async () => {
    const moved: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-10-10' };
    const { db, store } = createDb({ contracts: [moved], friends: [FRIEND] });
    const old = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', presentedDate: '2026-10-10', nowMs: NOW_MS });
    if (old.status !== 'accepted') throw new Error('setup');
    const oldRow = store.intents.get(old.intent.id)!;
    oldRow.target_cycle_key = 'C1:2026-09-10';
    oldRow.presented_scheduled_date = '2026-09-10';
    oldRow.deadline_at = '2026-09-07T23:59:59.999+09:00';
    const fresh = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', nowMs: NOW_MS });
    if (fresh.status !== 'accepted') throw new Error('setup2');

    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.superseded).toBe(1);
    expect(res.escalated).toBe(0); // 後継の意思が以後の通知を担う
    expect(store.intents.get(old.intent.id)?.state).toBe('superseded');
    expect(store.intents.get(old.intent.id)?.escalated_at).toBeNull(); // terminal 行にマーカーを付けない
    expect(store.intents.get(fresh.intent.id)?.state).toBe('received');
  });

  it('carry-over の非 UNIQUE 例外 (D1 transient) は supersede せず errors に計上 (解約意思を消さない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';
    store.throwOnCarryOver = new Error('D1_ERROR: internal error');
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.superseded).toBe(0);
    expect(res.errors).toBe(1);
    expect(store.intents.get(res0.intent.id)?.state).toBe('received'); // 意思は消えていない
  });

  it('executor=blocked (移行窓) は sweep 対象外 (解約意思が消えない §4-2)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    store.intents.get(res0.intent.id)!.deadline_at = '2026-09-07T23:59:59.999+09:00';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.pastDeadline).toBe(0);
    expect(store.intents.get(res0.intent.id)?.state).toBe('deferred');
  });

  it('received でも executor=blocked は sweep 対象外 (§4-2 の述語第二項。§5-4 再アンカー期の防御)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.state = 'received';
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.pastDeadline).toBe(0);
    expect(row.state).toBe('received');
  });

  it('機械 executor の 30 分超 claim は自動解放 / human は解放せずアラート (claim 世代ごと 1 回)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const humanIntent = await seedIntent(db, { op: 'pause' });
    await claimSubIntent(db, humanIntent.id, STAFF, NOW_MS);
    const machine = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', executor: 'own_billing', nowMs: NOW_MS });
    if (machine.status !== 'accepted') throw new Error('setup');
    const mRow = store.intents.get(machine.intent.id)!;
    mRow.state = 'executing';
    mRow.claimed_at = toJstString(new Date(NOW_MS));

    const later = NOW_MS + (MACHINE_CLAIM_RELEASE_MINUTES + 10) * 60_000;
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, later);
    expect(res.releasedMachineClaims).toBe(1);
    expect(res.staleHumanClaims).toBe(1);
    expect(res.staleAlerted).toBe(1);
    expect(store.intents.get(machine.intent.id)?.state).toBe('received');
    expect(store.intents.get(humanIntent.id)?.state).toBe('executing'); // 解放されない

    // 2 回目はアラートを繰り返さない (claim 世代ごと 1 回)
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, later + 60_000);
    expect(res2.staleHumanClaims).toBe(1); // 件数としては見える (可視化)
    expect(res2.staleAlerted).toBe(0); // 通知は増えない
  });

  it('claim 滞留アラートと締切超過エスカレーションは独立 (片方の消費でもう片方が沈黙しない)', async () => {
    // 順序: claim → 30分放置 (滞留アラート) → release → 締切超過 → 繰越しエスカレーション。
    // マーカーを 1 列で共有すると 2 つ目の通知が永久に出ない (監査 state-machine HIGH の回帰テスト)
    const moved: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-10-10' };
    const { db, store } = createDb({ contracts: [moved], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer', presentedDate: '2026-10-10', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.target_cycle_key = 'C1:2026-09-10';
    row.presented_scheduled_date = '2026-09-10';
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';

    await claimSubIntent(db, res0.intent.id, STAFF, NOW_MS);
    const stale = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NOW_MS + 40 * 60_000);
    expect(stale.staleAlerted).toBe(1); // ① claim 滞留アラート
    await releaseSubIntent(db, res0.intent.id, NOW_MS + 41 * 60_000);
    const overdue = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(overdue.carriedOver).toBe(1);
    expect(overdue.escalated).toBe(1); // ② 締切超過エスカレーションも発火する
  });

  it('Discord 通知は人間に届く形で送られる (webhook 本文にアラート文と /admin/ops 誘導)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'pause' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const fetchImpl = vi.fn(async () => ({}) as Response);
    await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
      NOW_MS + 40 * 60_000,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://discord.test/webhook');
    const body = JSON.parse(init.body) as { content: string };
    expect(body.content).toContain('着手が 30 分を超えて未解決');
    expect(body.content).toContain('/admin/ops');
  });
});

// ============================================================
// /admin/ops API (認可・gate・監査・可視化)
// ============================================================

function buildApp(staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (staff) c.set('staff' as never, staff as never);
    await next();
  });
  app.route('/', adminOps);
  return app;
}

const ADMIN_STAFF = { id: 'staff-1', name: 'テスト管理者', role: 'admin' as const };

describe('/admin/ops routes', () => {
  it('GET /admin/ops は公開 shell (200 + HTML)', async () => {
    const { db } = createDb();
    const app = buildApp(null);
    const res = await app.request('/admin/ops', {}, { DB: db });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('受理台帳');
    // ブランド: LINE 黄緑を新規 UI に使わない (テーマは teal)
    expect(html).not.toContain('#06C755');
  });

  it('GET /api/admin/sub-intents は staff 無しで 403', async () => {
    const { db } = createDb();
    const app = buildApp(null);
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    expect(res.status).toBe(403);
  });

  it('staff ロールは一覧も 403 (owner/admin のみ)', async () => {
    const { db } = createDb();
    const app = buildApp({ id: 'staff-9', name: '一般', role: 'staff' });
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    expect(res.status).toBe(403);
  });

  it('一覧は gate OFF でも閲覧できる (gateEnabled=false を返す)', async () => {
    const { db } = createDb();
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { gateEnabled: boolean } };
    expect(json.data.gateEnabled).toBe(false);
  });

  it('migration 076 未適用 (no such table) は 500 にせず migrationMissing を返す', async () => {
    const { db, store } = createDb();
    store.throwNoSuchTable = true;
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { migrationMissing?: boolean; intents: unknown[] } };
    expect(json.data.migrationMissing).toBe(true);
    expect(json.data.intents).toEqual([]);
  });

  it('一覧の可視化: 滞留 claim が先頭・未解決時間と claimAlert・stats が正しい', async () => {
    // claimAgeMinutes はサーバの実時計で計算されるため、このテストだけ実時計相対で seed する
    const { db, store } = createDb();
    const realNow = Date.now();
    const mk = (over: Partial<SubIntentRow>): SubIntentRow => ({
      id: `si_${Math.random().toString(16).slice(2)}`,
      friend_id: null,
      contract_ns: 'hb',
      contract_key: 'C1',
      target_cycle_key: `C1:x${Math.random().toString(16).slice(2)}`,
      presented_scheduled_date: null,
      op: 'skip',
      state: 'received',
      requested_by: 'customer',
      actor_staff_id: null,
      actor_role: null,
      payload_json: null,
      deadline_at: null,
      promised_by: null,
      claimed_at: null,
      executor: 'human',
      supersedes_intent_id: null,
      fail_reason: null,
      carryover_count: 0,
      escalated_at: null,
      stale_alerted_at: null,
      promise_alerted_at: null,
      predeadline_escalated_at: null,
      verify_state: null,
      verify_baseline_json: null,
      verified_at: null,
      created_at: toJstString(new Date(realNow - 3_600_000)),
      resolved_at: null,
      ...over,
    });
    const stuck = mk({ state: 'executing', claimed_at: toJstString(new Date(realNow - 40 * 60_000)), actor_staff_id: 'staff-9' });
    const fresh = mk({ state: 'executing', claimed_at: toJstString(new Date(realNow - 5 * 60_000)) });
    const soon = mk({ state: 'received', deadline_at: toJstString(new Date(realNow + 86_400_000)) });
    const later = mk({ state: 'received', deadline_at: toJstString(new Date(realNow + 5 * 86_400_000)) });
    const done = mk({ state: 'done', resolved_at: toJstString(new Date(realNow - 60_000)) });
    for (const r of [done, later, soon, fresh, stuck]) store.intents.set(r.id, r);

    const app = buildApp(ADMIN_STAFF);
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    const json = (await res.json()) as {
      data: {
        intents: Array<{ id: string; claimAgeMinutes: number | null; claimAlert: boolean }>;
        stats: { received: number; executing: number; doneLast7d: number };
      };
    };
    const ids = json.data.intents.map((i) => i.id);
    // executing (滞留が先) → received (締切近い順) → terminal
    expect(ids).toEqual([stuck.id, fresh.id, soon.id, later.id, done.id]);
    const stuckRow = json.data.intents[0];
    expect(stuckRow.claimAgeMinutes).toBeGreaterThanOrEqual(39);
    expect(stuckRow.claimAgeMinutes).toBeLessThanOrEqual(41);
    expect(stuckRow.claimAlert).toBe(true);
    expect(json.data.intents[1].claimAlert).toBe(false);
    expect(json.data.stats.received).toBe(2);
    expect(json.data.stats.executing).toBe(2);
    expect(json.data.stats.doneLast7d).toBe(1);
  });

  it('変更系は gate OFF なら 400 (死んだ台帳を育てない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT] });
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      { DB: db },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('SUB_INTENT_ENABLED');
  });

  it('変更系は env-owner (共有キー) を 403 で拒否 (§4 個人キーのみ)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT] });
    const app = buildApp({ id: 'env-owner', name: 'Owner', role: 'owner' });
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      { DB: db, ...GATE_ON },
    );
    expect(res.status).toBe(403);
    expect(store.auditLogs.some((l) => l.action === 'admin.sub_intent.denied_env_owner')).toBe(true);
  });

  it('受理 → 着手 → 完了のフルフロー (HTTP 経由) + 監査記録 (PII なし)', async () => {
    // HTTP 受理は実時計 (nowMs 注入不可) — 固定日付だと実時計が締切へ近づいた時に
    // §4-1 の開示 (promise_after_deadline) へ倒れて時限爆弾になる → 実時計相対に置く
    const relContract: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db, store } = createDb({ contracts: [relContract], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };

    const accept = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'pause', note: '9月分から' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(accept.status).toBe(200);
    const acceptJson = (await accept.json()) as { data: { status: string; intent: { id: string } } };
    expect(acceptJson.data.status).toBe('accepted');
    const id = acceptJson.data.intent.id;

    const claim = await app.request(`/api/admin/sub-intents/${id}/claim`, { method: 'POST' }, env);
    expect(claim.status).toBe(200);

    const done = await app.request(`/api/admin/sub-intents/${id}/done`, { method: 'POST' }, env);
    expect(done.status).toBe(200);
    expect(store.intents.get(id)?.state).toBe('done');

    for (const action of ['admin.sub_intent.accept', 'admin.sub_intent.claim', 'admin.sub_intent.done']) {
      expect(store.auditLogs.some((l) => l.action === action)).toBe(true);
    }
    const acceptLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.accept');
    expect(acceptLog?.metadata).not.toContain('9月分から');
  });

  it('undo の監査にも contractKey/op が残る (§4 受入条件: 契約単位の追跡)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const intent = await seedIntent(db, { op: 'pause' });
    const res = await app.request(`/api/admin/sub-intents/${intent.id}/undo`, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    const undoLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.undo');
    expect(undoLog?.metadata).toContain('C1');
    expect(undoLog?.metadata).toContain('pause');
    // /admin/ops 経由の undo は requested_by='staff' — ただし直接 CAS 取り消しでは行が terminal。
    // undo_of が生成されるケースで種別を確認する
    const intent2 = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent2.id, STAFF, NOW_MS);
    await app.request(`/api/admin/sub-intents/${intent2.id}/undo`, { method: 'POST' }, env);
    const undoOf = [...store.intents.values()].find((r) => r.op === 'undo_of');
    expect(undoOf?.requested_by).toBe('staff');
  });

  it('done の CAS 敗者は 409 + suspectDoubleExecution + Discord alert (完了と言わない §1-2)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    try {
      const env = { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' };
      const intent = await seedIntent(db);
      const res = await app.request(`/api/admin/sub-intents/${intent.id}/done`, { method: 'POST' }, env);
      expect(res.status).toBe(409);
      const json = (await res.json()) as { suspectDoubleExecution?: boolean };
      expect(json.suspectDoubleExecution).toBe(true);
      expect(fetchCalls.some((b) => b.includes('二重対応の疑い'))).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('fail は理由必須 (400)。audit には理由本文でなく定数が残る (PII 最小化)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const empty = await app.request(
      `/api/admin/sub-intents/${intent.id}/fail`,
      { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(empty.status).toBe(400);
    const res = await app.request(
      `/api/admin/sub-intents/${intent.id}/fail`,
      { method: 'POST', body: JSON.stringify({ reason: '山田様の電話番号 090-xxxx' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(200);
    const failLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.fail');
    expect(failLog?.errorMessage).toBe('staff_reason_recorded');
    expect(failLog?.errorMessage).not.toContain('山田');
  });

  it('存在しない契約の受理は 404 / 予定日の形式不正は 400', async () => {
    const { db } = createDb({ contracts: [CONTRACT] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const notFound = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'NOPE', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(notFound.status).toBe(404);
    const badDate = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip', presentedDate: 'garbage' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(badDate.status).toBe(400);
  });

  it('deferred の undo は HTTP 経由でも cancelled になる (移行窓の意思の取り下げ)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    const res = await app.request(`/api/admin/sub-intents/${res0.intent.id}/undo`, { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect(store.intents.get(res0.intent.id)?.state).toBe('cancelled');
  });
});

// ============================================================
// authMiddleware skip-list (/admin/ops は GET の shell のみ素通り)
// ============================================================

describe('authMiddleware skip-list (/admin/ops)', () => {
  function buildAuthedApp() {
    const app = new Hono();
    app.use('*', authMiddleware as never);
    app.route('/', adminOps);
    return app;
  }

  it('GET /admin/ops は Bearer なしで 200 (公開 shell)', async () => {
    const { db } = createDb();
    const res = await buildAuthedApp().request('/admin/ops', {}, { DB: db, API_KEY: 'k' });
    expect(res.status).toBe(200);
  });

  it('POST /admin/ops は 401 (GET 限定 skip = method 非依存の穴を作らない)', async () => {
    const { db } = createDb();
    const res = await buildAuthedApp().request('/admin/ops', { method: 'POST' }, { DB: db, API_KEY: 'k' });
    expect(res.status).toBe(401);
  });

  it('GET/POST /api/admin/sub-intents は Bearer なしで 401 (実データは素通りさせない)', async () => {
    const { db } = createDb();
    const app = buildAuthedApp();
    expect((await app.request('/api/admin/sub-intents', {}, { DB: db, API_KEY: 'k' })).status).toBe(401);
    expect(
      (await app.request('/api/admin/sub-intents', { method: 'POST' }, { DB: db, API_KEY: 'k' })).status,
    ).toBe(401);
  });
});

// ============================================================
// ユーティリティ
// ============================================================

describe('cycle key / deadline ヘルパー', () => {
  it('buildCycleKey は日付なしを unknown に畳む / undo キーは元 intent を含む', () => {
    expect(buildCycleKey('C1', '2026-09-10')).toBe('C1:2026-09-10');
    expect(buildCycleKey('C1', null)).toBe('C1:unknown');
    expect(buildUndoCycleKey('C1:2026-09-10', 'si_abc')).toBe('C1:2026-09-10#undo:si_abc');
  });

  it('computeDeadlineAt = 決済3日前の EOD JST (不正入力は null)', () => {
    expect(computeDeadlineAt('2026-09-10')).toBe('2026-09-07T23:59:59.999+09:00');
    expect(computeDeadlineAt(null)).toBeNull();
    expect(computeDeadlineAt('unknown')).toBeNull();
  });

  it('gate 判定は厳密一致', () => {
    expect(isSubIntentEnabled({ SUB_INTENT_ENABLED: 'true' })).toBe(true);
    expect(isSubIntentEnabled({ SUB_INTENT_ENABLED: 'TRUE' })).toBe(false);
    expect(isSubIntentEnabled({})).toBe(false);
  });

  it('op ラベルは全 op を網羅', () => {
    for (const op of ['skip', 'date', 'pause', 'resume', 'cancel', 'undo_of'] as const) {
      expect(SUB_INTENT_OP_LABELS[op]).toBeTruthy();
    }
  });
});

// ============================================================
// §4-1: promised_by (営業カレンダー) と受理前開示
// ============================================================

describe('§4-1 営業カレンダー (computePromisedBy)', () => {
  it('平日受理 → 翌営業日 17:00 JST (火曜 09:00 受理 → 水曜 17:00)', () => {
    expect(computePromisedBy(Date.parse('2026-09-01T00:00:00Z'))).toBe('2026-09-02T17:00:00.000+09:00');
  });

  it('金曜・土曜・日曜の受理はいずれも月曜 17:00 (土曜は当面 休み扱い = 顧客向け案内と一致)', () => {
    expect(computePromisedBy(Date.parse('2026-09-04T00:00:00Z'))).toBe('2026-09-07T17:00:00.000+09:00');
    expect(computePromisedBy(Date.parse('2026-09-05T00:00:00Z'))).toBe('2026-09-07T17:00:00.000+09:00');
    expect(computePromisedBy(Date.parse('2026-09-06T00:00:00Z'))).toBe('2026-09-07T17:00:00.000+09:00');
  });

  it('土曜の扱いは SATURDAY_IS_BUSINESS_DAY 1 つで決まる (顧客向け案内と同時に切り替える前提)', () => {
    // 現在は false = 土曜休み。true にしたとき「金曜 → 土曜」になることを定数から導出して固定する
    expect(SATURDAY_IS_BUSINESS_DAY).toBe(false);
    expect(isBusinessDayJst('2026-09-05')).toBe(SATURDAY_IS_BUSINESS_DAY); // 土
  });

  it('JST の日付境界で判定する (火曜 23:30 JST → 水曜 / 水曜 00:30 JST → 木曜)', () => {
    expect(computePromisedBy(Date.parse('2026-09-01T14:30:00Z'))).toBe('2026-09-02T17:00:00.000+09:00');
    expect(computePromisedBy(Date.parse('2026-09-01T15:30:00Z'))).toBe('2026-09-03T17:00:00.000+09:00');
  });

  it('isBusinessDayJst: 平日 true / 土日 false / 不正入力 false', () => {
    expect(isBusinessDayJst('2026-09-01')).toBe(true); // 火
    expect(isBusinessDayJst('2026-09-05')).toBe(false); // 土 (当面 休み扱い)
    expect(isBusinessDayJst('2026-09-06')).toBe(false); // 日 = 定休
    expect(isBusinessDayJst('garbage')).toBe(false);
  });

  it('🔔 祝日テーブルの被覆期限が十分先にある (期限が近づいたら CI を赤くして更新を強制する)', () => {
    // **意図的な時限テスト**: 実時計に依存させて「更新漏れ」を検知する唯一の仕組み。
    // 落ちたら business-calendar.ts の JP_HOLIDAYS_JST に翌年分を追記し
    // HOLIDAY_TABLE_VALID_THROUGH を伸ばすこと (内閣府の祝日 CSV が一次情報源)。
    // ⚠️ 期限切れを放置しても顧客に嘘はつかない (約束を出さなくなるだけ) が、
    //    「反映予定」が出せない期間が続くので体験は劣化する。
    const halfYearAhead = new Date(Date.now() + 183 * 86_400_000).toISOString().slice(0, 10);
    expect(HOLIDAY_TABLE_VALID_THROUGH >= halfYearAhead).toBe(true);
  });

  it('祝日テーブル満了後は営業日と断定せず、約束を出さない (元日を約束する事故の封鎖)', () => {
    // 2028-01-01 は元日かつ土曜。テーブルは 2027-12-31 までしか知らない
    expect(isBusinessDayJst('2028-01-01')).toBe(false);
    // ⚠️ 上の 1 行だけでは**満了ガードを検証できない** — 土曜ルールでも false になるため
    //    (mutation C4 が SURVIVED した実測)。土曜営業に切り替えた瞬間に穴が開く。
    //    満了後の**平日**で「営業日と断定しない」ことを固定する
    expect(isBusinessDayJst('2028-01-03')).toBe(false); // 月曜だが満了後
    expect(isBusinessDayJst('2028-06-14')).toBe(false); // 水曜・祝日でもない満了後の平日
    expect(isBusinessDayJst(HOLIDAY_TABLE_VALID_THROUGH)).toBe(false); // 2027-12-31 は年末休業
    // 満了直前の受理は約束を出さない (誤った日を約束するより「約束しない」)
    expect(computePromisedBy(Date.parse('2027-12-30T00:00:00Z'))).toBeNull();
    // 受理自体は成立し、文言は約束なしの分岐に落ちる
    expect(buildAcceptanceMessage('skip', null, 'human')).toContain('スタッフが順に対応');
  });

  it('出力は deadline_at と同形式 (文字列比較で promised_by > deadline_at が成立する)', () => {
    const promise = computePromisedBy(Date.parse('2026-09-04T00:00:00Z')); // 金曜 → 月曜 17:00
    expect(promise).toBe('2026-09-07T17:00:00.000+09:00');
    const deadline = computeDeadlineAt('2026-09-08'); // 09-05 EOD
    expect(deadline).not.toBeNull();
    expect(promise! > deadline!).toBe(true); // 週末跨ぎで約束が締切を超える実例 (毎週起こる)
  });
});

describe('§4-1 受理時の約束と開示', () => {
  it('受理で promised_by が記録される (火曜受理 → 水曜 17:00)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS,
    });
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.intent.promised_by).toBe('2026-09-02T17:00:00.000+09:00');
  });

  it('§4-3 の基準値 (verify_baseline_json) は受理時に採取される', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS,
    });
    if (res.status !== 'accepted') throw new Error('setup');
    const baseline = JSON.parse(res.intent.verify_baseline_json!) as VerifyBaseline;
    expect(baseline.estimate).toBe('2026-09-10');
    expect(baseline.source).toBe('flow');
    expect(baseline.intervalDays).toBe(30);
    expect(baseline.orderCount).toBe(3);
    expect(baseline.acceptedAt).toBe(toJstString(new Date(NOW_MS)));
  });

  it('resume は検証対象外 = 基準値を持たない', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'resume', requestedBy: 'customer', nowMs: NOW_MS,
    });
    if (res.status !== 'accepted') throw new Error('setup');
    expect(res.intent.verify_baseline_json).toBeNull();
    expect(VERIFIABLE_OPS.includes('resume')).toBe(false);
  });

  it('skip/date は締切超過後の受理を拒む (deadline_passed — 即失効する「承りました」を作らない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      nowMs: AFTER_DEADLINE_MS, acknowledgeLatePromise: true, // ack でも拒む
    });
    expect(res.status).toBe('deadline_passed');
    expect(store.intents.size).toBe(0);
    // pause/cancel は締切後も受理 (§1-2 の繰越しが救済)
    const pause = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', nowMs: AFTER_DEADLINE_MS,
    });
    expect(pause.status).toBe('accepted');
    // blocked (移行窓) は §5-1「必ず受理」が優先
    const blocked = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      executor: 'blocked', nowMs: AFTER_DEADLINE_MS,
    });
    expect(blocked.status).toBe('accepted');
  });

  it('金曜受理 + 土曜締切 → promise_after_deadline (受理していない)。了承すれば受理される', async () => {
    // 推定 09-08 → 締切 09-05 (土) EOD。金曜受理の約束は月曜 17:00 = 締切超過 (週末跨ぎ)
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const friday = Date.parse('2026-09-04T00:00:00Z');
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: friday,
    });
    expect(res.status).toBe('promise_after_deadline');
    if (res.status !== 'promise_after_deadline') return;
    expect(res.promisedBy).toBe('2026-09-07T17:00:00.000+09:00');
    expect(res.deadlineAt).toBe('2026-09-05T23:59:59.999+09:00');
    expect(store.intents.size).toBe(0); // 開示前に台帳へ入れない

    const ack = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: friday,
      acknowledgeLatePromise: true,
    });
    expect(ack.status).toBe('accepted');
    if (ack.status !== 'accepted') return;
    expect(ack.intent.promised_by).toBe('2026-09-07T17:00:00.000+09:00');
  });

  it('executor=blocked (モードB) は営業時間で約束しない (promised_by NULL・開示もしない)', async () => {
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db } = createDb({ contracts: [tight], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      executor: 'blocked', nowMs: Date.parse('2026-09-04T00:00:00Z'),
    });
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.intent.promised_by).toBeNull();
    expect(res.intent.state).toBe('deferred');
  });

  it('resume (締切なし) は約束が何であれ開示に落ちない', async () => {
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db } = createDb({ contracts: [tight], friends: [FRIEND] });
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'resume', requestedBy: 'customer',
      nowMs: Date.parse('2026-09-04T00:00:00Z'), // 金曜 → 月曜 17:00
    });
    expect(res.status).toBe('accepted');
    if (res.status !== 'accepted') return;
    expect(res.intent.promised_by).toBe('2026-09-07T17:00:00.000+09:00');
    expect(res.intent.deadline_at).toBeNull();
  });

  it('undo_of にも約束が付く (取り消し作業も顧客は待っている)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const undo = await undoSubIntent(db, intent.id, { staffId: null, role: null }, { nowMs: NOW_MS });
    expect(undo.status).toBe('undo_accepted');
    if (undo.status !== 'undo_accepted') return;
    expect(store.intents.get(undo.undoIntent.id)?.promised_by).toBe('2026-09-02T17:00:00.000+09:00');
  });

  it('受理文言: 反映予定を含み、cancel には §4-4 の救済手順が必ず入る', () => {
    const promise = '2026-09-02T17:00:00.000+09:00';
    expect(formatPromisedBy(promise)).toBe('9月2日 17:00');
    const skipMsg = buildAcceptanceMessage('skip', promise, 'human');
    expect(skipMsg).toContain('9月2日 17:00 までに反映予定');
    expect(skipMsg).not.toContain('返金');
    const cancelMsg = buildAcceptanceMessage('cancel', promise, 'human');
    expect(cancelMsg).toContain('期限切れで無効になることはありません');
    expect(cancelMsg).toContain('返金');
    const blockedMsg = buildAcceptanceMessage('skip', null, 'blocked');
    expect(blockedMsg).toContain('お切り替え手続き');
    expect(blockedMsg).not.toContain('反映予定です'); // モードB は営業時間の約束を出さない
  });

  it('開示文言: 期限と最短約束を明示し、cancel/pause は繰越し救済・skip/date は通常手続きの可能性を言う', () => {
    const d = buildLatePromiseDisclosure('skip', '2026-09-07T17:00:00.000+09:00', '2026-09-05T23:59:59.999+09:00');
    expect(d).toContain('9月7日 17:00');
    expect(d).toContain('9月5日');
    expect(d).toContain('通常どおり');
    const dc = buildLatePromiseDisclosure('cancel', '2026-09-07T17:00:00.000+09:00', '2026-09-05T23:59:59.999+09:00');
    expect(dc).toContain('無効になることはありません');
    expect(dc).toContain('返金');
  });
});

// ============================================================
// §4-2 一段目: 約束破り sweep
// ============================================================

/** 木曜 09:00 JST — 約束 (水曜 17:00) は超過・締切 (09-07 EOD) は未来 */
const PROMISE_BROKEN_MS = Date.parse('2026-09-03T00:00:00Z');

describe('§4-2 約束破り sweep', () => {
  it('promised_by 超過の received → 「お時間をいただいています」push (1 intent 1 回) + Discord + 監査', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(res.pastPromise).toBe(1);
    expect(res.promiseAlerted).toBe(1);
    expect(res.promiseNotified).toBe(1);
    expect(res.expired).toBe(0); // 締切は未来 — expire と混ざっていない
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatch).mock.calls[0][1];
    expect(call.category).toBe('transactional');
    expect(JSON.stringify(call.linePayload?.messages)).toContain('お時間をいただいています');
    expect(store.intents.get(intent.id)?.promise_alerted_at).not.toBeNull();
    expect(store.intents.get(intent.id)?.state).toBe('received'); // 通知は状態を動かさない
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.promise_broken')).toBe(true);

    // 2 回目の sweep では再通知しない (1 intent 1 回)
    vi.mocked(dispatch).mockClear();
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(res2.pastPromise).toBe(0);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('締切超過が先: 両方超過した skip は expire の正直な失敗通知のみ (遅延連絡→失効連絡の連打をしない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedIntent(db, { op: 'skip' });
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, AFTER_DEADLINE_MS);
    expect(res.expired).toBe(1);
    expect(res.promiseAlerted).toBe(0); // expire 済み = 約束破り通知の対象外
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(dispatch).mock.calls[0][1].linePayload?.messages)).toContain('完了できませんでした');
  });

  it('未連携は promiseUnnotified に計上 (成功と言わない)', async () => {
    const contract: ContractSeed = { ...CONTRACT, shopify_customer_id: null };
    const { db } = createDb({ contracts: [contract] });
    await seedIntent(db);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(res.promiseAlerted).toBe(1);
    expect(res.promiseNotified).toBe(0);
    expect(res.promiseUnnotified).toBe(1);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('executing (着手済み) は対象外 — 進んでいる依頼に「未着手の遅延」を送らない', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(res.pastPromise).toBe(0);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('Discord には約束時刻とフォロー要否が載る', async () => {
    const contract: ContractSeed = { ...CONTRACT, shopify_customer_id: null };
    const { db } = createDb({ contracts: [contract] });
    await seedIntent(db);
    const fetchCalls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/wh' },
      { fetchImpl },
      PROMISE_BROKEN_MS,
    );
    const body = fetchCalls.join('');
    expect(body).toContain('約束期限');
    expect(body).toContain('未連携');
  });
});

// ============================================================
// §4-4: cancel の締切 24h 前 強制エスカレーション + 救済
// ============================================================

/** 月曜 09:00 JST — cancel の締切 (09-07T23:59) まで 15 時間 */
const NEAR_DEADLINE_MS = Date.parse('2026-09-07T00:00:00Z');

/** 約束破り pass を黙らせて §4-4 を単独観測する (通知済み扱いにする) */
function silencePromise(store: Store): void {
  for (const r of store.intents.values()) r.promise_alerted_at = r.promise_alerted_at ?? 'muted';
}

describe('§4-4 cancel 救済 (締切 24h 前の強制エスカレーション)', () => {
  it('締切まで 24h を切った未実行 cancel → Discord 強制エスカレーション (1 回) + 監査', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'cancel' });
    silencePromise(store);
    const fetchCalls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    const res = await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/wh' },
      { fetchImpl },
      NEAR_DEADLINE_MS,
    );
    expect(res.cancelNearDeadline).toBe(1);
    expect(res.predeadlineEscalated).toBe(1);
    expect(store.intents.get(intent.id)?.predeadline_escalated_at).not.toBeNull();
    expect(fetchCalls.join('')).toContain('最優先');
    expect(fetchCalls.join('')).toContain('返金');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.predeadline_escalated')).toBe(true);

    // 2 回目は再エスカレーションしない
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(res2.cancelNearDeadline).toBe(0);
    expect(res2.predeadlineEscalated).toBe(0);
  });

  it('§4-1 の開示判定とは別物: 24h はエスカレーション閾値であり受理は拒まない', () => {
    expect(CANCEL_PREDEADLINE_ESCALATION_HOURS).toBe(24);
  });

  it('skip は対象外 (cancel 限定 — skip の締切超過は expire が正直に扱う)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedIntent(db, { op: 'skip' });
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(res.cancelNearDeadline).toBe(0);
  });

  it('executing (着手済み・未完了) の cancel もエスカレーション対象', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'cancel' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(res.predeadlineEscalated).toBe(1);
  });

  it('done 済みの cancel は対象外', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'cancel' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(res.cancelNearDeadline).toBe(0);
  });

  it('繰越しはマーカーをリセットする — 次サイクルの締切 24h 前にも再エスカレーションされる', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'cancel' });
    silencePromise(store);

    // ① 締切 24h 前 (09-07): 1 回目のエスカレーション
    const r1 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(r1.predeadlineEscalated).toBe(1);

    // ② 締切超過 (09-08): 繰越し (10-10 サイクル・締切 10-07) + マーカーリセット
    const r2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(r2.carriedOver).toBe(1);
    const row = store.intents.get(intent.id)!;
    expect(row.deadline_at).toBe('2026-10-07T23:59:59.999+09:00');
    expect(row.predeadline_escalated_at).toBeNull();
    expect(r2.predeadlineEscalated).toBe(0); // 新しい締切は 24h より先 — この run では鳴らない

    // ③ 次サイクルの締切 24h 前 (10-07): 2 回目のエスカレーション
    const r3 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, Date.parse('2026-10-07T00:00:00Z'));
    expect(r3.predeadlineEscalated).toBe(1);
  });

  it('executor=blocked は対象外 (移行窓の実行は PHASE3 側)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    // blocked は deferred だが、防御として received に置き換えても除外されることを確認
    store.intents.get(res0.intent.id)!.state = 'received';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NEAR_DEADLINE_MS);
    expect(res.cancelNearDeadline).toBe(0);
  });
});

// ============================================================
// §4-3: evaluateExecution (純関数 — op 別照合の 3 値)
// ============================================================

const EVAL_BASELINE: VerifyBaseline = {
  estimate: '2026-09-10',
  source: 'flow',
  intervalDays: 30,
  skipCount: 0,
  orderCount: 3,
  acceptedAt: '2026-09-01T09:00:00.000+09:00',
};

const EVAL_CONTRACT = {
  next_billing_estimate: '2026-10-10',
  estimate_source: 'flow',
  interval_days: 30,
  skip_count: 1, // 受理時 0 → 1 回スキップ実行済み (正常な前進)
  cancelled_at: null as string | null,
  paused_at: null as string | null,
};

function evalInput(over: Partial<EvaluateExecutionInput> = {}): EvaluateExecutionInput {
  return {
    op: 'skip',
    presentedDate: '2026-09-10',
    requestedDate: null,
    doneAt: '2026-09-01T15:00:00.000+09:00',
    baseline: EVAL_BASELINE,
    contract: EVAL_CONTRACT,
    orders: [],
    otherDoneSameOp: 0,
    resumedAfterDone: false,
    nowJst: '2026-09-12T09:00:00.000+09:00',
    ...over,
  };
}

describe('§4-3 evaluateExecution — skip', () => {
  it('窓内に count 前進の注文が出た → 即 miss (スキップ漏れ)', () => {
    const r = evaluateExecution(evalInput({
      orders: [{ orderCount: 4, createdAt: '2026-09-10T09:00:00.000+09:00' }],
    }));
    expect(r).toEqual({ verdict: 'miss', reason: 'order_in_skip_window' });
  });

  it('count が前進していない注文 (旧注文の遅延 import) は課金の証拠にしない — 濡れ衣を作らない', () => {
    const r = evaluateExecution(evalInput({
      orders: [{ orderCount: 2, createdAt: '2026-09-10T09:00:00.000+09:00' }],
    }));
    expect(r.verdict).toBe('pending'); // 窓が閉じるまで監視継続 (miss ではない)
  });

  it('count タグの無い注文が窓に出た → 窓終端で判定保留 (miss と言わない・人間確認へ)', () => {
    const r = evaluateExecution(evalInput({
      orders: [{ orderCount: null, createdAt: '2026-09-10T09:00:00.000+09:00' }],
      nowJst: '2026-09-26T09:00:00.000+09:00', // evalAt (09-10 + 15d) 超過
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'untagged_order_in_window' });
  });

  it('flow: 前進量 = 1 周期ちょうど → 窓終端で ok', () => {
    const r = evaluateExecution(evalInput({ nowJst: '2026-09-26T09:00:00.000+09:00' }));
    expect(r).toEqual({ verdict: 'ok', reason: 'estimate_advanced_one_cycle' });
  });

  it('flow: 前進量 = 2 周期 → 即 miss (二重 skip。①の注文不在だけでは検出できない §4-3)', () => {
    const r = evaluateExecution(evalInput({
      contract: { ...EVAL_CONTRACT, next_billing_estimate: '2026-11-09' },
    }));
    expect(r).toEqual({ verdict: 'miss', reason: 'double_skip' });
  });

  it('前進量 2 周期でも他の done skip があるなら判定保留 (正当な 2 回スキップと区別できない)', () => {
    const r = evaluateExecution(evalInput({
      contract: { ...EVAL_CONTRACT, next_billing_estimate: '2026-11-09' },
      otherDoneSameOp: 1,
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'multiple_skips_executed' });
  });

  it('derived は前進量を測らない → 窓終端で判定保留 (§4-3: flow 前提)', () => {
    const r = evaluateExecution(evalInput({
      baseline: { ...EVAL_BASELINE, source: 'derived' },
      contract: { ...EVAL_CONTRACT, estimate_source: 'derived' },
      nowJst: '2026-09-26T09:00:00.000+09:00',
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'no_flow_measurement' });
  });

  it('flow なのに推定が動いていない → 判定保留 (estimate_not_advanced — Flow 沈黙の可能性)', () => {
    const r = evaluateExecution(evalInput({
      contract: { ...EVAL_CONTRACT, next_billing_estimate: '2026-09-10' },
      nowJst: '2026-09-26T09:00:00.000+09:00',
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'estimate_not_advanced' });
  });

  it('窓が閉じるまでは pending (1 点判定にしない)', () => {
    const r = evaluateExecution(evalInput({ nowJst: '2026-09-20T09:00:00.000+09:00' }));
    expect(r.verdict).toBe('pending');
  });

  it('presented 不明 (unknown サイクル) は判定保留', () => {
    const r = evaluateExecution(evalInput({ presentedDate: null }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'no_presented_date' });
  });
});

describe('§4-3 evaluateExecution — date / pause / cancel', () => {
  it('date: 希望日なし (自由記述メモのみ) は照合不能 = 判定保留', () => {
    const r = evaluateExecution(evalInput({ op: 'date' }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'no_requested_date' });
  });

  it('date: 旧予定日側に count 前進の注文 → 即 miss (変更漏れ)', () => {
    const r = evaluateExecution(evalInput({
      op: 'date',
      requestedDate: '2026-09-20',
      orders: [{ orderCount: 4, createdAt: '2026-09-10T09:00:00.000+09:00' }],
    }));
    expect(r).toEqual({ verdict: 'miss', reason: 'order_on_old_date' });
  });

  it('date: 新予定日側にのみ注文 → 窓終端で ok。小幅変更 (新日が旧窓内) は miss にしない', () => {
    const ok = evaluateExecution(evalInput({
      op: 'date',
      requestedDate: '2026-09-20',
      orders: [{ orderCount: 4, createdAt: '2026-09-20T09:00:00.000+09:00' }],
      nowJst: '2026-09-28T09:00:00.000+09:00',
    }));
    expect(ok).toEqual({ verdict: 'ok', reason: 'order_on_new_date' });
    // 旧 09-10 → 新 09-12 (旧窓 [-2,+7] の内側)。新日近傍の注文は変更成立の証拠
    const overlap = evaluateExecution(evalInput({
      op: 'date',
      requestedDate: '2026-09-12',
      orders: [{ orderCount: 4, createdAt: '2026-09-12T09:00:00.000+09:00' }],
      nowJst: '2026-09-20T09:00:00.000+09:00',
    }));
    expect(overlap).toEqual({ verdict: 'ok', reason: 'order_on_new_date' });
  });

  it('date: 注文が観測できないまま窓終端 → 判定保留 (ok を捏造しない)', () => {
    const r = evaluateExecution(evalInput({
      op: 'date',
      requestedDate: '2026-09-20',
      nowJst: '2026-09-28T09:00:00.000+09:00',
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'no_order_observed' });
  });

  it('cancel: read-model の cancelled_at (受理後) → 即 ok', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      contract: { ...EVAL_CONTRACT, cancelled_at: '2026-09-02' },
    }));
    expect(r).toEqual({ verdict: 'ok', reason: 'cancel_tag_present' });
  });

  it('cancel: 受理より前の cancelled_at (別件の古いタグ) は証拠にしない', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      contract: { ...EVAL_CONTRACT, cancelled_at: '2026-08-01' },
    }));
    expect(r.verdict).toBe('pending');
  });

  it('cancel: done 後に count 前進の注文 → 即 miss (解約漏れ)', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      orders: [{ orderCount: 4, createdAt: '2026-09-15T09:00:00.000+09:00' }],
      nowJst: '2026-09-16T09:00:00.000+09:00',
    }));
    expect(r).toEqual({ verdict: 'miss', reason: 'order_after_cancel' });
  });

  it('cancel: done 後に resume が実行済みなら以後の注文は正当でありうる = 判定保留', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      orders: [{ orderCount: 4, createdAt: '2026-09-15T09:00:00.000+09:00' }],
      resumedAfterDone: true,
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'resumed_after_done' });
  });

  it('cancel: 1 周期ぶん注文が出ないまま窓終端 → ok', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      nowJst: '2026-10-03T09:00:00.000+09:00', // doneAt 09-01 + 30d = 10-01 超過
    }));
    expect(r).toEqual({ verdict: 'ok', reason: 'no_order_in_cycle' });
  });

  it('pause: paused_at (受理後) → 即 ok / 周期不明は 30 日で判定保留', () => {
    const tag = evaluateExecution(evalInput({
      op: 'pause',
      contract: { ...EVAL_CONTRACT, paused_at: '2026-09-02' },
    }));
    expect(tag).toEqual({ verdict: 'ok', reason: 'pause_tag_present' });
    const unknown = evaluateExecution(evalInput({
      op: 'pause',
      baseline: { ...EVAL_BASELINE, intervalDays: null },
      contract: { ...EVAL_CONTRACT, interval_days: null },
      nowJst: '2026-10-03T09:00:00.000+09:00',
    }));
    expect(unknown).toEqual({ verdict: 'inconclusive', reason: 'interval_unknown' });
  });

  it('done 前の count 前進注文 (受理〜done 間の課金) は pause/cancel の miss にしない (実行前の事象)', () => {
    const r = evaluateExecution(evalInput({
      op: 'cancel',
      doneAt: '2026-09-16T09:00:00.000+09:00',
      orders: [{ orderCount: 4, createdAt: '2026-09-15T09:00:00.000+09:00' }],
      nowJst: '2026-09-17T09:00:00.000+09:00',
    }));
    expect(r.verdict).toBe('pending');
  });
});

// ============================================================
// §4-3: sweep 統合 (pending 登録 → 照合 → verdict CAS → 検出時アクション)
// ============================================================

describe('§4-3 実行漏れ検出 (sweep 統合)', () => {
  async function seedDone(db: D1Database, op: 'skip' | 'date' | 'pause' | 'resume' | 'cancel') {
    const intent = await seedIntent(db, { op });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const done = await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    if (done.status !== 'done') throw new Error('setup');
    return intent;
  }

  it('done で verify_state=pending が立つ (skip)。resume は対象外', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const skip = await seedDone(db, 'skip');
    expect(store.intents.get(skip.id)?.verify_state).toBe('pending');
    const resume = await seedDone(db, 'resume');
    expect(store.intents.get(resume.id)?.verify_state).toBeNull();
  });

  it('miss: 窓内の count 前進注文 → 謝罪 push (1 回) + Discord + 監査。再 sweep で再通知しない', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND],
      orders: [{ shopify_order_id: 'O1', tags: 'subscription-id:C1, subscription-count:4', created_at: '2026-09-10T09:00:00.000+09:00' }],
    });
    const intent = await seedDone(db, 'skip');
    silencePromise(store);
    const fetchCalls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    const res = await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/wh' },
      { lineClient: fakeLineClient(), fetchImpl },
      Date.parse('2026-09-12T00:00:00Z'),
    );
    expect(res.verifyPending).toBe(1);
    expect(res.verifyMiss).toBe(1);
    expect(res.verifyMissNotified).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('miss');
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(dispatch).mock.calls[0][1].linePayload?.messages)).toContain('確認が必要');
    expect(fetchCalls.join('')).toContain('実行漏れの疑い');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.verify.miss')).toBe(true);

    vi.mocked(dispatch).mockClear();
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-12T00:00:00Z'));
    expect(res2.verifyPending).toBe(0);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('旧注文の遅延 import (count ≤ 基準) は miss にしない → flow の前進で ok に確定', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND],
      orders: [{ shopify_order_id: 'O0', tags: 'subscription-id:C1, subscription-count:2', created_at: '2026-09-10T09:00:00.000+09:00' }],
    });
    const intent = await seedDone(db, 'skip');
    silencePromise(store);
    store.contracts.get('C1')!.next_billing_estimate = '2026-10-10'; // Flow スキップ実測が反映済み
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-26T00:00:00Z'));
    expect(res.verifyMiss).toBe(0);
    expect(res.verifyOk).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('ok');
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled(); // ok は顧客に何も送らない
  });

  it('LIKE の部分一致 (C1 と C10) を parse で厳密に突合する — 隣の契約の注文で miss を出さない', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND],
      orders: [{ shopify_order_id: 'OX', tags: 'subscription-id:C10, subscription-count:9', created_at: '2026-09-10T09:00:00.000+09:00' }],
    });
    const intent = await seedDone(db, 'skip');
    silencePromise(store);
    store.contracts.get('C1')!.next_billing_estimate = '2026-10-10';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-26T00:00:00Z'));
    expect(res.verifyMiss).toBe(0);
    expect(res.verifyOk).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('ok');
  });

  it('基準値が読めない行は判定保留 (謝罪を送らない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedDone(db, 'skip');
    store.intents.get(intent.id)!.verify_baseline_json = 'not-json';
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-12T00:00:00Z'));
    expect(res.verifyInconclusive).toBe(1);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.verify.inconclusive')).toBe(true);
  });

  it('cancel: cancelled_at タグの反映で即 ok (窓を待たない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedDone(db, 'cancel');
    store.contracts.get('C1')!.cancelled_at = '2026-09-02';
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-03T00:00:00Z'));
    expect(res.verifyOk).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('ok');
  });

  it('cancel: done 後の count 前進注文 → miss + 謝罪 (解約漏れは顧客への課金 = 最悪の失敗)', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND],
      orders: [{ shopify_order_id: 'O2', tags: 'subscription-id:C1, subscription-count:4', created_at: '2026-09-15T09:00:00.000+09:00' }],
    });
    const intent = await seedDone(db, 'cancel');
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-16T00:00:00Z'));
    expect(res.verifyMiss).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('miss');
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
  });

  it('gate OFF では検証も走らない (dormancy)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedDone(db, 'skip');
    const before = store.queryCount;
    const res = await sweepSubIntents({ DB: db }, {}, Date.parse('2026-09-12T00:00:00Z'));
    expect(res.skippedGating).toBe(true);
    expect(store.queryCount).toBe(before);
  });
});

// ============================================================
// §8-2 / §4-1: /admin/ops の受理応答・開示・done/fail push
// ============================================================

describe('/admin/ops §10-4 (開示・伝達文・完了/失敗 push)', () => {
  it('受理応答に顧客への伝達文 (反映予定つき) が入る。cancel は救済手順つき', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db } = createDb({ contracts: [relContract], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'cancel' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { customerMessage: string; intent: { promisedBy: string | null } } };
    expect(json.data.customerMessage).toContain('までに反映予定');
    expect(json.data.customerMessage).toContain('返金');
    expect(json.data.intent.promisedBy).not.toBeNull();
  });

  it('§4-1: 約束が期限に間に合わない受理は 409 + 開示文言。acknowledge で受理される', async () => {
    // 締切 = 本日 EOD (推定 = 実時計 + 3 日) — 約束 (翌営業日 17:00) は必ず締切超過になる。
    // +2 日にすると締切が過去になり deadline_passed (400) 側へ倒れる — 別テストで固定
    const tight: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 3 * 86_400_000)).slice(0, 10),
    };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const first = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(first.status).toBe(409);
    const firstJson = (await first.json()) as { requiresAcknowledgement?: boolean; disclosure?: string };
    expect(firstJson.requiresAcknowledgement).toBe(true);
    expect(firstJson.disclosure).toContain('間に合わない');
    expect(store.intents.size).toBe(0);

    const second = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip', acknowledgeLatePromise: true }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(second.status).toBe(200);
    expect(store.intents.size).toBe(1);
  });

  it('date の希望日は形式検証のうえ payload に構造化される (照合の入力)', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db, store } = createDb({ contracts: [relContract], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const bad = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'date', requestedDate: '9/20' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(bad.status).toBe(400);
    const ok = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'date', requestedDate: '2026-09-20' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(ok.status).toBe(200);
    const row = [...store.intents.values()][0];
    expect(requestedDateFromPayload(row.payload_json)).toBe('2026-09-20');
  });

  it('§8-2: done で完了 push が送られ、応答に customerNotified が載る', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db } = createDb({ contracts: [relContract], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON, LINE_CHANNEL_ACCESS_TOKEN: 'token' };
    const accept = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'pause' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    const id = ((await accept.json()) as { data: { intent: { id: string } } }).data.intent.id;
    await app.request(`/api/admin/sub-intents/${id}/claim`, { method: 'POST' }, env);
    vi.mocked(dispatch).mockClear();
    const done = await app.request(`/api/admin/sub-intents/${id}/done`, { method: 'POST' }, env);
    expect(done.status).toBe(200);
    const doneJson = (await done.json()) as { data: { customerNotified: string } };
    expect(doneJson.data.customerNotified).toBe('notified');
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(dispatch).mock.calls[0][1];
    expect(call.category).toBe('transactional');
    expect(JSON.stringify(call.linePayload?.messages)).toContain('完了');
    // 宛先と冪等キーも固定する (呼ばれたことだけの assert は宛先取り違え変異を素通しする — 監査 MEDIUM)
    expect((call.recipient as { friend: { id: string; lineUserId: string } }).friend.id).toBe('F1');
    expect((call.recipient as { friend: { id: string; lineUserId: string } }).friend.lineUserId).toBe('U1');
    expect(call.linePayload?.retryKey).toBeTruthy();
  });

  it('§8-2: fail で失敗 push が送られる (理由本文は顧客文言に埋めない = PII 遮断)', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db } = createDb({ contracts: [relContract], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON, LINE_CHANNEL_ACCESS_TOKEN: 'token' };
    const accept = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    const id = ((await accept.json()) as { data: { intent: { id: string } } }).data.intent.id;
    await app.request(`/api/admin/sub-intents/${id}/claim`, { method: 'POST' }, env);
    vi.mocked(dispatch).mockClear();
    const fail = await app.request(
      `/api/admin/sub-intents/${id}/fail`,
      { method: 'POST', body: JSON.stringify({ reason: '山田様 090-xxxx に電話済み' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(fail.status).toBe(200);
    const failJson = (await fail.json()) as { data: { customerNotified: string } };
    expect(failJson.data.customerNotified).toBe('notified');
    const sent = JSON.stringify(vi.mocked(dispatch).mock.calls[0][1].linePayload?.messages);
    expect(sent).toContain('完了できませんでした');
    expect(sent).not.toContain('山田');
  });

  it('未連携の顧客への done は customerNotified=unlinked (電話フォローを促す)', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      shopify_customer_id: null,
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db } = createDb({ contracts: [relContract] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON, LINE_CHANNEL_ACCESS_TOKEN: 'token' };
    const accept = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'pause' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    const id = ((await accept.json()) as { data: { intent: { id: string } } }).data.intent.id;
    await app.request(`/api/admin/sub-intents/${id}/claim`, { method: 'POST' }, env);
    const done = await app.request(`/api/admin/sub-intents/${id}/done`, { method: 'POST' }, env);
    const doneJson = (await done.json()) as { data: { customerNotified: string } };
    expect(doneJson.data.customerNotified).toBe('unlinked');
  });

  it('一覧 API に promisedBy / verifyState / requestedDate が載る (スタッフ卓の可視化)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    store.intents.get(intent.id)!.verify_state = 'pending';
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request('/api/admin/sub-intents', {}, { DB: db });
    const json = (await res.json()) as {
      data: { intents: Array<{ promisedBy: string | null; verifyState: string | null }> };
    };
    expect(json.data.intents[0].promisedBy).toBe('2026-09-02T17:00:00.000+09:00');
    expect(json.data.intents[0].verifyState).toBe('pending');
  });
});

// ============================================================
// 採点ループ反映 (2026-08-07 監査 — CONFIRMED 5 件 + MEDIUM/LOW 群の回帰テスト)
// ============================================================

describe('監査反映: 約束の誠実性', () => {
  it('約束破り文言は op の terminal 規則と一致する (skip/date に「必ず完了」と言わない)', () => {
    expect(buildPromiseBrokenMessage('cancel')).toContain('お手続きは必ず完了し');
    expect(buildPromiseBrokenMessage('pause')).toContain('お手続きは必ず完了し');
    for (const op of ['skip', 'date', 'undo_of'] as const) {
      expect(buildPromiseBrokenMessage(op)).not.toContain('お手続きは必ず完了し');
      expect(buildPromiseBrokenMessage(op)).toContain('間に合わなかった場合も、必ずご連絡');
    }
  });

  it('祝日は営業日でない: 金曜 9/18 受理 → 土日 + 敬老/国民/秋分を跨ぎ 9/24 17:00 を約束', () => {
    expect(computePromisedBy(Date.parse('2026-09-18T00:00:00Z'))).toBe('2026-09-24T17:00:00.000+09:00');
    expect(isBusinessDayJst('2026-09-21')).toBe(false); // 敬老の日
    expect(isBusinessDayJst('2026-09-22')).toBe(false); // 国民の休日
    expect(isBusinessDayJst('2026-09-23')).toBe(false); // 秋分の日
    expect(isBusinessDayJst('2026-09-24')).toBe(true);
    // 祝日テーブルの各エントリが実際に効くことを 1 件ずつ固定 (テーブルは手管理 = 無検証だと腐る)
    for (const holiday of ['2026-11-03', '2026-11-23', '2026-12-29', '2027-01-01', '2027-05-05']) {
      expect(isBusinessDayJst(holiday)).toBe(false);
    }
  });

  it('受理 race: open 検査と INSERT の間に並行受理が勝っても accepted と嘘をつかない', async () => {
    // duplicate 先行返し導入で INSERT 衝突フォールバックは真の並行 race でしか通らなくなった —
    // その経路が「受理しました」(accepted) と偽らないことを race 注入で固定する (mutation M7)
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    store.hookBeforeInsert = () => {
      store.intents.set('si_race', {
        id: 'si_race',
        friend_id: 'F1',
        contract_ns: 'hb',
        contract_key: 'C1',
        target_cycle_key: 'C1:2026-09-10',
        presented_scheduled_date: '2026-09-10',
        op: 'skip',
        state: 'received',
        requested_by: 'customer',
        actor_staff_id: null,
        actor_role: null,
        payload_json: null,
        deadline_at: '2026-09-07T23:59:59.999+09:00',
        promised_by: '2026-09-02T17:00:00.000+09:00',
        claimed_at: null,
        executor: 'human',
        supersedes_intent_id: null,
        fail_reason: null,
        carryover_count: 0,
        escalated_at: null,
        stale_alerted_at: null,
        promise_alerted_at: null,
        predeadline_escalated_at: null,
        verify_state: null,
        verify_baseline_json: null,
        verified_at: null,
        created_at: toJstString(new Date(NOW_MS)),
        resolved_at: null,
      });
    };
    const res = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: NOW_MS,
    });
    expect(res.status).toBe('duplicate');
    if (res.status !== 'duplicate') return;
    expect(res.intent.id).toBe('si_race'); // 勝者の行を返す
  });

  it('既存 open intent は §4-1 の開示より先に duplicate (了承→duplicate の矛盾フローを作らない)', async () => {
    // 週末跨ぎ = 開示条件が成立する状況で、2 回目が開示でなく duplicate になることを固定する
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db } = createDb({ contracts: [tight], friends: [FRIEND] });
    const friday = Date.parse('2026-09-04T00:00:00Z');
    const first = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: friday,
      acknowledgeLatePromise: true,
    });
    expect(first.status).toBe('accepted');
    const second = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', nowMs: friday,
    });
    expect(second.status).toBe('duplicate'); // promise_after_deadline ではない
  });

  it('繰越しは promise_alerted_at を維持する (約束破り通知は 1 intent 1 回のまま)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'cancel' });
    const r1 = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(r1.promiseAlerted).toBe(1);
    const r2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(r2.carriedOver).toBe(1);
    expect(store.intents.get(intent.id)?.promise_alerted_at).not.toBeNull();
    expect(r2.promiseAlerted).toBe(0);
  });

  it('blocked は約束破り sweep の対象外 (防御的に promised_by を注入しても)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.state = 'received';
    row.promised_by = '2026-09-02T17:00:00.000+09:00';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, PROMISE_BROKEN_MS);
    expect(res.pastPromise).toBe(0);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('通知経路の friend 引きの D1 例外は failed に畳む (マーカー消費後の throw で無記録喪失しない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    await seedIntent(db, { op: 'skip' });
    store.throwOnFriendLookup = new Error('D1_ERROR: transient');
    const fetchCalls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    const res = await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/wh' },
      { lineClient: fakeLineClient(), fetchImpl },
      PROMISE_BROKEN_MS,
    );
    expect(res.promiseAlerted).toBe(1);
    expect(res.promiseUnnotified).toBe(1); // throw が sweep を壊さず「未通知」として可視化される
    expect(fetchCalls.join('')).toContain('送信に失敗');
  });
});

describe('監査反映: 検出健全性', () => {
  it('§4-3 skip 窓の境界を固定: flow は −2 から / derived は −3 から / +7 まで', () => {
    const order = (d: string) => [{ orderCount: 4, createdAt: `${d}T09:00:00.000+09:00` }];
    // flow: presented−2 (09-08) は窓内 = miss、−3 (09-07) は窓外
    expect(evaluateExecution(evalInput({ orders: order('2026-09-08') })).verdict).toBe('miss');
    expect(evaluateExecution(evalInput({ orders: order('2026-09-07') })).verdict).toBe('pending');
    // derived: −3 (09-07) まで窓内、−4 (09-06) は窓外
    const derived = {
      baseline: { ...EVAL_BASELINE, source: 'derived' },
      contract: { ...EVAL_CONTRACT, estimate_source: 'derived' },
    };
    expect(evaluateExecution(evalInput({ ...derived, orders: order('2026-09-07') })).verdict).toBe('miss');
    expect(evaluateExecution(evalInput({ ...derived, orders: order('2026-09-06') })).verdict).toBe('pending');
    // 上限: +7 (09-17) は窓内、+8 (09-18) は窓外
    expect(evaluateExecution(evalInput({ orders: order('2026-09-17') })).verdict).toBe('miss');
    expect(evaluateExecution(evalInput({ orders: order('2026-09-18') })).verdict).toBe('pending');
  });

  it('skip 累計が 2 以上進んでいる二重前進は判定保留 (HB 直接スキップに濡れ衣を着せない)', () => {
    const r = evaluateExecution(evalInput({
      contract: { ...EVAL_CONTRACT, next_billing_estimate: '2026-11-09', skip_count: 2 },
    }));
    expect(r).toEqual({ verdict: 'inconclusive', reason: 'multiple_skips_observed' });
  });

  it('注文走査が LIMIT で打ち切られた run は ok を宣言しない (嘘の ok 防止)', async () => {
    // 他契約のタグ付き注文 200 件で走査枠を使い切る (ASC = 最新の自契約分が切り捨てられる状況)
    const filler = Array.from({ length: 200 }, (_, i) => ({
      shopify_order_id: `F${i}`,
      tags: 'subscription-id:C9, subscription-count:1',
      created_at: `2026-09-02T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000+09:00`,
    }));
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND], orders: filler });
    const intent = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    silencePromise(store);
    store.contracts.get('C1')!.next_billing_estimate = '2026-10-10'; // 本来なら ok になる状況
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-26T00:00:00Z'));
    expect(res.verifyOk).toBe(0);
    expect(res.verifyInconclusive).toBe(1);
    expect(store.intents.get(intent.id)?.verify_state).toBe('inconclusive');
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled(); // 保留は顧客に何も送らない
  });

  it('date: 希望日つき受理 → 旧予定日側の課金を sweep 統合で miss 検出', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND],
      orders: [{ shopify_order_id: 'OD', tags: 'subscription-id:C1, subscription-count:4', created_at: '2026-09-10T09:00:00.000+09:00' }],
    });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'date', requestedBy: 'staff',
      payload: { requestedDate: '2026-09-20' }, nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    await claimSubIntent(db, res0.intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, res0.intent.id, STAFF, NOW_MS);
    silencePromise(store);
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-12T00:00:00Z'));
    expect(res.verifyMiss).toBe(1);
    expect(store.intents.get(res0.intent.id)?.verify_state).toBe('miss');
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
  });

  it('二重 skip (前進量 2 周期) は sweep 統合でも即 miss + 謝罪', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    silencePromise(store);
    store.contracts.get('C1')!.next_billing_estimate = '2026-11-09'; // 30日周期で 60 日前進
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, { lineClient: fakeLineClient() }, Date.parse('2026-09-12T00:00:00Z'));
    expect(res.verifyMiss).toBe(1);
    expect(vi.mocked(dispatch)).toHaveBeenCalledTimes(1);
  });

  it('done 直後の undo と pending 登録の競合は undo_of 失敗の復元で救済される', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db, { op: 'skip' });
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    // 競合の再現: done → (undo が先に cancel_requested を立てた) → setVerifyPendingCas 0 行
    store.intents.get(intent.id)!.verify_state = null;
    const undo = await undoSubIntent(db, intent.id, { staffId: 'staff-1', role: 'admin' }, { requestedBy: 'staff', nowMs: NOW_MS });
    if (undo.status !== 'undo_accepted') throw new Error('setup');
    await claimSubIntent(db, undo.undoIntent.id, STAFF, NOW_MS);
    const fail = await failSubIntent(db, undo.undoIntent.id, '取り消せず (HB 側で実行済み)', STAFF, NOW_MS);
    expect(fail.status).toBe('failed');
    if (fail.status !== 'failed') return;
    expect(fail.originalRestored).toBe(true);
    expect(store.intents.get(intent.id)?.state).toBe('done');
    expect(store.intents.get(intent.id)?.verify_state).toBe('pending'); // 検証対象に復帰
  });
});

describe('監査反映: §4-4 締切不明の cancel / done・fail の痕跡', () => {
  it('締切不明の cancel も受理から 24h でエスカレーション (漂流させない)', async () => {
    const noEstimate: ContractSeed = { ...CONTRACT, next_billing_estimate: null };
    const { db, store } = createDb({ contracts: [noEstimate], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    expect(res0.intent.deadline_at).toBeNull();

    // 受理から 1h: まだ対象外
    const early = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NOW_MS + 3600_000);
    expect(early.cancelNearDeadline).toBe(0);

    // 受理から 25h: エスカレーション (1 回)
    const fetchCalls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    const res = await sweepSubIntents(
      { DB: db, ...GATE_ON, DISCORD_WEBHOOK_URL: 'https://discord.test/wh' },
      { fetchImpl },
      NOW_MS + 25 * 3600_000,
    );
    expect(res.predeadlineEscalated).toBe(1);
    expect(fetchCalls.join('')).toContain('受付期限を確定できない');
    expect(store.intents.get(res0.intent.id)?.predeadline_escalated_at).not.toBeNull();
    const again = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, NOW_MS + 26 * 3600_000);
    expect(again.predeadlineEscalated).toBe(0);
  });

  it('done/fail の CAS 敗者は顧客に push しない (完了と言っていないものを知らせない)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON, LINE_CHANNEL_ACCESS_TOKEN: 'token' };
    const intent = await seedIntent(db); // received のまま (claim していない = CAS 敗者になる)
    vi.mocked(dispatch).mockClear();
    const done = await app.request(`/api/admin/sub-intents/${intent.id}/done`, { method: 'POST' }, env);
    expect(done.status).toBe(409);
    const fail = await app.request(
      `/api/admin/sub-intents/${intent.id}/fail`,
      { method: 'POST', body: JSON.stringify({ reason: 'x' }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(fail.status).toBe(409);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
  });

  it('done push が届かない場合は Discord と audit に残る (揮発表示だけにしない)', async () => {
    const relContract: ContractSeed = {
      ...CONTRACT,
      shopify_customer_id: null, // 未連携 → push 不能
      next_billing_estimate: toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10),
    };
    const { db, store } = createDb({ contracts: [relContract] });
    const app = buildApp(ADMIN_STAFF);
    const fetchCalls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      fetchCalls.push(String(init?.body ?? ''));
      return {} as Response;
    }) as typeof fetch;
    try {
      const env = { DB: db, ...GATE_ON, LINE_CHANNEL_ACCESS_TOKEN: 'token', DISCORD_WEBHOOK_URL: 'https://discord.test/wh' };
      const accept = await app.request(
        '/api/admin/sub-intents',
        { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'pause' }), headers: { 'Content-Type': 'application/json' } },
        env,
      );
      const id = ((await accept.json()) as { data: { intent: { id: string } } }).data.intent.id;
      await app.request(`/api/admin/sub-intents/${id}/claim`, { method: 'POST' }, env);
      const done = await app.request(`/api/admin/sub-intents/${id}/done`, { method: 'POST' }, env);
      expect(done.status).toBe(200);
      expect(fetchCalls.join('')).toContain('届けられませんでした');
      const notifyLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.done_notify');
      expect(notifyLog?.errorMessage).toBe('unlinked');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('締切超過の skip 受理は 400 (deadline_passed — 即失効する台帳行をスタッフ経由でも作らない)', async () => {
    const past: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 2 * 86_400_000)).slice(0, 10), // 締切 = 昨日
    };
    const { db, store } = createDb({ contracts: [past], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip', acknowledgeLatePromise: true }), headers: { 'Content-Type': 'application/json' } },
      { DB: db, ...GATE_ON },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('受付期限');
    expect(store.intents.size).toBe(0);
  });

  it('§4-1 了承つき受理は audit と台帳 (payload) に痕跡が残る', async () => {
    const tight: ContractSeed = {
      ...CONTRACT,
      next_billing_estimate: toJstString(new Date(Date.now() + 3 * 86_400_000)).slice(0, 10),
    };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'C1', op: 'skip', acknowledgeLatePromise: true }), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(200);
    const acceptLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.accept');
    expect(acceptLog?.metadata).toContain('acknowledgedLatePromise');
    const row = [...store.intents.values()][0];
    expect(String(row.payload_json)).toContain('latePromiseAcknowledged');
  });
});

// ============================================================
// §10-5: 受理ボタン (カード描画 + sub_intent postback ハンドラ)
// ============================================================

function makeLineClient() {
  // 引数の型を明示する — 省略すると mock.calls が長さ 0 のタプル型に推論され、
  // calls.at(-1)?.[1] (送信メッセージの取り出し) が CI の tsc で TS2493 になる
  return {
    replyMessage: vi.fn(async (_replyToken: string, _messages: unknown[]) => ({})),
    pushMessage: vi.fn(async (_to: string, _messages: unknown[]) => ({})),
  };
}

function subPostbackParams(op: string, over: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams();
  p.set('action', 'sub_intent');
  p.set('op', op);
  p.set('cid', 'C1');
  p.set('y', 'C1:2026-09-10');
  p.set('d0', '2026-09-10');
  p.set('v', SUB_INTENT_POSTBACK_VERSION);
  for (const [k, v] of Object.entries(over)) p.set(k, v);
  return p;
}

async function firePostback(
  db: D1Database,
  lineClient: ReturnType<typeof makeLineClient>,
  op: string,
  opts: {
    over?: Record<string, string>;
    pickedDate?: string;
    gateOn?: boolean;
    nowMs?: number;
    lineUserId?: string;
  } = {},
): Promise<string> {
  await handleSubIntentPostback({
    env: { DB: db, ...(opts.gateOn === false ? {} : GATE_ON) } as never,
    lineClient: lineClient as never,
    replyToken: 'rt',
    lineUserId: opts.lineUserId ?? 'U1',
    lineAccountId: null,
    params: subPostbackParams(op, opts.over ?? {}),
    postbackParams: opts.pickedDate ? { date: opts.pickedDate } : null,
    nowMs: opts.nowMs ?? NOW_MS,
  });
  return JSON.stringify(lineClient.replyMessage.mock.calls.at(-1)?.[1] ?? []);
}

describe('§10-5 カード描画 (subIntent モード)', () => {
  const asContract = CONTRACT as unknown as Parameters<typeof buildBillingReminderMessages>[0];

  it('gate OFF (既定) は従来どおり相談導線のみ — sub_intent postback を描画しない', () => {
    const s = JSON.stringify(buildBillingReminderMessages(asContract, 7));
    expect(s).toContain('teiki_guide');
    expect(s).not.toContain('sub_intent');
  });

  it('subIntent モードで受理ボタン 3 種 + §3 の結果行を描画する', () => {
    const s = JSON.stringify(buildBillingReminderMessages(asContract, 7, { subIntent: true, nowMs: NOW_MS }));
    expect(s).toContain('action=sub_intent&op=skip');
    expect(s).toContain('action=sub_intent&op=date');
    expect(s).toContain('action=sub_intent&op=cancel_pause');
    expect(s).not.toContain('teiki_guide');
    // §3-2: 表示日付は estimate + interval の**計算値**なので flow でも断定しない
    // (「ごろ」除去は executor='own_billing' まで保留 — 採点 CONFIRMED 系列)
    expect(s).toContain('押すと 次回は 10月10日ごろ に変わるお申し込みになります');
    // §2: 日付変更は datetimepicker で選択とタップを畳む
    expect(s).toContain('datetimepicker');
    // §10-5 lead: カードで完結することを言う
    expect(s).toContain('そのままお手続きいただけます');
  });

  it('§3-3: postback は y/d0/v を運び、y は buildCycleKey と同形式 (循環回避の複製の同一性を固定)', () => {
    const data = subIntentPostbackData('skip', asContract, undefined, NOW_MS);
    const p = new URLSearchParams(data);
    expect(p.get('y')).toBe(buildCycleKey('C1', '2026-09-10'));
    expect(p.get('d0')).toBe('2026-09-10');
    expect(p.get('v')).toBe(SUB_INTENT_POSTBACK_VERSION);
  });

  it('stale (過去日) 推定は d0 に載せず y=unknown に畳む (画面に無い日付を受理系が運ばない)', () => {
    const stale = { ...CONTRACT, next_billing_estimate: '2026-08-20' } as unknown as Parameters<
      typeof buildBillingReminderMessages
    >[0];
    const p = new URLSearchParams(subIntentPostbackData('skip', stale, undefined, NOW_MS));
    expect(p.get('d0')).toBeNull();
    expect(p.get('y')).toBe('C1:unknown');
  });

  it('§3-1: 受理ボタンのラベルは全角 8 字以内 / §7: 実行ボタンは #0f766e・height md', () => {
    const msgs = buildBillingReminderMessages(asContract, 7, {
      subIntent: true,
      nowMs: NOW_MS,
    }) as unknown as Array<{
      contents?: { body?: { contents?: Array<Record<string, unknown>> } };
    }>;
    const body = msgs[1]?.contents?.body?.contents ?? [];
    const buttons = body.filter((c) => c.type === 'button') as Array<{
      style: string;
      color?: string;
      height?: string;
      action: { type: string; label: string; data?: string };
    }>;
    const acceptButtons = buttons.filter((b) => String(b.action.data ?? '').includes('sub_intent'));
    expect(acceptButtons.length).toBe(3);
    for (const b of acceptButtons) {
      expect(b.action.label.length).toBeLessThanOrEqual(8);
      expect(b.height).toBe('md');
    }
    const primary = acceptButtons.filter((b) => b.style === 'primary');
    for (const b of primary) expect(b.color).toBe('#0f766e'); // §7-1: 白文字 4.5:1 以上
  });

  it('derived 契約の結果行も「ごろ」を付ける (§3-2 断定禁止)', () => {
    const derived = { ...CONTRACT, estimate_source: 'derived' } as unknown as Parameters<
      typeof buildBillingReminderMessages
    >[0];
    const s = JSON.stringify(buildBillingReminderMessages(derived, 7, { subIntent: true, nowMs: NOW_MS }));
    expect(s).toContain('10月10日ごろ に変わるお申し込み');
  });

  it('§7-1: 確認カードの解約ボタンは白文字 4.5:1 未満の #d9573d を使わない (採点 CONFIRMED)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    void store;
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'cancel_pause');
    expect(reply).toContain('#9a3412'); // header 代替と同じ濃色 (7.31:1)
    expect(reply).not.toContain('"color":"#d9573d"');
  });
});

describe('§10-5 sub_intent postback ハンドラ', () => {
  it('gate OFF は DB 非接触で準備中を返す (ロールバック時の履歴ボタンを死なせない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'skip', { gateOn: false });
    expect(reply).toContain('準備中');
    expect(store.queryCount).toBe(0);
  });

  it('skip 受理: reply で「承りました」+ 反映予定 + [取り消す] (§8-2 push しない・§1 完了と言わない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'skip');
    expect(reply).toContain('承りました');
    expect(reply).toContain('9月2日 17:00 までに反映予定');
    expect(reply).toContain('取り消す');
    expect(reply).toContain('スタッフの着手前まで');
    expect(reply).not.toContain('完了しました。'); // 受理を完了と言わない
    expect(lc.pushMessage).not.toHaveBeenCalled(); // §8-2: 受理は reply
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
    const row = [...store.intents.values()][0];
    expect(row.op).toBe('skip');
    expect(row.requested_by).toBe('customer');
    expect(row.state).toBe('received');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.postback')).toBe(true);
  });

  it('二重タップは duplicate: 台帳 1 行のまま「既に承っております」', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    await firePostback(db, lc, 'skip');
    const reply = await firePostback(db, lc, 'skip');
    expect(reply).toContain('既に承っております');
    expect(store.intents.size).toBe(1);
  });

  it('§3-3: y (サイクル識別子) 不一致は受理せず最新カードへ (推定変化後の古い吹き出し)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'skip', { over: { d0: '2026-09-03', y: 'C1:2026-09-03' } });
    expect(reply).toContain('ご契約の状況が変わっています');
    expect(store.intents.size).toBe(0); // INSERT していない
  });

  it('§3-3: y=unknown の古いカード (推定不明期に配布) は推定確定後に受理されない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    // 推定不明時のカードは d0 なし・y=unknown で配られる — 今は推定 09-10 が付いている
    const p = subPostbackParams('skip', { y: 'C1:unknown' });
    p.delete('d0');
    await handleSubIntentPostback({
      env: { DB: db, ...GATE_ON } as never,
      lineClient: lc as never,
      replyToken: 'rt',
      lineUserId: 'U1',
      lineAccountId: null,
      params: p,
      postbackParams: null,
      nowMs: NOW_MS,
    });
    const reply = JSON.stringify(lc.replyMessage.mock.calls.at(-1)?.[1] ?? []);
    expect(reply).toContain('ご契約の状況が変わっています');
    expect(store.intents.size).toBe(0);
  });

  it('§3-3 cycle_drift (第二防壁): y が一致しても d0 が現在とズレた細工 postback は受理しない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'skip', { over: { d0: '2026-09-03' } }); // y は現在と一致のまま
    expect(reply).toContain('ご予定が更新されています');
    expect(reply).toContain('9月10日'); // 最新の予定日を提示
    expect(store.intents.size).toBe(0);
  });

  it('締切超過の skip は受理しない (「承りました」の数分後に expire させない — 採点 CONFIRMED)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    // 09-08 = 締切 (09-07 EOD) 超過・推定 09-10 はまだ stale でない
    const reply = await firePostback(db, lc, 'skip', { nowMs: AFTER_DEADLINE_MS });
    expect(reply).toContain('受付期限');
    expect(reply).toContain('過ぎているため');
    expect(store.intents.size).toBe(0);
    // ack を付けても受理しない (開示は「見込み」への同意であって確実な失効への同意ではない)
    const ackReply = await firePostback(db, lc, 'skip', { over: { ack: '1' }, nowMs: AFTER_DEADLINE_MS });
    expect(ackReply).toContain('過ぎているため');
    expect(store.intents.size).toBe(0);
  });

  it('締切超過でも pause/cancel は受理する (§1-2 繰越しが救済する)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'cancel', { nowMs: AFTER_DEADLINE_MS });
    expect(reply).toContain('承りました');
    expect(store.intents.size).toBe(1);
  });

  it('§3-3 スキーマ版違い (v) は受理せず期限切れ + 最新カード', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'skip', { over: { v: '0' } });
    expect(reply).toContain('期限切れ');
    expect(store.intents.size).toBe(0);
  });

  it('IDOR: 他人の契約 cid は存在を漏らさずメニューへフォールバック', async () => {
    const other: ContractSeed = { ...CONTRACT, contract_id: 'C2', shopify_customer_id: 'OTHER' };
    const { db, store } = createDb({ contracts: [CONTRACT, other], friends: [FRIEND] });
    const lc = makeLineClient();
    // 攻撃者視点: y/d0 は改ざん可能なので**他人の契約に一致する値**を細工できる。
    // 所有者検証が唯一の壁 (y 突合は偽装可能 = IDOR の代替にならない — mutation Q5 の教訓)
    const reply = await firePostback(db, lc, 'skip', {
      over: { cid: 'C2', y: 'C2:2026-09-10', d0: '2026-09-10' },
    });
    expect(store.intents.size).toBe(0);
    expect(reply).not.toContain('C2'); // 契約の存在を漏らさない
  });

  it('解約済み契約への古いボタンは受理せず最新状態を見せる', async () => {
    const inactive: ContractSeed = { ...CONTRACT, cancelled_at: '2026-08-31' };
    const { db, store } = createDb({ contracts: [inactive], friends: [FRIEND] });
    const lc = makeLineClient();
    await firePostback(db, lc, 'skip');
    expect(store.intents.size).toBe(0);
  });

  it('date: datetimepicker の希望日を構造化して受理 (§4-3 の照合入力)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'date', { pickedDate: '2026-09-20' });
    expect(reply).toContain('9月20日');
    expect(reply).toContain('承りました');
    const row = [...store.intents.values()][0];
    expect(requestedDateFromPayload(row.payload_json)).toBe('2026-09-20');
  });

  it('date: 希望日が届かなければ受理しない (形式不正も含む)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'date');
    expect(reply).toContain('もう一度');
    expect(store.intents.size).toBe(0);
  });

  it('date: 過去日はサーバ側でも弾く (picker の min は描画時の防壁でしかない — 採点 MEDIUM)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'date', { pickedDate: '2026-08-30' });
    expect(reply).toContain('過去のお日にち');
    expect(store.intents.size).toBe(0);
  });

  it('date の duplicate は既存の希望日を開示し、新しく選んだ日付が未登録であることを言う (採点 CONFIRMED)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    await firePostback(db, lc, 'date', { pickedDate: '2026-09-20' });
    const reply = await firePostback(db, lc, 'date', { pickedDate: '2026-09-25' });
    expect(reply).toContain('9月20日 への変更で既に承っております');
    expect(reply).toContain('9月25日 はまだ登録されていません');
    expect(reply).toContain('取り消す');
    expect(store.intents.size).toBe(1);
  });

  it('一時停止中: skip/date は理由を言って受理せず、cancel は受理する (解約妨害を作らない)', async () => {
    const paused: ContractSeed = { ...CONTRACT, paused_at: '2026-08-20' };
    const { db, store } = createDb({ contracts: [paused], friends: [FRIEND] });
    const lc = makeLineClient();
    const skipReply = await firePostback(db, lc, 'skip');
    expect(skipReply).toContain('一時停止中のため');
    expect(store.intents.size).toBe(0);
    const choiceReply = await firePostback(db, lc, 'cancel_pause');
    expect(choiceReply).not.toContain('一時停止する'); // 停止中に意味のないボタンを出さない
    expect(choiceReply).toContain('解約を申し込む');
    const cancelReply = await firePostback(db, lc, 'cancel');
    expect(cancelReply).toContain('承りました');
    expect(store.intents.size).toBe(1);
  });

  it('§4-1 開示を経た顧客受理は payload に latePromiseAcknowledged が残る (admin 経路と同じ規律)', async () => {
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const lc = makeLineClient();
    const friday = Date.parse('2026-09-04T00:00:00Z');
    await firePostback(db, lc, 'skip', {
      over: { d0: '2026-09-08', y: 'C1:2026-09-08', ack: '1' },
      nowMs: friday,
    });
    const row = [...store.intents.values()][0];
    expect(String(row.payload_json)).toContain('latePromiseAcknowledged');
  });

  it('cancel_pause は確認カード (2 タップ目で受理・解約導線は隠さない §7-3)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'cancel_pause');
    expect(reply).toContain('一時停止する');
    expect(reply).toContain('解約を申し込む');
    expect(reply).toContain('今はやめておく');
    expect(store.intents.size).toBe(0); // 1 タップ目では受理しない

    const cancelReply = await firePostback(db, lc, 'cancel');
    expect(cancelReply).toContain('承りました');
    expect(cancelReply).toContain('返金'); // §4-4 救済手順が受理文言に入る
    expect([...store.intents.values()][0].op).toBe('cancel');
  });

  it('§4-1 開示: 間に合わない見込みは受理せず 2 タップ化。ack=1 で受理される', async () => {
    // 推定 09-08 → 締切 09-05 EOD。金曜受理の約束は月曜 17:00 = 締切超過
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-09-08' };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const lc = makeLineClient();
    const friday = Date.parse('2026-09-04T00:00:00Z');
    const reply = await firePostback(db, lc, 'skip', {
      over: { d0: '2026-09-08', y: 'C1:2026-09-08' },
      nowMs: friday,
    });
    expect(reply).toContain('間に合わない見込み');
    expect(reply).toContain('お願いする');
    expect(store.intents.size).toBe(0);

    const ackReply = await firePostback(db, lc, 'skip', {
      over: { d0: '2026-09-08', y: 'C1:2026-09-08', ack: '1' },
      nowMs: friday,
    });
    expect(ackReply).toContain('承りました');
    expect(store.intents.size).toBe(1);
  });

  it('undo: 受理直後の取り消しは 1 タップで cancelled (§3-4)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    await firePostback(db, lc, 'skip');
    const id = [...store.intents.values()][0].id;
    const reply = await firePostback(db, lc, 'undo', { over: { id } });
    expect(reply).toContain('取り消しました');
    expect(store.intents.get(id)?.state).toBe('cancelled');
  });

  it('undo IDOR: 他人の intent id は存在を漏らさず・状態を変えない', async () => {
    const { db, store } = createDb({
      contracts: [CONTRACT],
      friends: [FRIEND, { id: 'F2', line_user_id: 'U2', shopify_customer_id: null }],
    });
    const lc = makeLineClient();
    await firePostback(db, lc, 'skip');
    const id = [...store.intents.values()][0].id;
    const reply = await firePostback(db, lc, 'undo', { over: { id }, lineUserId: 'U2' });
    expect(reply).toContain('見つかりませんでした');
    expect(store.intents.get(id)?.state).toBe('received');
  });

  it('undo: スタッフ着手後は「承りました」止まり (取り消せたと言わない §1-3)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    await firePostback(db, lc, 'skip');
    const id = [...store.intents.values()][0].id;
    await claimSubIntent(db, id, STAFF, NOW_MS);
    const reply = await firePostback(db, lc, 'undo', { over: { id } });
    expect(reply).toContain('取り消しのご依頼を承りました');
    expect(reply).not.toContain('取り消しました。');
    expect(store.intents.get(id)?.state).toBe('executing'); // 元 intent は動かさない
  });

  it('dismiss は受理せず穏当に閉じる', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const lc = makeLineClient();
    const reply = await firePostback(db, lc, 'dismiss');
    expect(reply).toContain('承知しました');
    expect(store.intents.size).toBe(0);
  });
});
