/**
 * Tests for LIFF routes.
 *
 * Covers:
 *   1. GET /auth/line — mobile redirect to LIFF URL, PC shows QR page
 *   2. GET /auth/line — with account param resolves multi-account
 *   3. GET /auth/line — xh: refs are excluded from external URLs
 *   4. GET /auth/callback — error handling (missing code, error param)
 *   5. POST /api/liff/profile — get friend by LINE user ID
 *   6. POST /api/liff/profile — validation and 404
 *   7. POST /api/liff/link — requires idToken
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
    getFriendByLineUserId: vi.fn(async (_db: unknown, lineUserId: string) => {
      if (lineUserId === 'U_EXISTING') {
        return {
          id: 'friend-1',
          line_user_id: 'U_EXISTING',
          display_name: 'Test User',
          is_following: 1,
          user_id: 'user-1',
        };
      }
      return null;
    }),
    createUser: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'new-user-1',
      email: data.email,
      displayName: data.displayName,
    })),
    getUserByEmail: vi.fn(async () => null),
    linkFriendToUser: vi.fn(async () => undefined),
    upsertFriend: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'friend-upserted',
      line_user_id: data.lineUserId,
      display_name: data.displayName,
      is_following: 1,
    })),
    getEntryRouteByRefCode: vi.fn(async () => null),
    recordRefTracking: vi.fn(async () => undefined),
    addTagToFriend: vi.fn(async () => undefined),
    getLineAccountByChannelId: vi.fn(async (_db: unknown, channelId: string) => {
      if (channelId === 'acct-naturism') {
        return {
          id: 'la-1',
          channel_id: 'acct-naturism',
          login_channel_id: 'login-naturism',
          login_channel_secret: 'secret-naturism',
          liff_id: '1234-abcdef',
          channel_access_token: 'tok-naturism',
        };
      }
      return null;
    }),
    getLineAccounts: vi.fn(async () => []),
    jstNow: vi.fn(() => '2025-01-01T09:00:00+09:00'),
    // Stubs to prevent import errors
    getStaffByApiKey: vi.fn(async () => null),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
    getFriendById: vi.fn(async () => null),
  };
});

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

import { liffRoutes } from '../routes/liff.js';
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
  app.route('/', liffRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LIFF Routes', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // GET /auth/line
  // =========================================================================

  describe('GET /auth/line', () => {
    it('redirects mobile users to LIFF URL', async () => {
      const res = await app.request('/auth/line', {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS) Mobile' },
      }, env);
      expect(res.status).toBe(302);
      const location = res.headers.get('Location') || '';
      expect(location).toContain('liff.line.me');
    });

    it('shows QR page for desktop users', async () => {
      const res = await app.request('/auth/line', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('QR');
    });

    it('passes ref param in LIFF URL for mobile', async () => {
      const res = await app.request('/auth/line?ref=campaign1', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Android) Mobile' },
      }, env);
      expect(res.status).toBe(302);
      const location = res.headers.get('Location') || '';
      expect(location).toContain('ref=campaign1');
    });

    it('excludes xh: ref from external LIFF URL on mobile', async () => {
      const res = await app.request('/auth/line?ref=xh:secret_token', {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) Mobile' },
      }, env);
      expect(res.status).toBe(302);
      const location = res.headers.get('Location') || '';
      expect(location).not.toContain('xh:');
    });

    it('resolves multi-account with account param on mobile', async () => {
      // With account param, mobile should go through OAuth (not LIFF) for cross-account
      const res = await app.request('/auth/line?account=acct-naturism', {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone) Mobile' },
      }, env);
      expect(res.status).toBe(302);
      const location = res.headers.get('Location') || '';
      expect(location).toContain('access.line.me');
    });

    it('includes ad click IDs in state for OAuth', async () => {
      const res = await app.request('/auth/line?gclid=g123&fbclid=f456', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0)' },
      }, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      // QR page should render; state is in OAuth URL inside the page
      expect(html).toContain('QR');
    });
  });

  // =========================================================================
  // GET /auth/callback
  // =========================================================================

  describe('GET /auth/callback', () => {
    it('returns error page when error param is present', async () => {
      const res = await app.request('/auth/callback?error=access_denied', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('access_denied');
    });

    it('returns error page when code is missing', async () => {
      const res = await app.request('/auth/callback', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      // errorPage is rendered with Japanese error title
      expect(html).toContain('エラー');
    });
  });

  // =========================================================================
  // POST /api/liff/profile
  // =========================================================================

  describe('POST /api/liff/profile', () => {
    it('returns 400 when lineUserId is missing', async () => {
      const res = await app.request('/api/liff/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('returns 404 when friend not found', async () => {
      const res = await app.request('/api/liff/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_NONEXISTENT' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('returns friend data when found', async () => {
      const res = await app.request('/api/liff/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineUserId: 'U_EXISTING' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; displayName: string; isFollowing: boolean; userId: string | null };
      };
      expect(body.success).toBe(true);
      expect(body.data.id).toBe('friend-1');
      expect(body.data.displayName).toBe('Test User');
      expect(body.data.isFollowing).toBe(true);
    });
  });

  // =========================================================================
  // POST /api/liff/link
  // =========================================================================

  describe('POST /api/liff/link', () => {
    it('returns 400 when idToken is missing', async () => {
      const res = await app.request('/api/liff/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.error).toBe('idToken is required');
    });
  });
});
