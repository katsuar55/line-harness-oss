/**
 * Tests for subscription-reminder service (Phase 6 PR-6 cron heartbeat).
 *
 * 焦点:
 *   - due reminders 0 件でも cron_run_logs に heartbeat を記録する
 *   - reminder 送信が成功した場合の metrics 集計
 *   - cron_run_logs insert 失敗で cron 自体を止めない (fail-safe)
 *   - SUBSCRIPTION_REMINDER_JOB_NAME が cron-monitor の DEFAULT_RULES と一致
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Fake DB
// ============================================================

interface CapturedCall {
  sql: string;
  bindArgs: unknown[];
}

interface FakeDbStore {
  /** SELECT で返す due reminders 行 */
  dueReminders: Record<string, unknown>[];
  /** SELECT で返す friend 行 (line_user_id 解決用) */
  friendRow: Record<string, unknown> | null;
  /** notification preferences */
  prefsRow: Record<string, unknown> | null;
  /** cross-sell suggestions */
  crossSellRows: Record<string, unknown>[];
  /** captured calls */
  captured: CapturedCall[];
  /** insertCronRunLog でエラーを投げるか */
  failHeartbeat?: boolean;
  /** heartbeat 呼び出しの記録 */
  heartbeats: { jobName: string; status: string; metrics: unknown }[];
}

function makeFakeDb(store: FakeDbStore): D1Database {
  const db: unknown = {
    prepare(sql: string) {
      const call: CapturedCall = { sql, bindArgs: [] };
      store.captured.push(call);
      const builder = {
        bind(...args: unknown[]) {
          call.bindArgs = args;
          return builder;
        },
        async first<T>(): Promise<T | null> {
          if (/FROM friends WHERE id/.test(sql)) {
            return (store.friendRow as T) ?? null;
          }
          if (/FROM friend_notification_preferences/.test(sql)) {
            return (store.prefsRow as T) ?? null;
          }
          if (/FROM shopify_products/.test(sql)) {
            return null; // not used in basic tests
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (/FROM subscription_reminders/.test(sql) && /is_active = 1/.test(sql)) {
            return { results: store.dueReminders as T[] };
          }
          if (/FROM purchase_cross_sell_map/.test(sql)) {
            return { results: store.crossSellRows as T[] };
          }
          return { results: [] };
        },
        async run() {
          // claim UPDATE (next_reminder_at CAS) が changes===1 を要求するため meta を返す
          return { success: true, meta: { changes: 1 } };
        },
      };
      return builder;
    },
  };
  return db as D1Database;
}

// ============================================================
// Mock @line-crm/db (insertCronRunLog のスパイ)
// ============================================================

const mockHeartbeats: { jobName: string; status: string; metrics: unknown }[] = [];
let mockHeartbeatShouldFail = false;

vi.mock('@line-crm/db', () => ({
  insertCronRunLog: vi.fn(async (_db: unknown, input: { jobName: string; status: string; metrics?: unknown }) => {
    if (mockHeartbeatShouldFail) {
      throw new Error('simulated cron_run_logs insert failure');
    }
    mockHeartbeats.push({
      jobName: input.jobName,
      status: input.status,
      metrics: input.metrics,
    });
  }),
  getCrossSellSuggestions: vi.fn(async () => []),
}));

// ============================================================
// Mock LineClient
// ============================================================

const mockPushMessage = vi.fn(async () => ({ success: true }));

interface MockLineClient {
  pushMessage: typeof mockPushMessage;
}

const mockLineClient = {
  pushMessage: mockPushMessage,
} as unknown as MockLineClient;

beforeEach(() => {
  mockHeartbeats.length = 0;
  mockHeartbeatShouldFail = false;
  mockPushMessage.mockClear();
});

// ============================================================
// Tests
// ============================================================

/**
 * due の fixture。**固定日付にしない** (2026-08-23):
 * 送信直前の再導出ガード (STALE_DUE_THRESHOLD_MS = 3 日) が入ったため、
 * 固定日付は書いた瞬間から古くなり、3 日後にはテストが『先送り』側に落ちて壊れる。
 * 本番の due は cron 周期 (5 分) の範囲で来るので、相対日付の方が実態にも忠実。
 */
const DUE_JUST_NOW = new Date(Date.now() - 60_000).toISOString();

describe('processSubscriptionReminders — cron heartbeat (Phase 6 PR-6)', () => {
  it('due 0 件でも cron_run_logs に heartbeat を残す', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    const store: FakeDbStore = {
      dueReminders: [],
      friendRow: null,
      prefsRow: null,
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      'https://liff.line.me/123',
    );

    expect(result.dueCount).toBe(0);
    expect(result.sentCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(mockHeartbeats.length).toBe(1);
    expect(mockHeartbeats[0].jobName).toBe('subscription-reminder');
    expect(mockHeartbeats[0].status).toBe('success');
    // 送信直前ガードのヒット数も heartbeat に載る (2026-08-23): 戻り値だけだと
    // 呼び出し側が捨てるため本番で完全に不可視になる。完全一致で pin し、落ちたら気付く
    expect(mockHeartbeats[0].metrics).toEqual({
      due: 0, sent: 0, errors: 0, cancelReanchored: 0, cancelUnparsed: 0, staleSkipped: 0,
    });
  });

  it('reminders 送信成功時に metrics を heartbeat に含める', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    const store: FakeDbStore = {
      dueReminders: [
        {
          id: 'sr-1',
          friend_id: 'friend-1',
          product_title: 'プロテイン',
          interval_days: 30,
          next_reminder_at: DUE_JUST_NOW,
          shopify_product_id: null,
        },
      ],
      // Round 4 PR-3 統合: dispatcher が is_following / is_blacklisted も query する
      friendRow: { line_user_id: 'U-1', is_following: 1, is_blacklisted: 0 },
      prefsRow: null, // default ON
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      'https://liff.line.me/123',
    );

    expect(result.dueCount).toBe(1);
    expect(result.sentCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(mockPushMessage).toHaveBeenCalledTimes(1);
    expect(mockHeartbeats.length).toBe(1);
    expect(mockHeartbeats[0].metrics).toEqual({
      due: 1, sent: 1, errors: 0, cancelReanchored: 0, cancelUnparsed: 0, staleSkipped: 0,
    });
  });

  it('Round 4 PR-3: is_following=0 → dispatcher が skip し sentCount=0 / errorCount=0 (旧 behavior は errorCount++ だった)', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    const store: FakeDbStore = {
      dueReminders: [
        {
          id: 'sr-1',
          friend_id: 'friend-1',
          product_title: 'A',
          interval_days: 30,
          next_reminder_at: DUE_JUST_NOW,
          shopify_product_id: null,
        },
      ],
      friendRow: { line_user_id: 'U-1', is_following: 0, is_blacklisted: 0 },
      prefsRow: null,
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      '',
    );
    expect(result.sentCount).toBe(0);
    expect(result.errorCount).toBe(0); // skipped は errorCount に計上しない
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it('Round 4 PR-3: is_blacklisted=1 → dispatcher が skip', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    const store: FakeDbStore = {
      dueReminders: [
        {
          id: 'sr-1',
          friend_id: 'friend-1',
          product_title: 'A',
          interval_days: 30,
          next_reminder_at: DUE_JUST_NOW,
          shopify_product_id: null,
        },
      ],
      friendRow: { line_user_id: 'U-1', is_following: 1, is_blacklisted: 1 },
      prefsRow: null,
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      '',
    );
    expect(result.sentCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it('notification preference オフ → push されないが heartbeat は記録', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    const store: FakeDbStore = {
      dueReminders: [
        {
          id: 'sr-1',
          friend_id: 'friend-1',
          product_title: 'A',
          interval_days: 30,
          next_reminder_at: DUE_JUST_NOW,
          shopify_product_id: null,
        },
      ],
      friendRow: { line_user_id: 'U-1' },
      prefsRow: { reorder_reminder: 0 }, // OFF
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      'https://liff.line.me/123',
    );

    expect(result.dueCount).toBe(1);
    expect(result.sentCount).toBe(0); // skipped due to prefs
    expect(mockPushMessage).not.toHaveBeenCalled();
    expect(mockHeartbeats.length).toBe(1);

    // 回帰 (review HIGH): prefs オフは claim より前に skip され、 lease UPDATE を発行しない
    // (= next_reminder_at を now+10min に固定して 10 分毎 churn させない)。
    const issuedClaim = store.captured.some(
      (c) => /UPDATE subscription_reminders SET next_reminder_at = \?/.test(c.sql) && !/last_sent_at/.test(c.sql),
    );
    expect(issuedClaim).toBe(false);
  });

  it('cron_run_logs insert 失敗で cron 全体を止めない (fail-safe)', async () => {
    const { processSubscriptionReminders } = await import(
      '../services/subscription-reminder.js'
    );
    mockHeartbeatShouldFail = true;
    const store: FakeDbStore = {
      dueReminders: [],
      friendRow: null,
      prefsRow: null,
      crossSellRows: [],
      captured: [],
      heartbeats: [],
    };
    const db = makeFakeDb(store);

    // ※ throw されないこと
    const result = await processSubscriptionReminders(
      db,
      mockLineClient as never,
      'https://liff.line.me/123',
    );
    expect(result.dueCount).toBe(0);
    expect(mockHeartbeats.length).toBe(0); // 失敗したので記録されていない
  });
});

describe('cron-monitor DEFAULT_RULES — Phase 6 PR-6 統合', () => {
  it('subscription-reminder rule が登録されている', async () => {
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const rule = DEFAULT_RULES.find((r) => r.jobName === 'subscription-reminder');
    expect(rule).toBeDefined();
    expect(rule?.maxSilentHours).toBe(24);
  });

  it('subscription-reminder の job name が service と cron-monitor で一致', async () => {
    const { SUBSCRIPTION_REMINDER_JOB_NAME } = await import(
      '../services/subscription-reminder.js'
    );
    const { DEFAULT_RULES } = await import('../services/cron-monitor.js');
    const rule = DEFAULT_RULES.find((r) => r.jobName === SUBSCRIPTION_REMINDER_JOB_NAME);
    expect(rule).toBeDefined();
  });
});
