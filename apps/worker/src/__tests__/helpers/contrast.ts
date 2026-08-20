/**
 * WCAG コントラスト計算ヘルパー (Ultraplan PR-1)。
 *
 * §7-1 の「禁止 hex の文字列検出」だけでは、新しい低コントラスト色の**追加**を
 * 検出できない。ここでトークン値を実際に parse して比率を計算し、
 * 「この文字色 × この地色」の宣言表を AA (4.5:1) で機械検証する。
 * トークンの値を変える PR (視覚刷新 B) は、この計算が自動で追検査になる。
 */

/** #rgb / #rrggbb を [r,g,b] (0-255) に。それ以外は null。 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** WCAG 相対輝度。 */
export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** コントラスト比 (1〜21)。 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) throw new Error(`hex が parse できません: ${hexA} / ${hexB}`);
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * CSS 文字列から :root カスタムプロパティの hex 値を全部拾う。
 * `--name: #hex` 形式のみ (グラデ・関数値は対象外 = 宣言表側で生 hex を書く)。
 */
export function parseRootHexTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const roots = [...css.matchAll(/:root\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  for (const m of roots.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) {
    out.set(`--${m[1]}`, m[2].toLowerCase());
  }
  return out;
}

/** 宣言表の色指定 (トークン名 or 生 hex) を実 hex に解決する。 */
export function resolveColor(tokens: Map<string, string>, ref: string): string {
  if (ref.startsWith('#')) return ref.toLowerCase();
  const v = tokens.get(ref);
  if (!v) throw new Error(`トークン ${ref} が :root に見つかりません (削除/改名した場合は宣言表も更新)`);
  return v;
}
