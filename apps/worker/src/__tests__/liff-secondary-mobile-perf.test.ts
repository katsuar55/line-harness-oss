/**
 * Regression guard (2026-06-29 UX ブラッシュアップ — mobile_perf 横展開):
 *
 * portal (#157) に続き、二次 LIFF ページ (PR-B の発見導線先 = my-rank/food/food-graph/coach/reorder/opt-in)
 * にも theme-color を入れ、ブランド status bar を全 LIFF 面で統一する。さらに food-graph の期間タブが
 * py-2 (≈32px) で WCAG 2.5.5 (44px) 未満だったのを py-3 (≈40px) に拡大する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const readRoute = (name: string): string => readFileSync(join(root, '..', 'routes', name), 'utf8');

const STANDALONE_PAGES = [
  'liff-my-rank.ts',
  'liff-food-page.ts',
  'liff-food-graph.ts',
  'liff-coach-page.ts',
  'liff-reorder-page.ts',
  'liff-opt-in-page.ts',
];

describe('二次 LIFF の mobile/perf/a11y polish', () => {
  for (const file of STANDALONE_PAGES) {
    it(`${file} はブランド theme-color meta を持つ`, () => {
      expect(readRoute(file)).toMatch(/<meta name="theme-color" content="#059669">/);
    });
  }

  it('food-graph の期間タブは WCAG 44px に近い py-3 で、py-2(≈32px) に退行しない', () => {
    const src = readRoute('liff-food-graph.ts');
    expect(src).toMatch(/range-btn flex-1 py-3 text-sm/);
    expect(src).not.toMatch(/range-btn flex-1 py-2 text-sm/);
  });
});
