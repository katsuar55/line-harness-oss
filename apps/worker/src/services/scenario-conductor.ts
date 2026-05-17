/**
 * Phase 5γ-1: AI Conductor — Scenario Generator
 *
 * 自然言語プロンプトから LINE ステップ配信シナリオの構造化 JSON を生成する。
 * Visual エディタ代替の本丸 (5γ AI Conductor) の第 1 PR。
 *
 * 設計方針:
 *   - **生成のみ**: 本サービスは DB INSERT しない。 caller (UI) がプレビュー確認後に
 *     既存の `POST /api/scenarios` + `POST /api/scenarios/:id/steps` を叩く。
 *   - **AI Provider 抽象化に乗る**: AIRouter('scenario-gen') 経由で Claude → workers-ai
 *     fallback。 OSS 無料完動の原則だが、 構造化 JSON は workers-ai だと精度が落ちるため
 *     Tier 1 (Claude) 推奨 — Claude unavailable 時は workers-ai に fallback。
 *   - **薬機ガード二重化**: AI system prompt で禁止指示 + redactProhibitedPhrases で
 *     最終防衛線 (food-analyzer / nutrition-recommender と同パターン)。
 *   - **brand 値 hardcode 禁止**: AI 出力には `{{brand_name}}` 等 placeholder を強制
 *     (大方針 2: 汎用性 multi-brand の遵守)。
 *   - **JSON 強制**: system prompt で "ONLY valid JSON" + Zod 実行時検証 +
 *     extractJsonObject で前置き / コードフェンス耐性
 *
 * 既存パターン踏襲: food-analyzer.ts の Vision-JSON 解析パターンを scenario 用に転用。
 */

import { z } from 'zod';
import {
  AIRouter,
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
} from '@line-crm/ai-provider';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 4096;
const PROMPT_MIN_LEN = 5;
const PROMPT_MAX_LEN = 4000;
const STEP_MAX_COUNT = 50;
const DELAY_MAX_MINUTES = 60 * 24 * 30; // 30 days

const SCENARIO_TRIGGER_TYPES = ['friend_add', 'tag_added', 'manual'] as const;
const STEP_MESSAGE_TYPES = ['text', 'image', 'flex'] as const;
const STEP_CHANNELS = ['line', 'email', 'both'] as const;

// ----------------------------------------------------------------
// Zod スキーマ — AI が返す JSON を実行時検証
// ----------------------------------------------------------------

const scenarioInfoSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  triggerType: z.enum(SCENARIO_TRIGGER_TYPES),
  triggerTagId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

const scenarioStepSchema = z.object({
  stepOrder: z.number().int().min(1).max(STEP_MAX_COUNT),
  delayMinutes: z.number().int().min(0).max(DELAY_MAX_MINUTES),
  messageType: z.enum(STEP_MESSAGE_TYPES),
  messageContent: z.string().min(1).max(5000),
  channel: z.enum(STEP_CHANNELS).optional(),
  conditionType: z.string().max(50).nullable().optional(),
  conditionValue: z.string().max(500).nullable().optional(),
});

const conductorOutputSchema = z.object({
  scenario: scenarioInfoSchema,
  steps: z.array(scenarioStepSchema).min(1).max(STEP_MAX_COUNT),
});

export type ConductorScenarioOutput = z.infer<typeof conductorOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type ScenarioConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class ScenarioConductorError extends Error {
  constructor(
    message: string,
    public readonly code: ScenarioConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ScenarioConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは LINE 公式アカウントの CRM 担当者向けに、
ステップ配信シナリオの構造化 JSON を生成するアシスタントです。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
   薬機法に触れる表現は厳禁。
3. ブランド名・商品名の具体値は埋め込まず、 \`{{brand_name}}\` placeholder を使う。
4. 顧客名は \`{{name}}\` placeholder で参照する。
5. ステップ数は 1〜${STEP_MAX_COUNT} 件。 各ステップ delayMinutes は前ステップからの相対時間 (整数分)。
6. messageType は "text" | "image" | "flex" のいずれか。
   - "text" の messageContent はプレーンテキスト。
   - "image" の messageContent は画像 URL (https://...)。
   - "flex" の messageContent は LINE Flex Message JSON 文字列。

# 出力スキーマ
{
  "scenario": {
    "name": "シナリオ名 (120 字以内)",
    "description": "目的の短い説明 (1000 字以内、 optional)",
    "triggerType": "friend_add" | "tag_added" | "manual",
    "triggerTagId": null,
    "isActive": false
  },
  "steps": [
    {
      "stepOrder": 1,
      "delayMinutes": 0,
      "messageType": "text",
      "messageContent": "メッセージ本文 (5000 字以内)",
      "channel": "line",
      "conditionType": null,
      "conditionValue": null
    }
  ]
}

# トリガー別の慣例
- "friend_add" → 1 ステップ目は delayMinutes=0 の welcome (はじめましての挨拶)
- "tag_added" → 1 ステップ目は対応 tag の文脈を意識した内容
- "manual" → 1 ステップ目は broadcast 起点として説明的な内容

# placeholder 例
\`\`\`
こんにちは、 {{name}} さん。 {{brand_name}} です。
今日は商品の紹介をさせてください。
\`\`\``;

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface GenerateScenarioInput {
  /** ユーザの自然言語プロンプト (5〜4000 字) */
  prompt: string;
  /** AIRouter (createAIRouterFromEnv で生成) */
  router: AIRouter;
  /** 最大 token (default 4096) */
  maxTokens?: number;
}

export interface GenerateScenarioResult {
  scenario: ConductorScenarioOutput['scenario'];
  steps: ConductorScenarioOutput['steps'];
  /** redact 検出フレーズ等の警告 (UI で表示推奨) */
  warnings: string[];
  /** 実際に使われた provider id */
  provider: string;
  /** 実際に使われた model id */
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateScenarioFromPrompt(
  input: GenerateScenarioInput,
): Promise<GenerateScenarioResult> {
  // ---- 入力検証 ----
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new ScenarioConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new ScenarioConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  // ---- provider 利用可能性 ----
  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new ScenarioConductorError(
      'No scenario-gen provider available. Configure ANTHROPIC_API_KEY (recommended) or ensure Workers AI binding is set.',
      'api_key_missing',
    );
  }

  // ---- ユーザ prompt sanitize (prompt injection 軽減) ----
  const sanitizedPrompt = sanitizeUserPrompt(trimmed);

  // ---- AI 呼出 ----
  let response;
  try {
    response = await input.router.generateText('scenario-gen', {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: sanitizedPrompt,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new ScenarioConductorError('AI provider timed out', 'timeout', err);
    }
    throw new ScenarioConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new ScenarioConductorError('AI response had no text', 'invalid_response');
  }

  // ---- JSON 抽出 (前置き / コードフェンス耐性) ----
  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new ScenarioConductorError(
      'Failed to extract JSON object from response',
      'invalid_response',
    );
  }

  // ---- JSON parse ----
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new ScenarioConductorError(
      'Response was not valid JSON',
      'invalid_response',
      err,
    );
  }

  // ---- Zod schema 検証 ----
  const validated = conductorOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ScenarioConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  // ---- 薬機ガード (二重ガード: provider 内 redact + 本サービスでも redact) ----
  const { sanitized, warnings } = sanitizeScenarioOutput(validated.data);

  // ---- ステップ整合性検証: stepOrder の連番性 ----
  validateStepOrders(sanitized.steps);

  return {
    scenario: sanitized.scenario,
    steps: sanitized.steps,
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

/**
 * テキスト中から最初の JSON オブジェクト ({...}) を抽出する。
 * Claude が稀に "```json\n{...}\n```" や前置き文を返すケースに耐える。
 *
 * food-analyzer.ts の同名関数と同等実装。 共通 utils 化は次の PR で検討。
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 全文字列フィールドに redactProhibitedPhrases を適用 (薬機 NG ワード除去)。
 * 検出フレーズは warnings として返す (UI に表示)。
 */
function sanitizeScenarioOutput(data: ConductorScenarioOutput): {
  sanitized: ConductorScenarioOutput;
  warnings: string[];
} {
  const detected = new Set<string>();

  const redact = (s: string): string => {
    const r = redactProhibitedPhrases(s);
    r.detectedPhrases.forEach((p) => detected.add(p));
    return r.text;
  };

  const redactOpt = (s?: string | null): string | null | undefined => {
    if (s === undefined) return undefined;
    if (s === null) return null;
    return redact(s);
  };

  const sanitized: ConductorScenarioOutput = {
    scenario: {
      name: redact(data.scenario.name),
      description: redactOpt(data.scenario.description),
      triggerType: data.scenario.triggerType,
      triggerTagId: data.scenario.triggerTagId ?? null,
      isActive: data.scenario.isActive ?? false,
    },
    steps: data.steps.map((step) => ({
      stepOrder: step.stepOrder,
      delayMinutes: step.delayMinutes,
      messageType: step.messageType,
      messageContent: redact(step.messageContent),
      channel: step.channel ?? 'line',
      conditionType: redactOpt(step.conditionType),
      conditionValue: redactOpt(step.conditionValue),
    })),
  };

  const warnings: string[] = [];
  if (detected.size > 0) {
    warnings.push(
      `Detected ${detected.size} prohibited phrase(s): ${Array.from(detected)
        .map((p) => `"${p}"`)
        .join(', ')} — replaced with ${REDACTION_TOKEN}.`,
    );
  }

  return { sanitized, warnings };
}

/**
 * AI が "stepOrder=3, stepOrder=5" のような飛び番を返した場合、 配信ロジックが混乱する。
 * 1, 2, 3, ... の連番でなければ schema_validation_failed (caller がリトライ可能).
 */
function validateStepOrders(steps: ConductorScenarioOutput['steps']): void {
  const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  for (let i = 0; i < sorted.length; i++) {
    const expected = i + 1;
    if (sorted[i].stepOrder !== expected) {
      throw new ScenarioConductorError(
        `step ordering is not contiguous from 1 (expected ${expected}, got ${sorted[i].stepOrder} at index ${i})`,
        'schema_validation_failed',
      );
    }
  }
}

/**
 * ユーザ prompt サニタイズ (prompt injection 対策軽め)。
 *   - 改行・タブ・制御文字を空白に
 *   - "を全角に置換 (system prompt の delimiter 衝突回避)
 *   - 4000 字に切り詰め
 */
function sanitizeUserPrompt(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/"/g, '”')
    .trim()
    .slice(0, PROMPT_MAX_LEN);
}

// ----------------------------------------------------------------
// テスト用エクスポート
// ----------------------------------------------------------------

export const __test__ = {
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  conductorOutputSchema,
  extractJsonObject,
  sanitizeScenarioOutput,
  sanitizeUserPrompt,
  validateStepOrders,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  STEP_MAX_COUNT,
  DELAY_MAX_MINUTES,
};
