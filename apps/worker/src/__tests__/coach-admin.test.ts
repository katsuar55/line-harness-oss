/**
 * Tests for coach-admin routes (Phase 4 PR-6).
 *
 * Covers:
 *   - GET  /api/admin/coach/analytics       — from/to validation, totals + byDeficit
 *   - GET  /api/admin/coach/recommendations — status filter, limit clamp
 *   - GET  /api/admin/coach/sku-map         — listSkuMaps passthrough
 *   - PUT  /api/admin/coach/sku-map         — validation + upsert dispatch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getCoachAnalytics: vi.fn(),
    listSkuMaps: vi.fn(),
    upsertSkuMap: vi.fn(),
    // Stubs for other mounted routes (they share the auth middleware import path)
    getStaffByApiKey: vi.fn(async () => null),
  };
});

// Mock line-sdk to avoid pulling LINE client transitively
vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async multicast() {}
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { coachAdmin } from '../routes/coach-admin.js';
import type { Env } from '../index.js';
import {
  getCoachAnalytics,
  listSkuMaps,
  upsertSkuMap,
} from '@line-crm/db';

const mockGetCoachAnalytics = getCoachAnalytics as ReturnType<typeof vi.fn>;
const mockListSkuMaps = listSkuMaps as ReturnType<typeof vi.fn>;
const mockUpsertSkuMap = upsertSkuMap as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', coachAdmin);
  return app;
}

interface MockDbOptions {
  byDeficitRows?: unknown[];
  recoRows?: unknown[];
  throwOnPrepare?: boolean;
}

function createMockDb(opts: MockDbOptions = {}): D1Database {
  function pickResults(sql: string): { results: unknown[]; success: true } {
    if (sql.includes('json_each')) {
      return { results: opts.byDeficitRows ?? [], success: true };
    }
    if (sql.includes('nutrition_recommendations')) {
      return { results: opts.recoRows ?? [], success: true };
    }
    return { results: [], success: true };
  }

  const prepare = vi.fn((sql: string) => {
    if (opts.throwOnPrepare) throw new Error('DB failure');
    const allFn = vi.fn(async () => pickResults(sql));
    return {
      bind: () => ({
        first: vi.fn(async () => null),
        all: allFn,
        run: vi.fn(async () => ({ success: true })),
      }),
      first: vi.fn(async () => null),
      all: allFn,
      run: vi.fn(async () => ({ success: true })),
    };
  });

  return {
    prepare,
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(opts: MockDbOptions = {}): Env['Bindings'] {
  return {
    DB: createMockDb(opts),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coach-admin routes', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  // ── GET /api/admin/coach/analytics ─────────────────────────────────────

  describe('GET /api/admin/coach/analytics', () => {
    it('returns 400 when from is missing', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/analytics?to=2026-04-30',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });

    it('returns 400 for invalid date format', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/analytics?from=2026/04/01&to=2026-04-30',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when from > to', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/analytics?from=2026-05-01&to=2026-04-01',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns totals and byDeficit on success', async () => {
      mockGetCoachAnalytics.mockResolvedValueOnce({
        generated: 100,
        clicked: 25,
        converted: 5,
        ctr: 0.25,
        cvr: 0.05,
      });

      const byDeficitRows = [
        {
          deficit_key: 'protein_low',
          generated_count: 60,
          clicked_count: 15,
          converted_count: 3,
        },
        {
          deficit_key: 'fiber_low',
          generated_count: 40,
          clicked_count: 10,
          converted_count: 2,
        },
      ];
      const env = createMockEnv({ byDeficitRows });

      const res = await app.request(
        '/api/admin/coach/analytics?from=2026-04-01&to=2026-04-30',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: {
          totals: {
            generated: number;
            clicked: number;
            converted: number;
            ctr: number;
            cvr: number;
          };
          byDeficit: Array<{
            deficitKey: string;
            generatedCount: number;
            clickedCount: number;
            convertedCount: number;
            ctr: number;
            cvr: number;
          }>;
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.totals.generated).toBe(100);
      expect(json.data.totals.ctr).toBe(0.25);
      expect(json.data.byDeficit).toHaveLength(2);
      expect(json.data.byDeficit[0].deficitKey).toBe('protein_low');
      expect(json.data.byDeficit[0].ctr).toBeCloseTo(0.25);
      expect(json.data.byDeficit[1].deficitKey).toBe('fiber_low');

      // Verify getCoachAnalytics was called with end-of-day bound for "to"
      expect(mockGetCoachAnalytics).toHaveBeenCalledOnce();
      const args = mockGetCoachAnalytics.mock.calls[0];
      expect(args[1]).toBe('2026-04-01T00:00:00');
      expect(args[2]).toBe('2026-04-30T23:59:59');
    });
  });

  // ── GET /api/admin/coach/recommendations ───────────────────────────────

  describe('GET /api/admin/coach/recommendations', () => {
    it("filters status='active' by default", async () => {
      const recoRows = [
        {
          id: 'r1',
          friend_id: 'f1',
          friend_name: 'Alice',
          generated_at: '2026-04-27T10:00:00',
          status: 'active',
          ai_message: 'Hi',
          deficit_json: '[{"key":"protein_low"}]',
          sku_suggestions_json:
            '[{"shopifyProductId":"p","productTitle":"t","copy":"c","deficitKey":"protein_low"}]',
        },
      ];
      const env = createMockEnv({ recoRows });

      const res = await app.request(
        '/api/admin/coach/recommendations',
        { method: 'GET', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{
          id: string;
          friendId: string;
          friendName: string | null;
          deficitCount: number;
          skuCount: number;
        }>;
      };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0].friendName).toBe('Alice');
      expect(json.data[0].deficitCount).toBe(1);
      expect(json.data[0].skuCount).toBe(1);
    });

    it('returns 400 for invalid status', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/recommendations?status=banana',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('clamps limit to 200', async () => {
      let capturedSql = '';
      const env = {
        ...createMockEnv(),
        DB: {
          prepare: vi.fn((sql: string) => {
            capturedSql = sql;
            return {
              bind: vi.fn().mockReturnValue({
                all: vi.fn(async () => ({ results: [], success: true })),
              }),
            };
          }),
        } as unknown as D1Database,
      } as Env['Bindings'];

      const res = await app.request(
        '/api/admin/coach/recommendations?limit=999',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      // Bound limit should be 200
      const bindCalls = (
        env.DB.prepare as unknown as ReturnType<typeof vi.fn>
      ).mock.results[0].value.bind.mock.calls;
      expect(bindCalls[0][0]).toBe(200);
      expect(capturedSql).toContain('LIMIT ?');
    });
  });

  // ── GET /api/admin/coach/sku-map ───────────────────────────────────────

  describe('GET /api/admin/coach/sku-map', () => {
    it('returns the list', async () => {
      const rows = [
        {
          deficit_key: 'protein_low',
          shopify_product_id: 'gid://shopify/Product/1',
          product_title: 'Protein',
          copy_template: 'copy',
          is_active: 1,
          created_at: '2026-04-01T00:00:00',
        },
        {
          deficit_key: 'fiber_low',
          shopify_product_id: 'gid://shopify/Product/2',
          product_title: 'Fiber',
          copy_template: 'copy',
          is_active: 1,
          created_at: '2026-04-01T00:00:00',
        },
      ];
      mockListSkuMaps.mockResolvedValueOnce(rows);

      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/sku-map',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        success: boolean;
        data: Array<{ deficit_key: string }>;
      };
      expect(json.data).toHaveLength(2);
      expect(json.data[0].deficit_key).toBe('protein_low');
    });
  });

  // ── PUT /api/admin/coach/sku-map ───────────────────────────────────────

  describe('PUT /api/admin/coach/sku-map', () => {
    it('returns 400 for invalid deficitKey', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/sku-map',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deficitKey: 'nope_low',
            shopifyProductId: 'p',
            productTitle: 't',
            copyTemplate: 'c',
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(mockUpsertSkuMap).not.toHaveBeenCalled();
    });

    it('returns 400 when productTitle exceeds 100 chars', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/sku-map',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deficitKey: 'protein_low',
            shopifyProductId: 'p',
            productTitle: 'x'.repeat(101),
            copyTemplate: 'c',
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(mockUpsertSkuMap).not.toHaveBeenCalled();
    });

    it('returns 400 when copyTemplate exceeds 200 chars', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/sku-map',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deficitKey: 'protein_low',
            shopifyProductId: 'p',
            productTitle: 't',
            copyTemplate: 'y'.repeat(201),
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(mockUpsertSkuMap).not.toHaveBeenCalled();
    });

    it('calls upsertSkuMap on success', async () => {
      mockUpsertSkuMap.mockResolvedValueOnce(undefined);
      const env = createMockEnv();
      const res = await app.request(
        '/api/admin/coach/sku-map',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deficitKey: 'iron_low',
            shopifyProductId: 'gid://shopify/Product/9',
            productTitle: 'Iron+',
            copyTemplate: 'バランスのきっかけに',
            isActive: true,
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockUpsertSkuMap).toHaveBeenCalledOnce();
      const args = mockUpsertSkuMap.mock.calls[0];
      expect(args[1]).toMatchObject({
        deficitKey: 'iron_low',
        shopifyProductId: 'gid://shopify/Product/9',
        productTitle: 'Iron+',
        copyTemplate: 'バランスのきっかけに',
        isActive: true,
      });
    });
  });
});
