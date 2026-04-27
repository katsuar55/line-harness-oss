/**
 * Tests for LIFF Portal Food Log endpoints (Phase 3 PR-4).
 *
 * Covers:
 *   - POST   /api/liff/food/log               — manual food log entry
 *   - GET    /api/liff/food/logs              — history pagination
 *   - DELETE /api/liff/food/logs/:id          — owner-only delete (with R2 cleanup)
 *   - GET    /api/liff/food/stats/today       — today's PFC + calories
 *   - GET    /api/liff/food/stats/range       — date-range stats (graph)
 *   - GET    /api/liff/food/report/:yearMonth — monthly AI report (pull)
 *
 * The DB layer (`@line-crm/db`) and R2 bucket are mocked. Auth middleware
 * is replaced with a header-based stub so `getLiffUser` resolves to a known
 * friend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — only the food-log functions used by the routes.
// importOriginal preserves the rest (other helpers used elsewhere in liff-portal).
// ---------------------------------------------------------------------------
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    insertFoodLog: vi.fn(
      async (
        _db: unknown,
        input: {
          friendId: string;
          ateAt: string;
          mealType?: string | null;
          imageUrl?: string | null;
          rawText?: string | null;
        },
        id?: string,
      ) => ({
        id: id ?? 'fl-generated',
        friend_id: input.friendId,
        ate_at: input.ateAt,
        meal_type: input.mealType ?? null,
        image_url: input.imageUrl ?? null,
        raw_text: input.rawText ?? null,
        ai_analysis: null,
        total_calories: null,
        total_protein_g: null,
        total_fat_g: null,
        total_carbs_g: null,
        analysis_status: 'pending' as const,
        error_message: null,
        created_at: '2026-04-27T09:00:00+09:00',
      }),
    ),
    updateFoodLogAnalysis: vi.fn(async () => undefined),
    getFoodLogsByFriend: vi.fn(async () => ({
      logs: [
        {
          id: 'fl-1',
          friend_id: 'friend-1',
          ate_at: '2026-04-27T08:00:00+09:00',
          meal_type: 'breakfast',
          image_url: null,
          raw_text: 'oatmeal',
          ai_analysis: null,
          total_calories: 350,
          total_protein_g: 12,
          total_fat_g: 8,
          total_carbs_g: 55,
          analysis_status: 'completed',
          error_message: null,
          created_at: '2026-04-27T08:01:00+09:00',
        },
      ],
      nextCursor: null,
    })),
    getFoodLogById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'fl-mine') {
        return {
          id: 'fl-mine',
          friend_id: 'friend-1',
          ate_at: '2026-04-27T08:00:00+09:00',
          meal_type: null,
          image_url: 'https://test.workers.dev/api/images/food/abc123.png',
          raw_text: null,
          ai_analysis: null,
          total_calories: null,
          total_protein_g: null,
          total_fat_g: null,
          total_carbs_g: null,
          analysis_status: 'pending',
          error_message: null,
          created_at: '2026-04-27T08:01:00+09:00',
        };
      }
      if (id === 'fl-other') {
        return {
          id: 'fl-other',
          friend_id: 'friend-XX',
          ate_at: '2026-04-27T08:00:00+09:00',
          meal_type: null,
          image_url: null,
          raw_text: null,
          ai_analysis: null,
          total_calories: null,
          total_protein_g: null,
          total_fat_g: null,
          total_carbs_g: null,
          analysis_status: 'pending',
          error_message: null,
          created_at: '2026-04-27T08:01:00+09:00',
        };
      }
      return null;
    }),
    deleteFoodLog: vi.fn(async () => true),
    getDailyFoodStatsForToday: vi.fn(async () => ({
      friend_id: 'friend-1',
      date: '2026-04-27',
      total_calories: 1200,
      total_protein_g: 60,
      total_fat_g: 30,
      total_carbs_g: 150,
      meal_count: 3,
      last_updated: '2026-04-27T20:00:00+09:00',
    })),
    getDailyFoodStatsRange: vi.fn(async () => [
      {
        friend_id: 'friend-1',
        date: '2026-04-25',
        total_calories: 1500,
        total_protein_g: 70,
        total_fat_g: 40,
        total_carbs_g: 180,
        meal_count: 3,
        last_updated: '2026-04-25T20:00:00+09:00',
      },
    ]),
    getMonthlyFoodReport: vi.fn(async () => null),
    jstNow: vi.fn(() => '2026-04-27T09:00:00+09:00'),
  };
});

// ---------------------------------------------------------------------------
// App setup — header-driven auth stub mirroring the More Tab pattern in
// liff-portal.test.ts. The middleware sets `liffUser` so getLiffUser(c) resolves.
// ---------------------------------------------------------------------------
const { liffPortal } = await import('../routes/liff-portal.js');

interface MockR2Bucket {
  delete: ReturnType<typeof vi.fn>;
}

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

function mockEnv(): { DB: D1Database; IMAGES: MockR2Bucket } {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn(async () => ({ success: true })),
    all: vi.fn(async () => ({ results: [] })),
    first: vi.fn(async () => null),
  };
  const r2: MockR2Bucket = {
    delete: vi.fn(async () => undefined),
  };
  return {
    DB: { prepare: vi.fn(() => stmt) } as unknown as D1Database,
    IMAGES: r2,
  };
}

function authedReq(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  authenticated = true,
  env?: ReturnType<typeof mockEnv>,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('LIFF Food Log Endpoints', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ─── POST /api/liff/food/log ─────────────────────────
  describe('POST /api/liff/food/log', () => {
    it('creates a pending log when no nutrition values are provided', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: '2026-04-27T08:00:00+09:00',
        mealType: 'breakfast',
        rawText: 'toast and eggs',
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: { analysis_status: string; raw_text: string | null };
      };
      expect(json.success).toBe(true);
      expect(json.data.analysis_status).toBe('pending');
      expect(json.data.raw_text).toBe('toast and eggs');

      const db = await import('@line-crm/db');
      expect(db.updateFoodLogAnalysis).not.toHaveBeenCalled();
    });

    it('promotes to completed when calories+PFC are provided', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: '2026-04-27T12:00:00+09:00',
        mealType: 'lunch',
        calories: 600,
        proteinG: 25,
        fatG: 18,
        carbsG: 70,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { analysis_status: string; total_calories: number };
      };
      expect(json.data.analysis_status).toBe('completed');
      expect(json.data.total_calories).toBe(600);

      const db = await import('@line-crm/db');
      expect(db.updateFoodLogAnalysis).toHaveBeenCalledTimes(1);
    });

    it('rejects when ateAt is missing', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        mealType: 'snack',
      });
      expect(res.status).toBe(400);
    });

    it('rejects when ateAt is not ISO8601', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: 'not-a-date',
      });
      expect(res.status).toBe(400);
    });

    it('rejects when calories exceed 10000', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: '2026-04-27T08:00:00+09:00',
        calories: 99999,
      });
      expect(res.status).toBe(400);
    });

    it('rejects when proteinG is negative', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: '2026-04-27T08:00:00+09:00',
        proteinG: -5,
      });
      expect(res.status).toBe(400);
    });

    it('truncates rawText longer than 500 chars', async () => {
      const res = await authedReq(app, 'POST', '/api/liff/food/log', {
        ateAt: '2026-04-27T08:00:00+09:00',
        rawText: 'a'.repeat(700),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { raw_text: string } };
      expect(json.data.raw_text.length).toBe(500);
    });

    it('returns 401 without auth headers', async () => {
      const res = await authedReq(
        app,
        'POST',
        '/api/liff/food/log',
        { ateAt: '2026-04-27T08:00:00+09:00' },
        false,
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/liff/food/logs ─────────────────────────
  describe('GET /api/liff/food/logs', () => {
    it('returns logs with pagination metadata', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/logs');
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { logs: unknown[]; nextCursor: string | null };
      };
      expect(json.data.logs).toHaveLength(1);
      expect(json.data.nextCursor).toBeNull();
    });

    it('forwards limit/cursor/from/to query params to db helper', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/logs?limit=5&fromDate=2026-04-01T00:00:00%2B09:00&toDate=2026-04-30T23:59:59%2B09:00',
      );
      expect(res.status).toBe(200);
      const db = await import('@line-crm/db');
      expect(db.getFoodLogsByFriend).toHaveBeenCalledWith(
        expect.anything(),
        'friend-1',
        expect.objectContaining({
          limit: 5,
          fromDate: '2026-04-01T00:00:00+09:00',
          toDate: '2026-04-30T23:59:59+09:00',
        }),
      );
    });

    it('clamps limit to max 100', async () => {
      await authedReq(app, 'GET', '/api/liff/food/logs?limit=9999');
      const db = await import('@line-crm/db');
      const lastCall = (
        db.getFoodLogsByFriend as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1) as unknown[];
      expect((lastCall[2] as { limit: number }).limit).toBe(100);
    });

    it('returns 401 without auth', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/logs', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/liff/food/logs/:id ──────────────────
  describe('DELETE /api/liff/food/logs/:id', () => {
    it('deletes the log when caller is the owner', async () => {
      const env = mockEnv();
      const res = await authedReq(
        app,
        'DELETE',
        '/api/liff/food/logs/fl-mine',
        undefined,
        true,
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();

      const db = await import('@line-crm/db');
      // friendId が SQL レベルで渡される (TOCTOU 排除)
      expect(db.deleteFoodLog).toHaveBeenCalledWith(expect.anything(), 'fl-mine', 'friend-1');
      // R2 best-effort cleanup invoked because image_url contained an /api/images/food/ key.
      expect(env.IMAGES.delete).toHaveBeenCalledWith('food/abc123.png');
    });

    it('returns 404 when the log belongs to another friend', async () => {
      const res = await authedReq(app, 'DELETE', '/api/liff/food/logs/fl-other');
      expect(res.status).toBe(404);

      const db = await import('@line-crm/db');
      expect(db.deleteFoodLog).not.toHaveBeenCalled();
    });

    it('returns 404 when the log does not exist', async () => {
      const res = await authedReq(app, 'DELETE', '/api/liff/food/logs/missing');
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await authedReq(app, 'DELETE', '/api/liff/food/logs/fl-mine', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/liff/food/stats/today ──────────────────
  describe('GET /api/liff/food/stats/today', () => {
    it('returns today stats', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/stats/today');
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { total_calories: number; meal_count: number };
      };
      expect(json.data.total_calories).toBe(1200);
      expect(json.data.meal_count).toBe(3);
    });

    it('returns null data when no record exists', async () => {
      const db = await import('@line-crm/db');
      (db.getDailyFoodStatsForToday as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null);
      const res = await authedReq(app, 'GET', '/api/liff/food/stats/today');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: unknown | null };
      expect(json.data).toBeNull();
    });

    it('returns 401 without auth', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/stats/today', undefined, false);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/liff/food/stats/range ──────────────────
  describe('GET /api/liff/food/stats/range', () => {
    it('returns range stats', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/stats/range?from=2026-04-20&to=2026-04-27',
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: unknown[] };
      expect(json.data).toHaveLength(1);
    });

    it('rejects when from/to are missing', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/stats/range');
      expect(res.status).toBe(400);
    });

    it('rejects when from > to', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/stats/range?from=2026-04-27&to=2026-04-20',
      );
      expect(res.status).toBe(400);
    });

    it('rejects when range exceeds 90 days', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/stats/range?from=2026-01-01&to=2026-12-31',
      );
      expect(res.status).toBe(400);
    });

    it('rejects malformed date', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/stats/range?from=2026/04/01&to=2026/04/30',
      );
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/liff/food/report/:yearMonth ────────────
  describe('GET /api/liff/food/report/:yearMonth', () => {
    it('returns null data when no report exists yet', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/report/2026-04');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: unknown };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns the report when one exists', async () => {
      const db = await import('@line-crm/db');
      (db.getMonthlyFoodReport as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        friend_id: 'friend-1',
        year_month: '2026-03',
        summary_text: '今月もよく頑張りました。',
        meal_count: 60,
        avg_calories: 1850,
        generated_at: '2026-04-01T00:00:00+09:00',
      });
      const res = await authedReq(app, 'GET', '/api/liff/food/report/2026-03');
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { year_month: string; meal_count: number };
      };
      expect(json.data.year_month).toBe('2026-03');
      expect(json.data.meal_count).toBe(60);
    });

    it('rejects malformed yearMonth', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/report/2026-13');
      expect(res.status).toBe(400);
    });

    it('rejects non-YYYY-MM format', async () => {
      const res = await authedReq(app, 'GET', '/api/liff/food/report/2026');
      expect(res.status).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await authedReq(
        app,
        'GET',
        '/api/liff/food/report/2026-04',
        undefined,
        false,
      );
      expect(res.status).toBe(401);
    });
  });
});
