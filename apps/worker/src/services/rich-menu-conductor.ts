/**
 * Phase 5γ-2: AI Conductor — Rich Menu Generator
 *
 * 自然言語プロンプトから LINE Rich Menu Object の構造化 JSON を生成する。
 * 5γ-1 (scenario-conductor) と同じパターン (Vision-JSON adoption + Zod + redact)
 * を rich menu 用に転用。
 *
 * 設計方針:
 *   - **生成のみ**: DB INSERT も LINE API への登録もしない。 caller (UI) がプレビュー
 *     確認後に `POST /api/rich-menus` を叩く。 rich menu は LINE 側で管理 (D1 永続化なし)
 *   - **LINE 公式制約に厳格準拠**: size は LARGE (2500x1686) / SMALL (2500x843) のみ。
 *     areas は 1〜20 件、 bounds は整数、 size 枠内に収まる必要がある (Zod refine)
 *   - **薬機ガード**: name / chatBarText / action 内文字列に redact 適用
 *   - **action 種別**: postback / message / uri / richmenuswitch (datetimepicker は除外、
 *     AI 生成では混乱しやすい)
 *   - **brand 値 hardcode 禁止**: text / data に `{{brand_name}}` placeholder 強制
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
const AREAS_MIN_COUNT = 1;
const AREAS_MAX_COUNT = 20;

const RICH_MENU_SIZE_LARGE = { width: 2500, height: 1686 } as const;
const RICH_MENU_SIZE_SMALL = { width: 2500, height: 843 } as const;

const NAME_MAX_LEN = 300;
const CHAT_BAR_TEXT_MAX_LEN = 14;

// ----------------------------------------------------------------
// Zod スキーマ — AI が返す JSON を実行時検証
// ----------------------------------------------------------------

const sizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .refine(
    (s) =>
      (s.width === RICH_MENU_SIZE_LARGE.width && s.height === RICH_MENU_SIZE_LARGE.height) ||
      (s.width === RICH_MENU_SIZE_SMALL.width && s.height === RICH_MENU_SIZE_SMALL.height),
    {
      message: 'size must be 2500x1686 (LARGE) or 2500x843 (SMALL)',
    },
  );

const boundsSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const actionPostbackSchema = z.object({
  type: z.literal('postback'),
  data: z.string().min(1).max(300),
  displayText: z.string().max(300).optional(),
  label: z.string().max(20).optional(),
});

const actionMessageSchema = z.object({
  type: z.literal('message'),
  text: z.string().min(1).max(300),
  label: z.string().max(20).optional(),
});

const actionUriSchema = z.object({
  type: z.literal('uri'),
  uri: z.string().url().max(1000),
  label: z.string().max(20).optional(),
});

const actionRichMenuSwitchSchema = z.object({
  type: z.literal('richmenuswitch'),
  richMenuAliasId: z.string().min(1).max(100),
  data: z.string().min(1).max(300),
  label: z.string().max(20).optional(),
});

const actionSchema = z.discriminatedUnion('type', [
  actionPostbackSchema,
  actionMessageSchema,
  actionUriSchema,
  actionRichMenuSwitchSchema,
]);

const areaSchema = z.object({
  bounds: boundsSchema,
  action: actionSchema,
});

const richMenuOutputSchema = z.object({
  size: sizeSchema,
  selected: z.boolean(),
  name: z.string().min(1).max(NAME_MAX_LEN),
  chatBarText: z.string().min(1).max(CHAT_BAR_TEXT_MAX_LEN),
  areas: z.array(areaSchema).min(AREAS_MIN_COUNT).max(AREAS_MAX_COUNT),
});

export type ConductorRichMenuOutput = z.infer<typeof richMenuOutputSchema>;

// ----------------------------------------------------------------
// エラー
// ----------------------------------------------------------------

export type RichMenuConductorErrorCode =
  | 'prompt_too_short'
  | 'prompt_too_long'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class RichMenuConductorError extends Error {
  constructor(
    message: string,
    public readonly code: RichMenuConductorErrorCode,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'RichMenuConductorError';
  }
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは LINE 公式アカウントの CRM 担当者向けに、
リッチメニューの構造化 JSON を生成するアシスタントです。

# 必須ルール
1. **出力は valid JSON のみ**。 前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
3. ブランド名・商品名の具体値は埋め込まず、 \`{{brand_name}}\` placeholder を使う。
4. size は LARGE (2500x1686) / SMALL (2500x843) のみ。 ユーザ指定が無ければ LARGE。
5. areas は 1〜${AREAS_MAX_COUNT} 件。 bounds (x, y, width, height) は整数、 size 枠内に収まる必要あり。
6. areas は重なり禁止 (LINE 側で重なりは undefined behavior)。
7. chatBarText は **14 文字以内** (LINE 制約、 全角 14 字)。
8. name は管理用ラベル (300 字以内、 ユーザには見えない)。
9. action は "postback" / "message" / "uri" / "richmenuswitch" のいずれか:
   - postback: data (postback event の data 文字列), displayText (任意)
   - message: text (送信メッセージ本文)
   - uri: uri (http(s):// 完全 URL、 \`{{shop_url}}\` placeholder 推奨)
   - richmenuswitch: richMenuAliasId + data (alias 切替)

# 出力スキーマ
{
  "size": { "width": 2500, "height": 1686 },
  "selected": true,
  "name": "管理用ラベル (300 字以内)",
  "chatBarText": "メニュー (14 字以内)",
  "areas": [
    {
      "bounds": { "x": 0, "y": 0, "width": 1250, "height": 843 },
      "action": { "type": "postback", "data": "action=shop" }
    }
  ]
}

# 慣例的レイアウト
- LARGE (2500x1686) は 2x3 (6 ボタン) か 3x2 (6 ボタン) が定番
- SMALL (2500x843) は 1x3 (3 ボタン) か 1x4 (4 ボタン) が定番
- 各 area の bounds は size を均等分割するのが基本 (重なり / 隙間を避ける)

# placeholder 例
\`\`\`
chatBarText: "メニュー"
action.data: "action=shop&brand={{brand_name}}"
action.uri: "{{shop_url}}/collections/featured"
\`\`\``;

// ----------------------------------------------------------------
// 入出力型
// ----------------------------------------------------------------

export interface GenerateRichMenuInput {
  /** ユーザの自然言語プロンプト (5〜4000 字) */
  prompt: string;
  /** AIRouter */
  router: AIRouter;
  /** 最大 token (default 4096) */
  maxTokens?: number;
}

export interface GenerateRichMenuResult {
  richMenu: ConductorRichMenuOutput;
  /** redact 検出フレーズ等の警告 */
  warnings: string[];
  /** 実際に使われた provider id */
  provider: string;
  /** 実際に使われた model id */
  model: string;
}

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

export async function generateRichMenuFromPrompt(
  input: GenerateRichMenuInput,
): Promise<GenerateRichMenuResult> {
  // ---- 入力検証 ----
  const trimmed = input.prompt.trim();
  if (trimmed.length < PROMPT_MIN_LEN) {
    throw new RichMenuConductorError(
      `prompt too short (min ${PROMPT_MIN_LEN} chars after trim)`,
      'prompt_too_short',
    );
  }
  if (trimmed.length > PROMPT_MAX_LEN) {
    throw new RichMenuConductorError(
      `prompt too long (max ${PROMPT_MAX_LEN} chars)`,
      'prompt_too_long',
    );
  }

  // ---- provider 利用可能性 ----
  if (input.router.resolveProviders('scenario-gen').length === 0) {
    throw new RichMenuConductorError(
      'No scenario-gen provider available. Configure ANTHROPIC_API_KEY (recommended) or ensure Workers AI binding is set.',
      'api_key_missing',
    );
  }

  // ---- ユーザ prompt sanitize ----
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
      throw new RichMenuConductorError('AI provider timed out', 'timeout', err);
    }
    throw new RichMenuConductorError(
      `AI provider call failed: ${err instanceof Error ? err.message : 'unknown'}`,
      'api_error',
      err,
    );
  }

  if (!response.text) {
    throw new RichMenuConductorError('AI response had no text', 'invalid_response');
  }

  // ---- JSON 抽出 (scenario-conductor から再利用) ----
  const jsonString = extractJsonObject(response.text);
  if (!jsonString) {
    throw new RichMenuConductorError(
      'Failed to extract JSON object from response',
      'invalid_response',
    );
  }

  // ---- JSON parse ----
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new RichMenuConductorError(
      'Response was not valid JSON',
      'invalid_response',
      err,
    );
  }

  // ---- Zod schema 検証 ----
  const validated = richMenuOutputSchema.safeParse(parsed);
  if (!validated.success) {
    throw new RichMenuConductorError(
      `Schema validation failed: ${validated.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  // ---- area bounds の境界外チェック ----
  validateAreasWithinSize(validated.data);

  // ---- area bounds 重なり検出 (LINE 側で undefined なので reject) ----
  validateAreasNoOverlap(validated.data.areas);

  // ---- 薬機ガード ----
  const { sanitized, warnings } = sanitizeRichMenuOutput(validated.data);

  return {
    richMenu: sanitized,
    warnings,
    provider: response.provider,
    model: response.model,
  };
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

/**
 * 各 area の bounds が size 枠内に収まるか検証。
 * LINE 側でも reject されるが、 先に詳細 message で reject する方が UX 良い。
 */
function validateAreasWithinSize(data: ConductorRichMenuOutput): void {
  for (let i = 0; i < data.areas.length; i++) {
    const area = data.areas[i];
    const right = area.bounds.x + area.bounds.width;
    const bottom = area.bounds.y + area.bounds.height;
    if (right > data.size.width || bottom > data.size.height) {
      throw new RichMenuConductorError(
        `area[${i}] bounds (x=${area.bounds.x}, y=${area.bounds.y}, w=${area.bounds.width}, h=${area.bounds.height}) extends beyond size (${data.size.width}x${data.size.height})`,
        'schema_validation_failed',
      );
    }
  }
}

/**
 * area 同士の bounds が重なっていないか検証 (LINE 側で undefined behavior)。
 * 2 矩形が重なる条件: 互いに片方の x/y 範囲が他方と交差。
 */
function validateAreasNoOverlap(
  areas: ReadonlyArray<{ bounds: { x: number; y: number; width: number; height: number } }>,
): void {
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i].bounds;
      const b = areas[j].bounds;
      const xOverlap = a.x < b.x + b.width && b.x < a.x + a.width;
      const yOverlap = a.y < b.y + b.height && b.y < a.y + a.height;
      if (xOverlap && yOverlap) {
        throw new RichMenuConductorError(
          `area[${i}] and area[${j}] bounds overlap`,
          'schema_validation_failed',
        );
      }
    }
  }
}

/**
 * 全文字列フィールドに redactProhibitedPhrases を適用。
 * action 種別ごとに字段が違うので分岐 (discriminated union を順守)。
 */
function sanitizeRichMenuOutput(data: ConductorRichMenuOutput): {
  sanitized: ConductorRichMenuOutput;
  warnings: string[];
} {
  const detected = new Set<string>();

  const redact = (s: string): string => {
    const r = redactProhibitedPhrases(s);
    r.detectedPhrases.forEach((p) => detected.add(p));
    return r.text;
  };

  const redactOpt = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    return redact(s);
  };

  const sanitizedAreas = data.areas.map((area) => {
    const action = area.action;
    let newAction: typeof action;
    switch (action.type) {
      case 'postback':
        newAction = {
          type: 'postback',
          data: redact(action.data),
          ...(action.displayText !== undefined && { displayText: redact(action.displayText) }),
          ...(action.label !== undefined && { label: redact(action.label) }),
        };
        break;
      case 'message':
        newAction = {
          type: 'message',
          text: redact(action.text),
          ...(action.label !== undefined && { label: redact(action.label) }),
        };
        break;
      case 'uri':
        // uri 本体は redact 対象から外す (URL 構造を壊さないため。 label のみ redact)
        newAction = {
          type: 'uri',
          uri: action.uri,
          ...(action.label !== undefined && { label: redact(action.label) }),
        };
        break;
      case 'richmenuswitch':
        newAction = {
          type: 'richmenuswitch',
          richMenuAliasId: action.richMenuAliasId,
          data: redact(action.data),
          ...(action.label !== undefined && { label: redact(action.label) }),
        };
        break;
    }
    return { bounds: area.bounds, action: newAction };
  });

  const sanitized: ConductorRichMenuOutput = {
    size: data.size,
    selected: data.selected,
    name: redact(data.name),
    chatBarText: redact(data.chatBarText),
    areas: sanitizedAreas,
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
 * ユーザ prompt サニタイズ (scenario-conductor と同等)。
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
  richMenuOutputSchema,
  sanitizeRichMenuOutput,
  sanitizeUserPrompt,
  validateAreasWithinSize,
  validateAreasNoOverlap,
  PROMPT_MIN_LEN,
  PROMPT_MAX_LEN,
  AREAS_MAX_COUNT,
  NAME_MAX_LEN,
  CHAT_BAR_TEXT_MAX_LEN,
  RICH_MENU_SIZE_LARGE,
  RICH_MENU_SIZE_SMALL,
};
