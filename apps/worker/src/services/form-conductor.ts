/**
 * Phase 5γ-3: AI Conductor — Form Generator
 *
 * 自然言語プロンプトから LINE LIFF フォーム (apps/web 経由) で使用する `forms` レコードの
 * 構造化 JSON を生成する。 5γ-1 (scenario) / 5γ-2 (rich-menu) と同じパターン。
 *
 * 設計方針:
 *   - **生成のみ**: DB INSERT しない。 caller (UI) がプレビュー確認後に `POST /api/forms`
 *   - **fields は LIFF UI 制約に準拠**: 最大 50 件 (UI が破綻する閾値)、 type は固定 7 種
 *   - **field.name は snake_case**: フォーム送信時の submission.data key になるため
 *   - **薬機ガード**: name / description / field.label / field.placeholder に redact
 *   - **brand 値 hardcode 禁止**: label / placeholder に `{{brand_name}}` placeholder 強制
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
const FIELD_MIN_COUNT = 1;
const FIELD_MAX_COUNT = 50;
const NAME_MAX_LEN = 100;
const DESCRIPTION_MAX_LEN = 500;
const FIELD_LABEL_MAX_LEN = 100;
const FIELD_PLACEHOLDER_MAX_LEN = 200;

const FIELD_TYPES = [
  'text',
  'textarea',
  'email',
  'tel',
  'number',
  'select',
  'checkbox',
  'radio',
  'date',
] as const;

// snake_case 検証用 regex (英小文字 + 数字 + _、 開始は英字)
const SNAKE_CASE_REGEX = /^[a-z][a-z0-9_]*$/;

// ----------------------------------------------------------------
// Zod スキーマ
// ----------------------------------------------------------------

const fieldOptionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(100),
});

const fieldSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(50)
      .regex(SNAKE_CASE_REGEX, 'field.name must be snake_case (a-z, 0-9, _)'),
    label: z.string().min(1).max(FIELD_LABEL_MAX_LEN),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().optional(),
    placeholder: z.string().max(FIELD_PLACEHOLDER_MAX_LEN).optional(),
    /** select / radio / checkbox 用の選択肢 */
    options: z.array(fieldOptionSchema).min(1).max(50).optional(),
  })
  .refine(
    (f) => {
      // select / radio / checkbox には options が必須
      if (['select', 'radio', 'checkbox'].includes(f.type)) {
        return Array.isArray(f.options) && f.options.length > 0;
      }
      return true;
    },
    {
      message: 'field type select/radio/checkbox requires non-empty options',
    },
  );

const formOutputSchema = z.object({
  name: z.string().min(1).max(NAME_MAX_LEN),
  description: z.string().max(DESCRIPTION_MAX_LEN).nullable().optional(),
  fields: z.array(fieldSchema).min(FIELD_MIN_COUNT).max(FIELD_MAX_COUNT),
  /** 任意: 送信成功時に friend にタグを付与する場合 */
  onSubmitTagId: z.string().nullable().optional(),
  /** 任意: 送信成功時にシナリオに enroll する場合 */
  onSubmitScenarioId: z.string().nullable().optional(),
  /** 送信内容を friend.metadata に保存するか (default false) */
  saveToMetadata: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export type ConductorFormOutput = z.infer<typeof formOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type FormConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class FormConductorError extends Error {
  constructor(
    message: string,
    public readonly code: FormConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'FormConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは LINE LIFF フォーム (顧客アンケート / 申込書 / 商品リサーチ等) の
構造化 JSON を生成するアシスタントです。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
3. ブランド名・商品名の具体値は埋め込まず、 \`{{brand_name}}\` placeholder を使う。
4. fields は 1〜${FIELD_MAX_COUNT} 件。 多すぎは UI 破綻 + 回答率低下。
5. field.name は **snake_case** (a-z / 0-9 / _ のみ、 開始は英字)。 例: \`birth_date\`, \`favorite_color\`
6. field.type は以下から選ぶ: \`text\`, \`textarea\`, \`email\`, \`tel\`, \`number\`, \`select\`, \`checkbox\`, \`radio\`, \`date\`
7. \`select\` / \`checkbox\` / \`radio\` には **options 配列が必須** (value + label のオブジェクト)。
8. field.label は質問文 (100 字以内、 ユーザに見える)。
9. field.placeholder は入力例 (200 字以内、 optional)。

# 出力スキーマ
{
  "name": "フォーム管理名 (100 字以内)",
  "description": "フォームの説明 (500 字以内、 optional)",
  "fields": [
    {
      "name": "email",
      "label": "メールアドレス",
      "type": "email",
      "required": true,
      "placeholder": "name@example.com"
    },
    {
      "name": "subscribe",
      "label": "メルマガを受け取る",
      "type": "checkbox",
      "options": [
        { "value": "yes", "label": "受け取る" },
        { "value": "no", "label": "受け取らない" }
      ]
    }
  ],
  "onSubmitTagId": null,
  "onSubmitScenarioId": null,
  "saveToMetadata": true,
  "isActive": false
}

# 慣例
- 必須項目は明示的に required=true、 任意は省略 (default false)
- 連絡先取得目的なら email / tel を必須に
- アンケート目的なら text / select / radio を中心に
- placeholder は実例 (例: "山田太郎"、 "name@example.com")
`;

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface GenerateFormInput {
  prompt: string;
  router: AIRouter;
  maxTokens?: number;
}

export interface GenerateFormResult {
  form: ConductorFormOutput;
  warnings: string[];
  provider: string;
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateFormFromPrompt(
  input: GenerateFormInput,
): Promise<GenerateFormResult> {
  // 入力検証
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new FormConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new FormConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new FormConductorError(
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
      throw new FormConductorError('AI provider timed out', 'timeout', err);
    }
    throw new FormConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new FormConductorError('AI response had no text', 'invalid_response');
  }

  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new FormConductorError(
      'Failed to extract JSON object from response',
      'invalid_response',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new FormConductorError(
      'Response was not valid JSON',
      'invalid_response',
      err,
    );
  }

  const validated = formOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new FormConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  // field.name 重複検証 (Zod だけでは fields[*].name の uniqueness が表現しづらい)
  validateUniqueFieldNames(validated.data.fields);

  const { sanitized, warnings } = sanitizeFormOutput(validated.data);

  return {
    form: sanitized,
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

/**
 * field.name は submission data の key になるため重複禁止。
 */
function validateUniqueFieldNames(fields: ReadonlyArray<{ name: string }>): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.name)) {
      throw new FormConductorError(
        `duplicate field.name "${f.name}" (each field must have unique name)`,
        'schema_validation_failed',
      );
    }
    seen.add(f.name);
  }
}

/**
 * 全文字列フィールド (label / placeholder / description / option.label 等) に redact 適用。
 * field.name は snake_case 制約があるので redact 対象外 (NG ワードが含まれることはない)。
 */
function sanitizeFormOutput(data: ConductorFormOutput): {
  sanitized: ConductorFormOutput;
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

  const sanitized: ConductorFormOutput = {
    name: redact(data.name),
    description: redactOpt(data.description),
    fields: data.fields.map((f) => ({
      name: f.name,
      label: redact(f.label),
      type: f.type,
      ...(f.required !== undefined && { required: f.required }),
      ...(f.placeholder !== undefined && { placeholder: redact(f.placeholder) }),
      ...(f.options !== undefined && {
        options: f.options.map((opt) => ({
          value: opt.value,
          label: redact(opt.label),
        })),
      }),
    })),
    onSubmitTagId: data.onSubmitTagId ?? null,
    onSubmitScenarioId: data.onSubmitScenarioId ?? null,
    saveToMetadata: data.saveToMetadata ?? false,
    isActive: data.isActive ?? false,
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
  formOutputSchema,
  sanitizeFormOutput,
  sanitizeUserPrompt,
  validateUniqueFieldNames,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  FIELD_MIN_COUNT,
  FIELD_MAX_COUNT,
  FIELD_TYPES,
};
