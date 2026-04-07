/**
 * Tests for CSV export routes (Phase 3 Stage 6).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    jstNow: vi.fn(() => '2026-04-07T10:00:00+09:00'),
  };
});

import { csvExport } from '../routes/csv-export.js';

const API_KEY = 'test-api-key';

function createApp(role: string = 'owner') {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    c.set('staff', { id: 'test-staff', name: 'Test', role });
    return next();
  });
  app.route('/', csvExport);
  return app;
}

function mockD1(rows: Array<Record<string, unknown>> = []) {
  const allFn = vi.fn(async () => ({ results: rows }));
  return {
    prepare: vi.fn(() => {
      const bindable = { all: allFn, bind: vi.fn((): typeof bindable => bindable) };
      return bindable;
    }),
  };
}

function req(app: Hono, path: string, db?: unknown) {
  return app.request(`http://localhost${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${API_KEY}` },
  }, { DB: db ?? mockD1() });
}

describe('CSV Export API', () => {
  beforeEach(() => vi.clearAllMocks());

  const endpoints = [
    '/api/export/friends',
    '/api/export/orders',
    '/api/export/coupons',
    '/api/export/intake',
    '/api/export/health',
    '/api/export/referrals',
    '/api/export/ambassadors',
    '/api/export/ranks',
  ];

  for (const path of endpoints) {
    it(`GET ${path} returns CSV`, async () => {
      const app = createApp();
      const res = await req(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/csv');
      expect(res.headers.get('Content-Disposition')).toContain('attachment');
      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
    });
  }

  it('CSV contains proper headers for friends', async () => {
    const app = createApp();
    const db = mockD1([
      { id: 'f1', line_user_id: 'U_test', display_name: 'Test', is_following: 1, tags: 'tag1;tag2', created_at: '2026-01-01' },
    ]);
    const res = await req(app, '/api/export/friends', db);
    const body = await res.text();
    const lines = body.split('\n');
    expect(lines[0]).toContain('id,line_user_id,display_name');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it('requires auth', async () => {
    const app = createApp();
    const res = await app.request('http://localhost/api/export/friends', {
      method: 'GET',
    }, { DB: mockD1() });
    expect(res.status).toBe(401);
  });

  it('blocks staff role from CSV export (403)', async () => {
    const app = createApp('staff');
    const res = await req(app, '/api/export/friends');
    expect(res.status).toBe(403);
    const json = await res.json() as { error: string };
    expect(json.error).toContain('owner or admin');
  });

  it('allows admin role for CSV export', async () => {
    const app = createApp('admin');
    const res = await req(app, '/api/export/friends');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
  });

  // --- New CSV types ---

  it('GET /api/export/friends-by-tag requires tag param', async () => {
    const app = createApp();
    const res = await req(app, '/api/export/friends-by-tag');
    expect(res.status).toBe(400);
  });

  it('GET /api/export/friends-by-tag returns CSV with tag', async () => {
    const app = createApp();
    const db = mockD1([{ id: 'f1', display_name: 'Test', is_following: 1 }]);
    const res = await req(app, '/api/export/friends-by-tag?tag=VIP', db);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
  });

  for (const path of ['/api/export/tips', '/api/export/quiz-results', '/api/export/shipping']) {
    it(`GET ${path} returns CSV`, async () => {
      const app = createApp();
      const res = await req(app, path);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/csv');
    });
  }
});
