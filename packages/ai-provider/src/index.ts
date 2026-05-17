/**
 * @line-crm/ai-provider entry point (Phase 5β-prep)
 *
 * 利用例 (apps/worker/src/index.ts 等):
 * ```ts
 * import { AIRouter } from '@line-crm/ai-provider';
 *
 * const router = new AIRouter({
 *   workersAI: env.AI,
 *   workersAIPrimaryModel: env.AI_MODEL_PRIMARY,
 *   workersAIFallbackModel: env.AI_MODEL_FALLBACK,
 *   anthropicApiKey: env.ANTHROPIC_API_KEY,
 * });
 *
 * const result = await router.generateText('chat', {
 *   systemPrompt: '...',
 *   userMessage: 'こんにちは',
 * });
 * console.log(result.text);   // redacted text
 * console.log(result.provider); // 'workers-ai' (chat task の優先順位 1 位)
 * ```
 */

export * from './types.js';
export * from './redact.js';
export * from './router.js';
export { WorkersAIProvider, createWorkersAIProvider, stripThinkingTags } from './providers/workers-ai.js';
export { ClaudeProvider, createClaudeProvider } from './providers/claude.js';
export {
  GeminiProvider,
  ChatGPTProvider,
  DeepSeekProvider,
  KimiProvider,
  createGeminiProvider,
  createChatGPTProvider,
  createDeepSeekProvider,
  createKimiProvider,
} from './providers/stub-providers.js';
