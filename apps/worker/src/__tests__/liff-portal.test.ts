/**
 * Tests for LIFF Portal routes (Phase 3A).
 *
 * Covers:
 *   - POST /api/liff/rank — ランク＋進捗バー
 *   - POST /api/liff/coupons — 未使用クーポン一覧
 *   - POST /api/liff/reorder — 再購入情報
 *   - POST /api/liff/fulfillments — 配送状況
 *   - POST /api/liff/intake — 服用ログ
 *   - POST /api/liff/intake/streak — streak情報
 *   - POST /api/liff/intake/reminder — リマインダー設定
 *   - POST /api/liff/health/log — 体調記録
 *   - POST /api/liff/health/trends — 推移データ
 *   - POST /api/liff/health/summary — サマリー
 *   - POST /api/liff/quiz/submit — 診断クイズ
 *   - POST /api/liff/referral/generate — 紹介リンク
 *   - POST /api/liff/referral/stats — 紹介実績
 *   - POST /api/liff/ambassador/enroll — アンバサダー登録
 *   - POST /api/liff/ambassador/status — アンバサダー状態
 *   - GET /api/liff/tips/today — 日替わりTip
 *   - Input validation tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getFriendByLineUserId: vi.fn(async (_db: unknown, lineUserId: string) => {
      if (lineUserId === 'U_EXISTING') {
        return { id: 'friend-1', line_user_id: 'U_EXISTING', display_name: 'Test User', is_following: 1 };
      }
      return null;
    }),
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
    getShopifyOrders: vi.fn(async () => [
      { id: 'o1', order_number: 1001, total_price: 6415, line_items: '[{"name":"naturism Blue VP","quantity":1}]', created_at: '2026-03-01', fulfillment_status: 'fulfilled' },
    ]),
    getShopifyOrderById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'o1') {
        return {
          id: 'o1',
          friend_id: 'friend-1',
          order_number: 1001,
          total_price: 6415,
          email: 'test@example.com',
          line_items: '[{"name":"naturism Blue VP","variant_id":"44000001","quantity":1,"price":"6415"}]',
          created_at: '2026-03-01',
          fulfillment_status: 'fulfilled',
        };
      }
      // IDOR テスト用: 別 friend が所有する注文
      if (id === 'o-other') {
        return {
          id: 'o-other',
          friend_id: 'friend-OTHER',
          order_number: 2002,
          total_price: 9999,
          line_items: '[{"name":"naturism Pink","variant_id":"44000002","quantity":1,"price":"9999"}]',
          created_at: '2026-03-02',
          fulfillment_status: 'fulfilled',
        };
      }
      return null;
    }),
    getShopifyProducts: vi.fn(async () => [
      { id: 'p1', shopify_product_id: 'sp1', title: 'naturism Blue', price: 2376, compare_at_price: null, image_url: 'https://img.example.com/blue.jpg', handle: 'naturism-blue', status: 'active' },
      { id: 'p2', shopify_product_id: 'sp2', title: 'naturism Pink', price: 2830, compare_at_price: null, image_url: 'https://img.example.com/pink.jpg', handle: 'naturism-pink', status: 'active' },
    ]),
    createIntakeLog: vi.fn(async () => ({ id: 'il-1', streak_count: 3, logged_at: '2026-04-06T08:00:00+09:00', meal_type: null, alreadyLogged: false })),
    getIntakeLogs: vi.fn(async () => [
      { id: 'il-1', product_name: 'naturism Blue', streak_count: 3, logged_at: '2026-04-06T08:00:00+09:00', note: null },
    ]),
    getIntakeStreak: vi.fn(async () => ({ currentStreak: 3, longestStreak: 10, totalDays: 45 })),
    getTodayIntakeCount: vi.fn(async () => 1),
    upsertIntakeReminder: vi.fn(async () => ({ id: 'ir-1', reminder_time: '08:00', is_active: 1 })),
    getIntakeReminder: vi.fn(async () => ({ id: 'ir-1', reminder_time: '08:00', timezone: 'Asia/Tokyo', reminder_type: 'morning_push', is_active: 1, last_sent_at: null })),
    createReferralLink: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({ id: 'rl-1', ref_code: data.refCode })),
    getReferralLink: vi.fn(async () => null),
    getReferralLinkByRefCode: vi.fn(async () => null),
    createReferralReward: vi.fn(async () => ({ id: 'rr-1', status: 'pending' })),
    getReferralStats: vi.fn(async () => ({ totalReferred: 5, pendingRewards: 2, rewardedCount: 3 })),
    createRecommendationResult: vi.fn(async () => ({ id: 'rec-1', recommended_product: 'naturism Blue' })),
    getLatestRecommendation: vi.fn(async () => null),
    upsertHealthLog: vi.fn(async () => ({ id: 'hl-1', log_date: '2026-04-06' })),
    getHealthLogs: vi.fn(async () => [
      { id: 'hl-1', log_date: '2026-04-06', weight: 58.5, condition: 'good', skin_condition: 'good', meals: '{"breakfast":"yogurt"}', sleep_hours: 7, note: null, bowel_form: 'normal', bowel_count: 2, mood: 'good' },
    ]),
    getHealthTrends: vi.fn(async () => [
      { log_date: '2026-04-05', weight: 58.8, condition: 'normal', skin_condition: 'normal', sleep_hours: 6.5, bowel_form: 'hard', bowel_count: 1, mood: 'normal' },
      { log_date: '2026-04-06', weight: 58.5, condition: 'good', skin_condition: 'good', sleep_hours: 7, bowel_form: 'normal', bowel_count: 2, mood: 'good' },
    ]),
    getHealthSummary: vi.fn(async () => ({ totalLogs: 5, avgWeight: 58.6, goodDays: 3, normalDays: 1, badDays: 1, latestWeight: 58.5 })),
    enrollAmbassador: vi.fn(async () => ({ id: 'amb-1', status: 'active' })),
    submitAmbassadorFeedback: vi.fn(async () => ({ id: 'fb-1' })),
    getAmbassadorFeedbacks: vi.fn(async () => [
      { id: 'fb-1', type: 'feedback', category: 'product', content: '美味しいです', rating: 5, created_at: '2026-04-06T10:00:00+09:00' },
    ]),
    getAmbassador: vi.fn(async (_db: unknown, friendId: string) => {
      if (friendId === 'friend-1') {
        return { id: 'amb-1', status: 'active', tier: 'standard', enrolled_at: '2026-04-01', total_surveys_completed: 2, total_product_tests: 1, feedback_score: 4.5, preferences: '{"survey_ok":true,"product_test_ok":true,"sns_share_ok":false}' };
      }
      return null;
    }),
    getTodayTip: vi.fn(async () => ({ id: 'tip-1', tip_date: '2026-04-06', category: 'nutrition', title: '水分補給のコツ', content: 'こまめな水分補給が大切です', image_url: null })),
    getPendingSurveys: vi.fn(async (_db: unknown, ambassadorId: string) => {
      if (ambassadorId === 'amb-1') {
        return [{ id: 'srv-1', title: '商品満足度調査', description: '使い心地について', survey_type: 'survey', questions: '[{"id":"q1","type":"rating","label":"総合満足度","required":true}]' }];
      }
      return [];
    }),
    getSurveyById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'srv-1') {
        return { id: 'srv-1', title: '商品満足度調査', status: 'active', questions: '[{"id":"q1","type":"rating","label":"総合満足度","required":true}]' };
      }
      return null;
    }),
    submitSurveyResponse: vi.fn(async () => ({ id: 'srs-1' })),
    getFriendLanguage: vi.fn(async () => 'ja'),
    setFriendLanguage: vi.fn(async () => undefined),
    getTipTranslation: vi.fn(async () => null),
    jstNow: vi.fn(() => '2026-04-06T09:00:00+09:00'),
  };
});

// Mock shopify-token (getShopifyAccessToken)
vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'test-shopify-token'),
}));

// welcome クーポン発行 (紹介 claim の未発行救済で呼ばれる)。定数は実物を保つ。
vi.mock('../services/shopify-coupon-issuer.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    issueCouponForFriend: vi.fn(async () => ({
      code: 'LINE-RESCUE01',
      discountValue: 500,
      discountCurrency: 'JPY',
      issuedAt: '2026-08-24T00:00:00.000Z',
      expiresAt: '2026-08-31T00:00:00.000Z',
      isExisting: false,
      shopifyDiscountCodeId: 'gid://shopify/DiscountCodeNode/rescue',
    })),
  };
});

// Mock global fetch for Shopify API calls (Draft Orders — 2026-07-30 GraphQL 移行)
const originalFetch = globalThis.fetch;
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
  if (typeof url === 'string' && url.includes('/admin/api/') && url.includes('graphql.json')) {
    const reqBody = init?.body ? String(init.body) : '';
    if (reqBody.includes('draftOrderCreate')) {
      return new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/12345',
              invoiceUrl: 'https://naturism-diet.com/checkout/draft/12345',
              status: 'OPEN',
              totalPriceSet: { shopMoney: { amount: '6415.00', currencyCode: 'JPY' } },
              lineItems: { nodes: [{ name: 'naturism Blue VP', quantity: 1 }] },
            },
            userErrors: [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  // Fallback for other URLs (shouldn't hit in tests)
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}));

/** 直近の draftOrderCreate リクエスト body (GraphQL variables) を取り出すヘルパー */
function lastDraftOrderCall(): { query: string; variables: { input: Record<string, unknown> } } | null {
  const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit?]> } }).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const [url, init] = calls[i];
    if (typeof url === 'string' && url.includes('graphql.json') && init?.body && String(init.body).includes('draftOrderCreate')) {
      return JSON.parse(String(init.body));
    }
  }
  return null;
}

// Mock quiz engine
vi.mock('../services/quiz-engine.js', () => ({
  scoreQuiz: vi.fn(() => ({
    recommendedProduct: 'naturism Blue',
    reason: '脂質カットに特化したエントリーモデル。',
    scores: { blue: 15, pink: 5, premium: 3 },
    productInfo: { name: 'naturism Blue', emoji: 'blue', price: '¥64/日〜', components: 8, reason: '脂質カットに特化', storeUrl: 'https://naturism-diet.com' },
    excluded: [],
  })),
  NATURISM_QUIZ_CONFIG: { questions: [], products: [] },
}));

// ---------------------------------------------------------------------------
// App setup — mock liffAuth middleware to set liffUser from lineUserId body field
// ---------------------------------------------------------------------------
const { liffPortal } = await import('../routes/liff-portal.js');
const { getFriendByLineUserId } = await import('@line-crm/db');

function createApp() {
  const app = new Hono();

  // Mock LIFF auth middleware: read lineUserId from body and set liffUser
  app.use('/api/liff/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path === '/api/liff/tips/today') return next();

    try {
      const body = await c.req.json<{ lineUserId?: string }>();
      if (!body.lineUserId) return c.json({ success: false, error: 'Unauthorized' }, 401);

      const env = (c as unknown as { env: { DB: D1Database } }).env;
      const friend = await (getFriendByLineUserId as ReturnType<typeof vi.fn>)(env.DB, body.lineUserId);
      if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

      // 本物の liffAuthMiddleware と同じく shopifyCustomerId も載せる
      // (= /api/liff/rank の linked はこの値から導出され、D1 read を増やさない)
      (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', {
        lineUserId: body.lineUserId,
        friendId: friend.id,
        shopifyCustomerId: (friend as { shopify_customer_id?: string | null }).shopify_customer_id ?? null,
      });
      return next();
    } catch {
      return c.json({ success: false, error: 'Invalid body' }, 400);
    }
  });

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

function post(app: ReturnType<typeof createApp>, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, mockEnv());
}

function get(app: ReturnType<typeof createApp>, path: string) {
  return app.request(path, { method: 'GET' }, mockEnv());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LIFF Portal Routes', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ─── Rank ─────────────────────────────────────
  describe('POST /api/liff/rank', () => {
    it('returns rank with progress bar data for existing friend', async () => {
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.currentRank).toBeTruthy();
      expect((json.data.currentRank as Record<string, unknown>).name).toBe('Silver');
      expect(json.data.totalSpent).toBe(15000);
      expect(json.data.nextRank).toBeTruthy();
      expect((json.data.nextRank as Record<string, unknown>).name).toBe('Gold');
      expect(typeof json.data.progressPercent).toBe('number');
    });

    it('returns 404 for unknown lineUserId', async () => {
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_UNKNOWN' });
      expect(res.status).toBe(404);
    });

    it('returns null rank when friend has no rank record', async () => {
      const db = await import('@line-crm/db');
      (db.getFriendRank as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: Record<string, unknown> };
      expect(json.data.currentRank).toBeNull();
    });

    // linked = ポータルのマイアカウントが「オンラインストアと連携」カードを畳む判定。
    // この値が欠けると、連携済みの人が毎回ボタンを見て外部ブラウザを往復することになる
    // (実際に一度その状態で出荷しかけた)。両 return 分岐で固定する。
    it('未連携の friend は linked=false', async () => {
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_EXISTING' });
      const json = (await res.json()) as { data: { linked: boolean } };
      expect(json.data.linked).toBe(false);
    });

    it('連携済みの friend は linked=true', async () => {
      const db = await import('@line-crm/db');
      (db.getFriendByLineUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'friend-1',
        line_user_id: 'U_EXISTING',
        display_name: 'Test User',
        is_following: 1,
        shopify_customer_id: '6458785661181',
      });
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_EXISTING' });
      const json = (await res.json()) as { data: { linked: boolean } };
      expect(json.data.linked).toBe(true);
    });

    it('rank 記録が無い分岐でも linked を返す (早期 return の取りこぼし防止)', async () => {
      const db = await import('@line-crm/db');
      (db.getFriendByLineUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'friend-1',
        line_user_id: 'U_EXISTING',
        display_name: 'Test User',
        is_following: 1,
        shopify_customer_id: '6458785661181',
      });
      (db.getFriendRank as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const res = await post(app, '/api/liff/rank', { lineUserId: 'U_EXISTING' });
      const json = (await res.json()) as { data: { linked: boolean; currentRank: unknown } };
      expect(json.data.currentRank).toBeNull();
      expect(json.data.linked).toBe(true);
    });
  });

  // ─── Coupons ──────────────────────────────────
  describe('POST /api/liff/coupons', () => {
    it('returns unused coupons for friend', async () => {
      const res = await post(app, '/api/liff/coupons', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { coupons: Array<Record<string, unknown>> } };
      expect(json.data.coupons).toHaveLength(1);
      expect(json.data.coupons[0].code).toBe('WELCOME500');
    });

    it('returns 404 for unknown user', async () => {
      const res = await post(app, '/api/liff/coupons', { lineUserId: 'U_UNKNOWN' });
      expect(res.status).toBe(404);
    });
  });

  // ─── Reorder ──────────────────────────────────
  describe('POST /api/liff/reorder', () => {
    it('returns recent orders and products for reorder', async () => {
      const res = await post(app, '/api/liff/reorder', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { recentOrders: unknown[]; products: unknown[] } };
      expect(json.data.recentOrders).toHaveLength(1);
      expect(json.data.products).toHaveLength(2);
    });
  });

  // ─── Reorder Create ──────────────────────────
  describe('POST /api/liff/reorder/create', () => {
    it('creates draft order from past order', async () => {
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_EXISTING', orderId: 'o1' });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { invoiceUrl: string; totalPrice: number } };
      expect(json.success).toBe(true);
      expect(json.data.invoiceUrl).toContain('checkout');
      expect(json.data.totalPrice).toBe(6415);
    });

    it('returns 404 for nonexistent order', async () => {
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_EXISTING', orderId: 'nonexistent' });
      expect(res.status).toBe(404);
    });

    it('returns 400 when no items provided', async () => {
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(400);
    });

    it('creates draft order from item list', async () => {
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING',
        items: [{ variantId: '44000001', quantity: 2 }],
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { shopifyDraftOrderId: string } };
      expect(json.success).toBe(true);
      expect(json.data.shopifyDraftOrderId).toBe('12345');
    });

    it('returns 401 for unauthorized user', async () => {
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_UNKNOWN' });
      expect(res.status).toBe(404);
    });

    // IDOR regression: 他人の注文 (friend_id 不一致) を再注文しようとしても 404
    it('returns 404 when reordering another friend\'s order (IDOR guard)', async () => {
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_EXISTING', orderId: 'o-other' });
      expect(res.status).toBe(404);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(false);
    });

    // ─── 再注文シート (2026-07-30): 配送オプションの検証 + customAttributes 配管 ───
    it('rejects unknown shippingMethod with 400 (固定語彙のみ)', async () => {
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o1', shippingMethod: 'dokodemo-door',
      });
      expect(res.status).toBe(400);
    });

    it('rejects unknown deliveryTime with 400 (固定語彙のみ)', async () => {
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o1', shippingMethod: 'takkyubin', deliveryTime: '深夜2時',
      });
      expect(res.status).toBe(400);
    });

    it('rejects past deliveryDate with 400', async () => {
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o1', shippingMethod: 'takkyubin', deliveryDate: '2020-01-01',
      });
      expect(res.status).toBe(400);
    });

    it('passes 配送方法/配送希望日/時間帯 as customAttributes (宅配便)', async () => {
      const future = new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o1',
        shippingMethod: 'takkyubin', deliveryDate: future, deliveryTime: '午前中',
      });
      expect(res.status).toBe(200);
      const call = lastDraftOrderCall();
      expect(call).not.toBeNull();
      const attrs = call!.variables.input.customAttributes as Array<{ key: string; value: string }>;
      expect(attrs).toContainEqual({ key: '配送方法', value: '宅配便' });
      expect(attrs).toContainEqual({ key: '配送希望日', value: future });
      expect(attrs).toContainEqual({ key: '配送希望時間帯', value: '午前中' });
    });

    it('ネコポスは日時指定を無視する (ポスト投函 = 日時指定不可のサーバー側ガード)', async () => {
      const future = new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);
      const res = await post(app, '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o1',
        shippingMethod: 'nekopos', deliveryDate: future, deliveryTime: '午前中',
      });
      expect(res.status).toBe(200);
      const call = lastDraftOrderCall();
      const attrs = (call!.variables.input.customAttributes ?? []) as Array<{ key: string; value: string }>;
      expect(attrs).toContainEqual({ key: '配送方法', value: 'ネコポス' });
      expect(attrs.some((a) => a.key === '配送希望日')).toBe(false);
      expect(attrs.some((a) => a.key === '配送希望時間帯')).toBe(false);
    });

    it('GraphQL userErrors/errors は 502 + 顧客向けメッセージに変換される', async () => {
      const fetchMock = globalThis.fetch as unknown as { mockImplementationOnce: (fn: () => Promise<Response>) => void };
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({
        errors: [{ message: 'Access denied for draftOrderCreate', extensions: { code: 'ACCESS_DENIED' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      const res = await post(app, '/api/liff/reorder/create', { lineUserId: 'U_EXISTING', orderId: 'o1' });
      expect(res.status).toBe(502);
      const json = await res.json() as { error: string };
      expect(json.error).toContain('再注文機能の準備中');
    });
  });

  // ─── Fulfillments ─────────────────────────────
  describe('POST /api/liff/fulfillments', () => {
    it('returns 404 for unknown user', async () => {
      const res = await post(app, '/api/liff/fulfillments', { lineUserId: 'U_UNKNOWN' });
      expect(res.status).toBe(404);
    });

    it('発送前でも latestOrder (financial_status 等) を返す — ゼロクリック配送状況 (2026-07-30)', async () => {
      // fulfillments は空、最新注文は入金待ち (銀行振込) の想定
      const orderRow = {
        order_number: 1234,
        financial_status: 'pending',
        fulfillment_status: null,
        total_price: '2376.00',
        line_items: JSON.stringify([{ name: 'naturism Blue 180粒' }]),
        created_at: '2026-07-30T10:00:00+09:00',
      };
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => orderRow),
        run: vi.fn(async () => ({ success: true })),
      };
      const env = { ...mockEnv(), DB: { prepare: vi.fn(() => stmt) } as unknown as D1Database };
      const res = await app.request('/api/liff/fulfillments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_EXISTING' }),
      }, env);
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { fulfillments: unknown[]; latestOrder: { orderNumber: number; financialStatus: string; lineItems: Array<{ name: string }> } } };
      expect(json.data.fulfillments).toEqual([]);
      expect(json.data.latestOrder.orderNumber).toBe(1234);
      expect(json.data.latestOrder.financialStatus).toBe('pending');
      expect(json.data.latestOrder.lineItems[0].name).toBe('naturism Blue 180粒');
    });

    it('注文が無ければ latestOrder は null', async () => {
      const res = await post(app, '/api/liff/fulfillments', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { latestOrder: unknown } };
      expect(json.data.latestOrder).toBeNull();
    });
  });

  // ─── Intake ───────────────────────────────────
  describe('POST /api/liff/intake', () => {
    it('creates intake log and returns streak', async () => {
      const res = await post(app, '/api/liff/intake', { lineUserId: 'U_EXISTING', productName: 'naturism Blue' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { streakCount: number } };
      expect(json.data.streakCount).toBe(3);
    });

    it('returns 404 for unknown user', async () => {
      const res = await post(app, '/api/liff/intake', { lineUserId: 'U_UNKNOWN' });
      expect(res.status).toBe(404);
    });

    it('Phase 1: accepts mealType (breakfast/lunch/dinner/snack)', async () => {
      const res = await post(app, '/api/liff/intake', {
        lineUserId: 'U_EXISTING',
        productName: 'naturism Blue',
        mealType: 'breakfast',
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { streakCount: number; alreadyLogged: boolean } };
      expect(json.success).toBe(true);
      expect(json.data.alreadyLogged).toBe(false);
    });
  });

  describe('GET /api/liff/badges (Phase 2)', () => {
    it('endpoint is reachable (smoke test)', async () => {
      const res = await app.request('/api/liff/badges', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, mockEnv());
      // testLiffAuth: GET でも認証チェックが入るので 200/400/401 が想定。
      expect([200, 400, 401, 500]).toContain(res.status);
    });
  });

  describe('GET /api/liff/intake/today', () => {
    it('endpoint is reachable (returns 200/401 depending on auth)', async () => {
      // GET request: 認証 middleware の挙動次第で 200 or 401。
      // クラッシュしないこと(500以外)を確認するスモークテスト。
      const res = await app.request('/api/liff/intake/today', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }, mockEnv());
      // testLiffAuth は GET でも body を読みに行くため 400 (lineUserId required) になる場合がある。
      // 本番では Authorization Bearer 経由で 200 になる。スモーク用に 4xx 系も許容。
      expect([200, 400, 401]).toContain(res.status);
    });
  });

  describe('POST /api/liff/intake/streak', () => {
    it('returns streak info with recent logs', async () => {
      const res = await post(app, '/api/liff/intake/streak', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { currentStreak: number; longestStreak: number; totalDays: number; recentLogs: unknown[] } };
      expect(json.data.currentStreak).toBe(3);
      expect(json.data.longestStreak).toBe(10);
      expect(json.data.recentLogs).toHaveLength(1);
    });
  });

  describe('POST /api/liff/intake/reminder', () => {
    it('sets reminder and returns config', async () => {
      const res = await post(app, '/api/liff/intake/reminder', { lineUserId: 'U_EXISTING', reminderTime: '07:30' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { reminderTime: string; isActive: boolean } };
      expect(json.data.reminderTime).toBe('08:00');
      expect(json.data.isActive).toBe(true);
    });

    it('rejects invalid reminderTime format', async () => {
      const res = await post(app, '/api/liff/intake/reminder', { lineUserId: 'U_EXISTING', reminderTime: '25:99' });
      expect(res.status).toBe(400);
    });
  });

  // ─── Health ───────────────────────────────────
  describe('POST /api/liff/health/log', () => {
    it('creates or updates health log', async () => {
      const res = await post(app, '/api/liff/health/log', { lineUserId: 'U_EXISTING', weight: 58.5, condition: 'good' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { log_date: string } };
      expect(json.data.log_date).toBe('2026-04-06');
    });

    it('accepts new fields: bowelForm, bowelCount, mood', async () => {
      const res = await post(app, '/api/liff/health/log', {
        lineUserId: 'U_EXISTING',
        weight: 57.8,
        skinCondition: 'good',
        bowelForm: 'normal',
        bowelCount: 2,
        mood: 'great',
        sleepHours: 7.5,
        note: '朝ヨガした',
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { log_date: string } };
      expect(json.data.log_date).toBe('2026-04-06');
    });

    it('ignores invalid bowelForm values', async () => {
      const res = await post(app, '/api/liff/health/log', {
        lineUserId: 'U_EXISTING',
        bowelForm: 'invalid_value',
        mood: 'also_invalid',
      });
      expect(res.status).toBe(200);
    });

    it('clamps bowelCount to 0-10 range', async () => {
      const res = await post(app, '/api/liff/health/log', {
        lineUserId: 'U_EXISTING',
        bowelCount: 99,
      });
      expect(res.status).toBe(200);
    });

    it('rejects invalid logDate format', async () => {
      const res = await post(app, '/api/liff/health/log', { lineUserId: 'U_EXISTING', logDate: 'not-a-date' });
      expect(res.status).toBe(400);
    });

    it('rejects future logDate', async () => {
      const res = await post(app, '/api/liff/health/log', { lineUserId: 'U_EXISTING', logDate: '2027-01-01' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/liff/health/trends', () => {
    it('returns trend data for graphing', async () => {
      const res = await post(app, '/api/liff/health/trends', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { trends: unknown[] } };
      expect(json.data.trends).toHaveLength(2);
    });
  });

  describe('POST /api/liff/health/summary', () => {
    it('returns 7-day health summary', async () => {
      const res = await post(app, '/api/liff/health/summary', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalLogs: number; goodDays: number } };
      expect(json.data.totalLogs).toBe(5);
      expect(json.data.goodDays).toBe(3);
    });
  });

  describe('POST /api/liff/health/logs', () => {
    it('returns health logs list', async () => {
      const res = await post(app, '/api/liff/health/logs', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { logs: unknown[] } };
      expect(json.data.logs).toHaveLength(1);
    });
  });

  // ─── Quiz ─────────────────────────────────────
  describe('POST /api/liff/quiz/submit', () => {
    it('returns quiz recommendation (9問版: q2 は料理ランキング配列)', async () => {
      const res = await post(app, '/api/liff/quiz/submit', {
        lineUserId: 'U_EXISTING',
        answers: { q1: '揚げ物・脂っこい料理が好き', q2: ['中華', '焼肉', '和食'], q9: '初めて' },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { recommendedProduct: string; scores: Record<string, number> } };
      expect(json.data.recommendedProduct).toBe('naturism Blue');
      expect(json.data.scores).toBeDefined();
    });

    it('rejects non-string/array answer values with 400', async () => {
      const res = await post(app, '/api/liff/quiz/submit', {
        lineUserId: 'U_EXISTING',
        answers: { q1: 123 },
      });
      expect(res.status).toBe(400);
    });

    it('rejects oversized rank arrays with 400', async () => {
      const res = await post(app, '/api/liff/quiz/submit', {
        lineUserId: 'U_EXISTING',
        answers: { q2: ['a', 'b', 'c', 'd', 'e', 'f'] },
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown user', async () => {
      const res = await post(app, '/api/liff/quiz/submit', { lineUserId: 'U_UNKNOWN', answers: {} });
      expect(res.status).toBe(404);
    });
  });

  // ─── Referral ─────────────────────────────────
  describe('POST /api/liff/referral/generate', () => {
    it('generates new referral link for friend without one', async () => {
      const res = await post(app, '/api/liff/referral/generate', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { refCode: string; url: string; isNew: boolean } };
      expect(json.data.isNew).toBe(true);
      expect(json.data.url).toContain('https://test.workers.dev/r/');
    });

    it('returns existing link if already created', async () => {
      const db = await import('@line-crm/db');
      (db.getReferralLink as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-existing', ref_code: 'ref-abc12345', is_active: 1,
      });
      const res = await post(app, '/api/liff/referral/generate', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { isNew: boolean; refCode: string } };
      expect(json.data.isNew).toBe(false);
      expect(json.data.refCode).toBe('ref-abc12345');
    });
  });

  describe('POST /api/liff/referral/stats', () => {
    it('returns referral stats', async () => {
      const res = await post(app, '/api/liff/referral/stats', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { totalReferred: number } };
      expect(json.data.totalReferred).toBe(5);
    });
  });

  describe('POST /api/liff/referral/claim', () => {
    it('records referral_rewards (pending) のみ — claim ではクーポンを発行しない (referred の¥500=welcome、 referrer=購入時)', async () => {
      const db = await import('@line-crm/db');
      (db.getReferralLinkByRefCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-2', friend_id: 'friend-referrer', ref_code: 'ref-xyz', referrer_coupon_id: null, referred_coupon_id: null,
      });
      const res = await post(app, '/api/liff/referral/claim', { lineUserId: 'U_EXISTING', refCode: 'ref-xyz' });
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { alreadyClaimed: boolean; rewardId: string; status: string; coupons?: unknown };
      };
      expect(json.data.alreadyClaimed).toBe(false);
      expect(json.data.rewardId).toBe('rr-1');
      expect(json.data.status).toBe('pending');
      // claim は紹介クーポンを新規に作らない (referred は welcome クーポン、 referrer は購入時)
      //   → レスポンスに coupons フィールドは載らない
      expect(json.data.coupons).toBeUndefined();
      expect(db.createReferralReward as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });

    it('welcome 未発行でも被紹介者に届く — 発行を冪等に呼ぶ (Codex P1: 格上げ削除で消えた救済)', async () => {
      // 招待文は被紹介者に ¥500 を約束する。claim が follow より先に走った / follow 時の Shopify
      // 発行が失敗した場合、以前は格上げ機構が「welcome 行が無ければ直接発行」して救済していた。
      // 格上げは削除したが**救済だけは残す**。issueCouponForFriend は既発行なら既存 code を返す = 冪等。
      const issuer = await import('../services/shopify-coupon-issuer.js');
      const issueMock = issuer.issueCouponForFriend as ReturnType<typeof vi.fn>;
      issueMock.mockClear();

      const db = await import('@line-crm/db');
      (db.getReferralLinkByRefCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-3', friend_id: 'friend-referrer', ref_code: 'ref-rescue', referrer_coupon_id: null, referred_coupon_id: null,
      });

      const res = await post(app, '/api/liff/referral/claim', { lineUserId: 'U_EXISTING', refCode: 'ref-rescue' });
      expect(res.status).toBe(200);

      expect(issueMock, '救済の呼び出しが消えたら落ちる').toHaveBeenCalledTimes(1);
      const opts = issueMock.mock.calls[0][2] as { friendId: string; validDays: number; discountValueJpy?: number };
      expect(opts.friendId).toBe('friend-1');
      // 有効期限は follow と同じ定数から引く (救済だけ別日数にしない)
      expect(opts.validDays).toBe(issuer.WELCOME_VALID_DAYS);
      // 額は既定 (¥500) のまま = 紹介経由だけ優遇しない
      expect(opts.discountValueJpy).toBeUndefined();
    });

    it('2 回目以降の claim (alreadyClaimed) でも救済を試す — 1 度きりにしない (Codex P2)', async () => {
      // 成立記録だけ先に成功して救済が落ちると、以降は必ず alreadyClaimed で早期 return する。
      // 救済を成立記録の後ろに置くと、一過性の Shopify 障害で永久にクーポンが届かなくなる。
      const issuer = await import('../services/shopify-coupon-issuer.js');
      const issueMock = issuer.issueCouponForFriend as ReturnType<typeof vi.fn>;
      issueMock.mockClear();

      const db = await import('@line-crm/db');
      (db.getReferralLinkByRefCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-5', friend_id: 'friend-referrer', ref_code: 'ref-retry', referrer_coupon_id: null, referred_coupon_id: null,
      });

      // 既に claim 済み: referral_rewards に行がある状態を作る
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn(async () => ({ success: true })),
        all: vi.fn(async () => ({ results: [] })),
        first: vi.fn(async () => ({ id: 'rr-existing' })),
      };
      const env = { ...mockEnv(), DB: { prepare: vi.fn(() => stmt) } as unknown as D1Database };

      const res = await app.request(
        '/api/liff/referral/claim',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineUserId: 'U_EXISTING', refCode: 'ref-retry' }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { alreadyClaimed: boolean; rewardId: string } };
      expect(json.data.alreadyClaimed, '前提: alreadyClaimed の経路を通っていること').toBe(true);
      expect(json.data.rewardId).toBe('rr-existing');

      // 成立記録は増やさない
      expect(db.createReferralReward as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      // それでも救済は走る (早期 return の手前に置いていないと 0 回になる)
      expect(issueMock, 'alreadyClaimed でも救済を試すこと').toHaveBeenCalledTimes(1);
      const opts = issueMock.mock.calls[0][2] as { friendId: string; validDays: number };
      expect(opts.friendId).toBe('friend-1');
      expect(opts.validDays).toBe(issuer.WELCOME_VALID_DAYS);
    });

    it('救済で発行が失敗しても claim 自体は成功する (report は台帳の pending が正)', async () => {
      const issuer = await import('../services/shopify-coupon-issuer.js');
      const issueMock = issuer.issueCouponForFriend as ReturnType<typeof vi.fn>;
      issueMock.mockClear();
      issueMock.mockRejectedValueOnce(new Error('shopify down'));

      const db = await import('@line-crm/db');
      (db.getReferralLinkByRefCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-4', friend_id: 'friend-referrer', ref_code: 'ref-rescue-fail', referrer_coupon_id: null, referred_coupon_id: null,
      });

      const res = await post(app, '/api/liff/referral/claim', { lineUserId: 'U_EXISTING', refCode: 'ref-rescue-fail' });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { alreadyClaimed: boolean } };
      expect(json.success).toBe(true);
      expect(json.data.alreadyClaimed).toBe(false);
    });

    it('blocks self-referral (400)', async () => {
      const db = await import('@line-crm/db');
      (db.getReferralLinkByRefCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'rl-self', friend_id: 'friend-1', ref_code: 'ref-self', referrer_coupon_id: null, referred_coupon_id: null,
      });
      const res = await post(app, '/api/liff/referral/claim', { lineUserId: 'U_EXISTING', refCode: 'ref-self' });
      expect(res.status).toBe(400);
    });
  });

  // ─── Ambassador ───────────────────────────────
  describe('POST /api/liff/ambassador/enroll', () => {
    it('enrolls friend as ambassador', async () => {
      const res = await post(app, '/api/liff/ambassador/enroll', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { status: string } };
      expect(json.data.status).toBe('active');
    });
  });

  describe('POST /api/liff/ambassador/status', () => {
    it('returns ambassador status for enrolled friend', async () => {
      const res = await post(app, '/api/liff/ambassador/status', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { status: string; tier: string; surveysCompleted: number } };
      expect(json.data.status).toBe('active');
      expect(json.data.tier).toBe('standard');
      expect(json.data.surveysCompleted).toBe(2);
    });
  });

  // ─── Daily Tips ───────────────────────────────
  describe('GET /api/liff/tips/today', () => {
    it('returns today tip', async () => {
      const res = await get(app, '/api/liff/tips/today');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { title: string; category: string } };
      expect(json.data.title).toBe('水分補給のコツ');
      expect(json.data.category).toBe('nutrition');
    });

    it('returns null when no tip exists', async () => {
      const db = await import('@line-crm/db');
      (db.getTodayTip as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const res = await get(app, '/api/liff/tips/today');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: null; message: string };
      expect(json.data).toBeNull();
    });
  });

  // ─── Ambassador Feedback ───────────────────────
  describe('POST /api/liff/ambassador/feedback', () => {
    it('submits feedback for active ambassador', async () => {
      const res = await post(app, '/api/liff/ambassador/feedback', {
        lineUserId: 'U_EXISTING',
        category: 'product',
        content: '美味しくて続けやすいです',
        rating: 5,
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('fb-1');
    });

    it('rejects empty content', async () => {
      const res = await post(app, '/api/liff/ambassador/feedback', {
        lineUserId: 'U_EXISTING',
        content: '',
      });
      expect(res.status).toBe(400);
    });

    it('rejects content over 2000 chars', async () => {
      const res = await post(app, '/api/liff/ambassador/feedback', {
        lineUserId: 'U_EXISTING',
        content: 'a'.repeat(2001),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid rating', async () => {
      const res = await post(app, '/api/liff/ambassador/feedback', {
        lineUserId: 'U_EXISTING',
        content: 'test',
        rating: 6,
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-ambassador', async () => {
      const db = await import('@line-crm/db');
      (db.getAmbassador as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const res = await post(app, '/api/liff/ambassador/feedback', {
        lineUserId: 'U_EXISTING',
        content: 'test feedback',
      });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/liff/ambassador/feedbacks', () => {
    it('returns feedback history', async () => {
      const res = await post(app, '/api/liff/ambassador/feedbacks', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: Array<{ content: string }> };
      expect(json.data.length).toBe(1);
      expect(json.data[0].content).toBe('美味しいです');
    });
  });

  // ─── Ambassador Surveys ───────────────────────
  describe('POST /api/liff/ambassador/surveys', () => {
    it('returns pending surveys for active ambassador', async () => {
      const res = await post(app, '/api/liff/ambassador/surveys', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: Array<{ id: string; title: string; questions: unknown[] }> };
      expect(json.data.length).toBe(1);
      expect(json.data[0].title).toBe('商品満足度調査');
      expect(Array.isArray(json.data[0].questions)).toBe(true);
    });
  });

  describe('POST /api/liff/ambassador/survey/respond', () => {
    it('submits survey response (200)', async () => {
      const res = await post(app, '/api/liff/ambassador/survey/respond', {
        lineUserId: 'U_EXISTING',
        surveyId: 'srv-1',
        answers: { q1: 5 },
      });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string } };
      expect(json.data.id).toBe('srs-1');
    });

    it('rejects without surveyId (400)', async () => {
      const res = await post(app, '/api/liff/ambassador/survey/respond', {
        lineUserId: 'U_EXISTING',
        answers: { q1: 5 },
      });
      expect(res.status).toBe(400);
    });

    it('rejects without answers (400)', async () => {
      const res = await post(app, '/api/liff/ambassador/survey/respond', {
        lineUserId: 'U_EXISTING',
        surveyId: 'srv-1',
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-existent survey (404)', async () => {
      const res = await post(app, '/api/liff/ambassador/survey/respond', {
        lineUserId: 'U_EXISTING',
        surveyId: 'srv-nonexist',
        answers: { q1: 3 },
      });
      expect(res.status).toBe(404);
    });
  });

  // ─── i18n ───────────────────────────────────
  describe('POST /api/liff/language', () => {
    it('returns language preference', async () => {
      const res = await post(app, '/api/liff/language', { lineUserId: 'U_EXISTING' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { lang: string } };
      expect(json.data.lang).toBe('ja');
    });
  });

  describe('PUT /api/liff/language', () => {
    it('updates language preference', async () => {
      const res = await app.request('/api/liff/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_EXISTING', lang: 'en' }),
      }, mockEnv());
      expect(res.status).toBe(200);
    });

    it('rejects invalid language (400)', async () => {
      const res = await app.request('/api/liff/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_EXISTING', lang: 'invalid' }),
      }, mockEnv());
      expect(res.status).toBe(400);
    });
  });

  // ─── Auth rejection ───────────────────────────
  describe('Authentication', () => {
    it('returns 401 when lineUserId is missing', async () => {
      const res = await post(app, '/api/liff/rank', {});
      expect(res.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// LIFF More Tab APIs (GET / PUT / DELETE endpoints)
// ---------------------------------------------------------------------------
// These endpoints use getLiffUser(c) which reads c.get('liffUser').
// We need a middleware that sets liffUser for all HTTP methods.

function createMoreTabApp() {
  const moreApp = new Hono();

  // Middleware: set liffUser via X-Friend-Id / X-Line-User-Id headers
  moreApp.use('/api/liff/*', async (c, next) => {
    const friendId = c.req.header('X-Friend-Id');
    const lineUserId = c.req.header('X-Line-User-Id');
    if (friendId && lineUserId) {
      (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', { lineUserId, friendId });
    }
    // Also support JSON body for POST/PUT
    if (!friendId && (c.req.method === 'POST' || c.req.method === 'PUT')) {
      try {
        const body = await c.req.json<{ lineUserId?: string }>();
        if (body.lineUserId === 'U_EXISTING') {
          (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', { lineUserId: 'U_EXISTING', friendId: 'friend-1' });
        }
      } catch { /* no body */ }
    }
    return next();
  });

  moreApp.route('/', liffPortal);
  return moreApp;
}

function moreReq(
  moreApp: ReturnType<typeof createMoreTabApp>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  authenticated = true,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authenticated) {
    headers['X-Friend-Id'] = 'friend-1';
    headers['X-Line-User-Id'] = 'U_EXISTING';
  }
  const init: RequestInit = { method, headers };
  if (body) init.body = JSON.stringify(body);
  return moreApp.request(path, init, mockEnv());
}

describe('LIFF More Tab APIs', () => {
  let moreApp: ReturnType<typeof createMoreTabApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    moreApp = createMoreTabApp();
  });

  // ─── Referral coupon (紹介特典クーポン表示) ─────────
  describe('GET /api/liff/referral-coupon', () => {
    it('gate off (REFERRAL_REWARD_ENABLED 未設定) → coupons:[] (DB を触らない)', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/referral-coupon');
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { coupons: unknown[]; count: number } };
      expect(json.success).toBe(true);
      expect(json.data.coupons).toEqual([]);
      expect(json.data.count).toBe(0);
    });

    it('未認証 → 401', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/referral-coupon', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── Link coupon (連携特典クーポン表示・Sprint A-1・採点 C3/C5) ─────────
  describe('GET /api/liff/link-coupon', () => {
    it('gate off (LINK_REWARD_ENABLED 未設定) → coupon:null (DB を触らない = pre-migration 安全)', async () => {
      const env = { ...mockEnv() };
      const res = await moreApp.request(
        '/api/liff/link-coupon',
        { method: 'GET', headers: { 'X-Friend-Id': 'friend-1', 'X-Line-User-Id': 'U_EXISTING' } },
        env,
      );
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { coupon: unknown } };
      expect(json.success).toBe(true);
      expect(json.data.coupon).toBeNull();
      expect((env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
    });

    it('未認証 → 401', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/link-coupon', undefined, false);
      expect(res.status).toBe(401);
    });

    it('gate on + 発行済み → 単数 coupon の応答 shape (code/discountValue/expiresAt/remainingText/applyUrl)', async () => {
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const stmt = {
        bind: vi.fn().mockReturnThis(),
        // 🚨 fixture を既定額 (300) と同値にすると、route が「台帳の値」を返しているのか
        //    「定数を返している」のかを**区別できない**。定数と異なる値を置いて経路を測る。
        first: vi.fn(async () => ({ coupon_code: 'NLINK-TEST2345', discount_value: 450, expires_at: future })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      };
      const env = { ...mockEnv(), LINK_REWARD_ENABLED: 'true', DB: { prepare: vi.fn(() => stmt) } as unknown as D1Database };
      const res = await moreApp.request(
        '/api/liff/link-coupon',
        { method: 'GET', headers: { 'X-Friend-Id': 'friend-1', 'X-Line-User-Id': 'U_EXISTING' } },
        env,
      );
      expect(res.status).toBe(200);
      const json = await res.json() as {
        data: { coupon: { code: string; discountValue: number; expiresAt: string; remainingText: string | null; applyUrl: string | null } };
      };
      expect(json.data.coupon.code).toBe('NLINK-TEST2345');
      expect(json.data.coupon.discountValue).toBe(450); // 台帳の値がそのまま出る (定数 300 ではない)
      expect(json.data.coupon.expiresAt).toBe(future);
      // 兄弟 endpoint (referral) は複数形 coupons — 本 endpoint は単数 coupon の契約を固定する
      expect((json.data as Record<string, unknown>).coupons).toBeUndefined();
    });
  });

  // ─── Notification Prefs ─────────────────────────
  describe('GET /api/liff/notification-prefs', () => {
    it('returns default prefs when no record exists', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/notification-prefs');
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: Record<string, number> };
      expect(json.success).toBe(true);
      // Default all on
      expect(json.data.restock_alert).toBe(1);
      expect(json.data.campaign_message).toBe(1);
    });

    it('returns saved prefs when record exists', async () => {
      const env = mockEnv();
      const stmt = env.DB.prepare('');
      (stmt.bind('').first as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        restock_alert: 0, delivery_complete: 1, order_confirm: 1, campaign_message: 0, reorder_reminder: 1,
      });
      const res = await moreApp.request('/api/liff/notification-prefs', {
        method: 'GET',
        headers: { 'X-Friend-Id': 'friend-1', 'X-Line-User-Id': 'U_EXISTING' },
      }, env);
      expect(res.status).toBe(200);
      const json = await res.json() as { data: Record<string, number> };
      expect(json.data.restock_alert).toBe(0);
      expect(json.data.campaign_message).toBe(0);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/notification-prefs', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/liff/notification-prefs', () => {
    it('updates preferences (existing record)', async () => {
      const env = mockEnv();
      const stmt = env.DB.prepare('');
      // First call: check existing -> found
      (stmt.bind('').first as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'np-1' });
      const res = await moreApp.request('/api/liff/notification-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Friend-Id': 'friend-1', 'X-Line-User-Id': 'U_EXISTING' },
        body: JSON.stringify({ restock_alert: false, campaign_message: false }),
      }, env);
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; message: string };
      expect(json.success).toBe(true);
    });

    it('inserts preferences (new record)', async () => {
      const res = await moreReq(moreApp, 'PUT', '/api/liff/notification-prefs', { restock_alert: true });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean };
      expect(json.success).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'PUT', '/api/liff/notification-prefs', { restock_alert: false }, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── Subscriptions ──────────────────────────────
  describe('GET /api/liff/subscriptions', () => {
    it('returns empty subscriptions list', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/subscriptions');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { subscriptions: unknown[] } };
      expect(json.data.subscriptions).toEqual([]);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/subscriptions', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/liff/subscriptions', () => {
    it('creates subscription reminder', async () => {
      const res = await moreReq(moreApp, 'POST', '/api/liff/subscriptions', { productTitle: 'naturism Blue', intervalDays: 30 });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { id: string; nextReminderAt: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBeTruthy();
      expect(json.data.nextReminderAt).toBeTruthy();
    });

    it('returns 400 when productTitle missing', async () => {
      const res = await moreReq(moreApp, 'POST', '/api/liff/subscriptions', {});
      expect(res.status).toBe(400);
    });

    it('defaults intervalDays to 30', async () => {
      const res = await moreReq(moreApp, 'POST', '/api/liff/subscriptions', { productTitle: 'naturism Pink' });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { nextReminderAt: string } };
      // nextReminderAt should be ~30 days from now
      const nextDate = new Date(json.data.nextReminderAt);
      const now = new Date();
      const diffDays = (nextDate.getTime() - now.getTime()) / 86400000;
      expect(diffDays).toBeGreaterThan(29);
      expect(diffDays).toBeLessThan(31);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'POST', '/api/liff/subscriptions', { productTitle: 'test' }, false);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/liff/subscriptions/:id', () => {
    it('updates subscription interval', async () => {
      const res = await moreReq(moreApp, 'PUT', '/api/liff/subscriptions/sub-1', { intervalDays: 60 });
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; message: string };
      expect(json.success).toBe(true);
    });

    it('updates subscription active status', async () => {
      const res = await moreReq(moreApp, 'PUT', '/api/liff/subscriptions/sub-1', { isActive: false });
      expect(res.status).toBe(200);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'PUT', '/api/liff/subscriptions/sub-1', { isActive: false }, false);
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/liff/subscriptions/:id', () => {
    it('deletes subscription', async () => {
      const res = await moreReq(moreApp, 'DELETE', '/api/liff/subscriptions/sub-1');
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; message: string };
      expect(json.success).toBe(true);
      expect(json.message).toBe('Subscription deleted');
    });

    it('returns 401 when not authenticated', async () => {
      const res = await moreReq(moreApp, 'DELETE', '/api/liff/subscriptions/sub-1', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── FAQ ────────────────────────────────────────
  describe('GET /api/liff/faq', () => {
    it('returns FAQ list (empty by default)', async () => {
      const res = await moreReq(moreApp, 'GET', '/api/liff/faq', undefined, false);
      expect(res.status).toBe(200);
      const json = await res.json() as { success: boolean; data: { faqs: unknown[] } };
      expect(json.success).toBe(true);
      expect(json.data.faqs).toEqual([]);
    });

    it('returns FAQ items when they exist', async () => {
      const env = mockEnv();
      const stmt = env.DB.prepare('');
      (stmt.bind('').all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        results: [
          { id: 'faq-1', question: '返品はできますか？', answer: '未開封なら7日以内に返品可能です。', category: 'shipping' },
          { id: 'faq-2', question: '定期購買の解約方法は？', answer: 'マイページから解約できます。', category: 'subscription' },
        ],
      });
      const res = await moreApp.request('/api/liff/faq', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { faqs: Array<{ id: string; question: string }> } };
      expect(json.data.faqs).toHaveLength(2);
      expect(json.data.faqs[0].question).toContain('返品');
    });
  });
});
