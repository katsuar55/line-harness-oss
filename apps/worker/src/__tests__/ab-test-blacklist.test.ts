/**
 * Tests for A/B test target='all' blacklist exclusion (H, 2026-06-06).
 *
 * A/B test も mass 配信の一種。 tag 経路は getFriendsByTag (db 層で除外済) を共有するが、
 * resolveAudience の 'all' 経路は独自 raw SELECT のため別途除外が要る。 ここを直さないと
 * 「tag は除外・all は除外せず」 の内部不整合が残る。 実 processAbTestSend を SQL-capture db で
 * driving し、 'all' SELECT が COALESCE(is_blacklisted,0)=0 を含むことを検証する
 * (audience を空 results にして split/multicast 前に短絡)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

const mockGetAbTestById = vi.fn();
const mockUpdateAbTestStatus = vi.fn(async () => undefined);

vi.mock('@line-crm/db', () => ({
  getAbTestById: () => mockGetAbTestById(),
  getAbTests: vi.fn(async () => []),
  claimAbTestForSending: vi.fn(async () => true),
  updateAbTestStatus: () => mockUpdateAbTestStatus(),
  updateAbTestWinner: vi.fn(async () => undefined),
  updateAbTestTrackedLinks: vi.fn(async () => undefined),
  batchCreateAbTestAssignments: vi.fn(async () => undefined),
  getAssignedFriendIds: vi.fn(async () => new Set<string>()),
  getFriendsByTag: vi.fn(async () => []),
  jstNow: () => '2026-06-06T10:00:00.000+09:00',
}));

import { processAbTestSend } from '../services/ab-test.js';

function makeAbTest(over: Record<string, unknown> = {}) {
  return {
    id: 'ab-1',
    title: 'Test AB',
    variant_a_message_type: 'text',
    variant_a_message_content: 'Hello A',
    variant_a_alt_text: null,
    variant_b_message_type: 'text',
    variant_b_message_content: 'Hello B',
    variant_b_alt_text: null,
    target_type: 'all',
    target_tag_id: null,
    split_ratio: 50,
    status: 'draft',
    scheduled_at: null,
    sent_at: null,
    variant_a_total: 0,
    variant_a_success: 0,
    variant_b_total: 0,
    variant_b_success: 0,
    winner: null,
    winner_total: 0,
    winner_success: 0,
    variant_a_tracked_link_ids: null,
    variant_b_tracked_link_ids: null,
    line_account_id: null,
    created_at: '2026-06-06T10:00:00.000',
    ...over,
  };
}

/** prepare された全 SQL を記録する db (全 result 空 = audience 0)。 */
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
    pushMessage: vi.fn(async () => ({})),
  } as unknown as LineClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processAbTestSend target='all' — blacklist 除外", () => {
  it("'all' audience SELECT が COALESCE(is_blacklisted,0)=0 を含む", async () => {
    const abTest = makeAbTest();
    mockGetAbTestById.mockResolvedValue(abTest);

    const { db, sqls } = makeRecordingDb();
    await processAbTestSend(db, makeLineClient(), 'ab-1', undefined);

    const allQuery = sqls
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .find((s) => s.includes('FROM friends') && s.includes('is_following = 1'));

    expect(allQuery).toBeDefined();
    expect(allQuery).toContain('is_blacklisted');
    expect(allQuery).toContain('COALESCE(is_blacklisted, 0) = 0');
  });
});
