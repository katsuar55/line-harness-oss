import { describe, it, expect } from 'vitest';
import { createAIRouterFromEnv } from '../services/ai-router-factory.js';
import {
  foreignFoodAiTaskOverride,
  isForeignFoodAiEnabled,
} from '../services/foreign-food-ai-gate.js';

// Workers AI binding の最小 mock (isAvailable 判定に使われるだけ)
const fakeAI = { run: async () => ({ response: 'ok' }) };

function makeEnv(flag?: string) {
  return {
    AI: fakeAI,
    AI_MODEL_PRIMARY: 'm1',
    AI_MODEL_FALLBACK: 'm2',
    ANTHROPIC_API_KEY: 'sk-test',
    FOOD_AI_FOREIGN_ENABLED: flag,
  } as unknown as Parameters<typeof createAIRouterFromEnv>[0];
}

describe('isForeignFoodAiEnabled', () => {
  it("'true' のときだけ on", () => {
    expect(isForeignFoodAiEnabled({ FOOD_AI_FOREIGN_ENABLED: 'true' })).toBe(true);
    expect(isForeignFoodAiEnabled({ FOOD_AI_FOREIGN_ENABLED: 'TRUE' })).toBe(false);
    expect(isForeignFoodAiEnabled({ FOOD_AI_FOREIGN_ENABLED: '1' })).toBe(false);
    expect(isForeignFoodAiEnabled({})).toBe(false);
    expect(isForeignFoodAiEnabled(undefined)).toBe(false);
  });
});

describe('foreignFoodAiTaskOverride', () => {
  it('off: vision を空に、nutrition-copy を Workers AI だけにする', () => {
    expect(foreignFoodAiTaskOverride({})).toEqual({
      vision: [],
      'nutrition-copy': ['workers-ai'],
    });
  });
  it('on: 何も上書きしない', () => {
    expect(foreignFoodAiTaskOverride({ FOOD_AI_FOREIGN_ENABLED: 'true' })).toEqual({});
  });
});

describe('createAIRouterFromEnv と gate', () => {
  it('off (未設定): key があっても vision の provider は 0、nutrition-copy に claude が入らない', () => {
    const router = createAIRouterFromEnv(makeEnv(undefined));
    expect(router.resolveProviders('vision')).toHaveLength(0);
    const ids = router.resolveProviders('nutrition-copy').map((p) => p.id);
    expect(ids).not.toContain('claude');
  });

  it('on: 従来どおり vision に claude が使える', () => {
    const router = createAIRouterFromEnv(makeEnv('true'));
    const ids = router.resolveProviders('vision').map((p) => p.id);
    expect(ids).toContain('claude');
  });

  it('off は呼び出し側の taskPriority 上書きより優先する', () => {
    const router = createAIRouterFromEnv(makeEnv(undefined), {
      taskPriority: { vision: ['claude'] },
    });
    expect(router.resolveProviders('vision')).toHaveLength(0);
  });

  it('chat など他のタスクには影響しない', () => {
    const off = createAIRouterFromEnv(makeEnv(undefined)).resolveProviders('scenario-gen').map((p) => p.id);
    const on = createAIRouterFromEnv(makeEnv('true')).resolveProviders('scenario-gen').map((p) => p.id);
    expect(off).toEqual(on);
  });
});
