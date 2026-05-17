import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIRouter } from '@line-crm/ai-provider';
import type { AIProvider, AIProviderConfig } from '@line-crm/ai-provider';

// Helper: build a fake provider for slot
function makeFakeProvider(id: AIProvider['id'], opts: {
  available?: boolean;
  generateText?: AIProvider['generateText'];
} = {}): AIProvider {
  return {
    id,
    isAvailable: () => opts.available ?? true,
    generateText: opts.generateText ?? (async () => ({
      text: `response-from-${id}`,
      provider: id,
      model: `${id}-model`,
    })),
  };
}

describe('AIRouter — provider resolution', () => {
  let router: AIRouter;

  beforeEach(() => {
    // Minimal config — all real providers will be 'unavailable' since no keys passed
    router = new AIRouter({} as AIProviderConfig);
  });

  it('Workers AI が未バインドなら chat task で空配列', () => {
    expect(router.resolveProviders('chat')).toEqual([]);
  });

  it('vision task で全 provider 不可なら 空配列', () => {
    expect(router.resolveProviders('vision')).toEqual([]);
  });
});

describe('AIRouter — generateText fallback chain', () => {
  it('最初の provider が成功すれば その結果を返す', async () => {
    const router = new AIRouter(
      {} as AIProviderConfig,
      { taskPriority: { chat: ['workers-ai'] } },
    );
    // Inject fake provider
    (router as unknown as { providers: Map<string, AIProvider> }).providers.set(
      'workers-ai',
      makeFakeProvider('workers-ai'),
    );

    const result = await router.generateText('chat', { userMessage: 'hi' });
    expect(result.text).toBe('response-from-workers-ai');
    expect(result.provider).toBe('workers-ai');
  });

  it('最初の provider が throw したら 次の provider へ fallback する', async () => {
    const failFn = vi.fn(async () => {
      throw new Error('primary down');
    });
    const router = new AIRouter(
      {} as AIProviderConfig,
      { taskPriority: { chat: ['workers-ai', 'claude'] } },
    );
    const providers = (router as unknown as { providers: Map<string, AIProvider> }).providers;
    providers.set('workers-ai', makeFakeProvider('workers-ai', { generateText: failFn }));
    providers.set('claude', makeFakeProvider('claude'));

    const result = await router.generateText('chat', { userMessage: 'hi' });
    expect(failFn).toHaveBeenCalledOnce();
    expect(result.provider).toBe('claude');
  });

  it('全 provider 失敗時は最後の error を throw する', async () => {
    const router = new AIRouter(
      {} as AIProviderConfig,
      { taskPriority: { chat: ['workers-ai', 'claude'] } },
    );
    const providers = (router as unknown as { providers: Map<string, AIProvider> }).providers;
    providers.set(
      'workers-ai',
      makeFakeProvider('workers-ai', {
        generateText: async () => {
          throw new Error('first fail');
        },
      }),
    );
    providers.set(
      'claude',
      makeFakeProvider('claude', {
        generateText: async () => {
          throw new Error('second fail');
        },
      }),
    );

    await expect(router.generateText('chat', { userMessage: 'hi' })).rejects.toThrow(
      /second fail/,
    );
  });

  it('利用可能 provider 無しなら明示的 error', async () => {
    const router = new AIRouter(
      {} as AIProviderConfig,
      { taskPriority: { chat: ['workers-ai'] } },
    );
    // workers-ai is unavailable (no Ai binding)
    await expect(router.generateText('chat', { userMessage: 'hi' })).rejects.toThrow(
      /no provider available/,
    );
  });
});

describe('AIRouter — task priority', () => {
  it('chat task は workers-ai 優先 (大方針 1: 無料完動)', () => {
    const router = new AIRouter({} as AIProviderConfig);
    const order = (router as unknown as { taskPriority: Record<string, string[]> }).taskPriority
      .chat;
    expect(order[0]).toBe('workers-ai');
  });

  it('nutrition-copy / scenario-gen / vision は claude 優先', () => {
    const router = new AIRouter({} as AIProviderConfig);
    const tp = (router as unknown as { taskPriority: Record<string, string[]> }).taskPriority;
    expect(tp['nutrition-copy'][0]).toBe('claude');
    expect(tp['scenario-gen'][0]).toBe('claude');
    expect(tp['vision'][0]).toBe('claude');
  });

  it('vision には workers-ai が含まれない (Workers AI 未対応)', () => {
    const router = new AIRouter({} as AIProviderConfig);
    const order = (router as unknown as { taskPriority: Record<string, string[]> }).taskPriority
      .vision;
    expect(order).not.toContain('workers-ai');
  });
});
