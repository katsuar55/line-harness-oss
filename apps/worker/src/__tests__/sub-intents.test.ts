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
  SUB_INTENT_OP_LABELS,
  MACHINE_CLAIM_RELEASE_MINUTES,
} from '../services/sub-intents.js';
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
}

interface FriendSeed {
  id: string;
  line_user_id: string | null;
  shopify_customer_id: string | null;
}

interface Store {
  intents: Map<string, SubIntentRow>;
  contracts: Map<string, ContractSeed>;
  friends: Map<string, FriendSeed>;
  auditLogs: Array<{ action: string; targetId: string | null; metadata: string; errorMessage: string | null }>;
  cronLogs: Array<{ jobName: string; status: string; metrics: Record<string, unknown> }>;
  queryCount: number;
  /** expire CAS 敗者の再現: listPastDeadline の直後に呼ばれる (行を並行遷移させる) */
  hookAfterListPastDeadline?: (rows: SubIntentRow[]) => void;
  /** carry-over の非 UNIQUE 例外注入 (D1 transient エラーの再現) */
  throwOnCarryOver?: Error;
  /** migration 076 未適用の再現: 一覧/stats が no such table を投げる */
  throwNoSuchTable?: boolean;
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
     fail_reason, carryover_count, escalated_at, stale_alerted_at, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0, NULL, NULL, ?, NULL)
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
    SET target_cycle_key = ?, deadline_at = ?, presented_scheduled_date = ?, carryover_count = carryover_count + 1
    WHERE id = ? AND state = 'received'`),
  supersede: norm(`UPDATE sub_intents SET state = 'superseded', resolved_at = ?
    WHERE id = ? AND state = 'received'`),
  markEscalated: norm(`UPDATE sub_intents SET escalated_at = ?
    WHERE id = ? AND escalated_at IS NULL AND state IN ('received','executing')`),
  markStaleAlerted: norm(`UPDATE sub_intents SET stale_alerted_at = ?
    WHERE id = ? AND stale_alerted_at IS NULL AND state = 'executing'`),
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

function createDb(seed: { contracts?: ContractSeed[]; friends?: FriendSeed[] } = {}): {
  db: D1Database;
  store: Store;
} {
  const store: Store = {
    intents: new Map(),
    contracts: new Map((seed.contracts ?? []).map((c) => [c.contract_id, c])),
    friends: new Map((seed.friends ?? []).map((f) => [f.id, f])),
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
      const [id, friendId, ns, key, cycle, presented, op, state, requestedBy, staffId, role, payload, deadline, executor, supersedes, createdAt] = a as (string | null)[];
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
        promised_by: null,
        claimed_at: null,
        executor: executor as SubIntentRow['executor'],
        supersedes_intent_id: supersedes,
        fail_reason: null,
        carryover_count: 0,
        escalated_at: null,
        stale_alerted_at: null,
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

    if (sql === SQL.listPastDeadline) {
      const [now] = a as string[];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'received' && r.executor !== 'blocked' && r.deadline_at !== null && r.deadline_at < now)
        .sort((x, y) => (x.deadline_at! < y.deadline_at! ? -1 : 1));
      store.hookAfterListPastDeadline?.(rows);
      return { results: rows };
    }

    if (sql === SQL.listStaleClaims) {
      const [before] = a as string[];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'executing' && r.claimed_at !== null && r.claimed_at < before)
        .sort((x, y) => (x.claimed_at! < y.claimed_at! ? -1 : 1));
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
    if (sql.startsWith('SELECT * FROM friends WHERE shopify_customer_id = ?')) {
      for (const f of store.friends.values()) {
        if (f.shopify_customer_id === a[0]) return f;
      }
      return null;
    }
    if (sql.startsWith('SELECT id, line_user_id FROM friends WHERE id = ?')) {
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
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
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
