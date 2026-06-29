/**
 * Regression guard (2026-06-29 UX ブラッシュアップ — mobile/perf/a11y):
 *
 * 採点 mobile_perf: portal head に ①theme-color が無くブラウザ chrome がブランド色にならない
 * ②描画ブロッキングな外部 CDN (tailwind/jsdelivr/line-scdn) への dns-prefetch/preconnect が無く接続が遅い
 * ③言語ボタンが 32px (w-8 h-8) で WCAG 2.5.5 (44px) 未満 ④font-family の fallback に system フォントが薄い。
 * 「先進性・なかなかの UI/UX」の知覚に直結する低リスクな polish を入れる。
 * liff-pages.ts は inline template-literal なので静的検査。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('portal mobile/perf/a11y polish', () => {
  it('theme-color meta (ブランド色) を持つ', () => {
    expect(pages).toMatch(/<meta name="theme-color" content="#059669">/);
  });

  it('描画ブロッキング CDN への接続前倒し (preconnect/dns-prefetch) がある', () => {
    expect(pages).toMatch(/<link rel="preconnect" href="https:\/\/static\.line-scdn\.net"/);
    expect(pages).toMatch(/<link rel="dns-prefetch" href="https:\/\/cdn\.tailwindcss\.com">/);
    expect(pages).toMatch(/<link rel="dns-prefetch" href="https:\/\/cdn\.jsdelivr\.net">/);
  });

  it('言語ボタンは WCAG 44px 目標に近い 40px (w-10 h-10) で、32px(w-8 h-8) に退行しない', () => {
    expect(pages).toMatch(/id="lang-btn"[^>]*\bw-10 h-10\b/);
    expect(pages).not.toMatch(/id="lang-btn"[^>]*\bw-8 h-8\b/);
  });

  it('font-family fallback に system フォントが含まれる', () => {
    expect(pages).toMatch(/font-family:'Noto Sans JP',system-ui,-apple-system,BlinkMacSystemFont/);
  });
});
