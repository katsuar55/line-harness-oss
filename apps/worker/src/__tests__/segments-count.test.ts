/**
 * Tests for POST /api/segments/count (segment dry-run count).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getStaffByApiKey: vi.fn(async () => null),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { segments } from '../routes/segments.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-secret-12345';

function makeDb(count: number): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (sql.includes('COUNT(*)') ? { cnt: count } : null)),
      })),
      first: vi.fn(async () => (sql.includes('COUNT(*)') ? { cnt: count } : null)),
    })),
  } as unknown as D1Database;
}

function makeApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', segments);
  return app;
}

function post(body: unknown) {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function makeEnv(db: D1Database): Env['Bindings'] {
  return { DB: db, API_KEY: TEST_API_KEY } as unknown as Env['Bindings'];
}

describe('POST /api/segments/count', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without auth', async () => {
    const res = await makeApp().request(
      '/api/segments/count',
      { method: 'POST', body: '{}' },
      makeEnv(makeDb(0)),
    );
    expect(res.status).toBe(401);
  });

  it('counts friends matching a valid condition', async () => {
    const res = await makeApp().request(
      '/api/segments/count',
      post({
        condition: {
          operator: 'AND',
          rules: [
            { type: 'shopify_orders_count_gte', value: 2 },
            { type: 'is_following', value: true },
          ],
        },
      }),
      makeEnv(makeDb(42)),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { count: number } };
    expect(body.success).toBe(true);
    expect(body.data.count).toBe(42);
  });

  it('rejects an invalid condition (unknown rule type) with 400', async () => {
    const res = await makeApp().request(
      '/api/segments/count',
      post({ condition: { operator: 'AND', rules: [{ type: 'nope', value: 'x' }] } }),
      makeEnv(makeDb(0)),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toContain('invalid condition');
  });

  it('rejects a missing condition with 400', async () => {
    const res = await makeApp().request('/api/segments/count', post({}), makeEnv(makeDb(0)));
    expect(res.status).toBe(400);
  });
});
