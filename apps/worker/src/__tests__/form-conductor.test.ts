/**
 * Tests for form-conductor (Phase 5γ-3: AI Conductor — Form Generator).
 *
 * scenario-conductor / rich-menu-conductor と同じ mock router パターン。
 * forms 固有の検証 (snake_case name / unique name / options 必須) を中心にカバー。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateFormFromPrompt,
  FormConductorError,
  __test__,
} from '../services/form-conductor.js';
import type {
  AIRouter,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@line-crm/ai-provider';

// ============================================================
// Fixtures
// ============================================================

const VALID_FORM = {
  name: '商品アンケート',
  description: '新商品の感想をお聞かせください',
  fields: [
    {
      name: 'email',
      label: 'メールアドレス',
      type: 'email',
      required: true,
      placeholder: 'name@example.com',
    },
    {
      name: 'age_range',
      label: '年齢層',
      type: 'select',
      required: true,
      options: [
        { value: '20s', label: '20代' },
        { value: '30s', label: '30代' },
        { value: '40s', label: '40代' },
      ],
    },
    {
      name: 'comment',
      label: 'ご感想',
      type: 'textarea',
      placeholder: 'ご自由にお書きください',
    },
  ],
  onSubmitTagId: null,
  onSubmitScenarioId: null,
  saveToMetadata: true,
  isActive: false,
};

const VALID_JSON = JSON.stringify(VALID_FORM);

// ============================================================
// Helpers
// ============================================================

function makeMockRouter(opts: {
  noProvider?: boolean;
  respond?: string;
  reject?: Error;
} = {}): AIRouter {
  const generateText = vi.fn(async (_req: TextGenerationRequest) => {
    if (opts.reject) throw opts.reject;
    return {
      text: opts.respond ?? '',
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
    } as TextGenerationResponse;
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

describe('generateFormFromPrompt — happy path', () => {
  it('parses well-formed form JSON', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    const result = await generateFormFromPrompt({
      prompt: '商品アンケートを作って (メール + 年代 + 感想)',
      router,
    });
    expect(result.form.name).toBe('商品アンケート');
    expect(result.form.fields).toHaveLength(3);
    expect(result.form.fields[0].type).toBe('email');
    expect(result.form.fields[1].type).toBe('select');
    expect(result.form.fields[1].options).toHaveLength(3);
    expect(result.form.fields[2].type).toBe('textarea');
    expect(result.warnings).toEqual([]);
  });

  it('defaults isActive/saveToMetadata when AI omits them', async () => {
    const minimal = {
      name: 'minimal',
      fields: [{ name: 'q1', label: '質問1', type: 'text' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(minimal) });
    const result = await generateFormFromPrompt({
      prompt: '最小フォーム',
      router,
    });
    expect(result.form.isActive).toBe(false);
    expect(result.form.saveToMetadata).toBe(false);
    expect(result.form.onSubmitTagId).toBeNull();
    expect(result.form.onSubmitScenarioId).toBeNull();
  });

  it('uses scenario-gen task on AIRouter', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await generateFormFromPrompt({ prompt: 'フォームを作る', router });
    const generateText = (router as unknown as {
      generateText: ReturnType<typeof vi.fn>;
    }).generateText;
    expect(generateText.mock.calls[0][0]).toBe('scenario-gen');
  });
});

// ============================================================
// Validation: input
// ============================================================

describe('generateFormFromPrompt — input validation', () => {
  it('throws prompt_too_short', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await expect(
      generateFormFromPrompt({ prompt: 'hi', router }),
    ).rejects.toMatchObject({ code: 'prompt_too_short' });
  });

  it('throws prompt_too_long', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await expect(
      generateFormFromPrompt({ prompt: 'a'.repeat(4001), router }),
    ).rejects.toMatchObject({ code: 'prompt_too_long' });
  });

  it('throws api_key_missing when no provider', async () => {
    const router = makeMockRouter({ noProvider: true });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
  });
});

// ============================================================
// Validation: schema
// ============================================================

describe('generateFormFromPrompt — schema constraints', () => {
  it('rejects field.name in non-snake_case (camelCase)', async () => {
    const bad = {
      name: 'x',
      fields: [{ name: 'emailAddress', label: 'メール', type: 'email' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects field.name starting with digit', async () => {
    const bad = {
      name: 'x',
      fields: [{ name: '1st_question', label: 'q', type: 'text' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects unknown field.type', async () => {
    const bad = {
      name: 'x',
      fields: [{ name: 'q1', label: 'q', type: 'password' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects select field without options', async () => {
    const bad = {
      name: 'x',
      fields: [{ name: 'gender', label: '性別', type: 'select' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toThrow(/requires non-empty options/);
  });

  it('rejects radio field with empty options array', async () => {
    const bad = {
      name: 'x',
      fields: [{ name: 'gender', label: '性別', type: 'radio', options: [] }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects empty fields array', async () => {
    const bad = { name: 'x', fields: [] };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects duplicate field.name', async () => {
    const bad = {
      name: 'x',
      fields: [
        { name: 'q1', label: 'q1', type: 'text' },
        { name: 'q1', label: 'q1 duplicate', type: 'text' },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toThrow(/duplicate field\.name/);
  });
});

// ============================================================
// 薬機 redaction
// ============================================================

describe('generateFormFromPrompt — 薬機 redaction', () => {
  it('redacts prohibited phrases in name / description / field.label / placeholder / option.label', async () => {
    const dirty = {
      name: 'がんが消える商品アンケート',
      description: 'この商品で治療できる方を募集',
      fields: [
        {
          name: 'experience',
          label: '症状が消える経験はありますか',
          type: 'select',
          options: [
            { value: 'yes', label: '完治した' },
            { value: 'no', label: 'なし' },
          ],
        },
        {
          name: 'name',
          label: 'お名前',
          type: 'text',
          placeholder: '医薬品ユーザの方歓迎',
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateFormFromPrompt({
      prompt: 'フォーム生成',
      router,
    });
    expect(result.form.name).toContain('[省略]');
    expect(result.form.description).toContain('[省略]');
    expect(result.form.fields[0].label).toContain('[省略]');
    expect(result.form.fields[0].options?.[0].label).toContain('[省略]');
    expect(result.form.fields[1].placeholder).toContain('[省略]');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does NOT redact field.name (snake_case 制約があるため NG ワード混入リスクなし)', async () => {
    const cleanForm = {
      name: 'test',
      fields: [{ name: 'medical_history', label: '病歴', type: 'text' }],
    };
    const router = makeMockRouter({ respond: JSON.stringify(cleanForm) });
    const result = await generateFormFromPrompt({
      prompt: 'フォーム生成',
      router,
    });
    expect(result.form.fields[0].name).toBe('medical_history');
  });
});

// ============================================================
// Error handling
// ============================================================

describe('generateFormFromPrompt — error handling', () => {
  it('maps AbortError to timeout', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const router = makeMockRouter({ reject: err });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('throws invalid_response on non-JSON output', async () => {
    const router = makeMockRouter({ respond: 'plain text no braces' });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws api_error on generic AI failure', async () => {
    const router = makeMockRouter({ reject: new Error('Network error') });
    await expect(
      generateFormFromPrompt({ prompt: 'フォーム生成', router }),
    ).rejects.toMatchObject({ code: 'api_error' });
  });
});

// ============================================================
// Internal helpers
// ============================================================

describe('validateUniqueFieldNames', () => {
  it('passes when all names are unique', () => {
    const fields = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(() => __test__.validateUniqueFieldNames(fields)).not.toThrow();
  });

  it('throws on duplicate names', () => {
    const fields = [{ name: 'a' }, { name: 'b' }, { name: 'a' }];
    expect(() => __test__.validateUniqueFieldNames(fields)).toThrow(/duplicate/);
  });
});

describe('FormConductorError', () => {
  it('exposes code property', () => {
    const err = new FormConductorError('test', 'invalid_response');
    expect(err.code).toBe('invalid_response');
    expect(err.name).toBe('FormConductorError');
  });
});
