/**
 * Tests for Ambassadors management routes (Phase 3 Stage 5).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getAmbassadors: vi.fn(async () => ({
      ambassadors: [
        { id: 'amb-1', friend_id: 'f-1', display_name: 'Test User', status: 'active', tier: 'bronze', enrolled_at: '2026-04-01', total_surveys_completed: 2, total_product_tests: 1, preferences: '{"survey_ok":true}' },
      ],
      total: 1,
    })),
    getAmbassadorStats: vi.fn(async () => ({
      total: 5, active: 3, avgSurveys: 2, avgFeedbackScore: 4.2,
    })),
    updateAmbassador: vi.fn(async () => undefined),
  };
});

import { ambassadors } from '../routes/ambassadors.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', ambassadors);
  return app;
}

function mockD1() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => ({ id: 'amb-1' })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({})),
      })),
    })),
  };
}

function req(app: Hono, method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
  };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost${path}`, opts, { DB: mockD1() });
}

describe('Ambassadors API', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /api/ambassadors returns list', async () => {
    const app = createApp();
    const res = await req(app, 'GET', '/api/ambassadors');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
  });

  it('GET /api/ambassadors/stats returns stats', async () => {
    const app = createApp();
    const res = await req(app, 'GET', '/api/ambassadors/stats');
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.success).toBe(true);
    expect((json.data as Record<string, unknown>).total).toBe(5);
  });

  it('PUT /api/ambassadors/:id updates ambassador', async () => {
    const app = createApp();
    const res = await req(app, 'PUT', '/api/ambassadors/amb-1', { status: 'inactive', tier: 'gold' });
    expect(res.status).toBe(200);
  });

  it('PUT rejects invalid status', async () => {
    const app = createApp();
    const res = await req(app, 'PUT', '/api/ambassadors/amb-1', { status: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects invalid tier', async () => {
    const app = createApp();
    const res = await req(app, 'PUT', '/api/ambassadors/amb-1', { tier: 'diamond' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects note over 500 chars', async () => {
    const app = createApp();
    const res = await req(app, 'PUT', '/api/ambassadors/amb-1', { note: 'x'.repeat(501) });
    expect(res.status).toBe(400);
  });
});
