/**
 * Tests for message-conductor (Phase 5γ-4: AI Conductor — Message Template Generator).
 *
 * 4 種 messageType (text / image / flex / carousel) を中心にカバー。
 * scenario / rich-menu / form と同じ mock router パターン。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  generateMessageFromPrompt,
  MessageConductorError,
  __test__,
} from '../services/message-conductor.js';
import type {
  AIRouter,
  TextGenerationRequest,
  TextGenerationResponse,
} from '@line-crm/ai-provider';

// ============================================================
// Fixtures
// ============================================================

const VALID_TEXT = {
  messageType: 'text',
  name: 'welcome',
  category: 'general',
  text: 'こんにちは、 {{name}} さん。 {{brand_name}} です。',
};

const VALID_IMAGE = {
  messageType: 'image',
  name: 'product banner',
  category: 'product',
  originalContentUrl: 'https://example.com/image.jpg',
  previewImageUrl: 'https://example.com/preview.jpg',
};

const VALID_FLEX = {
  messageType: 'flex',
  name: 'product card',
  category: 'product',
  altText: '{{brand_name}} 商品のご案内',
  contents: {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [{ type: 'text', text: '商品ページ' }],
    },
  },
};

const VALID_CAROUSEL = {
  messageType: 'carousel',
  name: 'product carousel',
  category: 'product',
  altText: '{{brand_name}} の商品ラインナップ',
  bubbles: [
    {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '商品 A' }],
      },
    },
    {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: '商品 B' }],
      },
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
// Happy path — text
// ============================================================

describe('generateMessageFromPrompt — text happy path', () => {
  it('parses well-formed text message', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_TEXT) });
    const result = await generateMessageFromPrompt({
      prompt: 'welcome テキストメッセージを作って',
      router,
    });
    expect(result.template.messageType).toBe('text');
    expect(result.template.name).toBe('welcome');
    expect(result.messageContent).toBe(VALID_TEXT.text);
    expect(result.messageType).toBe('text');
    expect(result.altText).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('uses scenario-gen task on AIRouter', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_TEXT) });
    await generateMessageFromPrompt({ prompt: 'text message', router });
    const generateText = (router as unknown as {
      generateText: ReturnType<typeof vi.fn>;
    }).generateText;
    expect(generateText.mock.calls[0][0]).toBe('scenario-gen');
  });

  it('omits category when AI omits it', async () => {
    const minimal = { messageType: 'text', name: 'm', text: 'hello' };
    const router = makeMockRouter({ respond: JSON.stringify(minimal) });
    const result = await generateMessageFromPrompt({
      prompt: 'minimal text',
      router,
    });
    expect(result.template.messageType).toBe('text');
    if (result.template.messageType === 'text') {
      expect(result.template.category).toBeUndefined();
    }
  });
});

// ============================================================
// Happy path — image
// ============================================================

describe('generateMessageFromPrompt — image happy path', () => {
  it('parses well-formed image message', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_IMAGE) });
    const result = await generateMessageFromPrompt({
      prompt: '画像メッセージを作って',
      router,
    });
    expect(result.template.messageType).toBe('image');
    expect(result.messageType).toBe('image');
    expect(result.altText).toBeUndefined();
    const parsedContent = JSON.parse(result.messageContent);
    expect(parsedContent.originalContentUrl).toBe(VALID_IMAGE.originalContentUrl);
    expect(parsedContent.previewImageUrl).toBe(VALID_IMAGE.previewImageUrl);
  });

  it('rejects http:// (non-https) URLs', async () => {
    const bad = { ...VALID_IMAGE, originalContentUrl: 'http://example.com/img.jpg' };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: '画像メッセージ', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects when originalContentUrl missing', async () => {
    const bad = {
      messageType: 'image',
      name: 'x',
      previewImageUrl: 'https://example.com/p.jpg',
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: '画像メッセージ', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });
});

// ============================================================
// Happy path — flex
// ============================================================

describe('generateMessageFromPrompt — flex happy path', () => {
  it('parses well-formed flex message', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_FLEX) });
    const result = await generateMessageFromPrompt({
      prompt: 'flex 商品カードを作って',
      router,
    });
    expect(result.template.messageType).toBe('flex');
    expect(result.messageType).toBe('flex');
    expect(result.altText).toBe(VALID_FLEX.altText);
    const parsedContent = JSON.parse(result.messageContent);
    expect(parsedContent.type).toBe('bubble');
    expect(parsedContent.body).toBeDefined();
  });

  it('rejects when altText missing', async () => {
    const bad = {
      messageType: 'flex',
      name: 'x',
      contents: { type: 'bubble' },
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'flex メッセージ', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects when contents.type is not bubble', async () => {
    const bad = {
      messageType: 'flex',
      name: 'x',
      altText: 'alt',
      contents: { type: 'box' },
    };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'flex メッセージ', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });
});

// ============================================================
// Happy path — carousel
// ============================================================

describe('generateMessageFromPrompt — carousel happy path', () => {
  it('parses well-formed carousel with 2 bubbles', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_CAROUSEL) });
    const result = await generateMessageFromPrompt({
      prompt: '商品カルーセル',
      router,
    });
    expect(result.template.messageType).toBe('carousel');
    expect(result.messageType).toBe('carousel');
    expect(result.altText).toBe(VALID_CAROUSEL.altText);
    const parsedContent = JSON.parse(result.messageContent);
    expect(parsedContent.type).toBe('carousel');
    expect(parsedContent.contents).toHaveLength(2);
    expect(parsedContent.contents[0].type).toBe('bubble');
  });

  it('accepts max 12 bubbles', async () => {
    const bubbles = Array.from({ length: 12 }, () => ({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [] },
    }));
    const carousel = { ...VALID_CAROUSEL, bubbles };
    const router = makeMockRouter({ respond: JSON.stringify(carousel) });
    const result = await generateMessageFromPrompt({
      prompt: 'max carousel',
      router,
    });
    if (result.template.messageType === 'carousel') {
      expect(result.template.bubbles).toHaveLength(12);
    }
  });

  it('rejects 13 bubbles (over LINE max)', async () => {
    const bubbles = Array.from({ length: 13 }, () => ({
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [] },
    }));
    const carousel = { ...VALID_CAROUSEL, bubbles };
    const router = makeMockRouter({ respond: JSON.stringify(carousel) });
    await expect(
      generateMessageFromPrompt({ prompt: 'too many', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects 0 bubbles', async () => {
    const carousel = { ...VALID_CAROUSEL, bubbles: [] };
    const router = makeMockRouter({ respond: JSON.stringify(carousel) });
    await expect(
      generateMessageFromPrompt({ prompt: 'empty', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });
});

// ============================================================
// Validation: input
// ============================================================

describe('generateMessageFromPrompt — input validation', () => {
  it('throws prompt_too_short', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_TEXT) });
    await expect(
      generateMessageFromPrompt({ prompt: 'hi', router }),
    ).rejects.toMatchObject({ code: 'prompt_too_short' });
  });

  it('throws prompt_too_long', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_TEXT) });
    await expect(
      generateMessageFromPrompt({ prompt: 'a'.repeat(4001), router }),
    ).rejects.toMatchObject({ code: 'prompt_too_long' });
  });

  it('throws api_key_missing when no provider', async () => {
    const router = makeMockRouter({ noProvider: true });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ生成', router }),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
  });
});

// ============================================================
// Validation: schema
// ============================================================

describe('generateMessageFromPrompt — schema constraints', () => {
  it('rejects unknown messageType', async () => {
    const bad = { messageType: 'sticker', name: 'x' };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'unknown type', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects text exceeding 5000 chars', async () => {
    const bad = { ...VALID_TEXT, text: 'a'.repeat(5001) };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'long text', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects altText exceeding 400 chars', async () => {
    const bad = { ...VALID_FLEX, altText: 'a'.repeat(401) };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'long alt', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects empty text', async () => {
    const bad = { ...VALID_TEXT, text: '' };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'empty', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('rejects name exceeding 120 chars', async () => {
    const bad = { ...VALID_TEXT, name: 'a'.repeat(121) };
    const router = makeMockRouter({ respond: JSON.stringify(bad) });
    await expect(
      generateMessageFromPrompt({ prompt: 'long name', router }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });
});

// ============================================================
// 薬機 redaction (text)
// ============================================================

describe('generateMessageFromPrompt — text redaction', () => {
  it('redacts prohibited phrases in text', async () => {
    const dirty = {
      messageType: 'text',
      name: 'がんが治る商品',
      text: 'この商品で病気が改善します',
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateMessageFromPrompt({
      prompt: 'メッセージ',
      router,
    });
    expect(result.template.name).toContain('[省略]');
    if (result.template.messageType === 'text') {
      expect(result.template.text).toContain('[省略]');
    }
    expect(result.messageContent).toContain('[省略]');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does NOT modify clean text', async () => {
    const router = makeMockRouter({ respond: JSON.stringify(VALID_TEXT) });
    const result = await generateMessageFromPrompt({
      prompt: 'clean',
      router,
    });
    expect(result.warnings).toEqual([]);
    expect(result.messageContent).toBe(VALID_TEXT.text);
  });
});

// ============================================================
// 薬機 redaction (flex / carousel — deep)
// ============================================================

describe('generateMessageFromPrompt — flex deep redaction', () => {
  it('redacts text inside nested flex bubble', async () => {
    const dirty = {
      messageType: 'flex',
      name: 'がんが治るカード',
      altText: '病気が改善する商品',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: 'この商品で治療できます' },
            { type: 'text', text: '副作用なし' },
          ],
        },
      },
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateMessageFromPrompt({
      prompt: 'flex deep redaction',
      router,
    });
    expect(result.template.name).toContain('[省略]');
    if (result.template.messageType === 'flex') {
      expect(result.template.altText).toContain('[省略]');
    }
    expect(result.messageContent).toContain('[省略]');
    // text inside body.contents[0].text should be redacted
    const parsed = JSON.parse(result.messageContent);
    expect(parsed.body.contents[0].text).toContain('[省略]');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('does NOT redact URL-like keys (uri, url, iconUrl, etc.)', async () => {
    // edge case: a URL contains a substring that LOOKS bad but we keep it intact
    const tricky = {
      messageType: 'flex',
      name: 'clean name',
      altText: 'clean alt',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              action: {
                type: 'uri',
                uri: 'https://example.com/治る-page',
                label: 'クリック',
              },
            },
          ],
        },
      },
    };
    const router = makeMockRouter({ respond: JSON.stringify(tricky) });
    const result = await generateMessageFromPrompt({
      prompt: 'flex with URL preservation',
      router,
    });
    const parsed = JSON.parse(result.messageContent);
    // uri must be preserved verbatim
    expect(parsed.body.contents[0].action.uri).toBe(
      'https://example.com/治る-page',
    );
  });

  it('redacts carousel bubbles deeply', async () => {
    const dirty = {
      messageType: 'carousel',
      name: 'ok',
      altText: 'ok',
      bubbles: [
        {
          type: 'bubble',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [{ type: 'text', text: 'がんが治る商品' }],
          },
        },
      ],
    };
    const router = makeMockRouter({ respond: JSON.stringify(dirty) });
    const result = await generateMessageFromPrompt({
      prompt: 'carousel',
      router,
    });
    const parsed = JSON.parse(result.messageContent);
    expect(parsed.contents[0].body.contents[0].text).toContain('[省略]');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Error handling
// ============================================================

describe('generateMessageFromPrompt — error handling', () => {
  it('maps AbortError to timeout', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const router = makeMockRouter({ reject: err });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps generic Error with "aborted" in message to timeout', async () => {
    const router = makeMockRouter({ reject: new Error('request was aborted') });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('throws invalid_response on non-JSON output', async () => {
    const router = makeMockRouter({ respond: 'plain text no braces' });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws invalid_response when AI returns empty text', async () => {
    const router = makeMockRouter({ respond: '' });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws invalid_response on JSON with junk braces', async () => {
    // contains { but never balanced
    const router = makeMockRouter({ respond: 'hello { world' });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws api_error on generic AI failure', async () => {
    const router = makeMockRouter({ reject: new Error('Network error') });
    await expect(
      generateMessageFromPrompt({ prompt: 'メッセージ', router }),
    ).rejects.toMatchObject({ code: 'api_error' });
  });
});

// ============================================================
// Internal helpers
// ============================================================

describe('redactDeep', () => {
  const id = (s: string) => `[R:${s}]`;

  it('returns primitive values unchanged when not string', () => {
    expect(__test__.redactDeep(42, id)).toBe(42);
    expect(__test__.redactDeep(true, id)).toBe(true);
    expect(__test__.redactDeep(null, id)).toBeNull();
    expect(__test__.redactDeep(undefined, id)).toBeUndefined();
  });

  it('redacts string', () => {
    expect(__test__.redactDeep('hello', id)).toBe('[R:hello]');
  });

  it('redacts nested object string fields', () => {
    const node = { a: 'x', b: { c: 'y' } };
    const result = __test__.redactDeep(node, id) as Record<string, unknown>;
    expect(result.a).toBe('[R:x]');
    expect((result.b as Record<string, unknown>).c).toBe('[R:y]');
  });

  it('redacts array of strings', () => {
    const node = ['a', 'b'];
    expect(__test__.redactDeep(node, id)).toEqual(['[R:a]', '[R:b]']);
  });

  it('preserves URL-like keys verbatim', () => {
    const node = {
      uri: 'https://example.com',
      url: 'https://x.com',
      iconUrl: 'https://i.com',
      label: 'click',
    };
    const result = __test__.redactDeep(node, id) as Record<string, string>;
    expect(result.uri).toBe('https://example.com');
    expect(result.url).toBe('https://x.com');
    expect(result.iconUrl).toBe('https://i.com');
    expect(result.label).toBe('[R:click]');
  });
});

describe('serializeForTemplatesTable', () => {
  it('serializes text as raw string', () => {
    const result = __test__.serializeForTemplatesTable({
      messageType: 'text',
      name: 'x',
      text: 'hello',
    });
    expect(result).toBe('hello');
  });

  it('serializes image as JSON with both URLs', () => {
    const result = __test__.serializeForTemplatesTable({
      messageType: 'image',
      name: 'x',
      originalContentUrl: 'https://a.jpg',
      previewImageUrl: 'https://b.jpg',
    });
    const parsed = JSON.parse(result);
    expect(parsed.originalContentUrl).toBe('https://a.jpg');
    expect(parsed.previewImageUrl).toBe('https://b.jpg');
    // ensure no extra fields leak in
    expect(Object.keys(parsed).sort()).toEqual([
      'originalContentUrl',
      'previewImageUrl',
    ]);
  });

  it('serializes flex as bubble JSON', () => {
    const result = __test__.serializeForTemplatesTable({
      messageType: 'flex',
      name: 'x',
      altText: 'alt',
      contents: { type: 'bubble', body: { type: 'box' } },
    } as never);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe('bubble');
  });

  it('serializes carousel as { type: carousel, contents: bubbles[] }', () => {
    const result = __test__.serializeForTemplatesTable({
      messageType: 'carousel',
      name: 'x',
      altText: 'alt',
      bubbles: [{ type: 'bubble' }, { type: 'bubble' }],
    } as never);
    const parsed = JSON.parse(result);
    expect(parsed.type).toBe('carousel');
    expect(parsed.contents).toHaveLength(2);
  });
});

describe('extractAltText', () => {
  it('returns undefined for text', () => {
    expect(
      __test__.extractAltText({
        messageType: 'text',
        name: 'x',
        text: 'hi',
      }),
    ).toBeUndefined();
  });

  it('returns undefined for image', () => {
    expect(
      __test__.extractAltText({
        messageType: 'image',
        name: 'x',
        originalContentUrl: 'https://a.jpg',
        previewImageUrl: 'https://b.jpg',
      }),
    ).toBeUndefined();
  });

  it('returns altText for flex', () => {
    expect(
      __test__.extractAltText({
        messageType: 'flex',
        name: 'x',
        altText: 'an alt',
        contents: { type: 'bubble' },
      } as never),
    ).toBe('an alt');
  });

  it('returns altText for carousel', () => {
    expect(
      __test__.extractAltText({
        messageType: 'carousel',
        name: 'x',
        altText: 'carousel alt',
        bubbles: [{ type: 'bubble' }],
      } as never),
    ).toBe('carousel alt');
  });
});

describe('sanitizeUserPrompt', () => {
  it('strips control chars and CR/LF/Tab (consecutive whitespace collapsed to one space)', () => {
    // \r\n is a single match (two consecutive whitespace chars → 1 space),
    // \t is another match → 1 more space.
    expect(__test__.sanitizeUserPrompt('a\r\nb\tc')).toBe('a b c');
  });

  it('replaces double quotes with full-width quotes', () => {
    expect(__test__.sanitizeUserPrompt('say "hi"')).toBe('say ”hi”');
  });

  it('truncates to PROMPT_MAX_LEN', () => {
    const long = 'a'.repeat(4500);
    const result = __test__.sanitizeUserPrompt(long);
    expect(result.length).toBe(__test__.PROMPT_MAX_LEN);
  });
});

describe('MessageConductorError', () => {
  it('exposes code property', () => {
    const err = new MessageConductorError('test', 'invalid_response');
    expect(err.code).toBe('invalid_response');
    expect(err.name).toBe('MessageConductorError');
  });

  it('captures cause', () => {
    const cause = new Error('root');
    const err = new MessageConductorError('top', 'api_error', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('__test__ exports', () => {
  it('exposes messageOutputSchema', () => {
    expect(__test__.messageOutputSchema).toBeDefined();
  });

  it('exposes MESSAGE_TYPES constants', () => {
    expect(__test__.MESSAGE_TYPES).toEqual(['text', 'image', 'flex', 'carousel']);
  });

  it('exposes URL_LIKE_KEYS containing standard LINE URL fields', () => {
    expect(__test__.URL_LIKE_KEYS.has('uri')).toBe(true);
    expect(__test__.URL_LIKE_KEYS.has('originalContentUrl')).toBe(true);
    expect(__test__.URL_LIKE_KEYS.has('previewImageUrl')).toBe(true);
    expect(__test__.URL_LIKE_KEYS.has('iconUrl')).toBe(true);
  });

  it('exposes CAROUSEL_BUBBLE_MAX = 12 (LINE spec)', () => {
    expect(__test__.CAROUSEL_BUBBLE_MAX).toBe(12);
  });
});
