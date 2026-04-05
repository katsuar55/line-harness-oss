/**
 * Tests for Google Analytics 4 連携
 *
 * Covers:
 *   1. GA4設定 CRUD
 *   2. UTMテンプレート CRUD
 *   3. UTMリンクビルダー
 *   4. イベントログ取得
 *   5. buildUtmUrl / buildLineUtmUrl ユーティリティ
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

const mockSettings: Array<Record<string, unknown>> = [];
const mockTemplates: Array<Record<string, unknown>> = [];
const mockEvents: Array<Record<string, unknown>> = [];

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    upsertAnalyticsSettings: vi.fn(async (_db: unknown, settings: Record<string, unknown>) => {
      const item = {
        id: 'setting-1',
        line_account_id: settings.lineAccountId ?? null,
        provider: settings.provider ?? 'ga4',
        measurement_id: settings.measurementId,
        api_secret: settings.apiSecret ?? null,
        enabled: 1,
        config: '{}',
        created_at: '2025-01-01T09:00:00+09:00',
        updated_at: '2025-01-01T09:00:00+09:00',
      };
      mockSettings.push(item);
      return item;
    }),
    getAnalyticsSettings: vi.fn(async () => mockSettings),
    getAnalyticsSettingsById: vi.fn(async (_db: unknown, id: string) => {
      return mockSettings.find((s) => s.id === id) ?? null;
    }),
    deleteAnalyticsSettings: vi.fn(async () => undefined),
    getAnalyticsEvents: vi.fn(async () => mockEvents),
    logAnalyticsEvent: vi.fn(async () => undefined),
    createUtmTemplate: vi.fn(async (_db: unknown, template: Record<string, unknown>) => {
      const item = {
        id: 'utm-1',
        name: template.name,
        utm_source: template.utmSource ?? 'line',
        utm_medium: template.utmMedium ?? 'message',
        utm_campaign: template.utmCampaign ?? null,
        utm_content: template.utmContent ?? null,
        utm_term: template.utmTerm ?? null,
        line_account_id: template.lineAccountId ?? null,
        created_at: '2025-01-01T09:00:00+09:00',
        updated_at: '2025-01-01T09:00:00+09:00',
      };
      mockTemplates.push(item);
      return item;
    }),
    getUtmTemplates: vi.fn(async () => mockTemplates),
    getUtmTemplateById: vi.fn(async (_db: unknown, id: string) => {
      return mockTemplates.find((t) => t.id === id) ?? null;
    }),
    updateUtmTemplate: vi.fn(async (_db: unknown, id: string, updates: Record<string, unknown>) => {
      const t = mockTemplates.find((t) => t.id === id);
      if (!t) return null;
      return { ...t, ...updates };
    }),
    deleteUtmTemplate: vi.fn(async () => undefined),
    // Stubs
    getStaffByApiKey: vi.fn(async () => null),
    jstNow: vi.fn(() => '2025-01-01T09:00:00+09:00'),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { analyticsRoutes } from '../routes/analytics.js';
import { buildUtmUrl, buildLineUtmUrl } from '../services/analytics.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: createMockDb(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: 'test-api-key',
    LIFF_URL: 'https://liff.line.me/1234-abcdef',
    LINE_CHANNEL_ID: 'ch-id',
    LINE_LOGIN_CHANNEL_ID: 'login-ch',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createApp() {
  const app = new Hono<Env>();
  app.route('/api/analytics', analyticsRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Analytics Routes', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createApp();
    env = createMockEnv();
    mockSettings.length = 0;
    mockTemplates.length = 0;
    mockEvents.length = 0;
    vi.clearAllMocks();
  });

  // =========================================================================
  // GA4 Settings
  // =========================================================================

  describe('GA4 Settings', () => {
    it('GET /api/analytics/settings returns empty list initially', async () => {
      const res = await app.request('/api/analytics/settings', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(0);
    });

    it('POST /api/analytics/settings creates setting', async () => {
      const res = await app.request('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ measurementId: 'G-TESTID123', apiSecret: 'secret123' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(body.success).toBe(true);
      expect(body.data.measurement_id).toBe('G-TESTID123');
    });

    it('POST /api/analytics/settings returns 400 without measurementId', async () => {
      const res = await app.request('/api/analytics/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/analytics/settings/:id returns 404 for missing', async () => {
      const res = await app.request('/api/analytics/settings/nonexistent', { method: 'GET' }, env);
      expect(res.status).toBe(404);
    });

    it('GET /api/analytics/settings/:id masks api_secret', async () => {
      mockSettings.push({
        id: 'setting-1',
        measurement_id: 'G-TEST',
        api_secret: 'real-secret',
        enabled: 1,
      });
      const res = await app.request('/api/analytics/settings/setting-1', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data.api_secret).toBe('****');
    });

    it('DELETE /api/analytics/settings/:id succeeds', async () => {
      const res = await app.request('/api/analytics/settings/setting-1', { method: 'DELETE' }, env);
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // Analytics Events
  // =========================================================================

  describe('Analytics Events', () => {
    it('GET /api/analytics/events returns empty list', async () => {
      const res = await app.request('/api/analytics/events', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[]; meta: { limit: number } };
      expect(body.success).toBe(true);
      expect(body.meta.limit).toBe(50);
    });

    it('GET /api/analytics/events respects limit param', async () => {
      const res = await app.request('/api/analytics/events?limit=10&offset=5', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { meta: { limit: number; offset: number } };
      expect(body.meta.limit).toBe(10);
      expect(body.meta.offset).toBe(5);
    });
  });

  // =========================================================================
  // UTM Templates
  // =========================================================================

  describe('UTM Templates', () => {
    it('GET /api/analytics/utm returns empty list initially', async () => {
      const res = await app.request('/api/analytics/utm', { method: 'GET' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it('POST /api/analytics/utm creates template', async () => {
      const res = await app.request('/api/analytics/utm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Spring Campaign',
          utmCampaign: 'spring2026',
          utmContent: 'hero-banner',
        }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(body.data.name).toBe('Spring Campaign');
    });

    it('POST /api/analytics/utm returns 400 without name', async () => {
      const res = await app.request('/api/analytics/utm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
    });

    it('GET /api/analytics/utm/:id returns 404 for missing', async () => {
      const res = await app.request('/api/analytics/utm/nonexistent', { method: 'GET' }, env);
      expect(res.status).toBe(404);
    });

    it('PUT /api/analytics/utm/:id updates template', async () => {
      mockTemplates.push({ id: 'utm-1', name: 'Old Name' });
      const res = await app.request('/api/analytics/utm/utm-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data.name).toBe('New Name');
    });

    it('DELETE /api/analytics/utm/:id succeeds', async () => {
      const res = await app.request('/api/analytics/utm/utm-1', { method: 'DELETE' }, env);
      expect(res.status).toBe(200);
    });
  });

  // =========================================================================
  // UTM Link Builder
  // =========================================================================

  describe('UTM Link Builder', () => {
    it('POST /api/analytics/utm/build generates UTM URL', async () => {
      const res = await app.request('/api/analytics/utm/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://naturism.jp/products/supplement-a',
          campaign: 'spring2026',
          content: 'line-push',
        }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { url: string } };
      expect(body.data.url).toContain('utm_source=line');
      expect(body.data.url).toContain('utm_medium=message');
      expect(body.data.url).toContain('utm_campaign=spring2026');
      expect(body.data.url).toContain('utm_content=line-push');
    });

    it('POST /api/analytics/utm/build with custom source', async () => {
      const res = await app.request('/api/analytics/utm/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://naturism.jp',
          source: 'instagram',
          medium: 'social',
          campaign: 'test',
        }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { url: string } };
      expect(body.data.url).toContain('utm_source=instagram');
      expect(body.data.url).toContain('utm_medium=social');
    });

    it('POST /api/analytics/utm/build returns 400 without url', async () => {
      const res = await app.request('/api/analytics/utm/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
    });

    it('POST /api/analytics/utm/build with templateId returns 404 for missing template', async () => {
      const res = await app.request('/api/analytics/utm/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', templateId: 'nonexistent' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('POST /api/analytics/utm/build with templateId uses template params', async () => {
      mockTemplates.push({
        id: 'utm-1',
        utm_source: 'line',
        utm_medium: 'broadcast',
        utm_campaign: 'summer2026',
        utm_content: null,
        utm_term: null,
      });
      const res = await app.request('/api/analytics/utm/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://naturism.jp', templateId: 'utm-1' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { url: string } };
      expect(body.data.url).toContain('utm_medium=broadcast');
      expect(body.data.url).toContain('utm_campaign=summer2026');
    });
  });
});

// =========================================================================
// Unit Tests: UTM URL Builders
// =========================================================================

describe('UTM URL Builders', () => {
  it('buildUtmUrl appends UTM params to URL', () => {
    const result = buildUtmUrl('https://example.com/page', {
      source: 'google',
      medium: 'cpc',
      campaign: 'test',
    });
    expect(result).toContain('utm_source=google');
    expect(result).toContain('utm_medium=cpc');
    expect(result).toContain('utm_campaign=test');
  });

  it('buildUtmUrl preserves existing query params', () => {
    const result = buildUtmUrl('https://example.com/page?foo=bar', {
      source: 'line',
    });
    expect(result).toContain('foo=bar');
    expect(result).toContain('utm_source=line');
  });

  it('buildUtmUrl skips undefined params', () => {
    const result = buildUtmUrl('https://example.com', { source: 'line' });
    expect(result).toContain('utm_source=line');
    expect(result).not.toContain('utm_medium');
    expect(result).not.toContain('utm_campaign');
  });

  it('buildLineUtmUrl uses line defaults', () => {
    const result = buildLineUtmUrl('https://naturism.jp', {
      campaign: 'spring',
    });
    expect(result).toContain('utm_source=line');
    expect(result).toContain('utm_medium=message');
    expect(result).toContain('utm_campaign=spring');
  });

  it('buildLineUtmUrl works without options', () => {
    const result = buildLineUtmUrl('https://naturism.jp');
    expect(result).toContain('utm_source=line');
    expect(result).toContain('utm_medium=message');
  });
});
