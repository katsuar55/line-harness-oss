/**
 * AI 食事画像解析サービス (Anthropic Claude Vision)
 *
 * Phase 3 (AI 食事診断) の中核。LINE で受信した食事写真を Claude Vision に投げ、
 * カロリー・PFC・食材を JSON で取得して `food_logs` に保存する。
 *
 * 設計方針:
 * - **モデル**: claude-haiku-4.5 (vision 対応・低コスト・高速)
 * - **JSON 強制**: system prompt で "ONLY valid JSON" を厳命 + Zod で実行時検証
 * - **薬機法ガード**: 効能効果断定ワード ("治る" "効く" "病気が改善" 等) を notes から redaction
 * - **タイムアウト**: 30 秒 (vision は 10s では足りない)
 * - **失敗時は throw**: caller (`webhook.ts`) が markFoodLogFailed() で記録する
 *
 * Anthropic SDK は Workers fetch を内部で使うため Cloudflare Workers でそのまま動く。
 *
 * 使い方:
 *   const analysis = await analyzeFoodImage({
 *     imageBytes: blob.bytes,
 *     mimeType: blob.contentType,
 *     userCaption: 'カレーライス',
 *     apiKey: env.ANTHROPIC_API_KEY,
 *   });
 *   await updateFoodLogAnalysis(env.DB, foodLogId, analysis);
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { FoodAnalysis } from '@line-crm/db';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 1024;

const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

/**
 * 薬機法・医療系の効能効果断定ワード。
 *
 * **位置づけ**: defense-in-depth の二次防御。一次防御は SYSTEM_PROMPT で AI に
 * 「効能効果を書かない」よう指示する側。ここはそれをすり抜けたケース向け。
 *
 * 制限事項: 完全網羅ではない。AI が予期せぬ表記揺れ (例: カタカナ "ナオル"、
 * 英語 "cure") を返した場合は通過する可能性がある。本格的な薬機チェックには
 * 専用の辞書 + 形態素解析が必要。
 *
 * リスト方針: 平易なひらがな・漢字 + 一般的なカタカナ揺れを最低限カバー。
 */
const PROHIBITED_PHRASES = [
  // 完治/治療系
  '治る',
  '治す',
  '治療',
  '完治',
  '治癒',
  'ナオル',
  // 効能系
  '効く',
  '効果絶大',
  '即効',
  // 病気が消える系
  '病気が改善',
  '症状が消える',
  'がんが消える',
  '癌が消える',
  // 予防系 (断定)
  '予防できる',
  '予防効果',
  // 医薬品扱い系
  '医薬品',
  '副作用なし',
  // 過剰保証
  '保証',
  // 英語 (AI が稀に混ぜる)
  'cure',
  'heal',
] as const;

const REDACTION_TOKEN = '[省略]';

// ----------------------------------------------------------------
// Zod スキーマ — Claude が返す JSON を実行時検証する
// ----------------------------------------------------------------

const foodAnalysisSchema = z.object({
  // .finite() で NaN / Infinity を明示的に拒否 (将来 .max() を緩めても安全)
  calories: z.number().finite().min(0).max(10_000),
  protein_g: z.number().finite().min(0).max(1000),
  fat_g: z.number().finite().min(0).max(1000),
  carbs_g: z.number().finite().min(0).max(2000),
  fiber_g: z.number().finite().min(0).max(200).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        qty: z.string().max(50).optional(),
      }),
    )
    .min(0)
    .max(20),
  notes: z.string().max(500).optional(),
  model_version: z.string().max(50).optional(),
});

// ----------------------------------------------------------------
// 型・エラー
// ----------------------------------------------------------------

export type FoodAnalyzerErrorCode =
  | 'invalid_mime_type'
  | 'image_too_large'
  | 'api_key_missing'
  | 'timeout'
  | 'invalid_response'
  | 'schema_validation_failed'
  | 'api_error';

export class FoodAnalyzerError extends Error {
  constructor(
    message: string,
    public readonly code: FoodAnalyzerErrorCode,
    cause?: unknown,
  ) {
    // ES2022 Error.cause を使う (Sentry 等の構造化ロガーが認識できる)
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'FoodAnalyzerError';
  }
}

export interface AnalyzeFoodImageInput {
  /** 画像バイナリ (LINE Content API 等から取得) */
  imageBytes: Uint8Array;
  /** "image/jpeg" / "image/png" / "image/webp" / "image/gif" */
  mimeType: string;
  /** ユーザの自由記述 (キャプション)。"カレーライスとサラダ" 等 */
  userCaption?: string;
  /** Anthropic API キー (env.ANTHROPIC_API_KEY) */
  apiKey: string;
  /** モデル名 override (デフォルト claude-haiku-4-5) */
  model?: string;
  /** タイムアウト ms (デフォルト 30000) */
  timeoutMs?: number;
  /** 最大バイト数 (デフォルト 5MB — LINE Content と整合) */
  maxImageBytes?: number;
  /** テスト用 Anthropic クライアント注入 */
  clientOverride?: Pick<Anthropic, 'messages'>;
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは管理栄養士のアシスタントです。ユーザがアップロードした食事写真を解析し、
栄養情報を JSON 形式で返してください。

# 必須ルール
1. **出力は valid JSON のみ**。前後の説明文・マークダウン・コードブロックは禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" 等) は **絶対に書かない**。
   薬機法に触れるため、栄養素と食材の客観的説明のみ記載すること。
3. 推定値が不明な場合は妥当な平均値を使う (極端な値は避ける)。
4. items は最大 20 個まで。料理名と推定量を簡潔に。

# 出力スキーマ
{
  "calories": 数値 (kcal, 0〜10000),
  "protein_g": 数値 (g, 0〜1000),
  "fat_g": 数値 (g, 0〜1000),
  "carbs_g": 数値 (g, 0〜2000),
  "fiber_g": 数値 (g, optional),
  "items": [{ "name": "食材名", "qty": "推定量 (optional)" }],
  "notes": "客観的な栄養所見 (optional, 500 字以内, 効能効果禁止)",
  "model_version": "claude-haiku-4-5" (固定)
}`;

// ----------------------------------------------------------------
// メイン関数
// ----------------------------------------------------------------

/**
 * 食事画像を Claude Vision で解析し、栄養情報を返す。
 *
 * @throws {FoodAnalyzerError} API 呼び出し失敗 / スキーマ違反 / タイムアウト等
 */
export async function analyzeFoodImage(input: AnalyzeFoodImageInput): Promise<FoodAnalysis> {
  // ---- 入力検証 ----
  if (!input.apiKey) {
    throw new FoodAnalyzerError('ANTHROPIC_API_KEY is not configured', 'api_key_missing');
  }
  if (!isSupportedMimeType(input.mimeType)) {
    throw new FoodAnalyzerError(
      `Unsupported mime type: ${input.mimeType}. Allowed: ${SUPPORTED_MIME_TYPES.join(', ')}`,
      'invalid_mime_type',
    );
  }
  const maxBytes = input.maxImageBytes ?? 5 * 1024 * 1024;
  if (input.imageBytes.byteLength === 0) {
    throw new FoodAnalyzerError('imageBytes is empty', 'invalid_response');
  }
  if (input.imageBytes.byteLength > maxBytes) {
    throw new FoodAnalyzerError(
      `Image ${input.imageBytes.byteLength} bytes exceeds limit ${maxBytes}`,
      'image_too_large',
    );
  }

  const client =
    input.clientOverride ??
    new Anthropic({
      apiKey: input.apiKey,
      // Workers では undici の AbortSignal.timeout は使えるので SDK のデフォルトでよい
    });

  const model = input.model ?? DEFAULT_MODEL;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base64Image = uint8ArrayToBase64(input.imageBytes);

  // ---- Anthropic 呼び出し (タイムアウト付き) ----
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Anthropic.Messages.Message;
  try {
    // userCaption は LINE ユーザ入力なので prompt injection 対策で quote/改行/制御文字を除去
    const sanitizedCaption = input.userCaption
      ? sanitizeUserCaption(input.userCaption)
      : '';
    const userText = sanitizedCaption
      ? `この食事を解析してください。ユーザのコメント: "${sanitizedCaption}"`
      : 'この食事を解析してください。';

    response = await client.messages.create(
      {
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: input.mimeType as SupportedMimeType,
                  data: base64Image,
                },
              },
              { type: 'text', text: userText },
            ],
          },
        ],
      },
      { signal: controller.signal },
    );
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new FoodAnalyzerError(
        `Anthropic API timed out after ${timeoutMs}ms`,
        'timeout',
        err,
      );
    }
    throw new FoodAnalyzerError(
      `Anthropic API call failed: ${err instanceof Error ? err.name : 'unknown'}`,
      'api_error',
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  // ---- レスポンスから JSON 抽出 ----
  const textBlock = response.content.find((b) => b.type === 'text') as
    | Extract<Anthropic.Messages.ContentBlock, { type: 'text' }>
    | undefined;
  if (!textBlock?.text) {
    throw new FoodAnalyzerError('Anthropic response had no text block', 'invalid_response');
  }

  const jsonString = extractJsonObject(textBlock.text);
  if (!jsonString) {
    throw new FoodAnalyzerError(
      'Failed to extract JSON object from response',
      'invalid_response',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    throw new FoodAnalyzerError(
      'Response was not valid JSON',
      'invalid_response',
      err,
    );
  }

  const validated = foodAnalysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new FoodAnalyzerError(
      `Schema validation failed: ${validated.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join(', ')}`,
      'schema_validation_failed',
      validated.error,
    );
  }

  // ---- 薬機法ガード ----
  return sanitizeAnalysis({
    ...validated.data,
    model_version: validated.data.model_version ?? model,
  });
}

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------

function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Uint8Array を base64 文字列に変換。Anthropic SDK が Node Buffer/base64 を期待するため。
 *
 * Workers ランタイムには Buffer がないので、btoa + binary string 経由で変換する。
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // chunk 単位で処理 (大きい配列を一度に String.fromCharCode に渡すとスタック溢れ)。
  // Uint8Array は array-like なので Array.from でコピーせず subarray を直接 apply に渡す
  // (Workers の sub-request 内ではメモリ余裕がないため二重アロケートを避ける)。
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * テキスト中から最初の JSON オブジェクト ({...}) を抽出する。
 *
 * Claude が稀に "```json\n{...}\n```" や前置き文を返すケースに耐える。
 * ネスト対応のための簡易ブレース・カウンタ (文字列中の `{` `}` は無視)。
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
 * notes / items.name / items.qty に含まれる薬機法 NG ワードを redaction する。
 *
 * フレーズ単位で置換 (フィールド全体を消さない)。
 * 例: "タンパク質豊富で病気が改善します" → "タンパク質豊富で[省略]します"
 *
 * 副次効果として items.name 全体が NG ワードのみで構成される (例: "医薬品") 場合は
 * "[省略]" だけのフィールドになる。Zod は min(1) のためそのまま通る。
 */
export function sanitizeAnalysis(analysis: FoodAnalysis): FoodAnalysis {
  return {
    ...analysis,
    items: analysis.items.map((item) => ({
      name: redactProhibited(item.name),
      ...(item.qty !== undefined && {
        qty: redactProhibited(item.qty),
      }),
    })),
    ...(analysis.notes !== undefined && {
      notes: redactProhibited(analysis.notes),
    }),
  };
}

/**
 * 文字列内の禁止フレーズを `REDACTION_TOKEN` で置換する (フレーズ単位)。
 * NG ワードを含まない場合は元の文字列を返す。
 *
 * Japanese 文字に対する toLowerCase() は no-op なので、英語ワードのみ
 * case-insensitive にする (英語ワードは ASCII 限定なので lower 比較で OK)。
 */
function redactProhibited(text: string): string {
  if (!text) return text;
  let result = text;
  for (const phrase of PROHIBITED_PHRASES) {
    if (!phrase) continue;
    // 英語ワードは case-insensitive、日本語ワードは exact match
    const isAscii = /^[\x00-\x7f]+$/.test(phrase);
    if (isAscii) {
      const re = new RegExp(escapeRegExp(phrase), 'gi');
      result = result.replace(re, REDACTION_TOKEN);
    } else {
      result = result.split(phrase).join(REDACTION_TOKEN);
    }
  }
  return result;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 含有チェック (テスト用)。redactProhibited とロジックを揃える。
 */
function containsProhibited(text: string): boolean {
  if (!text) return false;
  return PROHIBITED_PHRASES.some((p) => {
    if (/^[\x00-\x7f]+$/.test(p)) {
      return text.toLowerCase().includes(p.toLowerCase());
    }
    return text.includes(p);
  });
}

/**
 * userCaption (LINE ユーザ入力) を Anthropic に渡す前にサニタイズ。
 * - quote (`"` `'`) を全角に置換 (prompt の delimiter を壊さない)
 * - 制御文字・改行を空白に
 * - 200 字に切り詰め
 */
function sanitizeUserCaption(raw: string): string {
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/"/g, '”')
    .replace(/'/g, '’')
    .trim()
    .slice(0, 200);
}

// テスト用エクスポート
export const __test__ = {
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  foodAnalysisSchema,
  containsProhibited,
  redactProhibited,
  sanitizeUserCaption,
};
