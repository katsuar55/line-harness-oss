/**
 * Tests for Survey management routes (Phase 3 — アンケート送信・商品テスト依頼).
 *
 * Covers:
 *   - GET /api/surveys — 一覧取得
 *   - POST /api/surveys — 作成
 *   - GET /api/surveys/:id — 詳細取得
 *   - PUT /api/surveys/:id — 更新
 *   - DELETE /api/surveys/:id — 削除
 *   - POST /api/surveys/:id/send — 配信
 *   - GET /api/surveys/:id/responses — 回答一覧
 *   - GET /api/surveys/:id/stats — 統計
 *   - Validation tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createSurvey: vi.fn(async () => ({ id: 'srv-new' })),
    updateSurvey: vi.fn(async () => undefined),
    getSurveys: vi.fn(async () => ({
      surveys: [
        { id: 'srv-1', title: '商品満足度調査', description: '使い心地について', survey_type: 'survey', questions: '[{"id":"q1","type":"rating","label":"満足度"}]', target_tier: 'all', status: 'active', sent_count: 10, response_count: 5, created_at: '2026-04-06', updated_at: '2026-04-06' },
      ],
      total: 1,
    })),
    getSurveyById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'srv-1') return { id: 'srv-1', title: '商品満足度調査', description: null, survey_type: 'survey', questions: '[{"id":"q1","type":"rating","label":"満足度"}]', target_tier: 'all', status: 'active', sent_count: 10, response_count: 5, created_at: '2026-04-06', updated_at: '2026-04-06' };
      if (id === 'srv-draft') return { id: 'srv-draft', title: 'Draft Survey', description: null, survey_type: 'survey', questions: '[]', target_tier: 'all', status: 'draft', sent_count: 0, response_count: 0, created_at: '2026-04-06', updated_at: '2026-04-06' };
      if (id === 'srv-empty') return { id: 'srv-empty', title: 'Empty Survey', description: null, survey_type: 'survey', questions: '[]', target_tier: 'all', status: 'active', sent_count: 0, response_count: 0, created_at: '2026-04-06', updated_at: '2026-04-06' };
      return null;
    }),
    deleteSurvey: vi.fn(async () => undefined),
    getDeliveryTargets: vi.fn(async () => [
      { ambassador_id: 'amb-1', friend_id: 'f-1', line_user_id: 'U_AMB_1' },
      { ambassador_id: 'amb-2', friend_id: 'f-2', line_user_id: 'U_AMB_2' },
    ]),
    recordSurveyDelivery: vi.fn(async () => undefined),
    incrementSurveySentCount: vi.fn(async () => undefined),
    getSurveyResponses: vi.fn(async () => ({
      responses: [
        { id: 'srs-1', ambassador_id: 'amb-1', friend_id: 'f-1', answers: '{"q1":5}', submitted_at: '2026-04-06', display_name: 'Test User' },
      ],
      total: 1,
    })),
    getSurveyStats: vi.fn(async () => ({
      sent: 10, responded: 5, responseRate: 50, avgRating: 4.2,
    })),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({
    multicast: vi.fn(async () => undefined),
    pushMessage: vi.fn(async () => undefined),
    broadcast: vi.fn(async () => undefined),
  })),
  flexMessage: vi.fn((_alt: string, contents: unknown) => ({ type: 'flex', altText: _alt, contents })),
}));

import { surveys } from '../routes/surveys.js';

const API_KEY = 'test-api-key';

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', surveys);
  return app;
}

function mockEnv() {
  return {
    DB: {} as D1Database,
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    LIFF_URL: 'https://liff.line.me/test',
  };
}

function get(app: Hono, path: string) {
  return app.request(path, {
    method: 'GET',
    headers: { Authorization: `Bearer ${API_KEY}` },
  }, mockEnv());
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, mockEnv());
}

function put(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, mockEnv());
}

function del(app: Hono, path: string) {
  return app.request(path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${API_KEY}` },
  }, mockEnv());
}

describe('Surveys API', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ─── CRUD ───────────────────────────────────
  describe('GET /api/surveys', () => {
    it('returns survey list', async () => {
      const res = await get(app, '/api/surveys');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { surveys: unknown[]; total: number } };
      expect(json.data.surveys.length).toBe(1);
      expect(json.data.total).toBe(1);
    });
  });

  describe('POST /api/surveys', () => {
    it('creates a survey (201)', async () => {
      const res = await post(app, '/api/surveys', {
        title: 'テストアンケート',
        questions: [{ id: 'q1', type: 'rating', label: '満足度', required: true }],
      });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string } };
      expect(json.data.id).toBe('srv-new');
    });

    it('rejects empty title (400)', async () => {
      const res = await post(app, '/api/surveys', {
        title: '',
        questions: [{ id: 'q1', type: 'rating', label: '満足度' }],
      });
      expect(res.status).toBe(400);
    });

    it('rejects empty questions (400)', async () => {
      const res = await post(app, '/api/surveys', {
        title: 'Test',
        questions: [],
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid survey_type (400)', async () => {
      const res = await post(app, '/api/surveys', {
        title: 'Test',
        survey_type: 'invalid',
        questions: [{ id: 'q1', type: 'rating', label: '満足度' }],
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid question type (400)', async () => {
      const res = await post(app, '/api/surveys', {
        title: 'Test',
        questions: [{ id: 'q1', type: 'invalid', label: '質問' }],
      });
      expect(res.status).toBe(400);
    });

    it('rejects choice without options (400)', async () => {
      const res = await post(app, '/api/surveys', {
        title: 'Test',
        questions: [{ id: 'q1', type: 'choice', label: '選択' }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/surveys/:id', () => {
    it('returns survey detail', async () => {
      const res = await get(app, '/api/surveys/srv-1');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { title: string; questions: unknown[] } };
      expect(json.data.title).toBe('商品満足度調査');
      expect(Array.isArray(json.data.questions)).toBe(true);
    });

    it('returns 404 for non-existent', async () => {
      const res = await get(app, '/api/surveys/srv-nope');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/surveys/:id', () => {
    it('updates survey (200)', async () => {
      const res = await put(app, '/api/surveys/srv-1', { title: '更新済み' });
      expect(res.status).toBe(200);
    });

    it('returns 404 for non-existent', async () => {
      const res = await put(app, '/api/surveys/srv-nope', { title: 'X' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/surveys/:id', () => {
    it('deletes survey without responses (200)', async () => {
      const res = await del(app, '/api/surveys/srv-empty');
      expect(res.status).toBe(200);
    });

    it('rejects delete for survey with responses (400)', async () => {
      const res = await del(app, '/api/surveys/srv-1');
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent', async () => {
      const res = await del(app, '/api/surveys/srv-nope');
      expect(res.status).toBe(404);
    });
  });

  // ─── Delivery ───────────────────────────────
  describe('POST /api/surveys/:id/send', () => {
    it('sends survey to ambassadors (200)', async () => {
      const res = await post(app, '/api/surveys/srv-1/send', {});
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { sent: number } };
      expect(json.data.sent).toBe(2);
    });

    it('rejects sending draft survey (400)', async () => {
      const res = await post(app, '/api/surveys/srv-draft/send', {});
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent survey', async () => {
      const res = await post(app, '/api/surveys/srv-nope/send', {});
      expect(res.status).toBe(404);
    });
  });

  // ─── Responses & Stats ─────────────────────
  describe('GET /api/surveys/:id/responses', () => {
    it('returns response list', async () => {
      const res = await get(app, '/api/surveys/srv-1/responses');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { responses: Array<{ answers: unknown }>; total: number } };
      expect(json.data.total).toBe(1);
      expect(json.data.responses[0].answers).toEqual({ q1: 5 });
    });
  });

  describe('GET /api/surveys/:id/stats', () => {
    it('returns survey statistics', async () => {
      const res = await get(app, '/api/surveys/srv-1/stats');
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { sent: number; responded: number; responseRate: number } };
      expect(json.data.sent).toBe(10);
      expect(json.data.responded).toBe(5);
      expect(json.data.responseRate).toBe(50);
    });
  });
});
