/**
 * Regression guard (2026-06-29 cutover C 検証): 友だち紹介「LINEで送る」は
 * shareTargetPicker 未対応時にコピーで終わらせず LINE 共有シートを開く。
 *
 * 実機検証で、shareTargetPicker が未対応 (LIFF console 未設定 / 外部ブラウザ) の環境では
 * 「LINEで送る」が `copyRefLink()` にフォールバックし「コピーするだけ」になっていた。
 * フォールバックは LINE 公式の共有URL (https://line.me/R/share?text=) を開くこと。
 * client JS を静的検査して、サイレントコピー退行を防ぐ。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'liff-pages.ts'),
  'utf8',
);

describe('友だち紹介 LINEで送る — フォールバックは LINE 共有シート (コピーで終わらせない)', () => {
  it('openLineShare ヘルパが存在し LINE 公式共有URLを開く', () => {
    expect(src).toMatch(/function\s+openLineShare/);
    expect(src).toContain('https://line.me/R/share?text=');
  });

  it('shareRefLine の shareTargetPicker 未対応フォールバックは openLineShare を呼ぶ', () => {
    // shareRefLine 関数本体を抽出
    const m = src.match(/function shareRefLine\(\)\s*\{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const body = m![0];
    // フォールバック経路が openLineShare を呼ぶ (= 旧実装の `else { copyRefLink(); }` ではない)
    expect(body).toContain('openLineShare(');
    // catch でもコピー退行しない (shareTargetPicker 失敗時も共有シート)
    expect(body).toMatch(/\.catch\(function\(\)\s*\{\s*openLineShare\(/);
  });
});
