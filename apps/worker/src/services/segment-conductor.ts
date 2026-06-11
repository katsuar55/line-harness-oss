/**
 * AI Conductor — Segment Generator (AIネイティブ オペレーター体験 — A案 MVP)
 *
 * 自然言語プロンプトから配信セグメント条件 (SegmentCondition) を生成する。
 * 「タグ手動管理/生JSONセグメントは時代遅れ」という DMM UX への回答:
 *   オペレーターが「30日購入がない人」「VIPタグでリピーター」と書くと、AI が
 *   segment-query.ts の 13 ルール型に**束縛された** SegmentCondition を返す
 *   (= 生成物は必ず buildSegmentQuery で実行可能、未知ルール型のハルシネーション不可)。
 *
 * 設計方針 (scenario-conductor.ts を踏襲):
 *   - **生成のみ** (配信しない)。 caller (UI) がチップ表示 + 該当人数確認後に
 *     既存の send-segment / JSON 受け入れ画面で利用する。
 *   - タグ/グループは ID が必要なため、caller が DB から**カタログを注入**し、
 *     AI はカタログ内の ID のみ使用。出力後に ID 実在検証 (ハルシネーション防御)。
 *   - Zod スキーマは SegmentRule union を 1:1 でミラー。乖離防止のため
 *     round-trip テスト (全ルール型 → buildSegmentQuery) を必須とする。
 */

import { z } from 'zod';
import {
  AIRouter,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
} from '@line-crm/ai-provider';
import type { SegmentCondition } from './segment-query.js';
import { extractJsonObject } from './scenario-conductor.js';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 1024;
const PROMPT_MIN_LEN = 5;
const PROMPT_MAX_LEN = 4000;
const RULES_MAX = 10;
const FRIEND_STATUSES = ['none', 'prospect', 'active', 'vip', 'dormant', 'churned'] as const;

// ----------------------------------------------------------------
// Zod スキーマ — segment-query.ts の SegmentRule union を 1:1 ミラー
// (drift 防止: segment-conductor.test.ts の round-trip テストが全型を buildSegmentQuery に通す)
// ----------------------------------------------------------------

const stringValueRule = z.object({
  type: z.enum([
    'tag_exists',
    'tag_not_exists',
    'ref_code',
    'group_exists',
    'group_not_exists',
    'assigned_staff',
    'shopify_tag_exists',
    'shopify_tag_not_exists',
  ]),
  value: z.string().min(1).max(200),
});

const friendStatusRule = z.object({
  type: z.literal('friend_status'),
  value: z.enum(FRIEND_STATUSES),
});

const booleanValueRule = z.object({
  type: z.literal('is_following'),
  value: z.boolean(),
});

const numberValueRule = z.object({
  type: z.enum(['shopify_total_spent_gte', 'shopify_orders_count_gte']),
  value: z.number().finite().min(0).max(100_000_000),
});

const metadataValueRule = z.object({
  type: z.enum(['metadata_equals', 'metadata_not_equals']),
  value: z.object({ key: z.string().min(1).max(100), value: z.string().max(500) }),
});

const segmentRuleSchema = z.union([
  stringValueRule,
  friendStatusRule,
  booleanValueRule,
  numberValueRule,
  metadataValueRule,
]);

export const segmentConditionSchema = z.object({
  operator: z.enum(['AND', 'OR']),
  rules: z.array(segmentRuleSchema).min(1).max(RULES_MAX),
});

const conductorSegmentOutputSchema = z.object({
  condition: segmentConditionSchema,
  humanReadable: z.string().min(1).max(500),
});

export type ConductorSegmentOutput = z.infer<typeof conductorSegmentOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type SegmentConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'unknown_reference'
  | 'api_error';

export class SegmentConductorError extends Error {
  constructor(
    message: string,
    public readonly code: SegmentConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'SegmentConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

function buildSystemPrompt(catalog: SegmentCatalog): string {
  const tagLines = catalog.tags.length
    ? catalog.tags.map((t) => `  - id="${t.id}" name="${t.name}"`).join('\n')
    : '  (タグ未登録)';
  const groupLines = catalog.groups.length
    ? catalog.groups.map((g) => `  - id="${g.id}" name="${g.name}"`).join('\n')
    : '  (グループ未登録)';

  return `あなたは LINE 公式アカウントの CRM 担当者向けに、
配信対象の絞り込み条件 (セグメント) の構造化 JSON を生成するアシスタントです。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. rules は 1〜${RULES_MAX} 件、 operator は "AND" (すべて満たす) | "OR" (いずれか満たす)。
3. 使えるルール型と value の形は以下だけ。 **この一覧に無い型を発明しない**。
   - tag_exists / tag_not_exists: value = タグ id (下のカタログから選ぶ。 name ではなく id)
   - group_exists / group_not_exists: value = グループ id (カタログから)
   - metadata_equals / metadata_not_equals: value = { "key": "...", "value": "..." }
   - ref_code: value = 流入経路コード (文字列)
   - is_following: value = true | false (true = フォロー中のみ)
   - friend_status: value = "none" | "prospect" | "active" | "vip" | "dormant" | "churned"
   - shopify_tag_exists / shopify_tag_not_exists: value = Shopify 顧客タグ名 (文字列)
   - shopify_total_spent_gte: value = 累計購入金額の下限 (数値、 円)
   - shopify_orders_count_gte: value = 注文回数の下限 (数値)
4. ユーザーの意図がカタログのタグ/グループに対応しない場合は、 その条件を**入れずに**、
   humanReadable に「該当タグが見つからない」旨を書く。 id を捏造しない。
5. humanReadable は日本語で条件の人間向け要約 (500 字以内)。
6. 「購入していない/しばらく買っていない」のような否定の購買条件は、 現在のルール型では
   表現できない場合がある (shopify_*_gte は下限のみ)。 表現できない時は最も近い条件で近似し、
   humanReadable に近似であることを明記する。

# 利用可能なタグ (id を使う)
${tagLines}

# 利用可能なグループ (id を使う)
${groupLines}

# 出力スキーマ例
{
  "condition": {
    "operator": "AND",
    "rules": [
      { "type": "shopify_orders_count_gte", "value": 2 },
      { "type": "is_following", "value": true }
    ]
  },
  "humanReadable": "注文回数2回以上で、現在フォロー中の友だち"
}`;
}

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface SegmentCatalog {
  tags: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
}

export interface GenerateSegmentInput {
  prompt: string;
  router: AIRouter;
  catalog: SegmentCatalog;
  maxTokens?: number;
}

export interface GenerateSegmentResult {
  condition: SegmentCondition;
  humanReadable: string;
  warnings: string[];
  provider: string;
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateSegmentFromPrompt(
  input: GenerateSegmentInput,
): Promise<GenerateSegmentResult> {
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new SegmentConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new SegmentConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new SegmentConductorError(
      'No generation provider available. Configure ANTHROPIC_API_KEY (recommended) or ensure Workers AI binding is set.',
      'api_key_missing',
    );
  }

  const sanitizedPrompt = sanitizeUserPrompt(trimmed);

  let response;
  try {
    response = await input.router.generateText('scenario-gen', {
      systemPrompt: buildSystemPrompt(input.catalog),
      userMessage: sanitizedPrompt,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new SegmentConductorError('AI provider timed out', 'timeout', err);
    }
    throw new SegmentConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new SegmentConductorError('AI response had no text', 'invalid_response');
  }

  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new SegmentConductorError('Failed to extract JSON object from response', 'invalid_response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new SegmentConductorError('Response was not valid JSON', 'invalid_response', err);
  }

  const validated = conductorSegmentOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new SegmentConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  // ---- ID 実在検証 (AI の id ハルシネーション防御) ----
  validateCatalogReferences(validated.data.condition, input.catalog);

  // ---- 薬機ガード (humanReadable のみ自由文) ----
  const { text: humanReadable, detectedPhrases } = redactProhibitedPhrases(
    validated.data.humanReadable,
  );
  const warnings: string[] = [];
  if (detectedPhrases.length > 0) {
    warnings.push(
      `Detected ${detectedPhrases.length} prohibited phrase(s) in humanReadable — replaced with ${REDACTION_TOKEN}.`,
    );
  }

  return {
    condition: validated.data.condition as SegmentCondition,
    humanReadable,
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

function validateCatalogReferences(
  condition: z.infer<typeof segmentConditionSchema>,
  catalog: SegmentCatalog,
): void {
  const tagIds = new Set(catalog.tags.map((t) => t.id));
  const groupIds = new Set(catalog.groups.map((g) => g.id));

  for (const rule of condition.rules) {
    if (
      (rule.type === 'tag_exists' || rule.type === 'tag_not_exists') &&
      !tagIds.has(rule.value as string)
    ) {
      throw new SegmentConductorError(
        `unknown tag id "${String(rule.value)}" (AI がカタログ外の id を生成)`,
        'unknown_reference',
      );
    }
    if (
      (rule.type === 'group_exists' || rule.type === 'group_not_exists') &&
      !groupIds.has(rule.value as string)
    ) {
      throw new SegmentConductorError(
        `unknown group id "${String(rule.value)}" (AI がカタログ外の id を生成)`,
        'unknown_reference',
      );
    }
  }
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
  conductorSegmentOutputSchema,
  segmentConditionSchema,
  buildSystemPrompt,
  validateCatalogReferences,
  sanitizeUserPrompt,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  RULES_MAX,
  FRIEND_STATUSES,
};
