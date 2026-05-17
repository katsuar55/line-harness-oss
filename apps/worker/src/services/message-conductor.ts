/**
 * Phase 5γ-4: AI Conductor — Message Template Generator
 *
 * 自然言語プロンプトから `templates` テーブルに保存可能な LINE Messaging API
 * 互換のメッセージ JSON を生成する。 5γ-1 (scenario) / 5γ-2 (rich-menu) /
 * 5γ-3 (form) と同じ AIRouter('scenario-gen') ベースのパターン。
 *
 * 設計方針:
 *   - **生成のみ**: DB INSERT しない。 caller (UI) がプレビュー確認後に
 *     `POST /api/templates` (既存) を叩く。
 *   - **4 種 messageType**: `text` | `image` | `flex` | `carousel`
 *     (`templates.message_type` の CHECK constraint と一致)
 *   - **構造化出力 + serialized 出力 を両方返す**:
 *     UI の preview 表示には structured を、 DB 保存には messageContent
 *     (templates.message_content 形式) を利用。
 *   - **薬機ガード再帰**: text / image はトップレベル、 flex / carousel は
 *     `text` / `altText` / `label` 系の string プロパティを再帰的に redact。
 *     URL 系 (`uri`, `url`, `iconUrl` 等) は redact 除外 (URL 構造を壊さない)。
 *   - **brand 値 hardcode 禁止**: AI 出力に `{{brand_name}}` 等 placeholder 強制
 *     (大方針 2: 汎用性 multi-brand)。
 *   - **discriminatedUnion**: Zod の discriminatedUnion('messageType', [...]) で
 *     4 種を型安全に区別 (rich-menu の action 4 種と同じパターン)。
 *   - **carousel**: 1〜12 bubble (LINE 仕様)、 messageContent は
 *     `{ type: 'carousel', contents: bubble[] }` 形式
 *
 * 既存パターン踏襲: form-conductor.ts と同等構造。
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

const DEFAULT_MAX_TOKENS = 4096;
const PROMPT_MIN_LEN = 5;
const PROMPT_MAX_LEN = 4000;
const NAME_MAX_LEN = 120;
const CATEGORY_MAX_LEN = 50;
const TEXT_MAX_LEN = 5000;            // LINE text message limit (effectively)
const ALT_TEXT_MAX_LEN = 400;         // LINE Flex altText: 400 chars
const URL_MAX_LEN = 2000;             // 念のため上限
const CAROUSEL_BUBBLE_MIN = 1;
const CAROUSEL_BUBBLE_MAX = 12;        // LINE carousel: 最大 12 bubble

const MESSAGE_TYPES = ['text', 'image', 'flex', 'carousel'] as const;

/**
 * 再帰 redact で「URL 系のキー」を判定するための allow list。
 * このキーに該当する string プロパティは redact をスキップする
 * (例: `https://example.com/がんが治る` のような URL を変質させない)。
 */
const URL_LIKE_KEYS = new Set([
  'uri',
  'url',
  'iconUrl',
  'imageUrl',
  'backgroundImageUrl',
  'previewImageUrl',
  'originalContentUrl',
  'thumbnailImageUrl',
]);

// ----------------------------------------------------------------
// Zod スキーマ — AI が返す JSON を実行時検証
// ----------------------------------------------------------------

/**
 * Flex Bubble は LINE Flex Message Object の深いネスト構造。
 * 細部までは検証せず、 type='bubble' のみ強制 + passthrough で他 prop 許容。
 */
const flexBubbleSchema = z
  .object({
    type: z.literal('bubble'),
  })
  .passthrough();

export type FlexBubble = z.infer<typeof flexBubbleSchema>;

const httpsUrlSchema = z
  .string()
  .min(1)
  .max(URL_MAX_LEN)
  .url()
  .refine((s) => s.startsWith('https://'), {
    message: 'URL must use https://',
  });

const textTemplateSchema = z.object({
  messageType: z.literal('text'),
  name: z.string().min(1).max(NAME_MAX_LEN),
  category: z.string().max(CATEGORY_MAX_LEN).optional(),
  text: z.string().min(1).max(TEXT_MAX_LEN),
});

const imageTemplateSchema = z.object({
  messageType: z.literal('image'),
  name: z.string().min(1).max(NAME_MAX_LEN),
  category: z.string().max(CATEGORY_MAX_LEN).optional(),
  originalContentUrl: httpsUrlSchema,
  previewImageUrl: httpsUrlSchema,
});

const flexTemplateSchema = z.object({
  messageType: z.literal('flex'),
  name: z.string().min(1).max(NAME_MAX_LEN),
  category: z.string().max(CATEGORY_MAX_LEN).optional(),
  altText: z.string().min(1).max(ALT_TEXT_MAX_LEN),
  contents: flexBubbleSchema,
});

const carouselTemplateSchema = z.object({
  messageType: z.literal('carousel'),
  name: z.string().min(1).max(NAME_MAX_LEN),
  category: z.string().max(CATEGORY_MAX_LEN).optional(),
  altText: z.string().min(1).max(ALT_TEXT_MAX_LEN),
  bubbles: z.array(flexBubbleSchema).min(CAROUSEL_BUBBLE_MIN).max(CAROUSEL_BUBBLE_MAX),
});

const messageOutputSchema = z.discriminatedUnion('messageType', [
  textTemplateSchema,
  imageTemplateSchema,
  flexTemplateSchema,
  carouselTemplateSchema,
]);

export type ConductorMessageOutput = z.infer<typeof messageOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type MessageConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class MessageConductorError extends Error {
  constructor(
    message: string,
    public readonly code: MessageConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'MessageConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは LINE 公式アカウントの担当者向けに、
配信用メッセージテンプレート (templates テーブル保存用) の構造化 JSON を生成するアシスタントです。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
   薬機法に触れる表現は厳禁。
3. ブランド名・商品名の具体値は埋め込まず、 \`{{brand_name}}\` placeholder を使う。
4. 顧客名を入れる場合は \`{{name}}\` placeholder で参照する。
5. messageType は "text" | "image" | "flex" | "carousel" のいずれか。
6. URL は **必ず https://** で始まる。 http:// は禁止 (LINE 仕様)。

# messageType 別スキーマ

## text
{
  "messageType": "text",
  "name": "テンプレート名 (120 字以内)",
  "category": "general",
  "text": "本文 (最大 5000 字)"
}

## image
{
  "messageType": "image",
  "name": "...",
  "category": "...",
  "originalContentUrl": "https://...",
  "previewImageUrl": "https://..."
}

## flex (単一 bubble)
{
  "messageType": "flex",
  "name": "...",
  "category": "...",
  "altText": "通知欄に表示される代替テキスト (400 字以内、必須)",
  "contents": {
    "type": "bubble",
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [{ "type": "text", "text": "..." }]
    }
  }
}

## carousel (1〜12 bubble)
{
  "messageType": "carousel",
  "name": "...",
  "category": "...",
  "altText": "...",
  "bubbles": [
    { "type": "bubble", "body": { ... } },
    { "type": "bubble", "body": { ... } }
  ]
}

# 慣例
- text は親密な敬語、 文末に絵文字 1 つ程度 OK。
- flex / carousel の text 要素には \`{{name}}\` / \`{{brand_name}}\` を活用。
- 画像 URL を要求された場合、 想像で URL を作らずプレースホルダ "https://example.com/placeholder.jpg" を使う (caller が後で差し替える前提)。
- flex bubble は body 主体で構成。 hero / header / footer は必要時のみ。
`;

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface GenerateMessageInput {
  prompt: string;
  router: AIRouter;
  maxTokens?: number;
}

export interface GenerateMessageResult {
  /** UI preview 用の構造化フィールド (AI 出力 + redact 後) */
  template: ConductorMessageOutput;
  /** templates.message_content にそのまま保存可能な文字列 */
  messageContent: string;
  /** templates.message_type にそのまま保存可能 */
  messageType: ConductorMessageOutput['messageType'];
  /** flex / carousel の altText (image/text は undefined) */
  altText: string | undefined;
  /** 検出された薬機 NG フレーズ等の警告 */
  warnings: string[];
  /** 実際に使われた provider id */
  provider: string;
  /** 実際に使われた model id */
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateMessageFromPrompt(
  input: GenerateMessageInput,
): Promise<GenerateMessageResult> {
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new MessageConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new MessageConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new MessageConductorError(
      'No scenario-gen provider available. Configure ANTHROPIC_API_KEY (recommended) or ensure Workers AI binding is set.',
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
      throw new MessageConductorError('AI provider timed out', 'timeout', err);
    }
    throw new MessageConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new MessageConductorError('AI response had no text', 'invalid_response');
  }

  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new MessageConductorError(
      'Failed to extract JSON object from response',
      'invalid_response',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new MessageConductorError('Response was not valid JSON', 'invalid_response', err);
  }

  const validated = messageOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new MessageConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  const { sanitized, warnings } = sanitizeMessageOutput(validated.data);
  const serialized = serializeForTemplatesTable(sanitized);

  return {
    template: sanitized,
    messageContent: serialized,
    messageType: sanitized.messageType,
    altText: extractAltText(sanitized),
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

/**
 * `template.message_content` カラムに保存する文字列を組み立てる。
 *
 * - text: 本文をそのまま
 * - image: `{ originalContentUrl, previewImageUrl }` の JSON
 * - flex: bubble オブジェクトの JSON
 * - carousel: `{ type: 'carousel', contents: bubble[] }` の JSON
 */
function serializeForTemplatesTable(data: ConductorMessageOutput): string {
  switch (data.messageType) {
    case 'text':
      return data.text;
    case 'image':
      return JSON.stringify({
        originalContentUrl: data.originalContentUrl,
        previewImageUrl: data.previewImageUrl,
      });
    case 'flex':
      return JSON.stringify(data.contents);
    case 'carousel':
      return JSON.stringify({
        type: 'carousel',
        contents: data.bubbles,
      });
  }
}

function extractAltText(data: ConductorMessageOutput): string | undefined {
  if (data.messageType === 'flex' || data.messageType === 'carousel') {
    return data.altText;
  }
  return undefined;
}

/**
 * テンプレート全体の文字列フィールドに薬機 redact を適用。
 *
 * 適用対象:
 *   - name / category (全 messageType)
 *   - text (text)
 *   - altText (flex / carousel)
 *   - flex/carousel の bubble 内の **全 string プロパティ** (URL 系を除く)
 *
 * URL_LIKE_KEYS に含まれるキーの string 値は redact をスキップ
 * (URL を変質させないため)。
 */
function sanitizeMessageOutput(data: ConductorMessageOutput): {
  sanitized: ConductorMessageOutput;
  warnings: string[];
} {
  const detected = new Set<string>();

  const redact = (s: string): string => {
    const r = redactProhibitedPhrases(s);
    r.detectedPhrases.forEach((p) => detected.add(p));
    return r.text;
  };

  let sanitized: ConductorMessageOutput;
  switch (data.messageType) {
    case 'text':
      sanitized = {
        messageType: 'text',
        name: redact(data.name),
        ...(data.category !== undefined && { category: redact(data.category) }),
        text: redact(data.text),
      };
      break;

    case 'image':
      // URL は redact しない (URL_LIKE_KEYS 扱い)
      sanitized = {
        messageType: 'image',
        name: redact(data.name),
        ...(data.category !== undefined && { category: redact(data.category) }),
        originalContentUrl: data.originalContentUrl,
        previewImageUrl: data.previewImageUrl,
      };
      break;

    case 'flex':
      sanitized = {
        messageType: 'flex',
        name: redact(data.name),
        ...(data.category !== undefined && { category: redact(data.category) }),
        altText: redact(data.altText),
        contents: redactDeep(data.contents, redact) as FlexBubble,
      };
      break;

    case 'carousel':
      sanitized = {
        messageType: 'carousel',
        name: redact(data.name),
        ...(data.category !== undefined && { category: redact(data.category) }),
        altText: redact(data.altText),
        bubbles: data.bubbles.map((b) => redactDeep(b, redact) as FlexBubble),
      };
      break;
  }

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
 * Flex bubble / carousel の任意の深さの object を再帰巡回し、
 * URL 系以外の string プロパティに redact を適用する。
 *
 * 注: bubble 内の `type: 'text'` の `text` プロパティや、
 * `action: { type: 'message', text: '...' }` 等が主な redact 対象。
 * `action: { type: 'uri', uri: '...' }` の uri は URL_LIKE_KEYS でスキップ。
 */
export function redactDeep(
  node: unknown,
  redact: (s: string) => string,
): unknown {
  if (node === null || node === undefined) return node;
  if (typeof node === 'string') return redact(node);
  if (typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    return node.map((item) => redactDeep(item, redact));
  }

  const obj = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (URL_LIKE_KEYS.has(key) && typeof value === 'string') {
      // URL 系は redact せずそのまま保持
      result[key] = value;
    } else {
      result[key] = redactDeep(value, redact);
    }
  }
  return result;
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
  messageOutputSchema,
  sanitizeMessageOutput,
  sanitizeUserPrompt,
  serializeForTemplatesTable,
  extractAltText,
  redactDeep,
  URL_LIKE_KEYS,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  NAME_MAX_LEN,
  TEXT_MAX_LEN,
  ALT_TEXT_MAX_LEN,
  CAROUSEL_BUBBLE_MIN,
  CAROUSEL_BUBBLE_MAX,
  MESSAGE_TYPES,
};
