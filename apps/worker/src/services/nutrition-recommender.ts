/**
 * 栄養レコメンド生成サービス (Phase 4 PR-3)
 *
 * PR-2 (`nutrition-analyzer`) が決定論で算出した `NutritionDeficit[]` を受け取り、
 *   1. SKU マップから商品を紐付け
 *   2. AIRouter ('nutrition-copy' task) で 60 字以内・薬機 OK な日本語コピーを生成
 *      (失敗時は固定テンプレにフォールバック)
 *   3. `nutrition_recommendations` テーブルに永続化
 * までを 1 関数で行う。
 *
 * 設計方針:
 * - **副作用は DB insert のみ**。配信 (LINE push) は別レイヤー (Phase 4 PR-4 以降) が担当。
 * - **AI 失敗を握り潰す**。AI が落ちてもユーザ向けレコメンドは出すべきなので
 *   テンプレに切り替えて `source: 'template'` で記録する。DB insert 失敗のみ throw。
 * - **薬機ガード二重化**: 一次は system prompt で AI に "効能効果断定禁止" を指示。
 *   二次は出力テキストに対する `redactProhibited` フィルタ (food-analyzer と同等)。
 *   provider 内 (router) でも 1 回 redact されるため実質的には三重防御。
 * - **deficits 空 / SKU 全件不在 → null**: caller (LIFF API) は null を「今は提案なし」
 *   として扱い、`nutrition_recommendations` には書かない (空カードを作らない)。
 * - **Phase 5β-prep adoption batch 2 (2026-05-16)**: Anthropic 直叩を AIRouter 経由に統合。
 *   旧 apiKey / clientOverride / model 引数は router に集約。
 */

import {
  getSkuMapByDeficit,
  insertNutritionRecommendation,
} from '@line-crm/db';
import type {
  NutritionDeficit,
  NutritionRecommendation,
  SkuSuggestion,
} from '@line-crm/db';
import {
  AIRouter,
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
} from '@line-crm/ai-provider';

// ============================================================
// 定数
// ============================================================

const DEFAULT_MAX_TOKENS = 200;
/** AI コピーの最大長 (60 字)。超過分は切り詰め */
const AI_MESSAGE_MAX_LEN = 120;
/** SKU コピー (`copy_template` から派生) の最大長 (60 字以内に揃える) */
const SKU_COPY_MAX_LEN = 60;

// PROHIBITED_PHRASES / REDACTION_TOKEN は @line-crm/ai-provider から import (上記)。
// 旧: ローカル const 定義 (food-analyzer / monthly-food-report と 3 重定義) → 集約完了。

/** severity の優先順位 (代表 deficit 抽出用、降順) */
const SEVERITY_ORDER: Record<NutritionDeficit['severity'], number> = {
  severe: 3,
  moderate: 2,
  mild: 1,
};

const DEFICIT_LABEL: Record<NutritionDeficit['key'], string> = {
  protein_low: 'たんぱく質',
  fiber_low: '食物繊維',
  iron_low: '鉄分',
  calorie_low: 'エネルギー',
  calorie_high: 'エネルギー',
};

const SYSTEM_PROMPT = `あなたは管理栄養士のアシスタントです。ユーザの直近 7 日間の栄養傾向データから、
LINE で表示する短い励ましメッセージを生成してください。

# 必須ルール
1. 出力は 60 字以内の日本語 1 文。マークダウン・記号装飾・箇条書き禁止。
2. 効能効果の断定 ("〜が治る" "〜に効く" "病気が改善" "予防できる" 等) は **絶対に書かない**。
   薬機法に触れる表現は禁止。栄養素の話だけにする。
3. 商品名や購入を促す文言は入れない (それは別 UI で出す)。
4. 説教調にしない。優しい励ましのトーンで、客観的な栄養傾向を 1 つ言及する。`;

// ============================================================
// 型
// ============================================================

export interface GenerateRecommendationInput {
  db: D1Database;
  friendId: string;
  /**
   * AI Router (Phase 5β-prep adoption batch 2 で追加).
   *   - resolveProviders('nutrition-copy').length === 0 → 完全テンプレ動作
   *   - generateText 全 provider 失敗 → テンプレフォールバック
   *   - 省略可能 (router 無しなら常にテンプレ動作 — Phase 4 互換 / OSS 無料完動の最終フォールバック)
   */
  router?: AIRouter;
  /** PR-2 で得た deficit 配列 (空配列なら何もせず null) */
  deficits: ReadonlyArray<NutritionDeficit>;
  /** 友だちの first_name (パーソナライズ用、未取得なら省略) */
  friendName?: string;
}

export interface GenerateRecommendationResult {
  /** 永続化された nutrition_recommendations.id */
  id: string;
  /** 生成されたメッセージ (redaction 済) */
  aiMessage: string;
  /** 紐付けされた SKU 群 */
  suggestions: SkuSuggestion[];
  /** AI 呼び出しに成功したか、テンプレに落ちたか */
  source: 'ai' | 'template';
  /** 永続化レコード全体 (caller が即時返却したい場合用) */
  recommendation: NutritionRecommendation;
}

// ============================================================
// メイン関数
// ============================================================

/**
 * 栄養レコメンドを生成・永続化する。
 *
 * 戻り値:
 *   - `null` : 入力 deficits が空、または該当 SKU が 1 件も無かった (DB insert なし)
 *   - 通常時 : 永続化済の NutritionRecommendation + AI/テンプレ判定
 *
 * @throws DB insert に失敗したときのみ throw。AI 呼び出し失敗は握り潰してテンプレ動作。
 */
export async function generateAndStoreRecommendation(
  input: GenerateRecommendationInput,
): Promise<GenerateRecommendationResult | null> {
  if (input.deficits.length === 0) {
    return null;
  }

  // ---- SKU 紐付け ----
  const suggestions = await collectSkuSuggestions(input.db, input.deficits);
  if (suggestions.length === 0) {
    return null;
  }

  // ---- AI コピー生成 (失敗時はテンプレ) ----
  const { message: aiMessage, source } = await generateMessage(input);

  // ---- DB 永続化 ----
  const recommendation = await insertNutritionRecommendation(input.db, {
    friendId: input.friendId,
    deficits: input.deficits,
    suggestions,
    aiMessage,
  });

  return {
    id: recommendation.id,
    aiMessage,
    suggestions,
    source,
    recommendation,
  };
}

// ============================================================
// SKU 紐付け
// ============================================================

async function collectSkuSuggestions(
  db: D1Database,
  deficits: ReadonlyArray<NutritionDeficit>,
): Promise<SkuSuggestion[]> {
  const out: SkuSuggestion[] = [];
  const seen = new Set<string>(); // shopify_product_id 重複排除

  for (const d of deficits) {
    const row = await getSkuMapByDeficit(db, d.key);
    if (!row) continue;
    if (seen.has(row.shopify_product_id)) continue;
    seen.add(row.shopify_product_id);

    out.push({
      shopifyProductId: row.shopify_product_id,
      productTitle: row.product_title,
      copy: clip(redactProhibited(row.copy_template), SKU_COPY_MAX_LEN),
      deficitKey: d.key,
    });
  }

  return out;
}

// ============================================================
// メッセージ生成 (AI or テンプレ)
// ============================================================

async function generateMessage(
  input: GenerateRecommendationInput,
): Promise<{ message: string; source: 'ai' | 'template' }> {
  const fallback = (): { message: string; source: 'template' } => ({
    message: templateMessage(input.deficits, input.friendName),
    source: 'template',
  });

  if (!input.router || input.router.resolveProviders('nutrition-copy').length === 0) {
    return fallback();
  }

  try {
    const userMessage = formatDeficitsForPrompt(input.deficits, input.friendName);
    const response = await input.router.generateText('nutrition-copy', {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    const raw = response.text?.trim();
    if (!raw) return fallback();

    // response.text は provider 内で redact 済だが二重防御で再 redact + 字数 clip
    const sanitized = clip(redactProhibited(raw), AI_MESSAGE_MAX_LEN);
    if (!sanitized) return fallback();
    return { message: sanitized, source: 'ai' };
  } catch (err) {
    // AI 失敗は握り潰し、テンプレに落とす (caller 側で何度でも再実行できるように)
    console.error(
      'nutrition recommendation AI failed (fallback to template):',
      err instanceof Error ? err.name : 'unknown',
    );
    return fallback();
  }
}

// ============================================================
// テンプレ
// ============================================================

/**
 * AI 不在時のフォールバック・コピー。
 * severity の最も高い deficit を 1 つ選び、その栄養素名でテンプレ文を組み立てる。
 * 効能効果は一切書かず、「意識してみませんか」の呼びかけまでで止める。
 */
export function templateMessage(
  deficits: ReadonlyArray<NutritionDeficit>,
  friendName?: string,
): string {
  if (deficits.length === 0) {
    // 通常 caller が空配列を渡さない設計だが防御
    return '今週は食事ログを続けていただきありがとうございます。';
  }
  const top = pickTopDeficit(deficits);
  const label = DEFICIT_LABEL[top.key] ?? '栄養素';
  const namePrefix = friendName ? `${friendName}さん、` : '';

  if (top.key === 'calorie_high') {
    return clip(
      `${namePrefix}今週は${label}が少し多めでした。次の 1 週間は無理のない範囲で意識してみませんか。`,
      AI_MESSAGE_MAX_LEN,
    );
  }
  return clip(
    `${namePrefix}今週は${label}が控えめでした。無理のない範囲で意識してみませんか。`,
    AI_MESSAGE_MAX_LEN,
  );
}

function pickTopDeficit(
  deficits: ReadonlyArray<NutritionDeficit>,
): NutritionDeficit {
  // severity 降順、同 severity なら入力順
  let top = deficits[0];
  for (let i = 1; i < deficits.length; i++) {
    const d = deficits[i];
    if (SEVERITY_ORDER[d.severity] > SEVERITY_ORDER[top.severity]) {
      top = d;
    }
  }
  return top;
}

function formatDeficitsForPrompt(
  deficits: ReadonlyArray<NutritionDeficit>,
  friendName?: string,
): string {
  const lines = deficits.map(
    (d) =>
      `- ${DEFICIT_LABEL[d.key] ?? d.key} (${d.key}): 観測 ${d.observedAvg} / 目標 ${d.targetAvg} / 重さ ${d.severity}`,
  );
  const header = friendName
    ? `ユーザの名前: ${friendName}さん`
    : 'ユーザの名前: 不明 (名前は呼びかけずにメッセージを書く)';
  return [
    header,
    '',
    '直近 7 日の栄養傾向 (1 日平均):',
    ...lines,
    '',
    '上記から 60 字以内の優しい励ましメッセージを 1 文だけ生成してください。',
    '効能効果の断定 (治る/効く/予防できる など) は禁止。商品名や購入誘導も書かない。',
  ].join('\n');
}

// ============================================================
// 薬機ガード (food-analyzer / monthly-food-report と同ロジック)
// ============================================================

function redactProhibited(text: string): string {
  if (!text) return text;
  // Phase 5β-prep adoption: @line-crm/ai-provider の集約済 redact 関数を使用
  return redactProhibitedPhrases(text).text;
}

function clip(s: string, max: number): string {
  if (!s) return s;
  // 文字単位 (Array.from で surrogate pair を 1 文字としてカウント)
  const arr = Array.from(s);
  if (arr.length <= max) return s;
  return arr.slice(0, max).join('');
}

// ============================================================
// テスト用エクスポート
// ============================================================
export const __test__ = {
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  AI_MESSAGE_MAX_LEN,
  SKU_COPY_MAX_LEN,
  redactProhibited,
  clip,
  pickTopDeficit,
  formatDeficitsForPrompt,
  collectSkuSuggestions,
};
