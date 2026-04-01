/**
 * Tests for webhooks routes (incoming & outgoing webhook management).
 *
 * Covers:
 *   1. GET /api/webhooks/incoming — list incoming webhooks
 *   2. POST /api/webhooks/incoming — create (validation)
 *   3. PUT /api/webhooks/incoming/:id — update, 404
 *   4. DELETE /api/webhooks/incoming/:id — delete
 *   5. GET /api/webhooks/outgoing — list outgoing webhooks
 *   6. POST /api/webhooks/outgoing — create (validation)
 *   7. PUT /api/webhooks/outgoing/:id — update, 404
 *   8. DELETE /api/webhooks/outgoing/:id — delete
 *   9. POST /api/webhooks/incoming/:id/receive — receive external webhook (fires event bus)
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
    getIncomingWebhooks: vi.fn(async () => [
      {
        id: 'iw-1',
        name: 'Shopify',
        source_type: 'shopify',
        secret: 'sec123',
        is_active: 1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ]),
    getIncomingWebhookById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'iw-1') {
        return {
          id: 'iw-1',
          name: 'Shopify Updated',
          source_type: 'shopify',
          secret: 'sec123',
          is_active: 1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
        };
      }
      return null;
    }),
    createIncomingWebhook: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'iw-new',
      name: data.name,
      source_type: data.sourceType ?? 'generic',
      is_active: 1,
      created_at: '2025-01-01T00:00:00Z',
    })),
    updateIncomingWebhook: vi.fn(async () => undefined),
    deleteIncomingWebhook: vi.fn(async () => undefined),
    getOutgoingWebhooks: vi.fn(async () => [
      {
        id: 'ow-1',
        name: 'CRM Sync',
        url: 'https://crm.example.com/hook',
        event_types: JSON.stringify(['friend_add', 'message_received']),
        secret: 'owsec',
        is_active: 1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
    ]),
    getOutgoingWebhookById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'ow-1') {
        return {
          id: 'ow-1',
          name: 'CRM Sync Updated',
          url: 'https://crm.example.com/hook',
          event_types: JSON.stringify(['friend_add']),
          is_active: 1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-02T00:00:00Z',
        };
      }
      return null;
    }),
    createOutgoingWebhook: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'ow-new',
      name: data.name,
      url: data.url,
      event_types: JSON.stringify(data.eventTypes ?? []),
      is_active: 1,
      created_at: '2025-01-01T00:00:00Z',
    })),
    updateOutgoingWebhook: vi.fn(async () => undefined),
    deleteOutgoingWebhook: vi.fn(async () => undefined),
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

// Mock event-bus (used by incoming receive endpoint)
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(async () => undefined),
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

import { webhooks } from '../routes/webhooks.js';
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
  app.route('/', webhooks);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Webhooks Routes', () => {
  let app: ReturnType<typeof createApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Incoming Webhooks
  // =========================================================================

  describe('Incoming Webhooks', () => {
    describe('GET /api/webhooks/incoming', () => {
      it('returns list of incoming webhooks', async () => {
        const res = await app.request('/api/webhooks/incoming', {}, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; data: Array<{ name: string; isActive: boolean }> };
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].name).toBe('Shopify');
        expect(body.data[0].isActive).toBe(true);
      });
    });

    describe('POST /api/webhooks/incoming', () => {
      it('returns 400 when name is missing', async () => {
        const res = await app.request('/api/webhooks/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }, env);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body.error).toBe('name is required');
      });

      it('creates incoming webhook', async () => {
        const res = await app.request('/api/webhooks/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Stripe', sourceType: 'stripe' }),
        }, env);
        expect(res.status).toBe(201);
        const body = (await res.json()) as { success: boolean; data: { id: string; name: string } };
        expect(body.success).toBe(true);
        expect(body.data.name).toBe('Stripe');
      });
    });

    describe('PUT /api/webhooks/incoming/:id', () => {
      it('updates and returns the webhook', async () => {
        const res = await app.request('/api/webhooks/incoming/iw-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Shopify Updated' }),
        }, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; data: { name: string } };
        expect(body.success).toBe(true);
        expect(body.data.name).toBe('Shopify Updated');
      });

      it('returns 404 when webhook not found', async () => {
        const { getIncomingWebhookById } = await import('@line-crm/db');
        (getIncomingWebhookById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

        const res = await app.request('/api/webhooks/incoming/nonexistent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        }, env);
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/webhooks/incoming/:id', () => {
      it('deletes and returns success', async () => {
        const res = await app.request('/api/webhooks/incoming/iw-1', { method: 'DELETE' }, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; data: null };
        expect(body.success).toBe(true);
        expect(body.data).toBeNull();
      });
    });
  });

  // =========================================================================
  // Outgoing Webhooks
  // =========================================================================

  describe('Outgoing Webhooks', () => {
    describe('GET /api/webhooks/outgoing', () => {
      it('returns list of outgoing webhooks with parsed event types', async () => {
        const res = await app.request('/api/webhooks/outgoing', {}, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          success: boolean;
          data: Array<{ name: string; eventTypes: string[]; isActive: boolean }>;
        };
        expect(body.success).toBe(true);
        expect(body.data).toHaveLength(1);
        expect(body.data[0].eventTypes).toEqual(['friend_add', 'message_received']);
      });
    });

    describe('POST /api/webhooks/outgoing', () => {
      it('returns 400 when name or url is missing', async () => {
        const res = await app.request('/api/webhooks/outgoing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test' }),
        }, env);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { success: boolean; error: string };
        expect(body.error).toBe('name and url are required');
      });

      it('creates outgoing webhook', async () => {
        const res = await app.request('/api/webhooks/outgoing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Analytics',
            url: 'https://analytics.example.com/hook',
            eventTypes: ['friend_add'],
          }),
        }, env);
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          success: boolean;
          data: { id: string; name: string; eventTypes: string[] };
        };
        expect(body.success).toBe(true);
        expect(body.data.name).toBe('Analytics');
      });
    });

    describe('PUT /api/webhooks/outgoing/:id', () => {
      it('updates and returns the webhook', async () => {
        const res = await app.request('/api/webhooks/outgoing/ow-1', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'CRM Sync Updated' }),
        }, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; data: { name: string } };
        expect(body.success).toBe(true);
      });

      it('returns 404 when webhook not found', async () => {
        const { getOutgoingWebhookById } = await import('@line-crm/db');
        (getOutgoingWebhookById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

        const res = await app.request('/api/webhooks/outgoing/nonexistent', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'X' }),
        }, env);
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /api/webhooks/outgoing/:id', () => {
      it('deletes and returns success', async () => {
        const res = await app.request('/api/webhooks/outgoing/ow-1', { method: 'DELETE' }, env);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { success: boolean; data: null };
        expect(body.success).toBe(true);
        expect(body.data).toBeNull();
      });
    });
  });

  // =========================================================================
  // Incoming Webhook Receive Endpoint
  // =========================================================================

  describe('POST /api/webhooks/incoming/:id/receive', () => {
    it('returns 404 when webhook not found', async () => {
      const { getIncomingWebhookById } = await import('@line-crm/db');
      (getIncomingWebhookById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const res = await app.request('/api/webhooks/incoming/nonexistent/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'order_created' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('returns 404 when webhook is inactive', async () => {
      const { getIncomingWebhookById } = await import('@line-crm/db');
      (getIncomingWebhookById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'iw-inactive',
        name: 'Inactive',
        source_type: 'generic',
        is_active: 0,
      });

      const res = await app.request('/api/webhooks/incoming/iw-inactive/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'test' }),
      }, env);
      expect(res.status).toBe(404);
    });

    it('receives webhook and fires event bus', async () => {
      const res = await app.request('/api/webhooks/incoming/iw-1/receive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: 'order-123' }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: { received: boolean; source: string } };
      expect(body.success).toBe(true);
      expect(body.data.received).toBe(true);
      expect(body.data.source).toBe('shopify');

      const { fireEvent } = await import('../services/event-bus.js');
      expect(fireEvent).toHaveBeenCalledWith(
        expect.anything(),
        'incoming_webhook.shopify',
        expect.objectContaining({
          eventData: expect.objectContaining({ webhookId: 'iw-1', source: 'shopify' }),
        }),
      );
    });
  });
});
