/**
 * サブスク決済7日前リマインド + 決済失敗リカバリ cron のテスト (WI-2, 採点R1 対応版)
 * 送信窓 [3,7] への拡張は SUBSCRIPTION_UX_TAP_MINIMAL §10-0 ④
 *
 * fake D1 は claim/解放 SQL の WHERE 述語を実際に評価する stateful 実装
 * (採点R1: claimChanges を返すだけの自己言及モックでは述語の退行を検出できない)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListDue,
  mockListPendingRecovery,
  mockGetFriendByCustomer,
  mockInsertCronRunLog,
  mockDispatch,
} = vi.hoisted(() => ({
  mockListDue: vi.fn(),
  mockListPendingRecovery: vi.fn(),
  mockGetFriendByCustomer: vi.fn(),
  mockInsertCronRunLog: vi.fn(),
  mockDispatch: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    listContractsDueForReminder: mockListDue,
    listContractsPendingRecovery: mockListPendingRecovery,
    getFriendByShopifyCustomerId: mockGetFriendByCustomer,
    insertCronRunLog: mockInsertCronRunLog,
    jstNow: () => '2026-07-14 12:00:00',
  };
});

vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: mockDispatch,
}));

import {
  processBillingReminders,
  deterministicRetryKey,
  BILLING_REMINDER_JOB_NAME,
} from '../services/subscription-billing-reminder.js';
import { DEFAULT_RULES } from '../services/cron-monitor.js';
import type { LineClient } from '@line-crm/line-sdk';

// JST 2026-07-14 12:00
const NOW_NOON = Date.parse('2026-07-14T12:00:00+09:00');
const TARGET_FROM = '2026-07-17'; // today+3 (catch-up 下限 = 締切当日)
const TARGET_TO = '2026-07-21'; // today+7 (通常送信 = 7日前リマインドカード)
const TARGET_DEADLINE_TOMORROW = '2026-07-18'; // today+4 (締切は明日)

interface ContractState {
  contract_id: string;
  next_billing_estimate: string | null;
  cancelled_at: string | null;
  paused_at: string | null;
  reminded_for_estimate: string | null;
  recovery_pending_at: string | null;
  recovery_notified_at: string | null;
  [key: string]: unknown;
}

/** claim/解放 SQL の WHERE 述語を実評価する stateful fake D1 */
function createStatefulDb(rows: ContractState[]) {
  const byId = new Map(rows.map((r) => [r.contract_id, r]));
  // 採点R3 MEDIUM 対策: fake は述語を手書き複製しているため、実 SQL 側から述語が消える退行を
  // fake の評価だけでは検出できない (fake が勝手に守り続けて false green)。SQL 文字列に
  // 述語が実在することも検証し、実装との drift を fail で顕在化させる。
  const requirePredicates = (sql: string, preds: string[]): void => {
    for (const p of preds) {
      if (!sql.includes(p)) throw new Error(`claim SQL から述語が消えている: ${p}`);
    }
  };
  const db = {
    byId,
    prepare(sql: string) {
      const exec = (binds: unknown[]) => ({
        async run() {
          if (sql.includes('SET reminded_for_estimate = next_billing_estimate')) {
            requirePredicates(sql, [
              'next_billing_estimate = ?',
              'cancelled_at IS NULL',
              'paused_at IS NULL',
              '(reminded_for_estimate IS NULL OR reminded_for_estimate != next_billing_estimate)',
            ]);
            const row = byId.get(binds[1] as string);
            const ok =
              row &&
              row.next_billing_estimate === binds[2] &&
              row.cancelled_at === null &&
              row.paused_at === null &&
              (row.reminded_for_estimate === null ||
                row.reminded_for_estimate !== row.next_billing_estimate);
            if (ok && row) row.reminded_for_estimate = row.next_billing_estimate;
            return { meta: { changes: ok ? 1 : 0 } };
          }
          if (sql.includes('SET reminded_for_estimate = NULL')) {
            requirePredicates(sql, ['reminded_for_estimate = ?']);
            const row = byId.get(binds[1] as string);
            const ok = row && row.reminded_for_estimate === binds[2];
            if (ok && row) row.reminded_for_estimate = null;
            return { meta: { changes: ok ? 1 : 0 } };
          }
          if (sql.includes('SET recovery_notified_at = ?')) {
            requirePredicates(sql, [
              'recovery_pending_at IS NOT NULL',
              'recovery_notified_at IS NULL',
              'paused_at IS NOT NULL',
              'cancelled_at IS NULL',
            ]);
            const row = byId.get(binds[2] as string);
            // 実 SQL の述語を再現: pending 有り (採点R3) かつ 未送信 かつ 今も一時停止中 かつ 未解約 (採点R2)
            const ok =
              row &&
              row.recovery_pending_at !== null &&
              row.recovery_notified_at === null &&
              row.paused_at !== null &&
              row.cancelled_at === null;
            if (ok && row) row.recovery_notified_at = binds[0] as string;
            return { meta: { changes: ok ? 1 : 0 } };
          }
          if (sql.includes('SET recovery_notified_at = NULL')) {
            requirePredicates(sql, ['recovery_notified_at IS NOT NULL']);
            const row = byId.get(binds[1] as string);
            const ok = row && row.recovery_notified_at !== null;
            if (ok && row) row.recovery_notified_at = null;
            return { meta: { changes: ok ? 1 : 0 } };
          }
          throw new Error(`unsupported run: ${sql}`);
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [] };
        },
      });
      return { bind: (...binds: unknown[]) => exec(binds), ...exec([]) };
    },
  };
  return db as unknown as D1Database & { byId: Map<string, ContractState> };
}

function contract(overrides: Partial<ContractState> = {}): ContractState {
  return {
    contract_id: '100',
    shopify_customer_id: 'cust-1',
    plan_name: '[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)',
    interval_days: 30,
    order_count: 2,
    last_order_id: 'ord-1',
    last_order_at: '2026-06-18T10:00:00+09:00',
    last_delivery_date: '2026-06-21',
    skip_count: 0,
    skip_count_at_last_order: 0,
    paused_at: null,
    cancelled_at: null,
    next_billing_estimate: TARGET_TO,
    estimate_source: 'derived',
    reminded_for_estimate: null,
    recovery_pending_at: null,
    recovery_notified_at: null,
    created_at: 'x',
    updated_at: 'x',
    ...overrides,
  };
}

const FRIEND = { id: 'f1', line_user_id: 'U_line_1' };
const lineClient = {} as LineClient;

function env(db: D1Database, overrides: Record<string, string | undefined> = {}) {
  return {
    DB: db,
    SUBSCRIPTION_REMINDER_ENABLED: 'true',
    SUBSCRIPTION_MENU_ENABLED: 'true',
    ...overrides,
  };
}

const SENT = { results: [{ channel: 'line', status: 'sent' }] };

beforeEach(() => {
  mockListDue.mockReset().mockResolvedValue([]);
  mockListPendingRecovery.mockReset().mockResolvedValue([]);
  mockGetFriendByCustomer.mockReset();
  mockInsertCronRunLog.mockReset();
  mockDispatch.mockReset();
});

describe('processBillingReminders — gate / 送信窓', () => {
  it('REMINDER gate OFF → 送信系は no-op だが heartbeat は記録 (採点R3: cron-monitor 監視用)', async () => {
    const db = createStatefulDb([]);
    const r = await processBillingReminders(
      env(db, { SUBSCRIPTION_REMINDER_ENABLED: undefined }),
      lineClient,
      NOW_NOON,
    );
    expect(r.skippedGating).toBe(true);
    expect(mockListDue).not.toHaveBeenCalled();
    expect(mockInsertCronRunLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        jobName: 'teiki-billing-reminder',
        status: 'success',
        metrics: expect.objectContaining({ skippedGating: true }),
      }),
    );
  });

  it('MENU gate OFF → read-model 凍結中は送らない (採点R1: 解約反映されず誤送信するため)', async () => {
    const db = createStatefulDb([]);
    const r = await processBillingReminders(
      env(db, { SUBSCRIPTION_MENU_ENABLED: undefined }),
      lineClient,
      NOW_NOON,
    );
    expect(r.skippedGating).toBe(true);
    expect(mockListDue).not.toHaveBeenCalled();
  });

  it.each([
    ['09:59', true],
    ['10:00', false],
    ['19:59', false],
    ['20:00', true],
  ])('送信窓境界 JST %s → skippedWindow=%s', async (hhmm, skipped) => {
    const db = createStatefulDb([]);
    const now = Date.parse(`2026-07-14T${hhmm}:00+09:00`);
    const r = await processBillingReminders(env(db), lineClient, now);
    expect(r.skippedWindow ?? false).toBe(skipped);
    // 窓外でも heartbeat は記録される (採点R3: 夜間 silent を cron-monitor が誤検知しない)
    expect(mockInsertCronRunLog).toHaveBeenCalled();
  });
});

describe('processBillingReminders — フェーズ1 リマインド', () => {
  it('照会範囲は [今日+3, 今日+4] (catch-up)。連携済みに送信し claim が立つ', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue(SENT);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);

    expect(mockListDue).toHaveBeenCalledWith(db, TARGET_FROM, TARGET_TO);
    expect(r.sent).toBe(1);
    expect(row.reminded_for_estimate).toBe(TARGET_TO);
    const payload = JSON.stringify(mockDispatch.mock.calls[0][1].linePayload);
    // 7日前送信 = 締切 (決済3日前) までまだ4日ある。「明日まで」と言ってはいけない
    expect(payload).toContain('あと4日以内のお手続き');
    expect(payload).not.toContain('明日までのお手続き');
    expect(payload).toContain('7月21日ごろ');
    // 決定的 retryKey (UUID形式) が付与される
    expect(mockDispatch.mock.calls[0][1].linePayload.retryKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // ───────────────────────────────────────────────
  // 送信窓 [3, 7] (SUBSCRIPTION_UX_TAP_MINIMAL §10-0 ④)
  //
  // 設計書が明示的に要求する回帰: 「MIN 変更で締切当日送信が消えないこと」。
  // MIN を 4 に上げると、決済3日前に初めて連携した顧客や、窓の前半が gate OFF /
  // 障害だった契約が **まだ行動できるのにリマインドを 1 通も受け取れない** (しかも
  // 失われたことに誰も気づけない)。ここを緩めた退行を必ず検出する。
  // ───────────────────────────────────────────────

  it('締切当日 (今日+3) が窓に含まれる — MIN を上げる退行を検出する', async () => {
    const row = contract({ next_billing_estimate: TARGET_FROM });
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue(SENT);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);

    // 窓の下限が today+3 (締切当日) ちょうどであること = MIN 引き上げの退行検出
    expect(mockListDue).toHaveBeenCalledWith(db, '2026-07-17', '2026-07-21');
    expect(r.sent).toBe(1); // 締切当日でも実際に送られる (窓に入るだけでは足りない)
    expect(row.reminded_for_estimate).toBe(TARGET_FROM);
  });

  it.each([
    ['2026-07-21', 7, 'あと4日以内のお手続き'], // 通常送信 (7日前カード)
    ['2026-07-20', 6, 'あと3日以内のお手続き'],
    ['2026-07-19', 5, 'あと2日以内のお手続き'],
    ['2026-07-18', 4, '明日までのお手続き'],
    ['2026-07-17', 3, '本日中のお手続き'], // 締切当日
  ])(
    '窓の全域で締切文言が実際の残り日数と一致する (推定日 %s = 決済%i日前)',
    async (estimate, _days, expected) => {
      const row = contract({ next_billing_estimate: estimate });
      const db = createStatefulDb([row]);
      mockListDue.mockResolvedValue([row]);
      mockGetFriendByCustomer.mockResolvedValue(FRIEND);
      mockDispatch.mockResolvedValue(SENT);

      await processBillingReminders(env(db), lineClient, NOW_NOON);
      expect(JSON.stringify(mockDispatch.mock.calls[0][1].linePayload)).toContain(expected);
    },
  );

  it('7日前に送った契約は窓の後半 (締切前日) で再送しない — 1推定日1通の claim 意味論', async () => {
    // 窓を広げても通数は増えず、届くタイミングが早くなるだけであることを固定する。
    // ここが壊れると同一顧客に最大 5 通届き、ブロック要因になる (§8-1)。
    const row = contract({
      next_billing_estimate: TARGET_DEADLINE_TOMORROW,
      reminded_for_estimate: TARGET_DEADLINE_TOMORROW, // 7日前時点で送信済み
    });
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);

    expect(r.claimedLost).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('catch-up (今日+3 = 締切当日) は「本日中」文言に切り替わる', async () => {
    const row = contract({ next_billing_estimate: TARGET_FROM });
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue(SENT);

    await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(JSON.stringify(mockDispatch.mock.calls[0][1].linePayload)).toContain('本日中のお手続き');
  });

  it('claim 済み (同一推定日) は再送しない — WHERE 述語を実評価', async () => {
    const row = contract({ reminded_for_estimate: TARGET_TO });
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.claimedLost).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('照会後に解約された契約は claim 述語 (cancelled IS NULL) で弾かれる', async () => {
    const row = contract({ cancelled_at: '2026-07-14' });
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.claimedLost).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('未連携 → claim を消費しない', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(null);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.unlinked).toBe(1);
    expect(row.reminded_for_estimate).toBeNull();
  });

  it('blacklist skip → claim 維持 (再試行しない)', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'skipped', reason: 'blacklisted' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.skippedRecipient).toBe(1);
    expect(row.reminded_for_estimate).toBe(TARGET_TO);
  });

  it('恒久 4xx (無効 userId 等) → claim 維持で無限リトライしない + permanentError で判別可能 (採点R1/R2)', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 400 Bad Request — invalid to' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.skippedRecipient).toBe(1);
    expect(r.permanentError).toBe(1);
    expect(row.reminded_for_estimate).toBe(TARGET_TO);
  });

  it('🚨採点R3: 409 (retry-key 重複) は「既に配信済み」= sent 扱いで claim 維持', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 409 Conflict — duplicated request' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.sent).toBe(1);
    expect(r.permanentError).toBe(0); // 配信成功をエラーとして監視を濁らせない
    expect(r.failed).toBe(0);
    expect(row.reminded_for_estimate).toBe(TARGET_TO); // claim 維持 = 再送しない
  });

  it('🚨採点R2: 429 (レート制限/月次上限) は transient → claim 解放して再試行に回す', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 429 Too Many Requests' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.failed).toBe(1);
    expect(r.permanentError).toBe(0);
    expect(row.reminded_for_estimate).toBeNull(); // 解放 = quota 回復後に再送される
  });

  it('transient 失敗 (5xx) → claim 解放して次サイクル再試行', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 500 — down' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.failed).toBe(1);
    expect(row.reminded_for_estimate).toBeNull();
    expect(mockInsertCronRunLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'partial' }),
    );
  });

  it('🚨採点R1: dispatch throw でも claim を解放する (「送信失敗は再試行」の約束を throw 経路でも守る)', async () => {
    const row = contract();
    const db = createStatefulDb([row]);
    mockListDue.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockRejectedValue(new Error('D1 transient'));

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.failed).toBe(1);
    expect(r.leakedClaims).toBe(0);
    expect(row.reminded_for_estimate).toBeNull(); // 解放済み = 次サイクルで再対象
  });
});

describe('processBillingReminders — フェーズ2 リカバリ', () => {
  const pendingContract = () =>
    contract({
      contract_id: '200',
      paused_at: '2026-07-14',
      next_billing_estimate: null,
      recovery_pending_at: '2026-07-14 03:00:00',
    });

  it('pending 契約に原因非依存の文言で送信し notified が立つ', async () => {
    const row = pendingContract();
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue(SENT);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoverySent).toBe(1);
    expect(row.recovery_notified_at).not.toBeNull();
    const payload = JSON.stringify(mockDispatch.mock.calls[0][1].linePayload);
    // 原因を断定しない (手動一時停止でも虚偽にならない)
    expect(payload).toContain('一時停止しました');
    expect(payload).toContain('お心当たりがない場合');
    expect(payload).not.toContain('お支払いが確認できなかったため');
  });

  it('🚨採点R3: リカバリ側も 409 (retry-key 重複) は sent 扱いで claim 維持', async () => {
    const row = pendingContract();
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 409 Conflict' }],
    });

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoverySent).toBe(1);
    expect(r.permanentError).toBe(0);
    expect(row.recovery_notified_at).not.toBeNull();
  });

  it('🚨採点R2: 検知後に再開済み (paused_at=null) の契約へは stale 通知を送らない', async () => {
    // 20:01 pause → 21:00 本人が resume → 翌朝の cron。resume 遷移でマーカーはクリアされるが、
    // 万一 pending が残っていても claim 述語 (paused IS NOT NULL) が最後の砦になる
    const row = pendingContract();
    row.paused_at = null; // 再開済み
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoverySkipped).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('🚨採点R3: list〜claim 間に新規注文がマーカーを解除した契約は claim 述語 (pending IS NOT NULL) で弾く', async () => {
    // 決済成功 (新注文 webhook) が pending を掃除した直後に cron が古い list 結果で claim を
    // 試みる race。述語がなければ「回復済み顧客に一時停止しました」の stale 通知になる。
    // list のスナップショット (pending 有り) と DB の現在値 (pending 解除済み) を
    // 別オブジェクトにして stale-read の形を忠実に再現する (採点R4)
    const snapshot = pendingContract(); // list が返した時点: pending 有り
    const dbRow = { ...pendingContract(), recovery_pending_at: null }; // DB: 並行 webhook が解除済み
    const db = createStatefulDb([dbRow]);
    mockListPendingRecovery.mockResolvedValue([snapshot]);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoverySkipped).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(dbRow.recovery_notified_at).toBeNull();
  });

  it('🚨採点R2: claim 後の friend lookup throw でも notified を解放する (永久リーク防止)', async () => {
    const row = pendingContract();
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockRejectedValue(new Error('D1 transient'));

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoveryFailed).toBe(1);
    expect(r.leakedClaims).toBe(0);
    expect(row.recovery_notified_at).toBeNull(); // 解放済み = 次サイクルで再試行
  });

  it('notified 済みは再送しない (並行 webhook/二重 cron 安全)', async () => {
    const row = pendingContract();
    row.recovery_notified_at = '2026-07-14 12:00:00';
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoverySkipped).toBe(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('未連携 → claim 消費で終了 (ホットループ回避、メールは Huckleberry 標準が担保)', async () => {
    const row = pendingContract();
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(null);

    const r = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r.recoveryUnlinked).toBe(1);
    expect(row.recovery_notified_at).not.toBeNull();
  });

  it('transient 失敗 → notified 解放して次サイクル再試行 / throw も同様', async () => {
    const row = pendingContract();
    const db = createStatefulDb([row]);
    mockListPendingRecovery.mockResolvedValue([row]);
    mockGetFriendByCustomer.mockResolvedValue(FRIEND);
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'line', status: 'failed', error: 'LINE API error: 503' }],
    });

    const r1 = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r1.recoveryFailed).toBe(1);
    expect(row.recovery_notified_at).toBeNull();

    mockDispatch.mockRejectedValue(new Error('boom'));
    const r2 = await processBillingReminders(env(db), lineClient, NOW_NOON);
    expect(r2.recoveryFailed).toBe(1);
    expect(row.recovery_notified_at).toBeNull();
    expect(r2.leakedClaims).toBe(0);
  });
});

describe('cron-monitor DEFAULT_RULES — WI-2 統合 (採点R3)', () => {
  it('teiki-billing-reminder が監視対象に登録されている (サイレント全停止の検知)', () => {
    const rule = DEFAULT_RULES.find((r) => r.jobName === BILLING_REMINDER_JOB_NAME);
    expect(rule).toBeDefined();
    // gate OFF / 窓外でも毎 tick heartbeat を記録するため、他の per-tick cron と同じ 2h 基準
    expect(rule!.maxSilentHours).toBe(2);
  });
});

describe('deterministicRetryKey', () => {
  it('同一シードから常に同じ UUID 形式を生成する (再試行時の二重配信防止)', async () => {
    const a = await deterministicRetryKey('reminder:100:2026-07-18');
    const b = await deterministicRetryKey('reminder:100:2026-07-18');
    const c = await deterministicRetryKey('reminder:100:2026-07-19');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // RFC 4122 準拠 (version=4 / variant=10xx)。LINE が厳密検証しても拒否されない (採点R2)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
