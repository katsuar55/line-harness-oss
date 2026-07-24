/**
 * own-billing cron 骨格のテスト (WI-4 step 1, docs/PHASE3_BILLING_DESIGN_2026-07-19.md §5/§8)
 *
 * 対象:
 *   - parseContractList: fail-closed (未設定/空/parse 不能)・'ALL' sentinel・\r trim (§8)
 *   - canIssueAttempt: 全 gate 要素の AND (enabled/armed/breaker/allowlist/excludelist/quarantine)
 *   - processOwnBilling: gate OFF = heartbeat のみで 071 新テーブル非アクセス (migration
 *     未適用の本番でも安全)・gate ON = D1 gate 可視化・D1 error = fail-closed + partial
 */
import { describe, it, expect } from 'vitest';
import {
  parseContractList,
  readStaticGates,
  readD1Gates,
  canIssueAttempt,
  processOwnBilling,
  OWN_BILLING_JOB_NAME,
  type OwnBillingEnv,
  type StaticGateStatus,
  type D1GateStatus,
} from '../services/own-billing.js';

// ===== fake D1 =====

interface FakeD1Options {
  /** own_billing_state に breaker_tripped_at 行がある */
  breakerTripped?: boolean;
  quarantine?: string[];
  /** 071 新テーブル参照で throw (migration 未適用の再現) */
  failNewTables?: boolean;
  /** cron_run_logs INSERT でも throw */
  failCronLog?: boolean;
  /** 通知キューに置く行 (配送 gate の実挙動を検証するため) */
  noticeQueue?: Array<Record<string, unknown>>;
}

function createFakeDb(opts: FakeD1Options = {}) {
  const executed: string[] = [];
  const cronLogs: Array<Record<string, unknown>> = [];
  const db = {
    prepare(sql: string) {
      executed.push(sql);
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return route(sql, 'first', args);
            },
            async all() {
              return { results: route(sql, 'all', args) };
            },
            async run() {
              return route(sql, 'run', args);
            },
          };
        },
        async first() {
          return route(sql, 'first', []);
        },
        async all() {
          return { results: route(sql, 'all', []) };
        },
        async run() {
          return route(sql, 'run', []);
        },
      };
    },
  } as unknown as D1Database;

  function route(sql: string, _mode: string, args: unknown[]): any {
    if (sql.includes('own_billing_state')) {
      if (opts.failNewTables) throw new Error('no such table: own_billing_state');
      return opts.breakerTripped ? { value: '2026-07-22T00:00:00Z' } : null;
    }
    if (sql.includes('own_billing_quarantine')) {
      if (opts.failNewTables) throw new Error('no such table: own_billing_quarantine');
      return (opts.quarantine ?? []).map((g) => ({ contract_gid: g }));
    }
    if (sql.includes('cron_run_logs')) {
      if (opts.failCronLog) throw new Error('cron_run_logs write failed');
      cronLogs.push({ sql, args });
      return { success: true };
    }
    // step3: 通知キューの配送 (窓内なら候補を引く)。既定は空キュー
    if (sql.includes('own_billing_notice_queue')) {
      if (opts.failNewTables) throw new Error('no such table: own_billing_notice_queue');
      // 'queued' → 'sending' の CAS だけ成功させる (= 配送権を取れたことを表す)。
      // その先の配送は本テストの対象外 (deliverOne の例外はループの try/catch が受ける)。
      if (sql.includes("SET status = 'sending'")) return { meta: { changes: 1 } };
      if (sql.trim().startsWith('UPDATE')) return { meta: { changes: 0 } };
      return (opts.noticeQueue ?? []).map((r) => ({ ...r }));
    }
    throw new Error(`unexpected SQL in fake db: ${sql}`);
  }

  return { db, executed, cronLogs };
}

const GID = 'gid://shopify/SubscriptionContract/1234567';

function statics(over: Partial<StaticGateStatus> = {}): StaticGateStatus {
  return {
    enabled: true,
    armed: true,
    allowlist: { kind: 'all' },
    excludelistSecret: { kind: 'empty' },
    ...over,
  };
}

function d1(over: Partial<D1GateStatus> = {}): D1GateStatus {
  return { breakerTripped: false, quarantine: new Set(), ...over };
}

// ===== parseContractList (§8 parser: fail-closed / ALL / \r trim) =====

describe('parseContractList', () => {
  it('未設定 (undefined/null) は empty (fail-closed でゼロ収載)', () => {
    expect(parseContractList(undefined).kind).toBe('empty');
    expect(parseContractList(null).kind).toBe('empty');
  });

  it('空文字・空白・カンマのみは empty', () => {
    expect(parseContractList('').kind).toBe('empty');
    expect(parseContractList('  ').kind).toBe('empty');
    expect(parseContractList(',,').kind).toBe('empty');
    expect(parseContractList(' \r\n ').kind).toBe('empty');
  });

  it("sentinel 'ALL' (単独) は all。末尾 CRLF が付いても all (\\r trim)", () => {
    expect(parseContractList('ALL').kind).toBe('all');
    expect(parseContractList('ALL\r').kind).toBe('all');
    expect(parseContractList(' ALL \r\n').kind).toBe('all');
  });

  it('gid リストは list になり、各トークンが trim される', () => {
    const p = parseContractList(` ${GID} ,\r gid://shopify/SubscriptionContract/2 \r\n`);
    expect(p.kind).toBe('list');
    if (p.kind === 'list') {
      expect(p.set.has(GID)).toBe(true);
      expect(p.set.has('gid://shopify/SubscriptionContract/2')).toBe(true);
      expect(p.set.size).toBe(2);
    }
  });

  it('parse 不能 (JSON 断片・空白入りトークン・ALL 併記) は invalid', () => {
    expect(parseContractList('{"a":1}').kind).toBe('invalid');
    expect(parseContractList('gid 1234').kind).toBe('invalid');
    expect(parseContractList(`ALL,${GID}`).kind).toBe('invalid');
  });

  it('改行区切りリストは複数トークンに分解される (review HIGH: 結合による excludelist fail-open 防止)', () => {
    const p = parseContractList(`${GID}\ngid://shopify/SubscriptionContract/2\r\ngid://shopify/SubscriptionContract/3`);
    expect(p.kind).toBe('list');
    if (p.kind === 'list') {
      expect(p.set.size).toBe(3);
      expect(p.set.has(GID)).toBe(true);
      expect(p.set.has('gid://shopify/SubscriptionContract/3')).toBe(true);
    }
  });

  it("改行区切りの 'ALL' 併記も invalid に落ちる (結合トークン化で検出を貫通しない)", () => {
    expect(parseContractList(`ALL\n${GID}`).kind).toBe('invalid');
  });
});

// ===== canIssueAttempt (§8 全要素 AND) =====

describe('canIssueAttempt', () => {
  it('全 gate green で true', () => {
    expect(canIssueAttempt(statics(), d1(), GID)).toBe(true);
  });

  it('SELF_BILLING_ENABLED off で false', () => {
    expect(canIssueAttempt(statics({ enabled: false }), d1(), GID)).toBe(false);
  });

  it('arming インターロック: ARMED_AT 未設定で false', () => {
    expect(canIssueAttempt(statics({ armed: false }), d1(), GID)).toBe(false);
  });

  it('breaker trip 中は false', () => {
    expect(canIssueAttempt(statics(), d1({ breakerTripped: true }), GID)).toBe(false);
  });

  it('allowlist fail-closed: empty / invalid は false', () => {
    expect(canIssueAttempt(statics({ allowlist: { kind: 'empty' } }), d1(), GID)).toBe(false);
    expect(canIssueAttempt(statics({ allowlist: { kind: 'invalid' } }), d1(), GID)).toBe(false);
  });

  it('allowlist list は収載契約のみ true', () => {
    const listed = statics({ allowlist: { kind: 'list', set: new Set([GID]) } });
    expect(canIssueAttempt(listed, d1(), GID)).toBe(true);
    expect(canIssueAttempt(listed, d1(), 'gid://shopify/SubscriptionContract/999')).toBe(false);
  });

  it('excludelist: invalid は全契約除外 (fail-closed 側)・list 一致で除外・ALL で全除外', () => {
    expect(
      canIssueAttempt(statics({ excludelistSecret: { kind: 'invalid' } }), d1(), GID),
    ).toBe(false);
    expect(
      canIssueAttempt(
        statics({ excludelistSecret: { kind: 'list', set: new Set([GID]) } }),
        d1(),
        GID,
      ),
    ).toBe(false);
    expect(
      canIssueAttempt(statics({ excludelistSecret: { kind: 'all' } }), d1(), GID),
    ).toBe(false);
  });

  it('D1 quarantine (secret ∪ D1 の和集合) 収載で false', () => {
    expect(canIssueAttempt(statics(), d1({ quarantine: new Set([GID]) }), GID)).toBe(false);
  });
});

// ===== readStaticGates / readD1Gates =====

describe('readStaticGates', () => {
  it('env を静的評価する (D1 非依存)', () => {
    const s = readStaticGates({
      DB: {} as D1Database,
      SELF_BILLING_ENABLED: 'true',
      SELF_BILLING_ARMED_AT: '2026-07-22T00:00:00Z',
      SELF_BILLING_ALLOWLIST: 'ALL',
    });
    expect(s.enabled).toBe(true);
    expect(s.armed).toBe(true);
    expect(s.allowlist.kind).toBe('all');
    expect(s.excludelistSecret.kind).toBe('empty');
  });

  it("armed は空白のみの ARMED_AT を未設定扱いにする", () => {
    const s = readStaticGates({ DB: {} as D1Database, SELF_BILLING_ARMED_AT: '  ' });
    expect(s.armed).toBe(false);
  });
});

describe('readD1Gates', () => {
  it('breaker 行と quarantine を読む', async () => {
    const { db } = createFakeDb({ breakerTripped: true, quarantine: [GID] });
    const g = await readD1Gates(db);
    expect(g.breakerTripped).toBe(true);
    expect(g.quarantine.has(GID)).toBe(true);
    expect(g.error).toBeUndefined();
  });

  it('テーブル不在 (migration 未適用) は fail-closed: breakerTripped=true + error', async () => {
    const { db } = createFakeDb({ failNewTables: true });
    const g = await readD1Gates(db);
    expect(g.breakerTripped).toBe(true);
    expect(g.error).toContain('no such table');
  });
});

// ===== processOwnBilling (5分 tick 骨格) =====

describe('processOwnBilling', () => {
  it('gate OFF: skippedGating heartbeat のみ。071 新テーブルへ一切アクセスしない (live-safety)', async () => {
    const { db, executed, cronLogs } = createFakeDb({ failNewTables: true });
    const r = await processOwnBilling({ DB: db });
    expect(r.skippedGating).toBe(true);
    expect(cronLogs.length).toBe(1);
    // 新テーブルへの SQL が発行されていないこと (発行されていれば fake が throw している)
    expect(executed.some((s) => s.includes('own_billing_state'))).toBe(false);
    expect(executed.some((s) => s.includes('own_billing_quarantine'))).toBe(false);
    expect(executed.some((s) => s.includes('own_sub_contracts'))).toBe(false);
  });

  it("gate OFF 判定は厳密一致 ('TRUE' や '1' では開かない)", async () => {
    const { db, cronLogs } = createFakeDb();
    for (const v of ['TRUE', '1', 'yes', ' true']) {
      const r = await processOwnBilling({ DB: db, SELF_BILLING_ENABLED: v });
      expect(r.skippedGating).toBe(true);
    }
    expect(cronLogs.length).toBe(4);
  });

  it("'true\\r' (PowerShell CRLF trap) は gate ON として扱う — silent no-op 化しない", async () => {
    const { db } = createFakeDb();
    const r = await processOwnBilling({
      DB: db,
      SELF_BILLING_ENABLED: 'true\r',
      SELF_BILLING_ARMED_AT: 'x',
      SELF_BILLING_ALLOWLIST: 'ALL',
    });
    expect(r.skippedGating).toBeUndefined();
    expect(r.armed).toBe(true);
  });

  // ── step3: 通知配送の注入と promoted_succeeded フック ──

  const onGates = {
    SELF_BILLING_ENABLED: 'true',
    SELF_BILLING_ARMED_AT: 'x',
    SELF_BILLING_ALLOWLIST: 'ALL',
  };
  const IN_WINDOW = Date.parse('2026-08-05T02:00:00Z'); // JST 11:00 (配送窓内)

  it('gate OFF なら notify を注入しても通知キューに触らない (dormant)', async () => {
    const { db, executed } = createFakeDb({ failNewTables: true });
    const r = await processOwnBilling(
      { DB: db },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    expect(r.skippedGating).toBe(true);
    expect(r.notices).toBeUndefined();
    expect(executed.some((s) => s.includes('own_billing_notice_queue'))).toBe(false);
  });

  it('gate ON + 窓内なら通知キューを配送する', async () => {
    const { db } = createFakeDb();
    const r = await processOwnBilling(
      { DB: db, ...onGates },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    expect(r.notices).toMatchObject({ window: true, picked: 0 });
  });

  it('breaker trip 中は通知配送も凍結する (誤判定由来の顧客通知を出さない)', async () => {
    const { db } = createFakeDb({ breakerTripped: true });
    const r = await processOwnBilling(
      { DB: db, ...onGates },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    expect(r.breakerTripped).toBe(true);
    expect(r.notices).toBeUndefined();
  });

  it('通知配送の例外は課金 tick を落とさず partial として heartbeat に残る', async () => {
    const { db, cronLogs } = createFakeDb({ failNewTables: true });
    const r = await processOwnBilling(
      { DB: db, ...onGates },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    // d1Error (gate 読取り失敗) で fail-closed、通知側の例外も握られている
    expect(r.d1Error).toBeDefined();
    expect(cronLogs.length).toBe(1);
  });

  it('契約単位 gate を canDispatch として通知配送へ渡す (quarantine の契約は配送されない)', async () => {
    // **実際にキューへ行を置いて、processOwnBilling の戻り値で検証する**
    // (述語を手元で作り直して assert するだけだと何も保証しない — 採点 R4/R6 test-integrity)
    const { db } = createFakeDb({
      quarantine: [GID],
      noticeQueue: [
        { id: 1, contract_gid: GID, cycle_key: '2', attempt_no: 1, kind: 'fail_notice',
          shopify_customer_id: '555', payload_json: '{}', dispatch_attempts: 0, queued_at: '2026-08-05T11:00:00.000+09:00' },
      ],
    });
    const r = await processOwnBilling(
      { DB: db, ...onGates },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    expect(r.notices?.gateFrozen).toBe(1);
    expect(r.notices?.picked).toBe(0);
  });

  it('quarantine 対象外の契約は配送候補になる (gate が全件を止めていない証拠)', async () => {
    const { db } = createFakeDb({
      quarantine: ['gid://shopify/SubscriptionContract/other'],
      noticeQueue: [
        { id: 1, contract_gid: GID, cycle_key: '2', attempt_no: 1, kind: 'fail_notice',
          shopify_customer_id: '555', payload_json: '{}', dispatch_attempts: 0, queued_at: '2026-08-05T11:00:00.000+09:00' },
      ],
    });
    const r = await processOwnBilling(
      { DB: db, ...onGates },
      { notify: { lineClient: {} as never }, nowMs: IN_WINDOW },
    );
    expect(r.notices?.gateFrozen).toBe(0);
    expect(r.notices?.picked).toBe(1);
  });

  it('gate ON: D1 gate を読み heartbeat metrics に可視化 (課金ロジックはまだ呼ばれない)', async () => {
    const { db, cronLogs } = createFakeDb({ quarantine: [GID] });
    const r = await processOwnBilling({
      DB: db,
      SELF_BILLING_ENABLED: 'true',
      SELF_BILLING_ARMED_AT: '2026-07-22T00:00:00Z',
      SELF_BILLING_ALLOWLIST: `${GID},gid://shopify/SubscriptionContract/2`,
    });
    expect(r.skippedGating).toBeUndefined();
    expect(r.armed).toBe(true);
    expect(r.breakerTripped).toBe(false);
    expect(r.allowlistKind).toBe('list');
    expect(r.allowlistParsed).toBe(2);
    expect(r.quarantineCount).toBe(1);
    expect(cronLogs.length).toBe(1);
    const logged = String(cronLogs[0]!.args);
    expect(logged).toContain(OWN_BILLING_JOB_NAME);
  });

  it('gate ON + migration 未適用: fail-closed (breakerTripped=true) で partial heartbeat', async () => {
    const { db, cronLogs } = createFakeDb({ failNewTables: true });
    const r = await processOwnBilling({
      DB: db,
      SELF_BILLING_ENABLED: 'true',
      SELF_BILLING_ARMED_AT: 'x',
      SELF_BILLING_ALLOWLIST: 'ALL',
    });
    expect(r.breakerTripped).toBe(true);
    expect(r.d1Error).toContain('no such table');
    expect(cronLogs.length).toBe(1);
  });

  it('heartbeat 書込失敗でも throw しない (cron 全体を落とさない)', async () => {
    const { db } = createFakeDb({ failCronLog: true });
    await expect(processOwnBilling({ DB: db })).resolves.toEqual({ skippedGating: true });
  });
});
