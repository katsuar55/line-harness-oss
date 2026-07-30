/**
 * 再注文ショートカット (2026-07-30 オーナー実機FB「タップしても何も起きない」):
 * 「購入履歴から再注文する」は素の scrollIntoView だけで、注文履歴が空だと無反応に見え、
 * 着地位置も sticky ヘッダーに隠れ、着地後の案内も無かった。
 * → 空なら誘導トースト / 有ればオフセット付きスクロール + ハイライト + 使い方トースト。
 *
 * inline template-literal のため source 静的検査 (既存 liff-* テストと同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

/** top-level function のブロックを抽出 (行頭 `}` で終端) */
function fnBlock(name: string): string {
  const m = pages.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('再注文ショートカット (購入履歴から再注文する)', () => {
  it('ボタンは reorderShortcut() に配線されている (素の scrollIntoView インライン実装を廃止)', () => {
    expect(pages).toMatch(/onclick="reorderShortcut\(\)"[^>]*>[\s\S]{0,120}購入履歴から再注文する/);
    expect(pages).not.toMatch(/onclick="var el=document\.getElementById\('orders-card'\);if\(el\)el\.scrollIntoView/);
  });

  it('注文履歴が空なら誘導トーストを出す (無反応に見える dead ボタン防止)', () => {
    const b = fnBlock('reorderShortcut');
    expect(b).toContain("querySelector('[data-order-id]')");
    expect(b).toContain('まだ注文履歴がありません');
  });

  it('sticky ヘッダー分のオフセットを取ってスクロールし、カードをハイライト + 使い方トースト', () => {
    const b = fnBlock('reorderShortcut');
    expect(b).toMatch(/pageYOffset - 110/);
    expect(b).toMatch(/scrollTo\(\{ top: y, behavior: 'smooth' \}\)/);
    expect(b).toMatch(/boxShadow/);
    expect(b).toContain('この注文を再注文');
  });

  it('esbuild backtick trap: 追加ブロックに backtick を含まない', () => {
    expect(fnBlock('reorderShortcut')).not.toContain('`');
  });
});
