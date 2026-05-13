/**
 * Phase 5β-prep: 薬機法 NG ワード redaction の集約
 *
 * これまで apps/worker/src/services/{food-analyzer, monthly-food-report, nutrition-recommender}.ts
 * に 3 重定義されていた PROHIBITED_PHRASES を 1 箇所に集約。
 *
 * 設計方針:
 *   - 完全網羅ではない (AI 出力の表記揺れまでカバーしようとすると専用辞書必要)
 *   - 平易なひらがな・漢字 + 一般的なカタカナ揺れ + 英語 を最低限カバー
 *   - 二重ガード: AI の system prompt 側でも「効能効果を書かない」と指示し、
 *     すり抜けたケース向けに本 redact が最終防衛線
 *
 * 薬機法 (旧薬事法) リファレンス:
 *   - 健康食品で「効く」「治る」「予防」 等を断定する表記は禁止
 *   - 機能性表示食品の届出表示の引用は OK (「届出表示に基づき〜をサポート」)
 */

/**
 * 薬機法 NG フレーズ (3 service の重複定義を集約)。
 * `readonly` で誤って push されないように保護。
 */
export const PROHIBITED_PHRASES = [
  // 完治・治療系
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

export const REDACTION_TOKEN = '[省略]';

/**
 * 入力テキストから PROHIBITED_PHRASES を REDACTION_TOKEN に置換する。
 * 大文字小文字 不問 (英語フレーズ向け)、 単純な substring 置換。
 *
 * @returns redacted text と検出されたフレーズリスト (監査ログ用)
 */
export function redactProhibitedPhrases(text: string): {
  text: string;
  detectedPhrases: string[];
} {
  let result = text;
  const detected: string[] = [];
  for (const phrase of PROHIBITED_PHRASES) {
    const pattern = new RegExp(escapeRegex(phrase), 'gi');
    if (pattern.test(result)) {
      detected.push(phrase);
      result = result.replace(pattern, REDACTION_TOKEN);
    }
  }
  return { text: result, detectedPhrases: detected };
}

/**
 * テキストに NG フレーズが含まれるかチェック (redaction 無し、 判定のみ)。
 */
export function hasProhibitedPhrases(text: string): boolean {
  return PROHIBITED_PHRASES.some((p) => {
    const pattern = new RegExp(escapeRegex(p), 'i');
    return pattern.test(text);
  });
}

/**
 * RegExp 安全のため特殊文字をエスケープ。
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
