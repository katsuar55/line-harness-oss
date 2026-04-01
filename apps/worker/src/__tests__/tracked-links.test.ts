/**
 * Tests for tracked-links routes.
 *
 * Covers:
 *   1. GET /api/tracked-links — list all tracked links
 *   2. GET /api/tracked-links/:id — get single link with clicks
 *   3. POST /api/tracked-links — create a new tracked link
 *   4. DELETE /api/tracked-links/:id — delete a tracked link
 *   5. GET /t/:linkId — click tracking redirect (302)
 *   6. GET /t/:linkId — returns 404 for inactive/missing link
 *   7. GET /t/:linkId — app-link domain returns HTML redirect
 *   8. GET /t/:linkId — LINE in-app browser redirects to LIFF
 *   9. GET /t/:linkId — resolves friend from lineUserId query param
 *  10. POST /api/tracked-links — validation: missing name returns 400
 *  11. GET /api/tracked-links — 500 on DB error
 *  12. GET /api/tracked-links/:id — 404 for non-existent link
 *  13. DELETE /api/tracked-links/:id — 404 for non-existent link
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getTrackedLinks: vi.fn(),
    getTrackedLinkById: vi.fn(),
    createTrackedLink: vi.fn(),
    deleteTrackedLink: vi.fn(),
    recordLinkClick: vi.fn(),
    getLinkClicks: vi.fn(),
    getFriendByLineUserId: vi.fn(),
    addTagToFriend: vi.fn(),
    enrollFriendInScenario: vi.fn(),
    // Stubs needed by other modules imported transitively
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
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

import {
  getTrackedLinks,
  getTrackedLinkById,
  createTrackedLink,
  deleteTrackedLink,
  recordLinkClick,
  getLinkClicks,
  getFriendByLineUserId,
  addTagToFriend,
  enrollFriendInScenario,
} from '@line-crm/db';
import type { TrackedLink, LinkClickWithFriend } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { trackedLinks } from '../routes/tracked-links.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

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

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', trackedLinks);
  return app;
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

const SAMPLE_LINK: TrackedLink = {
  id: 'link-001',
  name: 'Campaign A',
  original_url: 'https://example.com/landing',
  tag_id: 'tag-1',
  scenario_id: 'scenario-1',
  is_active: 1,
  click_count: 5,
  created_at: '2025-01-01T00:00:00+09:00',
  updated_at: '2025-01-02T00:00:00+09:00',
};

const SAMPLE_CLICKS: LinkClickWithFriend[] = [
  {
    id: 'click-001',
    tracked_link_id: 'link-001',
    friend_id: 'friend-1',
    clicked_at: '2025-01-02T12:00:00+09:00',
    friend_display_name: 'Taro',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tracked-links routes', () => {
  let app: InstanceType<typeof Hono<Env>>;
  let env: Env['Bindings'];

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createMockEnv();
  });

  // ── GET /api/tracked-links ──────────────────────────────────────────────

  describe('GET /api/tracked-links', () => {
    it('returns list of tracked links', async () => {
      vi.mocked(getTrackedLinks).mockResolvedValue([SAMPLE_LINK]);

      const res = await app.request('/api/tracked-links', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toMatchObject({
        id: 'link-001',
        name: 'Campaign A',
        originalUrl: 'https://example.com/landing',
        isActive: true,
        clickCount: 5,
      });
    });

    it('includes trackingUrl with correct base', async () => {
      vi.mocked(getTrackedLinks).mockResolvedValue([SAMPLE_LINK]);

      const res = await app.request('/api/tracked-links', { headers: authHeaders() }, env);
      const json = (await res.json()) as { data: { trackingUrl: string }[] };
      expect(json.data[0].trackingUrl).toContain('/t/link-001');
    });

    it('returns empty array when no links exist', async () => {
      vi.mocked(getTrackedLinks).mockResolvedValue([]);

      const res = await app.request('/api/tracked-links', { headers: authHeaders() }, env);
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getTrackedLinks).mockRejectedValue(new Error('DB down'));

      const res = await app.request('/api/tracked-links', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    it('returns 401 without auth header', async () => {
      const res = await app.request('/api/tracked-links', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/tracked-links/:id ──────────────────────────────────────────

  describe('GET /api/tracked-links/:id', () => {
    it('returns link with click details', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(getLinkClicks).mockResolvedValue(SAMPLE_CLICKS);

      const res = await app.request('/api/tracked-links/link-001', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        success: boolean;
        data: {
          id: string;
          clicks: { id: string; friendId: string; friendDisplayName: string; clickedAt: string }[];
        };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('link-001');
      expect(json.data.clicks).toHaveLength(1);
      expect(json.data.clicks[0]).toMatchObject({
        id: 'click-001',
        friendId: 'friend-1',
        friendDisplayName: 'Taro',
      });
    });

    it('returns 404 for non-existent link', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(null);

      const res = await app.request('/api/tracked-links/no-exist', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Tracked link not found');
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getTrackedLinkById).mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/tracked-links/link-001', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);
    });
  });

  // ── POST /api/tracked-links ─────────────────────────────────────────────

  describe('POST /api/tracked-links', () => {
    it('creates a new tracked link', async () => {
      vi.mocked(createTrackedLink).mockResolvedValue(SAMPLE_LINK);

      const res = await app.request(
        '/api/tracked-links',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Campaign A',
            originalUrl: 'https://example.com/landing',
            tagId: 'tag-1',
            scenarioId: 'scenario-1',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: { id: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('link-001');
    });

    it('passes tagId and scenarioId as null when not provided', async () => {
      vi.mocked(createTrackedLink).mockResolvedValue({ ...SAMPLE_LINK, tag_id: null, scenario_id: null });

      const res = await app.request(
        '/api/tracked-links',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Simple', originalUrl: 'https://example.com' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(createTrackedLink).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tagId: null, scenarioId: null }),
      );
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/tracked-links',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalUrl: 'https://example.com' }),
        },
        env,
      );
      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('required');
    });

    it('returns 400 when originalUrl is missing', async () => {
      const res = await app.request(
        '/api/tracked-links',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'No URL' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(createTrackedLink).mockRejectedValue(new Error('insert failed'));

      const res = await app.request(
        '/api/tracked-links',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test', originalUrl: 'https://example.com' }),
        },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── DELETE /api/tracked-links/:id ───────────────────────────────────────

  describe('DELETE /api/tracked-links/:id', () => {
    it('deletes an existing link', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(deleteTrackedLink).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/tracked-links/link-001',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });

    it('returns 404 for non-existent link', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(null);

      const res = await app.request(
        '/api/tracked-links/no-exist',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(404);
    });

    it('returns 500 on DB error', async () => {
      vi.mocked(getTrackedLinkById).mockRejectedValue(new Error('DB error'));

      const res = await app.request(
        '/api/tracked-links/link-001',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  // ── GET /t/:linkId — click tracking redirect ───────────────────────────

  describe('GET /t/:linkId (click tracking)', () => {
    let trackApp: InstanceType<typeof Hono<Env>>;
    let waitUntilPromises: Promise<unknown>[];
    let mockExecCtx: ExecutionContext;

    beforeEach(() => {
      waitUntilPromises = [];
      trackApp = new Hono<Env>();
      trackApp.use('*', authMiddleware);
      trackApp.route('/', trackedLinks);
      mockExecCtx = {
        waitUntil: vi.fn((p: Promise<unknown>) => { waitUntilPromises.push(p); }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
    });

    async function fetchTrack(path: string, init?: RequestInit): Promise<Response> {
      const req = new Request(`http://localhost${path}`, init);
      return await trackApp.fetch(req, env, mockExecCtx);
    }

    it('redirects to original URL with 302', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: null,
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.com/landing');
    });

    it('bypasses auth (no Authorization header needed)', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: null,
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001');
      // Should NOT be 401 — /t/ paths skip auth
      expect(res.status).not.toBe(401);
    });

    it('returns 404 for non-existent link', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(null);

      const res = await fetchTrack('/t/no-exist');
      expect(res.status).toBe(404);
    });

    it('returns 404 for inactive link', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue({ ...SAMPLE_LINK, is_active: 0 });

      const res = await fetchTrack('/t/link-001');
      expect(res.status).toBe(404);
    });

    it('resolves friendId from lu (lineUserId) query param', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-99' } as never);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: 'friend-99',
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001?lu=Uabc123');
      expect(res.status).toBe(302);
      expect(getFriendByLineUserId).toHaveBeenCalledWith(expect.anything(), 'Uabc123');
    });

    it('uses f (friendId) query param directly', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: 'friend-direct',
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001?f=friend-direct');
      expect(res.status).toBe(302);
      // Should NOT call getFriendByLineUserId when f is provided
      expect(getFriendByLineUserId).not.toHaveBeenCalled();
    });

    it('redirects LINE in-app browser to LIFF when no user info', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);

      const res = await fetchTrack('/t/link-001', {
        headers: { 'user-agent': 'Mozilla/5.0 Line/12.0.0' },
      });
      expect(res.status).toBe(302);
      const location = res.headers.get('location') ?? '';
      expect(location).toContain('liff.line.me');
      expect(location).toContain('redirect=');
    });

    it('does not redirect to LIFF when lu param is present', async () => {
      vi.mocked(getTrackedLinkById).mockResolvedValue(SAMPLE_LINK);
      vi.mocked(getFriendByLineUserId).mockResolvedValue({ id: 'friend-99' } as never);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: 'friend-99',
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001?lu=Uabc', {
        headers: { 'user-agent': 'Mozilla/5.0 Line/12.0.0' },
      });
      // Should redirect to original URL, not LIFF
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://example.com/landing');
    });

    it('returns HTML redirect for app-link domains (e.g. x.com)', async () => {
      const xLink: TrackedLink = {
        ...SAMPLE_LINK,
        original_url: 'https://x.com/user/status/123',
      };
      vi.mocked(getTrackedLinkById).mockResolvedValue(xLink);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: null,
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('<!DOCTYPE html>');
      expect(body).toContain('x.com/user/status/123');
    });

    it('skips LIFF redirect for app-link domains even in LINE browser', async () => {
      const igLink: TrackedLink = {
        ...SAMPLE_LINK,
        original_url: 'https://instagram.com/profile',
      };
      vi.mocked(getTrackedLinkById).mockResolvedValue(igLink);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: null,
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001', {
        headers: { 'user-agent': 'Mozilla/5.0 Line/12.0.0' },
      });
      // Should return HTML (app redirect), not LIFF redirect
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('instagram.com/profile');
    });

    it('runs tag and scenario actions via waitUntil for identified friend', async () => {
      const linkWithActions: TrackedLink = {
        ...SAMPLE_LINK,
        tag_id: 'tag-action',
        scenario_id: 'scen-action',
      };
      vi.mocked(getTrackedLinkById).mockResolvedValue(linkWithActions);
      vi.mocked(recordLinkClick).mockResolvedValue({
        id: 'click-new',
        tracked_link_id: 'link-001',
        friend_id: 'friend-direct',
        clicked_at: '2025-01-03T00:00:00+09:00',
      });

      const res = await fetchTrack('/t/link-001?f=friend-direct');
      expect(res.status).toBe(302);

      // Flush waitUntil promises
      await Promise.allSettled(waitUntilPromises);

      expect(recordLinkClick).toHaveBeenCalledWith(expect.anything(), 'link-001', 'friend-direct');
      expect(addTagToFriend).toHaveBeenCalledWith(expect.anything(), 'friend-direct', 'tag-action');
      expect(enrollFriendInScenario).toHaveBeenCalledWith(expect.anything(), 'friend-direct', 'scen-action');
    });
  });
});
