/**
 * Phase 5β-prep: ClaudeProvider — Tier 1 オプション (Q2 ユーザー回答 No.1)
 *
 * Anthropic Messages API を unified AIProvider インターフェースで wrap する。
 * apps/worker/src/services/{food-analyzer, monthly-food-report, nutrition-recommender,
 * weekly-coach-push}.ts の Anthropic 呼出を抽象化する前提。
 *
 * - default model: claude-haiku-4-5-20251001 (cost-effective for short generation)
 * - vision 対応: 唯一 vision を持つ provider (food-analyzer の食事画像解析の主力)
 * - PROHIBITED_PHRASES redaction を出力に適用
 */

import type {
  AIProvider,
  AIProviderConfig,
  ProviderId,
  TextGenerationRequest,
  TextGenerationResponse,
  VisionRequest,
} from '../types.js';
import { redactProhibitedPhrases } from '../redact.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;
const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeProviderOptions {
  apiKey?: string;
  model?: string;
  /** Optional fetch override for testing. Must be bound to globalThis when global. */
  fetchImpl?: typeof fetch;
}

interface AnthropicResponseShape {
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  model?: string;
}

export class ClaudeProvider implements AIProvider {
  readonly id: ProviderId = 'claude';
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model && options.model.length > 0 ? options.model : DEFAULT_MODEL;
    // CLAUDE.md「Workers コーディングルール」: global function は bind(globalThis) で保持
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  async generateText(request: TextGenerationRequest): Promise<TextGenerationResponse> {
    this.ensureKey();
    const body = {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      system: request.systemPrompt,
      messages: [{ role: 'user', content: request.userMessage }],
    };
    const parsed = await this.callAnthropic(body);
    return this.toResponse(parsed);
  }

  async generateVision(request: VisionRequest): Promise<TextGenerationResponse> {
    this.ensureKey();
    const body = {
      model: this.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: request.mediaType,
                data: stripDataUriPrefix(request.imageBase64),
              },
            },
            { type: 'text', text: request.userMessage },
          ],
        },
      ],
    };
    const parsed = await this.callAnthropic(body);
    return this.toResponse(parsed);
  }

  private ensureKey(): void {
    if (!this.apiKey) {
      throw new Error('ClaudeProvider: ANTHROPIC_API_KEY not configured');
    }
  }

  private async callAnthropic(body: unknown): Promise<AnthropicResponseShape> {
    const response = await this.fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey!,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new Error(`ClaudeProvider: API error ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    return (await response.json()) as AnthropicResponseShape;
  }

  private toResponse(parsed: AnthropicResponseShape): TextGenerationResponse {
    const raw = (parsed.content ?? [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('\n')
      .trim();
    const { text } = redactProhibitedPhrases(raw);
    return {
      text,
      provider: this.id,
      model: parsed.model ?? this.model,
      usage: parsed.usage
        ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }
        : undefined,
    };
  }
}

export function createClaudeProvider(config: AIProviderConfig): ClaudeProvider {
  return new ClaudeProvider({
    apiKey: config.anthropicApiKey,
    model: config.claudeModel,
  });
}

function stripDataUriPrefix(input: string): string {
  return input.startsWith('data:') ? input.slice(input.indexOf(',') + 1) : input;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const t = await response.text();
    return t.slice(0, 480);
  } catch {
    return '';
  }
}
