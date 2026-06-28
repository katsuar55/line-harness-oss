/**
 * Regression guard (2026-06-29 顧客導線監査 rank 13/14): マイランク会員証の
 * 全顧客が見る文言/可読性。loyalty gated off で全 6,583 友だちが REGULAR ¥0 を見るため影響大。
 *
 * rank 13: regular(¥0)→bronze 境界は「あと ¥1 でブロンズ」でなく定性文言にする。
 * rank 14: 日本語ランク名を主表示にし、低コントラストな gray-400 の日本語名を廃止する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'liff-my-rank.ts'),
  'utf8',
);

describe('マイランク会員証の文言/可読性 (監査 rank 13/14)', () => {
  it('rank13: ¥0→bronze 境界は金額でなく定性文言 (あと¥1 を出さない)', () => {
    expect(src).toContain('d.next.remainingJpy <= 1');
    expect(src).toContain('まずは1回のお買い物で');
  });

  it('rank14: 日本語ランク名を主表示(text-3xl) + 低コントラスト gray-400 の日本語名を廃止', () => {
    expect(src).toContain('text-3xl font-extrabold mt-0.5');
    // 旧: 日本語ランク名が text-gray-400 (約2.6:1, WCAG AA 未達) で描画されていた
    expect(src).not.toMatch(/text-gray-400[^>]*>'\+esc\(rank\.name\)/);
  });
});
