/**
 * Tests for Tips management routes (Phase 3A Stage 2).
 *
 * Covers:
 *   - GET /api/tips — 一覧取得（ページネーション）
 *   - GET /api/tips/:id — 単一取得
 *   - POST /api/tips — 新規作成
 *   - PUT /api/tips/:id — 更新
 *   - DELETE /api/tips/:id — 削除
 *   - GET /api/tips/today — 今日のTip
 *   - Input validation tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db  — must be before the import of ../routes/tips
// ---------------------------------------------------------------------------
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getDailyTips: vi.fn(async () => ({
      tips: [
        { id: 'tip-1', tip_date: '2026-04-06', category: 'health', title: '水分補給のコツ', content: 'こまめな水分補給が大切です。', image_url: null, source: 'manual', created_at: '2026-04-05T10:00:00Z' },
        { id: 'tip-2', tip_date: '2026-04-05', category: 'nutrition', title: '食物繊維について', content: '食物繊維を意識して摂りましょう。', image_url: null, source: 'manual', created_at: '2026-04-04T10:00:00Z' },
      ],
      total: 2,
    })),
    getTodayTip: vi.fn(async () => ({
      id: 'tip-today', tip_date: '2026-04-06', category: 'health', title: '今日のTip', content: 'テスト内容', image_url: null,
    })),
    createDailyTip: vi.fn(async (_db: unknown, data: Record<string, unknown>) => ({
      id: 'tip-new', tip_date: data.tipDate,
    })),
    updateDailyTip: vi.fn(async () => undefined),
    deleteDailyTip: vi.fn(async () => undefined),
  };
});

import { tips } from '../routes/tips.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();

  // Mock auth middleware (same pattern as main app)
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    return next();
  });

  app.route('/', tips);

  return app;
}

function mockD1() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => ({
          id: 'tip-1', tip_date: '2026-04-06', category: 'health', title: '水分補給のコツ',
          content: 'こまめな水分補給が大切です。', image_url: null, source: 'manual', created_at: '2026-04-05',
        })),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({})),
      })),
    })),
  };
}

function makeRequest(app: Hono, method: string, path: string, body?: unknown) {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  return app.request(`http://localhost${path}`, opts, { DB: mockD1() });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('Tips API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/tips', () => {
    it('returns paginated tips list', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'GET', '/api/tips');
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
      const data = json.data as Record<string, unknown>;
      expect(Array.isArray(data.tips)).toBe(true);
      expect(data.total).toBe(2);
    });

    it('requires auth', async () => {
      const app = new Hono();
      app.use('/api/*', async (c, next) => {
        const auth = c.req.header('Authorization');
        if (!auth || !auth.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
        return next();
      });
      app.route('/', tips);

      const res = await app.request('http://localhost/api/tips', {
        method: 'GET',
        headers: {},
      }, { DB: mockD1() });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/tips/:id', () => {
    it('returns single tip', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'GET', '/api/tips/tip-1');
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
    });
  });

  describe('POST /api/tips', () => {
    it('creates a new tip with valid data', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026-04-07',
        category: 'health',
        title: 'テストTip',
        content: 'テスト内容です。',
      });
      expect(res.status).toBe(201);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
    });

    it('rejects missing tipDate', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        category: 'health',
        title: 'テスト',
        content: '内容',
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid date format', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026/04/07',
        category: 'health',
        title: 'テスト',
        content: '内容',
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing title', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026-04-07',
        category: 'health',
        content: '内容',
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing content', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026-04-07',
        category: 'health',
        title: 'タイトル',
      });
      expect(res.status).toBe(400);
    });

    it('rejects title over 200 chars', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026-04-07',
        category: 'health',
        title: 'A'.repeat(201),
        content: '内容',
      });
      expect(res.status).toBe(400);
    });

    it('rejects content over 2000 chars', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'POST', '/api/tips', {
        tipDate: '2026-04-07',
        category: 'health',
        title: 'タイトル',
        content: 'A'.repeat(2001),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/tips/:id', () => {
    it('updates an existing tip', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'PUT', '/api/tips/tip-1', {
        title: '更新されたタイトル',
      });
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
    });
  });

  describe('DELETE /api/tips/:id', () => {
    it('deletes an existing tip', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'DELETE', '/api/tips/tip-1');
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
    });
  });

  describe('GET /api/tips/today', () => {
    it('returns today tip', async () => {
      const app = createApp();
      const res = await makeRequest(app, 'GET', '/api/tips/today');
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(json.success).toBe(true);
      expect(json.data).not.toBeNull();
    });
  });
});
