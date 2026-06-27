/**
 * Regression guard (採点 Round1 D9 UI): LIFF ページは pinch-zoom を無効化しない。
 *
 * `<meta name="viewport" ... user-scalable=no>` / `maximum-scale=1.0` は低視力
 * ユーザーの拡大を妨げ WCAG 2.1 SC 1.4.4 (Resize Text) / 1.4.10 に違反する。
 * 顧客向け LIFF は全ページ拡大可能であること (liff.ts の既存正しい viewport に揃える)。
 * source を静的検査することで、 各 render 関数の引数差異に依存せず全 LIFF ページ +
 * 将来追加ページを一括で守る。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');

const liffFiles = readdirSync(routesDir).filter(
  (f) => f.startsWith('liff') && f.endsWith('.ts'),
);

describe('LIFF viewport — pinch-zoom を無効化しない (WCAG 1.4.4)', () => {
  it('liff* route ファイルが存在する (検査対象あり)', () => {
    expect(liffFiles.length).toBeGreaterThan(0);
  });

  it.each(liffFiles)('%s は user-scalable=no / maximum-scale を含まない', (file) => {
    const src = readFileSync(join(routesDir, file), 'utf8');
    expect(src).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(src).not.toMatch(/maximum-scale\s*=\s*1(\.0)?/i);
  });
});
