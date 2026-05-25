/**
 * Tests for services/ai-models-catalog (= 自動 update 戦略 #1、 2026-05-26)
 *
 * カバー範囲:
 *   - gating (= JST 04:00-04:04 window)
 *   - AI_MODELS_SYNC_FORCE='true' で gating bypass
 *   - secret 未設定 (= account_id / api_token) で graceful skip
 *   - parseModelId (= @cf/ prefix の vendor/family 抽出)
 *   - extractCapabilities + extractContextWindow
 *   - sync 成功: insert / update / 新着 → Discord 通知
 *   - sync 成功 + stale deprecated → Discord 通知
 *   - API fetch 失敗 → errors=1 + cron_run_logs に error
 *   - upsert per-model 失敗 → 他の model に影響なし
 *   - 既存 row (= pre-existing) は新着扱いしない
 *   - cron_run_logs 必ず insert される (= 失敗時も metadata で trace 可)
 *   - Discord webhook 未設定で notification skip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock @line-crm/db
// ============================================================

interface UpsertCall {
  input: {
    modelId: string;
    vendor: string;
    family: string;
    sizeLabel: string | null;
    task: string;
    capabilities: string[];
    contextWindow: number | null;
    description: string | null;
    isBeta: boolean;
    rawMetadata: unknown;
    source: string;
  };
  resultInserted: boolean;
}

interface CronRunCall {
  jobName: string;
  status: string;
  metrics?: unknown;
  errorSummary?: string;
}

const state = {
  upsertCalls: [] as UpsertCall[],
  cronRunCalls: [] as CronRunCall[],
  existingModelIds: new Set<string>(),
  /** modelId → forceInserted (true = upsert returns inserted, false = updated) */
  upsertReturnInserted: new Map<string, boolean>(),
  upsertShouldThrowFor: new Set<string>(),
  staleResult: { deprecatedCount: 0, modelIds: [] as string[] },
  cronInsertShouldThrow: false,
};

vi.mock('@line-crm/db', () => ({
  upsertAiModel: vi.fn(async (_db: unknown, input: UpsertCall['input']) => {
    if (state.upsertShouldThrowFor.has(input.modelId)) {
      throw new Error(`simulated upsert failure for ${input.modelId}`);
    }
    const inserted = state.upsertReturnInserted.get(input.modelId) ?? true;
    state.upsertCalls.push({ input, resultInserted: inserted });
    return { inserted };
  }),
  getAiModelById: vi.fn(async (_db: unknown, modelId: string) => {
    if (state.existingModelIds.has(modelId)) {
      return {
        id: 'existing',
        modelId,
        vendor: 'meta',
        family: 'llama',
        sizeLabel: null,
        task: 'text-generation',
        capabilities: [],
        contextWindow: null,
        description: null,
        isBeta: false,
        isDeprecated: false,
        primaryCandidate: false,
        fallbackCandidate: false,
        firstSeenAt: '2026-01-01T00:00:00.000',
        lastSeenAt: '2026-01-01T00:00:00.000',
        lastSyncedAt: null,
        source: 'seed',
      };
    }
    return null;
  }),
  markStaleModelsAsDeprecated: vi.fn(async () => state.staleResult),
  insertCronRunLog: vi.fn(async (_db: unknown, input: CronRunCall) => {
    if (state.cronInsertShouldThrow) throw new Error('simulated cron insert failure');
    state.cronRunCalls.push(input);
  }),
}));

// ============================================================
// Fake D1 (= 実 SQL は mock した db helper が握っているので noop)
// ============================================================

function makeFakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[], success: true };
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

// ============================================================
// Test fetch impl
// ============================================================

interface CloudflareModelResult {
  name: string;
  description?: string;
  task: { name: string };
  tags?: string[];
  properties?: Array<{ property_id: string; value: string | number }>;
}

function makeCloudflareResponse(models: CloudflareModelResult[]) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: models,
  };
}

function makeFetchImpl(opts: {
  status?: number;
  body?: unknown;
  throws?: boolean;
}): { fetch: typeof fetch; discordCalls: Array<{ url: string; body: unknown }> } {
  const discordCalls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('discord.com')) {
      discordCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response('ok', { status: 204 });
    }
    if (opts.throws) {
      throw new Error('network error');
    }
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, discordCalls };
}

// ============================================================
// Reset state
// ============================================================

beforeEach(() => {
  state.upsertCalls.length = 0;
  state.cronRunCalls.length = 0;
  state.existingModelIds.clear();
  state.upsertReturnInserted.clear();
  state.upsertShouldThrowFor.clear();
  state.staleResult = { deprecatedCount: 0, modelIds: [] };
  state.cronInsertShouldThrow = false;
  vi.clearAllMocks();
});

// ============================================================
// gating
// ============================================================

describe('isSyncWindow', () => {
  it('JST 04:00 ジャスト → true', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:00:00Z'))).toBe(true);
  });

  it('JST 04:04 → true (= 5 分窓内)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:04:00Z'))).toBe(true);
  });

  it('JST 04:05 → false (= 窓外)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T19:05:00Z'))).toBe(false);
  });

  it('JST 03:59 → false', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T18:59:00Z'))).toBe(false);
  });

  it('JST 12:00 (= 完全別時間) → false', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.isSyncWindow(new Date('2026-05-26T03:00:00Z'))).toBe(false);
  });
});

// ============================================================
// parseModelId
// ============================================================

describe('parseModelId', () => {
  it('@cf/meta/llama-4-scout-17b-16e-instruct', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.parseModelId('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(r).toEqual({ vendor: 'meta', family: 'llama', sizeLabel: '4-scout-17b-16e-instruct' });
  });

  it('@cf/google/gemma-4-26b-a4b-it', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.parseModelId('@cf/google/gemma-4-26b-a4b-it');
    expect(r).toEqual({ vendor: 'google', family: 'gemma', sizeLabel: '4-26b-a4b-it' });
  });

  it('@cf/qwen/qwen3-30b-a3b-fp8 (= qwen prefix を family に統合)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.parseModelId('@cf/qwen/qwen3-30b-a3b-fp8');
    expect(r).toEqual({ vendor: 'qwen', family: 'qwen', sizeLabel: '30b-a3b-fp8' });
  });

  it('@cf/openai/whisper (= size なし)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.parseModelId('@cf/openai/whisper');
    expect(r).toEqual({ vendor: 'openai', family: 'whisper', sizeLabel: null });
  });

  it('@cf/baai/bge-base-en-v1.5', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.parseModelId('@cf/baai/bge-base-en-v1.5');
    expect(r).toEqual({ vendor: 'baai', family: 'bge', sizeLabel: 'base-en-v1.5' });
  });
});

// ============================================================
// extractCapabilities / extractContextWindow
// ============================================================

describe('extractCapabilities', () => {
  it('text-generation task → ["text"]', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.extractCapabilities([], 'text-generation')).toEqual(['text']);
  });

  it('vision tag → ["text", "vision"]', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.extractCapabilities(['vision'], 'text-generation').sort()).toEqual([
      'text',
      'vision',
    ]);
  });

  it('beta tag は capabilities に含めない', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.extractCapabilities(['beta'], 'text-generation')).toEqual(['text']);
  });

  it('embedding task → ["embedding"]', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.extractCapabilities([], 'embedding')).toEqual(['embedding']);
  });

  it('multiple tags + speech task', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    const r = __test__.extractCapabilities(['multilingual', 'function-calling'], 'speech-to-text');
    expect(r.sort()).toEqual(['audio', 'function-calling', 'multilingual']);
  });
});

describe('extractContextWindow', () => {
  it('properties に context_window あれば返す (string)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(
      __test__.extractContextWindow([{ property_id: 'context_window', value: '32000' }]),
    ).toBe(32000);
  });

  it('properties に context_window あれば返す (number)', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(
      __test__.extractContextWindow([{ property_id: 'context_window', value: 131072 }]),
    ).toBe(131072);
  });

  it('properties undefined → null', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(__test__.extractContextWindow(undefined)).toBeNull();
  });

  it('context_window 不在 → null', async () => {
    const { __test__ } = await import('../services/ai-models-catalog.js');
    expect(
      __test__.extractContextWindow([{ property_id: 'other', value: 'x' }]),
    ).toBeNull();
  });
});

// ============================================================
// syncAiModelsCatalog
// ============================================================

describe('syncAiModelsCatalog — gating', () => {
  it('窓外 → triggered=false, skippedReason=window', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({});
    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
      },
      {
        now: new Date('2026-05-26T05:00:00+09:00'),
        fetchImpl: fi.fetch,
      },
    );
    expect(result.triggered).toBe(false);
    expect(result.skippedReason).toBe('window');
    expect(state.upsertCalls).toHaveLength(0);
    expect(state.cronRunCalls).toHaveLength(0);
  });

  it('窓内 + AI_MODELS_SYNC_FORCE=true → triggered=true 関係なく実行', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({ body: makeCloudflareResponse([]) });
    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      {
        now: new Date('2026-05-26T15:00:00+09:00'),
        fetchImpl: fi.fetch,
      },
    );
    expect(result.triggered).toBe(true);
    expect(result.fetched).toBe(0);
  });
});

describe('syncAiModelsCatalog — graceful secret missing', () => {
  it('CLOUDFLARE_ACCOUNT_ID 未設定 → skippedReason=account-missing + cron log', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({});
    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );
    expect(result.triggered).toBe(true);
    expect(result.skippedReason).toBe('account-missing');
    expect(state.cronRunCalls).toHaveLength(1);
    expect(state.cronRunCalls[0]?.status).toBe('skipped');
  });

  it('CLOUDFLARE_API_TOKEN 未設定 → skippedReason=token-missing', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({});
    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );
    expect(result.triggered).toBe(true);
    expect(result.skippedReason).toBe('token-missing');
    expect(state.cronRunCalls[0]?.status).toBe('skipped');
  });
});

describe('syncAiModelsCatalog — successful sync', () => {
  it('新規 model 1 件 → inserted=1, newModelIds に含む, cron success', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        {
          name: '@cf/meta/llama-4-scout-17b-16e-instruct',
          description: 'Llama 4 Scout',
          task: { name: 'Text Generation' },
          tags: ['multilingual'],
          properties: [{ property_id: 'context_window', value: '131072' }],
        },
      ]),
    });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.triggered).toBe(true);
    expect(result.fetched).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.newModelIds).toEqual(['@cf/meta/llama-4-scout-17b-16e-instruct']);
    expect(result.errors).toBe(0);

    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0]?.input).toMatchObject({
      modelId: '@cf/meta/llama-4-scout-17b-16e-instruct',
      vendor: 'meta',
      family: 'llama',
      task: 'text-generation',
      contextWindow: 131072,
      isBeta: false,
      source: 'sync',
    });
    expect(state.upsertCalls[0]?.input.capabilities.sort()).toEqual(['multilingual', 'text']);

    expect(state.cronRunCalls).toHaveLength(1);
    expect(state.cronRunCalls[0]).toMatchObject({
      jobName: 'ai-models-catalog-sync',
      status: 'success',
      metrics: { fetched: 1, inserted: 1, updated: 0, newlyDeprecated: 0, errors: 0 },
    });
  });

  it('既存 model (= existing in DB) は newModelIds に含まれない', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    state.existingModelIds.add('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    state.upsertReturnInserted.set('@cf/meta/llama-3.3-70b-instruct-fp8-fast', false);

    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        {
          name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          description: 'Llama 3.3 70B',
          task: { name: 'Text Generation' },
          tags: [],
        },
      ]),
    });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.fetched).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.newModelIds).toEqual([]);
  });

  it('beta tag → isBeta=true', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        {
          name: '@cf/meta/test-model',
          task: { name: 'Text Generation' },
          tags: ['beta', 'function-calling'],
        },
      ]),
    });

    await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(state.upsertCalls[0]?.input.isBeta).toBe(true);
  });

  it('Discord 通知 (= 新着あり) → discordCalls 1 件', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        {
          name: '@cf/meta/new-model-xyz',
          task: { name: 'Text Generation' },
        },
      ]),
    });

    await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/xxx/yyy',
        ACCOUNT_NAME: 'naturism',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(fi.discordCalls).toHaveLength(1);
    const body = fi.discordCalls[0]?.body as { content: string };
    expect(body.content).toContain('New Cloudflare AI model(s) detected');
    expect(body.content).toContain('@cf/meta/new-model-xyz');
    expect(body.content).toContain('naturism');
  });

  it('Discord webhook 未設定 → discordCalls 0 件', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        { name: '@cf/meta/new-model-xyz', task: { name: 'Text Generation' } },
      ]),
    });

    await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
        // DISCORD_WEBHOOK_URL 未設定
      },
      { fetchImpl: fi.fetch },
    );

    expect(fi.discordCalls).toHaveLength(0);
  });

  it('stale deprecated → newlyDeprecated > 0 + Discord 通知', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    state.staleResult = {
      deprecatedCount: 2,
      modelIds: ['@cf/old/model-1', '@cf/old/model-2'],
    };
    const fi = makeFetchImpl({ body: makeCloudflareResponse([]) });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/xxx/yyy',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.newlyDeprecated).toBe(2);
    expect(result.deprecatedModelIds).toEqual(['@cf/old/model-1', '@cf/old/model-2']);
    expect(fi.discordCalls).toHaveLength(1);
    const body = fi.discordCalls[0]?.body as { content: string };
    expect(body.content).toContain('marked deprecated');
    expect(body.content).toContain('@cf/old/model-1');
  });

  it('新着 + deprecated 同時 → Discord 1 通でまとめて通知', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    state.staleResult = { deprecatedCount: 1, modelIds: ['@cf/old/x'] };
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        { name: '@cf/new/y', task: { name: 'Text Generation' } },
      ]),
    });

    await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/xxx/yyy',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(fi.discordCalls).toHaveLength(1);
    const content = (fi.discordCalls[0]?.body as { content: string }).content;
    expect(content).toContain('New Cloudflare AI model(s) detected');
    expect(content).toContain('marked deprecated');
  });
});

describe('syncAiModelsCatalog — error handling', () => {
  it('API fetch throw → errors=1 + cron error 記録', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({ throws: true });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.triggered).toBe(true);
    expect(result.errors).toBe(1);
    expect(result.fetched).toBe(0);
    expect(state.cronRunCalls).toHaveLength(1);
    expect(state.cronRunCalls[0]?.status).toBe('error');
  });

  it('API 5xx → errors=1', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({ status: 503, body: { success: false } });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.errors).toBe(1);
    expect(state.cronRunCalls[0]?.status).toBe('error');
  });

  it('API success=false → errors=1', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({ body: { success: false, errors: [{ message: 'denied' }] } });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.errors).toBe(1);
  });

  it('一部 upsert 失敗 → errors > 0、 他 model は続行 + status=partial', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    state.upsertShouldThrowFor.add('@cf/bad/model');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        { name: '@cf/good/model', task: { name: 'Text Generation' } },
        { name: '@cf/bad/model', task: { name: 'Text Generation' } },
        { name: '@cf/good/model-2', task: { name: 'Text Generation' } },
      ]),
    });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.fetched).toBe(3);
    expect(result.inserted).toBe(2);
    expect(result.errors).toBe(1);
    expect(state.cronRunCalls[0]?.status).toBe('partial');
  });

  it('cron_run_logs insert 失敗 → 例外を throw しない (= fail-safe)', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    state.cronInsertShouldThrow = true;
    const fi = makeFetchImpl({ body: makeCloudflareResponse([]) });

    await expect(
      syncAiModelsCatalog(
        {
          DB: makeFakeDb(),
          CLOUDFLARE_ACCOUNT_ID: 'acc',
          CLOUDFLARE_API_TOKEN: 'tok',
          AI_MODELS_SYNC_FORCE: 'true',
        },
        { fetchImpl: fi.fetch },
      ),
    ).resolves.toBeDefined();
  });
});

describe('syncAiModelsCatalog — name skip', () => {
  it('name 未設定の result entry は skip (errors 加算しない)', async () => {
    const { syncAiModelsCatalog } = await import('../services/ai-models-catalog.js');
    const fi = makeFetchImpl({
      body: makeCloudflareResponse([
        { task: { name: 'Text Generation' } } as unknown as CloudflareModelResult,
        { name: '@cf/meta/valid', task: { name: 'Text Generation' } },
      ]),
    });

    const result = await syncAiModelsCatalog(
      {
        DB: makeFakeDb(),
        CLOUDFLARE_ACCOUNT_ID: 'acc',
        CLOUDFLARE_API_TOKEN: 'tok',
        AI_MODELS_SYNC_FORCE: 'true',
      },
      { fetchImpl: fi.fetch },
    );

    expect(result.fetched).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.errors).toBe(0);
  });
});
