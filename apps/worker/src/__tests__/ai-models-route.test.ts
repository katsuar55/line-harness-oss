/**
 * Tests for /api/ai-models route (= 戦略 #1 admin UI、 2026-05-26)
 *
 * カバー範囲:
 *   - GET /api/ai-models (= 一覧 + stats + isNewlyAdded markup)
 *   - GET filter (vendor / task / includeDeprecated)
 *   - GET /api/ai-models/:modelId (= 個別、 200 + 404)
 *   - PATCH /api/ai-models/:modelId/candidate (= toggle primary / fallback)
 *   - PATCH 400 (= 空 body)
 *   - PATCH 404 (= unknown model)
 *   - POST /api/ai-models/sync (= 手動 trigger)
 *   - 認証必須 (= 401)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ============================================================
// Mock @line-crm/db
// ============================================================

interface MockEntry {
  id: string;
  modelId: string;
  vendor: string;
  family: string;
  sizeLabel: string | null;
  task: string;
  capabilities: string[];
  contextWindow: number | null;
  description: string | null;
  isBeta: boolean;
  isDeprecated: boolean;
  primaryCandidate: boolean;
  fallbackCandidate: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string | null;
  source: string;
}

const state = {
  models: [] as MockEntry[],
  recentlyAdded: [] as MockEntry[],
  candidateUpdates: [] as Array<{ modelId: string; primary?: boolean; fallback?: boolean }>,
  setCandidateThrows: false,
};

vi.mock('@line-crm/db', () => ({
  listAiModels: vi.fn(async (_db: unknown, filters: { vendor?: string; task?: string; includeDeprecated?: boolean }) => {
    return state.models.filter((m) => {
      if (!filters.includeDeprecated && m.isDeprecated) return false;
      if (filters.vendor && m.vendor !== filters.vendor) return false;
      if (filters.task && m.task !== filters.task) return false;
      return true;
    });
  }),
  getAiModelById: vi.fn(async (_db: unknown, modelId: string) => {
    return state.models.find((m) => m.modelId === modelId) ?? null;
  }),
  setModelCandidate: vi.fn(
    async (_db: unknown, modelId: string, flags: { primary?: boolean; fallback?: boolean }) => {
      if (state.setCandidateThrows) throw new Error('simulated db failure');
      state.candidateUpdates.push({ modelId, ...flags });
      const m = state.models.find((x) => x.modelId === modelId);
      if (m) {
        if (flags.primary !== undefined) m.primaryCandidate = flags.primary;
        if (flags.fallback !== undefined) m.fallbackCandidate = flags.fallback;
      }
    },
  ),
  getAiModelCatalogStats: vi.fn(async () => ({
    total: state.models.length,
    active: state.models.filter((m) => !m.isDeprecated).length,
    deprecated: state.models.filter((m) => m.isDeprecated).length,
    primaryCandidates: state.models.filter((m) => m.primaryCandidate && !m.isDeprecated).length,
    fallbackCandidates: state.models.filter((m) => m.fallbackCandidate && !m.isDeprecated).length,
    byVendor: state.models.reduce((acc, m) => {
      if (!m.isDeprecated) acc[m.vendor] = (acc[m.vendor] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    byTask: state.models.reduce((acc, m) => {
      if (!m.isDeprecated) acc[m.task] = (acc[m.task] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  })),
  getRecentlyAddedModels: vi.fn(async () => state.recentlyAdded),
  // for syncAiModelsCatalog dependency chain
  upsertAiModel: vi.fn(async () => ({ inserted: true })),
  markStaleModelsAsDeprecated: vi.fn(async () => ({ deprecatedCount: 0, modelIds: [] })),
  insertCronRunLog: vi.fn(async () => {}),
}));

// ============================================================
// Test app
// ============================================================

const API_KEY = 'test-api-key';

async function createApp() {
  const { aiModels } = await import('../routes/ai-models.js');
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', aiModels);
  return app;
}

function makeFakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function seedModel(overrides: Partial<MockEntry> = {}): MockEntry {
  return {
    id: 'id-1',
    modelId: '@cf/meta/llama-4-scout',
    vendor: 'meta',
    family: 'llama',
    sizeLabel: '4-scout',
    task: 'text-generation',
    capabilities: ['text', 'multilingual'],
    contextWindow: 131072,
    description: 'Llama 4 Scout',
    isBeta: true,
    isDeprecated: false,
    primaryCandidate: true,
    fallbackCandidate: false,
    firstSeenAt: '2026-05-26T07:00:00.000',
    lastSeenAt: '2026-05-26T07:00:00.000',
    lastSyncedAt: null,
    source: 'seed',
    ...overrides,
  };
}

beforeEach(() => {
  state.models = [];
  state.recentlyAdded = [];
  state.candidateUpdates.length = 0;
  state.setCandidateThrows = false;
  vi.clearAllMocks();
});

// ============================================================
// auth
// ============================================================

describe('auth', () => {
  it('GET 認証なし → 401', async () => {
    const app = await createApp();
    const res = await app.request('http://localhost/api/ai-models', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// GET /api/ai-models
// ============================================================

describe('GET /api/ai-models', () => {
  it('全件 (= active のみ) を stats とともに返す', async () => {
    const app = await createApp();
    state.models = [
      seedModel({ modelId: '@cf/meta/m1', vendor: 'meta', primaryCandidate: true }),
      seedModel({ id: 'id-2', modelId: '@cf/google/g1', vendor: 'google', primaryCandidate: false, fallbackCandidate: true }),
      seedModel({ id: 'id-3', modelId: '@cf/qwen/q1', vendor: 'qwen', isDeprecated: true }),
    ];
    const res = await app.request(
      'http://localhost/api/ai-models',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { models: Array<{ modelId: string }>; stats: { total: number; active: number } };
    };
    expect(json.success).toBe(true);
    expect(json.data.models).toHaveLength(2); // deprecated 除外
    expect(json.data.stats.total).toBe(3);
    expect(json.data.stats.active).toBe(2);
  });

  it('includeDeprecated=true で deprecated も返す', async () => {
    const app = await createApp();
    state.models = [
      seedModel({ modelId: '@cf/a/1' }),
      seedModel({ id: 'id-2', modelId: '@cf/q/1', isDeprecated: true }),
    ];
    const res = await app.request(
      'http://localhost/api/ai-models?includeDeprecated=true',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    const json = (await res.json()) as {
      success: boolean;
      data: { models: Array<{ modelId: string }> };
    };
    expect(json.data.models).toHaveLength(2);
  });

  it('vendor filter', async () => {
    const app = await createApp();
    state.models = [
      seedModel({ modelId: '@cf/meta/m', vendor: 'meta' }),
      seedModel({ id: 'id-2', modelId: '@cf/google/g', vendor: 'google' }),
    ];
    const res = await app.request(
      'http://localhost/api/ai-models?vendor=meta',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    const json = (await res.json()) as {
      success: boolean;
      data: { models: Array<{ modelId: string; vendor: string }> };
    };
    expect(json.data.models).toHaveLength(1);
    expect(json.data.models[0]?.vendor).toBe('meta');
  });

  it('task filter', async () => {
    const app = await createApp();
    state.models = [
      seedModel({ modelId: '@cf/m/x', task: 'text-generation' }),
      seedModel({ id: 'id-2', modelId: '@cf/m/y', task: 'embedding' }),
    ];
    const res = await app.request(
      'http://localhost/api/ai-models?task=embedding',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    const json = (await res.json()) as {
      success: boolean;
      data: { models: Array<{ task: string }> };
    };
    expect(json.data.models).toHaveLength(1);
    expect(json.data.models[0]?.task).toBe('embedding');
  });

  it('isNewlyAdded markup (= getRecentlyAddedModels に含まれるなら true)', async () => {
    const app = await createApp();
    state.models = [
      seedModel({ modelId: '@cf/new/x' }),
      seedModel({ id: 'id-2', modelId: '@cf/old/y' }),
    ];
    state.recentlyAdded = [seedModel({ modelId: '@cf/new/x' })];

    const res = await app.request(
      'http://localhost/api/ai-models',
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    const json = (await res.json()) as {
      success: boolean;
      data: { models: Array<{ modelId: string; isNewlyAdded: boolean }> };
    };
    expect(json.data.models.find((m) => m.modelId === '@cf/new/x')?.isNewlyAdded).toBe(true);
    expect(json.data.models.find((m) => m.modelId === '@cf/old/y')?.isNewlyAdded).toBe(false);
  });
});

// ============================================================
// GET /api/ai-models/:modelId
// ============================================================

describe('GET /api/ai-models/:modelId', () => {
  it('存在 → 200', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/meta/llama-4-scout' })];
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/meta/llama-4-scout'),
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { modelId: string } };
    expect(json.data.modelId).toBe('@cf/meta/llama-4-scout');
  });

  it('不存在 → 404', async () => {
    const app = await createApp();
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/unknown/model'),
      { method: 'GET', headers: { Authorization: `Bearer ${API_KEY}` } },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// PATCH /api/ai-models/:modelId/candidate
// ============================================================

describe('PATCH /api/ai-models/:modelId/candidate', () => {
  it('primary=true で setModelCandidate 呼び出し + 200', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/m/x', primaryCandidate: false })];
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/m/x') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: true }),
      },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { primary: boolean } };
    expect(json.data.primary).toBe(true);
    expect(state.candidateUpdates).toEqual([{ modelId: '@cf/m/x', primary: true }]);
  });

  it('fallback=false で update', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/m/x', fallbackCandidate: true })];
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/m/x') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fallback: false }),
      },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { fallback: boolean } };
    expect(json.data.fallback).toBe(false);
  });

  it('primary + fallback 両方 update', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/m/x' })];
    await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/m/x') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: true, fallback: true }),
      },
      { DB: makeFakeDb() },
    );
    expect(state.candidateUpdates).toEqual([
      { modelId: '@cf/m/x', primary: true, fallback: true },
    ]);
  });

  it('空 body (= primary も fallback も含まない) → 400', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/m/x' })];
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/m/x') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(400);
  });

  it('不存在 modelId → 404', async () => {
    const app = await createApp();
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/unknown/m') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: true }),
      },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(404);
  });

  it('primary が boolean でない → 400 (= validation)', async () => {
    const app = await createApp();
    state.models = [seedModel({ modelId: '@cf/m/x' })];
    const res = await app.request(
      'http://localhost/api/ai-models/' + encodeURIComponent('@cf/m/x') + '/candidate',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: 'yes' }),
      },
      { DB: makeFakeDb() },
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================
// POST /api/ai-models/sync
// ============================================================

describe('POST /api/ai-models/sync', () => {
  it('secret 未設定 → triggered=true + skippedReason=account-missing', async () => {
    const app = await createApp();
    const res = await app.request(
      'http://localhost/api/ai-models/sync',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
      },
      { DB: makeFakeDb() }, // CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN 未設定
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { triggered: boolean; skippedReason?: string };
    };
    expect(json.success).toBe(true);
    expect(json.data.triggered).toBe(true);
    expect(json.data.skippedReason).toBe('account-missing');
  });
});
