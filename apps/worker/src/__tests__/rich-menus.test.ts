/**
 * Tests for rich-menus routes (/api/rich-menus/*).
 *
 * Covers:
 *   1.  Authentication — 401 without valid Bearer token
 *   2.  GET  /api/rich-menus — list all rich menus (success / LINE API error)
 *   3.  POST /api/rich-menus — create rich menu (success / LINE API error)
 *   4.  DELETE /api/rich-menus/:id — delete rich menu (success / error)
 *   5.  POST /api/rich-menus/:id/default — set default rich menu (success / error)
 *   6.  POST /api/friends/:friendId/rich-menu — link rich menu to friend
 *        (success / missing richMenuId / friend not found / LINE API error)
 *   7.  DELETE /api/friends/:friendId/rich-menu — unlink rich menu from friend
 *        (success / friend not found / LINE API error)
 *   8.  POST /api/rich-menus/setup-naturism — setup naturism rich menu (success / error)
 *   9.  GET  /api/rich-menus/image-guide — returns HTML (public, no auth)
 *  10.  POST /api/rich-menus/:id/image — upload rich menu image
 *        (JSON base64 / raw binary / missing image / unsupported content-type)
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
    getFriendById: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
  };
});

// ---------------------------------------------------------------------------
// Mock @line-crm/line-sdk — capture constructor calls and method invocations
// ---------------------------------------------------------------------------

const mockGetRichMenuList = vi.fn();
const mockCreateRichMenu = vi.fn();
const mockDeleteRichMenu = vi.fn();
const mockSetDefaultRichMenu = vi.fn();
const mockLinkRichMenuToUser = vi.fn();
const mockUnlinkRichMenuFromUser = vi.fn();
const mockUploadRichMenuImage = vi.fn();
const mockDeleteDefaultRichMenu = vi.fn();
const mockGetRichMenuAliasList = vi.fn();
const mockCreateRichMenuAlias = vi.fn();
const mockUpdateRichMenuAlias = vi.fn();
const mockDeleteRichMenuAlias = vi.fn();

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    getRichMenuList = mockGetRichMenuList;
    createRichMenu = mockCreateRichMenu;
    deleteRichMenu = mockDeleteRichMenu;
    setDefaultRichMenu = mockSetDefaultRichMenu;
    deleteDefaultRichMenu = mockDeleteDefaultRichMenu;
    linkRichMenuToUser = mockLinkRichMenuToUser;
    unlinkRichMenuFromUser = mockUnlinkRichMenuFromUser;
    uploadRichMenuImage = mockUploadRichMenuImage;
    getRichMenuAliasList = mockGetRichMenuAliasList;
    createRichMenuAlias = mockCreateRichMenuAlias;
    updateRichMenuAlias = mockUpdateRichMenuAlias;
    deleteRichMenuAlias = mockDeleteRichMenuAlias;
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
import { richMenus } from '../routes/rich-menus.js';
import type { Env } from '../index.js';
import { getFriendById } from '@line-crm/db';

const mockGetFriendById = getFriendById as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', richMenus);
  return app;
}

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

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Rich Menus Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Auth check
  // =========================================================================

  it('returns 401 without Authorization header', async () => {
    const res = await app.request('/api/rich-menus', {}, env);
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // GET /api/rich-menus
  // =========================================================================

  describe('GET /api/rich-menus', () => {
    it('returns a list of rich menus', async () => {
      const menus = [{ richMenuId: 'rm-1', name: 'Menu 1' }];
      mockGetRichMenuList.mockResolvedValue({ richmenus: menus });

      const res = await app.request('/api/rich-menus', { headers: authHeaders() }, env);
      const json = (await res.json()) as { success: boolean; data: unknown[] };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toEqual(menus);
    });

    it('returns empty array when richmenus is undefined', async () => {
      mockGetRichMenuList.mockResolvedValue({});

      const res = await app.request('/api/rich-menus', { headers: authHeaders() }, env);
      const json = (await res.json()) as { success: boolean; data: unknown[] };

      expect(res.status).toBe(200);
      expect(json.data).toEqual([]);
    });

    it('returns 500 when LINE API fails', async () => {
      mockGetRichMenuList.mockRejectedValue(new Error('LINE API error'));

      const res = await app.request('/api/rich-menus', { headers: authHeaders() }, env);
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to fetch rich menus');
    });
  });

  // =========================================================================
  // POST /api/rich-menus
  // =========================================================================

  describe('POST /api/rich-menus', () => {
    it('creates a rich menu and returns 201', async () => {
      const createBody = { size: { width: 2500, height: 843 }, name: 'Test Menu', areas: [] };
      mockCreateRichMenu.mockResolvedValue({ richMenuId: 'rm-new' });

      const res = await app.request(
        '/api/rich-menus',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: { richMenuId: string } };

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.richMenuId).toBe('rm-new');
      expect(mockCreateRichMenu).toHaveBeenCalledWith(createBody);
    });

    it('returns 500 on LINE API error', async () => {
      mockCreateRichMenu.mockRejectedValue(new Error('create failed'));

      const res = await app.request(
        '/api/rich-menus',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'fail' }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to create rich menu');
    });
  });

  // =========================================================================
  // DELETE /api/rich-menus/:id
  // =========================================================================

  describe('DELETE /api/rich-menus/:id', () => {
    it('deletes a rich menu', async () => {
      mockDeleteRichMenu.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/rich-menus/rm-delete',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: null };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockDeleteRichMenu).toHaveBeenCalledWith('rm-delete');
    });

    it('returns 500 on error', async () => {
      mockDeleteRichMenu.mockRejectedValue(new Error('delete failed'));

      const res = await app.request(
        '/api/rich-menus/rm-fail',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to delete rich menu');
    });
  });

  // =========================================================================
  // POST /api/rich-menus/:id/default
  // =========================================================================

  describe('POST /api/rich-menus/:id/default', () => {
    it('sets default rich menu', async () => {
      mockSetDefaultRichMenu.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/rich-menus/rm-default/default',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: null };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockSetDefaultRichMenu).toHaveBeenCalledWith('rm-default');
    });

    it('returns 500 on error', async () => {
      mockSetDefaultRichMenu.mockRejectedValue(new Error('default failed'));

      const res = await app.request(
        '/api/rich-menus/rm-fail/default',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // POST /api/friends/:friendId/rich-menu
  // =========================================================================

  describe('POST /api/friends/:friendId/rich-menu', () => {
    it('links rich menu to a friend', async () => {
      mockGetFriendById.mockResolvedValue({ id: 'f-1', line_user_id: 'U1234' });
      mockLinkRichMenuToUser.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/friends/f-1/rich-menu',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId: 'rm-link' }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: null };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockLinkRichMenuToUser).toHaveBeenCalledWith('U1234', 'rm-link');
    });

    it('returns 400 when richMenuId is missing', async () => {
      const res = await app.request(
        '/api/friends/f-1/rich-menu',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(400);
      expect(json.error).toBe('richMenuId is required');
    });

    it('returns 404 when friend not found', async () => {
      mockGetFriendById.mockResolvedValue(null);

      const res = await app.request(
        '/api/friends/f-missing/rich-menu',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId: 'rm-link' }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(404);
      expect(json.error).toBe('Friend not found');
    });

    it('returns 500 on LINE API error', async () => {
      mockGetFriendById.mockResolvedValue({ id: 'f-1', line_user_id: 'U1234' });
      mockLinkRichMenuToUser.mockRejectedValue(new Error('link failed'));

      const res = await app.request(
        '/api/friends/f-1/rich-menu',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId: 'rm-link' }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // DELETE /api/friends/:friendId/rich-menu
  // =========================================================================

  describe('DELETE /api/friends/:friendId/rich-menu', () => {
    it('unlinks rich menu from a friend', async () => {
      mockGetFriendById.mockResolvedValue({ id: 'f-1', line_user_id: 'U1234' });
      mockUnlinkRichMenuFromUser.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/friends/f-1/rich-menu',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: null };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockUnlinkRichMenuFromUser).toHaveBeenCalledWith('U1234');
    });

    it('returns 404 when friend not found', async () => {
      mockGetFriendById.mockResolvedValue(null);

      const res = await app.request(
        '/api/friends/f-missing/rich-menu',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(404);
      expect(json.error).toBe('Friend not found');
    });

    it('returns 500 on LINE API error', async () => {
      mockGetFriendById.mockResolvedValue({ id: 'f-1', line_user_id: 'U1234' });
      mockUnlinkRichMenuFromUser.mockRejectedValue(new Error('unlink failed'));

      const res = await app.request(
        '/api/friends/f-1/rich-menu',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // POST /api/rich-menus/setup-naturism
  // =========================================================================

  describe('POST /api/rich-menus/setup-naturism', () => {
    it('creates 8-button menu v3, uploads image, and sets default — returns 201', async () => {
      mockDeleteDefaultRichMenu.mockResolvedValue(undefined);
      mockCreateRichMenu.mockResolvedValue({ richMenuId: 'rm-naturism' });
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      mockSetDefaultRichMenu.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/rich-menus/setup-naturism',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: { richMenuId: string; areas: Array<{ label: string; type: string }>; message: string } };

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.richMenuId).toBe('rm-naturism');
      expect(json.data.message).toContain('リッチメニュー');
      // v3: 8 areas (uri + message types, no postback)
      expect(json.data.areas).toHaveLength(8);
      expect(mockCreateRichMenu).toHaveBeenCalledTimes(1);
      const menuBody = mockCreateRichMenu.mock.calls[0][0];
      expect(menuBody.size).toEqual({ width: 2500, height: 1686 });
      expect(menuBody.areas).toHaveLength(8);
      // Verify area labels include key buttons
      const labels = menuBody.areas.map((a: { action: { label: string } }) => a.action.label);
      expect(labels).toContain('ホームページ');
      expect(labels).toContain('Q&A お問い合わせ');
      expect(mockUploadRichMenuImage).toHaveBeenCalledTimes(1);
      expect(mockSetDefaultRichMenu).toHaveBeenCalledWith('rm-naturism');
    });

    it('succeeds even if deleteDefaultRichMenu fails (no existing default)', async () => {
      mockDeleteDefaultRichMenu.mockRejectedValue(new Error('no default'));
      mockCreateRichMenu.mockResolvedValue({ richMenuId: 'rm-naturism-2' });
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      mockSetDefaultRichMenu.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/rich-menus/setup-naturism',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: { richMenuId: string } };

      expect(res.status).toBe(201);
      expect(json.success).toBe(true);
      expect(json.data.richMenuId).toBe('rm-naturism-2');
    });

    it('returns 500 if createRichMenu fails', async () => {
      mockCreateRichMenu.mockRejectedValue(new Error('create failed'));

      const res = await app.request(
        '/api/rich-menus/setup-naturism',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to setup naturism rich menu');
    });

    it('returns 500 if image upload fails', async () => {
      mockCreateRichMenu.mockResolvedValue({ richMenuId: 'rm-naturism' });
      mockUploadRichMenuImage.mockRejectedValue(new Error('upload failed'));

      const res = await app.request(
        '/api/rich-menus/setup-naturism',
        { method: 'POST', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
    });
  });

  // =========================================================================
  // GET /api/rich-menus/image-guide (public — no auth)
  // =========================================================================

  describe('GET /api/rich-menus/image-guide', () => {
    it('returns HTML without authentication', async () => {
      const res = await app.request('/api/rich-menus/image-guide', {}, env);

      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('ホームページ');
    });
  });

  // =========================================================================
  // POST /api/rich-menus/:id/image
  // =========================================================================

  describe('POST /api/rich-menus/:id/image', () => {
    it('uploads image via JSON base64 body', async () => {
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      const base64Image = btoa('fake-png-data');

      const res = await app.request(
        '/api/rich-menus/rm-img/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: null };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockUploadRichMenuImage).toHaveBeenCalledTimes(1);
      // First arg is richMenuId, second is ArrayBuffer, third is content type
      expect(mockUploadRichMenuImage.mock.calls[0][0]).toBe('rm-img');
      expect(mockUploadRichMenuImage.mock.calls[0][2]).toBe('image/png');
    });

    it('uploads image via JSON base64 body with data URI prefix', async () => {
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      const base64Image = `data:image/png;base64,${btoa('fake-png-data')}`;

      const res = await app.request(
        '/api/rich-menus/rm-img2/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
    });

    it('uploads image via JSON base64 body with jpeg contentType', async () => {
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      const base64Image = btoa('fake-jpeg-data');

      const res = await app.request(
        '/api/rich-menus/rm-jpg/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image, contentType: 'image/jpeg' }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockUploadRichMenuImage.mock.calls[0][2]).toBe('image/jpeg');
    });

    it('returns 400 when image field is missing in JSON', async () => {
      const res = await app.request(
        '/api/rich-menus/rm-img/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(400);
      expect(json.error).toContain('image (base64) is required');
    });

    it('uploads raw binary PNG image', async () => {
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

      const res = await app.request(
        '/api/rich-menus/rm-raw/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'image/png' },
          body: binaryData,
        },
        env,
      );
      const json = (await res.json()) as { success: boolean };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockUploadRichMenuImage.mock.calls[0][2]).toBe('image/png');
    });

    it('uploads raw binary JPEG image', async () => {
      mockUploadRichMenuImage.mockResolvedValue(undefined);
      const binaryData = new Uint8Array([0xff, 0xd8, 0xff]).buffer;

      const res = await app.request(
        '/api/rich-menus/rm-raw-jpg/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'image/jpeg' },
          body: binaryData,
        },
        env,
      );
      const json = (await res.json()) as { success: boolean };

      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(mockUploadRichMenuImage.mock.calls[0][2]).toBe('image/jpeg');
    });

    it('returns 400 for unsupported content-type', async () => {
      const res = await app.request(
        '/api/rich-menus/rm-img/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
          body: 'not-an-image',
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(400);
      expect(json.error).toContain('Content-Type must be');
    });

    it('returns 500 on LINE API error', async () => {
      mockUploadRichMenuImage.mockRejectedValue(new Error('upload error'));
      const base64Image = btoa('fake-data');

      const res = await app.request(
        '/api/rich-menus/rm-err/image',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Image }),
        },
        env,
      );
      const json = (await res.json()) as { success: boolean; error: string };

      expect(res.status).toBe(500);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Failed to upload rich menu image');
    });
  });

  // ------------------------------------------------------------------
  // Rich menu alias endpoints
  // ------------------------------------------------------------------

  describe('GET /api/rich-menus/aliases', () => {
    it('returns list of aliases', async () => {
      mockGetRichMenuAliasList.mockResolvedValueOnce({
        aliases: [
          { richMenuAliasId: 'alias-a', richMenuId: 'rm-1' },
          { richMenuAliasId: 'alias-b', richMenuId: 'rm-2' },
        ],
      });
      const res = await app.request(
        '/api/rich-menus/aliases',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
    });

    it('returns 500 on LINE API error', async () => {
      mockGetRichMenuAliasList.mockRejectedValueOnce(new Error('alias list failed'));
      const res = await app.request(
        '/api/rich-menus/aliases',
        { method: 'GET', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/rich-menus/aliases', () => {
    it('creates alias successfully', async () => {
      mockCreateRichMenuAlias.mockResolvedValueOnce(undefined);
      const res = await app.request(
        '/api/rich-menus/aliases',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ aliasId: 'alias-1', richMenuId: 'rm-1' }),
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(mockCreateRichMenuAlias).toHaveBeenCalledWith('alias-1', 'rm-1');
    });

    it('returns 400 when aliasId missing', async () => {
      const res = await app.request(
        '/api/rich-menus/aliases',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId: 'rm-1' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/rich-menus/aliases/:aliasId', () => {
    it('updates alias to point at new richMenuId', async () => {
      mockUpdateRichMenuAlias.mockResolvedValueOnce(undefined);
      const res = await app.request(
        '/api/rich-menus/aliases/alias-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId: 'rm-2' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockUpdateRichMenuAlias).toHaveBeenCalledWith('alias-1', 'rm-2');
    });

    it('returns 400 when richMenuId missing', async () => {
      const res = await app.request(
        '/api/rich-menus/aliases/alias-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/rich-menus/aliases/:aliasId', () => {
    it('deletes alias successfully', async () => {
      mockDeleteRichMenuAlias.mockResolvedValueOnce(undefined);
      const res = await app.request(
        '/api/rich-menus/aliases/alias-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);
      expect(mockDeleteRichMenuAlias).toHaveBeenCalledWith('alias-1');
    });
  });
});
