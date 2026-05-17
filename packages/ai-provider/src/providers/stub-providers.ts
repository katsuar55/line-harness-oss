/**
 * Phase 5β-prep: stub providers (Gemini / ChatGPT / DeepSeek / Kimi)
 *
 * 各 provider は API_KEY 構造のみ事前定義し、 実 API 呼出は後続 PR で実装する。
 * 現状の `isAvailable()` は false 固定なので、 router は WorkersAI / Claude を選ぶ。
 *
 * Q2 ユーザー回答の優先順位:
 *   1. Claude (full impl in claude.ts)
 *   2. Gemini
 *   3. ChatGPT
 *   4. DeepSeek
 *   5. Kimi
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

abstract class StubProvider implements AIProvider {
  abstract readonly id: ProviderId;
  protected readonly apiKey?: string;
  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }
  isAvailable(): boolean {
    // 実装完了まで false 固定 (skeleton)
    return false;
  }
  async generateText(_request: TextGenerationRequest): Promise<TextGenerationResponse> {
    throw new Error(`${this.id} provider not yet implemented (Phase 5β follow-up)`);
  }
  async generateVision(_request: VisionRequest): Promise<TextGenerationResponse> {
    throw new AIProviderUnsupportedError(this.id, 'vision');
  }
}

export class GeminiProvider extends StubProvider {
  readonly id: ProviderId = 'gemini';
}

export class ChatGPTProvider extends StubProvider {
  readonly id: ProviderId = 'chatgpt';
}

export class DeepSeekProvider extends StubProvider {
  readonly id: ProviderId = 'deepseek';
}

export class KimiProvider extends StubProvider {
  readonly id: ProviderId = 'kimi';
}

export function createGeminiProvider(config: AIProviderConfig): GeminiProvider {
  return new GeminiProvider(config.geminiApiKey);
}
export function createChatGPTProvider(config: AIProviderConfig): ChatGPTProvider {
  return new ChatGPTProvider(config.openaiApiKey);
}
export function createDeepSeekProvider(config: AIProviderConfig): DeepSeekProvider {
  return new DeepSeekProvider(config.deepseekApiKey);
}
export function createKimiProvider(config: AIProviderConfig): KimiProvider {
  return new KimiProvider(config.moonshotApiKey);
}
