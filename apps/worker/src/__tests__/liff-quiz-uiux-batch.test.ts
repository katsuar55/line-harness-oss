/**
 * 採点 Round3 batch: quiz UX (verified 72) + uiux_feel (verified 72) — 2026-07-07
 *
 * quiz batch:
 *   - 回答途中の state を sessionStorage に保存 → リロード/中断から再開可能
 *     (注: grader の「タブ切替で消失」は誤り — switchTab は DOM を隠すだけ。実在リスクは
 *      リロード/誤操作での消失なので、その対策として永続化する)
 *   - ✕ で中断できる (cancelQuiz、進捗保持)
 *   - 選択ハイライトは classList API (className.replace は class 順序/空白に脆い)
 *   - auto-advance 300ms→150ms + progress bar は選択直後に即時更新
 *   - 連打で 2 問飛ぶ二重 advance を quizAdvancing ガードで防止
 *   - 結果画面に entrance animation / スコア内訳の winner ★ / 保存結果のトースト通知
 *
 * uiux_feel (Katsu 常設方針「先進性を感じる操作感」):
 *   - btn-primary/meal-btn の押下 scale を明確に (0.95)
 *   - fadeUp を 0.38s の soft curve に
 *   - skeleton の stagger (連続カードが波状に光る)
 *   - prefers-reduced-motion 尊重
 *
 * inline template-literal のため source 静的検査 (既存 liff-* テストと同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

/** top-level function のブロックを抽出 (行頭 `}` で終端) */
function fnBlock(name: string): string {
  const m = pages.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  expect(m, name + ' が定義されている').not.toBeNull();
  return m![0];
}

describe('quiz UX batch', () => {
  it('回答 state を sessionStorage に保存し、リロード/中断から再開できる (v3=食事シーン軸キー: 旧ラベルの保存 state を世代交代で無効化)', () => {
    expect(pages).toContain("'quiz_state_v3'");
    expect(pages).not.toContain("'quiz_state_v1'");
    expect(pages).not.toContain("'quiz_state_v2'");
    expect(pages).toContain('function saveQuizState(');
    expect(pages).toContain('function loadQuizState(');
    expect(pages).toContain('function clearQuizState(');
    // startQuiz は保存 state があれば途中から再開
    expect(fnBlock('startQuiz')).toContain('loadQuizState()');
  });

  it('loadQuizState は壊れた/範囲外の保存値を拒否する (JSON.parse ガード + step 範囲チェック)', () => {
    const b = fnBlock('loadQuizState');
    expect(b).toMatch(/catch/);
    expect(b).toMatch(/step\s*<\s*0|st\.step\s*>=\s*QUIZ_QUESTIONS\.length/);
  });

  it('retryQuiz は保存 state をクリアして最初から / finishQuiz もクリアする', () => {
    expect(fnBlock('retryQuiz')).toContain('clearQuizState()');
    expect(fnBlock('finishQuiz')).toContain('clearQuizState()');
  });

  it('診断中に ✕ で中断できる (cancelQuiz、intro へ戻る)', () => {
    expect(pages).toContain('function cancelQuiz(');
    expect(pages).toMatch(/onclick="cancelQuiz\(\)"/);
  });

  it('選択ハイライトは classList API (fragile な className.replace を廃止)', () => {
    const b = fnBlock('selectQuizOption');
    expect(b).toContain('classList.remove');
    expect(b).toContain('classList.add');
    expect(b).not.toContain('className.replace');
  });

  it('auto-advance は 150ms、progress bar は選択直後に即時更新 (待ちがアニメになる)', () => {
    const b = fnBlock('selectQuizOption');
    expect(b).toMatch(/quiz-progress-bar[\s\S]*setTimeout/);
    expect(b).toContain(', 150)');
    expect(b).not.toContain(', 300)');
  });

  it('150ms 窓内の連打で 2 問飛ばない (quizAdvancing ガード)', () => {
    const b = fnBlock('selectQuizOption');
    expect(b).toMatch(/if \(quizAdvancing\) return;/);
    expect(b).toMatch(/quizAdvancing = true/);
    expect(b).toMatch(/quizAdvancing = false/);
  });

  it('✕ 中断は pending advance timer を破棄する (stale timer が再開後の state を進める race 防止 — review MEDIUM)', () => {
    const cancel = fnBlock('cancelQuiz');
    expect(cancel).toMatch(/clearTimeout\(quizAdvanceTimer\)/);
    expect(cancel).toMatch(/quizAdvancing = false/);
    expect(fnBlock('startQuiz')).toMatch(/clearTimeout\(quizAdvanceTimer\)/);
  });

  it('回答は 150ms 待ちに依存せず即時保存される (review LOW)', () => {
    const b = fnBlock('selectQuizOption');
    // quizAnswers 更新 → saveQuizState が setTimeout より前に呼ばれる
    expect(b).toMatch(/quizAnswers\[q\.id\][\s\S]*saveQuizState\(\);[\s\S]*setTimeout/);
  });

  it('結果画面に entrance animation (inline style — switchTab 管理の .section は使わない)', () => {
    const b = fnBlock('finishQuiz');
    expect(b).toMatch(/quiz-result'\)\.style\.animation/);
  });

  it('度数バーは本サイト同一: 固定順 (ブルー度→ピンク度→プレミアム度)・%は合計比・ゼロ除算ガード (2026-07-29 9問版ミラー)', () => {
    const b = fnBlock('finishQuiz');
    expect(b).toContain('QUIZ_TYPES.forEach');
    expect(b).toMatch(/total > 0 \? Math\.round/);
    expect(pages).toMatch(/QUIZ_TYPE_LABELS = \{ blue: 'ブルー度', pink: 'ピンク度', premium: 'プレミアム度' \}/);
    // 固定順の根拠: QUIZ_TYPES の宣言順 (得点順に並べ替えない)
    expect(pages).toMatch(/QUIZ_TYPES = \['blue', 'pink', 'premium'\]/);
  });

  it('診断結果の保存は成功/失敗をトーストで通知 (silent catch 廃止)', () => {
    const b = fnBlock('finishQuiz');
    expect(b).toMatch(/quiz\/submit[\s\S]{0,400}showToast/);
    expect(b).not.toMatch(/\.catch\(function\(\) \{\}\)/);
  });

  it('選択肢ボタンに tap feedback (2026-07-29: .nxq-opt の CSS :active scale へ移行)', () => {
    expect(pages).toMatch(/\.nxq-opt:active\{transform:scale\(\.97\)\}/);
  });

  it('esbuild backtick trap: quiz 変更ブロックに backtick を含まない', () => {
    for (const fn of ['startQuiz', 'retryQuiz', 'cancelQuiz', 'selectQuizOption', 'finishQuiz', 'saveQuizState', 'loadQuizState']) {
      expect(fnBlock(fn), fn).not.toContain('`');
    }
  });
});

describe('uiux_feel (先進性方針: タップ柔らかく・skeleton 波状・reduced-motion 尊重)', () => {
  it('btn-primary :active scale = 0.95 (明確な押下感) + shadow 強化', () => {
    expect(pages).toContain('.btn-primary:active{transform:scale(0.95)');
  });

  it('meal-btn に押下 scale feedback (2026-07-07 PM: 押し込み統一で translateY 同梱)', () => {
    expect(pages).toMatch(/\.meal-btn:active\{transform:translateY\(1\.5px\) scale\(0\.95\)\}/);
  });

  it('fadeUp は 0.38s の soft curve (0.25s ease-out から延長)', () => {
    expect(pages).toMatch(/animation:fadeUp \.38s/);
  });

  it('skeleton は stagger (連続カードで波状に光る)', () => {
    expect(pages).toMatch(/\.skeleton\{animation-delay|\.card:nth-child\(\d\) \.skeleton\{animation-delay/);
  });

  it('prefers-reduced-motion で装飾アニメ/押下 transform を無効化', () => {
    expect(pages).toContain('@media(prefers-reduced-motion:reduce)');
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,400}animation:none !important/);
  });
});
