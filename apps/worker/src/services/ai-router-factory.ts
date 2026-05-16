/**
 * Phase 5β-prep adoption: AIRouter factory
 *
 * Worker bindings (env) から AIRouter を構築するヘルパー。
 * 各 service / route で以下の 2 step を 1 行に短縮できる:
 *
 *   const router = createAIRouterFromEnv(c.env);
 *   const result = await router.generateText('chat', { userMessage: '...' });
 *
 * AIRouter の構築コストは無視できる程度 (Map 6 件) なので、
 * リクエストごとに作成して問題ない (singleton 化は不要)。
 */

import { AIRouter, type AIRouterOptions } from '@line-crm/ai-provider';
import type { Env } from '../index.js';

/**
 * Worker env Bindings から AIRouter を構築。
 *
 * - workersAI binding が必須 (default 主役)
 * - ANTHROPIC_API_KEY 未設定なら Claude provider は isAvailable=false で skip
 * - 他 API キー (Gemini / OpenAI / DeepSeek / Kimi) は将来 env に追加された時点で自動採用
 */
export function createAIRouterFromEnv(
  env: Env['Bindings'],
  options: AIRouterOptions = {},
): AIRouter {
  return new AIRouter(
    {
      workersAI: env.AI,
      workersAIPrimaryModel: env.AI_MODEL_PRIMARY,
      workersAIFallbackModel: env.AI_MODEL_FALLBACK,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      // Tier 1 オプション (将来 env に追加時に自動採用):
      // geminiApiKey: env.GEMINI_API_KEY,
      // openaiApiKey: env.OPENAI_API_KEY,
      // deepseekApiKey: env.DEEPSEEK_API_KEY,
      // moonshotApiKey: env.MOONSHOT_API_KEY,
    },
    options,
  );
}
