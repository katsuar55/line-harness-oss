/**
 * Tests for scenario-conductor (Phase 5γ-1: AI Conductor — Scenario Generator).
 *
 * Covers:
 *   - Happy path: well-formed JSON → ConductorScenarioOutput
 *   - JSON 抽出: コードフェンス / 前置き付きでも JSON 本文だけ取れる
 *   - Zod schema 違反 / step ordering 不整合
 *   - 薬機ガード: scenario.name / description / step.messageContent の redaction
 *   - api_key_missing (provider 不在)
 *   - prompt 検証 (短すぎ / 長すぎ)
 *   - timeout
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateScenarioFromPrompt,
  ScenarioConductorError,
  extractJsonObject,
  __test__,
} from '../services/scenario-conductor.js';
import type {
  AIRouter,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@line-crm/ai-provider';

// ============================================================
// Fixtures
// ============================================================

const VALID_OUTPUT = {
  scenario: {
    name: '新規友だち welcome 3 step',
    description: '友だち追加直後 → 1 時間後 → 24 時間後の welcome シナリオ',
    triggerType: 'friend_add',
    triggerTagId: null,
    isActive: false,
  },
  steps: [
    {
      stepOrder: 1,
      delayMinutes: 0,
      messageType: 'text',
      messageContent: 'はじめまして、 {{name}} さん。 {{brand_name}} です。',
      channel: 'line',
      conditionType: null,
      conditionValue: null,
    },
    {
      stepOrder: 2,
      delayMinutes: 60,
      messageType: 'text',
      messageContent: '{{brand_name}} の商品ラインナップをご紹介します。',
      channel: 'line',
      conditionType: null,
      conditionValue: null,
    },
    {
      stepOrder: 3,
      delayMinutes: 24 * 60,
      messageType: 'text',
      messageContent: '昨日に続いて、 サポート体制のご紹介です。',
      channel: 'line',
      conditionType: null,
      conditionValue: null,
    },
  ],
};

const VALID_JSON = JSON.stringify(VALID_OUTPUT);

// ============================================================
// Helpers
// ============================================================

/**
 * 最小限の AIRouter mock.
 *   - noProvider: true で resolveProviders を空に (api_key_missing path)
 *   - respond で generateText が返す text を指定
 *   - reject で generateText が throw する Error を指定
 */
function makeMockRouter(opts: {
  noProvider?: boolean;
  respond?: string;
  reject?: Error;
  provider?: string;
  model?: string;
} = {}): AIRouter {
  const generateText = vi.fn(async (_req: TextGenerationRequest) => {
    if (opts.reject) throw opts.reject;
    const text = opts.respond ?? '';
    const resp: TextGenerationResponse = {
      text,
      provider: (opts.provider ?? 'claude') as TextGenerationResponse['provider'],
      model: opts.model ?? 'claude-haiku-4-5-20251001',
    };
    return resp;
  });
  return {
    resolveProviders: vi
      .fn()
      .mockReturnValue(opts.noProvider ? [] : [{ id: 'claude' }]),
    generateText,
    generateVision: vi.fn(),
    getProvider: vi.fn(),
  } as unknown as AIRouter;
}

// ============================================================
// Happy path
// ============================================================

describe('generateScenarioFromPrompt — happy path', () => {
  it('parses well-formed JSON into scenario + steps', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    const result = await generateScenarioFromPrompt({
      prompt: '新規友だちに 3 step で welcome シナリオを作って',
      router,
    });
    expect(result.scenario.name).toBe('新規友だち welcome 3 step');
    expect(result.scenario.triggerType).toBe('friend_add');
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].messageContent).toContain('{{name}}');
    expect(result.steps[0].messageContent).toContain('{{brand_name}}');
    expect(result.warnings).toEqual([]);
    expect(result.provider).toBe('claude');
    expect(result.model).toMatch(/claude-haiku/);
  });

  it('passes prompt to generateText userMessage and uses scenario-gen task', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await generateScenarioFromPrompt({
      prompt: 'テストプロンプト 12345',
      router,
    });
    const generateText = (router as unknown as {
      generateText: ReturnType<typeof vi.fn>;
    }).generateText;
    expect(generateText.mock.calls).toHaveLength(1);
    const [task, req] = generateText.mock.calls[0];
    expect(task).toBe('scenario-gen');
    expect((req as TextGenerationRequest).userMessage).toContain('テストプロンプト 12345');
    expect((req as TextGenerationRequest).systemPrompt).toBeTruthy();
  });

  it('defaults isActive to false and triggerTagId to null when AI omits them', async () => {
    const minimal = {
      scenario: { name: 'minimal', triggerType: 'manual' },
      steps: [
        { stepOrder: 1, delayMinutes: 0, messageType: 'text', messageContent: 'hello' },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(minimal) });
    const result = await generateScenarioFromPrompt({
      prompt: 'manual broadcast の最小例',
      router,
    });
    expect(result.scenario.isActive).toBe(false);
    expect(result.scenario.triggerTagId).toBeNull();
    expect(result.steps[0].channel).toBe('line');
  });
});

// ============================================================
// JSON extraction
// ============================================================

describe('extractJsonObject', () => {
  it('extracts JSON when wrapped in code fence with prefix', () => {
    const wrapped = `Here's your scenario:\n\`\`\`json\n${VALID_JSON}\n\`\`\``;
    const extracted = extractJsonObject(wrapped);
    expect(extracted).toBeTruthy();
    const parsed = JSON.parse(extracted!);
    expect(parsed.scenario.name).toBe('新規友だち welcome 3 step');
  });

  it('returns null when no opening brace found', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('handles nested braces in messageContent strings', () => {
    const nested = JSON.stringify({
      scenario: { name: 'nested', triggerType: 'manual' },
      steps: [
        {
          stepOrder: 1,
          delayMinutes: 0,
          messageType: 'flex',
          messageContent: '{"type":"box","contents":[{"type":"text","text":"hi"}]}',
        },
      ],
    });
    const extracted = extractJsonObject(`preamble ${nested} trailing`);
    expect(extracted).toBeTruthy();
    expect(JSON.parse(extracted!)).toBeTruthy();
  });

  it('ignores braces inside double-quoted strings', () => {
    const text = '{"key": "value with } brace inside"}';
    const extracted = extractJsonObject(text);
    expect(extracted).toBe(text);
  });
});

describe('generateScenarioFromPrompt — JSON extraction in AI response', () => {
  it('handles AI response wrapped in markdown code fence', async () => {
    const wrapped = `以下のシナリオを生成しました:\n\`\`\`json\n${VALID_JSON}\n\`\`\``;
    const router = makeMockRouter({ respond: wrapped });
    const result = await generateScenarioFromPrompt({
      prompt: 'シナリオ生成テスト',
      router,
    });
    expect(result.scenario.name).toBe('新規友だち welcome 3 step');
  });
});

// ============================================================
// Validation errors
// ============================================================

describe('generateScenarioFromPrompt — input validation', () => {
  it('throws prompt_too_short for prompt under 5 chars', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await expect(
      generateScenarioFromPrompt({ prompt: 'hi', router }),
    ).rejects.toMatchObject({
      name: 'ScenarioConductorError',
      code: 'prompt_too_short',
    });
  });

  it('throws prompt_too_long for prompt over 4000 chars', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    const huge = 'a'.repeat(4001);
    await expect(
      generateScenarioFromPrompt({ prompt: huge, router }),
    ).rejects.toMatchObject({
      name: 'ScenarioConductorError',
      code: 'prompt_too_long',
    });
  });

  it('throws api_key_missing when no scenario-gen provider available', async () => {
    const router = makeMockRouter({ noProvider: true });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      name: 'ScenarioConductorError',
      code: 'api_key_missing',
    });
  });
});

// ============================================================
// Schema / parse errors
// ============================================================

describe('generateScenarioFromPrompt — response validation', () => {
  it('throws invalid_response when AI returns text without JSON', async () => {
    const router = makeMockRouter({ respond: 'just plain text no braces' });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('throws invalid_response when JSON parse fails', async () => {
    const router = makeMockRouter({ respond: '{ invalid json,,, }' });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('throws schema_validation_failed when shape is wrong', async () => {
    const router = makeMockRouter({ respond: '{"foo": "bar"}' });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'schema_validation_failed',
    });
  });

  it('throws schema_validation_failed when triggerType is invalid', async () => {
    const bad = {
      scenario: { name: 'x', triggerType: 'invalid_trigger' },
      steps: [{ stepOrder: 1, delayMinutes: 0, messageType: 'text', messageContent: 'hi' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'schema_validation_failed',
    });
  });

  it('throws schema_validation_failed when stepOrder is not contiguous', async () => {
    const bad = {
      scenario: { name: 'x', triggerType: 'manual' },
      steps: [
        { stepOrder: 1, delayMinutes: 0, messageType: 'text', messageContent: 'first' },
        { stepOrder: 3, delayMinutes: 0, messageType: 'text', messageContent: 'third' },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toThrow(/contiguous/);
  });
});

// ============================================================
// 薬機 redaction
// ============================================================

describe('generateScenarioFromPrompt — 薬機 redaction', () => {
  it('redacts prohibited phrases in messageContent and reports in warnings', async () => {
    const dirty = {
      scenario: { name: '完治シナリオ', triggerType: 'manual' },
      steps: [
        {
          stepOrder: 1,
          delayMinutes: 0,
          messageType: 'text',
          messageContent: 'この商品で症状が消えるはずです',
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateScenarioFromPrompt({
      prompt: 'シナリオを生成',
      router,
    });
    expect(result.scenario.name).toContain('[省略]');
    expect(result.steps[0].messageContent).toContain('[省略]');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Detected/);
    expect(result.warnings[0]).toMatch(/完治/);
  });

  it('leaves clean content untouched and reports no warnings', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    const result = await generateScenarioFromPrompt({
      prompt: 'クリーンなシナリオを生成',
      router,
    });
    expect(result.warnings).toEqual([]);
    expect(result.scenario.name).not.toContain('[省略]');
  });
});

// ============================================================
// Timeout / API error
// ============================================================

describe('generateScenarioFromPrompt — error handling', () => {
  it('maps AbortError to timeout code', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const router = makeMockRouter({ reject: err });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('maps generic AI error to api_error code', async () => {
    const router = makeMockRouter({ reject: new Error('Anthropic API 503') });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'api_error',
    });
  });

  it('throws invalid_response when AI returns empty text', async () => {
    const router = makeMockRouter({ respond: '' });
    await expect(
      generateScenarioFromPrompt({ prompt: 'シナリオを生成', router }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

// ============================================================
// Internal helpers (unit tests of __test__ exports)
// ============================================================

describe('sanitizeUserPrompt', () => {
  it('replaces control characters and newlines with spaces', () => {
    const out = __test__.sanitizeUserPrompt('hello\nworld\ttab');
    expect(out).toBe('hello world tab');
  });

  it('replaces double quotes with full-width quotes', () => {
    const out = __test__.sanitizeUserPrompt('say "hello"');
    expect(out).toContain('”');
    expect(out).not.toContain('"');
  });

  it('truncates to PROMPT_MAX_LEN', () => {
    const huge = 'a'.repeat(5000);
    const out = __test__.sanitizeUserPrompt(huge);
    expect(out.length).toBe(__test__.PROMPT_MAX_LEN);
  });
});

describe('ScenarioConductorError', () => {
  it('exposes code property', () => {
    const err = new ScenarioConductorError('test', 'prompt_too_short');
    expect(err.code).toBe('prompt_too_short');
    expect(err.name).toBe('ScenarioConductorError');
  });

  it('chains cause via ES2022 Error.cause', () => {
    const cause = new Error('inner');
    const err = new ScenarioConductorError('outer', 'api_error', cause);
    expect((err as Error & { cause?: unknown }).cause).toBe(cause);
  });
});
