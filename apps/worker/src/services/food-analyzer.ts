/**
 * AI 食事画像解析サービス (Phase 5β-prep adoption batch 2: AIRouter 経由)
 *
 * Phase 3 (AI 食事診断) の中核。LINE で受信した食事写真を vision 対応 provider
 * (現状 Claude のみ) に投げ、 カロリー・PFC・食材を JSON で取得して
 * `food_logs` に保存する。
 *
 * 設計方針:
 * - **vision 対応 provider**: AIRouter が 'vision' task で resolveProviders、 現状 Claude のみ
 * - **JSON 強制**: system prompt で "ONLY valid JSON" を厳命 + Zod で実行時検証
 * - **薬機法ガード**: AIRouter 内 (provider redact) + service 内 sanitizeAnalysis の二重防御
 * - **失敗時は throw**: caller (`webhook.ts`) が markFoodLogFailed() で記録する
 *
 * 使い方:
 *   const router = createAIRouterFromEnv(env);
 *   const analysis = await analyzeFoodImage({
 *     imageBytes: blob.bytes,
 *     mimeType: blob.contentType,
 *     userCaption: 'カレーライス',
 *     router,
 *   });
 *   await updateFoodLogAnalysis(env.DB, foodLogId, analysis);
 */

import { z } from 'zod';
import type { FoodAnalysis } from '@line-crm/db';
import {
  AIRouter,
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
} from '@line-crm/ai-provider';
import { extractJsonObject } from '../utils/json-extract.js';

// ----------------------------------------------------------------
// 定数
// ----------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 1024;

const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

// PROHIBITED_PHRASES / REDACTION_TOKEN は @line-crm/ai-provider から import (上記)。
// 旧: ローカル定義 (defense-in-depth の二次防御リスト) → 集約完了
// (food-analyzer / monthly-food-report / nutrition-recommender の 3 重定義を解消)

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
  /**
   * AIRouter. vision 対応 provider が `resolveProviders('vision')` に必要 (現状 Claude のみ).
   * 未利用なら api_key_missing エラー (互換性のため既存 error code を維持).
   */
  router: AIRouter;
  /** 最大バイト数 (デフォルト 5MB — LINE Content と整合) */
  maxImageBytes?: number;
}

// ----------------------------------------------------------------
// プロンプト
// ----------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは管理栄養士のアシスタントです。ユーザがアップロードした食事写真を解析し、
栄養情報を JSON 形式で返してください。

# 必須ルール
1. **出力は valid JSON のみ**。前後の説明文・マークダウン・コードブロックは禁止。
2. **正直性ルール（最重要）**: 料理名・食材が判別困難な場合（暗い・ぼけている・角度が悪い・知らない料理・小さすぎて細部が見えない 等）は、 適当に推定せず以下の形式で返すこと:
   - items: [{ "name": "unknown" }] のみ
   - notes: "画像の詳細が判別できません。 もしよろしければ料理名や食材を文字で教えていただけませんか？🙏"
   - calories / protein_g / fat_g / carbs_g: すべて 0
   サイズ感（一人前か大盛りか）が不明な場合も「unknown」 を返し、 量を勝手に決めない。
3. **判別できる場合のみ**: 麺の種類・スープ色・トッピング・盛り付け・色味等の客観的特徴を **必ず観察してから** 料理名を決定する。 推測ではなく観察に基づく判定。
4. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" 等) は **絶対に書かない**。
   薬機法に触れるため、栄養素と食材の客観的説明のみ記載すること。
5. items は最大 20 個まで。料理名と推定量を簡潔に。
6. 推定値（判別できた場合）は実物に即した妥当な範囲で（極端な値は避ける）。

# 出力スキーマ
{
  "calories": 数値 (kcal, 0〜10000、 判別不能なら 0),
  "protein_g": 数値 (g, 0〜1000、 判別不能なら 0),
  "fat_g": 数値 (g, 0〜1000、 判別不能なら 0),
  "carbs_g": 数値 (g, 0〜2000、 判別不能なら 0),
  "fiber_g": 数値 (g, optional),
  "items": [{ "name": "食材名 or 'unknown'", "qty": "推定量 (optional)" }],
  "notes": "客観的な栄養所見 or 判別不能時の案内 (optional, 500 字以内, 効能効果禁止)",
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

  // vision 対応 provider が無い (Claude 等の API_KEY 未設定) なら早期 throw
  if (input.router.resolveProviders('vision').length === 0) {
    throw new FoodAnalyzerError(
      'No vision-capable provider available (ANTHROPIC_API_KEY not configured)',
      'api_key_missing',
    );
  }

  const base64Image = uint8ArrayToBase64(input.imageBytes);

  // userCaption は LINE ユーザ入力なので prompt injection 対策で quote/改行/制御文字を除去
  const sanitizedCaption = input.userCaption
    ? sanitizeUserCaption(input.userCaption)
    : '';
  const userText = sanitizedCaption
    ? `この食事を解析してください。ユーザのコメント: "${sanitizedCaption}"`
    : 'この食事を解析してください。';

  // ---- Vision 呼び出し ----
  let response;
  try {
    response = await input.router.generateVision({
      systemPrompt: SYSTEM_PROMPT,
      userMessage: userText,
      imageBase64: base64Image,
      mediaType: input.mimeType,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
      throw new FoodAnalyzerError(
        `Vision API timed out`,
        'timeout',
        err,
      );
    }
    throw new FoodAnalyzerError(
      `Vision API call failed: ${err instanceof Error ? err.name : 'unknown'}`,
      'api_error',
      err,
    );
  }

  // ---- レスポンスから JSON 抽出 ----
  if (!response.text) {
    throw new FoodAnalyzerError('Vision response had no text', 'invalid_response');
  }

  const jsonString = extractJsonObject(response.text);
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

  // ---- 薬機法ガード (provider 内 redact + sanitize の二重防御) ----
  return sanitizeAnalysis({
    ...validated.data,
    model_version: validated.data.model_version ?? response.model,
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

// extractJsonObject は utils/json-extract.ts に移動 (Phase 5γ-5)。
// 本 file 冒頭の import で利用。 個別 export を停止 (caller は webhook.ts 内のみ、 同一 file の関数経由)。

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
  // Phase 5β-prep adoption: @line-crm/ai-provider の集約済 redact 関数を使用
  return redactProhibitedPhrases(text).text;
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
