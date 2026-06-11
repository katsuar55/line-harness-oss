/**
 * Tests for the auto-reply AI Conductor (generateAutoReplyFromPrompt).
 * Mocks only the AIRouter so the real validation / Zod / 薬機 redact path runs.
 */
import { describe, it, expect } from 'vitest';
import type { AIRouter } from '@line-crm/ai-provider';
import {
  generateAutoReplyFromPrompt,
  __test__,
} from '../services/auto-reply-conductor.js';

function fakeRouter(opts: {
  providers?: string[];
  text?: string;
  throwErr?: Error;
}): AIRouter {
  return {
    resolveProviders: () => opts.providers ?? ['workers-ai'],
    generateText: async () => {
      if (opts.throwErr) throw opts.throwErr;
      return { text: opts.text ?? '', provider: 'workers-ai', model: 'llama-test' };
    },
  } as unknown as AIRouter;
}

const VALID = JSON.stringify({
  keyword: '営業時間',
  alternateKeywords: ['何時まで', '営業日'],
  matchType: 'contains',
  responseContent: 'サポートは平日10時〜18時です。',
});

describe('generateAutoReplyFromPrompt', () => {
  it('returns a validated auto-reply from valid AI JSON', async () => {
    const res = await generateAutoReplyFromPrompt({
      prompt: '営業時間を聞かれたら平日10時から18時と答えて',
      router: fakeRouter({ text: VALID }),
    });
    expect(res.autoReply.keyword).toBe('営業時間');
    expect(res.autoReply.matchType).toBe('contains');
    expect(res.autoReply.responseContent).toContain('平日10時');
    expect(res.autoReply.alternateKeywords).toEqual(['何時まで', '営業日']);
    expect(res.provider).toBe('workers-ai');
    expect(res.warnings).toEqual([]);
  });

  it('throws prompt_too_short for a tiny prompt', async () => {
    await expect(
      generateAutoReplyFromPrompt({ prompt: 'あ', router: fakeRouter({ text: VALID }) }),
    ).rejects.toMatchObject({ code: 'prompt_too_short' });
  });

  it('throws api_key_missing when no provider is available', async () => {
    await expect(
      generateAutoReplyFromPrompt({
        prompt: '営業時間を聞かれたら答えて',
        router: fakeRouter({ providers: [], text: VALID }),
      }),
    ).rejects.toMatchObject({ code: 'api_key_missing' });
  });

  it('throws invalid_response when AI returns non-JSON', async () => {
    await expect(
      generateAutoReplyFromPrompt({
        prompt: '営業時間を聞かれたら答えて',
        router: fakeRouter({ text: 'これはJSONではありません' }),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('throws schema_validation_failed when responseContent is missing', async () => {
    await expect(
      generateAutoReplyFromPrompt({
        prompt: '営業時間を聞かれたら答えて',
        router: fakeRouter({ text: JSON.stringify({ keyword: 'x', matchType: 'exact' }) }),
      }),
    ).rejects.toMatchObject({ code: 'schema_validation_failed' });
  });

  it('redacts 薬機 prohibited phrases and surfaces a warning', async () => {
    const banned = __test__.PROHIBITED_PHRASES[0];
    const text = JSON.stringify({
      keyword: '効果',
      matchType: 'contains',
      responseContent: `この商品は${banned}と言われています。`,
    });
    const res = await generateAutoReplyFromPrompt({
      prompt: '効果を聞かれたら答えて',
      router: fakeRouter({ text }),
    });
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.autoReply.responseContent).toContain(__test__.REDACTION_TOKEN);
    expect(res.autoReply.responseContent).not.toContain(banned);
  });

  it('maps timeout (AbortError) to code timeout', async () => {
    await expect(
      generateAutoReplyFromPrompt({
        prompt: '営業時間を聞かれたら答えて',
        router: fakeRouter({
          throwErr: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });
});
