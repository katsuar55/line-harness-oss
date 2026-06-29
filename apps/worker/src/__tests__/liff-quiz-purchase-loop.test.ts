/**
 * Regression guard (2026-06-29 UX ブラッシュアップ PR-A — クイズ→購入のループ閉鎖):
 *
 * 採点 consolidation/purchase HIGH: クイズ完走後の「おすすめ商品」結果は、CTA が bare homepage
 * (https://naturism-diet.com) へ外部遷移するだけで、推奨された具体的商品ページにも・CRM 内の会員特典
 * 購入導線にも繋がっていなかった。最短距離で「推奨商品の購入」へ到達できず、回遊が閉じていなかった。
 *
 * 本 PR で QUIZ_PRODUCTS を実商品ページ (handle付き、本番 200 確認済) に直リンクし、結果画面に
 * マイランク会員特典への in-CRM 導線を追加する。liff-pages.ts は inline template-literal なので静的検査。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('クイズ結果→購入のループ閉鎖 (PR-A)', () => {
  it('QUIZ_PRODUCTS は推奨商品の実商品ページ (handle付き) に直リンクする', () => {
    expect(pages).toContain('/products/naturism-blue-180-30days');
    expect(pages).toContain('/products/koso-in-naturism-pink-180-30days');
    expect(pages).toContain('/products/naturism-premium-180-20days');
  });

  it('bare homepage 直送 (storeUrl: https://naturism-diet.com) に退行しない', () => {
    expect(pages).not.toMatch(/storeUrl: 'https:\/\/naturism-diet\.com' \}/);
  });

  it('クイズ結果 CTA は購入意図を明示する', () => {
    expect(pages).toContain('ご購入はこちら');
  });

  it('クイズ結果に LINE会員特典 (マイランク) への in-CRM 導線がある', () => {
    expect(pages).toContain("openFeaturePage('/liff/my-rank')");
  });
});
