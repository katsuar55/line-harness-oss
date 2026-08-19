/**
 * Tests for GET /api/liff/portal-bootstrap (Ultraplan PR-2).
 *
 * Covers:
 *   - 正常系: 14 section 全てが { ok: true, data } で返る
 *   - 部分失敗: 1 section の DB reject は { ok: false, status: 500 } に畳まれ、他 section に伝播しない
 *   - 未認証 (liffUser なし) → 401
 *   - Cache-Control: no-store (顧客個人データ束をキャッシュに残さない)
 *   - 応答 shape の同値検証: section の data が既存個別 endpoint
 *     (POST /api/liff/rank / POST /api/liff/coupons) の data と deepEqual
 *     (= 抽出前後で shape が 1 bit も変わっていないことの実測)
 *
 * mock 作法は liff-portal.test.ts を踏襲 (vi.mock('@line-crm/db') + importOriginal、
 * liffUser は header ベースの middleware stub で注入)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — portal-read.ts の read 関数が触る query 関数のみ差し替え。
// importOriginal で残り (calculateLevel / pointsToNextLevel 等の純関数) は実物を使う。
// ---------------------------------------------------------------------------
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getFriendRank: vi.fn(async (_db: unknown, friendId: string) => {
      if (friendId === 'friend-1') {
        return { id: 'fr-1', friend_id: 'friend-1', rank_id: 'rank-silver', total_spent: 15000, orders_count: 5 };
      }
      return null;
    }),
    getMemberRanks: vi.fn(async () => [
      { id: 'rank-regular', name: 'Regular', color: '#888', icon: 'star', min_total_spent: 0, benefits_json: '{"discount":0}', sort_order: 0 },
      { id: 'rank-bronze', name: 'Bronze', color: '#CD7F32', icon: 'bronze', min_total_spent: 1, benefits_json: '{"discount":3}', sort_order: 1 },
      { id: 'rank-silver', name: 'Silver', color: '#C0C0C0', icon: 'silver', min_total_spent: 12000, benefits_json: '{"discount":5}', sort_order: 2 },
      { id: 'rank-gold', name: 'Gold', color: '#FFD700', icon: 'gold', min_total_spent: 24000, benefits_json: '{"discount":7}', sort_order: 3 },
      { id: 'rank-platinum', name: 'Platinum', color: '#E5E4E2', icon: 'platinum', min_total_spent: 45000, benefits_json: '{"discount":10}', sort_order: 4 },
    ]),
    getCouponAssignmentsByFriend: vi.fn(async (_db: unknown, _friendId: string, _unusedOnly?: boolean) => [
      { coupon_id: 'cp-1', code: 'WELCOME500', title: '500円OFF', description: '初回限定', discount_type: 'fixed', discount_value: 500, minimum_order_amount: 3000, expires_at: '2026-12-31', assigned_at: '2026-01-01' },
    ]),
    getReferralStats: vi.fn(async () => ({ totalReferred: 5, pendingRewards: 2, rewardedCount: 3 })),
    getReferralLink: vi.fn(async () => null),
    getAmbassador: vi.fn(async (_db: unknown, friendId: string) => {
      if (friendId === 'friend-1') {
        return { id: 'amb-1', status: 'active', tier: 'standard', enrolled_at: '2026-04-01', total_surveys_completed: 2, total_product_tests: 1, feedback_score: 4.5, preferences: '{"survey_ok":true,"product_test_ok":true,"sns_share_ok":false}' };
      }
      return null;
    }),
    getTodayTip: vi.fn(async () => ({ id: 'tip-1', tip_date: '2026-04-06', category: 'nutrition', title: '水分補給のコツ', content: 'こまめな水分補給が大切です', image_url: null })),
    getFriendLanguage: vi.fn(async () => 'ja'),
    countWaitingReferralCoupons: vi.fn(async () => 0),
    getAllBadges: vi.fn(async () => [
      { id: 'bd-1', badge_code: 'first-intake', name: 'はじめの一歩', description: '初回服用記録', icon: 'star', is_active: 1 },
    ]),
    getFriendBadges: vi.fn(async () => [
      { badge_code: 'first-intake', earned_at: '2026-04-01T09:00:00+09:00' },
    ]),
  };
});

// ---------------------------------------------------------------------------
// App setup — liffUser は header ベースの middleware stub で注入
// (liff-portal.test.ts の More Tab パターンと同じ。 shape 同値検証のため
//  既存 liffPortal と新 liffPortalBootstrap を同じ app に mount する)
// ---------------------------------------------------------------------------
const { liffPortal } = await import('../routes/liff-portal.js');
const { liffPortalBootstrap } = await import('../routes/liff-portal-bootstrap.js');

function createApp() {
  const app = new Hono();

  app.use('/api/liff/*', async (c, next) => {
    const friendId = c.req.header('X-Friend-Id');
    const lineUserId = c.req.header('X-Line-User-Id');
    if (friendId && lineUserId) {
      // 本物の liffAuthMiddleware と同じ shape (shopifyCustomerId 含む)
      (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', {
        lineUserId,
        friendId,
        shopifyCustomerId: null,
      });
    }
    return next();
  });

  app.route('/', liffPortalBootstrap);
  app.route('/', liffPortal);
  return app;
}

function mockEnv() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn(async () => ({ success: true })),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
  };
  return {
    DB: { prepare: vi.fn(() => mockStmt) } as unknown as D1Database,
    AI: {} as Ai,
    WORKER_URL: 'https://test.workers.dev',
    SHOPIFY_STORE_DOMAIN: 'naturism-diet.com',
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
  };
}

const AUTH_HEADERS = { 'X-Friend-Id': 'friend-1', 'X-Line-User-Id': 'U_EXISTING' };

const SECTION_KEYS = [
  'rank',
  'coupons',
  'welcomeCoupon',
  'referralCoupon',
  'linkCoupon',
  'friendCoupon',
  'referral',
  'ranking',
  'ambassador',
  'tip',
  'profile',
  'intakeToday',
  'badges',
  'language',
];

type Section = { ok: true; data: unknown } | { ok: false; status: number };
interface BootstrapBody {
  success: boolean;
  data: Record<string, Section>;
}

function getBootstrap(app: ReturnType<typeof createApp>, env: ReturnType<typeof mockEnv>, headers: Record<string, string> = AUTH_HEADERS) {
  return app.request('/api/liff/portal-bootstrap', { method: 'GET', headers }, env);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /api/liff/portal-bootstrap', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('正常系: 14 section 全てが ok:true で返り、キーが契約どおり揃う', async () => {
    const res = await getBootstrap(app, mockEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as BootstrapBody;
    expect(json.success).toBe(true);

    expect(Object.keys(json.data).sort()).toEqual([...SECTION_KEYS].sort());
    for (const key of SECTION_KEYS) {
      expect(json.data[key].ok, `section ${key} should be ok`).toBe(true);
    }

    // 代表 section の中身 (個別 endpoint と同じ shape の spot check)
    const rank = json.data.rank as { ok: true; data: { totalSpent: number; currentRank: { name: string }; linked: boolean } };
    expect(rank.data.totalSpent).toBe(15000);
    expect(rank.data.currentRank.name).toBe('Silver');
    expect(rank.data.linked).toBe(false);

    const coupons = json.data.coupons as { ok: true; data: { coupons: Array<{ code: string }> } };
    expect(coupons.data.coupons).toHaveLength(1);
    expect(coupons.data.coupons[0].code).toBe('WELCOME500');

    // gate off の 2 section は DB 不触の空 (既存個別 endpoint と同じ)
    expect((json.data.referralCoupon as { data: unknown }).data).toEqual({ coupons: [], count: 0, queuedCount: 0 });
    expect((json.data.linkCoupon as { data: unknown }).data).toEqual({ coupon: null });

    expect((json.data.welcomeCoupon as { data: unknown }).data).toEqual({ coupon: null });
    expect((json.data.friendCoupon as { data: { enabled: boolean } }).data.enabled).toBe(false);
    expect((json.data.tip as { data: { title: string } }).data.title).toBe('水分補給のコツ');
    expect((json.data.language as { data: { lang: string } }).data.lang).toBe('ja');
    expect((json.data.ambassador as { data: { status: string; surveysCompleted: number } }).data.status).toBe('active');
    expect((json.data.ambassador as { data: { surveysCompleted: number } }).data.surveysCompleted).toBe(2);
    expect((json.data.referral as { data: { totalReferred: number; hasLink: boolean } }).data.totalReferred).toBe(5);
    expect((json.data.referral as { data: { hasLink: boolean } }).data.hasLink).toBe(false);
    expect((json.data.ranking as { data: unknown }).data).toEqual([]);
    expect((json.data.profile as { data: unknown }).data).toEqual({});
    expect((json.data.intakeToday as { data: { recorded: Record<string, boolean> } }).data.recorded).toEqual({
      breakfast: false, lunch: false, dinner: false, snack: false,
    });
    const badges = json.data.badges as { ok: true; data: { score: number; level: number; earnedBadges: Array<{ code: string }> } };
    expect(badges.data.score).toBe(0); // DB stub の first() は null → score 0
    expect(badges.data.earnedBadges).toEqual([{ code: 'first-intake', earnedAt: '2026-04-01T09:00:00+09:00' }]);
  });

  it('部分失敗: 1 section の reject は ok:false/status:500 に畳まれ、他 section は ok:true のまま', async () => {
    const db = await import('@line-crm/db');
    (db.getReferralStats as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const res = await getBootstrap(app, mockEnv());
    expect(res.status).toBe(200); // 全体は 200 のまま (section 単位でエラーを閉じる)
    const json = await res.json() as BootstrapBody;
    expect(json.success).toBe(true);

    expect(json.data.referral).toEqual({ ok: false, status: 500 });
    // 失敗が隣に伝播していないこと
    for (const key of SECTION_KEYS.filter((k) => k !== 'referral')) {
      expect(json.data[key].ok, `section ${key} should survive referral failure`).toBe(true);
    }
  });

  it('未認証 (liffUser なし) → 401', async () => {
    const res = await getBootstrap(app, mockEnv(), {});
    expect(res.status).toBe(401);
    const json = await res.json() as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('Cache-Control: no-store (顧客個人データ束を中間キャッシュに残さない)', async () => {
    const res = await getBootstrap(app, mockEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // ─── 応答 shape の同値検証 (抽出の同値証明) ─────────────────
  // 同じ mock / 同じ liffUser で「既存個別 endpoint の data」と
  // 「bootstrap の section data」を両方取得し deepEqual で照合する。

  it('rank section の data は既存 POST /api/liff/rank の data と deepEqual', async () => {
    const rankRes = await app.request('/api/liff/rank', { method: 'POST', headers: AUTH_HEADERS }, mockEnv());
    expect(rankRes.status).toBe(200);
    const rankJson = await rankRes.json() as { data: unknown };

    const bootRes = await getBootstrap(app, mockEnv());
    expect(bootRes.status).toBe(200);
    const bootJson = await bootRes.json() as BootstrapBody;

    expect(bootJson.data.rank).toEqual({ ok: true, data: rankJson.data });
  });

  it('coupons section の data は既存 POST /api/liff/coupons の data と deepEqual', async () => {
    const couponsRes = await app.request('/api/liff/coupons', { method: 'POST', headers: AUTH_HEADERS }, mockEnv());
    expect(couponsRes.status).toBe(200);
    const couponsJson = await couponsRes.json() as { data: unknown };

    const bootRes = await getBootstrap(app, mockEnv());
    expect(bootRes.status).toBe(200);
    const bootJson = await bootRes.json() as BootstrapBody;

    expect(bootJson.data.coupons).toEqual({ ok: true, data: couponsJson.data });
  });
});
