/**
 * Tests for rich-menu-conductor (Phase 5γ-2: AI Conductor — Rich Menu Generator).
 *
 * scenario-conductor.test.ts と同じパターン (mock router + valid/invalid JSON 検証)
 * を rich menu 用に適用。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateRichMenuFromPrompt,
  RichMenuConductorError,
  __test__,
} from '../services/rich-menu-conductor.js';
import type {
  AIRouter,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@line-crm/ai-provider';

// ============================================================
// Fixtures
// ============================================================

const VALID_LARGE_RICH_MENU = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'メインメニュー (大)',
  chatBarText: 'メニュー',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 1250, height: 843 },
      action: { type: 'postback', data: 'action=shop&brand={{brand_name}}' },
    },
    {
      bounds: { x: 1250, y: 0, width: 1250, height: 843 },
      action: { type: 'uri', uri: 'https://example.com/contact' },
    },
    {
      bounds: { x: 0, y: 843, width: 1250, height: 843 },
      action: { type: 'message', text: 'クーポンを見たい' },
    },
    {
      bounds: { x: 1250, y: 843, width: 1250, height: 843 },
      action: {
        type: 'richmenuswitch',
        richMenuAliasId: 'sub-menu',
        data: 'switch_to=sub',
      },
    },
  ],
};

const VALID_LARGE_JSON = JSON.stringify(VALID_LARGE_RICH_MENU);

const VALID_SMALL_RICH_MENU = {
  size: { width: 2500, height: 843 },
  selected: true,
  name: 'コンパクト',
  chatBarText: '開く',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 833, height: 843 },
      action: { type: 'message', text: 'shop' },
    },
    {
      bounds: { x: 833, y: 0, width: 834, height: 843 },
      action: { type: 'message', text: 'support' },
    },
    {
      bounds: { x: 1667, y: 0, width: 833, height: 843 },
      action: { type: 'message', text: 'about' },
    },
  ],
};

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
    generateText,
    generateVision: vi.fn(),
    getProvider: vi.fn(),
  } as unknown as AIRouter;
}

// ============================================================
// Happy path
// ============================================================

describe('generateRichMenuFromPrompt — happy path', () => {
  it('parses LARGE rich menu (2500x1686) JSON', async () => {
    const router = makeMockRouter({ respond: VALID_LARGE_JSON });
    const result = await generateRichMenuFromPrompt({
      prompt: '商品ショップへの遷移とサポートのリッチメニュー',
      router,
    });
    expect(result.richMenu.size.width).toBe(2500);
    expect(result.richMenu.size.height).toBe(1686);
    expect(result.richMenu.areas).toHaveLength(4);
    expect(result.richMenu.chatBarText).toBe('メニュー');
    expect(result.warnings).toEqual([]);
    expect(result.provider).toBe('claude');
  });

  it('accepts SMALL rich menu (2500x843)', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_SMALL_RICH_MENU) });
    const result = await generateRichMenuFromPrompt({
      prompt: '小さめメニュー',
      router,
    });
    expect(result.richMenu.size.height).toBe(843);
    expect(result.richMenu.areas).toHaveLength(3);
  });

  it('passes scenario-gen task to AIRouter (rich menu shares this task)', async () => {
    const router = makeMockRouter({ respond: VALID_LARGE_JSON });
    await generateRichMenuFromPrompt({
      prompt: 'リッチメニューを作って',
      router,
    });
    const generateText = (router as unknown as {
      generateText: ReturnType<typeof vi.fn>;
    }).generateText;
    const [task] = generateText.mock.calls[0];
    expect(task).toBe('scenario-gen');
  });
});

// ============================================================
// Validation
// ============================================================

describe('generateRichMenuFromPrompt — input validation', () => {
  it('throws prompt_too_short', async () => {
    const router = makeMockRouter({ respond: VALID_LARGE_JSON });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'hi', router }),
    ).rejects.toMatchObject({ code: 'prompt_too_short' });
  });

  it('throws prompt_too_long', async () => {
    const router = makeMockRouter({ respond: VALID_LARGE_JSON });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'a'.repeat(4001), router }),
    ).rejects.toMatchObject({ code: 'prompt_too_long' });
  });

  it('throws api_key_missing when no provider', async () => {
    const router = makeMockRouter({ noProvider: true });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
  });
});

// ============================================================
// Schema constraints
// ============================================================

describe('generateRichMenuFromPrompt — schema constraints', () => {
  it('rejects non-LARGE/non-SMALL size', async () => {
    const bad = { ...VALID_LARGE_RICH_MENU, size: { width: 1000, height: 500 } };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toThrow(/size must be 2500/);
  });

  it('rejects chatBarText over 14 chars', async () => {
    const bad = { ...VALID_LARGE_RICH_MENU, chatBarText: '15文字以上のチャットバーテキスト' };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects empty areas array', async () => {
    const bad = { ...VALID_LARGE_RICH_MENU, areas: [] };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects unknown action type', async () => {
    const bad = {
      ...VALID_LARGE_RICH_MENU,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          action: { type: 'datetimepicker', data: 'x', mode: 'date' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects area bounds extending beyond size', async () => {
    const bad = {
      ...VALID_LARGE_RICH_MENU,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 3000, height: 100 },
          action: { type: 'message', text: 'oversized' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toThrow(/extends beyond size/);
  });

  it('rejects overlapping areas', async () => {
    const bad = {
      ...VALID_LARGE_RICH_MENU,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1500, height: 1000 },
          action: { type: 'message', text: 'a' },
        },
        {
          bounds: { x: 1000, y: 500, width: 1000, height: 1000 },
          action: { type: 'message', text: 'b' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toThrow(/overlap/);
  });

  it('rejects uri action with invalid URL', async () => {
    const bad = {
      ...VALID_LARGE_RICH_MENU,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          action: { type: 'uri', uri: 'not a url' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });
});

// ============================================================
// 薬機 redaction
// ============================================================

describe('generateRichMenuFromPrompt — 薬機 redaction', () => {
  it('redacts prohibited phrases in name / chatBarText / action.text', async () => {
    const dirty = {
      ...VALID_LARGE_RICH_MENU,
      name: 'がんが消えるメニュー',
      chatBarText: '完治',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 2500, height: 1686 },
          action: { type: 'message', text: '症状が消える商品はこちら' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateRichMenuFromPrompt({
      prompt: 'リッチメニュー生成',
      router,
    });
    expect(result.richMenu.name).toContain('[省略]');
    expect(result.richMenu.chatBarText).toContain('[省略]');
    const messageAction = result.richMenu.areas[0].action;
    if (messageAction.type === 'message') {
      expect(messageAction.text).toContain('[省略]');
    }
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Detected/);
  });

  it('does NOT redact uri (URL 構造を壊さないため)', async () => {
    const withUri = {
      ...VALID_LARGE_RICH_MENU,
      areas: [
        {
          bounds: { x: 0, y: 0, width: 2500, height: 1686 },
          action: { type: 'uri', uri: 'https://example.com/effective-product' },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(withUri) });
    const result = await generateRichMenuFromPrompt({
      prompt: 'リッチメニュー生成',
      router,
    });
    const action = result.richMenu.areas[0].action;
    if (action.type === 'uri') {
      expect(action.uri).toBe('https://example.com/effective-product');
    }
  });

  it('leaves clean output untouched', async () => {
    const router = makeMockRouter({ respond: VALID_LARGE_JSON });
    const result = await generateRichMenuFromPrompt({
      prompt: 'クリーンなリッチメニュー',
      router,
    });
    expect(result.warnings).toEqual([]);
    expect(result.richMenu.name).not.toContain('[省略]');
  });
});

// ============================================================
// Error handling
// ============================================================

describe('generateRichMenuFromPrompt — error handling', () => {
  it('maps AbortError to timeout', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const router = makeMockRouter({ reject: err });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps generic AI error to api_error', async () => {
    const router = makeMockRouter({ reject: new Error('Claude 500') });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'api_error' });
  });

  it('throws invalid_response on non-JSON', async () => {
    const router = makeMockRouter({ respond: 'just text no braces' });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws invalid_response on malformed JSON', async () => {
    const router = makeMockRouter({ respond: '{ malformed,,, }' });
    await expect(
      generateRichMenuFromPrompt({ prompt: 'リッチメニュー生成', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

// ============================================================
// Internal helpers
// ============================================================

describe('validateAreasNoOverlap', () => {
  it('passes for non-overlapping areas', () => {
    const areas = [
      { bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { bounds: { x: 100, y: 0, width: 100, height: 100 } },
      { bounds: { x: 0, y: 100, width: 200, height: 100 } },
    ];
    expect(() => __test__.validateAreasNoOverlap(areas)).not.toThrow();
  });

  it('throws for overlapping areas', () => {
    const areas = [
      { bounds: { x: 0, y: 0, width: 200, height: 200 } },
      { bounds: { x: 100, y: 100, width: 200, height: 200 } },
    ];
    expect(() => __test__.validateAreasNoOverlap(areas)).toThrow(/overlap/);
  });

  it('allows touching edges (no overlap)', () => {
    // x=100 edge of first area equals x=100 start of second — touching, not overlapping
    const areas = [
      { bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { bounds: { x: 100, y: 0, width: 100, height: 100 } },
    ];
    expect(() => __test__.validateAreasNoOverlap(areas)).not.toThrow();
  });
});
