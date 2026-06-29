/**
 * Regression guard (2026-06-29 UX ブラッシュアップ PR-B — 二次機能の発見性):
 *
 * 食事記録 (/liff/food)・AIコーチ (/liff/coach)・グラフ (/liff/food/graph) は実装済みなのに、
 * portal home から 0 導線 (週次 push と LIFF Top メニュー経由のみ) で、顧客は「その他」タブを開いて
 * スクロールしないと存在に気づけなかった (採点 secondary_liff HIGH: 4+タップ埋没)。
 * 「機能が集約されている」= 一本化動機の前提は機能の存在認知。home タブに発見導線を露出する。
 *
 * portal の openLiffPage は ?page= で portal 内タブへ deep-link するため、独立ページへは
 * worker URL (API_BASE + path) へ遷移する openFeaturePage を使う。
 * liff-pages.ts は inline template-literal の埋め込み HTML/JS なので source を静的検査する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('portal home の二次機能 発見性 (PR-B)', () => {
  it('独立 LIFF ページへ遷移する openFeaturePage ヘルパを持つ', () => {
    expect(pages).toContain('function openFeaturePage');
    // API_BASE + path へ遷移し、portal の ?page= deep-link とは別物
    expect(pages).toMatch(/function openFeaturePage[\s\S]{0,200}API_BASE \+ path/);
  });

  it('home に「栄養 & ウェルネス」discovery card がある', () => {
    expect(pages).toContain('栄養 & ウェルネス');
  });

  it('food / coach / food-graph の3導線を正しいルートで露出する', () => {
    expect(pages).toMatch(/openFeaturePage\('\/liff\/food'\)/);
    expect(pages).toMatch(/openFeaturePage\('\/liff\/coach'\)/);
    expect(pages).toMatch(/openFeaturePage\('\/liff\/food\/graph'\)/);
  });

  it('discovery card は home section 内 (intake-today-card と tip-card の間) に置かれる', () => {
    // section-home 内に栄養カードが存在し、section-more より前 (= home タブで見える)
    const homeIdx = pages.indexOf('id="section-home"');
    const wellnessIdx = pages.indexOf('栄養 & ウェルネス');
    const moreIdx = pages.indexOf('id="section-more"');
    expect(homeIdx).toBeGreaterThan(-1);
    expect(wellnessIdx).toBeGreaterThan(homeIdx);
    expect(wellnessIdx).toBeLessThan(moreIdx);
  });
});
