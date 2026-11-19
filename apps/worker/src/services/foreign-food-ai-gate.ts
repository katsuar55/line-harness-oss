/**
 * 食事データの外国 AI 送信 gate (2026-11-19)
 *
 * 食事の写真 (vision) と、食事記録から作る栄養の文章 (nutrition-copy) は、
 * 既定の優先順では外国の AI 事業者 (Anthropic) に送られる。
 * 利用目的の通知と同意の記録が整うまで、既定で止める。
 *
 * - FOOD_AI_FOREIGN_ENABLED === 'true' のときだけ従来どおり外国 AI を使う。
 * - それ以外 (未設定を含む) は:
 *     vision         → provider なし (写真の受け取り・保存は続け、解析だけしない)
 *     nutrition-copy → Workers AI のみ (使えなければ各 service のテンプレに自動 fallback)
 *
 * 戻すときは secret `FOOD_AI_FOREIGN_ENABLED=true` を入れるだけ (redeploy 不要)。
 */

import type { AIRouterOptions } from '@line-crm/ai-provider';

export const FOOD_AI_PAUSED_REPLY =
  '🍽 食事の写真を受け取り、記録しました。カロリーの自動解析は、ただいまお休みしています 🙏';

export const FOOD_AI_PAUSED_REASON = '解析は一時停止中 (外国AIへの送信の同意の整備まで)';

export function isForeignFoodAiEnabled(
  env: { FOOD_AI_FOREIGN_ENABLED?: string } | undefined | null,
): boolean {
  return env?.FOOD_AI_FOREIGN_ENABLED === 'true';
}

/**
 * gate が off のときに AIRouter の taskPriority へ重ねる上書き。
 * on のときは空 (= 何も変えない)。
 */
export function foreignFoodAiTaskOverride(
  env: { FOOD_AI_FOREIGN_ENABLED?: string } | undefined | null,
): NonNullable<AIRouterOptions['taskPriority']> {
  if (isForeignFoodAiEnabled(env)) return {};
  return {
    vision: [],
    'nutrition-copy': ['workers-ai'],
  };
}
