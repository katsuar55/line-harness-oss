/**
 * Tests for processBroadcastSend channel dispatcher integration (Round 4 PR-6 段階 2).
 *
 * Coverage:
 * - channel='line' (default): LINE multicast / broadcast API only — dispatch() NOT called
 * - channel='line' target=all: triggers broadcastWithRequestId
 * - channel='email' target=tag: dispatch called once per following friend
 * - channel='email' missing email_template_id: throws + status reset to 'draft'
 * - channel='email' template inactive (is_active=0): throws
 * - channel='email' with no emailConfig: short-circuits (status='sent', counts=0, no dispatch)
 * - channel='email' friend without email row: skipped (no dispatch for that friend)
 * - channel='both': dispatch called once per friend with channel='both'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Broadcast, EmailTemplate, Friend } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { EmailDispatchConfig } from '../services/email-dispatch-config.js';

// ---------------------------------------------------------------------------
// Mock @line-crm/db helpers used by broadcast.ts
// ---------------------------------------------------------------------------

const mockGetBroadcastById = vi.fn<(db: unknown, id: string) => Promise<Broadcast | null>>();
const mockUpdateBroadcastStatus = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockClaimBroadcastForSending = vi.fn<(db: unknown, id: string) => Promise<boolean>>();
const mockGetFriendsByTag = vi.fn<(db: unknown, tagId: string) => Promise<Friend[]>>();
const mockGetEmailTemplateById = vi.fn<(db: unknown, id: string) => Promise<EmailTemplate | null>>();
const mockGetBroadcasts = vi.fn<(db: unknown) => Promise<Broadcast[]>>();
// 採点 Round1 D1/D5: cron は getBroadcasts 全件 scan を廃し、 bounded due query + stuck 安全復旧へ
const mockGetDueScheduledBroadcasts =
  vi.fn<(db: unknown, nowIso: string, limit?: number) => Promise<Broadcast[]>>();
const mockGetStuckSendingBroadcasts =
  vi.fn<(db: unknown, cutoffIso: string, limit?: number) => Promise<Broadcast[]>>();
const mockHasBroadcastSendEvidence = vi.fn<(db: unknown, id: string) => Promise<boolean>>();
const mockResetStuckBroadcastToScheduled = vi.fn<(db: unknown, id: string, nowIso: string) => Promise<boolean>>();

vi.mock('@line-crm/db', () => ({
  getBroadcastById: (db: unknown, id: string) => mockGetBroadcastById(db, id),
  getBroadcasts: (db: unknown) => mockGetBroadcasts(db),
  getDueScheduledBroadcasts: (db: unknown, nowIso: string, limit?: number) =>
    mockGetDueScheduledBroadcasts(db, nowIso, limit),
  getStuckSendingBroadcasts: (db: unknown, cutoffIso: string, limit?: number) =>
    mockGetStuckSendingBroadcasts(db, cutoffIso, limit),
  hasBroadcastSendEvidence: (db: unknown, id: string) => mockHasBroadcastSendEvidence(db, id),
  resetStuckBroadcastToScheduled: (db: unknown, id: string, nowIso: string) =>
    mockResetStuckBroadcastToScheduled(db, id, nowIso),
  updateBroadcastStatus: (...args: unknown[]) => mockUpdateBroadcastStatus(...args),
  claimBroadcastForSending: (db: unknown, id: string) => mockClaimBroadcastForSending(db, id),
  getFriendsByTag: (db: unknown, tagId: string) => mockGetFriendsByTag(db, tagId),
  getEmailTemplateById: (db: unknown, id: string) => mockGetEmailTemplateById(db, id),
  jstNow: () => '2026-04-30T10:00:00.000+09:00',
  toJstString: () => '2026-04-30T09:30:00.000+09:00',
}));

// ---------------------------------------------------------------------------
// Mock channel-dispatcher
// ---------------------------------------------------------------------------

vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock email-dispatch-config so buildEmailDispatcherDeps doesn't construct real Resend client
// ---------------------------------------------------------------------------

vi.mock('../services/email-dispatch-config.js', () => ({
  buildEmailDispatcherDeps: vi.fn(() => ({
    emailProvider: {} as unknown,
    emailRenderer: {} as unknown,
    emailFrom: 'noreply@example.com',
    emailReplyTo: 'support@example.com',
  })),
}));

// ---------------------------------------------------------------------------
// Mock auto-track (lazy-imported in broadcast.ts) — keep content unchanged
// ---------------------------------------------------------------------------

vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db, messageType, content) => ({
    messageType,
    content,
  })),
}));

// ---------------------------------------------------------------------------
// Mock stealth helpers (so tests don't actually sleep)
// ---------------------------------------------------------------------------

vi.mock('../services/stealth.js', () => ({
  calculateStaggerDelay: vi.fn(() => 0),
  sleep: vi.fn(async () => {}),
  addMessageVariation: vi.fn((text: string) => text),
}));

// ---------------------------------------------------------------------------
// After mocks: import system under test
// ---------------------------------------------------------------------------

import { processBroadcastSend, processScheduledBroadcasts } from '../services/broadcast.js';
import { dispatch } from '../services/channel-dispatcher.js';

const dispatchMock = vi.mocked(dispatch);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeBroadcast(over: Partial<Broadcast> = {}): Broadcast {
  return {
    id: 'bc-1',
    title: 'Test',
    message_type: 'text',
    message_content: 'Hello',
    target_type: 'all',
    target_tag_id: null,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    total_count: 0,
    success_count: 0,
    line_request_id: null,
    insights_json: null,
    insights_fetched_at: null,
    channel: 'line',
    email_template_id: null,
    created_at: '2026-04-30T10:00:00+09:00',
    ...over,
  };
}

function makeFriend(over: Partial<Friend> = {}): Friend {
  return {
    id: 'f-1',
    line_user_id: 'U001',
    display_name: 'Taro',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    created_at: '2026-04-01T00:00:00+09:00',
    updated_at: '2026-04-01T00:00:00+09:00',
    shopify_customer_id: null,
    ...over,
  };
}

function makeTemplate(over: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'tpl-1',
    name: 'Test template',
    category: 'general',
    subject: 'Subject',
    html_content: '<p>Hi</p>',
    text_content: 'Hi',
    preheader: null,
    is_active: 1,
    created_at: '2026-04-01T00:00:00+09:00',
    updated_at: '2026-04-01T00:00:00+09:00',
    ...over,
  };
}

function makeConfig(): EmailDispatchConfig {
  return {
    resendApiKey: 're_test',
    emailFrom: 'noreply@example.com',
    emailReplyTo: 'support@example.com',
    emailUnsubscribeBaseUrl: 'https://example.com/unsub',
    emailUnsubscribeHmacKey: 'a'.repeat(64),
    emailLegalFooterHtml: '<p>footer</p>',
    emailLegalFooterText: 'footer',
  };
}

interface FakeDbOpts {
  /** email_subscribers lookup by friend_id (returns first matching) */
  subscribers?: Map<string, { id: string; email: string }>;
  /** all-following SELECT result */
  allFollowingFriends?: Friend[];
}

function makeFakeDb(opts: FakeDbOpts = {}): D1Database {
  function makeStmt(sql: string, params: unknown[]) {
    return {
      bind(...moreParams: unknown[]) {
        return makeStmt(sql, moreParams);
      },
      async first<T>() {
        if (sql.includes('FROM email_subscribers')) {
          const friendId = params[0] as string;
          const sub = opts.subscribers?.get(friendId);
          return (sub ?? null) as T | null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes('FROM friends') && sql.includes('is_following = 1')) {
          return { results: (opts.allFollowingFriends ?? []) as T[], success: true };
        }
        // M-1 fix: batchLookupSubscribers が IN 句で email_subscribers を一括 SELECT
        if (sql.includes('FROM email_subscribers') && sql.includes('IN (')) {
          const friendIds = params as string[];
          const rows: Array<{ id: string; email: string; friend_id: string }> = [];
          for (const fid of friendIds) {
            const sub = opts.subscribers?.get(fid);
            if (sub) rows.push({ id: sub.id, email: sub.email, friend_id: fid });
          }
          return { results: rows as T[], success: true };
        }
        // M-3 fix: loadSentSubscriberIdsForBroadcast (既送信 set、default 空)
        if (sql.includes('FROM email_messages_log')) {
          return { results: [] as T[], success: true };
        }
        return { results: [] as T[], success: true };
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
  return {
    prepare(sql: string) {
      return makeStmt(sql, []);
    },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

interface FakeLineClient extends Partial<LineClient> {
  multicast: ReturnType<typeof vi.fn>;
  broadcastWithRequestId: ReturnType<typeof vi.fn>;
}

function makeFakeLineClient(): FakeLineClient {
  return {
    multicast: vi.fn(async () => ({})),
    broadcastWithRequestId: vi.fn(async () => ({ requestId: 'req-1' })),
  } as unknown as FakeLineClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  // default: claim 成功 (= 既存の happy-path テストを従来どおり進める)
  mockClaimBroadcastForSending.mockResolvedValue(true);
  // 採点 Round1: cron query の default (= stuck なし / due なし)。 各テストで上書き。
  mockGetStuckSendingBroadcasts.mockResolvedValue([]);
  mockGetDueScheduledBroadcasts.mockResolvedValue([]);
  mockHasBroadcastSendEvidence.mockResolvedValue(false);
  mockResetStuckBroadcastToScheduled.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// channel='line' regression — dispatcher MUST NOT be called
// ---------------------------------------------------------------------------

describe("processBroadcastSend channel='line' (default)", () => {
  it("target_type='all' triggers broadcastWithRequestId, dispatcher NOT called", async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null, {
      broadcastAllEnabled: true,
    });

    expect(lineClient.broadcastWithRequestId).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
    // sent状態に遷移した
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 0, successCount: 0 }),
    );
  });

  it("target_type='tag' uses multicast, dispatcher NOT called", async () => {
    const broadcast = makeBroadcast({
      channel: 'line',
      target_type: 'tag',
      target_tag_id: 'tag-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
    ]);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id);

    expect(lineClient.multicast).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("legacy row with no channel column (undefined) defaults to LINE path", async () => {
    // 既存マイグレーション前の row では channel フィールドが落ちている可能性。
    const broadcast = makeBroadcast({ channel: undefined, target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null, {
      broadcastAllEnabled: true,
    });

    expect(lineClient.broadcastWithRequestId).toHaveBeenCalledTimes(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// atomic claim (E) — 二重送信防止
// ---------------------------------------------------------------------------

describe('processBroadcastSend atomic claim (E)', () => {
  it('claim 失敗 (= 別 cron/手動が先に送信中) → 一切送信せず status も触らずスキップ', async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockClaimBroadcastForSending.mockResolvedValue(false);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    const result = await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      null,
    );

    // 送信系は一切呼ばれない
    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();
    expect(lineClient.multicast).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    // status 遷移もしない (= 別実行に委ねる)
    expect(mockUpdateBroadcastStatus).not.toHaveBeenCalled();
    // claimed=false + 現状の broadcast を返す
    expect(result.claimed).toBe(false);
    expect(result.broadcast.id).toBe(broadcast.id);
  });

  it('claim 成功 → 通常どおり送信して sent に遷移する (回帰)', async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockClaimBroadcastForSending.mockResolvedValue(true);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null, {
      broadcastAllEnabled: true,
    });

    expect(mockClaimBroadcastForSending).toHaveBeenCalledTimes(1);
    expect(lineClient.broadcastWithRequestId).toHaveBeenCalledTimes(1);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 0, successCount: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// ② Codex review (2026-06-26): target_type='all' blacklist-bypass guard
//    (BROADCAST_ALL_ENABLED 既定OFF — LINE broadcast API は friend 列挙せず blacklist 不可)
// ---------------------------------------------------------------------------

describe("processBroadcastSend target_type='all' guard (BROADCAST_ALL_ENABLED)", () => {
  it('flag OFF (options 省略) + channel=line/all → 送信拒否 (throw, broadcastWithRequestId 呼ばれない, status=draft)', async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await expect(
      processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null),
    ).rejects.toThrow(/disabled/i);

    // LINE broadcast API は呼ばれない (= blacklist bypass 配信が起きない)
    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();
    // claim 後 throw → catch で status='draft' に戻る (= 再送 cron に拾われない)
    const calls = mockUpdateBroadcastStatus.mock.calls;
    expect(calls[calls.length - 1]?.[2]).toBe('draft');
  });

  it('flag OFF (明示 false) + channel=line/all → 送信拒否', async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await expect(
      processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null, {
        broadcastAllEnabled: false,
      }),
    ).rejects.toThrow(/disabled/i);
    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();
  });

  it('flag ON + channel=line/all → 送信実行 (broadcastWithRequestId 呼ばれる)', async () => {
    const broadcast = makeBroadcast({ channel: 'line', target_type: 'all' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, null, {
      broadcastAllEnabled: true,
    });

    expect(lineClient.broadcastWithRequestId).toHaveBeenCalledTimes(1);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 0, successCount: 0 }),
    );
  });

  it('channel=email/all + flag OFF → ガード対象外 (email は friend 列挙で is_blacklisted 除外できる)', async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'all',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });

    const subs = new Map<string, { id: string; email: string }>([['f-1', { id: 'sub-1', email: 'a@example.com' }]]);
    const db = makeFakeDb({ subscribers: subs, allFollowingFriends: [makeFriend({ id: 'f-1' })] });
    const lineClient = makeFakeLineClient();

    // flag OFF でも email/all は throw せず送信される
    await processBroadcastSend(db, lineClient as unknown as LineClient, broadcast.id, undefined, makeConfig());

    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 1, successCount: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// channel='email'
// ---------------------------------------------------------------------------

describe("processBroadcastSend channel='email'", () => {
  it("target='tag' dispatches once per following friend with email", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate({ id: 'tpl-1' }));
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
      makeFriend({ id: 'f-3', line_user_id: 'U003', is_following: 0 }), // unfollowed
    ]);

    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm-x', subscriberId: 'sub-x' }],
    });

    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
      ['f-2', { id: 'sub-2', email: 'b@example.com' }],
    ]);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb({ subscribers: subs });

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    // 2 following friends with email → 2 dispatch calls
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const firstCall = dispatchMock.mock.calls[0]![1];
    expect(firstCall.channel).toBe('email');
    expect(firstCall.category).toBe('marketing');
    expect(firstCall.sourceKind).toBe('broadcast');
    expect(firstCall.source?.broadcastId).toBe(broadcast.id);
    expect(firstCall.emailPayload?.templateId).toBe('tpl-1');
    expect(firstCall.emailPayload?.subjectTemplate).toBe('Subject');
    expect(firstCall.recipient.subscriberId).toBe('sub-1');

    // multicast / broadcast API は呼ばれない
    expect(lineClient.multicast).not.toHaveBeenCalled();
    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();

    // sent状態への遷移
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 2, successCount: 2 }),
    );
  });

  it("missing email_template_id throws + resets status to 'draft'", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      email_template_id: null,
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await expect(
      processBroadcastSend(
        db,
        lineClient as unknown as LineClient,
        broadcast.id,
        undefined,
        makeConfig(),
      ),
    ).rejects.toThrow(/email_template_id is required/);

    // status resets to draft after failure
    const calls = mockUpdateBroadcastStatus.mock.calls;
    const lastStatusCall = calls[calls.length - 1];
    expect(lastStatusCall?.[2]).toBe('draft');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("inactive template (is_active=0) throws", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'all',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate({ id: 'tpl-1', is_active: 0 }));

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await expect(
      processBroadcastSend(
        db,
        lineClient as unknown as LineClient,
        broadcast.id,
        undefined,
        makeConfig(),
      ),
    ).rejects.toThrow(/Email template not found or inactive/);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("missing template (null) throws", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'all',
      email_template_id: 'missing',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(null);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await expect(
      processBroadcastSend(
        db,
        lineClient as unknown as LineClient,
        broadcast.id,
        undefined,
        makeConfig(),
      ),
    ).rejects.toThrow(/Email template not found or inactive/);
  });

  it("no emailConfig (null) short-circuits with status='sent', counts=0, no dispatch", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'all',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    // template lookup should NOT happen because we short-circuit before it
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      null,
    );

    expect(dispatchMock).not.toHaveBeenCalled();
    // status updates: sending then sent (with 0 counts)
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 0, successCount: 0 }),
    );
  });

  it("friend without email_subscribers row is skipped (other friends still dispatched)", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
      makeFriend({ id: 'f-3', line_user_id: 'U003', is_following: 1 }),
    ]);

    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });

    // only f-1, f-3 have email subscribers (f-2 missing)
    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
      ['f-3', { id: 'sub-3', email: 'c@example.com' }],
    ]);

    const lineClient = makeFakeLineClient();
    const db = makeFakeDb({ subscribers: subs });

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    // 2 friends with email → 2 dispatch calls (not 3)
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 2, successCount: 2 }),
    );
  });

  it("dispatcher returning skipped does NOT count as success", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
    ]);

    // 1st sent, 2nd skipped (consent OFF)
    dispatchMock
      .mockResolvedValueOnce({
        results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
      })
      .mockResolvedValueOnce({
        results: [{ channel: 'email', status: 'skipped', reason: 'unsubscribed' }],
      });

    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
      ['f-2', { id: 'sub-2', email: 'b@example.com' }],
    ]);

    const db = makeFakeDb({ subscribers: subs });
    const lineClient = makeFakeLineClient();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 2, successCount: 1 }),
    );
  });

  it("dispatcher exception does not break loop, other friends still dispatched", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
    ]);

    dispatchMock
      .mockRejectedValueOnce(new Error('Resend network error'))
      .mockResolvedValueOnce({
        results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
      });

    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
      ['f-2', { id: 'sub-2', email: 'b@example.com' }],
    ]);

    const db = makeFakeDb({ subscribers: subs });
    const lineClient = makeFakeLineClient();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 2, successCount: 1 }),
    );
  });

  it("target='all' uses raw SELECT to get following friends", async () => {
    const broadcast = makeBroadcast({
      channel: 'email',
      target_type: 'all',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());

    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });

    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
    ]);
    const allFollowing: Friend[] = [makeFriend({ id: 'f-1', line_user_id: 'U001' })];

    const db = makeFakeDb({ subscribers: subs, allFollowingFriends: allFollowing });
    const lineClient = makeFakeLineClient();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    // getFriendsByTag は呼ばれない (target='all' だから)
    expect(mockGetFriendsByTag).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// channel='both'
// ---------------------------------------------------------------------------

describe("processBroadcastSend channel='both'", () => {
  it("dispatches with channel='both' once per following friend", async () => {
    const broadcast = makeBroadcast({
      channel: 'both',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
      makeFriend({ id: 'f-2', line_user_id: 'U002', is_following: 1 }),
    ]);

    dispatchMock.mockResolvedValue({
      results: [
        { channel: 'line', status: 'sent' },
        { channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' },
      ],
    });

    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
      ['f-2', { id: 'sub-2', email: 'b@example.com' }],
    ]);

    const db = makeFakeDb({ subscribers: subs });
    const lineClient = makeFakeLineClient();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    const firstCall = dispatchMock.mock.calls[0]![1];
    expect(firstCall.channel).toBe('both');
    expect(firstCall.linePayload?.messages).toBeDefined();
    expect(firstCall.emailPayload?.templateId).toBe('tpl-1');

    // multicast (LINE-only path) は使わない
    expect(lineClient.multicast).not.toHaveBeenCalled();
    expect(lineClient.broadcastWithRequestId).not.toHaveBeenCalled();

    // both paths sent → success counted
    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 2, successCount: 2 }),
    );
  });

  it("at least one channel sent counts as success", async () => {
    const broadcast = makeBroadcast({
      channel: 'both',
      target_type: 'tag',
      target_tag_id: 'tag-1',
      email_template_id: 'tpl-1',
    });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendsByTag.mockResolvedValue([
      makeFriend({ id: 'f-1', line_user_id: 'U001', is_following: 1 }),
    ]);

    // LINE sent, email skipped → still success (one channel reached)
    dispatchMock.mockResolvedValue({
      results: [
        { channel: 'line', status: 'sent' },
        { channel: 'email', status: 'skipped', reason: 'no_subscriber' },
      ],
    });

    const db = makeFakeDb({ subscribers: new Map() });
    const lineClient = makeFakeLineClient();

    await processBroadcastSend(
      db,
      lineClient as unknown as LineClient,
      broadcast.id,
      undefined,
      makeConfig(),
    );

    expect(mockUpdateBroadcastStatus).toHaveBeenCalledWith(
      expect.anything(),
      broadcast.id,
      'sent',
      expect.objectContaining({ totalCount: 1, successCount: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// processScheduledBroadcasts forwards emailConfig
// ---------------------------------------------------------------------------

describe('processScheduledBroadcasts (採点 Round1 D1/D5)', () => {
  it('bounded due query で取得した scheduled broadcast を processBroadcastSend する (emailConfig forward)', async () => {
    const dueEmail = makeBroadcast({
      id: 'bc-due',
      channel: 'email',
      status: 'scheduled',
      scheduled_at: '2020-01-01T00:00:00+09:00',
      target_type: 'all',
      email_template_id: 'tpl-1',
    });
    mockGetDueScheduledBroadcasts.mockResolvedValue([dueEmail]); // DB 側で due のみ返す
    mockGetBroadcastById.mockImplementation(async (_db, id) => (id === 'bc-due' ? dueEmail : null));
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const subs = new Map<string, { id: string; email: string }>([
      ['f-1', { id: 'sub-1', email: 'a@example.com' }],
    ]);
    const db = makeFakeDb({ subscribers: subs, allFollowingFriends: [makeFriend({ id: 'f-1' })] });
    const lineClient = makeFakeLineClient();

    await processScheduledBroadcasts(db, lineClient as unknown as LineClient, undefined, makeConfig());

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('due query が空なら何も送らない (future-scheduled は DB 側で除外)', async () => {
    mockGetDueScheduledBroadcasts.mockResolvedValue([]);
    const db = makeFakeDb();
    const lineClient = makeFakeLineClient();

    await processScheduledBroadcasts(db, lineClient as unknown as LineClient, undefined, makeConfig());

    expect(mockUpdateBroadcastStatus).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("stuck 'sending' + 送信痕跡あり → detect-only (warn+audit、 auto-reset しない=二重送信回避)", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stuck = makeBroadcast({ id: 'bc-stuck', channel: 'line', status: 'sending', target_type: 'all' });
    mockGetStuckSendingBroadcasts.mockResolvedValue([stuck]);
    mockHasBroadcastSendEvidence.mockResolvedValue(true); // 送信痕跡あり
    const db = makeFakeDb();
    const lineClient = makeFakeLineClient();

    await processScheduledBroadcasts(db, lineClient as unknown as LineClient, undefined, makeConfig());

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("stuck 'sending'"));
    expect(mockResetStuckBroadcastToScheduled).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stuck 'sending' + 送信痕跡なし → 安全に auto-recover (scheduled へ reset)", async () => {
    const stuck = makeBroadcast({
      id: 'bc-stuck2',
      channel: 'line',
      status: 'sending',
      target_type: 'tag',
      target_tag_id: 'tag-1',
    });
    mockGetStuckSendingBroadcasts.mockResolvedValue([stuck]);
    mockHasBroadcastSendEvidence.mockResolvedValue(false); // 痕跡なし
    mockResetStuckBroadcastToScheduled.mockResolvedValue(true);
    const db = makeFakeDb();
    const lineClient = makeFakeLineClient();

    await processScheduledBroadcasts(db, lineClient as unknown as LineClient, undefined, makeConfig());

    expect(mockResetStuckBroadcastToScheduled).toHaveBeenCalledWith(
      expect.anything(),
      'bc-stuck2',
      expect.any(String),
    );
  });
});
