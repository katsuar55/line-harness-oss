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
  issueOrEnqueueReferralCoupon: vi.fn(),
  activateNextQueuedReferralCoupon: vi.fn(async () => null),
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
  buildReferrerQueuedMessage,
  type ReferralRewardEnv,
} from '../services/referral-reward.js';
import { issueOrEnqueueReferralCoupon } from '../services/referral-coupon-issuer.js';
import { dispatch } from '../services/channel-dispatcher.js';

const mockIssue = issueOrEnqueueReferralCoupon as ReturnType<typeof vi.fn>;
const mockDispatch = dispatch as ReturnType<typeof vi.fn>;

interface RewardRow {
  id: string;
  referrer_friend_id: string;
  referred_friend_id: string;
  status: string;
  rewarded_at: string | null;
  created_at: string;
}

class FakeDb {
  rewards: RewardRow[] = [];
  friends: Record<string, { line_user_id: string | null }> = {};
  /** CAS-loser を再現: pending が見えても flip は changes:0 を返す (並行の敗者) */
  forceFlipLoser = false;

  prepare(sql: string) {
    const isSelectPending =
      sql.includes('FROM referral_rewards') && sql.includes("status = 'pending'") && sql.includes('referred_friend_id = ?');
    const hasLimit1 = /LIMIT\s+1/i.test(sql);
    const hasOrderByCreatedAsc = /ORDER BY created_at ASC/i.test(sql);
    const isFlip =
      sql.includes('UPDATE referral_rewards') && sql.includes("status = 'rewarded'");
    const isSelectFriend = sql.includes('line_user_id FROM friends');
    return {
      bind: (...params: unknown[]) => ({
        all: async () => {
          if (isSelectPending) {
            const referred = params[0] as string;
            let matched = this.rewards.filter((r) => r.referred_friend_id === referred && r.status === 'pending');
            // 実 SQL の ORDER BY created_at ASC / LIMIT 1 を honor (= LIMIT 1 の挙動を検証可能にする)
            if (hasOrderByCreatedAsc) matched = matched.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
            if (hasLimit1) matched = matched.slice(0, 1);
            const results = matched.map((r) => ({ id: r.id, referrer_friend_id: r.referrer_friend_id }));
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
            if (this.forceFlipLoser) {
              // 並行の敗者: 別実行が先に flip した体で pending のまま changes:0 を返す
              return { success: true, meta: { changes: 0 } };
            }
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

/** RewardRow 生成 helper (created_at default 付き) */
function reward(partial: Partial<RewardRow> & Pick<RewardRow, 'id' | 'referrer_friend_id' | 'referred_friend_id'>): RewardRow {
  return { status: 'pending', rewarded_at: null, created_at: '2026-07-01T00:00:00.000Z', ...partial };
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
    kind: 'issued',
    coupon: {
      code: 'NREF-R-REWARD01',
      discountValue: 500,
      discountCurrency: 'JPY',
      role: 'referrer',
      expiresAt: new Date(FIXED_NOW + 60 * 86_400_000).toISOString(),
      isExisting: false,
      shopifyDiscountCodeId: 'gid://x',
    },
  });
});

describe('processReferralRewardOnPurchase', () => {
  it('gate off → 完全 no-op (issue/push しない)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
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
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
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
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_referrer' };

    await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    mockDispatch.mockClear();
    mockIssue.mockClear();
    const res2 = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res2.pendingFound).toBe(0);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('coupon 発行失敗 (kind=failed) → flip せず・push せず', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_referrer' };
    mockIssue.mockResolvedValueOnce({ kind: 'failed' });

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(0);
    expect(res.pushed).toBe(0);
    expect(db.rewards[0].status).toBe('pending'); // flip されていない (再試行の余地)
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('blacklist/not_following (dispatch skipped) → coupon は発行/flip 済だが pushed=0', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_referrer' };
    mockDispatch.mockResolvedValueOnce({ results: [{ channel: 'line', status: 'skipped', reason: 'blacklisted' }] });

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(1);
    expect(res.pushed).toBe(0);
    expect(db.rewards[0].status).toBe('rewarded');
  });

  it('自己紹介 (referrer===referred) → skip (issue/flip/push しない)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'B', referred_friend_id: 'B' }));
    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.pendingFound).toBe(1);
    expect(res.rewarded).toBe(0);
    expect(mockIssue).not.toHaveBeenCalled();
    expect(db.rewards[0].status).toBe('pending');
  });

  it('複数 referrer が同 referred を claim → 1 購入で最古 (先着) 1 referrer のみ報酬 (増幅防止・review HIGH)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rwA', referrer_friend_id: 'A', referred_friend_id: 'B', created_at: '2026-07-01T00:00:00.000Z' }));
    db.rewards.push(reward({ id: 'rwC', referrer_friend_id: 'C', referred_friend_id: 'B', created_at: '2026-07-02T00:00:00.000Z' }));
    db.friends['A'] = { line_user_id: 'U_A' };
    db.friends['C'] = { line_user_id: 'U_C' };

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.pendingFound).toBe(1); // ORDER BY created_at ASC LIMIT 1
    expect(res.rewarded).toBe(1);
    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue.mock.calls[0][2]).toMatchObject({ friendId: 'A', role: 'referrer' }); // 最古 A のみ
    expect(db.rewards.find((r) => r.id === 'rwA')!.status).toBe('rewarded');
    expect(db.rewards.find((r) => r.id === 'rwC')!.status).toBe('pending'); // C は据置
  });

  it('並行 CAS 敗者 (flip changes===0 while pending) → coupon 冪等発行済でも push しない (二重 push 防止・review HIGH)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_A' };
    db.forceFlipLoser = true; // 別実行が先に flip を勝ち取った体

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(1); // coupon は冪等発行された
    expect(res.pushed).toBe(0);   // が flip に負けたので push しない
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('referrer が既にクーポン受給済 (kind=existing) → reward 行は flip するが push しない (誤通知防止・review MEDIUM)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_A' };
    mockIssue.mockResolvedValueOnce({
      kind: 'existing',
      coupon: {
        code: 'NREF-R-EXISTING', discountValue: 500, discountCurrency: 'JPY', role: 'referrer',
        expiresAt: new Date(FIXED_NOW + 60 * 86_400_000).toISOString(), isExisting: true, shopifyDiscountCodeId: 'gid://x',
      },
    });
    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(1);
    expect(res.pushed).toBe(0);
    expect(db.rewards[0].status).toBe('rewarded'); // terminal 化 (再処理防止)
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('順次活性化 (kind=queued) → flip する + 「順番待ち」variant を push (コードは含まない)', async () => {
    const db = new FakeDb();
    db.rewards.push(reward({ id: 'rw1', referrer_friend_id: 'A', referred_friend_id: 'B' }));
    db.friends['A'] = { line_user_id: 'U_A' };
    mockIssue.mockResolvedValueOnce({ kind: 'queued', waitingCount: 2 });

    const res = await processReferralRewardOnPurchase(db as unknown as D1Database, makeEnv(), fakeLineClient, { referredFriendId: 'B', now: () => FIXED_NOW });
    expect(res.rewarded).toBe(1);
    expect(res.pushed).toBe(1);
    expect(db.rewards[0].status).toBe('rewarded'); // queued でも報酬は確定 (T1/T2/T3 が後で活性化)
    const payload = mockDispatch.mock.calls[0][1] as { linePayload: { messages: Array<{ altText: string; contents: unknown }> } };
    const json = JSON.stringify(payload.linePayload.messages[0]);
    expect(json).toContain('待機中 2枚');
    expect(json).not.toContain('NREF-'); // コードはまだ存在しない
  });
});

describe('buildReferrerQueuedMessage', () => {
  it('待機枚数と「自動でひらきます」を含み、クーポンコードを含まない', () => {
    const msg = buildReferrerQueuedMessage(3, 'https://liff.line.me/123');
    expect(msg.type).toBe('flex');
    const json = JSON.stringify(msg.contents);
    expect(json).toContain('待機中 3枚');
    expect(json).toContain('自動でひらきます');
    expect(json).toContain('クーポンを見る');
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
