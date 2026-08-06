/**
 * sub_intents 受理レイヤーのテスト (§10-3、 2026-08-06)
 *
 * 検証対象 (= 顧客の意思を預かる台帳 — 誤遷移は「勝手に解約」「勝手に失効」になる):
 *   - 受理 (§1-1): partial UNIQUE の効き (二重タップ冪等) / cycle_drift 拒否 / deferred (移行窓)
 *   - state 機械 (§1-2): 全 CAS の勝敗 / claim の締切述語 (expire と相互排他) /
 *     pause・cancel は expire させず同一行繰越し / human claim は自動解放しない
 *   - undo (§1-3): received|deferred は直接 CAS、executing|done は undo_of intent
 *   - sweep (§4-2): 正直な失敗通知 / エスカレーション 1 intent 1 回 / 繰越しの無限ループなし /
 *     executor='blocked' 除外 / gate OFF は DB 非アクセス
 *   - /admin/ops API: requireRole / env-owner 拒否 / gate OFF 400 / 監査記録
 *
 * 実 D1 の CAS/partial UNIQUE 意味論を忠実に再現する in-memory fake を使う
 * (= sub-link.test.ts と同型。UNIQUE 違反は throw、CAS は述語評価して changes を返す)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

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
  computeDeadlineAt,
  isSubIntentEnabled,
  SUB_INTENT_OP_LABELS,
  MACHINE_CLAIM_RELEASE_MINUTES,
} from '../services/sub-intents.js';
import { adminOps } from '../routes/admin-ops.js';
import { authMiddleware } from '../middleware/auth.js';
import { toJstString } from '@line-crm/db';
import type { SubIntentRow } from '@line-crm/db';

// ============================================================
// in-memory D1 fake (= CAS/partial UNIQUE を忠実に enforce)
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
  auditLogs: Array<{ action: string; targetId: string | null; metadata: string }>;
  cronLogs: Array<{ jobName: string; status: string; metrics: Record<string, unknown> }>;
  queryCount: number;
}

const OPEN = new Set(['received', 'executing', 'deferred']);

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

  function norm(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
  }

  function exec(sqlRaw: string, args: unknown[], mode: 'first' | 'all' | 'run'): unknown {
    store.queryCount += 1;
    const sql = norm(sqlRaw);
    const a = args as (string | number | null)[];

    // ---- sub_intents ----
    if (sql.startsWith('INSERT INTO sub_intents')) {
      if (!sql.includes('ON CONFLICT DO NOTHING')) throw new Error('expected ON CONFLICT DO NOTHING');
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
        created_at: createdAt as string,
        resolved_at: null,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith('SELECT * FROM sub_intents WHERE id = ?')) {
      return store.intents.get(a[0] as string) ?? null;
    }

    if (sql.startsWith('SELECT * FROM sub_intents WHERE contract_ns = ?')) {
      const [ns, key, cycle, op] = a as string[];
      for (const row of store.intents.values()) {
        if (
          row.contract_ns === ns && row.contract_key === key &&
          row.target_cycle_key === cycle && row.op === op && OPEN.has(row.state)
        ) return row;
      }
      return null;
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'executing'")) {
      const withDeadline = sql.includes('deadline_at IS NULL OR deadline_at >');
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
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'done', resolved_at = ?")) {
      const [now, staffId, role, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'executing') return { meta: { changes: 0 } };
      row.state = 'done';
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'failed'")) {
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

    if (sql.startsWith("UPDATE sub_intents SET state = 'received', claimed_at = NULL")) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'executing') return { meta: { changes: 0 } };
      row.state = 'received';
      row.claimed_at = null;
      row.actor_staff_id = null;
      row.actor_role = null;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'cancelled', resolved_at = ?, actor_staff_id")) {
      const [now, staffId, role, id] = a as (string | null)[];
      const row = store.intents.get(id as string);
      if (!row || !(row.state === 'received' || row.state === 'deferred')) return { meta: { changes: 0 } };
      row.state = 'cancelled';
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'cancel_requested'")) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'done') return { meta: { changes: 0 } };
      row.state = 'cancel_requested';
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'cancelled', resolved_at = ? WHERE id = ? AND state IN ('cancel_requested','done')")) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || !(row.state === 'cancel_requested' || row.state === 'done')) return { meta: { changes: 0 } };
      row.state = 'cancelled';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'done' WHERE id = ? AND state = 'cancel_requested'")) {
      const [id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'cancel_requested') return { meta: { changes: 0 } };
      row.state = 'done';
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'expired'")) {
      const [now, id, nowCmp] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      if (!(row.deadline_at !== null && row.deadline_at < nowCmp)) return { meta: { changes: 0 } };
      row.state = 'expired';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith('UPDATE sub_intents SET target_cycle_key = ?')) {
      const [newCycle, newDeadline, id] = a as (string | null)[];
      const row = store.intents.get(id as string);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      // partial UNIQUE: 繰越し先に別の open intent がいたら throw (実 D1 と同じ)
      if (hasOpenConflict(store, row.contract_ns, row.contract_key, newCycle as string, row.op, row.id)) {
        throw new Error('UNIQUE constraint failed: sub_intents');
      }
      row.target_cycle_key = newCycle as string;
      row.deadline_at = newDeadline;
      row.carryover_count += 1;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE sub_intents SET state = 'superseded'")) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.state !== 'received') return { meta: { changes: 0 } };
      row.state = 'superseded';
      row.resolved_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith('UPDATE sub_intents SET escalated_at = ?')) {
      const [now, id] = a as string[];
      const row = store.intents.get(id);
      if (!row || row.escalated_at !== null) return { meta: { changes: 0 } };
      row.escalated_at = now;
      return { meta: { changes: 1 } };
    }

    if (sql.startsWith("SELECT * FROM sub_intents WHERE state = 'received' AND executor <> 'blocked'")) {
      const [now] = a as string[];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'received' && r.executor !== 'blocked' && r.deadline_at !== null && r.deadline_at < now)
        .sort((x, y) => (x.deadline_at! < y.deadline_at! ? -1 : 1));
      return { results: rows };
    }

    if (sql.startsWith("SELECT * FROM sub_intents WHERE state = 'executing' AND claimed_at IS NOT NULL")) {
      const [before] = a as string[];
      const rows = [...store.intents.values()]
        .filter((r) => r.state === 'executing' && r.claimed_at !== null && r.claimed_at < before)
        .sort((x, y) => (x.claimed_at! < y.claimed_at! ? -1 : 1));
      return { results: rows };
    }

    if (sql.startsWith('SELECT * FROM sub_intents ORDER BY')) {
      const order: Record<string, number> = { executing: 0, received: 1, cancel_requested: 2, deferred: 3 };
      const rows = [...store.intents.values()].sort((x, y) => {
        const ox = order[x.state] ?? 4;
        const oy = order[y.state] ?? 4;
        if (ox !== oy) return ox - oy;
        return x.created_at < y.created_at ? 1 : -1;
      });
      return { results: rows };
    }

    if (sql.startsWith('SELECT SUM(CASE WHEN state =')) {
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

    // ---- 参照テーブル ----
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

    throw new Error(`fake D1: unhandled SQL (${mode}): ${sql.slice(0, 120)}`);
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
        // bind なし (引数ゼロの SQL は本層に無いが、防御)
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
    const undo = await undoSubIntent(db, first.intent.id, { staffId: null, role: null }, NOW_MS);
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
});

// ============================================================
// undo (§1-3)
// ============================================================

describe('undoSubIntent (§1-3)', () => {
  it('received は直接 cancelled (CAS 勝者のみ)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
    expect(res.status).toBe('cancelled');
  });

  it('executing は undo_of intent の受理に化ける (「承りました」止まり)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
    expect(res.status).toBe('undo_accepted');
    if (res.status !== 'undo_accepted') return;
    expect(res.undoIntent.op).toBe('undo_of');
    expect(res.undoIntent.supersedes_intent_id).toBe(intent.id);
    // 元 intent は executing のまま (claim 意味論を壊さない)
    expect(store.intents.get(intent.id)?.state).toBe('executing');
  });

  it('executing への二重 undo は冪等 (undo_of は 1 行だけ)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const a = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
    const b = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS + 1000);
    expect(a.status).toBe('undo_accepted');
    expect(b.status).toBe('undo_accepted');
    if (a.status !== 'undo_accepted' || b.status !== 'undo_accepted') return;
    expect(b.undoIntent.id).toBe(a.undoIntent.id);
    const undoRows = [...store.intents.values()].filter((r) => r.op === 'undo_of');
    expect(undoRows.length).toBe(1);
  });

  it('done は cancel_requested に立ち、undo_of の完了で cancelled / 失敗で done に戻る', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    await completeSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
    expect(res.status).toBe('undo_accepted');
    if (res.status !== 'undo_accepted') return;
    expect(store.intents.get(intent.id)?.state).toBe('cancel_requested');
    // undo_of を実行 → 完了 = 元 intent は cancelled
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
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
    if (res.status !== 'undo_accepted') throw new Error('setup');
    await claimSubIntent(db, res.undoIntent.id, STAFF, NOW_MS);
    const failed = await failSubIntent(db, res.undoIntent.id, '既に発送済み', STAFF, NOW_MS);
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.originalRestored).toBe(true);
    expect(store.intents.get(intent.id)?.state).toBe('done');
  });

  it('expired からは取り消せない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const intent = await seedIntent(db);
    store.intents.get(intent.id)!.state = 'expired';
    const res = await undoSubIntent(db, intent.id, { staffId: null, role: null }, NOW_MS);
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

  it('skip の締切超過 → expired + 正直な失敗通知 (連携済み) + cron log', async () => {
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
    // 監査も残る (§4 全遷移)
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

  it('pause の締切超過 → expire せず同一行を次サイクルへ繰越し + エスカレーション (§1-2)', async () => {
    // 繰越し先 = read-model の現在推定 (10-10 に進んでいる想定)
    const moved: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-10-10' };
    const { db, store } = createDb({ contracts: [moved], friends: [FRIEND] });
    // 受理は推定が 09-10 だった時点の想定 → 手で 09-10 サイクルの行を作る
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
    expect(after.deadline_at).toBe('2026-10-07T23:59:59.999+09:00');
    expect(after.carryover_count).toBe(1);

    // 2 回目の sweep で再ヒットしない (無限エスカレーションを防ぐ §1-2)
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res2.pastDeadline).toBe(0);
    expect(res2.escalated).toBe(0);
  });

  it('繰越し先に別 open intent がいたら superseded (新しい意思が優先)', async () => {
    const moved: ContractSeed = { ...CONTRACT, next_billing_estimate: '2026-10-10' };
    const { db, store } = createDb({ contracts: [moved], friends: [FRIEND] });
    // 旧サイクルの pause (締切超過)
    const old = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', presentedDate: '2026-10-10', nowMs: NOW_MS });
    if (old.status !== 'accepted') throw new Error('setup');
    const oldRow = store.intents.get(old.intent.id)!;
    oldRow.target_cycle_key = 'C1:2026-09-10';
    oldRow.presented_scheduled_date = '2026-09-10';
    oldRow.deadline_at = '2026-09-07T23:59:59.999+09:00';
    // 新サイクルには既に新しい pause 意思がある
    const fresh = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'pause', requestedBy: 'customer', nowMs: NOW_MS });
    if (fresh.status !== 'accepted') throw new Error('setup2');

    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.superseded).toBe(1);
    expect(store.intents.get(old.intent.id)?.state).toBe('superseded');
    expect(store.intents.get(fresh.intent.id)?.state).toBe('received');
  });

  it('繰越し先を算出できない場合は締切なしで保持 (意思を expire させない)', async () => {
    const dead: ContractSeed = { ...CONTRACT, next_billing_estimate: null, interval_days: null };
    const { db, store } = createDb({ contracts: [dead], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer', nowMs: NOW_MS });
    if (res0.status !== 'accepted') throw new Error('setup');
    const row = store.intents.get(res0.intent.id)!;
    row.target_cycle_key = 'C1:2026-09-10';
    row.presented_scheduled_date = '2026-09-10';
    row.deadline_at = '2026-09-07T23:59:59.999+09:00';

    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.carryUnanchored).toBe(1);
    const after = store.intents.get(res0.intent.id)!;
    expect(after.state).toBe('received');
    expect(after.deadline_at).toBeNull();
    // 再ヒットしない
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res2.pastDeadline).toBe(0);
  });

  it('executor=blocked (移行窓) は sweep 対象外 (解約意思が消えない §4-2)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const res0 = await acceptSubIntent(db, {
      contractNs: 'hb', contractKey: 'C1', op: 'cancel', requestedBy: 'customer',
      executor: 'blocked', nowMs: NOW_MS,
    });
    if (res0.status !== 'accepted') throw new Error('setup');
    // deferred だが防御として deadline も過去に置く
    store.intents.get(res0.intent.id)!.deadline_at = '2026-09-07T23:59:59.999+09:00';
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, AFTER_DEADLINE_MS);
    expect(res.pastDeadline).toBe(0);
    expect(store.intents.get(res0.intent.id)?.state).toBe('deferred');
  });

  it('received でも executor=blocked は sweep 対象外 (§4-2 の述語第二項。§5-4 再アンカー期の防御)', async () => {
    // deferred → received の再アンカー遷移 (§5-4) が入ると received × blocked が実在しうる。
    // 述語の executor <> 'blocked' が落ちると移行窓の解約意思が expired で消える (§4-2 が明記する事故)。
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

  it('機械 executor の 30 分超 claim は自動解放 / human は解放せずアラート 1 回のみ (§1-2)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const humanIntent = await seedIntent(db, { op: 'pause' });
    await claimSubIntent(db, humanIntent.id, STAFF, NOW_MS);
    const machine = await acceptSubIntent(db, { contractNs: 'hb', contractKey: 'C1', op: 'skip', requestedBy: 'customer', executor: 'own_billing', nowMs: NOW_MS });
    if (machine.status !== 'accepted') throw new Error('setup');
    // 機械行を executing に (claim は state 機械上 human と同経路)
    const mRow = store.intents.get(machine.intent.id)!;
    mRow.state = 'executing';
    mRow.claimed_at = toJstString(new Date(NOW_MS));

    const later = NOW_MS + (MACHINE_CLAIM_RELEASE_MINUTES + 10) * 60_000;
    const res = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, later);
    expect(res.releasedMachineClaims).toBe(1);
    expect(res.staleHumanClaims).toBe(1);
    expect(store.intents.get(machine.intent.id)?.state).toBe('received');
    expect(store.intents.get(humanIntent.id)?.state).toBe('executing'); // 解放されない

    // 2 回目はアラートを繰り返さない (1 intent 1 回)
    const res2 = await sweepSubIntents({ DB: db, ...GATE_ON }, {}, later + 60_000);
    expect(res2.staleHumanClaims).toBe(1); // 件数としては見える (可視化)
    expect(res2.escalated).toBe(0); // 通知は増えない
  });
});

// ============================================================
// /admin/ops API (認可・gate・監査)
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

  it('受理 → 着手 → 完了のフルフロー (HTTP 経由) + 監査記録', async () => {
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
    // 監査 metadata に PII を入れない (contractKey と op のみ)
    const acceptLog = store.auditLogs.find((l) => l.action === 'admin.sub_intent.accept');
    expect(acceptLog?.metadata).not.toContain('9月分から');
  });

  it('done の CAS 敗者は 409 + suspectDoubleExecution (完了と言わない §1-2)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const intent = await seedIntent(db);
    // claim せず直接 done → CAS 0
    const res = await app.request(`/api/admin/sub-intents/${intent.id}/done`, { method: 'POST' }, env);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { suspectDoubleExecution?: boolean };
    expect(json.suspectDoubleExecution).toBe(true);
  });

  it('fail は理由必須 (400)', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp(ADMIN_STAFF);
    const env = { DB: db, ...GATE_ON };
    const intent = await seedIntent(db);
    await claimSubIntent(db, intent.id, STAFF, NOW_MS);
    const res = await app.request(
      `/api/admin/sub-intents/${intent.id}/fail`,
      { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('存在しない契約の受理は 404', async () => {
    const { db } = createDb();
    const app = buildApp(ADMIN_STAFF);
    const res = await app.request(
      '/api/admin/sub-intents',
      { method: 'POST', body: JSON.stringify({ contractKey: 'NOPE', op: 'skip' }), headers: { 'Content-Type': 'application/json' } },
      { DB: db, ...GATE_ON },
    );
    expect(res.status).toBe(404);
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
  it('buildCycleKey は日付なしを unknown に畳む', () => {
    expect(buildCycleKey('C1', '2026-09-10')).toBe('C1:2026-09-10');
    expect(buildCycleKey('C1', null)).toBe('C1:unknown');
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
