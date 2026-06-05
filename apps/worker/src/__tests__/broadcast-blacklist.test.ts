/**
 * Tests for broadcast target='all' blacklist exclusion (H, 2026-06-06).
 *
 * broadcast の friend 選択経路は 3 つ:
 *   - tag 経路   → getFriendsByTag (db 層で除外、 tags-blacklist.test.ts で担保)
 *   - 'all' 経路 → resolveFollowingFriends の raw SELECT (本ファイルで担保)
 *   - LINE 'all' broadcast API → LINE 側で全 follower に送信され friend を列挙しない =
 *                                blacklist 適用不可 (= 構造的制約、 コードコメントで明示)
 *
 * 実 processBroadcastSend を SQL-capture db で driving し、 'all' SELECT が
 * COALESCE(is_blacklisted,0)=0 を含むことを検証する。 friends を空 results で返すため
 * recipients=0 で短絡するが、 'all' query は短絡前に prepare 済 = 捕捉できる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Broadcast, EmailTemplate } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { EmailDispatchConfig } from '../services/email-dispatch-config.js';

const mockGetBroadcastById = vi.fn<(db: unknown, id: string) => Promise<Broadcast | null>>();
const mockUpdateBroadcastStatus = vi.fn<(...args: unknown[]) => Promise<void>>();
const mockGetFriendsByTag = vi.fn(async () => []);
const mockGetEmailTemplateById = vi.fn<(db: unknown, id: string) => Promise<EmailTemplate | null>>();
const mockGetBroadcasts = vi.fn(async () => []);

vi.mock('@line-crm/db', () => ({
  getBroadcastById: (db: unknown, id: string) => mockGetBroadcastById(db, id),
  getBroadcasts: () => mockGetBroadcasts(),
  updateBroadcastStatus: (...args: unknown[]) => mockUpdateBroadcastStatus(...args),
  // E: atomic claim — blacklist テストでは常に claim 成功で送信経路を exercise する
  claimBroadcastForSending: async () => true,
  getFriendsByTag: () => mockGetFriendsByTag(),
  getEmailTemplateById: (db: unknown, id: string) => mockGetEmailTemplateById(db, id),
  jstNow: () => '2026-06-06T10:00:00.000+09:00',
}));

vi.mock('../services/channel-dispatcher.js', () => ({ dispatch: vi.fn() }));

vi.mock('../services/email-dispatch-config.js', () => ({
  buildEmailDispatcherDeps: vi.fn(() => ({
    emailProvider: {} as unknown,
    emailRenderer: {} as unknown,
    emailFrom: 'noreply@example.com',
    emailReplyTo: 'support@example.com',
  })),
}));

import { processBroadcastSend } from '../services/broadcast.js';

function makeBroadcast(over: Partial<Broadcast> & { line_account_id?: string | null } = {}): Broadcast {
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
    channel: 'email',
    email_template_id: 'tpl-1',
    created_at: '2026-06-06T10:00:00+09:00',
    ...over,
  } as Broadcast;
}

function makeTemplate(): EmailTemplate {
  return {
    id: 'tpl-1',
    name: 'T',
    category: 'general',
    subject: 'S',
    html_content: '<p>x</p>',
    text_content: 'x',
    preheader: null,
    is_active: 1,
    created_at: '2026-06-06T10:00:00+09:00',
    updated_at: '2026-06-06T10:00:00+09:00',
  };
}

function makeConfig(): EmailDispatchConfig {
  return {
    resendApiKey: 're_test',
    emailFrom: 'noreply@example.com',
    emailReplyTo: 'support@example.com',
    emailUnsubscribeBaseUrl: 'https://example.com/unsub',
    emailUnsubscribeHmacKey: 'a'.repeat(64),
    emailLegalFooterHtml: '<p>f</p>',
    emailLegalFooterText: 'f',
  };
}

/** prepare された全 SQL を記録する db (全 result 空)。 */
function makeRecordingDb(): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  function stmt(sql: string) {
    return {
      bind: (..._a: unknown[]) => stmt(sql),
      first: async () => null,
      all: async () => ({ results: [] as unknown[], success: true }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
  }
  const db = {
    prepare: (sql: string) => {
      sqls.push(sql);
      return stmt(sql);
    },
  } as unknown as D1Database;
  return { db, sqls };
}

function makeLineClient(): LineClient {
  return {
    multicast: vi.fn(async () => ({})),
    broadcastWithRequestId: vi.fn(async () => ({ requestId: 'r' })),
  } as unknown as LineClient;
}

/** 'all' 友だち選択の raw SELECT を recorded SQL から探す。 */
function findAllFriendsQuery(sqls: string[]): string | undefined {
  return sqls
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .find((s) => s.includes('FROM friends') && s.includes('is_following = 1'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
});

describe("processBroadcastSend target='all' — blacklist 除外", () => {
  it('unscoped (line_account_id なし) の all SELECT が COALESCE(is_blacklisted,0)=0 を含む', async () => {
    const broadcast = makeBroadcast({ line_account_id: null });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const { db, sqls } = makeRecordingDb();
    await processBroadcastSend(db, makeLineClient(), broadcast.id, undefined, makeConfig());

    const allQuery = findAllFriendsQuery(sqls);
    expect(allQuery).toBeDefined();
    expect(allQuery).toContain('is_blacklisted');
    expect(allQuery).toContain('COALESCE(is_blacklisted, 0) = 0');
    // scoped でないので line_account_id 述語は含まない
    expect(allQuery).not.toContain('line_account_id = ?');
  });

  it('scoped (line_account_id あり) の all SELECT が blacklist と account 述語の両方を含む', async () => {
    const broadcast = makeBroadcast({ line_account_id: 'acc-1' });
    mockGetBroadcastById.mockResolvedValue(broadcast);
    mockUpdateBroadcastStatus.mockResolvedValue(undefined);

    const { db, sqls } = makeRecordingDb();
    await processBroadcastSend(db, makeLineClient(), broadcast.id, undefined, makeConfig());

    const allQuery = findAllFriendsQuery(sqls);
    expect(allQuery).toBeDefined();
    expect(allQuery).toContain('line_account_id = ?');
    expect(allQuery).toContain('COALESCE(is_blacklisted, 0) = 0');
  });
});
