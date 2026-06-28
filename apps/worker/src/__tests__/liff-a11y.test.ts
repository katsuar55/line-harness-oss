/**
 * Regression guard (採点 Round2 D9 UI a11y): LIFF の status toast と編集モーダルに
 * screen-reader 用のセマンティクスを保つ。
 *
 * - status toast (#toast) は role="status" + aria-live="polite" を持つこと
 *   (= クーポンコピー/削除/再生成の成否が SR に通知される。WCAG 4.1.3)。
 * - reorder の編集モーダルは role="dialog" + aria-modal="true" を持つこと
 *   (WCAG 4.1.2)。
 * source を静的検査し、各 render 関数の引数差異に依存せず全ページ + 将来追加を守る。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');

function read(file: string): string {
  return readFileSync(join(routesDir, file), 'utf8');
}

// id="toast" を持つ liff route ファイル一覧 (動的検出)
const toastFiles = readdirSync(routesDir)
  .filter((f) => f.startsWith('liff') && f.endsWith('.ts'))
  .filter((f) => /id="toast"/.test(read(f)));

describe('LIFF status toast — aria-live (WCAG 4.1.3)', () => {
  it('toast を持つ liff ページが存在する (検査対象あり)', () => {
    expect(toastFiles.length).toBeGreaterThan(0);
  });

  it.each(toastFiles)('%s の #toast は role="status" + aria-live="polite" を持つ', (file) => {
    const src = read(file);
    // <div id="toast" ...> の開始タグを抽出して属性を検査
    const m = src.match(/<div\s+id="toast"[^>]*>/);
    expect(m, `${file} に <div id="toast"> が見つからない`).not.toBeNull();
    const tag = m![0];
    expect(tag, `${file} の toast に aria-live がない`).toMatch(/aria-live="polite"/);
    expect(tag, `${file} の toast に role="status" がない`).toMatch(/role="status"/);
  });
});

describe('LIFF reorder 編集モーダル — dialog セマンティクス (WCAG 4.1.2)', () => {
  it('liff-reorder-page.ts の #modal 内ダイアログが role="dialog" + aria-modal="true"', () => {
    const src = read('liff-reorder-page.ts');
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    expect(src).toMatch(/aria-labelledby="modal-title"/);
  });
});
