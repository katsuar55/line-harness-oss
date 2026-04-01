/**
 * Tests for ad-platforms routes.
 *
 * Covers:
 *   1. GET /api/ad-platforms — list all ad platforms with masked config
 *   2. POST /api/ad-platforms — create with validation (name, config required; valid names)
 *   3. PUT /api/ad-platforms/:id — update, 404 when not found
 *   4. POST /api/ad-platforms/test — test conversion (validation, platform lookup, with/without friendId)
 *   5. DELETE /api/ad-platforms/:id — delete
 *   6. GET /api/ad-platforms/:id/logs — conversion logs with limit param
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getAdPlatforms: vi.fn(async () => [
      {
        id: 'ap-1',
        name: 'meta',
        display_name: 'Meta Ads',
        config: JSON.stringify({ access_token: 'abcdefghij1234567890', pixel_id: 'px123' }),
        is_active: 1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ]),
    getAdPlatformById: vi.fn(async () => null),
    createAdPlatform: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'ap-new',
      name: data.name,
      display_name: data.displayName ?? null,
      config: JSON.stringify(data.config),
      is_active: 1,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    })),
    updateAdPlatform: vi.fn(async () => ({
      id: 'ap-1',
      name: 'meta',
      display_name: 'Meta Updated',
      config: JSON.stringify({ access_token: 'updated123' }),
      is_active: 1,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
    })),
    deleteAdPlatform: vi.fn(async () => undefined),
    getAdConversionLogs: vi.fn(async () => [
      {
        id: 'log-1',
        ad_platform_id: 'ap-1',
        friend_id: 'f-1',
        event_name: 'purchase',
        click_id: 'gclid_abc',
        click_id_type: 'gclid',
        status: 'sent',
        error_message: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ]),
    getAdPlatformByName: vi.fn(async (_db: unknown, name: string) => {
      if (name === 'meta') {
        return { id: 'ap-1', name: 'meta', config: '{}', is_active: 1 };
      }
      return null;
    }),
    // Stubs to prevent import errors
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
    getFriendById: vi.fn(async () => null),
  };
});

// Mock ad-conversion service
vi.mock('../services/ad-conversion.js', () => ({
  sendAdConversions: vi.fn(async () => undefined),
}));

// Mock line-sdk
vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class {
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

import { adPlatforms } from '../routes/ad-platforms.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockEnv(): Env['Bindings'] {
  return {
    DB: {
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
    } as unknown as D1Database,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: 'test-api-key',
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'ch-id',
    LINE_LOGIN_CHANNEL_ID: 'login-ch',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createApp() {
  const app = new Hono<Env>();
  app.route('/', adPlatforms);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ad Platforms Routes', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  describe('GET /api/ad-platforms', () => {
    it('returns list with masked config', async () => {
      const res = await app.request('/api/ad-platforms', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ config: Record<string, string> }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      // access_token should be masked (length > 8)
      expect(body.data[0].config.access_token).toMatch(/^\w{4}\*{4}\w{4}$/);
      // pixel_id is short (5 chars), should NOT be masked
      expect(body.data[0].config.pixel_id).toBe('px123');
    });
  });

  describe('POST /api/ad-platforms', () => {
    it('returns 400 when name is missing', async () => {
      const res = await app.request('/api/ad-platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { token: 'x' } }),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('returns 400 when config is missing', async () => {
      const res = await app.request('/api/ad-platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'meta' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid platform name', async () => {
      const res = await app.request('/api/ad-platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'snapchat', config: { token: 'x' } }),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toContain('must be one of');
    });

    it('creates a platform with valid data', async () => {
      const res = await app.request('/api/ad-platforms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'meta', config: { access_token: 'tok' } }),
      }, env);
      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; name: string } };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('meta');
    });
  });

  describe('PUT /api/ad-platforms/:id', () => {
    it('updates a platform and returns 200', async () => {
      const res = await app.request('/api/ad-platforms/ap-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'Meta Updated' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { displayName: string } };
      expect(body.success).toBe(true);
    });

    it('returns 404 when platform not found', async () => {
      const { updateAdPlatform } = await import('@line-crm/db');
      (updateAdPlatform as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const res = await app.request('/api/ad-platforms/nonexistent', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'X' }),
      }, env);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/ad-platforms/test', () => {
    it('returns 400 when platform or eventName is missing', async () => {
      const res = await app.request('/api/ad-platforms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'meta' }),
      }, env);
      expect(res.status).toBe(400);
    });

    it('returns 404 when platform not found', async () => {
      const res = await app.request('/api/ad-platforms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'google', eventName: 'purchase' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('returns success without friendId (config check only)', async () => {
      const res = await app.request('/api/ad-platforms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'meta', eventName: 'purchase' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('configured and active');
    });

    it('sends test conversion with friendId', async () => {
      const res = await app.request('/api/ad-platforms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'meta', eventName: 'purchase', friendId: 'f-1' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { message: string } };
      expect(body.data.message).toContain('full pipeline');
    });
  });

  describe('DELETE /api/ad-platforms/:id', () => {
    it('deletes and returns success', async () => {
      const res = await app.request('/api/ad-platforms/ap-1', { method: 'DELETE' }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });
  });

  describe('GET /api/ad-platforms/:id/logs', () => {
    it('returns conversion logs', async () => {
      const res = await app.request('/api/ad-platforms/ap-1/logs', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ eventName: string }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].eventName).toBe('purchase');
    });

    it('passes limit query param', async () => {
      const { getAdConversionLogs } = await import('@line-crm/db');
      await app.request('/api/ad-platforms/ap-1/logs?limit=10', {}, env);
      expect(getAdConversionLogs).toHaveBeenCalledWith(expect.anything(), 'ap-1', 10);
    });
  });
});
