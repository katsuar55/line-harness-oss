/**
 * Phase 5β-prep: AIRouter — タスク別 provider 自動選択
 *
 * 大方針 1 (AI ネイティブ) の判定ロジック:
 *   - OSS 無料完動を最優先 → 有料 AI が unavailable でも全機能動く
 *   - 高度タスク (nutrition-copy / scenario-gen) は Claude 推奨、 fallback Workers AI
 *   - Vision は Claude 専用 (Workers AI vision 未対応)
 *   - chat / translate は Workers AI 優先 (無料)
 *
 * 設計選択:
 *   - 1 PROVIDER に決定する関数ではなく「優先順 list を返す」 → caller が順次 try
 *   - これにより API 一時障害時の fallback が自然に動く
 *   - 将来「ユーザーが手動でデフォルト provider を選択」 することも対応可
 */

import type {
  AIProvider,
  AIProviderConfig,
  ProviderId,
  TaskKind,
  TextGenerationRequest,
  TextGenerationResponse,
  VisionRequest,
} from './types.js';
import { AIProviderUnsupportedError } from './types.js';
import { createWorkersAIProvider } from './providers/workers-ai.js';
import { createClaudeProvider } from './providers/claude.js';
import {
  createGeminiProvider,
  createChatGPTProvider,
  createDeepSeekProvider,
  createKimiProvider,
} from './providers/stub-providers.js';

/**
 * タスク種別ごとの優先順位 (priority order)。
 * 最初に isAvailable() = true を返す provider を採用、 失敗時は次へ fallback。
 */
const TASK_PRIORITY: Record<TaskKind, ProviderId[]> = {
  // 短文応答 (auto-reply 等): Workers AI 優先 (無料、 常時稼働)
  chat: ['workers-ai', 'claude', 'gemini', 'chatgpt'],
  // 翻訳: Workers AI 優先 (Llama 3.3 が十分高品質)
  translate: ['workers-ai', 'claude', 'gemini', 'chatgpt'],
  // 栄養文章生成: Claude 推奨 (薬機 redact 厳しい)、 fallback Workers AI
  'nutrition-copy': ['claude', 'workers-ai', 'gemini', 'chatgpt'],
  // シナリオ自動生成 (5γ AI Conductor): Claude 推奨 (構造化 JSON 出力強い)
  'scenario-gen': ['claude', 'gemini', 'chatgpt', 'workers-ai'],
  // Vision: Claude のみ (Workers AI 未対応)
  vision: ['claude', 'gemini', 'chatgpt'],
};

export interface AIRouterOptions {
  /** タスク別 priority のオーバーライド (テスト用) */
  taskPriority?: Partial<Record<TaskKind, ProviderId[]>>;
}

/**
 * AIRouter: provider 群を保持し、 task に応じて選択 + fallback を実行。
 */
export class AIRouter {
  private readonly providers: Map<ProviderId, AIProvider>;
  private readonly taskPriority: Record<TaskKind, ProviderId[]>;

  constructor(config: AIProviderConfig, options: AIRouterOptions = {}) {
    this.providers = new Map<ProviderId, AIProvider>([
      ['workers-ai', createWorkersAIProvider(config)],
      ['claude', createClaudeProvider(config)],
      ['gemini', createGeminiProvider(config)],
      ['chatgpt', createChatGPTProvider(config)],
      ['deepseek', createDeepSeekProvider(config)],
      ['kimi', createKimiProvider(config)],
    ]);
    this.taskPriority = { ...TASK_PRIORITY, ...options.taskPriority };
  }

  /**
   * task のために、 利用可能な provider を優先順で取得 (isAvailable=true のみ)。
   * 1 件も利用不可なら空配列。
   */
  resolveProviders(task: TaskKind): AIProvider[] {
    const order = this.taskPriority[task];
    const resolved: AIProvider[] = [];
    for (const id of order) {
      const p = this.providers.get(id);
      if (p && p.isAvailable()) resolved.push(p);
    }
    return resolved;
  }

  /**
   * 単一 provider を取得 (テスト/直接アクセス用)。
   */
  getProvider(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * テキスト生成を task 推奨 provider で実行 (失敗時 fallback)。
   * 全 provider 失敗時は最後の error を throw する。
   */
  async generateText(
    task: TaskKind,
    request: TextGenerationRequest,
  ): Promise<TextGenerationResponse> {
    const candidates = this.resolveProviders(task);
    if (candidates.length === 0) {
      throw new Error(`AIRouter: no provider available for task "${task}"`);
    }
    let lastError: unknown;
    for (const provider of candidates) {
      try {
        return await provider.generateText(request);
      } catch (err) {
        lastError = err;
        console.warn(
          `[AIRouter] task=${task} provider=${provider.id} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    throw new Error(
      `AIRouter: all providers failed for task "${task}". last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * Vision (画像解析): vision 対応の provider のみ試行。
   */
  async generateVision(request: VisionRequest): Promise<TextGenerationResponse> {
    const candidates = this.resolveProviders('vision');
    if (candidates.length === 0) {
      throw new Error('AIRouter: no vision-capable provider available (Claude 等の API_KEY 必要)');
    }
    let lastError: unknown;
    for (const provider of candidates) {
      if (!provider.generateVision) {
        lastError = new AIProviderUnsupportedError(provider.id, 'vision');
        continue;
      }
      try {
        return await provider.generateVision(request);
      } catch (err) {
        lastError = err;
        console.warn(
          `[AIRouter] vision provider=${provider.id} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    throw new Error(
      `AIRouter: all vision providers failed. last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }
}
