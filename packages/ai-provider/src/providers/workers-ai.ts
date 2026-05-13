/**
 * Phase 5β-prep: WorkersAIProvider — Tier 2 主役 (OSS 無料完動 大方針 1)
 *
 * Cloudflare Workers AI を unified AIProvider インターフェースで wrap する。
 * apps/worker/src/services/ai-response.ts の runAiWithFallback ロジックを抽象化し、
 * 他 provider と差し替え可能にする。
 *
 * - 主力モデル: Qwen3-30B-A3B (日本語強い)
 * - fallback モデル: Llama-3.3-70B (安定)
 * - <think>...</think> tag 除去 (Qwen3 reasoning 出力)
 * - vision 未対応 (Workers AI に vision なし、 AIProviderUnsupportedError throw)
 */

import type {
  AIProvider,
  AIProviderConfig,
  ProviderId,
  TextGenerationRequest,
  TextGenerationResponse,
  VisionRequest,
} from '../types.js';
import { AIProviderUnsupportedError } from '../types.js';
import { redactProhibitedPhrases } from '../redact.js';

const DEFAULT_PRIMARY_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const DEFAULT_FALLBACK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_MAX_TOKENS_QWEN = 1024; // Qwen3 は reasoning token も消費するため大きめ
const DEFAULT_MAX_TOKENS_LLAMA = 512;

export interface WorkersAIProviderOptions {
  ai?: Ai;
  primaryModel?: string;
  fallbackModel?: string;
}

export class WorkersAIProvider implements AIProvider {
  readonly id: ProviderId = 'workers-ai';
  private readonly ai?: Ai;
  private readonly primaryModel: string;
  private readonly fallbackModel: string;

  constructor(options: WorkersAIProviderOptions = {}) {
    this.ai = options.ai;
    this.primaryModel = isValidWorkersAIModel(options.primaryModel)
      ? (options.primaryModel as string)
      : DEFAULT_PRIMARY_MODEL;
    this.fallbackModel = isValidWorkersAIModel(options.fallbackModel)
      ? (options.fallbackModel as string)
      : DEFAULT_FALLBACK_MODEL;
  }

  isAvailable(): boolean {
    return this.ai !== undefined;
  }

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    if (!this.ai) {
      throw new Error('WorkersAIProvider: Ai binding not configured');
    }
    const models = [this.primaryModel, this.fallbackModel];
    let lastError: unknown;

    for (const model of models) {
      try {
        const messages: Array<{ role: string; content: string }> = [];
        if (request.systemPrompt) {
          messages.push({ role: 'system', content: request.systemPrompt });
        }
        const userContent = model.includes('qwen3')
          ? request.userMessage + ' /no_think'
          : request.userMessage;
        messages.push({ role: 'user', content: userContent });

        const maxTokens =
          request.maxTokens ??
          (model.includes('qwen3') ? DEFAULT_MAX_TOKENS_QWEN : DEFAULT_MAX_TOKENS_LLAMA);

        const response = (await this.ai.run(model as Parameters<Ai['run']>[0], {
          messages,
          max_tokens: maxTokens,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        })) as { response?: string };

        if (response?.response) {
          const cleaned = stripThinkingTags(response.response);
          if (cleaned) {
            const { text } = redactProhibitedPhrases(cleaned);
            return {
              text,
              provider: this.id,
              model,
            };
          }
        }
        lastError = new Error(`Model ${model} returned empty response`);
      } catch (err) {
        lastError = err;
        console.error(
          `[WorkersAIProvider] Model ${model} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    throw new Error(
      `WorkersAIProvider: all models failed. last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  async generateVision(_request: VisionRequest): Promise<TextGenerationResponse> {
    throw new AIProviderUnsupportedError(this.id, 'vision');
  }
}

/**
 * Factory: AIProviderConfig から WorkersAIProvider を構築。
 */
export function createWorkersAIProvider(config: AIProviderConfig): WorkersAIProvider {
  return new WorkersAIProvider({
    ai: config.workersAI,
    primaryModel: config.workersAIPrimaryModel,
    fallbackModel: config.workersAIFallbackModel,
  });
}

/**
 * Qwen3 の `<think>...</think>` reasoning タグを除去する。
 */
export function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Cloudflare Workers AI モデル名 (@cf/ プレフィックス) の検証。
 */
function isValidWorkersAIModel(name: string | undefined): boolean {
  return typeof name === 'string' && name.startsWith('@cf/') && name.length > 4;
}
