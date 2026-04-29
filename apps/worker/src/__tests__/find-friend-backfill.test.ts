/**
 * Unit tests for findFriendAndBackfill helper (Round 4 PR-0).
 *
 * Background: Phase 6 KPI レポートで判明した課題:
 *   users.email が常に NULL → email マッチング 0 件 → Phase 6 PR-2 enroll が永遠に発火しない
 *
 * このヘルパーは email/phone のどちらかで user が見つかった時、
 * もう片方が NULL なら Shopify 側の値で back-fill する。
 *
 * テスト対象 (apps/worker/src/routes/shopify.ts):
 *   findFriendAndBackfill(db, email, phone) → MatchResult
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mocks to the top
vi.mock('@line-crm/db', () => ({
  upsertShopifyOrder: vi.fn(),
  upsertShopifyCustomer: vi.fn(),
  upsertShopifyProduct: vi.fn(),
  getShopifyOrders: vi.fn(),
  getShopifyOrderById: vi.fn(),
  getShopifyCustomers: vi.fn(),
  getShopifyOrderByShopifyId: vi.fn(),
  getShopifyCustomerByShopifyId: vi.fn(),
  linkShopifyCustomerToFriend: vi.fn(),
  jstNow: () => '2026-04-29T07:00:00+09:00',
}));

vi.mock('../utils/shopify-hmac.js', () => ({
  verifyShopifySignature: vi.fn(),
}));

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(),
}));

import { findFriendAndBackfill } from '../routes/shopify.js';

// ---------------------------------------------------------------------------
// Mock D1 helper
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type QueryResponder = (sql: string, params: unknown[]) => Row | null;

interface MockDb {
  db: D1Database;
  updateCalls: Array<{ sql: string; params: unknown[] }>;
}

function createMockDb(responder: QueryResponder): MockDb {
  const updateCalls: Array<{ sql: string; params: unknown[] }> = [];

  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => responder(sql, params),
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.trim().toUpperCase().startsWith('UPDATE')) {
            updateCalls.push({ sql, params });
          }
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;

  return { db, updateCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findFriendAndBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('email で user 見つかり phone も埋まっている → back-fill なし', async () => {
    const { db, updateCalls } = createMockDb((sql, params) => {
      if (sql.includes('FROM users WHERE email')) {
        return { id: 'user-1', email: 'a@x.com', phone: '+819011112222' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-1' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'a@x.com', '+819011112222');

    expect(result.friendId).toBe('friend-1');
    expect(result.matchedBy).toBe('email');
    expect(result.backfilled).toBe('none');
    expect(updateCalls).toHaveLength(0);
  });

  it('email で user 見つかり phone が NULL → phone を back-fill', async () => {
    const { db, updateCalls } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE email')) {
        return { id: 'user-2', email: 'b@x.com', phone: null };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-2' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'b@x.com', '090-1234-5678');

    expect(result.friendId).toBe('friend-2');
    expect(result.matchedBy).toBe('email');
    expect(result.backfilled).toBe('phone');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.sql).toContain('UPDATE users SET phone');
    // phone は normalize 済 (ハイフン除去)
    expect(updateCalls[0]?.params[0]).toBe('09012345678');
  });

  it('phone で user 見つかり email が NULL → email を back-fill (主要ユースケース)', async () => {
    const { db, updateCalls } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE email')) return null;
      if (sql.includes('FROM users WHERE phone')) {
        return { id: 'user-3', email: null, phone: '09033334444' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-3' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'shopify@x.com', '090-3333-4444');

    expect(result.friendId).toBe('friend-3');
    expect(result.matchedBy).toBe('phone');
    expect(result.backfilled).toBe('email');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.sql).toContain('UPDATE users SET email');
    expect(updateCalls[0]?.params[0]).toBe('shopify@x.com');
  });

  it('phone で見つかり email も既に埋まっている → back-fill なし', async () => {
    const { db, updateCalls } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE email')) return null;
      if (sql.includes('FROM users WHERE phone')) {
        return { id: 'user-4', email: 'existing@x.com', phone: '09055556666' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-4' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'shopify-different@x.com', '090-5555-6666');

    expect(result.matchedBy).toBe('phone');
    expect(result.backfilled).toBe('none');
    // 既に email が入っているので Shopify 側の email では上書きしない
    expect(updateCalls).toHaveLength(0);
  });

  it('email/phone どちらでも見つからない → null 返却 / back-fill なし', async () => {
    const { db, updateCalls } = createMockDb(() => null);

    const result = await findFriendAndBackfill(db, 'unknown@x.com', '090-9999-0000');

    expect(result.friendId).toBeNull();
    expect(result.matchedBy).toBeNull();
    expect(result.backfilled).toBe('none');
    expect(updateCalls).toHaveLength(0);
  });

  it('user は見つかったが friend が無い → friendId=null だが backfill は実行する', async () => {
    const { db, updateCalls } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE phone')) {
        return { id: 'user-5', email: null, phone: '09077778888' };
      }
      if (sql.includes('FROM friends WHERE user_id')) return null;
      return null;
    });

    const result = await findFriendAndBackfill(db, 'orphan@x.com', '090-7777-8888');

    expect(result.friendId).toBeNull();
    expect(result.matchedBy).toBe('phone');
    // friend が無くても user.email は埋める (将来 friend 紐付きする時のため)
    expect(result.backfilled).toBe('email');
    expect(updateCalls).toHaveLength(1);
  });

  it('email 引数が undefined / phone のみで検索成功時は phone path のみ', async () => {
    const { db } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE phone')) {
        return { id: 'user-6', email: null, phone: '09011112222' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-6' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, undefined, '+819011112222');

    expect(result.friendId).toBe('friend-6');
    expect(result.matchedBy).toBe('phone');
    // email が undefined なので backfill 対象なし
    expect(result.backfilled).toBe('none');
  });

  it('phone 引数が undefined / email のみ → email path のみ', async () => {
    const { db } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE email')) {
        return { id: 'user-7', email: 'c@x.com', phone: '09099990000' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-7' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'c@x.com', undefined);

    expect(result.friendId).toBe('friend-7');
    expect(result.matchedBy).toBe('email');
    expect(result.backfilled).toBe('none');
  });

  it('email/phone 両方 undefined → 即 null', async () => {
    const { db, updateCalls } = createMockDb(() => null);

    const result = await findFriendAndBackfill(db, undefined, undefined);

    expect(result.friendId).toBeNull();
    expect(result.matchedBy).toBeNull();
    expect(updateCalls).toHaveLength(0);
  });

  it('email が空文字 (DB の "" 値) の user → backfill 実行 (NULL 同等扱い)', async () => {
    const { db, updateCalls } = createMockDb((sql) => {
      if (sql.includes('FROM users WHERE phone')) {
        return { id: 'user-8', email: '', phone: '09011112222' };
      }
      if (sql.includes('FROM friends WHERE user_id')) {
        return { id: 'friend-8' };
      }
      return null;
    });

    const result = await findFriendAndBackfill(db, 'newemail@x.com', '+819011112222');

    expect(result.backfilled).toBe('email');
    expect(updateCalls).toHaveLength(1);
  });
});
