/**
 * Tests for images routes (upload, serve, delete).
 *
 * Covers:
 *   1. POST /api/images — JSON base64 upload (with/without data URI prefix)
 *   2. POST /api/images — binary upload
 *   3. POST /api/images — missing data field returns 400
 *   4. POST /api/images — file too large returns 400
 *   5. POST /api/images — unsupported MIME type returns 400
 *   6. POST /api/images — IMAGES binding missing returns 503
 *   7. POST /api/images — internal error returns 500
 *   8. GET /images/:key — serve image (public, no auth)
 *   9. GET /images/:key — image not found returns 404
 *  10. GET /images/:key — IMAGES binding missing returns 503
 *  11. DELETE /api/images/:key — delete image
 *  12. DELETE /api/images/:key — IMAGES binding missing returns 503
 *  13. DELETE /api/images/:key — internal error returns 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — stub DB functions needed by auth middleware
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
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
// Import app modules after mocks are set up
// ---------------------------------------------------------------------------

import { authMiddleware } from '../middleware/auth.js';
import { images } from '../routes/images.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';
// 1x1 red PNG in base64
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Build a minimal Hono app with auth middleware + image routes
// ---------------------------------------------------------------------------

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', images);
  return app;
}

// ---------------------------------------------------------------------------
// Mock D1Database binding
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

// ---------------------------------------------------------------------------
// Mock R2Bucket
// ---------------------------------------------------------------------------

function createMockR2Bucket() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async (): Promise<unknown> => null),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false })),
    head: vi.fn(async () => null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock env
// ---------------------------------------------------------------------------

function createMockEnv(overrides?: Partial<Env['Bindings']>): Env['Bindings'] {
  return {
    DB: createMockDb(),
    IMAGES: createMockR2Bucket() as unknown as R2Bucket,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: make authenticated request
// ---------------------------------------------------------------------------

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Images Routes', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  // =========================================================================
  // POST /api/images
  // =========================================================================

  describe('POST /api/images', () => {
    it('uploads image via JSON base64 and returns 201', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            data: TINY_PNG_BASE64,
            mimeType: 'image/png',
            filename: 'test.png',
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; key: string; url: string; mimeType: string; size: number };
      };
      expect(body.success).toBe(true);
      expect(body.data.key).toMatch(/\.png$/);
      expect(body.data.url).toContain('https://worker.example.com/images/');
      expect(body.data.mimeType).toBe('image/png');
      expect(body.data.size).toBeGreaterThan(0);

      const mockBucket = env.IMAGES as unknown as ReturnType<typeof createMockR2Bucket>;
      expect(mockBucket.put).toHaveBeenCalledTimes(1);
    });

    it('parses data URI prefix and extracts mimeType', async () => {
      const env = createMockEnv();
      const dataUri = `data:image/jpeg;base64,${TINY_PNG_BASE64}`;
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ data: dataUri }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        data: { mimeType: string; key: string };
      };
      expect(body.data.mimeType).toBe('image/jpeg');
      expect(body.data.key).toMatch(/\.jpg$/);
    });

    it('uploads binary image data', async () => {
      const env = createMockEnv();
      const binaryData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'image/png' }),
          body: binaryData,
        },
        env,
      );

      expect(res.status).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { mimeType: string } };
      expect(body.success).toBe(true);
      expect(body.data.mimeType).toBe('image/png');
    });

    it('returns 400 when data field is missing in JSON body', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ mimeType: 'image/png' }),
        },
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('data');
    });

    it('returns 400 when image exceeds 5MB', async () => {
      const env = createMockEnv();
      const bigData = new Uint8Array(6 * 1024 * 1024);
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'image/png' }),
          body: bigData,
        },
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('5MB');
    });

    it('returns 400 for unsupported MIME type', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'image/svg+xml' }),
          body: new Uint8Array([0, 1, 2]),
        },
        env,
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('Unsupported');
    });

    it('returns 503 when IMAGES binding is not configured', async () => {
      const env = createMockEnv({ IMAGES: undefined });
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            data: TINY_PNG_BASE64,
            mimeType: 'image/png',
          }),
        },
        env,
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('not configured');
    });

    it('returns 500 on internal error', async () => {
      const failBucket = createMockR2Bucket();
      failBucket.put.mockRejectedValueOnce(new Error('R2 write failure'));
      const env = createMockEnv({ IMAGES: failBucket as unknown as R2Bucket });

      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            data: TINY_PNG_BASE64,
            mimeType: 'image/png',
          }),
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('requires authentication (returns 401 without Bearer token)', async () => {
      const env = createMockEnv();
      const res = await app.request(
        '/api/images',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: TINY_PNG_BASE64, mimeType: 'image/png' }),
        },
        env,
      );

      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /images/:key — public image serving
  // =========================================================================

  describe('GET /images/:key', () => {
    it('serves image with correct headers (public, no auth)', async () => {
      const mockBody = new ReadableStream();
      const mockObject = {
        body: mockBody,
        httpMetadata: { contentType: 'image/jpeg' },
        etag: '"abc123"',
      };
      const bucket = createMockR2Bucket();
      bucket.get.mockResolvedValueOnce(mockObject);
      const env = createMockEnv({ IMAGES: bucket as unknown as R2Bucket });

      // No auth header — GET /images/:key is public
      const res = await app.request('/images/test-id.jpg', { method: 'GET' }, env);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/jpeg');
      expect(res.headers.get('Cache-Control')).toContain('public');
      expect(res.headers.get('Cache-Control')).toContain('max-age=31536000');
      expect(res.headers.get('ETag')).toBe('"abc123"');
    });

    it('returns 404 when image is not found', async () => {
      const bucket = createMockR2Bucket();
      bucket.get.mockResolvedValueOnce(null);
      const env = createMockEnv({ IMAGES: bucket as unknown as R2Bucket });

      const res = await app.request('/images/nonexistent.png', { method: 'GET' }, env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('returns 503 when IMAGES binding is not configured', async () => {
      const env = createMockEnv({ IMAGES: undefined });

      const res = await app.request('/images/test.png', { method: 'GET' }, env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain('not configured');
    });

    it('falls back to image/png when httpMetadata has no contentType', async () => {
      const mockObject = {
        body: new ReadableStream(),
        httpMetadata: {},
        etag: '"fallback"',
      };
      const bucket = createMockR2Bucket();
      bucket.get.mockResolvedValueOnce(mockObject);
      const env = createMockEnv({ IMAGES: bucket as unknown as R2Bucket });

      const res = await app.request('/images/no-meta.png', { method: 'GET' }, env);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/png');
    });
  });

  // =========================================================================
  // DELETE /api/images/:key
  // =========================================================================

  describe('DELETE /api/images/:key', () => {
    it('deletes image and returns success', async () => {
      const bucket = createMockR2Bucket();
      const env = createMockEnv({ IMAGES: bucket as unknown as R2Bucket });

      const res = await app.request(
        '/api/images/test-id.png',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
      expect(bucket.delete).toHaveBeenCalledWith('test-id.png');
    });

    it('returns 503 when IMAGES binding is not configured', async () => {
      const env = createMockEnv({ IMAGES: undefined });

      const res = await app.request(
        '/api/images/test-id.png',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('returns 500 on internal error', async () => {
      const bucket = createMockR2Bucket();
      bucket.delete.mockRejectedValueOnce(new Error('R2 delete failure'));
      const env = createMockEnv({ IMAGES: bucket as unknown as R2Bucket });

      const res = await app.request(
        '/api/images/fail.png',
        {
          method: 'DELETE',
          headers: authHeaders(),
        },
        env,
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('requires authentication (returns 401 without Bearer token)', async () => {
      const env = createMockEnv();

      const res = await app.request(
        '/api/images/test-id.png',
        { method: 'DELETE' },
        env,
      );

      expect(res.status).toBe(401);
    });
  });
});
