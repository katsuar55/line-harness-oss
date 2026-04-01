/**
 * Tests for openapi routes.
 *
 * Covers:
 *   1. GET /openapi.json — returns valid OpenAPI 3.1.0 spec
 *   2. GET /openapi.json — spec contains required sections
 *   3. GET /docs — returns Swagger UI HTML page
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db (prevent import errors from other routes)
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
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

import { openapi } from '../routes/openapi.js';
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
  app.route('/', openapi);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAPI Routes', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  describe('GET /openapi.json', () => {
    it('returns 200 with valid JSON', async () => {
      const res = await app.request('/openapi.json', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.openapi).toBe('3.1.0');
    });

    it('contains info section with title and version', async () => {
      const res = await app.request('/openapi.json', {}, env);
      const body = (await res.json()) as { info: { title: string; version: string } };
      expect(body.info.title).toBe('LINE OSS CRM API');
      expect(body.info.version).toBeTruthy();
    });

    it('contains paths section with documented endpoints', async () => {
      const res = await app.request('/openapi.json', {}, env);
      const body = (await res.json()) as { paths: Record<string, unknown> };
      expect(body.paths).toBeDefined();
      expect(body.paths['/api/friends']).toBeDefined();
      expect(body.paths['/webhook']).toBeDefined();
    });

    it('contains security scheme for bearer auth', async () => {
      const res = await app.request('/openapi.json', {}, env);
      const body = (await res.json()) as {
        components: { securitySchemes: { bearerAuth: { type: string; scheme: string } } };
      };
      expect(body.components.securitySchemes.bearerAuth.type).toBe('http');
      expect(body.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    });

    it('contains schema definitions', async () => {
      const res = await app.request('/openapi.json', {}, env);
      const body = (await res.json()) as {
        components: { schemas: Record<string, unknown> };
      };
      expect(body.components.schemas.Friend).toBeDefined();
      expect(body.components.schemas.Tag).toBeDefined();
      expect(body.components.schemas.Scenario).toBeDefined();
      expect(body.components.schemas.Broadcast).toBeDefined();
    });

    it('contains tags array', async () => {
      const res = await app.request('/openapi.json', {}, env);
      const body = (await res.json()) as { tags: Array<{ name: string }> };
      expect(Array.isArray(body.tags)).toBe(true);
      const tagNames = body.tags.map((t) => t.name);
      expect(tagNames).toContain('Friends');
      expect(tagNames).toContain('Webhook');
    });
  });

  describe('GET /docs', () => {
    it('returns HTML with Swagger UI', async () => {
      const res = await app.request('/docs', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('swagger-ui');
      expect(html).toContain('SwaggerUIBundle');
    });

    it('references /openapi.json in the Swagger config', async () => {
      const res = await app.request('/docs', {}, env);
      const html = await res.text();
      expect(html).toContain('/openapi.json');
    });

    it('has proper HTML structure', async () => {
      const res = await app.request('/docs', {}, env);
      const html = await res.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>');
    });
  });
});
