/**
 * AI output 薬機法 NG word filter (Phase 3.1 ULTRATHINK、 2026-05-24)
 *
 * 役割:
 *   - AI 応答 (= 既存 system prompt で薬機法遵守を強調) の出力 layer で keyword 検出
 *   - 検出時は logger.warn + audit_logs (= `ai.ng_word_detected`) で記録 (= safety net)
 *   - 自動 修正は文脈崩壊 risk のため見送り、 monitoring layer に専念
 *
 * NG word の根拠:
 *   ai-response.ts の buildSystemPrompt 内「最重要ルール 4. 薬機法遵守」 で明示:
 *   「痩せる」 「治る」 「効く」 「効果がある」 「改善する」 「向上する」 等
 *
 * 設計:
 *   - keyword 一覧は const として export (= test + admin で可視化可能)
 *   - false positive を抑えるため、 partial 一致 + 文脈無視 (= 単純な regex)
 *   - 「予防」 は「予防接種」 等で誤検出 → 「~を予防」 「~予防効果」 等の動詞句限定 regex
 */

/**
 * 薬機法的に断定 NG な keyword / 動詞句。
 * 各エントリは regex pattern + 説明。
 */
export const NG_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // 効能効果の断定
  { pattern: /痩せ[るまらたて]/g, label: '痩せる' },
  { pattern: /やせ[るまらたて]/g, label: 'やせる' },
  { pattern: /治[りるっれら]/g, label: '治る' },
  { pattern: /なお[りるっれら]/g, label: 'なおる' },
  { pattern: /効き(ます|まし)/g, label: '効きます' },
  { pattern: /効く(?![ぐくキク])/g, label: '効く' }, // 「効くと」 「効くから」 のみ、 「効くか」 質問は OK
  { pattern: /効果が(あり|出)/g, label: '効果がある' },
  { pattern: /改善(し|され)/g, label: '改善する' },
  { pattern: /向上(し|され)/g, label: '向上する' },
  { pattern: /(を)予防(し|でき|可能|に役立)/g, label: '~を予防する' },
  { pattern: /(を)解消(し|でき|可能)/g, label: '~を解消する' },
  { pattern: /(を)治療/g, label: '治療' },
  { pattern: /(を)診断/g, label: '診断' },
  // 即効性の断定
  { pattern: /すぐ(に)?(痩せ|やせ|治|なお|効)/g, label: '即効性' },
  { pattern: /1週間で(痩|やせ|-?\d)/g, label: '1週間で〜' },
];

export interface NgDetectionResult {
  /** 検出された NG word ラベル一覧 (重複排除済) */
  detected: string[];
  /** いずれかが検出されたか */
  hasNg: boolean;
}

/**
 * 文字列内の NG word を検出。
 *
 * @param text AI 応答テキスト (= 既に <think> tag 除去済を想定)
 * @returns 検出ラベル一覧 + hasNg flag
 */
export function detectNgWords(text: string): NgDetectionResult {
  if (!text) return { detected: [], hasNg: false };
  const found = new Set<string>();
  for (const { pattern, label } of NG_PATTERNS) {
    // RegExp が global の場合 lastIndex 共有を避けるため毎回 reset
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      found.add(label);
    }
  }
  const detected = [...found];
  return { detected, hasNg: detected.length > 0 };
}
