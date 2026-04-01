/**
 * Tests for affiliates routes.
 *
 * Covers:
 *   1. GET /api/affiliates — list all affiliates
 *   2. GET /api/affiliates/:id — get single affiliate
 *   3. POST /api/affiliates — create affiliate
 *   4. PUT /api/affiliates/:id — update affiliate
 *   5. DELETE /api/affiliates/:id — delete affiliate
 *   6. GET /api/affiliates/:id/report — single affiliate report
 *   7. POST /api/affiliates/click — record click (public endpoint)
 *   8. GET /api/affiliates-report — all affiliates report
 *   9. Error handling — 500 on DB exceptions
 *  10. Validation — missing required fields
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

const {
  mockGetAffiliates,
  mockGetAffiliateById,
  mockGetAffiliateByCode,
  mockCreateAffiliate,
  mockUpdateAffiliate,
  mockDeleteAffiliate,
  mockRecordAffiliateClick,
  mockGetAffiliateReport,
} = vi.hoisted(() => ({
  mockGetAffiliates: vi.fn(),
  mockGetAffiliateById: vi.fn(),
  mockGetAffiliateByCode: vi.fn(),
  mockCreateAffiliate: vi.fn(),
  mockUpdateAffiliate: vi.fn(),
  mockDeleteAffiliate: vi.fn(),
  mockRecordAffiliateClick: vi.fn(),
  mockGetAffiliateReport: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getAffiliates: mockGetAffiliates,
    getAffiliateById: mockGetAffiliateById,
    getAffiliateByCode: mockGetAffiliateByCode,
    createAffiliate: mockCreateAffiliate,
    updateAffiliate: mockUpdateAffiliate,
    deleteAffiliate: mockDeleteAffiliate,
    recordAffiliateClick: mockRecordAffiliateClick,
    getAffiliateReport: mockGetAffiliateReport,
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async getProfile(userId: string) {
      return { displayName: 'Test', userId, pictureUrl: '', statusMessage: '' };
    }
    async showLoadingAnimation() {}
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { affiliates } from '../routes/affiliates.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-12345';

function createMockEnv(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', affiliates);
  return app;
}

const SAMPLE_AFFILIATE = {
  id: 'aff-1',
  name: 'Partner A',
  code: 'PARTNER_A',
  commission_rate: 10,
  is_active: 1,
  created_at: '2025-01-01T00:00:00+09:00',
};

const SAMPLE_AFFILIATE_2 = {
  id: 'aff-2',
  name: 'Partner B',
  code: 'PARTNER_B',
  commission_rate: 15,
  is_active: 0,
  created_at: '2025-02-01T00:00:00+09:00',
};

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Affiliates Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createMockEnv();
  });

  // ── GET /api/affiliates ─────────────────────────────────────────────────

  describe('GET /api/affiliates', () => {
    it('returns list of affiliates', async () => {
      mockGetAffiliates.mockResolvedValue([SAMPLE_AFFILIATE, SAMPLE_AFFILIATE_2]);

      const res = await app.request('/api/affiliates', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect(json.data[0]).toEqual({
        id: 'aff-1',
        name: 'Partner A',
        code: 'PARTNER_A',
        commissionRate: 10,
        isActive: true,
        createdAt: '2025-01-01T00:00:00+09:00',
      });
    });

    it('returns empty array when no affiliates exist', async () => {
      mockGetAffiliates.mockResolvedValue([]);

      const res = await app.request('/api/affiliates', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      mockGetAffiliates.mockRejectedValue(new Error('DB down'));

      const res = await app.request('/api/affiliates', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    it('returns 401 without auth', async () => {
      const res = await app.request('/api/affiliates', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/affiliates/:id ─────────────────────────────────────────────

  describe('GET /api/affiliates/:id', () => {
    it('returns a single affiliate', async () => {
      mockGetAffiliateById.mockResolvedValue(SAMPLE_AFFILIATE);

      const res = await app.request('/api/affiliates/aff-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('aff-1');
    });

    it('returns 404 when affiliate not found', async () => {
      mockGetAffiliateById.mockResolvedValue(null);

      const res = await app.request('/api/affiliates/nonexistent', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Affiliate not found');
    });

    it('returns 500 on DB error', async () => {
      mockGetAffiliateById.mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/affiliates/aff-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // ── POST /api/affiliates ────────────────────────────────────────────────

  describe('POST /api/affiliates', () => {
    it('creates a new affiliate', async () => {
      mockCreateAffiliate.mockResolvedValue(SAMPLE_AFFILIATE);

      const res = await app.request(
        '/api/affiliates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Partner A', code: 'PARTNER_A', commissionRate: 10 }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('aff-1');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/affiliates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'CODE' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name and code are required');
    });

    it('returns 400 when code is missing', async () => {
      const res = await app.request(
        '/api/affiliates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Partner' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name and code are required');
    });

    it('returns 500 on DB error', async () => {
      mockCreateAffiliate.mockRejectedValue(new Error('Insert failed'));

      const res = await app.request(
        '/api/affiliates',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Partner', code: 'CODE' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── PUT /api/affiliates/:id ─────────────────────────────────────────────

  describe('PUT /api/affiliates/:id', () => {
    it('updates an existing affiliate', async () => {
      const updated = { ...SAMPLE_AFFILIATE, name: 'Updated Partner' };
      mockUpdateAffiliate.mockResolvedValue(updated);

      const res = await app.request(
        '/api/affiliates/aff-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Partner' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: { name: string } };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated Partner');
    });

    it('converts isActive boolean to is_active integer', async () => {
      const deactivated = { ...SAMPLE_AFFILIATE, is_active: 0 };
      mockUpdateAffiliate.mockResolvedValue(deactivated);

      const res = await app.request(
        '/api/affiliates/aff-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: false }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: { isActive: boolean } };
      expect(json.data.isActive).toBe(false);

      // Verify the DB function received the converted value
      expect(mockUpdateAffiliate).toHaveBeenCalledWith(
        env.DB,
        'aff-1',
        expect.objectContaining({ is_active: 0 }),
      );
    });

    it('passes commissionRate as commission_rate', async () => {
      mockUpdateAffiliate.mockResolvedValue({ ...SAMPLE_AFFILIATE, commission_rate: 20 });

      await app.request(
        '/api/affiliates/aff-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ commissionRate: 20 }),
        },
        env,
      );

      expect(mockUpdateAffiliate).toHaveBeenCalledWith(
        env.DB,
        'aff-1',
        expect.objectContaining({ commission_rate: 20 }),
      );
    });

    it('returns 404 when affiliate not found', async () => {
      mockUpdateAffiliate.mockResolvedValue(null);

      const res = await app.request(
        '/api/affiliates/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Affiliate not found');
    });

    it('returns 500 on DB error', async () => {
      mockUpdateAffiliate.mockRejectedValue(new Error('Update failed'));

      const res = await app.request(
        '/api/affiliates/aff-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── DELETE /api/affiliates/:id ──────────────────────────────────────────

  describe('DELETE /api/affiliates/:id', () => {
    it('deletes an affiliate', async () => {
      mockDeleteAffiliate.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/affiliates/aff-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockDeleteAffiliate).toHaveBeenCalledWith(env.DB, 'aff-1');
    });

    it('returns 500 on DB error', async () => {
      mockDeleteAffiliate.mockRejectedValue(new Error('Delete failed'));

      const res = await app.request(
        '/api/affiliates/aff-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── GET /api/affiliates/:id/report ──────────────────────────────────────

  describe('GET /api/affiliates/:id/report', () => {
    const sampleReport = {
      affiliateId: 'aff-1',
      affiliateName: 'Partner A',
      code: 'PARTNER_A',
      commissionRate: 10,
      totalClicks: 100,
      totalConversions: 5,
      totalRevenue: 5000,
    };

    it('returns the affiliate report', async () => {
      mockGetAffiliateReport.mockResolvedValue([sampleReport]);

      const res = await app.request('/api/affiliates/aff-1/report', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: typeof sampleReport };
      expect(json.success).toBe(true);
      expect(json.data.totalClicks).toBe(100);
      expect(json.data.totalConversions).toBe(5);
    });

    it('passes date filters to getAffiliateReport', async () => {
      mockGetAffiliateReport.mockResolvedValue([sampleReport]);

      await app.request(
        '/api/affiliates/aff-1/report?startDate=2025-01-01&endDate=2025-12-31',
        { headers: authHeaders() },
        env,
      );

      expect(mockGetAffiliateReport).toHaveBeenCalledWith(env.DB, 'aff-1', {
        startDate: '2025-01-01',
        endDate: '2025-12-31',
      });
    });

    it('returns 404 when report is empty', async () => {
      mockGetAffiliateReport.mockResolvedValue([]);

      const res = await app.request('/api/affiliates/aff-1/report', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Affiliate not found');
    });

    it('returns 500 on DB error', async () => {
      mockGetAffiliateReport.mockRejectedValue(new Error('Report error'));

      const res = await app.request('/api/affiliates/aff-1/report', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);
    });
  });

  // ── POST /api/affiliates/click ──────────────────────────────────────────

  describe('POST /api/affiliates/click', () => {
    it('records a click (public endpoint, no auth required)', async () => {
      mockGetAffiliateByCode.mockResolvedValue(SAMPLE_AFFILIATE);
      mockRecordAffiliateClick.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'PARTNER_A', url: 'https://example.com' }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockRecordAffiliateClick).toHaveBeenCalledWith(
        env.DB,
        'aff-1',
        'https://example.com',
        null,
      );
    });

    it('records a click with CF-Connecting-IP header', async () => {
      mockGetAffiliateByCode.mockResolvedValue(SAMPLE_AFFILIATE);
      mockRecordAffiliateClick.mockResolvedValue(undefined);

      await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '1.2.3.4',
          },
          body: JSON.stringify({ code: 'PARTNER_A' }),
        },
        env,
      );

      expect(mockRecordAffiliateClick).toHaveBeenCalledWith(
        env.DB,
        'aff-1',
        undefined,
        '1.2.3.4',
      );
    });

    it('falls back to X-Forwarded-For when CF-Connecting-IP is absent', async () => {
      mockGetAffiliateByCode.mockResolvedValue(SAMPLE_AFFILIATE);
      mockRecordAffiliateClick.mockResolvedValue(undefined);

      await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '5.6.7.8',
          },
          body: JSON.stringify({ code: 'PARTNER_A' }),
        },
        env,
      );

      expect(mockRecordAffiliateClick).toHaveBeenCalledWith(
        env.DB,
        'aff-1',
        undefined,
        '5.6.7.8',
      );
    });

    it('returns 400 when code is missing', async () => {
      const res = await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('code is required');
    });

    it('returns 404 when affiliate code not found', async () => {
      mockGetAffiliateByCode.mockResolvedValue(null);

      const res = await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'INVALID' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.error).toBe('Affiliate not found');
    });

    it('returns 500 on DB error', async () => {
      mockGetAffiliateByCode.mockRejectedValue(new Error('DB error'));

      const res = await app.request(
        '/api/affiliates/click',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'PARTNER_A' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── GET /api/affiliates-report ──────────────────────────────────────────

  describe('GET /api/affiliates-report', () => {
    const reportItems = [
      {
        affiliateId: 'aff-1',
        affiliateName: 'Partner A',
        code: 'PARTNER_A',
        commissionRate: 10,
        totalClicks: 100,
        totalConversions: 5,
        totalRevenue: 5000,
      },
      {
        affiliateId: 'aff-2',
        affiliateName: 'Partner B',
        code: 'PARTNER_B',
        commissionRate: 15,
        totalClicks: 50,
        totalConversions: 2,
        totalRevenue: 2000,
      },
    ];

    it('returns report for all affiliates', async () => {
      mockGetAffiliateReport.mockResolvedValue(reportItems);

      const res = await app.request('/api/affiliates-report', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
    });

    it('passes date filters to getAffiliateReport with undefined affiliateId', async () => {
      mockGetAffiliateReport.mockResolvedValue([]);

      await app.request(
        '/api/affiliates-report?startDate=2025-01-01&endDate=2025-06-30',
        { headers: authHeaders() },
        env,
      );

      expect(mockGetAffiliateReport).toHaveBeenCalledWith(env.DB, undefined, {
        startDate: '2025-01-01',
        endDate: '2025-06-30',
      });
    });

    it('returns empty array when no affiliates', async () => {
      mockGetAffiliateReport.mockResolvedValue([]);

      const res = await app.request('/api/affiliates-report', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      mockGetAffiliateReport.mockRejectedValue(new Error('Report error'));

      const res = await app.request('/api/affiliates-report', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);
    });
  });

  // ── Serialization ───────────────────────────────────────────────────────

  describe('serialization', () => {
    it('converts is_active=1 to isActive=true', async () => {
      mockGetAffiliateById.mockResolvedValue({ ...SAMPLE_AFFILIATE, is_active: 1 });

      const res = await app.request('/api/affiliates/aff-1', { headers: authHeaders() }, env);
      const json = (await res.json()) as { data: { isActive: boolean } };
      expect(json.data.isActive).toBe(true);
    });

    it('converts is_active=0 to isActive=false', async () => {
      mockGetAffiliateById.mockResolvedValue({ ...SAMPLE_AFFILIATE, is_active: 0 });

      const res = await app.request('/api/affiliates/aff-1', { headers: authHeaders() }, env);
      const json = (await res.json()) as { data: { isActive: boolean } };
      expect(json.data.isActive).toBe(false);
    });

    it('maps commission_rate to commissionRate', async () => {
      mockGetAffiliateById.mockResolvedValue({ ...SAMPLE_AFFILIATE, commission_rate: 25 });

      const res = await app.request('/api/affiliates/aff-1', { headers: authHeaders() }, env);
      const json = (await res.json()) as { data: { commissionRate: number } };
      expect(json.data.commissionRate).toBe(25);
    });
  });
});
