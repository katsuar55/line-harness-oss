/**
 * 第2波-⑥ 初回オンボーディング (2026-07-01):
 *
 * 初回起動で軽量な informational ツアー (4ステップ・診断ファースト) + 文脈で「次の一手」1枚を出し、
 * 無差別10カード並列ロードの埋没を解消する。新規 DB/API なし・localStorage 完結・既存 API 組合せ。
 *
 * liff-pages.ts は inline template-literal (backtick) なので:
 *   1. source を静的検査 (構造・localStorage key・初回ゲート・esbuild backtick trap 回避)
 *   2. 純ロジック computeNextMove は source から抽出して実際に eval し優先順位を検証
 *      (ロジックを test で再実装しない = over-mock 回避)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

// computeNextMove とその依存 (NEXT_MOVE_STEPS / lsGet) を source から抽出して eval する。
const block = pages.match(
  /var NEXT_MOVE_STEPS = \[[\s\S]*?\nfunction computeNextMove\(\) \{[\s\S]*?\n\}/,
);

function makeLogic(store: Record<string, string>) {
  if (!block) throw new Error('onboarding logic block not found in liff-pages.ts');
  const fakeLocalStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'localStorage',
    block[0] + '\nreturn { computeNextMove: computeNextMove, NEXT_MOVE_STEPS: NEXT_MOVE_STEPS };',
  ) as (ls: unknown) => {
    computeNextMove: () => { key: string } | null;
    NEXT_MOVE_STEPS: Array<{ key: string; title: string; cta: string }>;
  };
  return factory(fakeLocalStorage);
}

describe('LIFF 初回オンボーディング (第2波-⑥) — 静的構造', () => {
  it('home に 次の一手 (next-move) カードがある', () => {
    expect(pages).toContain('id="next-move-card"');
    expect(pages).toContain('id="next-move-title"');
    expect(pages).toContain('id="next-move-cta"');
    expect(pages).toContain('onclick="dismissNextMove()"');
  });

  it('初回ツアーの overlay が dialog/aria-modal で存在する', () => {
    expect(pages).toContain('id="onboarding-tour"');
    expect(pages).toContain('role="dialog"');
    expect(pages).toContain('aria-modal="true"');
    expect(pages).toContain('onclick="skipTour()"');
    expect(pages).toContain('onclick="tourPrimary()"');
  });

  it('4ステップの informational ツアー (診断ファースト) が定義されている', () => {
    expect(pages).toContain('naturism へようこそ');
    expect(pages).toContain('まずは無料診断');
    expect(pages).toContain('続けるほど、おトク');
    expect(pages).toContain('記録も相談も、ここで');
  });

  it('initOnboarding は loading を消してから呼ばれる (ツアーが loading の上に出ない)', () => {
    expect(pages).toContain('function initOnboarding');
    expect(pages).toMatch(
      /getElementById\('loading'\)\.style\.display = 'none';\s*(?:\/\/[^\n]*\n\s*)*initOnboarding\(\);/,
    );
  });

  it('初回ゲート/dismiss は localStorage で判定する (新規 DB/API なし)', () => {
    expect(pages).toContain("'onboarding_tour_v1_done'");
    expect(pages).toContain("'nextmove_dismissed'");
    expect(pages).toContain('function finishTour');
    expect(pages).toContain('function dismissNextMove');
  });

  it('CTA は既存機能を再利用する (switchTab/openFeaturePage・新規遷移先なし)', () => {
    expect(pages).toContain("switchTab('quiz')");
    expect(pages).toContain("openFeaturePage('/liff/opt-in')");
    expect(pages).toContain("switchTab('intake')");
  });

  it('次の一手 CTA タップ後に renderNextMove で再評価する (session 中の stale 表示防止)', () => {
    // lsSet(step.key,'1') → renderNextMove() → step.run() の順で、タップ済ステップを繰り返さない
    expect(pages).toMatch(
      /ctaEl\.onclick = function \(\) \{[\s\S]*?lsSet\(step\.key, '1'\);[\s\S]*?renderNextMove\(\);[\s\S]*?step\.run\(\);/,
    );
  });

  it('onboarding ブロックは esbuild backtick trap を踏まない (backtick/${ を含まない)', () => {
    if (!block) throw new Error('block missing');
    expect(block[0]).not.toContain('`');
    expect(block[0]).not.toContain('${');
  });
});

describe('LIFF 初回オンボーディング (第2波-⑥) — computeNextMove 実ロジック (source eval)', () => {
  it('診断ファースト: 何も actioned でなければ nm_quiz を返す', () => {
    expect(makeLogic({}).computeNextMove()?.key).toBe('nm_quiz');
  });

  it('診断済なら次は nm_optin', () => {
    expect(makeLogic({ nm_quiz: '1' }).computeNextMove()?.key).toBe('nm_optin');
  });

  it('optin_dismissed 済でも optin をスキップして nm_intake へ (二重提示回避)', () => {
    expect(makeLogic({ nm_quiz: '1', optin_dismissed: '1' }).computeNextMove()?.key).toBe('nm_intake');
  });

  it('全ステップ actioned なら null (カード非表示)', () => {
    expect(makeLogic({ nm_quiz: '1', nm_optin: '1', nm_intake: '1' }).computeNextMove()).toBeNull();
  });

  it('NEXT_MOVE_STEPS の順序は 診断→メール→服用 (診断ファースト)', () => {
    expect(makeLogic({}).NEXT_MOVE_STEPS.map((s) => s.key)).toEqual(['nm_quiz', 'nm_optin', 'nm_intake']);
  });
});
