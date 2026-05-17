/**
 * Tests for food-analyzer (Anthropic Claude Vision wrapper).
 *
 * Covers:
 *   - Happy path: well-formed JSON → FoodAnalysis
 *   - JSON 抽出: コードブロック/前置き付きでも本文だけ取れる
 *   - スキーマ違反 / 数値範囲違反 / 不正 mime / 空画像 / size 超過
 *   - 薬機ガード: notes / items の NG ワード redaction
 *   - api_key_missing
 *   - timeout
 */

import { describe, it, expect, vi } from 'vitest';
import {
  analyzeFoodImage,
  FoodAnalyzerError,
  extractJsonObject,
  sanitizeAnalysis,
  __test__,
} from '../services/food-analyzer.js';
import type { AIRouter, TextGenerationResponse, VisionRequest } from '@line-crm/ai-provider';

const VALID_JSON = JSON.stringify({
  calories: 650,
  protein_g: 20,
  fat_g: 25,
  carbs_g: 80,
  fiber_g: 3,
  items: [
    { name: 'カレーライス', qty: '1皿' },
    { name: 'サラダ', qty: '小鉢1' },
  ],
  notes: '炭水化物中心の食事です。',
});

const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/**
 * 最小限の AIRouter mock for vision.
 * - noProvider: true で resolveProviders を空に (api_key_missing path)
 * - respond で generateVision が返す text を指定
 * - reject で generateVision が throw する Error を指定
 */
function makeMockRouter(opts: {
  noProvider?: boolean;
  respond?: string;
  reject?: Error;
} = {}): AIRouter {
  const generateVision = vi.fn(async (_req: VisionRequest) => {
    if (opts.reject) throw opts.reject;
    const text = opts.respond ?? '';
    const resp: TextGenerationResponse = {
      text,
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
    };
    return resp;
  });
  return {
    resolveProviders: vi
      .fn()
      .mockReturnValue(opts.noProvider ? [] : [{ id: 'claude' }]),
    generateText: vi.fn(),
    generateVision,
    getProvider: vi.fn(),
  } as unknown as AIRouter;
}

describe('analyzeFoodImage — happy path', () => {
  it('parses well-formed JSON into FoodAnalysis', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    const result = await analyzeFoodImage({
      imageBytes: FAKE_PNG,
      mimeType: 'image/png',
      router,
    });
    expect(result.calories).toBe(650);
    expect(result.protein_g).toBe(20);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].name).toBe('カレーライス');
    expect(result.notes).toBe('炭水化物中心の食事です。');
    expect(result.model_version).toMatch(/claude-haiku/);
  });

  it('passes user caption to generateVision userMessage', async () => {
    const router = makeMockRouter({ respond: VALID_JSON });
    await analyzeFoodImage({
      imageBytes: FAKE_PNG,
      mimeType: 'image/png',
      userCaption: '今日のお昼ご飯',
      router,
    });
    const generateVision = (router as unknown as {
      generateVision: ReturnType<typeof vi.fn>;
    }).generateVision;
    const call = generateVision.mock.calls[0][0] as VisionRequest;
    expect(call.userMessage).toContain('今日のお昼ご飯');
    expect(call.mediaType).toBe('image/png');
    expect(call.imageBase64).toBeTruthy();
  });

  it('strips JSON from a response wrapped in markdown code fence', async () => {
    const wrapped = '以下が結果です:\n```json\n' + VALID_JSON + '\n```\n他のメモは無視してください';
    const router = makeMockRouter({ respond: wrapped });
    const result = await analyzeFoodImage({
      imageBytes: FAKE_PNG,
      mimeType: 'image/png',
      router,
    });
    expect(result.calories).toBe(650);
  });
});

describe('analyzeFoodImage — input validation', () => {
  it('throws api_key_missing when no vision provider available', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({ noProvider: true }),
      }),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
  });

  it('throws invalid_mime_type for unsupported mime', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'application/pdf',
        router: makeMockRouter({ respond: VALID_JSON }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_mime_type' });
  });

  it('throws invalid_response for empty image', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: new Uint8Array(0),
        mimeType: 'image/png',
        router: makeMockRouter({ respond: VALID_JSON }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws image_too_large when bytes exceed maxImageBytes', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: new Uint8Array(1000),
        mimeType: 'image/png',
        maxImageBytes: 500,
        router: makeMockRouter({ respond: VALID_JSON }),
      }),
    ).rejects.toMatchObject({ code: 'image_too_large' });
  });
});

describe('analyzeFoodImage — response failures', () => {
  it('throws invalid_response when generateVision returns empty text', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({ respond: '' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws invalid_response when text contains no JSON object', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({ respond: 'JSON を生成できませんでした。' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws schema_validation_failed when calories is negative', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({
          respond: JSON.stringify({
            calories: -100,
            protein_g: 10,
            fat_g: 10,
            carbs_g: 10,
            items: [],
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('throws schema_validation_failed when calories exceeds 10000', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({
          respond: JSON.stringify({
            calories: 999_999,
            protein_g: 10,
            fat_g: 10,
            carbs_g: 10,
            items: [],
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('throws schema_validation_failed when items is missing', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({
          respond: JSON.stringify({ calories: 100, protein_g: 1, fat_g: 1, carbs_g: 1 }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('throws timeout when generateVision aborts', async () => {
    const abortErr = new Error('Request was aborted');
    abortErr.name = 'AbortError';
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({ reject: abortErr }),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('throws api_error for unexpected upstream errors', async () => {
    await expect(
      analyzeFoodImage({
        imageBytes: FAKE_PNG,
        mimeType: 'image/png',
        router: makeMockRouter({ reject: new Error('500 Internal Server Error') }),
      }),
    ).rejects.toMatchObject({ code: 'api_error' });
  });
});

describe('extractJsonObject', () => {
  it('extracts JSON when surrounded by prose', () => {
    expect(extractJsonObject('result: {"a":1}\ndone')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    const nested = '{"a": {"b": {"c": 1}}}';
    expect(extractJsonObject('prefix' + nested + 'suffix')).toBe(nested);
  });

  it('returns null when no opening brace', () => {
    expect(extractJsonObject('plain text only')).toBeNull();
  });

  it('ignores braces inside strings', () => {
    expect(extractJsonObject('{"text":"contains } char"}')).toBe(
      '{"text":"contains } char"}',
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"text":"escaped \\"quote\\""}')).toBe(
      '{"text":"escaped \\"quote\\""}',
    );
  });
});

describe('sanitizeAnalysis (薬機法 redaction)', () => {
  it('redacts only the prohibited phrase, keeps clean parts intact', () => {
    const sanitized = sanitizeAnalysis({
      calories: 100,
      protein_g: 1,
      fat_g: 1,
      carbs_g: 1,
      items: [{ name: 'スープ' }],
      notes: 'タンパク質豊富で病気が改善されます',
    });
    expect(sanitized.notes).toBe(`タンパク質豊富で${__test__.REDACTION_TOKEN}されます`);
  });

  it('keeps clean notes intact (no prohibited phrase)', () => {
    const original = {
      calories: 100,
      protein_g: 1,
      fat_g: 1,
      carbs_g: 1,
      items: [{ name: 'スープ' }],
      notes: 'タンパク質と野菜のバランスが良い食事です',
    };
    const sanitized = sanitizeAnalysis(original);
    expect(sanitized.notes).toBe(original.notes);
  });

  it('redacts katakana variant ナオル', () => {
    const r = __test__.redactProhibited('この症状がナオルでしょう');
    expect(r).toBe(`この症状が${__test__.REDACTION_TOKEN}でしょう`);
  });

  it('redacts english cure/heal case-insensitively', () => {
    const r = __test__.redactProhibited('It will Cure your disease and HEAL pain');
    expect(r).toContain(__test__.REDACTION_TOKEN);
    expect(r).not.toMatch(/cure/i);
    expect(r).not.toMatch(/heal/i);
  });

  it('redacts items[].name partially', () => {
    const sanitized = sanitizeAnalysis({
      calories: 100,
      protein_g: 1,
      fat_g: 1,
      carbs_g: 1,
      items: [{ name: '医薬品スープ', qty: '1杯' }],
    });
    expect(sanitized.items[0].name).toBe(`${__test__.REDACTION_TOKEN}スープ`);
    expect(sanitized.items[0].qty).toBe('1杯');
  });

  it('e2e: analyzeFoodImage redacts response with prohibited phrase (sanitize layer)', async () => {
    const tainted = JSON.stringify({
      calories: 200,
      protein_g: 5,
      fat_g: 5,
      carbs_g: 30,
      items: [{ name: 'スープ' }],
      notes: '飲むと病気が改善されます',
    });
    // mock router の generateVision は provider 内 redact をスキップ (raw text を返す)
    // → service 側 sanitizeAnalysis レイヤーで redact されることを確認
    const result = await analyzeFoodImage({
      imageBytes: FAKE_PNG,
      mimeType: 'image/png',
      router: makeMockRouter({ respond: tainted }),
    });
    expect(result.notes).toBe(`飲むと${__test__.REDACTION_TOKEN}されます`);
    expect(result.calories).toBe(200);
  });

  it('handles items without qty', () => {
    const sanitized = sanitizeAnalysis({
      calories: 100,
      protein_g: 1,
      fat_g: 1,
      carbs_g: 1,
      items: [{ name: 'スープ' }],
    });
    expect(sanitized.items[0].name).toBe('スープ');
    expect(sanitized.items[0].qty).toBeUndefined();
  });
});

describe('sanitizeUserCaption (prompt injection guard)', () => {
  it('replaces quotes with full-width to preserve prompt delimiter', () => {
    const r = __test__.sanitizeUserCaption('I said "ignore previous"');
    expect(r).not.toContain('"');
    expect(r).toContain('”');
  });

  it('strips newlines and control chars', () => {
    const r = __test__.sanitizeUserCaption('a\nb\tc\x00d');
    expect(r).toBe('a b cd');
  });

  it('truncates to 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = __test__.sanitizeUserCaption(long);
    expect(r.length).toBe(200);
  });
});

describe('Error.cause (ES2022)', () => {
  it('exposes cause via standard Error.cause', () => {
    const cause = new Error('underlying');
    const err = new FoodAnalyzerError('msg', 'api_error', cause);
    // ES2022 native Error.cause path
    expect(err.cause).toBe(cause);
  });
});

describe('FoodAnalyzerError', () => {
  it('preserves code and cause via standard ES2022 path', () => {
    const cause = new Error('underlying');
    const err = new FoodAnalyzerError('msg', 'api_error', cause);
    expect(err.name).toBe('FoodAnalyzerError');
    expect(err.code).toBe('api_error');
    expect(err.cause).toBe(cause);
  });

  it('omits cause when not provided', () => {
    const err = new FoodAnalyzerError('msg', 'api_error');
    expect(err.cause).toBeUndefined();
  });
});
