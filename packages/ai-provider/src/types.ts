/**
 * Phase 5β-prep: AI provider 抽象化レイヤー の型定義
 *
 * 大方針 1 (AI ネイティブ):
 *   - Tier 2 主役 = Workers AI (無料、 デフォルト)
 *   - Tier 1 オプション = Claude / Gemini / ChatGPT / DeepSeek / Kimi (有料、 API_KEY 必要)
 *   - OSS 無料完動が大前提 → ANTHROPIC_API_KEY 未設定でも全機能動作
 */

/**
 * provider 識別子。 router での切替と user 設定で使う。
 *   - workers-ai: Cloudflare Workers AI (default, free)
 *   - claude:     Anthropic Claude (preferred for vision / high-quality)
 *   - gemini:     Google Gemini
 *   - chatgpt:    OpenAI ChatGPT
 *   - deepseek:   DeepSeek (低価格・高性能)
 *   - kimi:       Moonshot Kimi (long context)
 */
export type ProviderId =
  | 'workers-ai'
  | 'claude'
  | 'gemini'
  | 'chatgpt'
  | 'deepseek'
  | 'kimi';

/**
 * タスク分類 (router での自動 provider 選択に利用)。
 *   - chat:           auto-reply / shorts text (default Workers AI)
 *   - translate:      auto-translate (default Workers AI)
 *   - nutrition-copy: 栄養文章生成 (要 Claude、 fallback Workers AI)
 *   - scenario-gen:   AI Conductor (要 Claude、 fallback Workers AI)
 *   - vision:         画像解析 (Claude のみ。 Workers AI vision 未対応のため fallback 無し)
 */
export type TaskKind =
  | 'chat'
  | 'translate'
  | 'nutrition-copy'
  | 'scenario-gen'
  | 'vision';

/**
 * テキスト生成リクエスト (vision を除く全タスク共通)
 */
export interface TextGenerationRequest {
  /** system role 用 prompt */
  systemPrompt?: string;
  /** user message (chat / single-turn) */
  userMessage: string;
  /** max tokens (provider 依存の上限あり、 router で正規化) */
  maxTokens?: number;
  /** temperature (0..1) — 既定 0.7 */
  temperature?: number;
}

/**
 * テキスト生成レスポンス (全 provider 共通)
 */
export interface TextGenerationResponse {
  /** 生成テキスト (PROHIBITED_PHRASES redaction 適用後) */
  text: string;
  /** 実際に使われた provider ID */
  provider: ProviderId;
  /** 実際に使われた model 識別子 (provider 内固有) */
  model: string;
  /** 利用 token 数 (provider 取得可能な場合のみ) */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Vision (画像解析) リクエスト
 *   - 現状 Claude のみ対応 (Workers AI に vision モデル無し)
 */
export interface VisionRequest {
  systemPrompt?: string;
  userMessage: string;
  /** base64 encoded image data (data URI 文字列か pure base64、 provider が判定) */
  imageBase64: string;
  /** MIME type ('image/jpeg' 等) */
  mediaType: string;
  maxTokens?: number;
}

/**
 * AI provider の最小インターフェース。 全 provider が実装する。
 */
export interface AIProvider {
  readonly id: ProviderId;
  /** provider が利用可能か (API_KEY / binding 等が揃っているか) */
  isAvailable(): boolean;
  /** テキスト生成。 全 provider 必須。 */
  generateText(request: TextGenerationRequest): Promise<TextGenerationResponse>;
  /** Vision (画像解析)。 未対応 provider は AIProviderUnsupportedError を throw。 */
  generateVision?(request: VisionRequest): Promise<TextGenerationResponse>;
}

/**
 * provider 未対応のオペレーション。 router が fallback 判定に利用。
 */
export class AIProviderUnsupportedError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly operation: 'text' | 'vision',
  ) {
    super(`Provider "${provider}" does not support ${operation}`);
    this.name = 'AIProviderUnsupportedError';
  }
}

/**
 * provider 設定 (env から構築)
 */
export interface AIProviderConfig {
  /** Workers AI binding (Tier 2 主役) */
  workersAI?: Ai;
  /** Workers AI primary model (例: '@cf/qwen/qwen3-30b-a3b-fp8') */
  workersAIPrimaryModel?: string;
  /** Workers AI fallback model (例: '@cf/meta/llama-3.3-70b-instruct-fp8-fast') */
  workersAIFallbackModel?: string;
  /** Claude API key (Tier 1 オプション) */
  anthropicApiKey?: string;
  /** Claude model (default: claude-haiku-4-5-20251001) */
  claudeModel?: string;
  /** Gemini API key */
  geminiApiKey?: string;
  /** ChatGPT (OpenAI) API key */
  openaiApiKey?: string;
  /** DeepSeek API key */
  deepseekApiKey?: string;
  /** Kimi (Moonshot) API key */
  moonshotApiKey?: string;
}
