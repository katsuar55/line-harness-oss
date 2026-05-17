/**
 * Tests for email-admin routes (Round 4 PR-7).
 *
 * Covers:
 *   - GET    /api/admin/email/kpi             — from/to validation, totals + byCategory + subscribers snapshot
 *   - GET    /api/admin/email/subscribers     — status filter passthrough
 *   - POST   /api/admin/email/subscribers     — email validation + upsert dispatch
 *   - PATCH  /api/admin/email/subscribers/:id — isActive validation + correct helper dispatch
 *   - GET    /api/admin/email/templates       — listEmailTemplates passthrough
 *   - PUT    /api/admin/email/templates       — validation + upsert dispatch (with/without id)
 *   - DELETE /api/admin/email/templates/:id   — deleteEmailTemplate dispatch
 *   - GET    /api/admin/email/messages        — status / date filters + camelCase mapping
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
    upsertEmailSubscriber: vi.fn(),
    unsubscribeById: vi.fn(),
    resubscribeById: vi.fn(),
    listEmailTemplates: vi.fn(),
    upsertEmailTemplate: vi.fn(),
    deleteEmailTemplate: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
  };
});

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
import { emailAdmin } from '../routes/email-admin.js';
import type { Env } from '../index.js';
import {
  upsertEmailSubscriber,
  unsubscribeById,
  resubscribeById,
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
} from '@line-crm/db';

const mockUpsertEmailSubscriber = upsertEmailSubscriber as ReturnType<typeof vi.fn>;
const mockUnsubscribeById = unsubscribeById as ReturnType<typeof vi.fn>;
const mockResubscribeById = resubscribeById as ReturnType<typeof vi.fn>;
const mockListEmailTemplates = listEmailTemplates as ReturnType<typeof vi.fn>;
const mockUpsertEmailTemplate = upsertEmailTemplate as ReturnType<typeof vi.fn>;
const mockDeleteEmailTemplate = deleteEmailTemplate as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', emailAdmin);
  return app;
}

interface MockDbOptions {
  /** kpi totals row */
  totalsRow?: {
    sent: number | null;
    delivered: number | null;
    opened: number | null;
    clicked: number | null;
    bounced: number | null;
    complained: number | null;
  } | null;
  /** kpi unsubscribed row */
  unsubscribedRow?: { n: number } | null;
  /** kpi byCategory rows */
  byCategoryRows?: Array<{
    category: string;
    sent: number | null;
    delivered: number | null;
    opened: number | null;
    clicked: number | null;
  }>;
  /** kpi subscribers snapshot row */
  subscribersRow?: {
    total: number | null;
    active: number | null;
    inactive: number | null;
    transactional_only: number | null;
  } | null;
  /** subscribers list rows */
  subscribersListRows?: unknown[];
  /** messages list rows */
  messagesListRows?: unknown[];
}

function createMockDb(opts: MockDbOptions = {}): D1Database {
  function pickFirst(sql: string): unknown | null {
    if (sql.includes('SUM(CASE WHEN sent_at IS NOT NULL')) {
      return opts.totalsRow ?? null;
    }
    if (sql.includes('FROM email_subscribers') && sql.includes('unsubscribed_at IS NOT NULL')) {
      return opts.unsubscribedRow ?? null;
    }
    if (sql.includes('SUM(CASE WHEN is_active = 1 AND transactional_only = 0')) {
      return opts.subscribersRow ?? null;
    }
    return null;
  }
  function pickAll(sql: string): { results: unknown[]; success: true } {
    if (sql.includes('GROUP BY category')) {
      return { results: opts.byCategoryRows ?? [], success: true };
    }
    if (sql.includes('FROM email_subscribers') && sql.includes('ORDER BY created_at DESC')) {
      return { results: opts.subscribersListRows ?? [], success: true };
    }
    if (sql.includes('LEFT JOIN email_subscribers')) {
      return { results: opts.messagesListRows ?? [], success: true };
    }
    return { results: [], success: true };
  }

  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => pickFirst(sql)),
        all: vi.fn(async () => pickAll(sql)),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => pickFirst(sql)),
      all: vi.fn(async () => pickAll(sql)),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env['Bindings'] {
  return {
    DB: db,
    LINE_CHANNEL_SECRET: '',
    LINE_CHANNEL_ACCESS_TOKEN: '',
    API_KEY: TEST_API_KEY,
    ANTHROPIC_API_KEY: '',
    LIFF_URL: '',
    LINE_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_SECRET: '',
    WORKER_URL: '',
    AI: {} as never,
    IMAGES: {} as never,
  } as unknown as Env['Bindings'];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/admin/email/kpi
// ---------------------------------------------------------------------------

describe('GET /api/admin/email/kpi', () => {
  it('400 when from/to missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/kpi',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 when date format invalid', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/kpi?from=bad&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 when from > to', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/kpi?from=2026-02-01&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200 returns totals + byCategory + subscribers snapshot', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        totalsRow: {
          sent: 100,
          delivered: 95,
          opened: 60,
          clicked: 25,
          bounced: 3,
          complained: 1,
        },
        unsubscribedRow: { n: 4 },
        byCategoryRows: [
          { category: 'marketing', sent: 70, delivered: 67, opened: 40, clicked: 15 },
          { category: 'transactional', sent: 30, delivered: 28, opened: 20, clicked: 10 },
        ],
        subscribersRow: {
          total: 500,
          active: 420,
          inactive: 30,
          transactional_only: 50,
        },
      }),
    );

    const res = await app.request(
      '/api/admin/email/kpi?from=2026-01-01&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        totals: Record<string, number | string>;
        byCategory: Array<Record<string, number | string>>;
        subscribers: Record<string, number>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.totals).toEqual({
      sent: 100,
      delivered: 95,
      opened: 60,
      clicked: 25,
      bounced: 3,
      complained: 1,
      unsubscribed: 4,
      fromDate: '2026-01-01',
      toDate: '2026-01-31',
    });
    expect(body.data.byCategory.length).toBe(2);
    expect(body.data.byCategory[0]).toEqual({
      category: 'marketing',
      sent: 70,
      delivered: 67,
      opened: 40,
      clicked: 15,
    });
    expect(body.data.subscribers).toEqual({
      total: 500,
      active: 420,
      inactive: 30,
      transactionalOnly: 50,
    });
  });

  it('401 when unauthenticated', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/kpi?from=2026-01-01&to=2026-01-31',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/email/subscribers
// ---------------------------------------------------------------------------

describe('GET /api/admin/email/subscribers', () => {
  it('200 returns list (default status=all)', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        subscribersListRows: [
          { id: 's1', email: 'a@example.com', is_active: 1, transactional_only: 0 },
          { id: 's2', email: 'b@example.com', is_active: 0, transactional_only: 0 },
        ],
      }),
    );
    const res = await app.request(
      '/api/admin/email/subscribers',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { subscribers: Array<{ id: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.subscribers.length).toBe(2);
  });

  it('200 with status=active filter', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        subscribersListRows: [
          { id: 's1', email: 'a@example.com', is_active: 1, transactional_only: 0 },
        ],
      }),
    );
    const res = await app.request(
      '/api/admin/email/subscribers?status=active',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { subscribers: Array<unknown> };
    };
    expect(body.data.subscribers.length).toBe(1);
  });

  it('400 when status is invalid', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers?status=BOGUS',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/email/subscribers
// ---------------------------------------------------------------------------

describe('POST /api/admin/email/subscribers', () => {
  it('400 when email missing/invalid', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'not-an-email', marketingOptIn: true }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockUpsertEmailSubscriber).not.toHaveBeenCalled();
  });

  it('400 when marketingOptIn missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockUpsertEmailSubscriber).not.toHaveBeenCalled();
  });

  it('200 dispatches upsertEmailSubscriber', async () => {
    mockUpsertEmailSubscriber.mockResolvedValueOnce({
      id: 's-new',
      email: 'a@example.com',
      is_active: 1,
      transactional_only: 0,
    });
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'a@example.com',
          marketingOptIn: true,
          consentSource: 'manual_import',
          friendId: 'f1',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertEmailSubscriber).toHaveBeenCalledWith(expect.anything(), {
      email: 'a@example.com',
      friendId: 'f1',
      marketingOptIn: true,
      consentSource: 'manual_import',
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/email/subscribers/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/email/subscribers/:id', () => {
  it('400 when isActive missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers/s1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockResubscribeById).not.toHaveBeenCalled();
    expect(mockUnsubscribeById).not.toHaveBeenCalled();
  });

  it('400 when isActive non-boolean', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers/s1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: 'yes' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200 calls resubscribeById when isActive=true', async () => {
    mockResubscribeById.mockResolvedValueOnce(true);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers/s1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: true }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockResubscribeById).toHaveBeenCalledWith(expect.anything(), 's1');
    expect(mockUnsubscribeById).not.toHaveBeenCalled();
  });

  it('200 calls unsubscribeById when isActive=false', async () => {
    mockUnsubscribeById.mockResolvedValueOnce(true);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers/s1',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUnsubscribeById).toHaveBeenCalledWith(expect.anything(), 's1');
    expect(mockResubscribeById).not.toHaveBeenCalled();
  });

  it('404 when helper returns false (not found)', async () => {
    mockResubscribeById.mockResolvedValueOnce(false);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/subscribers/missing',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isActive: true }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/email/templates
// ---------------------------------------------------------------------------

describe('GET /api/admin/email/templates', () => {
  it('200 passes through to listEmailTemplates', async () => {
    mockListEmailTemplates.mockResolvedValueOnce([
      { id: 't1', name: 'Test', subject: 'Hello' },
    ]);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates?activeOnly=true&category=marketing',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockListEmailTemplates).toHaveBeenCalledWith(expect.anything(), {
      category: 'marketing',
      activeOnly: true,
    });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/email/templates
// ---------------------------------------------------------------------------

describe('PUT /api/admin/email/templates', () => {
  it('400 when name missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subject: 'S',
          htmlContent: 'H',
          textContent: 'T',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(mockUpsertEmailTemplate).not.toHaveBeenCalled();
  });

  it('400 when subject missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'N',
          htmlContent: 'H',
          textContent: 'T',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('400 when htmlContent missing', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'N',
          subject: 'S',
          textContent: 'T',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200 with id (update path)', async () => {
    mockUpsertEmailTemplate.mockResolvedValueOnce({ id: 't1', name: 'Updated' });
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 't1',
          name: 'Updated',
          subject: 'Hello',
          htmlContent: '<p>Hi</p>',
          textContent: 'Hi',
          category: 'marketing',
          isActive: true,
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertEmailTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 't1',
        name: 'Updated',
        subject: 'Hello',
        htmlContent: '<p>Hi</p>',
        textContent: 'Hi',
      }),
    );
  });

  it('200 without id (create path)', async () => {
    mockUpsertEmailTemplate.mockResolvedValueOnce({ id: 'new-id', name: 'Brand' });
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Brand',
          subject: 'Welcome',
          htmlContent: '<h1>Hello</h1>',
          textContent: 'Hello',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockUpsertEmailTemplate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'Brand',
        subject: 'Welcome',
        htmlContent: '<h1>Hello</h1>',
        textContent: 'Hello',
      }),
    );
    // id should NOT be set
    const args = mockUpsertEmailTemplate.mock.calls[0]?.[1] as { id?: string };
    expect(args.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/email/templates/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/email/templates/:id', () => {
  it('200 dispatches deleteEmailTemplate', async () => {
    mockDeleteEmailTemplate.mockResolvedValueOnce(true);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates/t1',
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(mockDeleteEmailTemplate).toHaveBeenCalledWith(expect.anything(), 't1');
  });

  it('200 idempotent even when not found', async () => {
    mockDeleteEmailTemplate.mockResolvedValueOnce(false);
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/templates/missing',
      { method: 'DELETE', headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/email/messages
// ---------------------------------------------------------------------------

describe('GET /api/admin/email/messages', () => {
  it('200 returns message list with camelCase mapping', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        messagesListRows: [
          {
            id: 'log1',
            subscriber_id: 'sub1',
            email: 'a@example.com',
            subject: 'Hello',
            category: 'marketing',
            source_kind: 'broadcast',
            status: 'delivered',
            open_count: 2,
            click_count: 1,
            sent_at: '2026-01-01T00:00:00Z',
            delivered_at: '2026-01-01T00:00:05Z',
            first_opened_at: '2026-01-01T01:00:00Z',
            last_event_at: '2026-01-01T01:00:00Z',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    const res = await app.request(
      '/api/admin/email/messages?limit=50',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        messages: Array<{
          id: string;
          subscriberId: string;
          email: string;
          openCount: number;
          clickCount: number;
          sourceKind: string;
          createdAt: string;
        }>;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.messages.length).toBe(1);
    const m = body.data.messages[0];
    expect(m.id).toBe('log1');
    expect(m.subscriberId).toBe('sub1');
    expect(m.email).toBe('a@example.com');
    expect(m.openCount).toBe(2);
    expect(m.clickCount).toBe(1);
    expect(m.sourceKind).toBe('broadcast');
  });

  it('200 empty list when no rows', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb({ messagesListRows: [] }));
    const res = await app.request(
      '/api/admin/email/messages',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { messages: unknown[] };
    };
    expect(body.data.messages).toEqual([]);
  });

  it('400 when from format invalid', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDb());
    const res = await app.request(
      '/api/admin/email/messages?from=bad',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200 with status filter passes through', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDb({
        messagesListRows: [
          {
            id: 'log2',
            subscriber_id: 'sub2',
            email: 'b@example.com',
            subject: 'Sub',
            category: 'marketing',
            source_kind: 'manual',
            status: 'bounced',
            open_count: 0,
            click_count: 0,
            sent_at: null,
            delivered_at: null,
            first_opened_at: null,
            last_event_at: null,
            created_at: '2026-01-02T00:00:00Z',
          },
        ],
      }),
    );
    const res = await app.request(
      '/api/admin/email/messages?status=bounced&from=2026-01-01&to=2026-01-31',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { messages: Array<{ status: string }> };
    };
    expect(body.data.messages[0].status).toBe('bounced');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/email/opt-in/generate-url (Phase 5β-1)
// ---------------------------------------------------------------------------

describe('POST /api/admin/email/opt-in/generate-url', () => {
  function makeEnvWithKey(db: D1Database, opts: { hmacKey?: string; workerUrl?: string } = {}): Env['Bindings'] {
    return {
      ...makeEnv(db),
      EMAIL_OPTIN_HMAC_KEY: opts.hmacKey,
      WORKER_URL: opts.workerUrl ?? 'https://worker.example.com',
    } as unknown as Env['Bindings'];
  }

  it('EMAIL_OPTIN_HMAC_KEY 未設定 → 503', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), {}); // no hmacKey
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('WORKER_URL 未設定 → 503', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k', workerUrl: '' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('email 無し → 400', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('email 不正 → 400', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'not-an-email' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('ttlSeconds が大きすぎる (>30 日) → 400', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@x.com', ttlSeconds: 60 * 60 * 24 * 31 }), // > 30 days
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('valid email → 200 + 署名 URL 返却', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k', workerUrl: 'https://worker.example.com' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'user@example.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { url: string; email: string; expiresAt: number } };
    expect(body.success).toBe(true);
    expect(body.data.email).toBe('user@example.com');
    expect(body.data.url).toMatch(/^https:\/\/worker\.example\.com\/email\/opt-in\?email=user%40example\.com&e=\d+&token=[a-f0-9]{64}$/);
    expect(body.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('WORKER_URL 末尾 slash 正規化', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k', workerUrl: 'https://w.example.com/' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'a@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { url: string } };
    expect(body.data.url).toMatch(/^https:\/\/w\.example\.com\/email\/opt-in/);
    expect(body.data.url).not.toMatch(/\/\/email/);
  });

  it('認証なし → 401', async () => {
    const app = createTestApp();
    const env = makeEnvWithKey(createMockDb(), { hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/generate-url',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/email/opt-in/candidates (Phase 5β-1d-1)
// ---------------------------------------------------------------------------

describe('GET /api/admin/email/opt-in/candidates', () => {
  function createMockDbWithCandidates(rows: Array<{
    email: string;
    first_name: string | null;
    last_name: string | null;
    shopify_customer_id: string;
  }>): D1Database {
    return {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => {
            if (sql.includes('FROM shopify_customers sc') && sql.includes('LEFT JOIN email_subscribers')) {
              return { results: rows, success: true };
            }
            return { results: [], success: true };
          }),
          run: vi.fn(async () => ({ success: true })),
        })),
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [], success: true })),
        run: vi.fn(async () => ({ success: true })),
      })),
      dump: vi.fn(),
      batch: vi.fn(async () => []),
      exec: vi.fn(async () => ({ count: 0, duration: 0 })),
    } as unknown as D1Database;
  }

  it('200 + candidates array (Shopify 顧客で email_subscribers 非 active を JOIN 除外)', async () => {
    const app = createTestApp();
    const env = makeEnv(
      createMockDbWithCandidates([
        {
          email: 'cand1@x.com',
          first_name: 'Taro',
          last_name: 'Yamada',
          shopify_customer_id: '111',
        },
        {
          email: 'cand2@x.com',
          first_name: null,
          last_name: null,
          shopify_customer_id: '222',
        },
      ]),
    );
    const res = await app.request(
      '/api/admin/email/opt-in/candidates?limit=10',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { candidates: Array<{ email: string; firstName: string | null; shopifyCustomerId: string }>; count: number };
    };
    expect(body.data.count).toBe(2);
    expect(body.data.candidates[0]).toEqual({
      email: 'cand1@x.com',
      firstName: 'Taro',
      lastName: 'Yamada',
      shopifyCustomerId: '111',
    });
  });

  it('limit/offset query が反映される (上限 500 で clamp)', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDbWithCandidates([]));
    const res = await app.request(
      '/api/admin/email/opt-in/candidates?limit=99999&offset=10',
      { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { limit: number; offset: number } };
    expect(body.data.limit).toBe(500); // clamped
    expect(body.data.offset).toBe(10);
  });

  it('認証なし → 401', async () => {
    const app = createTestApp();
    const env = makeEnv(createMockDbWithCandidates([]));
    const res = await app.request('/api/admin/email/opt-in/candidates', {}, env);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/email/opt-in/send-invitations (Phase 5β-1d-1)
// ---------------------------------------------------------------------------

describe('POST /api/admin/email/opt-in/send-invitations', () => {
  function makeFullEnv(opts: { hmacKey?: string; workerUrl?: string; resendKey?: string; emailFrom?: string } = {}): Env['Bindings'] {
    return {
      ...makeEnv(createMockDb()),
      EMAIL_OPTIN_HMAC_KEY: opts.hmacKey,
      WORKER_URL: opts.workerUrl ?? 'https://w.example.com',
      RESEND_API_KEY: opts.resendKey ?? 're_test',
      EMAIL_FROM: opts.emailFrom ?? 'noreply@example.com',
      EMAIL_REPLY_TO: 'support@example.com',
      EMAIL_UNSUBSCRIBE_BASE_URL: 'https://example.com/email/unsubscribe',
      EMAIL_UNSUBSCRIBE_HMAC_KEY: 'a'.repeat(64),
      EMAIL_LEGAL_FOOTER_HTML: '<p>footer</p>',
      EMAIL_LEGAL_FOOTER_TEXT: 'footer',
    } as unknown as Env['Bindings'];
  }

  it('EMAIL_OPTIN_HMAC_KEY 未設定 → 503', async () => {
    const app = createTestApp();
    const env = makeFullEnv({}); // hmacKey なし
    const res = await app.request(
      '/api/admin/email/opt-in/send-invitations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [{ email: 'a@x.com' }] }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('recipients 無し → 400', async () => {
    const app = createTestApp();
    const env = makeFullEnv({ hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/send-invitations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [] }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('recipients > 200 → 400', async () => {
    const app = createTestApp();
    const env = makeFullEnv({ hmacKey: 'k' });
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ email: `r${i}@x.com` }));
    const res = await app.request(
      '/api/admin/email/opt-in/send-invitations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: tooMany }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('recipient.email が string でない → 400', async () => {
    const app = createTestApp();
    const env = makeFullEnv({ hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/send-invitations',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [{ email: 123 }] }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('認証なし → 401', async () => {
    const app = createTestApp();
    const env = makeFullEnv({ hmacKey: 'k' });
    const res = await app.request(
      '/api/admin/email/opt-in/send-invitations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [{ email: 'a@x.com' }] }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
