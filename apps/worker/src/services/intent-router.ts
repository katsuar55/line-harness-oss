/**
 * Intent Router (= 5/26 ULTRATHINK fix、 deterministic keyword routing、 Plan A+ patch)
 *
 * 役割:
 *   AI に prefix を任せると Llama/Qwen が rule を無視するため、 重要 intent は
 *   webhook level で keyword 検出し、 deterministic に固定応答を返す safety net。
 *
 *   - Plan A-3 (quick_quiz invite) AI prefix → keyword routing に格上げ
 *   - Plan A-6 (price_table) AI prefix → keyword routing に格上げ
 *   - Plan A-1 (会員ランク等 未実装機能) AI 応答禁止 → keyword routing で即固定応答
 *
 * 優先順位 (= webhook.ts text path):
 *   1. auto_replies keyword match (= 既存)
 *   2. **intent-router.detectIntent (= 本 service)** ← 新規 Layer 1.5
 *   3. AI 応答 (= Layer 2、 上記すべて miss なら)
 *
 * keyword 設計:
 *   - 部分一致 (= includes) で対応、 case sensitive
 *   - キーワード一覧は各 intent ごとに array で集約、 維持しやすく
 *   - 「価格」 等の 1 char 短いものは auto_replies match が先に走るため、
 *     ここでは「価格教えて」 「価格比較」 等の **長い phrase** のみ catch
 *
 * fail-safe:
 *   - detectIntent は null 返却で fallthrough (= AI path に流れる)
 *   - intent matched でも reply 失敗時は caller が catch + log
 */

import type { Message } from '@line-crm/line-sdk';
import { buildPriceTableMessage } from './ai-message-builder.js';
import { buildQuickQuizInviteMessage } from './quick-quiz.js';

export type Intent =
  | { readonly type: 'quiz_invite'; readonly reason: string }
  | { readonly type: 'price_table'; readonly reason: string }
  | { readonly type: 'feature_unavailable'; readonly feature: string; readonly reason: string };

export interface IntentRouteResult {
  readonly intent: Intent;
  readonly messages: ReadonlyArray<Message>;
  readonly matchedKeyword: string;
}

interface PatternRule {
  readonly keywords: ReadonlyArray<string>;
  readonly intent: Intent;
}

// 上から順に check、 最初に match した keyword で確定
const PATTERNS: ReadonlyArray<PatternRule> = [
  // ========= quick_quiz invite (= 5 質問 chain 誘導) =========
  {
    keywords: [
      '私におすすめ', '私にぴったり', '私に合う', '私にあう', '私はどれ',
      'おすすめは何', 'おすすめは?', 'おすすめは？', 'おすすめ教えて', 'おすすめを教えて',
      'どれがいい', 'どれがおすすめ', 'どれを買え', 'どれを選', 'どれが合う', 'どれにすべき',
      '初めてでどれ', '何を選べ', '何を買え',
    ],
    intent: { type: 'quiz_invite', reason: 'product recommendation intent' },
  },

  // ========= price_table (= 3 商品 grid flex) =========
  // 5/26 user feedback: 「価格」 単独でも grid 形式で返したい → 「価格」 を keyword に追加。
  // auto_replies の旧「価格」 text row は deactivate 済 (= scripts/intent-router-bootstrap.sql)。
  //
  // **重要: 長い phrase を先頭に、 短い keyword を末尾に置く** (= matchedKeyword の specificity 確保)。
  {
    keywords: [
      // 明示的 phrase (= 長い、 specific) を先頭に
      '価格教えて', '価格を教えて', '価格一覧', '価格比較', '価格表',
      '料金教えて', '料金を教えて', '値段教えて', '値段を教えて', '値段一覧',
      'いくらする', 'いくらします', 'いくらですか', '3 種類の価格', '3種類の価格',
      '3 つの価格', '3つの価格', 'すべての価格', '全部の価格',
      'どれが一番安い', 'どれが安い', '一番安いのは',
      // 単独 keyword (= 短い、 fallback) を末尾に
      '価格', '値段', '料金',
    ],
    intent: { type: 'price_table', reason: 'price comparison intent' },
  },

  // ========= feature_unavailable (= 未実装機能、 固定応答) =========
  // 会員ランク / マイランク / ステータス
  {
    keywords: ['会員ランク', 'マイランク', 'ランクは何', 'ランクなに', '私のランク', '私のステータス'],
    intent: { type: 'feature_unavailable', feature: '会員ランク', reason: 'unimplemented' },
  },
  // ポイント / マイル
  {
    keywords: ['ポイント残高', 'ポイント教えて', 'マイル教えて', '私のポイント', '私のマイル', 'ポイントいくつ', 'マイル何個'],
    intent: { type: 'feature_unavailable', feature: 'ポイント / マイル', reason: 'unimplemented' },
  },
  // 紹介プログラム
  {
    keywords: ['紹介プログラム', '紹介制度', 'リファラル', '友だち紹介', '友達紹介', '紹介して', '紹介の', '紹介コード'],
    intent: { type: 'feature_unavailable', feature: '紹介プログラム', reason: 'unimplemented' },
  },
  // アンバサダー
  {
    keywords: ['アンバサダー'],
    intent: { type: 'feature_unavailable', feature: 'アンバサダープログラム', reason: 'unimplemented' },
  },
  // バッジ / 称号
  {
    keywords: ['専用バッジ', 'バッジ教えて', '称号', '私のバッジ'],
    intent: { type: 'feature_unavailable', feature: '専用バッジ / 称号', reason: 'unimplemented' },
  },
];

/**
 * text を intent に分類。 match なし → null (= AI flow に流れる)。
 *
 * @param text user message (= LINE で受信、 sanitize 済前提)
 * @returns matched intent + messages、 nothing なら null
 */
export function detectIntent(text: string): IntentRouteResult | null {
  const normalized = text.trim();
  if (normalized.length === 0) return null;

  for (const pattern of PATTERNS) {
    for (const keyword of pattern.keywords) {
      if (normalized.includes(keyword)) {
        return {
          intent: pattern.intent,
          messages: buildMessagesForIntent(pattern.intent),
          matchedKeyword: keyword,
        };
      }
    }
  }
  return null;
}

function buildMessagesForIntent(intent: Intent): ReadonlyArray<Message> {
  switch (intent.type) {
    case 'quiz_invite':
      return [buildQuickQuizInviteMessage()];
    case 'price_table':
      return [buildPriceTableMessage()];
    case 'feature_unavailable':
      return [
        {
          type: 'text',
          text: `🌿 ${intent.feature}機能は近日リリース予定です。\n今しばらくお待ちください💝\n\nリリースされ次第、 公式 LINE でお知らせします😊`,
        },
      ];
  }
}

// テスト用 export
export const __test__ = {
  PATTERNS,
  buildMessagesForIntent,
};
