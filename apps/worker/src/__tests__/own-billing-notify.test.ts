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
  contracts: Map<string, { dunning_state: string; dunning_deadline_at: string | null }>;
  subscribers: SubscriberRow[];
  seq: number;
}

function freshState(): State {
  return {
    queue: [],
    notices: new Set(),
    customerEmail: 'buyer@example.com',
    friend: { id: 'f1', line_user_id: 'U1' },
    contracts: new Map([[GID, { dunning_state: 'challenged', dunning_deadline_at: null }]]),
    subscribers: [],
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
              if (sql.includes('FROM shopify_customers')) {
                return { email: state.customerEmail };
              }
              if (sql.includes('FROM friends')) {
                return state.friend
                  ? { id: state.friend.id, line_user_id: state.friend.line_user_id }
                  : null;
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
                  sent_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'sending'")) {
                const row = state.queue.find((r) => r.id === args[0] && r.status === 'queued');
                if (!row) return { meta: { changes: 0 } };
                row.status = 'sending';
                row.dispatch_attempts += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET status = 'sent'")) {
                const row = state.queue.find((r) => r.id === args[2]);
                if (row) {
                  row.status = 'sent';
                  row.channel = String(args[0]);
                  row.sent_at = String(args[1]);
                }
                return { meta: { changes: 1 } };
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
      results: [{ channel: 'email', status: 'skipped', reason: 'inactive_transactional' }],
    });
    await dispatchQueuedNotices(createFakeDb(state), bothDeps, NOW_IN_WINDOW, NOW_ISO);
    expect(state.subscribers).toHaveLength(1);
    expect(state.subscribers[0].transactional_only).toBe(0);
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
    state.contracts.set(GID, { dunning_state: 'none', dunning_deadline_at: null });
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
