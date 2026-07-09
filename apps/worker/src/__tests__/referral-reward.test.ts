/**
 * Tests for referral-reward (紹介者への購入時報酬, 2026-07-10).
 *
 * Covers:
 *   - gate off → 完全 no-op (issue も push もしない)
 *   - pending reward 無し (organic buyer) → no-op
 *   - pending reward 有り → referrer coupon 発行 + atomic flip (pending→rewarded) + push
 *   - 冪等: 2 回目呼出は既に rewarded で pending 無し → no-op (push 重複なし)
 *   - coupon 発行失敗 (issue が null) → flip せず・push せず (次回購入で再試行の余地)
 *   - blacklist/not_following (dispatch skipped) → coupon は発行/ flip 済だが pushed=0
 *   - 自己紹介 (referrer===referred) → skip
 *   - buildReferrerRewardMessage の中身
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/referral-coupon-issuer.js', () => ({
  issueReferralCoupon: vi.fn(),
}));
vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: vi.fn(),
}));
vi.mock('../services/audit-logger.js', () => ({
  auditSystem: vi.fn(async () => {}),
}));

import {
  processReferralRewardOnPurchase,
  buildReferrerRewardMessage,
  type ReferralRewardEnv,
} from '../services/referral-reward.js';
import { issueReferralCoupon } from '../services/referral-coupon-issuer.js';
import { dispatch } from '../services/channel-dispatcher.js';

const mockIssue = issueReferralCoupon as ReturnType<typeof vi.fn>;
const mockDispatch = dispatch as ReturnType<typeof vi.fn>;

interface RewardRow {
  id: string;
  referrer_friend_id: string;
  referred_friend_id: string;
  status: string;
  rewarded_at: string | null;
}

class FakeDb {
  rewards: RewardRow[] = [];
  friends: Record<string, { line_user_id: string | null }> = {};

  prepare(sql: string) {
    const isSelectPending =
      sql.includes('FROM referral_rewards') && sql.includes("status = 'pending'") && sql.includes('referred_friend_id = ?');
    const isFlip =
      sql.includes('UPDATE referral_rewards') && sql.includes("status = 'rewarded'");
    const isSelectFriend = sql.includes('line_user_id FROM friends');
    return {
      bind: (...params: unknown[]) => ({
        all: async () => {
          if (isSelectPending) {
            const referred = params[0] as string;
            const results = this.rewards
              .filter((r) => r.referred_friend_id === referred && r.status === 'pending')
              .map((r) => ({ id: r.id, referrer_friend_id: r.referrer_friend_id }));
            return { results };
          }
          return { results: [] };
        },
        first: async () => {
          if (isSelectFriend) {
            const id = params[0] as string;
            return this.friends[id] ?? null;
          }
          return null;
        },
        run: async () => {
          if (isFlip) {
            const rewardedAt = params[0] as string;
            const id = params[1] as string;
            const row = this.rewards.find((r) => r.id === id && r.status === 'pending');
            if (!row) return { success: true, meta: { changes: 0 } };
            row.status = 'rewarded';
            row.rewarded_at = rewardedAt;
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      }),
    };
  }
}

const FIXED_NOW = new Date('2026-07-10T00:00:00.000Z').getTime();

function makeEnv(overrides: Partial<ReferralRewardEnv> = {}): ReferralRewardEnv {
  return {
    SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
    SHOPIFY_CLIENT_ID: 'id',
    SHOPIFY_CLIENT_SECRET: 'secret',
    REFERRAL_REWARD_ENABLED: 'true',
    LIFF_URL: 'https://liff.line.me/123-abc',
    ...overrides,
  };
}

const fakeLineClient = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockResolvedValue({ results: [{ channel: 'line', status: 'sent' }] });
  mockIssue.mockResolvedValue({
    code: 'NREF-R-REWARD01',
    discountValue: 500,
    discountCurrency: 'JPY',
    role: 'referrer',
    expiresAt: new Date(FIXED_NOW + 7 * 86_400_000).toISOString(),
    isExisting: false,
    shopifyDiscountCodeId: 'gid://x',
  });
});

describe('processReferralRewardOnPurchase', () => {
  it('gate off → 完全 no-op (issue/push しない)', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    const res = await processReferralRewardOnPurchase(
      db as unknown as D1Database,
      makeEnv({ REFERRAL_REWARD_ENABLED: undefined }),
      fakeLineClient,
      { referredFriendId: 'B', now: () => FIXED_NOW },
    );
    expect(res).toEqual({ pendingFound: 0, rewarded: 0, pushed: 0 });
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(db.rewards[0].status).toBe('pending');
  });

  it('pending reward 無し (organic buyer) → no-op', async () => {
    const db = new FakeDb();
    const res = await processReferralRewardOnPurchase(
      db as unknown as D1Database, makeEnv(), fakeLineClient,
      { referredFriendId: 'B', now: () => FIXED_NOW },
    );
    expect(res.pendingFound).toBe(0);
    expect(res.rewarded).toBe(0);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it('pending reward → referrer coupon 発行 + flip (pending→rewarded) + push', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    db.friends['A'] = { line_user_id: 'U_referrer' };

    const res = await processReferralRewardOnPurchase(
      db as unknown as D1Database, makeEnv(), fakeLineClient,
      { referredFriendId: 'B', now: () => FIXED_NOW },
    );
    expect(res).toEqual({ pendingFound: 1, rewarded: 1, pushed: 1 });
    // referrer に対して発行
    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue.mock.calls[0][2]).toMatchObject({ friendId: 'A', role: 'referrer', rewardId: 'rw1' });
    // flip
    expect(db.rewards[0].status).toBe('rewarded');
    expect(db.rewards[0].rewarded_at).toBe(new Date(FIXED_NOW).toISOString());
    // push は referrer の line_user_id 宛
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1].recipient.friend).toMatchObject({ id: 'A', lineUserId: 'U_referrer' });
    expect(mockDispatch.mock.calls[0][1].category).toBe('transactional');
  });

  it('冪等: 2 回目呼出は pending 無し → no-op (push 重複なし)', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    db.friends['A'] = { line_user_id: 'U_referrer' };

    await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    mockDispatch.mockClear();
    mockIssue.mockClear();
    const res2 = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res2.pendingFound).toBe(0);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('coupon 発行失敗 (issue が null) → flip せず・push せず', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    db.friends['A'] = { line_user_id: 'U_referrer' };
    mockIssue.mockResolvedValueOnce(null);

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(0);
    expect(res.pushed).toBe(0);
    expect(db.rewards[0].status).toBe('pending'); // flip されていない (再試行の余地)
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('blacklist/not_following (dispatch skipped) → coupon は発行/flip 済だが pushed=0', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    db.friends['A'] = { line_user_id: 'U_referrer' };
    mockDispatch.mockResolvedValueOnce({ results: [{ channel: 'line', status: 'skipped', reason: 'blacklisted' }] });

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(1);
    expect(res.pushed).toBe(0);
    expect(db.rewards[0].status).toBe('rewarded');
  });

  it('自己紹介 (referrer===referred) → skip (issue/flip/push しない)', async () => {
    const db = new FakeDb();
    db.rewards.push({ id: 'rw1', referrer_friend_id: 'B', referred_friend_id: 'B', status: 'pending', rewarded_at: null });
    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.pendingFound).toBe(1);
    expect(res.rewarded).toBe(0);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(db.rewards[0].status).toBe('pending');
  });
});

describe('buildReferrerRewardMessage', () => {
  it('altText と coupon code を含む Flex を返す', () => {
    const msg = buildReferrerRewardMessage('NREF-R-XYZ12345', '2026-07-17T00:00:00.000Z', 'https://liff.line.me/123');
    expect(msg.type).toBe('flex');
    expect(msg.altText).toContain('クーポン');
    const json = JSON.stringify(msg.contents);
    expect(json).toContain('NREF-R-XYZ12345');
    expect(json).toContain('2026-07-17');
    expect(json).toContain('クーポンを見る'); // footer button (liffUrl あり)
  });

  it('liffUrl 空なら footer なし', () => {
    const msg = buildReferrerRewardMessage('NREF-R-XYZ', null, '');
    expect((msg.contents as { footer?: unknown }).footer).toBeUndefined();
  });
});
