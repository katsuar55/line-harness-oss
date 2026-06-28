/**
 * Regression guard (2026-06-29 顧客導線監査 残backlog — 二次 LIFF error-as-empty 修正):
 *
 * coach / reorder / food / opt-in / food-graph の各ページは独自 initLiff を持ち、
 *   (a) liff.getIDToken() の null 検査が無い → 失効 idToken のまま進み全 /api/liff/* が 401 →
 *       「データなし」空状態に誤変換 (rank4/6/19/21)
 *   (b) init catch が renderDemo()/renderEmpty()/render([])/showToast でフォールバック →
 *       本物の init 失敗を空/偽データで隠蔽 (food は fake 1240kcal を実ユーザに表示 = rank19)
 * していた。PR-E (#151, liff-pages.ts portal home) の idToken null → showFatalError パターンを
 * 各ページに適用し、失敗を skeleton 固着/空状態/偽データに倒さず明示エラー+再読込で出す。
 *
 * これらは inline template-literal の埋め込み JS なので、liff-portal-resilience.test.ts と同様に
 * source 文字列を静的検査する (raw Japanese 保存・\u エスケープなし)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
function readRoute(name: string): string {
  return readFileSync(join(root, '..', 'routes', name), 'utf8');
}

const asyncPages: ReadonlyArray<{ file: string; label: string }> = [
  { file: 'liff-food-page.ts', label: 'food' },
  { file: 'liff-coach-page.ts', label: 'coach' },
  { file: 'liff-reorder-page.ts', label: 'reorder' },
  { file: 'liff-opt-in-page.ts', label: 'opt-in' },
];

describe('二次 LIFF レジリエンス (error-as-empty 撲滅)', () => {
  for (const { file, label } of asyncPages) {
    describe(label, () => {
      const src = readRoute(file);

      it('showFatalError ヘルパ (再読み込みボタン付き) を持つ', () => {
        expect(src).toContain('function showFatalError');
        expect(src).toMatch(/showFatalError[\s\S]{0,400}location\.reload\(\)/);
      });

      it('idToken null を検出して showFatalError し、無認証のまま進行しない', () => {
        expect(src).toMatch(/if \(!idToken\) \{[\s\S]{0,300}showFatalError/);
      });

      it('init catch は showFatalError に倒す (空/偽データのフォールバックでない)', () => {
        expect(src).toMatch(/catch \(err\) \{[\s\S]{0,400}showFatalError/);
      });
    });
  }

  describe('food: 偽 demo データは明示 ?demo=1 でのみ表示 (本物の失敗で出さない)', () => {
    const src = readRoute('liff-food-page.ts');

    it('demo は isDemoRequested() (?demo=1) ゲートで明示要求された時のみ', () => {
      expect(src).toContain('function isDemoRequested');
      expect(src).toMatch(/get\(['"]demo['"]\)\s*===\s*['"]1['"]/);
      // demo データ描画は明示ゲート経由でのみ到達する
      expect(src).toMatch(/isDemoRequested\(\)[\s\S]{0,300}renderDemo\(\)/);
    });

    it('init catch では renderDemo を呼ばず showFatalError に倒す (fake 1240kcal 漏洩防止)', () => {
      // catch (err) ブロック内に renderDemo が現れる前に showFatalError へ到達する
      expect(src).toMatch(/catch \(err\) \{(?:(?!renderDemo)[\s\S]){0,400}showFatalError/);
    });
  });

  describe('portal (liff-pages.ts) — Codex MEDIUM-2: init失敗で偽データを出さない', () => {
    const src = readRoute('liff-pages.ts');

    it('demo は isDemoRequested() (?demo=1) ゲートで明示要求された時のみ', () => {
      expect(src).toContain('function isDemoRequested');
    });

    it('init catch は ?demo=1 以外では showFatalError に倒す (偽クーポン/偽注文を出さない)', () => {
      expect(src).toMatch(/catch \(err\) \{[\s\S]{0,400}isDemoRequested\(\)[\s\S]{0,300}showFatalError/);
    });
  });

  describe('food-graph (promise-chain init)', () => {
    const src = readRoute('liff-food-graph.ts');

    it('showFatalError ヘルパを持つ', () => {
      expect(src).toContain('function showFatalError');
      expect(src).toMatch(/showFatalError[\s\S]{0,400}location\.reload\(\)/);
    });

    it('idToken null を検出して showFatalError する', () => {
      expect(src).toMatch(/if \(!idToken\) \{[\s\S]{0,300}showFatalError/);
    });

    it('liff.init().catch は showFatalError に倒す (空グラフ表示でない)', () => {
      expect(src).toMatch(/\.catch\(function\s*\(err\)\s*\{[\s\S]{0,300}showFatalError/);
    });
  });
});
