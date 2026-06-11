/**
 * AI Conductor — Auto-Reply Generator (AIネイティブ オペレーター体験 — A案 MVP)
 *
 * 自然言語プロンプトから「キーワード自動応答」(auto_replies 行) を生成する。
 * Katsu が「キーワード自動応答は時代遅れ」と述べた DMM UX を、AI ネイティブに上位互換化する第1歩:
 *   オペレーターが「解約と言われたら○○と答えて」と書くと、AI が
 *   keyword 候補 + match_type + 返信文 (薬機フィルタ済) を起草 → 確認して保存。
 *
 * 設計方針 (scenario-conductor.ts を踏襲):
 *   - **生成のみ** (DB INSERT しない)。 caller (UI) が確認後に POST /api/auto-replies を叩く。
 *   - AIRouter('scenario-gen') 経由 (Claude → workers-ai fallback)。
 *   - 薬機ガード二重化: system prompt の禁止指示 + redactProhibitedPhrases。
 *   - brand/顧客名は {{brand_name}} / {{name}} placeholder。
 *   - JSON 強制 + Zod 実行時検証 + extractJsonObject。
 *
 * 補足: auto_replies は 1 行 = 1 keyword。 alternateKeywords は「候補」として返し、
 *   UI が採用分だけ個別に POST する (= schema 無変更、 migration 不要)。
 */

import { z } from 'zod';
import {
  AIRouter,
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
} from '@line-crm/ai-provider';
import { extractJsonObject } from './scenario-conductor.js';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_MIN_LEN = 5;
const PROMPT_MAX_LEN = 4000;
const KEYWORD_MAX_LEN = 40;
const ALT_KEYWORD_MAX = 5;
const RESPONSE_MAX_LEN = 2000;

const MATCH_TYPES = ['exact', 'contains'] as const;

// ----------------------------------------------------------------
// Zod スキーマ
// ----------------------------------------------------------------

const autoReplyOutputSchema = z.object({
  keyword: z.string().min(1).max(KEYWORD_MAX_LEN),
  alternateKeywords: z.array(z.string().min(1).max(KEYWORD_MAX_LEN)).max(ALT_KEYWORD_MAX).optional(),
  matchType: z.enum(MATCH_TYPES),
  responseContent: z.string().min(1).max(RESPONSE_MAX_LEN),
});

export type AutoReplyConductorOutput = z.infer<typeof autoReplyOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type AutoReplyConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class AutoReplyConductorError extends Error {
  constructor(
    message: string,
    public readonly code: AutoReplyConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AutoReplyConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは LINE 公式アカウントの CRM 担当者向けに、
「キーワード自動応答」 の設定 JSON を生成するアシスタントです。
ユーザが「○○と聞かれたら△△と答えて」のような意図を書くので、
それを 1 つの keyword 自動応答ルールに変換します。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
   薬機法に触れる表現は厳禁。返信文は事実ベースの案内に留める。
3. ブランド名・商品名の具体値は埋め込まず \`{{brand_name}}\` placeholder、 顧客名は \`{{name}}\` placeholder。
4. keyword は友だちが送ってきそうな短い語 (40 字以内)。 alternateKeywords に類義語を最大 5 個。
5. matchType:
   - "exact" = メッセージが keyword と完全一致した時だけ反応 (誤爆を避けたい時)。
   - "contains" = メッセージに keyword が含まれていれば反応 (曖昧な質問を広く拾いたい時)。
   一般的な問い合わせ語は "contains" を推奨。
6. responseContent は 1 つの具体的な回答 (2000 字以内、 プレーンテキスト)。

# 出力スキーマ
{
  "keyword": "営業時間",
  "alternateKeywords": ["何時まで", "開いてる", "営業日"],
  "matchType": "contains",
  "responseContent": "お問い合わせありがとうございます。{{brand_name}} のサポート対応は平日10時〜18時です。"
}`;

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface GenerateAutoReplyInput {
  prompt: string;
  router: AIRouter;
  maxTokens?: number;
}

export interface GenerateAutoReplyResult {
  autoReply: AutoReplyConductorOutput;
  warnings: string[];
  provider: string;
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateAutoReplyFromPrompt(
  input: GenerateAutoReplyInput,
): Promise<GenerateAutoReplyResult> {
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new AutoReplyConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new AutoReplyConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new AutoReplyConductorError(
      'No generation provider available. Configure ANTHROPIC_API_KEY (recommended) or ensure Workers AI binding is set.',
      'api_key_missing',
    );
  }

  const sanitizedPrompt = sanitizeUserPrompt(trimmed);

  let response;
  try {
    response = await input.router.generateText('scenario-gen', {
      systemPrompt: SYSTEM_PROMPT,
      userMessage: sanitizedPrompt,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new AutoReplyConductorError('AI provider timed out', 'timeout', err);
    }
    throw new AutoReplyConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new AutoReplyConductorError('AI response had no text', 'invalid_response');
  }

  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new AutoReplyConductorError('Failed to extract JSON object from response', 'invalid_response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new AutoReplyConductorError('Response was not valid JSON', 'invalid_response', err);
  }

  const validated = autoReplyOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new AutoReplyConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  const { sanitized, warnings } = sanitizeAutoReplyOutput(validated.data);

  return {
    autoReply: sanitized,
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

function sanitizeAutoReplyOutput(data: AutoReplyConductorOutput): {
  sanitized: AutoReplyConductorOutput;
  warnings: string[];
} {
  const detected = new Set<string>();
  const redact = (s: string): string => {
    const r = redactProhibitedPhrases(s);
    r.detectedPhrases.forEach((p) => detected.add(p));
    return r.text;
  };

  const sanitized: AutoReplyConductorOutput = {
    keyword: redact(data.keyword),
    alternateKeywords: data.alternateKeywords?.map(redact),
    matchType: data.matchType,
    responseContent: redact(data.responseContent),
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
  autoReplyOutputSchema,
  sanitizeAutoReplyOutput,
  sanitizeUserPrompt,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  KEYWORD_MAX_LEN,
  RESPONSE_MAX_LEN,
};
