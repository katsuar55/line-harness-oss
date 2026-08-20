/**
 * サブスク LIFF API のテスト (Ultraplan PR-4、2026-08-20)
 *
 * 検証対象 (= 顧客の意思を預かる公開 API — 誤動作は「勝手に解約」「他人の契約の窃視」になる):
 *   - gate: SUBSCRIPTION_MENU_ENABLED OFF は GET enabled:false / POST 409 (DB 非接触)
 *   - IDOR: 他人の契約/intent は **404 (存在を漏らさない)** + 台帳に触れない
 *   - §3-3: cycleKey 不一致は 409 cycle_changed で受理しない
 *   - §4-1: late promise は 409 開示 → ack 再送で受理 (痕跡 latePromiseAcknowledged)
 *   - 通知: accepted のときだけスタッフ通知が鳴る。duplicate では**絶対に鳴らない**
 *
 * 測定器の設計 (sub-intents.test.ts と同じ規律):
 *   fake D1 は sub_intents への SQL を**正規化した全文一致 (WHERE 込み)** で照合する。
 *   知らない SQL は throw で即発覚。sqlLog に全実行 SQL を残し、IDOR/未連携テストの観測点は
 *   「ストレージ (INSERT / 契約 SELECT) に触れていないこと」に置く (ステータスだけ見ない)。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { liffSubContracts } from '../routes/liff-sub-contracts.js';
import { toJstString, SUB_INTENT_OPEN_STATES } from '@line-crm/db';
import type { SubIntentRow } from '@line-crm/db';

// ============================================================
// in-memory D1 fake — sub_intents は SQL 全文一致 (WHERE 込み) で照合
// ============================================================

interface ContractSeed {
  contract_id: string;
  shopify_customer_id: string | null;
  plan_name: string | null;
  next_billing_estimate: string | null;
  estimate_source: string;
  interval_days: number | null;
  order_count: number | null;
  skip_count: number;
  cancelled_at: string | null;
  paused_at: string | null;
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
  /** 実行された SQL (正規化済み) の全記録 — 「ストレージに触れていない」観測点 */
  sqlLog: string[];
  queryCount: number;
}

const OPEN = new Set<string>(SUB_INTENT_OPEN_STATES);

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
  undo: norm(`UPDATE sub_intents
    SET state = 'cancelled', resolved_at = ?, actor_staff_id = ?, actor_role = ?
    WHERE id = ? AND state IN ('received','deferred')`),
  listOpenByFriend: norm(`SELECT * FROM sub_intents
    WHERE friend_id = ? AND state IN ('received','executing','deferred')
    ORDER BY
      CASE state
        WHEN 'executing' THEN 0
        WHEN 'received' THEN 1
        WHEN 'deferred' THEN 2
        ELSE 3
      END,
      CASE WHEN state = 'executing' THEN claimed_at ELSE NULL END ASC,
      CASE WHEN state = 'received' THEN COALESCE(deadline_at, '9999') ELSE NULL END ASC,
      created_at DESC
    LIMIT ?`),
};

function hasOpenConflict(store: Store, ns: string, key: string, cycle: string, op: string): boolean {
  for (const row of store.intents.values()) {
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
    contracts: new Map((seed.contracts ?? []).map((c) => [c.contract_id, { ...c }])),
    friends: new Map((seed.friends ?? []).map((f) => [f.id, { ...f }])),
    auditLogs: [],
    sqlLog: [],
    queryCount: 0,
  };

  function exec(sqlRaw: string, args: unknown[]): unknown {
    store.queryCount += 1;
    const sql = norm(sqlRaw);
    store.sqlLog.push(sql);
    const a = args as (string | null)[];

    if (sql === SQL.insert) {
      const [id, friendId, ns, key, cycle, presented, op, state, requestedBy, staffId, role, payload, deadline, promisedBy, executor, supersedes, verifyBaseline, createdAt] = a;
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

    if (sql === SQL.undo) {
      const [now, staffId, role, id] = a;
      const row = store.intents.get(id as string);
      if (!row || !(row.state === 'received' || row.state === 'deferred')) return { meta: { changes: 0 } };
      row.state = 'cancelled';
      row.resolved_at = now;
      row.actor_staff_id = staffId;
      row.actor_role = role;
      return { meta: { changes: 1 } };
    }

    if (sql === SQL.listOpenByFriend) {
      const [friendId, limit] = args as [string, number];
      const order: Record<string, number> = { executing: 0, received: 1, deferred: 2 };
      const rows = [...store.intents.values()]
        .filter((r) => r.friend_id === friendId && OPEN.has(r.state))
        .sort((x, y) => {
          const ox = order[x.state] ?? 3;
          const oy = order[y.state] ?? 3;
          if (ox !== oy) return ox - oy;
          return x.created_at < y.created_at ? 1 : -1;
        })
        .slice(0, limit);
      return { results: rows };
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
      return { id: a[0], action: 'stub' };
    }

    throw new Error(`fake D1: unhandled SQL: ${sql.slice(0, 160)}`);
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => exec(sql, args),
            first: async () => exec(sql, args),
            all: async () => exec(sql, args),
          };
        },
        run: async () => exec(sql, []),
        first: async () => exec(sql, []),
        all: async () => exec(sql, []),
      };
    },
  } as unknown as D1Database;

  return { db, store };
}

// ============================================================
// フィクスチャ — route は nowMs 注入不能のため**実時計相対**の日付に置く
// (固定日付だと実時計の前進で deadline_passed / late_promise 側へ倒れる時限爆弾になる)
// ============================================================

/** 推定 = 実時計 + 30 日 → 締切 (+27 日) は常に未来 = 素直に受理される */
const FUTURE_ESTIMATE = toJstString(new Date(Date.now() + 30 * 86_400_000)).slice(0, 10);
/** 推定 = 実時計 + 3 日 → 締切 = 本日 EOD。約束 (翌営業日 17:00) は必ず締切超過 = §4-1 開示 */
const TIGHT_ESTIMATE = toJstString(new Date(Date.now() + 3 * 86_400_000)).slice(0, 10);
const TODAY_JST = toJstString(new Date()).slice(0, 10);

const CONTRACT: ContractSeed = {
  contract_id: 'C1',
  shopify_customer_id: 'CUST1',
  plan_name: 'naturism 定期便',
  next_billing_estimate: FUTURE_ESTIMATE,
  estimate_source: 'flow',
  interval_days: 30,
  order_count: 3,
  skip_count: 0,
  cancelled_at: null,
  paused_at: null,
};
/** 他人の契約 (IDOR の標的) */
const OTHER_CONTRACT: ContractSeed = {
  ...CONTRACT,
  contract_id: 'C2',
  shopify_customer_id: 'OTHER',
};
const FRIEND: FriendSeed = { id: 'F1', line_user_id: 'U1', shopify_customer_id: 'CUST1' };

const USER = { lineUserId: 'U1', friendId: 'F1', shopifyCustomerId: 'CUST1' as string | null };
const GATES = { SUBSCRIPTION_MENU_ENABLED: 'true', SUB_INTENT_ENABLED: 'true' };
const CYCLE_KEY = `C1:${FUTURE_ESTIMATE}`;

function buildApp(liffUser: typeof USER | null = USER) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (liffUser) c.set('liffUser' as never, liffUser as never);
    await next();
  });
  app.route('/', liffSubContracts);
  return app;
}

function postJson(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: Record<string, unknown>,
  env: Record<string, unknown>,
) {
  return app.request(
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    env,
  );
}

/** 台帳へ直接行を差し込む (undo テスト用 — 状態を任意に作る)。 */
function seedIntentRow(store: Store, over: Partial<SubIntentRow> = {}): SubIntentRow {
  const row: SubIntentRow = {
    id: over.id ?? 'si_seed1',
    friend_id: 'F1',
    contract_ns: 'hb',
    contract_key: 'C1',
    target_cycle_key: CYCLE_KEY,
    presented_scheduled_date: FUTURE_ESTIMATE,
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
    created_at: toJstString(new Date()),
    resolved_at: null,
    ...over,
  };
  store.intents.set(row.id, row);
  return row;
}

const touchedSubIntentInsert = (store: Store): boolean =>
  store.sqlLog.some((s) => s.startsWith('INSERT INTO sub_intents'));

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  // 通知経路 (Discord) の既定 stub — 個別テストで観測する場合は上書きする
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
});

// ============================================================
// 認証・gate
// ============================================================

describe('認証と gate', () => {
  it('liffUser 不在 (未認証) は 401', async () => {
    const { db } = createDb();
    const app = buildApp(null);
    expect((await app.request('/api/liff/sub-contracts', {}, { DB: db, ...GATES })).status).toBe(401);
    expect((await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip' }, { DB: db, ...GATES })).status).toBe(401);
    expect((await postJson(app, '/api/liff/sub-intents/si_x/undo', {}, { DB: db, ...GATES })).status).toBe(401);
  });

  it('SUBSCRIPTION_MENU_ENABLED OFF: GET は enabled:false (DB 非接触)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const res = await app.request('/api/liff/sub-contracts', {}, { DB: db });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { enabled: boolean } };
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: false });
    expect(store.queryCount).toBe(0);
  });

  it('SUBSCRIPTION_MENU_ENABLED OFF: POST 2 本は 409 (DB 非接触)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const accept = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey: CYCLE_KEY }, { DB: db });
    expect(accept.status).toBe(409);
    const undo = await postJson(app, '/api/liff/sub-intents/si_x/undo', {}, { DB: db });
    expect(undo.status).toBe(409);
    expect(store.queryCount).toBe(0);
  });

  it('menu ON + SUB_INTENT_ENABLED OFF: GET は enabled:true + subIntentEnabled:false、POST は 409', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, SUBSCRIPTION_MENU_ENABLED: 'true' };
    const get = await app.request('/api/liff/sub-contracts', {}, env);
    expect(get.status).toBe(200);
    const json = (await get.json()) as { data: { enabled: boolean; subIntentEnabled: boolean } };
    expect(json.data.enabled).toBe(true);
    expect(json.data.subIntentEnabled).toBe(false);
    const post = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey: CYCLE_KEY }, env);
    expect(post.status).toBe(409);
    // 受理系は台帳に一切触れない (読み取りの GET だけが DB を読む)
    expect(touchedSubIntentInsert(store)).toBe(false);
  });
});

// ============================================================
// GET /api/liff/sub-contracts
// ============================================================

describe('GET /api/liff/sub-contracts', () => {
  it('未連携 (shopifyCustomerId null) は linked:false・契約 fetch なし', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp({ ...USER, shopifyCustomerId: null });
    const res = await app.request('/api/liff/sub-contracts', {}, { DB: db, ...GATES });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { linked: boolean; contracts: unknown[] } };
    expect(json.data.linked).toBe(false);
    expect(json.data.contracts).toEqual([]);
    // 観測点はステータスでなく「ストレージに触れていないこと」
    expect(store.sqlLog.some((s) => s.includes('subscription_contracts'))).toBe(false);
  });

  it('連携済み: 契約に cycleKey / presentableDate / deadlineText / openIntents が同梱される', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, ...GATES };
    // open intent を 1 件受理してから GET (受理→一覧の実配線を通す)
    const accept = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey: CYCLE_KEY }, env);
    expect(accept.status).toBe(200);
    const res = await app.request('/api/liff/sub-contracts', {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        enabled: boolean;
        linked: boolean;
        subIntentEnabled: boolean;
        contracts: Array<{
          contractId: string;
          planName: string | null;
          intervalDays: number | null;
          orderCount: number | null;
          state: string;
          presentableDate: string | null;
          cycleKey: string;
          deadlineText: string | null;
          openIntents: Array<{ id: string; op: string; opLabel: string; state: string }>;
        }>;
      };
    };
    expect(json.data.enabled).toBe(true);
    expect(json.data.linked).toBe(true);
    expect(json.data.subIntentEnabled).toBe(true);
    expect(json.data.contracts).toHaveLength(1);
    const contract = json.data.contracts[0];
    expect(contract.contractId).toBe('C1');
    expect(contract.planName).toBe('naturism 定期便');
    expect(contract.state).toBe('active');
    expect(contract.presentableDate).toBe(FUTURE_ESTIMATE);
    expect(contract.cycleKey).toBe(CYCLE_KEY);
    expect(contract.deadlineText).toContain('締切');
    expect(contract.openIntents).toHaveLength(1);
    expect(contract.openIntents[0].op).toBe('skip');
    expect(contract.openIntents[0].opLabel).toBe('次回スキップ');
    expect(contract.openIntents[0].state).toBe('received');
    expect(store.intents.size).toBe(1);
  });

  it('paused / cancelled は state に写像される', async () => {
    const paused: ContractSeed = { ...CONTRACT, contract_id: 'C3', paused_at: '2026-08-01' };
    const cancelled: ContractSeed = { ...CONTRACT, contract_id: 'C4', cancelled_at: '2026-08-01' };
    const { db } = createDb({ contracts: [paused, cancelled], friends: [FRIEND] });
    const app = buildApp();
    const res = await app.request('/api/liff/sub-contracts', {}, { DB: db, ...GATES });
    const json = (await res.json()) as { data: { contracts: Array<{ contractId: string; state: string }> } };
    const states = new Map(json.data.contracts.map((c) => [c.contractId, c.state]));
    expect(states.get('C3')).toBe('paused');
    expect(states.get('C4')).toBe('cancelled');
  });
});

// ============================================================
// POST /api/liff/sub-contracts/:id/intents — 敵対的ケース
// ============================================================

describe('POST /api/liff/sub-contracts/:id/intents', () => {
  it('IDOR: 他人の契約 id は 404 (存在を漏らさない)・acceptSubIntent (INSERT) に到達しない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT, OTHER_CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    // 攻撃者視点: cycleKey は改ざん可能なので他人の契約に一致する値を細工できる。
    // 所有者検証が唯一の壁
    const res = await postJson(
      app,
      '/api/liff/sub-contracts/C2/intents',
      { op: 'skip', cycleKey: `C2:${FUTURE_ESTIMATE}` },
      { DB: db, ...GATES },
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain('C2'); // 契約の存在を応答に漏らさない
    expect(touchedSubIntentInsert(store)).toBe(false);
    expect(store.intents.size).toBe(0);

    // 実在しない契約 id と**同一の応答** (存在確認オラクルを作らない)
    const ghost = await postJson(
      app,
      '/api/liff/sub-contracts/NOPE/intents',
      { op: 'skip', cycleKey: 'NOPE:x' },
      { DB: db, ...GATES },
    );
    expect(ghost.status).toBe(404);
    expect(await ghost.text()).toBe(text);
  });

  it('op が skip|date|pause|cancel 以外は 400 (undo_of / resume を受理経路に載せない)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    for (const op of ['undo_of', 'resume', 'delete', '']) {
      const res = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op, cycleKey: CYCLE_KEY }, { DB: db, ...GATES });
      expect(res.status).toBe(400);
    }
    expect(store.intents.size).toBe(0);
  });

  it('§3-3: cycleKey 不一致は 409 cycle_changed + 現在値の提示。受理しない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/liff/sub-contracts/C1/intents',
      { op: 'skip', cycleKey: 'C1:1999-01-01' },
      { DB: db, ...GATES },
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; current: { cycleKey: string; presentableDate: string | null } };
    expect(json.error).toBe('cycle_changed');
    expect(json.current.cycleKey).toBe(CYCLE_KEY);
    expect(json.current.presentableDate).toBe(FUTURE_ESTIMATE);
    expect(touchedSubIntentInsert(store)).toBe(false);
  });

  it('date: 希望日なし / 形式不正 / 過去日 (JST 今日含む) は 400 で弾く', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, ...GATES };
    for (const requestedDate of [undefined, '9/20', '2000-01-01', TODAY_JST]) {
      const res = await postJson(
        app,
        '/api/liff/sub-contracts/C1/intents',
        { op: 'date', cycleKey: CYCLE_KEY, ...(requestedDate !== undefined ? { requestedDate } : {}) },
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(store.intents.size).toBe(0);
  });

  it('受理成功: 200 + 「承りました」文言 + 反映予定。台帳は received', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/liff/sub-contracts/C1/intents',
      { op: 'skip', cycleKey: CYCLE_KEY },
      { DB: db, ...GATES },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { status: string; message: string; promisedBy: string | null; intent: { op: string; state: string } };
    };
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('accepted');
    expect(json.data.message).toContain('承りました');
    expect(json.data.message).not.toContain('完了しました。'); // 受理を完了と言わない (§1)
    expect(json.data.intent.op).toBe('skip');
    expect(json.data.intent.state).toBe('received');
    const row = [...store.intents.values()][0];
    expect(row.requested_by).toBe('customer');
    expect(row.state).toBe('received');
    expect(row.friend_id).toBe('F1');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.liff_accept')).toBe(true);
  });

  it('cancel の受理文言には §4-4 の救済手順 (返金) が入る', async () => {
    const { db } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/liff/sub-contracts/C1/intents',
      { op: 'cancel', cycleKey: CYCLE_KEY },
      { DB: db, ...GATES },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { message: string } };
    expect(json.data.message).toContain('返金');
  });

  it('accepted はスタッフ通知 (Discord) が鳴り、duplicate 再送では**絶対に鳴らない**', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    // 引数型を明示する (省略すると mock.calls が 0 長タプルになり [1] 参照が TS2493)
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('ok'));
    vi.stubGlobal('fetch', fetchSpy);
    const app = buildApp();
    const env = { DB: db, ...GATES, DISCORD_WEBHOOK_URL: 'https://discord.example/hook' };

    const first = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey: CYCLE_KEY }, env);
    expect(first.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Discord 1 通 (メール env 未設定)
    const body = String(fetchSpy.mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('LIFF から'); // 経路が分かる語 (postback 経路と区別できる)
    expect(body).toContain('C1');

    fetchSpy.mockClear();
    const second = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey: CYCLE_KEY }, env);
    expect(second.status).toBe(200);
    const json = (await second.json()) as { data: { status: string; message: string } };
    expect(json.data.status).toBe('duplicate');
    expect(json.data.message).toContain('既に承っております');
    expect(fetchSpy).not.toHaveBeenCalled(); // 再タップで鳴らすと新規受理が埋もれる
    expect(store.intents.size).toBe(1);
  });

  it('date の duplicate は既存の希望日を開示し、今回の日付が未登録であることを言う', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, ...GATES };
    const d1 = toJstString(new Date(Date.now() + 20 * 86_400_000)).slice(0, 10);
    const d2 = toJstString(new Date(Date.now() + 25 * 86_400_000)).slice(0, 10);
    const first = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'date', cycleKey: CYCLE_KEY, requestedDate: d1 }, env);
    expect(first.status).toBe(200);
    const second = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'date', cycleKey: CYCLE_KEY, requestedDate: d2 }, env);
    expect(second.status).toBe(200);
    const json = (await second.json()) as { data: { status: string; existingDate: string | null; message: string } };
    expect(json.data.status).toBe('duplicate');
    expect(json.data.existingDate).toBe(d1);
    expect(json.data.message).toContain('既に承っております');
    expect(json.data.message).toContain('まだ登録されていません');
    expect(store.intents.size).toBe(1);
  });

  it('§4-1: ack なしの late promise は 409 + 開示 (受理しない) → ack:true の再送で受理される', async () => {
    const tight: ContractSeed = { ...CONTRACT, next_billing_estimate: TIGHT_ESTIMATE };
    const { db, store } = createDb({ contracts: [tight], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, ...GATES };
    const cycleKey = `C1:${TIGHT_ESTIMATE}`;

    const first = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey }, env);
    expect(first.status).toBe(409);
    const firstJson = (await first.json()) as {
      error: string; promisedBy?: string; deadlineAt?: string; disclosure?: string;
    };
    expect(firstJson.error).toBe('late_promise');
    expect(firstJson.promisedBy).toBeTruthy();
    expect(firstJson.deadlineAt).toBeTruthy();
    expect(firstJson.disclosure).toContain('間に合わない');
    expect(store.intents.size).toBe(0); // 開示前に台帳へ入れない

    const second = await postJson(app, '/api/liff/sub-contracts/C1/intents', { op: 'skip', cycleKey, ack: true }, env);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { data: { status: string } };
    expect(secondJson.data.status).toBe('accepted');
    expect(store.intents.size).toBe(1);
    // §4-1 の開示を経た受理は台帳に痕跡が残る (postback / admin 経路と同じ規律)
    const row = [...store.intents.values()][0];
    expect(String(row.payload_json)).toContain('latePromiseAcknowledged');
  });

  it('解約済み契約は 409 contract_inactive / 一時停止中の skip は 409 paused_op_unavailable・cancel は受理', async () => {
    const inactive: ContractSeed = { ...CONTRACT, contract_id: 'C5', cancelled_at: '2026-08-01' };
    const paused: ContractSeed = { ...CONTRACT, contract_id: 'C6', paused_at: '2026-08-01' };
    const { db, store } = createDb({ contracts: [inactive, paused], friends: [FRIEND] });
    const app = buildApp();
    const env = { DB: db, ...GATES };

    const dead = await postJson(app, '/api/liff/sub-contracts/C5/intents', { op: 'skip', cycleKey: `C5:${FUTURE_ESTIMATE}` }, env);
    expect(dead.status).toBe(409);
    expect(((await dead.json()) as { error: string }).error).toBe('contract_inactive');

    const skip = await postJson(app, '/api/liff/sub-contracts/C6/intents', { op: 'skip', cycleKey: `C6:${FUTURE_ESTIMATE}` }, env);
    expect(skip.status).toBe(409);
    expect(((await skip.json()) as { error: string }).error).toBe('paused_op_unavailable');
    expect(store.intents.size).toBe(0);

    // 停止中の解約意思は正当に受理する (§1-2 — doorway で捨てるのは解約妨害)
    const cancel = await postJson(app, '/api/liff/sub-contracts/C6/intents', { op: 'cancel', cycleKey: `C6:${FUTURE_ESTIMATE}` }, env);
    expect(cancel.status).toBe(200);
    expect(store.intents.size).toBe(1);
  });
});

// ============================================================
// POST /api/liff/sub-intents/:id/undo
// ============================================================

describe('POST /api/liff/sub-intents/:id/undo', () => {
  it('IDOR: 他人の intent は 404 (存在を漏らさない)・state は変わらない', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const victim = seedIntentRow(store, { id: 'si_victim', friend_id: 'F2' });
    const app = buildApp();
    const res = await postJson(app, '/api/liff/sub-intents/si_victim/undo', {}, { DB: db, ...GATES });
    expect(res.status).toBe(404);
    expect(store.intents.get(victim.id)?.state).toBe('received'); // 触っていない

    // 実在しない id と同一応答 (存在確認オラクルを作らない)
    const ghost = await postJson(app, '/api/liff/sub-intents/si_ghost/undo', {}, { DB: db, ...GATES });
    expect(ghost.status).toBe(404);
    expect(await ghost.text()).toBe(await res.text());
  });

  it('自分の received intent は取り消せる (200 + 「取り消しました」)', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    const mine = seedIntentRow(store, { id: 'si_mine' });
    const app = buildApp();
    const res = await postJson(app, '/api/liff/sub-intents/si_mine/undo', {}, { DB: db, ...GATES });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { status: string; message: string } };
    expect(json.data.status).toBe('cancelled');
    expect(json.data.message).toContain('取り消しました');
    expect(store.intents.get(mine.id)?.state).toBe('cancelled');
    expect(store.auditLogs.some((l) => l.action === 'sub_intent.liff_undo')).toBe(true);
  });

  it('terminal (expired) の intent は 409 not_undoable + 実際の state を返す', async () => {
    const { db, store } = createDb({ contracts: [CONTRACT], friends: [FRIEND] });
    seedIntentRow(store, { id: 'si_gone', state: 'expired' });
    const app = buildApp();
    const res = await postJson(app, '/api/liff/sub-intents/si_gone/undo', {}, { DB: db, ...GATES });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; state: string };
    expect(json.error).toBe('not_undoable');
    expect(json.state).toBe('expired');
  });
});
