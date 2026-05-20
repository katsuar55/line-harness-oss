/**
 * Tests for LINE Insights Overview API (Phase 5β-5a).
 *
 * Coverage:
 *   - 全 4 section (aiReplyRate / broadcasts / scenarios / coupons) を 1 response で返す
 *   - days param の clamp (7-90)
 *   - 認証必須
 *   - 空データ時の graceful response (null / empty array で 0 を返す)
 *   - aiPct / deliverRate / failByStage の集計 logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import { lineInsights } from '../routes/line-insights.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return next();
  });
  app.route('/', lineInsights);
  return app;
}

interface MockD1Options {
  /** if true, first() always returns null (empty data) */
  empty?: boolean;
}

function mockD1(options: MockD1Options = {}) {
  return {
    prepare: vi.fn((sql: string) => {
      const self = {
        bind: vi.fn(() => self),
        first: vi.fn(async () => {
          if (options.empty) return null;
          if (sql.includes('FROM messages_log')) {
            return {
              total: 100,
              ai_replies: 60,
              manual_replies: 10,
              scenario_replies: 20,
              broadcast_messages: 5,
            };
          }
          if (sql.includes('FROM broadcasts')) {
            // 5β-5c-prep: insights_json 集計列を追加
            return {
              total_broadcasts: 5,
              total_delivered: 1000,
              total_target: 1200,
              with_insights: 3,
              total_read: 600,
              total_clicks: 80,
            };
          }
          if (sql.includes('FROM line_friend_coupons')) {
            return { total: 50, redeemed: 12, issued_last_n: 30 };
          }
          if (sql.includes("LIKE 'line_friend_coupon%'")) {
            return { succeeded: 28, failed: 2, threw: 0 };
          }
          return null;
        }),
        all: vi.fn(async () => {
          if (options.empty) return { results: [] };
          if (sql.includes('GROUP BY status')) {
            return {
              results: [
                { status: 'active', count: 10 },
                { status: 'completed', count: 5 },
                { status: 'cancelled', count: 1 },
              ],
            };
          }
          if (sql.includes("WHERE status='active' GROUP BY scenario_id")) {
            return {
              results: [
                { scenario_id: 'welcome-v1', count: 8 },
                { scenario_id: 'reorder-v1', count: 2 },
              ],
            };
          }
          if (sql.includes('GROUP BY stage')) {
            return {
              results: [
                { stage: 'discount_create', count: 2 },
                { stage: 'access_token', count: 1 },
              ],
            };
          }
          return { results: [] };
        }),
      };
      return self;
    }),
  };
}

function req(app: Hono, path: string, db: ReturnType<typeof mockD1> = mockD1()) {
  return app.request(
    `http://localhost${path}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
    { DB: db },
  );
}

describe('LINE Insights API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /api/line-insights/overview returns all 4 sections', async () => {
    const app = createApp();
    const res = await req(app, '/api/line-insights/overview');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        window: { days: number };
        aiReplyRate: { totalOutgoing: number; aiReplies: number; aiPct: number; other: number };
        broadcasts: {
          totalBroadcasts: number;
          totalDelivered: number;
          deliverRate: number;
          withInsights: number;
          totalRead: number;
          totalClicks: number;
          readRate: number;
          clickRate: number;
        };
        scenarios: { statusCounts: unknown[]; activeByScenario: unknown[] };
        coupons: {
          totalIssued: number;
          redeemed: number;
          failByStage: unknown[];
          succeededLastNDays: number;
          failedLastNDays: number;
        };
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.window.days).toBe(30);
    expect(json.data.aiReplyRate.totalOutgoing).toBe(100);
    expect(json.data.aiReplyRate.aiReplies).toBe(60);
    // 60/100 = 60.0
    expect(json.data.aiReplyRate.aiPct).toBe(60);
    // other = total - (ai + manual + scenario + broadcast) = 100 - 95 = 5
    expect(json.data.aiReplyRate.other).toBe(5);
    expect(json.data.broadcasts.totalBroadcasts).toBe(5);
    // 1000 / 1200 = 83.333... → rounded to 1 decimal = 83.3
    expect(json.data.broadcasts.deliverRate).toBeCloseTo(83.3, 1);
    // 5β-5c-prep: insights_json 集計列
    expect(json.data.broadcasts.withInsights).toBe(3);
    expect(json.data.broadcasts.totalRead).toBe(600);
    expect(json.data.broadcasts.totalClicks).toBe(80);
    // read 600 / delivered 1000 = 60%
    expect(json.data.broadcasts.readRate).toBeCloseTo(60, 1);
    // click 80 / delivered 1000 = 8%
    expect(json.data.broadcasts.clickRate).toBeCloseTo(8, 1);
    expect(json.data.scenarios.statusCounts.length).toBe(3);
    expect(json.data.scenarios.activeByScenario.length).toBe(2);
    expect(json.data.coupons.totalIssued).toBe(50);
    expect(json.data.coupons.succeededLastNDays).toBe(28);
    expect(json.data.coupons.failedLastNDays).toBe(2);
    expect(json.data.coupons.failByStage.length).toBe(2);
  });

  it('clamps days parameter to 7-90', async () => {
    const app = createApp();
    const res1 = await req(app, '/api/line-insights/overview?days=200');
    const json1 = (await res1.json()) as { data: { window: { days: number } } };
    expect(json1.data.window.days).toBe(90);

    const res2 = await req(app, '/api/line-insights/overview?days=3');
    const json2 = (await res2.json()) as { data: { window: { days: number } } };
    expect(json2.data.window.days).toBe(7);
  });

  it('defaults to 30 days when days param missing', async () => {
    const app = createApp();
    const res = await req(app, '/api/line-insights/overview');
    const json = (await res.json()) as { data: { window: { days: number } } };
    expect(json.data.window.days).toBe(30);
  });

  it('requires auth', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/line-insights/overview',
      {},
      { DB: mockD1() },
    );
    expect(res.status).toBe(401);
  });

  it('handles empty data gracefully (null first / empty results)', async () => {
    const app = createApp();
    const res = await req(app, '/api/line-insights/overview', mockD1({ empty: true }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        aiReplyRate: { totalOutgoing: number; aiPct: number };
        broadcasts: { totalBroadcasts: number; deliverRate: number };
        scenarios: { statusCounts: unknown[]; activeByScenario: unknown[] };
        coupons: { totalIssued: number; failByStage: unknown[]; failedLastNDays: number };
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.aiReplyRate.totalOutgoing).toBe(0);
    // 0/0 = NaN を回避し、 deliverRate / aiPct ともに 0 を返す
    expect(json.data.aiReplyRate.aiPct).toBe(0);
    expect(json.data.broadcasts.totalBroadcasts).toBe(0);
    expect(json.data.broadcasts.deliverRate).toBe(0);
    expect(json.data.scenarios.statusCounts).toEqual([]);
    expect(json.data.scenarios.activeByScenario).toEqual([]);
    expect(json.data.coupons.totalIssued).toBe(0);
    expect(json.data.coupons.failByStage).toEqual([]);
    expect(json.data.coupons.failedLastNDays).toBe(0);
  });
});
