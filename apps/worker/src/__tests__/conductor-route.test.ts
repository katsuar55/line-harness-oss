/**
 * Tests for routes/conductor.ts (Phase 5γ-1: AI Conductor route).
 *
 * service (scenario-conductor) 自体の挙動は scenario-conductor.test.ts で検証済。
 * ここでは route 層 (Hono + auth + body 検証 + error code → HTTP status mapping) のみを担当。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ----- DB mock (authMiddleware 内で staff lookup が走るため) -----
vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async () => null),
  };
});

// ----- LINE SDK mock (auth で signature 検証経路は通らないが念のため) -----
vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
  },
}));

// ----- service mock (route の HTTP mapping のみテストするため) -----
vi.mock('../services/scenario-conductor.js', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('../services/scenario-conductor.js');
  return {
    ...orig,
    generateScenarioFromPrompt: vi.fn(),
  };
});

vi.mock('../services/rich-menu-conductor.js', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('../services/rich-menu-conductor.js');
  return {
    ...orig,
    generateRichMenuFromPrompt: vi.fn(),
  };
});

// ----- ai-router-factory mock (env 由来の AIRouter 構築は不要) -----
vi.mock('../services/ai-router-factory.js', () => ({
  createAIRouterFromEnv: vi.fn(() => ({})),
}));

import { authMiddleware } from '../middleware/auth.js';
import conductor from '../routes/conductor.js';
import {
  generateScenarioFromPrompt,
  ScenarioConductorError,
} from '../services/scenario-conductor.js';
import {
  generateRichMenuFromPrompt,
  RichMenuConductorError,
} from '../services/rich-menu-conductor.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-conductor-12345';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: createMockDb(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-ch',
    LINE_LOGIN_CHANNEL_ID: 'login-ch',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', conductor);
  return app;
}

const VALID_RESULT = {
  scenario: {
    name: 'test',
    description: null,
    triggerType: 'manual',
    triggerTagId: null,
    isActive: false,
  },
  steps: [
    {
      stepOrder: 1,
      delayMinutes: 0,
      messageType: 'text',
      messageContent: 'hello',
      channel: 'line',
      conditionType: null,
      conditionValue: null,
    },
  ],
  warnings: [],
  provider: 'claude',
  model: 'claude-haiku-4-5',
};

describe('POST /api/conductor/scenario — authentication', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 401 without auth header', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/conductor/scenario — body validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      { method: 'POST', headers: authHeaders(), body: 'not json{' },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/JSON/i);
  });

  it('returns 400 when prompt missing', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt is empty string', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt: '' }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt is non-string type', async () => {
    const res = await app.request(
      '/api/conductor/scenario',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt: 123 }) },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/conductor/scenario — service error → HTTP mapping', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];
  const mockedGenerate = generateScenarioFromPrompt as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 200 on success', async () => {
    mockedGenerate.mockResolvedValueOnce(VALID_RESULT);
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: '新規友だちに welcome シナリオ' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(VALID_RESULT);
  });

  it('maps prompt_too_short to 400', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ScenarioConductorError('too short', 'prompt_too_short'),
    );
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'hi' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; code: string };
    expect(body.code).toBe('prompt_too_short');
  });

  it('maps api_key_missing to 503', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ScenarioConductorError('no provider', 'api_key_missing'),
    );
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'シナリオ生成' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('maps timeout to 504', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ScenarioConductorError('timed out', 'timeout'),
    );
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'シナリオ生成' }),
      },
      env,
    );
    expect(res.status).toBe(504);
  });

  it('maps invalid_response to 502', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ScenarioConductorError('not json', 'invalid_response'),
    );
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'シナリオ生成' }),
      },
      env,
    );
    expect(res.status).toBe(502);
  });

  it('maps schema_validation_failed to 502', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ScenarioConductorError('schema fail', 'schema_validation_failed'),
    );
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'シナリオ生成' }),
      },
      env,
    );
    expect(res.status).toBe(502);
  });

  it('maps unknown error to 500', async () => {
    mockedGenerate.mockRejectedValueOnce(new Error('unexpected'));
    const res = await app.request(
      '/api/conductor/scenario',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'シナリオ生成' }),
      },
      env,
    );
    expect(res.status).toBe(500);
  });
});

// ============================================================
// Phase 5γ-2: rich menu route
// ============================================================

const VALID_RICH_MENU_RESULT = {
  richMenu: {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: 'main',
    chatBarText: 'メニュー',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 2500, height: 1686 },
        action: { type: 'message', text: 'hello' },
      },
    ],
  },
  warnings: [],
  provider: 'claude',
  model: 'claude-haiku-4-5',
};

describe('POST /api/conductor/rich-menu — authentication', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 401 without auth header', async () => {
    const res = await app.request(
      '/api/conductor/rich-menu',
      { method: 'POST', body: JSON.stringify({ prompt: 'hello' }) },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/conductor/rich-menu — body validation', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 400 for malformed JSON body', async () => {
    const res = await app.request(
      '/api/conductor/rich-menu',
      { method: 'POST', headers: authHeaders(), body: 'not json{' },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when prompt missing', async () => {
    const res = await app.request(
      '/api/conductor/rich-menu',
      { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/conductor/rich-menu — service error → HTTP mapping', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];
  const mockedGenerateRm = generateRichMenuFromPrompt as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  it('returns 200 on success', async () => {
    mockedGenerateRm.mockResolvedValueOnce(VALID_RICH_MENU_RESULT);
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'ショップへのメニュー' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(VALID_RICH_MENU_RESULT);
  });

  it('maps prompt_too_short to 400', async () => {
    mockedGenerateRm.mockRejectedValueOnce(
      new RichMenuConductorError('too short', 'prompt_too_short'),
    );
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'hi' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('prompt_too_short');
  });

  it('maps api_key_missing to 503', async () => {
    mockedGenerateRm.mockRejectedValueOnce(
      new RichMenuConductorError('no provider', 'api_key_missing'),
    );
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'メニュー' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });

  it('maps timeout to 504', async () => {
    mockedGenerateRm.mockRejectedValueOnce(
      new RichMenuConductorError('timed out', 'timeout'),
    );
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'メニュー' }),
      },
      env,
    );
    expect(res.status).toBe(504);
  });

  it('maps schema_validation_failed to 502', async () => {
    mockedGenerateRm.mockRejectedValueOnce(
      new RichMenuConductorError('bad', 'schema_validation_failed'),
    );
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'メニュー' }),
      },
      env,
    );
    expect(res.status).toBe(502);
  });

  it('maps unknown error to 500', async () => {
    mockedGenerateRm.mockRejectedValueOnce(new Error('unexpected'));
    const res = await app.request(
      '/api/conductor/rich-menu',
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: 'メニュー' }),
      },
      env,
    );
    expect(res.status).toBe(500);
  });
});
