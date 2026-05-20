/**
 * Tests for /api/audit-logs (Phase 5β-1d-2f-followup admin UI route).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import { auditLogs } from '../routes/audit-logs.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', auditLogs);
  return app;
}

/**
 * FakeDb: queryAuditLogs / countAuditLogs が内部で SELECT する SQL を mock する。
 *
 * packages/db/src/audit-logs.ts:
 *   - queryAuditLogs: `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
 *   - countAuditLogs: `SELECT COUNT(*) AS n FROM audit_logs ${where}`
 *
 * 同じ filter で呼ばれる前提なので、 1 つの mock store で両方対応する。
 */
function mockD1(opts: { rows?: Array<Record<string, unknown>>; total?: number } = {}) {
  const rows = opts.rows ?? [];
  const total = opts.total ?? rows.length;
  return {
    prepare: vi.fn((sql: string) => {
      const isCount = /SELECT\s+COUNT\(/i.test(sql);
      const isSelectAll = /SELECT\s+\*\s+FROM\s+audit_logs/i.test(sql);
      const self = {
        bind: vi.fn(() => self),
        first: vi.fn(async () => {
          if (isCount) return { n: total };
          return null;
        }),
        all: vi.fn(async () => {
          if (isSelectAll) return { results: rows };
          return { results: [] };
        }),
      };
      return self;
    }),
  };
}

describe('GET /api/audit-logs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns logs + total + limit + offset (default pagination)', async () => {
    const app = createApp();
    const fakeRows = [
      {
        id: '1',
        action: 'line_friend_coupon.issue_failed',
        actor_type: 'webhook',
        result: 'failure',
        target_id: 'friend-A',
        metadata: '{"stage":"discount_create"}',
        created_at: '2026-05-20T10:00:00+09:00',
      },
    ];
    const res = await app.request(
      'http://localhost/api/audit-logs',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1({ rows: fakeRows, total: 1 }) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { logs: Array<{ id: string; action: string }>; total: number; limit: number; offset: number; hasMore: boolean };
    };
    expect(json.success).toBe(true);
    expect(json.data.logs.length).toBe(1);
    expect(json.data.logs[0].id).toBe('1');
    expect(json.data.logs[0].action).toBe('line_friend_coupon.issue_failed');
    expect(json.data.total).toBe(1);
    expect(json.data.limit).toBe(100);
    expect(json.data.offset).toBe(0);
    expect(json.data.hasMore).toBe(false);
  });

  it('clamps limit to 500 max', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?limit=9999',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    const json = (await res.json()) as { data: { limit: number } };
    expect(json.data.limit).toBe(500);
  });

  it('clamps limit to 1 min', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?limit=0',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    const json = (await res.json()) as { data: { limit: number } };
    expect(json.data.limit).toBe(1);
  });

  it('parses offset correctly', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?offset=50',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1({ rows: [], total: 200 }) },
    );
    const json = (await res.json()) as { data: { offset: number; total: number; hasMore: boolean } };
    expect(json.data.offset).toBe(50);
    expect(json.data.total).toBe(200);
    expect(json.data.hasMore).toBe(false); // offset 50 + logs 0 < 200 だが logs 空なので hasMore=false
  });

  it('returns hasMore=true when offset + logs.length < total', async () => {
    const app = createApp();
    const someRows = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      action: 'x',
      actor_type: 'system',
      result: 'success',
      target_id: null,
      metadata: '{}',
      created_at: '2026-05-20T00:00:00+09:00',
    }));
    const res = await app.request(
      'http://localhost/api/audit-logs?limit=10&offset=0',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1({ rows: someRows, total: 50 }) },
    );
    const json = (await res.json()) as { data: { hasMore: boolean } };
    expect(json.data.hasMore).toBe(true);
  });

  it('rejects invalid result with 400', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?result=garbage',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('invalid result');
  });

  it('rejects invalid actorType with 400', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?actorType=hacker',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('invalid actorType');
  });

  it('accepts valid result=failure', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?result=failure',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('accepts valid actorType=webhook', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?actorType=webhook',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('accepts actionPrefix for line_friend_coupon.* filter (= 課題 1 use case)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs?actionPrefix=line_friend_coupon.',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: mockD1() },
    );
    expect(res.status).toBe(200);
  });

  it('requires auth', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/audit-logs',
      { method: 'GET' },
      { DB: mockD1() },
    );
    expect(res.status).toBe(401);
  });

  it('handles D1 error gracefully (500)', async () => {
    const app = createApp();
    const failingDb = {
      prepare: vi.fn(() => {
        throw new Error('D1 unavailable');
      }),
    };
    const res = await app.request(
      'http://localhost/api/audit-logs',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: failingDb },
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });
});
