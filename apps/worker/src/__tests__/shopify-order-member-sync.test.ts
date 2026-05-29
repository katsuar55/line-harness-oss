/**
 * Tests for services/shopify-order-member-sync (= Phase 4-γ、 2026-05-28)
 *
 * カバー範囲:
 *   - resolveFriendForOrder: existing / email / phone / no-match の 4 path
 *   - syncOrderToMember: happy path / friend not matched / 既 applied (= 冪等)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

// ============================================================
// Mocks (= @line-crm/db addPurchaseEvent + services/membership)
// ============================================================

const addPurchaseEventMock = vi.fn();
const checkAndNotifyMock = vi.fn();

vi.mock('@line-crm/db', () => ({
  addPurchaseEvent: (...args: unknown[]) => addPurchaseEventMock(...args),
}));

vi.mock('../services/membership.js', () => ({
  checkAndNotifyForFriend: (...args: unknown[]) => checkAndNotifyMock(...args),
}));

// dynamic import 後 mock を解決して service を取得
async function loadService() {
  return await import('../services/shopify-order-member-sync.js');
}

// ============================================================
// D1 mock factory
// ============================================================

interface MockUser {
  id: string;
  email?: string;
  phone?: string;
}

interface MockFriend {
  id: string;
  user_id?: string;
  shopify_customer_id?: string;
}

function makeDb(opts: { users?: MockUser[]; friends?: MockFriend[] }): D1Database {
  const users = opts.users ?? [];
  const friends = opts.friends ?? [];
  return {
    prepare: (sql: string) => {
      const bound: unknown[] = [];
      const stmt: any = {
        bind: (...args: unknown[]) => {
          bound.push(...args);
          return stmt;
        },
        first: async () => {
          if (sql.includes('FROM users') && sql.includes('email = ?')) {
            const target = bound[0];
            // COLLATE NOCASE 指定時は case-insensitive 照合をシミュレート
            const ci = sql.includes('COLLATE NOCASE');
            return (
              users.find((u) =>
                ci
                  ? (u.email ?? '').toLowerCase() === String(target).toLowerCase()
                  : u.email === target,
              ) ?? null
            );
          }
          if (sql.includes('FROM users') && sql.includes('phone = ?')) {
            const target = bound[0];
            return users.find((u) => u.phone === target) ?? null;
          }
          if (sql.includes('FROM friends') && sql.includes('user_id = ?')) {
            const target = bound[0];
            return friends.find((f) => f.user_id === target) ?? null;
          }
          if (sql.includes('FROM friends') && sql.includes('shopify_customer_id = ?')) {
            const target = bound[0];
            return friends.find((f) => f.shopify_customer_id === target) ?? null;
          }
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

// ============================================================
// resolveFriendForOrder tests
// ============================================================

describe('resolveFriendForOrder', () => {
  beforeEach(() => {
    addPurchaseEventMock.mockReset();
    checkAndNotifyMock.mockReset();
  });

  it('returns existing friend_id without lookup', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({});
    const result = await resolveFriendForOrder(db, { existingFriendId: 'friend-1' });
    expect(result).toEqual({ friendId: 'friend-1', matchedBy: 'existing' });
  });

  it('matches by email', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [{ id: 'user-1', email: 'a@example.com' }],
      friends: [{ id: 'friend-1', user_id: 'user-1' }],
    });
    const result = await resolveFriendForOrder(db, { email: 'a@example.com' });
    expect(result).toEqual({ friendId: 'friend-1', matchedBy: 'email' });
  });

  it('matches by email case-insensitively (= COLLATE NOCASE)', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [{ id: 'user-1', email: 'a@example.com' }],
      friends: [{ id: 'friend-1', user_id: 'user-1' }],
    });
    const result = await resolveFriendForOrder(db, { email: 'A@Example.COM' });
    expect(result).toEqual({ friendId: 'friend-1', matchedBy: 'email' });
  });

  it('matches by phone after normalization', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [{ id: 'user-2', phone: '+819012345678' }],
      friends: [{ id: 'friend-2', user_id: 'user-2' }],
    });
    const result = await resolveFriendForOrder(db, { phone: '+81-90-1234-5678' });
    expect(result).toEqual({ friendId: 'friend-2', matchedBy: 'phone' });
  });

  it('returns null when no match', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({ users: [], friends: [] });
    const result = await resolveFriendForOrder(db, { email: 'x@example.com' });
    expect(result).toEqual({ friendId: null, matchedBy: null });
  });

  it('matches by shopify_customer_id (= Phase 4-ι direct bridge)', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      friends: [{ id: 'friend-cust-1', shopify_customer_id: 'cust-12345' }],
    });
    const result = await resolveFriendForOrder(db, { shopifyCustomerId: 'cust-12345' });
    expect(result).toEqual({ friendId: 'friend-cust-1', matchedBy: 'customer_id' });
  });

  it('customer_id match takes precedence over email/phone', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [{ id: 'user-1', email: 'a@example.com' }],
      friends: [
        { id: 'friend-via-email', user_id: 'user-1' },
        { id: 'friend-via-customer', shopify_customer_id: 'cust-99' },
      ],
    });
    const result = await resolveFriendForOrder(db, {
      shopifyCustomerId: 'cust-99',
      email: 'a@example.com',
    });
    expect(result.friendId).toBe('friend-via-customer');
    expect(result.matchedBy).toBe('customer_id');
  });

  it('falls back to email when customer_id provided but no friend match', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [{ id: 'user-1', email: 'a@example.com' }],
      friends: [{ id: 'friend-via-email', user_id: 'user-1' }],
    });
    const result = await resolveFriendForOrder(db, {
      shopifyCustomerId: 'unknown-cust',
      email: 'a@example.com',
    });
    expect(result.friendId).toBe('friend-via-email');
    expect(result.matchedBy).toBe('email');
  });

  it('email match takes precedence over phone', async () => {
    const { resolveFriendForOrder } = await loadService();
    const db = makeDb({
      users: [
        { id: 'user-1', email: 'a@example.com' },
        { id: 'user-2', phone: '+819000000000' },
      ],
      friends: [
        { id: 'friend-1', user_id: 'user-1' },
        { id: 'friend-2', user_id: 'user-2' },
      ],
    });
    const result = await resolveFriendForOrder(db, {
      email: 'a@example.com',
      phone: '+819000000000',
    });
    expect(result.friendId).toBe('friend-1');
    expect(result.matchedBy).toBe('email');
  });
});

// ============================================================
// syncOrderToMember tests
// ============================================================

describe('syncOrderToMember', () => {
  beforeEach(() => {
    addPurchaseEventMock.mockReset();
    checkAndNotifyMock.mockReset();
  });

  const fakeLineClient = {} as LineClient;

  function makeEnv(): { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string } {
    return {
      DB: makeDb({
        users: [{ id: 'user-1', email: 'a@example.com' }],
        friends: [{ id: 'friend-1', user_id: 'user-1' }],
      }),
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    };
  }

  it('happy path: matches by email, applies event, triggers promote', async () => {
    addPurchaseEventMock.mockResolvedValue({
      inserted: true,
      applied: true,
      eventId: 'evt-1',
      friendId: 'friend-1',
      amountJpy: 1980,
      newTotalPurchaseJpy: 1980,
    });
    checkAndNotifyMock.mockResolvedValue({
      promoted: false,
      fromTier: 'bronze',
      toTier: 'bronze',
      pushed: false,
    });

    const { syncOrderToMember } = await loadService();
    const env = makeEnv();
    const result = await syncOrderToMember(env, fakeLineClient, {
      shopifyOrderId: 'order-100',
      amountJpy: 1980,
      email: 'a@example.com',
      source: 'webhook',
    });

    expect(result.matchedBy).toBe('email');
    expect(result.event.applied).toBe(true);
    expect(result.promote?.promoted).toBe(false);
    expect(addPurchaseEventMock).toHaveBeenCalledOnce();
    expect(checkAndNotifyMock).toHaveBeenCalledWith(env, fakeLineClient, 'friend-1');
  });

  it('friend not matched: event recorded but member sync skipped', async () => {
    addPurchaseEventMock.mockResolvedValue({
      inserted: true,
      applied: false,
      eventId: 'evt-2',
      friendId: null,
      amountJpy: 5000,
      newTotalPurchaseJpy: null,
      reason: 'friend not matched',
    });

    const { syncOrderToMember } = await loadService();
    const env = makeEnv();
    const result = await syncOrderToMember(env, fakeLineClient, {
      shopifyOrderId: 'order-200',
      amountJpy: 5000,
      email: 'unknown@example.com',
    });

    expect(result.matchedBy).toBeNull();
    expect(result.event.applied).toBe(false);
    expect(result.promote).toBeNull();
    expect(checkAndNotifyMock).not.toHaveBeenCalled();
  });

  it('existing event already applied: returns duplicate, no promote', async () => {
    addPurchaseEventMock.mockResolvedValue({
      inserted: false,
      applied: true,
      eventId: 'evt-existing',
      friendId: 'friend-1',
      amountJpy: 1980,
      newTotalPurchaseJpy: null,
      reason: 'duplicate (already applied)',
    });

    const { syncOrderToMember } = await loadService();
    const env = makeEnv();
    const result = await syncOrderToMember(env, fakeLineClient, {
      shopifyOrderId: 'order-300',
      amountJpy: 1980,
      existingFriendId: 'friend-1',
    });

    expect(result.event.inserted).toBe(false);
    expect(result.event.applied).toBe(true);
    expect(result.event.reason).toContain('duplicate');
    expect(checkAndNotifyMock).toHaveBeenCalledOnce();
  });

  it('promote triggered when tier-up eligible', async () => {
    addPurchaseEventMock.mockResolvedValue({
      inserted: true,
      applied: true,
      eventId: 'evt-promote',
      friendId: 'friend-1',
      amountJpy: 12000,
      newTotalPurchaseJpy: 12000,
    });
    checkAndNotifyMock.mockResolvedValue({
      promoted: true,
      fromTier: 'bronze',
      toTier: 'silver',
      pushed: true,
    });

    const { syncOrderToMember } = await loadService();
    const env = makeEnv();
    const result = await syncOrderToMember(env, fakeLineClient, {
      shopifyOrderId: 'order-400',
      amountJpy: 12000,
      existingFriendId: 'friend-1',
    });

    expect(result.promote?.promoted).toBe(true);
    expect(result.promote?.toTier).toBe('silver');
    expect(result.promote?.pushed).toBe(true);
  });
});
