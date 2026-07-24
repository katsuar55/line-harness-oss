/**
 * own-billing-engine (WI-4 step 2) のテスト — 設計書 §10.3 の step 2 該当 unit。
 *
 * 対象:
 *   - claim ライフサイクル: INSERT / CAS 再入前提条件 (pending 照会→不可 / succeeded 昇格 /
 *     failed 後のみ) / THROTTLED next_tick の同一 key・attempt_no 据え置き / 並行競合の勝者 1
 *   - resolveBillableCycle: 最古選択・将来日は対象外・14日境界 (I-6) の放棄副作用と
 *     dunning 解放対称 (retry_wait→none / challenged は触らない §5.2 管轄)
 *   - 同期エラーレーン: THROTTLED→next_tick / BCCBED・未知→hold (+resolve 除外) /
 *     CONTRACT_PAUSED→abandoned
 *   - issueForContract: I-2 順序 (resync→resolve→claim→発行) / 発行成功で attempt_gid 記録
 *   - listDueContracts: due 述語 + 移行窓 phase 除外 (§5.1 v6)
 *   - idempotency key: 決定的 SHA-256
 */
import { describe, it, expect } from 'vitest';
import { processOwnBilling, isIssueWindow } from '../services/own-billing.js';
import {
  buildIdempotencyKey,
  anchorPlus,
  nextAnchorAfter,
  acquireClaim,
  applySyncError,
  claimBlocksIssue,
  resolveBillableCycle,
  resyncContractCycle,
  issueForContract,
  listDueContracts,
  type ShopifyBillingApi,
  type BillingCycleInfo,
  type OwnContractRow,
  type ClaimRow,
  type AttemptTerminalStatus,
} from '../services/own-billing-engine.js';

const GID = 'gid://shopify/SubscriptionContract/111';
const NOW = '2026-07-23T10:00:00.000+09:00';
const TODAY = '2026-07-23';

// ─── fake D1 (claims + contracts + snapshots の実挙動を再現) ───

interface FakeState {
  claims: Map<string, ClaimRow & { resolved_at: string | null; claimed_at: string }>;
  contracts: Map<string, OwnContractRow & { dunning_attempts?: number }>;
  snapshots: Array<{ own_contract_gid: string; phase: string }>;
  quarantine?: string[];
}

function key(gid: string, cycle: string) {
  return `${gid}|${cycle}`;
}

function createFakeDb(state: FakeState) {
  return {
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
            async first() {
              if (sql.includes('SELECT * FROM billing_cycle_claims')) {
                return state.claims.get(key(String(args[0]), String(args[1]))) ?? null;
              }
              if (sql.includes('own_billing_state')) return null;
              throw new Error(`unexpected first(): ${sql}`);
            },
            async all() {
              if (sql.includes('FROM own_sub_contracts c')) {
                const today = String(args[0]);
                const limit = Number(args[2] ?? 5);
                const excluded = new Set(
                  state.snapshots
                    .filter((s) =>
                      ['own_created_paused', 'hb_stop_requested', 'huckleberry_stopped', 'billing_aligned'].includes(s.phase),
                    )
                    .map((s) => s.own_contract_gid),
                );
                const quarantined = new Set(state.quarantine ?? []);
                const results = [...state.contracts.values()].filter((c) => {
                  if (c.status !== 'active') return false;
                  if (excluded.has(c.contract_gid)) return false;
                  // NOT EXISTS (own_billing_quarantine) の SQL 述語をモデルする
                  if (sql.includes('own_billing_quarantine') && quarantined.has(c.contract_gid)) return false;
                  // 未claim 述語: 現在サイクルにブロック claim (attempting/succeeded/skipped/hold)
                  const cl = state.claims.get(key(c.contract_gid, String(c.current_cycle_index)));
                  if (cl && (['attempting', 'succeeded', 'skipped'].includes(cl.status) || cl.retry_policy === 'hold')) {
                    return false;
                  }
                  if (c.dunning_state === 'none') {
                    return c.current_cycle_scheduled_date !== null && c.current_cycle_scheduled_date <= today;
                  }
                  if (c.dunning_state === 'retry_wait') {
                    return c.next_retry_date !== null && c.next_retry_date <= today;
                  }
                  return false;
                }).slice(0, limit);
                return { results };
              }
              if (sql.includes('own_billing_quarantine')) return { results: [] };
              throw new Error(`unexpected all(): ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO billing_cycle_claims')) {
                const k = key(String(args[0]), String(args[1]));
                if (state.claims.has(k)) throw new Error('UNIQUE constraint failed');
                state.claims.set(k, {
                  contract_gid: String(args[0]),
                  cycle_key: String(args[1]),
                  status: 'attempting',
                  retry_policy: 'none',
                  attempt_no: 1,
                  attempt_gid: null,
                  idempotency_key: String(args[2]),
                  claimed_at: String(args[3]),
                  resolved_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE billing_cycle_claims')) {
                // 昇格 CAS は bind(now, gid, cycle, status) — 一般則 (gid=末尾-2) と並びが
                // 異なるため、汎用 row 解決より先に個別処理する
                if (sql.includes(`SET status = 'succeeded'`)) {
                  const k2 = key(String(args[1]), String(args[2]));
                  const r2 = state.claims.get(k2);
                  if (!r2 || r2.status !== String(args[3])) return { meta: { changes: 0 } };
                  r2.status = 'succeeded';
                  r2.resolved_at = String(args[0]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('cycle_key <> ?')) {
                  // 旧サイクル未解決 claim の一括 abandoned (§4.0 step 4): bind(now, gid, cycleKey)。
                  // 対象は他サイクルの行なので汎用 row 解決より前に処理する
                  let bulkChanges = 0;
                  for (const r3 of state.claims.values()) {
                    if (
                      r3.contract_gid === String(args[1]) &&
                      r3.cycle_key !== String(args[2]) &&
                      ['failed', 'failed_no_attempt'].includes(r3.status) &&
                      r3.retry_policy !== 'hold'
                    ) {
                      r3.status = 'abandoned';
                      r3.resolved_at = String(args[0]);
                      bulkChanges++;
                    }
                  }
                  return { meta: { changes: bulkChanges } };
                }
                // 条件付き UPDATE を素朴に解釈: WHERE の status 集合と一致した行のみ変更
                const gidIdx = args.length - 2;
                const k = key(String(args[gidIdx]), String(args[gidIdx + 1]));
                const row = state.claims.get(k);
                if (!row) return { meta: { changes: 0 } };
                if (sql.includes(`status IN ('failed', 'failed_no_attempt', 'abandoned')`)) {
                  if (!['failed', 'failed_no_attempt', 'abandoned'].includes(row.status)) {
                    return { meta: { changes: 0 } };
                  }
                  row.status = 'attempting';
                  row.retry_policy = 'none';
                  row.attempt_no = Number(args[0]);
                  row.idempotency_key = String(args[1]);
                  row.attempt_gid = null;
                  row.claimed_at = String(args[2]);
                  row.resolved_at = null;
                  return { meta: { changes: 1 } };
                }
                if (sql.includes(`SET status = 'abandoned'`)) {
                  // real の WHERE 述語に忠実化する (採点 R7 test-integrity):
                  //  - I-6 放棄: failed 系 OR (attempting AND attempt_gid IS NOT NULL)
                  //    = attempt_gid 不明の attempting は残す (二重課金防止ガード)
                  //  - CONTRACT_PAUSED/TERMINATED: status='attempting' 限定
                  let eligible: boolean;
                  if (sql.includes('attempt_gid IS NOT NULL')) {
                    eligible =
                      ['failed', 'failed_no_attempt'].includes(row.status) ||
                      (row.status === 'attempting' && row.attempt_gid !== null);
                  } else if (sql.includes('status IN')) {
                    eligible = ['attempting', 'failed', 'failed_no_attempt'].includes(row.status);
                  } else {
                    eligible = row.status === 'attempting';
                  }
                  if (eligible) {
                    row.status = 'abandoned';
                    row.resolved_at = String(args[0]);
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: 0 } };
                }
                if (sql.includes(`SET status = 'failed_no_attempt'`)) {
                  if (row.status !== 'attempting') return { meta: { changes: 0 } };
                  row.status = 'failed_no_attempt';
                  row.retry_policy = sql.includes(`retry_policy = 'next_tick'`) ? 'next_tick' : 'hold';
                  row.resolved_at = String(args[0]);
                  return { meta: { changes: 1 } };
                }
                if (sql.includes('SET attempt_gid = ?')) {
                  if (row.status !== 'attempting') return { meta: { changes: 0 } };
                  row.attempt_gid = String(args[0]);
                  return { meta: { changes: 1 } };
                }
                throw new Error(`unexpected claims UPDATE: ${sql}`);
              }
              if (sql.includes('UPDATE own_sub_contracts')) {
                if (sql.includes(`dunning_state = 'none'`) && sql.includes(`IN ('none', 'retry_wait')`)) {
                  const gid = String(args[1]);
                  const c = state.contracts.get(gid);
                  if (c && ['none', 'retry_wait'].includes(c.dunning_state)) {
                    c.dunning_state = 'none';
                    c.next_retry_date = null;
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: 0 } };
                }
                if (sql.includes(`dunning_state = 'ops_hold'`)) {
                  const c = state.contracts.get(String(args[1]));
                  if (c && ['none', 'retry_wait'].includes(c.dunning_state)) {
                    c.dunning_state = 'ops_hold';
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: 0 } };
                }
                if (sql.includes('cadence_repair_needed = 1')) {
                  const c = state.contracts.get(String(args[1])) as (OwnContractRow & { cadence_repair_needed?: number }) | undefined;
                  if (c) c.cadence_repair_needed = 1;
                  return { meta: { changes: c ? 1 : 0 } };
                }
                if (sql.includes('SET status = ?')) {
                  // 状態再同期 (CONTRACT_PAUSED/TERMINATED): bind(newStatus, now, gid)。
                  // real は dunningSql も書く: CONTRACT_PAUSED は exhausted 保持/他は none、
                  // CANCELLED (TERMINATED) は dunning 全リセット。fake も忠実に反映する
                  // (採点 R9 test-integrity)。
                  const c = state.contracts.get(String(args[2])) as
                    | (OwnContractRow & { dunning_attempts?: number; dunning_deadline_at?: string | null })
                    | undefined;
                  if (c && c.status === 'active') {
                    c.status = String(args[0]);
                    if (sql.includes("CASE WHEN dunning_state = 'exhausted'")) {
                      if (c.dunning_state !== 'exhausted') c.dunning_state = 'none';
                    } else {
                      c.dunning_state = 'none';
                      c.dunning_attempts = 0;
                      c.next_retry_date = null;
                      c.dunning_deadline_at = null;
                    }
                    return { meta: { changes: 1 } };
                  }
                  return { meta: { changes: 0 } };
                }
                if (sql.includes('SET current_cycle_index')) {
                  const gid = String(args[3]);
                  const c = state.contracts.get(gid);
                  if (c) {
                    c.current_cycle_index = args[0] === null ? null : Number(args[0]);
                    c.current_cycle_scheduled_date = args[1] === null ? null : String(args[1]);
                  }
                  return { meta: { changes: c ? 1 : 0 } };
                }
                throw new Error(`unexpected contracts UPDATE: ${sql}`);
              }
              if (sql.includes('cron_run_logs')) return { success: true };
              throw new Error(`unexpected run(): ${sql}`);
            },
          });
      return { bind: (...args: unknown[]) => exec(args), ...exec([]) };
    },
  } as unknown as D1Database;
}

function contract(over: Partial<OwnContractRow> = {}): OwnContractRow {
  return {
    contract_gid: GID,
    shopify_customer_id: 'c1',
    status: 'active',
    current_cycle_index: 3,
    current_cycle_scheduled_date: TODAY,
    anchor_date: '2026-04-24',
    interval_unit: 'DAY',
    interval_count: 30,
    dunning_state: 'none',
    next_retry_date: null,
    ...over,
  };
}

interface FakeApiOpts {
  cycles?: BillingCycleInfo[];
  attemptStatus?: AttemptTerminalStatus | null;
  createResult?: { ok: boolean; attemptGid?: string; userErrorCode?: string };
}

function createFakeApi(opts: FakeApiOpts = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const api: ShopifyBillingApi = {
    async listCycles(gid) {
      calls.push({ fn: 'listCycles', args: [gid] });
      return opts.cycles ?? [{ cycleIndex: 3, expectedDate: '2026-07-22T15:00:00Z', billed: false, skipped: false }];
    },
    async scheduleCycleDate(gid, idx, date) {
      calls.push({ fn: 'scheduleCycleDate', args: [gid, idx, date] });
      return { ok: true };
    },
    async setCycleSkip(gid, idx, skip) {
      calls.push({ fn: 'setCycleSkip', args: [gid, idx, skip] });
      return { ok: true };
    },
    async createAttempt(gid, idx, k2) {
      calls.push({ fn: 'createAttempt', args: [gid, idx, k2] });
      return opts.createResult ?? { ok: true, attemptGid: 'gid://shopify/SubscriptionBillingAttempt/9' };
    },
    async getAttemptStatus(gid) {
      calls.push({ fn: 'getAttemptStatus', args: [gid] });
      // 'attemptStatus' キーが明示指定 (null 含む) ならそれを返す。未指定なら 'failed'
      return 'attemptStatus' in opts ? (opts.attemptStatus ?? null) : 'failed';
    },
  };
  return { api, calls };
}

function freshState(over: Partial<FakeState> = {}): FakeState {
  return {
    claims: new Map(),
    contracts: new Map([[GID, contract()]]),
    snapshots: [],
    ...over,
  };
}

const noAlert = () => {};

// ─── idempotency key / anchor 算術 ───

describe('buildIdempotencyKey / anchor 算術', () => {
  it('key は決定的 SHA-256 で attempt_no に依存する', async () => {
    const k1 = await buildIdempotencyKey(GID, '3', 1);
    const k1b = await buildIdempotencyKey(GID, '3', 1);
    const k2 = await buildIdempotencyKey(GID, '3', 2);
    expect(k1).toBe(k1b);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k2).not.toBe(k1);
  });

  it('anchorPlus / nextAnchorAfter は anchor+k×interval 固定列を返す', () => {
    expect(anchorPlus('2026-04-24', 3, 30)).toBe('2026-07-23');
    // today = anchor+90 ちょうど → 次アンカーは +120
    expect(nextAnchorAfter(contract(), '2026-07-23')).toBe('2026-08-22');
    // anchor より前 → 最初のアンカー
    expect(nextAnchorAfter(contract({ anchor_date: '2026-08-01' }), '2026-07-23')).toBe('2026-08-01');
  });
});

// ─── claim ライフサイクル ───

describe('acquireClaim', () => {
  it('新規サイクルは INSERT で attempting を獲得する', async () => {
    const state = freshState();
    const { api } = createFakeApi();
    const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.claim.status).toBe('attempting');
      expect(r.claim.attempt_no).toBe(1);
    }
  });

  it('attempting / succeeded / skipped / hold はブロック (発行不可)', () => {
    const base: ClaimRow = { contract_gid: GID, cycle_key: '3', status: 'attempting', retry_policy: 'none', attempt_no: 1, attempt_gid: null, idempotency_key: 'k' };
    expect(claimBlocksIssue(base)).toBe(true);
    expect(claimBlocksIssue({ ...base, status: 'succeeded' })).toBe(true);
    expect(claimBlocksIssue({ ...base, status: 'skipped' })).toBe(true);
    expect(claimBlocksIssue({ ...base, status: 'failed_no_attempt', retry_policy: 'hold' })).toBe(true);
    expect(claimBlocksIssue({ ...base, status: 'failed' })).toBe(false);
    expect(claimBlocksIssue(null)).toBe(false);
  });

  it('CAS 再入: 旧 attempt が pending/challenged なら再入不可 (no-parallel-attempt)', async () => {
    for (const st of ['pending', 'challenged'] as const) {
      const state = freshState();
      state.claims.set(key(GID, '3'), {
        contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
        attempt_no: 1, attempt_gid: 'att-1', idempotency_key: 'k1', claimed_at: NOW, resolved_at: NOW,
      });
      const { api } = createFakeApi({ attemptStatus: st });
      const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
      expect(r).toEqual({ acquired: false, reason: 'pending_old_attempt' });
    }
  });

  it('CAS 再入: 旧 attempt の照会が null (照会不能) なら再入しない (二重課金の最終防壁)', async () => {
    // getAttemptStatus が null = 「旧 attempt が生きているか不明」。fail-closed で再入せず、
    // 新 idempotencyKey を発行しない。これが崩れると旧 attempt 生存時に 2 本目が走る。
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: 'att-1', idempotency_key: 'k1', claimed_at: NOW, resolved_at: NOW,
    });
    const { api } = createFakeApi({ attemptStatus: null });
    const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    expect(r).toEqual({ acquired: false, reason: 'pending_old_attempt' });
    // claim は再獲得されず attempt_no も据え置き
    expect(state.claims.get(key(GID, '3'))!.attempt_no).toBe(1);
    expect(state.claims.get(key(GID, '3'))!.status).toBe('failed');
  });

  it('CAS 再入: 旧 attempt が succeeded なら claim を succeeded 昇格し発行しない', async () => {
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: 'att-1', idempotency_key: 'k1', claimed_at: NOW, resolved_at: NOW,
    });
    const { api } = createFakeApi({ attemptStatus: 'succeeded' });
    const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    expect(r).toEqual({ acquired: false, reason: 'promoted_succeeded' });
    expect(state.claims.get(key(GID, '3'))!.status).toBe('succeeded');
  });

  it('CAS 再入: failed 確定後は attempt_no++ + 新 key で再獲得できる', async () => {
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: 'att-1', idempotency_key: 'k1', claimed_at: NOW, resolved_at: NOW,
    });
    const { api } = createFakeApi({ attemptStatus: 'failed' });
    const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.claim.attempt_no).toBe(2);
      expect(r.claim.idempotency_key).toBe(await buildIdempotencyKey(GID, '3', 2));
      expect(r.claim.attempt_gid).toBeNull();
    }
  });

  it('THROTTLED next_tick 再入は attempt_no 据え置き・同一 key (§6.5 明示例外)', async () => {
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed_no_attempt', retry_policy: 'next_tick',
      attempt_no: 2, attempt_gid: null, idempotency_key: 'same-key', claimed_at: NOW, resolved_at: NOW,
    });
    const { api } = createFakeApi();
    const r = await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.claim.attempt_no).toBe(2);
      expect(r.claim.idempotency_key).toBe('same-key');
    }
  });

  it('並行競合: 同一サイクルへの 2 者は INSERT の PK 排他で勝者 1', async () => {
    const state = freshState();
    const { api } = createFakeApi();
    const db = createFakeDb(state);
    const r1 = await acquireClaim(db, api, GID, '3', NOW);
    const r2 = await acquireClaim(db, api, GID, '3', NOW);
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(false);
  });
});

// ─── 同期エラーレーン ───

describe('applySyncError (§6.5)', () => {
  async function withAttempting(state: FakeState) {
    const { api } = createFakeApi();
    await acquireClaim(createFakeDb(state), api, GID, '3', NOW);
    return state;
  }

  it('THROTTLED → failed_no_attempt + next_tick', async () => {
    const state = await withAttempting(freshState());
    const lane = await applySyncError(createFakeDb(state), GID, '3', 'THROTTLED', NOW);
    expect(lane).toBe('next_tick');
    const c = state.claims.get(key(GID, '3'))!;
    expect(c.status).toBe('failed_no_attempt');
    expect(c.retry_policy).toBe('next_tick');
  });

  it('BCCBED / 未知 → hold (自動再発行なし: claimBlocksIssue が true)', async () => {
    for (const code of ['BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE', 'SOMETHING_NEW']) {
      const state = await withAttempting(freshState());
      const lane = await applySyncError(createFakeDb(state), GID, '3', code, NOW);
      expect(lane).toBe('hold');
      const c = state.claims.get(key(GID, '3'))!;
      expect(c.retry_policy).toBe('hold');
      expect(claimBlocksIssue(c)).toBe(true);
    }
  });

  it('CONTRACT_PAUSED → abandoned + status=paused。dunning は exhausted 以外 none へ', async () => {
    const state = await withAttempting(
      freshState({ contracts: new Map([[GID, contract({ dunning_state: 'retry_wait', next_retry_date: TODAY })]]) }),
    );
    const lane = await applySyncError(createFakeDb(state), GID, '3', 'CONTRACT_PAUSED', NOW);
    expect(lane).toBe('abandoned_state_resync');
    expect(state.claims.get(key(GID, '3'))!.status).toBe('abandoned');
    expect(state.contracts.get(GID)).toMatchObject({ status: 'paused', dunning_state: 'none' });
  });

  it('CONTRACT_PAUSED は exhausted (システム起因 S5) を保持する (§6.4 復旧を残す)', async () => {
    const state = await withAttempting(
      freshState({ contracts: new Map([[GID, contract({ dunning_state: 'exhausted' })]]) }),
    );
    await applySyncError(createFakeDb(state), GID, '3', 'CONTRACT_PAUSED', NOW);
    expect(state.contracts.get(GID)).toMatchObject({ status: 'paused', dunning_state: 'exhausted' });
  });

  it('CONTRACT_TERMINATED → abandoned + status=cancelled + dunning 全リセット', async () => {
    const state = await withAttempting(
      freshState({ contracts: new Map([[GID, contract({ dunning_state: 'await_card' })]]) }),
    );
    const lane = await applySyncError(createFakeDb(state), GID, '3', 'CONTRACT_TERMINATED', NOW);
    expect(lane).toBe('abandoned_state_resync');
    expect(state.contracts.get(GID)).toMatchObject({ status: 'cancelled', dunning_state: 'none' });
  });
});

// ─── resolveBillableCycle ───

describe('resolveBillableCycle (§4.0)', () => {
  it('最古の未解決サイクルを選び、将来日は対象外', async () => {
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 2, expectedDate: '2026-07-20T15:00:00Z', billed: true, skipped: false },
      { cycleIndex: 4, expectedDate: '2026-08-22T15:00:00Z', billed: false, skipped: false },
      { cycleIndex: 3, expectedDate: '2026-07-22T15:00:00Z', billed: false, skipped: false },
    ];
    const state = freshState();
    const { api } = createFakeApi({ cycles });
    const r = await resolveBillableCycle(createFakeDb(state), api, contract(), TODAY, NOW, noAlert);
    expect(r.cycle?.cycleIndex).toBe(3);

    const future = await resolveBillableCycle(
      createFakeDb(state),
      createFakeApi({ cycles: [cycles[1]!] }).api,
      contract(), TODAY, NOW, noAlert,
    );
    expect(future.cycle).toBeNull();
  });

  it('I-6: 14日超過は放棄 (claim abandoned + skip + 次アンカー schedule + alert) し、retry_wait の dunning を解放する', async () => {
    const state = freshState({ contracts: new Map([[GID, contract({ dunning_state: 'retry_wait', next_retry_date: TODAY })]]) });
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: null, idempotency_key: 'k', claimed_at: NOW, resolved_at: NOW,
    });
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false }, // 21日超過
      { cycleIndex: 4, expectedDate: '2026-08-01T15:00:00Z', billed: false, skipped: false },
    ];
    const alerts: string[] = [];
    const { api, calls } = createFakeApi({ cycles });
    const r = await resolveBillableCycle(
      createFakeDb(state), api,
      contract({ dunning_state: 'retry_wait' }), TODAY, NOW,
      (m) => { alerts.push(m); },
    );
    expect(r).toEqual({ cycle: null, abandonedStale: true });
    expect(state.claims.get(key(GID, '3'))!.status).toBe('abandoned');
    expect(calls.some((c2) => c2.fn === 'setCycleSkip' && c2.args[2] === true)).toBe(true);
    expect(calls.some((c2) => c2.fn === 'scheduleCycleDate')).toBe(true);
    expect(state.contracts.get(GID)!.dunning_state).toBe('none');
    expect(alerts.length).toBe(1);
  });

  it('I-6: attempt_gid 不明の attempting claim は abandoned にしない (二重課金防止・webhooks 側と対称)', async () => {
    // createAttempt が ok だが gid 欠落 (stuck_unrecorded) の claim。Shopify 側に attempt が
    // 生きているか不明なので、14日超過でも abandoned にせず attempting のまま残す。
    // abandoned にすると unskip 等で引き戻された際に acquireClaim の gid 照会がスキップされ
    // 新 key で二重発行しうる。
    const state = freshState({ contracts: new Map([[GID, contract()]]) });
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'attempting', retry_policy: 'none',
      attempt_no: 1, attempt_gid: null, idempotency_key: 'k', claimed_at: NOW, resolved_at: null,
    });
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false }, // 21日超過
    ];
    const { api } = createFakeApi({ cycles });
    const r = await resolveBillableCycle(createFakeDb(state), api, contract(), TODAY, NOW, noAlert);
    expect(r.abandonedStale).toBe(true); // サイクル自体は放棄される (skip される)
    // だが attempt_gid 不明の attempting claim は abandoned に化けない
    expect(state.claims.get(key(GID, '3'))!.status).toBe('attempting');
  });

  it('I-6: attempt_gid を持つ attempting claim は従来どおり abandoned 化する', async () => {
    const state = freshState({ contracts: new Map([[GID, contract()]]) });
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'attempting', retry_policy: 'none',
      attempt_no: 1, attempt_gid: 'gid://shopify/SubscriptionBillingAttempt/9', idempotency_key: 'k',
      claimed_at: NOW, resolved_at: null,
    });
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false },
    ];
    const { api } = createFakeApi({ cycles });
    await resolveBillableCycle(createFakeDb(state), api, contract(), TODAY, NOW, noAlert);
    expect(state.claims.get(key(GID, '3'))!.status).toBe('abandoned');
  });

  it('I-6 境界: ちょうど 14 日は放棄しない (>14 のみ)', async () => {
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-08T15:00:00Z', billed: false, skipped: false }, // 14日前 (JST 7/9)
    ];
    const { api } = createFakeApi({ cycles });
    const r = await resolveBillableCycle(createFakeDb(freshState()), api, contract(), TODAY, NOW, noAlert);
    expect(r.abandonedStale).toBe(false);
    expect(r.cycle?.cycleIndex).toBe(3);
  });

  it('challenged 契約の I-6 放棄は dunning_state を触らない (§5.2 の管轄)', async () => {
    const state = freshState({ contracts: new Map([[GID, contract({ dunning_state: 'challenged' })]]) });
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false },
    ];
    const { api } = createFakeApi({ cycles });
    await resolveBillableCycle(createFakeDb(state), api, contract({ dunning_state: 'challenged' }), TODAY, NOW, noAlert);
    expect(state.contracts.get(GID)!.dunning_state).toBe('challenged');
  });
});

// ─── issueForContract (I-2 順序) / resync / listDueContracts ───

describe('issueForContract (I-2)', () => {
  it('resync → resolve → claim → 発行の順で成功し attempt_gid を記録する', async () => {
    const state = freshState();
    const { api, calls } = createFakeApi();
    const r = await issueForContract(createFakeDb(state), api, contract(), TODAY, NOW, noAlert);
    expect(r).toBe('issued');
    const c = state.claims.get(key(GID, '3'))!;
    expect(c.status).toBe('attempting');
    expect(c.attempt_gid).toBe('gid://shopify/SubscriptionBillingAttempt/9');
    // createAttempt は claim の idempotency_key で呼ばれる
    const create = calls.find((c2) => c2.fn === 'createAttempt')!;
    expect(create.args[2]).toBe(c.idempotency_key);
    // listCycles は resync の 1 回に統合 (resolve は preloaded cycles を受け取る — R2 対応)
    expect(calls.filter((c2) => c2.fn === 'listCycles').length).toBe(1);
  });

  it('claim がブロック (attempting 既存) なら発行しない', async () => {
    const state = freshState();
    const { api, calls } = createFakeApi();
    const db = createFakeDb(state);
    await issueForContract(db, api, contract(), TODAY, NOW, noAlert);
    const before = calls.filter((c2) => c2.fn === 'createAttempt').length;
    const r2 = await issueForContract(db, api, contract(), TODAY, NOW, noAlert);
    expect(r2).toBe('claim_blocked');
    expect(calls.filter((c2) => c2.fn === 'createAttempt').length).toBe(before);
  });

  it('同期 userError は §6.5 レーンに落ちる (THROTTLED→next_tick / BCCBED→hold)', async () => {
    const s1 = freshState();
    const r1 = await issueForContract(
      createFakeDb(s1),
      createFakeApi({ createResult: { ok: false, userErrorCode: 'THROTTLED' } }).api,
      contract(), TODAY, NOW, noAlert,
    );
    expect(r1).toBe('sync_error_next_tick');
    expect(s1.claims.get(key(GID, '3'))!.retry_policy).toBe('next_tick');

    const alerts: string[] = [];
    const s2 = freshState();
    const r2 = await issueForContract(
      createFakeDb(s2),
      createFakeApi({ createResult: { ok: false, userErrorCode: 'BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE' } }).api,
      contract(), TODAY, NOW, (m) => { alerts.push(m); },
    );
    expect(r2).toBe('sync_error_hold');
    expect(alerts.length).toBe(1);
  });
});

describe('resyncContractCycle / listDueContracts', () => {
  it('resync は最古未解決サイクルで cache を更新する', async () => {
    const state = freshState();
    const { api } = createFakeApi({
      cycles: [{ cycleIndex: 5, expectedDate: '2026-08-22T15:00:00Z', billed: false, skipped: false }],
    });
    const r = await resyncContractCycle(createFakeDb(state), api, GID, NOW);
    expect(r).toMatchObject({ cycleIndex: 5, scheduledDate: '2026-08-23' });
    expect(state.contracts.get(GID)!.current_cycle_index).toBe(5);
  });

  it('§6.5 hold claim を持つサイクルは resolve の対象外 (I-6 も発動しない = ops 管轄を自動放棄しない)', async () => {
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed_no_attempt', retry_policy: 'hold',
      attempt_no: 1, attempt_gid: null, idempotency_key: 'k', claimed_at: NOW, resolved_at: NOW,
    });
    // 21 日超過の stale サイクルでも hold なら放棄しない
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false },
    ];
    const { api, calls } = createFakeApi({ cycles });
    const r = await resolveBillableCycle(createFakeDb(state), api, contract(), TODAY, NOW, noAlert);
    expect(r).toEqual({ cycle: null, abandonedStale: false });
    expect(state.claims.get(key(GID, '3'))!.status).toBe('failed_no_attempt');
    expect(calls.some((c2) => c2.fn === 'setCycleSkip')).toBe(false);
  });

  it('I-6 で scheduleEdit/skip が失敗したら cadence_repair_needed=1 + alert (§4.0)', async () => {
    const state = freshState();
    const cycles: BillingCycleInfo[] = [
      { cycleIndex: 3, expectedDate: '2026-07-01T15:00:00Z', billed: false, skipped: false },
      { cycleIndex: 4, expectedDate: '2026-08-01T15:00:00Z', billed: false, skipped: false },
    ];
    const alerts: string[] = [];
    const { api } = createFakeApi({ cycles });
    api.setCycleSkip = async () => ({ ok: false, error: 'boom' });
    await resolveBillableCycle(createFakeDb(state), api, contract(), TODAY, NOW, (m) => { alerts.push(m); });
    expect((state.contracts.get(GID) as { cadence_repair_needed?: number }).cadence_repair_needed).toBe(1);
    expect(alerts.some((m) => m.includes('repair'))).toBe(true);
  });

  it('CONTRACT_PAUSED の同期エラーで契約 status が paused へ再同期される (翌日の due 再列挙を止める)', async () => {
    const state = freshState();
    const r = await issueForContract(
      createFakeDb(state),
      createFakeApi({ createResult: { ok: false, userErrorCode: 'CONTRACT_PAUSED' } }).api,
      contract(), TODAY, NOW, noAlert,
    );
    expect(r).toBe('sync_error_state_resync');
    expect(state.contracts.get(GID)!.status).toBe('paused');
    const due = await listDueContracts(createFakeDb(state), TODAY);
    expect(due.length).toBe(0);
  });

  it('BCCBED hold で契約は ops_hold になり due 対象から外れる (毎 tick 空撃ちを止める)', async () => {
    const state = freshState();
    await issueForContract(
      createFakeDb(state),
      createFakeApi({ createResult: { ok: false, userErrorCode: 'BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE' } }).api,
      contract(), TODAY, NOW, noAlert,
    );
    expect(state.contracts.get(GID)!.dunning_state).toBe('ops_hold');
    const due = await listDueContracts(createFakeDb(state), TODAY);
    expect(due.length).toBe(0);
  });

  it('quarantine 収載の契約は due 候補から除外される (SQL の NOT EXISTS を検証)', async () => {
    const state = freshState();
    // 通常なら due になる契約 (active/none/scheduled<=today)
    expect((await listDueContracts(createFakeDb(state), TODAY)).map((c) => c.contract_gid)).toEqual([GID]);
    // quarantine に入れると候補から外れる
    state.quarantine = [GID];
    expect((await listDueContracts(createFakeDb(state), TODAY)).length).toBe(0);
  });

  it('§4.0 step 4: 対象サイクルの claim 取得前に旧サイクルの failed claim が abandoned 化される', async () => {
    const state = freshState();
    state.claims.set(key(GID, '2'), {
      contract_gid: GID, cycle_key: '2', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: null, idempotency_key: 'k2', claimed_at: NOW, resolved_at: NOW,
    });
    const r = await issueForContract(createFakeDb(state), createFakeApi().api, contract(), TODAY, NOW, noAlert);
    expect(r).toBe('issued');
    expect(state.claims.get(key(GID, '2'))!.status).toBe('abandoned');
  });

  it('CAS 照会昇格は promoted_succeeded outcome として可視化される', async () => {
    const state = freshState();
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'failed', retry_policy: 'none',
      attempt_no: 1, attempt_gid: 'att-1', idempotency_key: 'k1', claimed_at: NOW, resolved_at: NOW,
    });
    const r = await issueForContract(
      createFakeDb(state), createFakeApi({ attemptStatus: 'succeeded' }).api,
      contract(), TODAY, NOW, noAlert,
    );
    expect(r).toBe('promoted_succeeded');
  });

  it('listDueContracts: 現在サイクルにブロック claim がある契約は除外 + limit cap', async () => {
    const state = freshState({
      contracts: new Map([
        [GID, contract()],
        ['gidB', contract({ contract_gid: 'gidB' })],
        ['gidC', contract({ contract_gid: 'gidC' })],
      ]),
    });
    state.claims.set(key(GID, '3'), {
      contract_gid: GID, cycle_key: '3', status: 'attempting', retry_policy: 'none',
      attempt_no: 1, attempt_gid: null, idempotency_key: 'k', claimed_at: NOW, resolved_at: null,
    });
    const due = await listDueContracts(createFakeDb(state), TODAY);
    expect(due.map((c) => c.contract_gid).sort()).toEqual(['gidB', 'gidC']);
    const capped = await listDueContracts(createFakeDb(state), TODAY, 1);
    expect(capped.length).toBe(1);
  });

  it('due 述語: active ∧ (none∧scheduled<=today / retry_wait∧retry<=today)、移行窓 phase は除外', async () => {
    const state = freshState({
      contracts: new Map([
        [GID, contract()],
        ['gid2', contract({ contract_gid: 'gid2', dunning_state: 'retry_wait', next_retry_date: TODAY, current_cycle_scheduled_date: null })],
        ['gid3', contract({ contract_gid: 'gid3', status: 'paused' })],
        ['gid4', contract({ contract_gid: 'gid4', dunning_state: 'await_card' })],
        ['gid5', contract({ contract_gid: 'gid5' })],
        ['gid6', contract({ contract_gid: 'gid6', current_cycle_scheduled_date: '2026-08-01' })],
      ]),
      snapshots: [{ own_contract_gid: 'gid5', phase: 'billing_aligned' }],
    });
    const due = await listDueContracts(createFakeDb(state), TODAY);
    const gids = due.map((c) => c.contract_gid).sort();
    expect(gids).toEqual([GID, 'gid2'].sort());
  });
});

// ─── tick wiring (processOwnBilling の due 発行配線) ───

describe('processOwnBilling wiring (§5.1)', () => {
  const GATE_ENV = {
    SELF_BILLING_ENABLED: 'true',
    SELF_BILLING_ARMED_AT: '2026-07-22T00:00:00Z',
    SELF_BILLING_ALLOWLIST: 'ALL',
  };
  // JST 06:00 = UTC 21:00 (前日)
  const IN_WINDOW = Date.parse('2026-07-22T21:00:00Z');

  it('isIssueWindow は JST 05:00-07:59 のみ true (境界 4 点)', () => {
    expect(isIssueWindow(Date.parse('2026-07-22T19:59:00Z'))).toBe(false); // JST 04:59
    expect(isIssueWindow(Date.parse('2026-07-22T20:00:00Z'))).toBe(true);  // JST 05:00
    expect(isIssueWindow(Date.parse('2026-07-22T22:59:00Z'))).toBe(true);  // JST 07:59
    expect(isIssueWindow(Date.parse('2026-07-22T23:00:00Z'))).toBe(false); // JST 08:00
  });

  it('発行窓内 + api 注入で issued が outcomes に集計される', async () => {
    const state = freshState();
    const { api } = createFakeApi();
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV },
      { api, nowMs: IN_WINDOW, alert: noAlert },
    );
    expect(r.dueContracts).toBe(1);
    expect(r.issueOutcomes).toEqual({ issued: 1 });
    expect(state.claims.get(key(GID, '3'))!.status).toBe('attempting');
  });

  it('allowlist 非収載は gate_denied: claim を作らず resolve (listCycles) も呼ばない (§10.1⑨)', async () => {
    const state = freshState();
    const { api, calls } = createFakeApi();
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV, SELF_BILLING_ALLOWLIST: 'gid://shopify/SubscriptionContract/999' },
      { api, nowMs: IN_WINDOW, alert: noAlert },
    );
    expect(r.issueOutcomes).toEqual({ gate_denied: 1 });
    expect(state.claims.size).toBe(0);
    expect(calls.filter((c2) => c2.fn === 'listCycles').length).toBe(0);
  });

  it('発行窓外は発行系を実行しない (issueOutcomes 未定義)', async () => {
    const state = freshState();
    const { api, calls } = createFakeApi();
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV },
      { api, nowMs: Date.parse('2026-07-22T12:00:00Z'), alert: noAlert }, // JST 21:00
    );
    expect(r.issueOutcomes).toBeUndefined();
    expect(calls.length).toBe(0);
  });

  it('api 未注入 (本番 step 2 時点) は gate ON でも発行系を実行しない', async () => {
    const state = freshState();
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV },
      { nowMs: IN_WINDOW },
    );
    expect(r.issueOutcomes).toBeUndefined();
    expect(state.claims.size).toBe(0);
  });

  it('1 契約の throw は隔離され後続契約は発行される (outcomes.error 集計)', async () => {
    const state = freshState({
      contracts: new Map([
        [GID, contract()],
        ['gidB', contract({ contract_gid: 'gidB' })],
      ]),
    });
    const { api } = createFakeApi();
    const origList = api.listCycles.bind(api);
    let first = true;
    api.listCycles = async (gid) => {
      // 最初の契約の resync で決定的に throw させる
      if (gid === GID && first) { first = false; throw new Error('deterministic failure'); }
      return origList(gid);
    };
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV },
      { api, nowMs: IN_WINDOW, alert: noAlert },
    );
    expect(r.issueOutcomes!.error).toBe(1);
    expect(r.issueOutcomes!.issued).toBe(1);
  });
});

// ─── R2 修正の回帰テスト ───

describe('R2 修正 (starvation / interval guard / ok-without-gid)', () => {
  const GATE_ENV = {
    SELF_BILLING_ENABLED: 'true',
    SELF_BILLING_ARMED_AT: '2026-07-22T00:00:00Z',
  };
  const IN_WINDOW = Date.parse('2026-07-22T21:00:00Z');

  it('gate_denied 契約は発行予算を消費しない — allowlist 収載契約が飢餓しない (R2 HIGH)', async () => {
    // 候補の先頭側に allowlist 非収載を 4 件並べても、収載契約に発行が届く
    const contracts = new Map<string, ReturnType<typeof contract>>();
    for (let i = 1; i <= 4; i++) {
      contracts.set(`gid://shopify/SubscriptionContract/${i}`, contract({ contract_gid: `gid://shopify/SubscriptionContract/${i}` }));
    }
    contracts.set(GID, contract());
    const state = freshState({ contracts });
    const { api } = createFakeApi();
    const r = await processOwnBilling(
      { DB: createFakeDb(state), ...GATE_ENV, SELF_BILLING_ALLOWLIST: GID },
      { api, nowMs: IN_WINDOW, alert: noAlert },
    );
    expect(r.issueOutcomes!.gate_denied).toBe(4);
    expect(r.issueOutcomes!.issued).toBe(1);
    expect(r.processedContracts).toBe(1);
  });

  it('interval_unit が DAY 以外は unsupported_interval で発行 skip + alert (§0 防衛)', async () => {
    const state = freshState({
      contracts: new Map([[GID, contract({ interval_unit: 'WEEK' })]]),
    });
    const alerts: string[] = [];
    const r = await issueForContract(
      createFakeDb(state), createFakeApi().api,
      contract({ interval_unit: 'WEEK' }), TODAY, NOW, (m) => { alerts.push(m); },
    );
    expect(r).toBe('unsupported_interval');
    expect(state.claims.size).toBe(0);
    expect(alerts.length).toBe(1);
  });

  it('createAttempt ok だが attemptGid 欠落は attempting 維持 + stuck_unrecorded (二重課金構造を作らない)', async () => {
    const state = freshState();
    const alerts: string[] = [];
    const r = await issueForContract(
      createFakeDb(state),
      createFakeApi({ createResult: { ok: true } }).api,
      contract(), TODAY, NOW, (m) => { alerts.push(m); },
    );
    expect(r).toBe('stuck_unrecorded');
    const c = state.claims.get(key(GID, '3'))!;
    expect(c.status).toBe('attempting'); // failed_no_attempt に落とさない
    expect(alerts.length).toBe(1);
  });
});
