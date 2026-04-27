/**
 * Tests for LIFF Nutrition Coach API endpoints (Phase 4 PR-4).
 *
 * Covers:
 *   - GET   /api/liff/coach/latest      — latest active recommendation (parsed JSON)
 *   - POST  /api/liff/coach/dismiss     — mark dismissed (friend_id ガード)
 *   - POST  /api/liff/coach/click       — mark clicked + return shopifyProductId
 *   - POST  /api/liff/coach/regenerate  — analyze + recommend (24h rate-limit)
 *
 * `@line-crm/db` と nutrition-analyzer / nutrition-recommender service を
 * モックして、route 層の挙動 (バリデーション・所有者チェック・rate-limit・
 * JSON parse) のみを検証する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { NutritionDeficit, SkuSuggestion } from '@line-crm/db';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getLatestActiveRecommendation: vi.fn(async () => null),
    markRecommendationStatus: vi.fn(async () => undefined),
    jstNow: vi.fn(() => '2026-04-27T09:00:00+09:00'),
  };
});

// ---------------------------------------------------------------------------
// Mock nutrition services
// ---------------------------------------------------------------------------
vi.mock('../services/nutrition-analyzer.js', () => ({
  analyzeFriendNutrition: vi.fn(async () => ({
    fromDate: '2026-04-21',
    toDate: '2026-04-27',
    daysWithData: 7,
    averages: { calorie: 1500, protein_g: 45, fat_g: 40, carbs_g: 200 },
    deficits: [
      {
        key: 'protein_low' as const,
        observedAvg: 45,
        targetAvg: 65,
        severity: 'moderate' as const,
      },
    ],
  })),
}));

vi.mock('../services/nutrition-recommender.js', () => ({
  generateAndStoreRecommendation: vi.fn(async () => ({
    id: 'rec-new-1',
    aiMessage: '今週はたんぱく質が控えめでした。',
    suggestions: [
      {
        shopifyProductId: 'gid://shopify/Product/1',
        productTitle: 'プロテインシェイク',
        copy: 'すっきり美味しいプロテイン',
        deficitKey: 'protein_low',
      },
    ],
    source: 'template' as const,
    recommendation: {
      id: 'rec-new-1',
      friend_id: 'friend-1',
      generated_at: '2026-04-27T09:00:00+09:00',
      deficit_json: '[]',
      sku_suggestions_json: '[]',
      ai_message: '今週はたんぱく質が控えめでした。',
      status: 'active' as const,
      sent_at: null,
      clicked_at: null,
      converted_at: null,
      conversion_event_id: null,
    },
  })),
}));

const { liffPortal } = await import('../routes/liff-portal.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function createApp() {
  const app = new Hono();
  app.use('/api/liff/*', async (c, next) => {
    const friendId = c.req.header('X-Friend-Id');
    const lineUserId = c.req.header('X-Line-User-Id');
    if (friendId && lineUserId) {
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        'liffUser',
        { lineUserId, friendId },
      );
    }
    return next();
  });
  app.route('/', liffPortal);
  return app;
}

interface MockEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
}

function mockEnv(): MockEnv {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn(async () => ({ success: true })),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
  };
  return {
    DB: { prepare: vi.fn(() => stmt) } as unknown as D1Database,
    ANTHROPIC_API_KEY: 'sk-test',
  };
}

function authedReq(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  authenticated = true,
  env?: MockEnv,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authenticated) {
    headers['X-Friend-Id'] = 'friend-1';
    headers['X-Line-User-Id'] = 'U_EXISTING';
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init, env ?? mockEnv());
}

const baseDeficits: NutritionDeficit[] = [
  {
    key: 'protein_low',
    observedAvg: 45,
    targetAvg: 65,
    severity: 'moderate',
  },
];

const baseSuggestions: SkuSuggestion[] = [
  {
    shopifyProductId: 'gid://shopify/Product/1',
    productTitle: 'プロテインシェイク',
    copy: 'すっきり美味しいプロテイン',
    deficitKey: 'protein_low',
  },
  {
    shopifyProductId: 'gid://shopify/Product/2',
    productTitle: 'マルチビタミン',
    copy: '毎日の栄養補給に',
    deficitKey: 'iron_low',
  },
];

function makeRecommendationRow(overrides: Partial<{
  id: string;
  friendId: string;
  generatedAt: string;
  deficits: NutritionDeficit[];
  suggestions: SkuSuggestion[];
  aiMessage: string;
}> = {}) {
  return {
    id: overrides.id ?? 'rec-1',
    friend_id: overrides.friendId ?? 'friend-1',
    generated_at: overrides.generatedAt ?? '2026-04-27T09:00:00+09:00',
    deficit_json: JSON.stringify(overrides.deficits ?? baseDeficits),
    sku_suggestions_json: JSON.stringify(overrides.suggestions ?? baseSuggestions),
    ai_message: overrides.aiMessage ?? '今週はたんぱく質が控えめでした。',
    status: 'active' as const,
    sent_at: null,
    clicked_at: null,
    converted_at: null,
    conversion_event_id: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LIFF Coach API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ─── GET /api/liff/coach/latest ──────────────────
  describe('GET /api/liff/coach/latest', () => {
    it('returns 401 without auth', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/coach/latest', undefined, false);
      expect(res.status).toBe(401);
    });

    it('returns null data when no active recommendation exists', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/coach/latest');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('parses deficit_json and sku_suggestions_json before returning', async () => {
      const db = await import('@line-crm/db');
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow(),
      );
      const res = await authedReq(app, 'GET', '/api/liff/coach/latest');
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          ai_message: string;
          deficits: NutritionDeficit[];
          suggestions: SkuSuggestion[];
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rec-1');
      expect(Array.isArray(json.data.deficits)).toBe(true);
      expect(json.data.deficits[0].key).toBe('protein_low');
      expect(Array.isArray(json.data.suggestions)).toBe(true);
      expect(json.data.suggestions[0].shopifyProductId).toBe('gid://shopify/Product/1');
    });
  });

  // ─── POST /api/liff/coach/dismiss ────────────────
  describe('POST /api/liff/coach/dismiss', () => {
    it('returns 400 when id is missing', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/coach/dismiss', {});
      expect(res.status).toBe(400);
    });

    it('returns 403 when the recommendation belongs to another friend', async () => {
      const db = await import('@line-crm/db');
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow({ friendId: 'friend-OTHER' }),
      );
      const res = await authedReq(app, 'POST', '/api/liff/coach/dismiss', {
        id: 'rec-1',
      });
      expect(res.status).toBe(403);
      expect(db.markRecommendationStatus).not.toHaveBeenCalled();
    });

    it('marks dismissed when caller owns the recommendation', async () => {
      const db = await import('@line-crm/db');
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow({ id: 'rec-1', friendId: 'friend-1' }),
      );
      const res = await authedReq(app, 'POST', '/api/liff/coach/dismiss', {
        id: 'rec-1',
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean };
      expect(json.success).toBe(true);
      expect(db.markRecommendationStatus).toHaveBeenCalledWith(
        expect.anything(),
        'rec-1',
        'dismissed',
      );
    });
  });

  // ─── POST /api/liff/coach/click ──────────────────
  describe('POST /api/liff/coach/click', () => {
    it('returns shopifyProductId for the clicked suggestion index', async () => {
      const db = await import('@line-crm/db');
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow({ id: 'rec-1' }),
      );
      const res = await authedReq(app, 'POST', '/api/liff/coach/click', {
        id: 'rec-1',
        suggestionIndex: 0,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { shopifyProductId: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.shopifyProductId).toBe('gid://shopify/Product/1');
      expect(db.markRecommendationStatus).toHaveBeenCalledWith(
        expect.anything(),
        'rec-1',
        'clicked',
      );
    });

    it('returns 400 when suggestionIndex is out of range', async () => {
      const db = await import('@line-crm/db');
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow(),
      );
      const res = await authedReq(app, 'POST', '/api/liff/coach/click', {
        id: 'rec-1',
        suggestionIndex: 99,
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/liff/coach/regenerate ─────────────
  describe('POST /api/liff/coach/regenerate', () => {
    it('returns 401 without auth', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/coach/regenerate', {}, false);
      expect(res.status).toBe(401);
    });

    it('returns 429 when last generation is within 24h', async () => {
      const db = await import('@line-crm/db');
      const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
      (db.getLatestActiveRecommendation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeRecommendationRow({ generatedAt: recentIso }),
      );
      const res = await authedReq(app, 'POST', '/api/liff/coach/regenerate', {});
      expect(res.status).toBe(429);
    });

    it('returns skipped reason when analyzer reports no_data', async () => {
      const analyzer = await import('../services/nutrition-analyzer.js');
      (analyzer.analyzeFriendNutrition as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        fromDate: '2026-04-21',
        toDate: '2026-04-27',
        daysWithData: 0,
        averages: null,
        deficits: [],
        skipReason: 'no_data',
      });
      const res = await authedReq(app, 'POST', '/api/liff/coach/regenerate', {});
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { skipped: boolean; reason: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.skipped).toBe(true);
      expect(json.data.reason).toBe('no_data');
    });

    it('invokes the recommender when deficits are present and returns the new recommendation', async () => {
      const recommender = await import('../services/nutrition-recommender.js');
      const res = await authedReq(app, 'POST', '/api/liff/coach/regenerate', {});
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { id: string; aiMessage: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('rec-new-1');
      expect(json.data.aiMessage).toContain('たんぱく質');
      expect(recommender.generateAndStoreRecommendation).toHaveBeenCalledTimes(1);
    });
  });
});
