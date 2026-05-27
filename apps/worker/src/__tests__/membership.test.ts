/**
 * Tests for services/membership (= Phase 4 PR #82、 2026-05-27)
 *
 * カバー範囲:
 *   - formatTierBenefits: 各 tier perks (= bronze/silver/gold/platinum/ambassador)
 *   - buildTierUpFlex: header/body/footer 構造、 oldTier→newTier 表示、 displayName 埋込
 *   - buildTierUpIntro: text format
 *   - promoteAndNotify: promote 不要 / promoted + push 成功 / promoted + push 失敗 / tier lookup fail
 *   - checkAndNotifyForFriend: member 不在 / friend 不在
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';

// ============================================================
// Mock @line-crm/db
// ============================================================

const state = {
  promotedResult: { promoted: false, fromTier: 'bronze', toTier: 'bronze' },
  tierLookupResults: new Map<string, unknown>(),
  memberLookup: null as unknown,
};

vi.mock('@line-crm/db', () => ({
  promoteMemberIfEligible: vi.fn(async () => state.promotedResult),
  getMembershipTierById: vi.fn(async (_db: unknown, tierId: string) => {
    return state.tierLookupResults.get(tierId) ?? null;
  }),
  getMemberByFriendId: vi.fn(async () => state.memberLookup),
}));

// ============================================================
// Test fixtures
// ============================================================

const bronzeTier = {
  id: 'bronze',
  name: 'ブロンズ',
  displayOrder: 1,
  minTotalPurchaseJpy: 0,
  minReferralCount: 0,
  perks: {},
  badgeEmoji: '🥉',
  badgeColor: '#cd7f32',
  isActive: true,
};

const silverTier = {
  id: 'silver',
  name: 'シルバー',
  displayOrder: 2,
  minTotalPurchaseJpy: 10000,
  minReferralCount: 0,
  perks: { discountPercent: 3 },
  badgeEmoji: '🥈',
  badgeColor: '#c0c0c0',
  isActive: true,
};

const goldTier = {
  id: 'gold',
  name: 'ゴールド',
  displayOrder: 3,
  minTotalPurchaseJpy: 30000,
  minReferralCount: 0,
  perks: { discountPercent: 5, prioritySupport: true },
  badgeEmoji: '🥇',
  badgeColor: '#ffd700',
  isActive: true,
};

const platinumTier = {
  id: 'platinum',
  name: 'プラチナ',
  displayOrder: 4,
  minTotalPurchaseJpy: 100000,
  minReferralCount: 3,
  perks: {
    discountPercent: 8,
    prioritySupport: true,
    exclusiveProducts: ['Pink Limited'],
  },
  badgeEmoji: '💎',
  badgeColor: '#e5e4e2',
  isActive: true,
};

const ambassadorTier = {
  id: 'ambassador',
  name: 'アンバサダー',
  displayOrder: 5,
  minTotalPurchaseJpy: 200000,
  minReferralCount: 10,
  perks: {
    discountPercent: 10,
    prioritySupport: true,
    exclusiveProducts: ['Pink Limited', 'Beta Test'],
    affiliateCode: true,
  },
  badgeEmoji: '🌟',
  badgeColor: '#ff6b9d',
  isActive: true,
};

function makeFakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[], success: true };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeLineClient() {
  return {
    pushMessage: vi.fn(async (_userId: string, _messages: unknown[]) => {}),
    replyMessage: vi.fn(async (_token: string, _messages: unknown[]) => {}),
  } as unknown as LineClient & {
    pushMessage: ReturnType<typeof vi.fn>;
    replyMessage: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  state.promotedResult = { promoted: false, fromTier: 'bronze', toTier: 'bronze' };
  state.tierLookupResults.clear();
  state.memberLookup = null;
  vi.clearAllMocks();
});

// ============================================================
// formatTierBenefits
// ============================================================

describe('formatTierBenefits', () => {
  it('bronze (= perks 空) → fallback message', async () => {
    const { __test__ } = await import('../services/membership.js');
    const lines = __test__.formatTierBenefits(bronzeTier);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('naturism');
  });

  it('silver (= 3% discount のみ) → 1 line', async () => {
    const { __test__ } = await import('../services/membership.js');
    const lines = __test__.formatTierBenefits(silverTier);
    expect(lines.some((l) => /3% OFF/.test(l))).toBe(true);
  });

  it('gold (= discount + priority) → 2 lines', async () => {
    const { __test__ } = await import('../services/membership.js');
    const lines = __test__.formatTierBenefits(goldTier);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => /5% OFF/.test(l))).toBe(true);
    expect(lines.some((l) => /優先サポート/.test(l))).toBe(true);
  });

  it('platinum (= discount + priority + exclusive) → 3 lines', async () => {
    const { __test__ } = await import('../services/membership.js');
    const lines = __test__.formatTierBenefits(platinumTier);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => /8% OFF/.test(l))).toBe(true);
    expect(lines.some((l) => /Pink Limited/.test(l))).toBe(true);
  });

  it('ambassador (= 全 perks) → 4 lines', async () => {
    const { __test__ } = await import('../services/membership.js');
    const lines = __test__.formatTierBenefits(ambassadorTier);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.some((l) => /アフィリエイト/.test(l))).toBe(true);
  });
});

// ============================================================
// buildTierUpFlex
// ============================================================

describe('buildTierUpFlex', () => {
  it('header に oldTier name + newTier name + badge emoji を含む', async () => {
    const { __test__ } = await import('../services/membership.js');
    const flex = __test__.buildTierUpFlex(bronzeTier, silverTier, 'テスト太郎') as unknown as {
      header: { contents: Array<{ text?: string }> };
    };
    const headerTexts = flex.header.contents.map((c) => c.text).filter(Boolean).join(' ');
    expect(headerTexts).toContain('🥈');
    expect(headerTexts).toContain('ブロンズ');
    expect(headerTexts).toContain('シルバー');
  });

  it('body に displayName + benefits を含む', async () => {
    const { __test__ } = await import('../services/membership.js');
    const flex = __test__.buildTierUpFlex(silverTier, goldTier, '加藤勝久') as unknown as {
      body: { contents: Array<{ text?: string }> };
    };
    const bodyTexts = flex.body.contents
      .map((c) => c.text)
      .filter(Boolean)
      .join(' ');
    expect(bodyTexts).toContain('加藤勝久');
    expect(bodyTexts).toContain('ゴールド');
    expect(bodyTexts).toContain('5% OFF');
  });

  it('header backgroundColor = newTier.badgeColor', async () => {
    const { __test__ } = await import('../services/membership.js');
    const flex = __test__.buildTierUpFlex(silverTier, goldTier, 'X') as unknown as {
      header: { backgroundColor: string };
    };
    expect(flex.header.backgroundColor).toBe('#ffd700');
  });

  it('footer に公式ストア button を含む', async () => {
    const { __test__ } = await import('../services/membership.js');
    const flex = __test__.buildTierUpFlex(bronzeTier, silverTier, 'X') as unknown as {
      footer: { contents: Array<{ action?: { uri?: string; label?: string } }> };
    };
    const button = flex.footer.contents.find(
      (c) => c.action?.uri === 'https://naturism-diet.com/',
    );
    expect(button).toBeDefined();
  });

  it('badge emoji なしの tier でも flex 生成可', async () => {
    const { __test__ } = await import('../services/membership.js');
    const tierNoEmoji = { ...silverTier, badgeEmoji: null };
    const flex = __test__.buildTierUpFlex(bronzeTier, tierNoEmoji, 'X') as unknown as {
      header: unknown;
    };
    expect(flex.header).toBeDefined();
  });
});

// ============================================================
// buildTierUpIntro
// ============================================================

describe('buildTierUpIntro', () => {
  it('text + displayName + newTier name を含む', async () => {
    const { __test__ } = await import('../services/membership.js');
    const msg = __test__.buildTierUpIntro('加藤', goldTier) as { type: string; text: string };
    expect(msg.type).toBe('text');
    expect(msg.text).toContain('加藤');
    expect(msg.text).toContain('ゴールド');
    expect(msg.text).toContain('🥇');
  });
});

// ============================================================
// promoteAndNotify
// ============================================================

describe('promoteAndNotify', () => {
  it('promote 不要 (= 既 max tier) → pushed=false, push 呼ばれない', async () => {
    const { promoteAndNotify } = await import('../services/membership.js');
    state.promotedResult = { promoted: false, fromTier: 'gold', toTier: 'gold' };
    const lc = makeLineClient();

    const result = await promoteAndNotify(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-1',
      'U_123',
      '加藤',
    );

    expect(result.promoted).toBe(false);
    expect(result.pushed).toBe(false);
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });

  it('promoted + tier 両方取得 → push 成功', async () => {
    const { promoteAndNotify } = await import('../services/membership.js');
    state.promotedResult = { promoted: true, fromTier: 'bronze', toTier: 'silver' };
    state.tierLookupResults.set('bronze', bronzeTier);
    state.tierLookupResults.set('silver', silverTier);
    const lc = makeLineClient();

    const result = await promoteAndNotify(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-1',
      'U_abc',
      '加藤',
    );

    expect(result.promoted).toBe(true);
    expect(result.pushed).toBe(true);
    expect(lc.pushMessage).toHaveBeenCalledTimes(1);
    const [userId, messages] = lc.pushMessage.mock.calls[0];
    expect(userId).toBe('U_abc');
    expect(messages).toHaveLength(2); // intro text + flex
  });

  it('promoted + tier lookup fail → pushed=false, reason', async () => {
    const { promoteAndNotify } = await import('../services/membership.js');
    state.promotedResult = { promoted: true, fromTier: 'bronze', toTier: 'unknown_tier' };
    state.tierLookupResults.set('bronze', bronzeTier);
    // unknown_tier の lookup は null 返す
    const lc = makeLineClient();

    const result = await promoteAndNotify(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-1',
      'U_x',
      'X',
    );

    expect(result.promoted).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe('tier lookup failed');
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });

  it('display_name null → 「お客様」 fallback', async () => {
    const { promoteAndNotify } = await import('../services/membership.js');
    state.promotedResult = { promoted: true, fromTier: 'bronze', toTier: 'silver' };
    state.tierLookupResults.set('bronze', bronzeTier);
    state.tierLookupResults.set('silver', silverTier);
    const lc = makeLineClient();

    await promoteAndNotify(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-null',
      'U_null',
      null,
    );

    const [, messages] = lc.pushMessage.mock.calls[0] as [string, Array<{ text?: string }>];
    const intro = messages[0]!;
    expect(intro.text).toContain('お客様');
  });

  it('push 失敗 → pushed=false、 例外 throw しない', async () => {
    const { promoteAndNotify } = await import('../services/membership.js');
    state.promotedResult = { promoted: true, fromTier: 'bronze', toTier: 'silver' };
    state.tierLookupResults.set('bronze', bronzeTier);
    state.tierLookupResults.set('silver', silverTier);
    const lc = makeLineClient();
    lc.pushMessage.mockRejectedValueOnce(new Error('LINE API down'));

    const result = await promoteAndNotify(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-1',
      'U_fail',
      'X',
    );

    expect(result.promoted).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.reason).toContain('LINE API down');
  });
});

// ============================================================
// checkAndNotifyForFriend
// ============================================================

describe('checkAndNotifyForFriend', () => {
  it('member 不在 → promoted=false, reason="member not found"', async () => {
    const { checkAndNotifyForFriend } = await import('../services/membership.js');
    state.memberLookup = null;
    const lc = makeLineClient();

    const result = await checkAndNotifyForFriend(
      { DB: makeFakeDb(), LINE_CHANNEL_ACCESS_TOKEN: 'test' },
      lc,
      'friend-none',
    );

    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('member not found');
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });
});
