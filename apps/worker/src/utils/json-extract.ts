/**
 * Shared JSON extraction utility for AI Conductor services (5γ-1〜5γ-4) と
 * food-analyzer の Vision-JSON 解析で共通利用される。
 *
 * 以前は `services/scenario-conductor.ts` と `services/food-analyzer.ts` に
 * 個別定義されていたが、 Phase 5γ-5 で重複削除のためここに集約。
 *
 * scenario-conductor.ts は backward compat のため re-export を維持する。
 */

/**
 * テキスト中から最初の JSON オブジェクト (`{ ... }`) を抽出する。
 *
 * Claude / Workers AI が稀に "```json\n{...}\n```" や前置き文を含めて返す
 * ケースに耐える。 入れ子のブレース・文字列内のブレース・エスケープ文字を考慮する。
 *
 * - 入力: AI 生 response テキスト
 * - 戻り値:
 *   - 最初のバランス取れた JSON object substring (start `{` から match `}` まで)
 *   - JSON object が見つからない / バランスしない場合は `null`
 *
 * 注: 配列 (`[ ... ]`) は対象外。 conductor 4 種 + food-analyzer はすべて
 * top-level object を返す前提のため。
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
