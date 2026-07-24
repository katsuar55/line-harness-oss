/**
 * own-billing-notify (WI-4 step 3) — 設計書 §2 チャネル規則 / §3 冪等マーカー /
 * §5.6 配送窓 / §6.3 challenged deadline の unit。§10.3「email fallback 分岐」該当。
 *
 * 重点:
 *   - enqueue 冪等: 同一 (contract, cycle, attempt, kind) は 1 通。送信済みなら積み直さない
 *   - 配送窓 (JST 10:00-19:59) 外では 1 通も送らない
 *   - **LINE → email fallback**: 未連携 / LINE 失敗・skip (ブロック) の両方で email に落ちる
 *   - 到達手段なしは即 abandoned (無限リトライを作らない)
 *   - challenge_link の 72h 期限は「送信成功時」に初めて設定される (配送待ちを顧客から引かない)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dispatchMock = vi.fn();
vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
}));

import {
  enqueueNotice,
  dispatchQueuedNotices,
  isNoticeWindow,
  buildNoticeText,
  buildNoticeSubject,
  formatJpDate,
  MAX_DISPATCH_ATTEMPTS,
  MAX_NOTICE_PER_TICK,
} from '../services/own-billing-notify.js';

const GID = 'gid://shopify/SubscriptionContract/111';
const CUSTOMER = '555';
const NOW_IN_WINDOW = Date.parse('2026-08-05T02:00:00Z'); // JST 11:00
const NOW_OUT_WINDOW = Date.parse('2026-08-05T20:00:00Z'); // JST 05:00 翌日
const NOW_ISO = '2026-08-05T11:00:00.000+09:00';

interface QueueRow {
  id: number;
  contract_gid: string;
  cycle_key: string;
  attempt_no: number;
  kind: string;
  shopify_customer_id: string;
  payload_json: string;
  status: string;
  channel: string | null;
  dispatch_attempts: number;
  last_error: string | null;
  queued_at: string;
  sending_at: string | null;
  sent_at: string | null;
}

interface SubscriberRow {
  id: string;
  email: string;
  is_active: number;
  transactional_only: number;
  consent_source: string | null;
}

interface State {
  queue: QueueRow[];
  notices: Set<string>;
  customerEmail: string | null;
  friend: { id: string; line_user_id: string } | null;
  contracts: Map<string, { status: string; dunning_state: string; dunning_deadline_at: string | null }>;
  subscribers: SubscriberRow[];
  /** transactional_only を立て直した記録 (consent 変更の可観測性) */
  subscriberUpdates: Array<{ id: string; transactional_only: number }>;
  /** 配送直前に読まれる claim の状態。'succeeded' なら失敗通知は破棄される */
  claimStatus: string | null;
  /** (contract_gid|cycle_key) 単位の claim 状態 (取り違え検出テスト用) */
  claimStatusByKey?: Record<string, string>;
  seq: number;
}

function freshState(): State {
  return {
    queue: [],
    notices: new Set(),
    customerEmail: 'buyer@example.com',
    friend: { id: 'f1', line_user_id: 'U1' },
    contracts: new Map([[GID, { status: 'active', dunning_state: 'challenged', dunning_deadline_at: null }]]),
    subscribers: [],
    subscriberUpdates: [],
    claimStatus: 'failed',
    seq: 0,
  };
}

function createFakeDb(state: State): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM own_billing_notices')) {
                const k = `${args[0]}|${args[1]}|${args[2]}|${args[3]}`;
                return state.notices.has(k) ? { x: 1 } : null;
              }
              // 宛先解決は **WHERE 述語を尊重する** (顧客 ID 取り違えを検出できるように)
              if (sql.includes('FROM shopify_customers')) {
                return args[0] === CUSTOMER ? { email: state.customerEmail } : { email: null };
              }
              // 契約行が無い gid (予算テストの `${GID}-N`) は null を返す
              if (sql.includes('FROM own_sub_contracts') && !state.contracts.has(String(args[0]))) {
                return null;
              }
              if (sql.includes('FROM friends')) {
                if (args[0] !== CUSTOMER) return null;
                return state.friend
                  ? { id: state.friend.id, line_user_id: state.friend.line_user_id }
                  : null;
              }
              // 配送直前の再検証 (支払済み / dunning 解除済みなら失敗通知を破棄する)。
              // **(contract_gid, cycle_key) で引く** = bind 順の取り違え回帰を検出できる
              // (採点 R8 test-integrity)。per-key があればそちらを優先、無ければ従来の単一値。
              if (sql.includes('SELECT status FROM billing_cycle_claims')) {
                const perKey = state.claimStatusByKey?.[`${args[0]}|${args[1]}`];
                if (perKey !== undefined) return { status: perKey };
                return state.claimStatus === null ? null : { status: state.claimStatus };
              }
              if (sql.includes('SELECT status, dunning_state FROM own_sub_contracts')) {
                const c = state.contracts.get(String(args[0]));
                return c ? { status: c.status, dunning_state: c.dunning_state } : null;
              }
              // delivery_notice の配送直前再検証 (status のみ)
              if (sql.includes('SELECT status FROM own_sub_contracts')) {
                const c = state.contracts.get(String(args[0]));
                return c ? { status: c.status } : null;
              }
              if (sql.includes('FROM email_subscribers WHERE email')) {
                return state.subscribers.find((s) => s.email === args[0]) ?? null;
              }
              if (sql.includes('FROM email_subscribers WHERE id')) {
                return state.subscribers.find((s) => s.id === args[0]) ?? null;
              }
              throw new Error(`unexpected first(): ${sql}`);
            },
            async all() {
              if (sql.includes('FROM own_billing_notice_queue')) {
                const limit = Number(args[0] ?? 5);
                // 実 D1 は行の**コピー**を返す。live 参照を返すと、後続の CAS UPDATE が
                // 呼び出し側の手元 row まで書き換えてしまい dispatch_attempts が
                // 1 ずれる (= 本番と違う挙動でテストが嘘をつく)。必ず複製する。
                return {
                  results: state.queue
                    .filter((r) => r.status === 'queued')
                    .slice(0, limit)
                    .map((r) => ({ ...r })),
                };
              }
              throw new Error(`unexpected all(): ${sql}`);
            },
            async run() {
              if (sql.includes('INSERT INTO own_billing_notice_queue')) {
                const dup = state.queue.some(
                  (r) =>
                    r.contract_gid === args[0] &&
                    r.cycle_key === args[1] &&
                    r.attempt_no === args[2] &&
                    r.kind === args[3],
                );
                if (dup) throw new Error('UNIQUE constraint failed');
                state.queue.push({
                  id: ++state.seq,
                  contract_gid: String(args[0]),
                  cycle_key: String(args[1]),
                  attempt_no: Number(args[2]),
                  kind: String(args[3]),
                  shopify_customer_id: String(args[4]),
                  payload_json: String(args[5]),
                  status: 'queued',
                  channel: null,
                  dispatch_attempts: 0,
                  last_error: null,
                  queued_at: String(args[6]),
                  sending_at: null,
                  sent_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'sending'")) {
                // bind は (nowIso, id) の順
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'queued');
                if (!row) return { meta: { changes: 0 } };
                row.status = 'sending';
                row.sending_at = String(args[0]);
                row.dispatch_attempts += 1;
                return { meta: { changes: 1 } };
              }
              // 'sending' 固着行の回収 (reaper) — **sending_at** で判定する
              if (sql.includes("SET status = 'queued'") && sql.includes("status = 'sending'")) {
                let n = 0;
                for (const r of state.queue) {
                  if (r.status === 'sending' && r.sending_at !== null && r.sending_at <= String(args[0])) {
                    r.status = 'queued';
                    n += 1;
                  }
                }
                return { meta: { changes: n } };
              }
              // abandoned 行の復活 (enqueue の UNIQUE 衝突時)
              if (sql.includes("SET status = 'queued'") && sql.includes("status = 'abandoned'")) {
                const row = state.queue.find(
                  (r) =>
                    r.contract_gid === args[2] && r.cycle_key === args[3] &&
                    r.attempt_no === Number(args[4]) && r.kind === args[5] && r.status === 'abandoned',
                );
                if (!row) return { meta: { changes: 0 } };
                row.status = 'queued';
                row.queued_at = String(args[0]);
                row.payload_json = String(args[1]);
                row.dispatch_attempts = 0;
                row.last_error = null;
                row.sent_at = null;
                return { meta: { changes: 1 } };
              }
              // markSent は channel を書く (bind: channel, nowIso, id)。
              // real は `AND status = 'sending'` を持つ (reaper 競合対策) ので fake も尊重する
              if (sql.includes("SET status = 'sent'") && sql.includes('channel = ?')) {
                const row = state.queue.find((r) => r.id === args[2] && r.status === 'sending');
                if (row) {
                  row.status = 'sent';
                  row.channel = String(args[0]);
                  row.sent_at = String(args[1]);
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              // 送信済みマーカー検出時の 'sent' 落とし込み (bind: nowIso, id)
              if (sql.includes("SET status = 'sent'")) {
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'sending');
                if (row) {
                  row.status = 'sent';
                  row.sent_at = String(args[0]);
                }
                return { meta: { changes: row ? 1 : 0 } };
              }
              if (sql.includes('INSERT INTO email_subscribers')) {
                state.subscribers.push({
                  id: String(args[0]),
                  email: String(args[2]),
                  is_active: Number(args[3]),
                  transactional_only: Number(args[4]),
                  consent_source: args[5] === null ? null : String(args[5]),
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE email_subscribers SET transactional_only = 1')) {
                state.subscriberUpdates.push({ id: String(args[1]), transactional_only: 1 });
                const s = state.subscribers.find((x) => x.id === args[1]);
                if (s) s.transactional_only = 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes('UPDATE email_subscribers')) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INSERT OR IGNORE INTO own_billing_notices')) {
                state.notices.add(`${args[0]}|${args[1]}|${args[2]}|${args[3]}`);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('SET dunning_deadline_at')) {
                const c = state.contracts.get(String(args[2]));
                // 条件付き UPDATE: dunning_state='challenged' のときだけ書く
                if (c && c.dunning_state === 'challenged') c.dunning_deadline_at = String(args[0]);
                return { meta: { changes: c ? 1 : 0 } };
              }
              if (sql.includes("last_error = 'stale'")) {
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'sending');
                if (row) {
                  row.status = 'abandoned';
                  row.last_error = 'stale';
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes("last_error = 'superseded_by_state'")) {
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'sending');
                if (row) {
                  row.status = 'abandoned';
                  row.last_error = 'superseded_by_state';
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes("last_error = 'superseded_by_success'")) {
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'sending');
                if (row) {
                  row.status = 'abandoned';
                  row.last_error = 'superseded_by_success';
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes("last_error = 'no_reachable_channel'")) {
                const row = state.queue.find((r) => r.id === args[1] && r.status === 'sending');
                if (row) {
                  row.status = 'abandoned';
                  row.last_error = 'no_reachable_channel';
                }
                return { meta: { changes: 1 } };
              }
              if (sql.includes('SET status = ?, last_error = ?')) {
                const row = state.queue.find((r) => r.id === args[4] && r.status === 'sending');
                if (row) {
                  row.status = String(args[0]);
                  row.last_error = String(args[1]);
                }
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected run(): ${sql}`);
            },
          };
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

const lineDeps = { lineClient: {} as never };
const bothDeps = {
  lineClient: {} as never,
  emailProvider: {} as never,
  emailRenderer: {} as never,
  emailFrom: 'a@b.c',
};

beforeEach(() => {
  dispatchMock.mockReset();
});

describe('isNoticeWindow (§5.6 JST 10:00-19:59)', () => {
  it('窓の内外を JST で判定する', () => {
    expect(isNoticeWindow(Date.parse('2026-08-05T00:59:00Z'))).toBe(false); // JST 09:59
    expect(isNoticeWindow(Date.parse('2026-08-05T01:00:00Z'))).toBe(true); // JST 10:00
    expect(isNoticeWindow(Date.parse('2026-08-05T10:59:00Z'))).toBe(true); // JST 19:59
    expect(isNoticeWindow(Date.parse('2026-08-05T11:00:00Z'))).toBe(false); // JST 20:00
  });
});

describe('enqueueNotice (§3 冪等)', () => {
  it('同一キーの二重 enqueue は duplicate になり 1 行のまま', async () => {
    const state = freshState();
    const db = createFakeDb(state);
    const input = {
      contractGid: GID,
      cycleKey: '2',
      attemptNo: 1,
      kind: 'fail_notice' as const,
      shopifyCustomerId: CUSTOMER,
      payload: {},
    };
    await expect(enqueueNotice(db, input, NOW_ISO)).resolves.toBe('enqueued');
    await expect(enqueueNotice(db, input, NOW_ISO)).resolves.toBe('duplicate');
    expect(state.queue).toHaveLength(1);
  });

  it('送信済みマーカーがあれば積まない (キュー掃除後の再送防止)', async () => {
    const state = freshState();
    state.notices.add(`${GID}|2|1|fail_notice`);
    const db = createFakeDb(state);
    await expect(
      enqueueNotice(
        db,
        { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'fail_notice', shopifyCustomerId: CUSTOMER, payload: {} },
        NOW_ISO,
      ),
    ).resolves.toBe('already_sent');
    expect(state.queue).toHaveLength(0);
  });

  it('attempt_no / kind が違えば別通知として積める', async () => {
    const state = freshState();
    const db = createFakeDb(state);
    const base = { contractGid: GID, cycleKey: '2', shopifyCustomerId: CUSTOMER, payload: {} };
    await enqueueNotice(db, { ...base, attemptNo: 1, kind: 'fail_notice' }, NOW_ISO);
    await enqueueNotice(db, { ...base, attemptNo: 2, kind: 'fail_notice' }, NOW_ISO);
    await enqueueNotice(db, { ...base, attemptNo: 1, kind: 'card_request' }, NOW_ISO);
    expect(state.queue).toHaveLength(3);
  });
});

describe('dispatchQueuedNotices — チャネル規則 (§2)', () => {
  async function seed(state: State, kind = 'fail_notice') {
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: kind as never, shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
  }

  it('配送窓外では 1 通も送らずキューを残す', async () => {
    const state = freshState();
    await seed(state);
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_OUT_WINDOW, NOW_ISO);
    expect(res.window).toBe(false);
    expect(res.picked).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0].status).toBe('queued');
  });

  it('連携済みなら LINE で送り、送信済みマーカーを残す', async () => {
    const state = freshState();
    await seed(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.sentLine).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(state.queue[0]).toMatchObject({ status: 'sent', channel: 'line' });
    expect(state.notices.has(`${GID}|2|1|fail_notice`)).toBe(true);
  });

  it('LINE が skipped (ブロック等) なら email へ fallback する', async () => {
    const state = freshState();
    await seed(state);
    dispatchMock
      .mockResolvedValueOnce({ results: [{ channel: 'line', status: 'skipped', reason: 'blacklisted' }] })
      .mockResolvedValueOnce({ results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 's' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.sentEmail).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(state.queue[0]).toMatchObject({ status: 'sent', channel: 'email' });
  });

  it('LINE が failed でも email へ fallback する', async () => {
    const state = freshState();
    await seed(state);
    dispatchMock
      .mockResolvedValueOnce({ results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 500' }] })
      .mockResolvedValueOnce({ results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 's' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.sentEmail).toBe(1);
  });

  it('未連携 (friend なし) なら最初から email', async () => {
    const state = freshState();
    state.friend = null;
    await seed(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 's' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.sentEmail).toBe(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect((dispatchMock.mock.calls[0][1] as { channel: string }).channel).toBe('email');
  });

  it('subscriber 行が無い顧客にも事務連絡が届く (transactional_only 行を自動作成)', async () => {
    // 本番の email_subscribers は 2 行しかなく、定期便顧客は全員未登録。
    // 行を作らないと dispatcher が no_subscriber で skip し、課金失敗通知が誰にも届かない。
    const state = freshState();
    state.friend = null;
    await seed(state);
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 's' }],
    });
    await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(state.subscribers).toHaveLength(1);
    expect(state.subscribers[0]).toMatchObject({
      email: 'buyer@example.com',
      // marketing 許諾は絶対に与えない (広告配信は is_active=1 が要る)
      is_active: 0,
      transactional_only: 1,
      consent_source: 'own_billing_transactional',
    });
  });

  it('既存 subscriber がいれば行を作らない (配信停止済みを復活させない)', async () => {
    const state = freshState();
    state.friend = null;
    state.subscribers.push({
      id: 'existing',
      email: 'buyer@example.com',
      is_active: 0,
      transactional_only: 0,
      consent_source: 'opt_in_form',
    });
    await seed(state);
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 'existing' }],
    });
    await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    // 新しい行は作らない。**marketing 許諾 (is_active) にも触らない**。
    expect(state.subscribers).toHaveLength(1);
    expect(state.subscribers[0].is_active).toBe(0);
    // transactional_only だけは立て直す (R2 MEDIUM: メルマガ解除者に事務連絡が
    // 黙って届かなくなるのを防ぐ。schema のコメントが明記している意図どおり)
    expect(state.subscribers[0].transactional_only).toBe(1);
  });

  it('LINE も email も到達不能なら即 abandoned (無限リトライを作らない)', async () => {
    const state = freshState();
    state.friend = null;
    state.customerEmail = null;
    await seed(state);
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.noRecipient).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0]).toMatchObject({ status: 'abandoned', last_error: 'no_reachable_channel' });
  });

  it('email 送信失敗は queued に戻り、上限で abandoned になる', async () => {
    const state = freshState();
    state.friend = null;
    await seed(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'email', status: 'failed', error: 'x' }] });
    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i += 1) {
      await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    }
    expect(state.queue[0].status).toBe('abandoned');
    expect(state.queue[0].dispatch_attempts).toBe(MAX_DISPATCH_ATTEMPTS);
  });

  it('CAS で status を取れなかった行は送らない (二重配送の排他)', async () => {
    const state = freshState();
    await seed(state);
    state.queue[0].status = 'sending'; // 他 tick が先に取った状態
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.picked).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('transactional カテゴリで送る (配信停止済みでも事務連絡は届く)', async () => {
    const state = freshState();
    await seed(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect((dispatchMock.mock.calls[0][1] as { category: string }).category).toBe('transactional');
  });
});

describe('採点 R1 回帰 — 通知が消える/届いてはいけない経路', () => {
  async function seedOne(state: State, kind = 'fail_notice') {
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: kind as never, shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
  }

  it('MEDIUM: LINE 一時障害 + email 無し は abandoned にせず再試行に回す', async () => {
    // abandoned にすると queue の UNIQUE で以後の enqueue が duplicate になり通知が永久に消える
    const state = freshState();
    state.customerEmail = null;
    await seedOne(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 500' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.noRecipient).toBe(0);
    expect(state.queue[0].status).toBe('queued');
    expect(state.queue[0].last_error).toBe('all_channels_failed');
  });

  it('MEDIUM: 契約単位 gate (excludelist/quarantine) 中は配送せずキューに残す', async () => {
    const state = freshState();
    await seedOne(state);
    const res = await dispatchQueuedNotices(
      createFakeDb(state),
      { ...lineDeps, canDispatch: () => false },
      NOW_IN_WINDOW,
      NOW_ISO,
    );
    expect(res.gateFrozen).toBe(1);
    expect(res.picked).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0].status).toBe('queued');
  });

  it('HIGH: 配送直前に支払済みと判明したら失敗通知を破棄する', async () => {
    const state = freshState();
    await seedOne(state, 'card_request');
    state.claimStatus = 'succeeded'; // enqueue 後・配送前に決済が通った
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.superseded).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0]).toMatchObject({ status: 'abandoned', last_error: 'superseded_by_success' });
  });

  it('成功を伝える通知 (delivery_notice) は支払済みでも破棄しない', async () => {
    const state = freshState();
    await seedOne(state, 'delivery_notice');
    state.claimStatus = 'succeeded';
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.superseded).toBe(0);
    expect(res.sentLine).toBe(1);
  });

  it('MEDIUM: email 送信先はあるが provider 未注入なら再試行に回す (設定漏れを abandon しない)', async () => {
    const state = freshState();
    state.friend = null;
    await seedOne(state);
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.noRecipient).toBe(0);
    expect(state.queue[0]).toMatchObject({ status: 'queued', last_error: 'email_provider_not_configured' });
  });

  it('LINE 送信には決定的 retryKey が付く (再試行での二重配信防止)', async () => {
    const state = freshState();
    await seedOne(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    const payload = dispatchMock.mock.calls[0][1] as { linePayload?: { retryKey?: string } };
    expect(payload.linePayload?.retryKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('宛先解決は queue 行の shopify_customer_id で引く (他人に送らない)', async () => {
    const state = freshState();
    await enqueueNotice(
      createFakeDb(state),
      {
        contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'fail_notice',
        shopifyCustomerId: 'someone-else', payload: {},
      },
      NOW_ISO,
    );
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    // 別顧客なので friend も email も引けない = 誰にも送らない
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(res.noRecipient).toBe(1);
  });

  it('MEDIUM: 凍結明けの古い通知 (日付あり) は破棄する (過去日の締切を案内しない)', async () => {
    const state = freshState();
    // 日付を含む card_request を積む
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'card_request', shopifyCustomerId: CUSTOMER,
        payload: { deadlineDate: '2026-08-08' } },
      '2026-08-01T11:00:00.000+09:00', // 4 日前
    );
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.stale).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0]).toMatchObject({ status: 'abandoned', last_error: 'stale' });
  });

  it('配送直前の再検証は行の (contract, cycle) で claim を引く (取り違えない)', async () => {
    // 2 契約分の通知を積み、片方の claim だけ succeeded にする
    const state = freshState();
    state.friend = null;
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'fail_notice', shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '3', attemptNo: 1, kind: 'fail_notice', shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
    state.claimStatusByKey = { [`${GID}|2`]: 'succeeded', [`${GID}|3`]: 'failed' };
    state.customerEmail = 'buyer@example.com';
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 's' }],
    });
    const res = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    // cycle 2 (succeeded) は破棄、cycle 3 (failed) は送る
    expect(res.superseded).toBe(1);
    expect(res.sentEmail).toBe(1);
  });

  it('R9 HIGH: resume_notice は配送時に dunning が非 none なら破棄する (再開後に失敗した誤送信を防ぐ)', async () => {
    const state = freshState();
    state.contracts.set(GID, { status: 'active', dunning_state: 'retry_wait', dunning_deadline_at: null });
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: -1, kind: 'resume_notice', shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.superseded).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('R9 LOW: delivery_notice は配送時に解約済みなら継続前提の文面を出さない', async () => {
    const state = freshState();
    state.contracts.set(GID, { status: 'cancelled', dunning_state: 'none', dunning_deadline_at: null });
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'delivery_notice', shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
    let sentText = '';
    dispatchMock.mockImplementation(async (_deps: unknown, input: { linePayload?: { messages: Array<{ text: string }> } }) => {
      sentText = input.linePayload?.messages?.[0]?.text ?? '';
      return { results: [{ channel: 'line', status: 'sent' }] };
    });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(sentText).toContain('停止したまま');
    expect(sentText).not.toContain('次回分から反映');
  });

  it('R7 MEDIUM: 日付を含まない終端 fail_notice は古くても破棄せず送る (停止したのに通知なしを防ぐ)', async () => {
    const state = freshState();
    // isFinal の fail_notice は payload に日付を持たない
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 3, kind: 'fail_notice', shopifyCustomerId: CUSTOMER,
        payload: { isFinal: true } },
      '2026-08-01T11:00:00.000+09:00', // 4 日前 (凍結明け)
    );
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.stale).toBe(0);
    expect(res.sentLine).toBe(1);
  });

  it('LOW: failed と abandoned は排他カウント (heartbeat の二重計上を防ぐ)', async () => {
    const state = freshState();
    state.friend = null;
    await seedOne(state);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'email', status: 'failed', error: 'x' }] });
    let last = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    for (let i = 1; i < MAX_DISPATCH_ATTEMPTS; i += 1) {
      last = await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    }
    // 最終回は abandoned のみに計上され failed には入らない
    expect(last.abandoned).toBe(1);
    expect(last.failed).toBe(0);
  });
});

describe('採点 R2 回帰 — 通知が恒久喪失/陳腐化する経路', () => {
  async function seedOne(state: State, kind = 'fail_notice') {
    return enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: kind as never, shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
  }

  it('HIGH: abandoned になった通知は再 enqueue で復活する (UNIQUE が「二度と積めない」に化けない)', async () => {
    // 凍結が 36h を超えて stale 破棄 → 解除後に再度 enqueue できないと
    // 「停止したのに通知なし」が恒久化する
    const state = freshState();
    await seedOne(state);
    state.queue[0].status = 'abandoned';
    state.queue[0].last_error = 'stale';
    await expect(seedOne(state)).resolves.toBe('revived');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ status: 'queued', dispatch_attempts: 0, last_error: null });
  });

  it('sent 済みの通知は復活しない (二重送信を作らない)', async () => {
    const state = freshState();
    await seedOne(state);
    state.queue[0].status = 'sent';
    await expect(seedOne(state)).resolves.toBe('duplicate');
    expect(state.queue[0].status).toBe('sent');
  });

  it("LOW: 'sending' に固着した行は次 tick で 'queued' に戻る (isolate 強制終了からの回収)", async () => {
    const state = freshState();
    await seedOne(state);
    state.queue[0].status = 'sending';
    // reaper は **sending_at** (CAS 時刻) で判定する。queued_at で判定すると
    // 配送中の行を別 tick が即座に奪って二重送信になる (R3 MEDIUM)。
    state.queue[0].sending_at = '2026-08-05T09:00:00.000+09:00'; // 2 時間前
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.sentLine).toBe(1);
  });

  it('MEDIUM: 配送中 (sending) の行は reaper に奪われない (二重送信の防止)', async () => {
    const state = freshState();
    await seedOne(state);
    state.queue[0].status = 'sending';
    state.queue[0].sending_at = NOW_ISO; // ついさっき CAS した = 配送中
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.picked).toBe(0);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(state.queue[0].status).toBe('sending');
  });

  it('MEDIUM: 送信済みマーカーがあれば配送直前でも送らない (reaper 競合の二重防壁)', async () => {
    const state = freshState();
    await seedOne(state);
    state.notices.add(`${GID}|2|1|fail_notice`); // 実際には送信済み
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(res.superseded).toBe(1);
    expect(state.queue[0].status).toBe('sent');
  });

  it('MEDIUM: dunning が解除済みなら card_request を送らない (更新直後の再依頼を防ぐ)', async () => {
    const state = freshState();
    state.contracts.set(GID, { status: 'active', dunning_state: 'none', dunning_deadline_at: null });
    await seedOne(state, 'card_request');
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.superseded).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('MEDIUM: 解約済み契約への失敗通知も送らない', async () => {
    const state = freshState();
    state.contracts.set(GID, { status: 'cancelled', dunning_state: 'exhausted', dunning_deadline_at: null });
    await seedOne(state, 'fail_notice');
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.superseded).toBe(1);
  });

  it('MEDIUM: メルマガ解除済みの既存 subscriber にも事務連絡が届くよう transactional_only を立てる', async () => {
    const state = freshState();
    state.friend = null;
    state.subscribers.push({
      id: 'unsub', email: 'buyer@example.com',
      is_active: 0, transactional_only: 0, consent_source: 'opt_in_form',
    });
    await seedOne(state);
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'm', subscriberId: 'unsub' }],
    });
    await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    // is_active は 0 のまま (広告配信は解除されたまま) / transactional_only だけ立て直す
    expect(state.subscriberUpdates).toContainEqual({ id: 'unsub', transactional_only: 1 });
    expect(state.subscribers[0].is_active).toBe(0);
  });

  it('resume_notice はカード更新起因では「お支払いを確認できた」と断定しない', () => {
    expect(buildNoticeText('resume_notice', { paymentConfirmed: true })).toContain('お支払いを確認できた');
    expect(buildNoticeText('resume_notice', {})).not.toContain('お支払いを確認できた');
    expect(buildNoticeText('resume_notice', {})).toContain('お支払い方法のご更新');
  });

  it('delivery_notice は解約済み契約に継続を前提とした案内をしない', () => {
    expect(buildNoticeText('delivery_notice', { contractClosed: true })).toContain('停止したまま');
    expect(buildNoticeText('delivery_notice', { contractClosed: true })).not.toContain('次回分から反映');
  });
});

describe('配送予算と飢餓防止', () => {
  async function seedN(state: State, n: number) {
    for (let i = 0; i < n; i += 1) {
      await enqueueNotice(
        createFakeDb(state),
        {
          contractGid: `${GID}-${i}`, cycleKey: '2', attemptNo: 1, kind: 'fail_notice',
          shopifyCustomerId: CUSTOMER, payload: {},
        },
        `2026-08-05T${String(10 + i).padStart(2, '0')}:00:00.000+09:00`,
      );
    }
  }

  it('1 tick の配送は MAX_NOTICE_PER_TICK 件までに制限される', async () => {
    const state = freshState();
    await seedN(state, MAX_NOTICE_PER_TICK + 3);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(res.picked).toBe(MAX_NOTICE_PER_TICK);
    expect(state.queue.filter((r) => r.status === 'queued')).toHaveLength(3);
  });

  it('凍結行は予算を消費せず、後続の契約が配送される (飢餓防止)', async () => {
    const state = freshState();
    await seedN(state, 4);
    const frozen = new Set([`${GID}-0`, `${GID}-1`]);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    const res = await dispatchQueuedNotices(
      createFakeDb(state),
      { ...lineDeps, canDispatch: (gid: string) => !frozen.has(gid) },
      NOW_IN_WINDOW,
      NOW_ISO,
    );
    expect(res.gateFrozen).toBe(2);
    // 凍結が先頭 2 件を占めても、残り 2 件は配送される
    expect(res.picked).toBe(2);
  });

  it('FIFO (queued_at 昇順) で配送される', async () => {
    const state = freshState();
    await seedN(state, 3);
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    // 先に積んだ順に sent になっていること
    expect(state.queue.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
  });
});

describe('challenge_link の 72h 期限 (§5.6 起点 = 送付時刻)', () => {
  it('送信成功して初めて dunning_deadline_at が設定される', async () => {
    const state = freshState();
    await enqueueNotice(
      createFakeDb(state),
      {
        contractGid: GID,
        cycleKey: '2',
        attemptNo: 1,
        kind: 'challenge_link',
        shopifyCustomerId: CUSTOMER,
        payload: { nextActionUrl: 'https://3ds.example/v' },
      },
      NOW_ISO,
    );
    // enqueue 時点では未設定 (配送窓待ちの時間を顧客の 72h から差し引かない)
    expect(state.contracts.get(GID)?.dunning_deadline_at).toBeNull();

    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);

    const deadline = state.contracts.get(GID)?.dunning_deadline_at;
    expect(deadline).toBeTruthy();
    const hours = (Date.parse(deadline as string) - Date.parse(NOW_ISO)) / 3600_000;
    expect(hours).toBeCloseTo(72, 5);
  });

  it('challenged 以外の状態へ遷移していたら期限を書かない', async () => {
    const state = freshState();
    state.contracts.set(GID, { status: 'active', dunning_state: 'none', dunning_deadline_at: null });
    await enqueueNotice(
      createFakeDb(state),
      { contractGid: GID, cycleKey: '2', attemptNo: 1, kind: 'challenge_link', shopifyCustomerId: CUSTOMER, payload: {} },
      NOW_ISO,
    );
    dispatchMock.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
    await dispatchQueuedNotices(createFakeDb(state), lineDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(state.contracts.get(GID)?.dunning_deadline_at).toBeNull();
  });
});

describe('文面 (薬機法・原因断定の回避)', () => {
  it('全 kind に件名と本文がある', () => {
    for (const kind of [
      'fail_notice',
      'card_request',
      'challenge_link',
      'pause_notice',
      'resume_notice',
      'delivery_notice',
    ] as const) {
      expect(buildNoticeSubject(kind).length).toBeGreaterThan(0);
      expect(buildNoticeText(kind, {}).length).toBeGreaterThan(0);
    }
  });

  it('pause_notice は原因を断定しない (手動停止の顧客に虚偽通知しない)', () => {
    const text = buildNoticeText('pause_notice', {});
    expect(text).toContain('お心当たりがない場合');
    expect(text).not.toContain('お支払いに失敗しました');
  });

  it('fail_notice は最終かどうかで文面が変わる', () => {
    const interim = buildNoticeText('fail_notice', { nextRetryDate: '2026-08-08' });
    expect(interim).toContain('8月8日');
    expect(interim).not.toContain('一時停止');
    const final = buildNoticeText('fail_notice', { isFinal: true });
    expect(final).toContain('一時停止');
  });

  it('challenge_link は nextActionUrl をそのまま載せる (§2 例外)', () => {
    expect(buildNoticeText('challenge_link', { nextActionUrl: 'https://3ds.example/v' })).toContain(
      'https://3ds.example/v',
    );
  });

  it('薬機法: 効能効果を示唆する語を含まない', () => {
    const banned = ['効果', '改善', '治', '痩せ', '脂肪', '効く'];
    for (const kind of [
      'fail_notice',
      'card_request',
      'challenge_link',
      'pause_notice',
      'resume_notice',
      'delivery_notice',
    ] as const) {
      const text = buildNoticeText(kind, {});
      for (const w of banned) expect(text).not.toContain(w);
    }
  });
});

describe('formatJpDate', () => {
  it('曜日つき和文日付にする', () => {
    expect(formatJpDate('2026-08-05')).toBe('8月5日(水)');
  });
  it('不正値は空文字 (文面から行ごと落とす)', () => {
    expect(formatJpDate(undefined)).toBe('');
    expect(formatJpDate('2026/08/05')).toBe('');
  });
});
