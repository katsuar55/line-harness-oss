/**
 * コーラル挿し色 (2026-07-07 Katsu 実機FB第6弾):
 *
 * 「ティールグリーンが多く、ナチュリズムのカラーパレットの通り暖色のコーラルも
 *  適当なところで使用してほしい」
 *
 * コーラルの正 = テーマ実測 `--color-coral: #FFB39C` (theme-live/assets/pp-styles.css:29)。
 * 三層設計: ティール=基調・構造 / コーラル=感情・お得・アクションの挿し色 / ゴールド=プレミア。
 *
 * 適用箇所 (「適当なところ」の判断):
 *   - 診断 (感情・楽しさの中心): 診断スタート CTA = btn-coral / quiz progress bar /
 *     結果の「あなたにおすすめ」ラベル
 *   - はじめの一歩 (next-move) ラベル
 *   - welcome クーポン (お得の主役): 汎用 orange → ブランドコーラルに調律
 *   - 紹介実績の数字 / 3日以上の連続服用ストリーク数字 (達成の温かさ)
 *   - スクロール進捗バーの終端 (teal → coral のグラデ)
 *
 * コントラスト (adversarial review MEDIUM+LOW 反映):
 *   - 文字は --coral-ink #a44e37 (白背景 ~5.3:1 / #fff5ec 上 ~4.9:1、WCAG AA)
 *   - 白文字ボタンの gradient は深端 #b85c41 (白 4.5:1) + text-shadow で明端を補強
 *   - 原色 #ffb39c は装飾 (進捗バー/quiz bar/枠) のみ、文字背景に使わない
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('コーラル トークンとクラス', () => {
  it(':root にコーラルトークン (パレット実測 #ffb39c 基軸)', () => {
    expect(pages).toMatch(/--coral:#ffb39c;--coral-deep:#e8836a;--coral-ink:#a44e37/);
  });

  it('.btn-coral は btn-primary と同じ pill + 押し込み文法のコーラル版 (白文字 AA = 深端 #b85c41 + text-shadow)', () => {
    expect(pages).toMatch(/\.btn-coral\{background:linear-gradient\(135deg,#e8836a 0%,#b85c41 100%\)/);
    expect(pages).toMatch(/\.btn-coral\{[^}]*text-shadow/);
    expect(pages).toMatch(/\.btn-coral\{[^}]*border-radius:999px !important/);
    expect(pages).toMatch(/\.btn-coral:active\{transform:scale\(0\.95\) translateY\(1\.5px\)/);
  });

  it('.text-coral は AA を満たす coral-ink (#a44e37)', () => {
    expect(pages).toMatch(/\.text-coral\{color:#a44e37 !important\}/);
  });
});

describe('適用箇所', () => {
  it('診断スタート CTA は btn-coral (感情アクション)', () => {
    expect(pages).toMatch(/onclick="startQuiz\(\)" class="btn-coral/);
  });

  it('quiz progress bar はコーラルグラデ', () => {
    expect(pages).toMatch(/#quiz-progress-bar\{background:linear-gradient\(90deg,#ffb39c,#e8836a\) !important\}/);
  });

  it('「はじめの一歩」「あなたにおすすめ」「紹介実績」の数字/ラベルが text-coral', () => {
    expect(pages).toMatch(/text-coral[^>]*>はじめの一歩|はじめの一歩[\s\S]{0,40}text-coral/);
    expect(pages).toMatch(/class="text-xs text-coral font-bold mb-2">あなたにおすすめ/);
    expect(pages).toMatch(/紹介実績: <span class="font-bold text-coral">/);
  });

  it('welcome クーポンは汎用 orange からブランドコーラルへ調律 (orange 系クラス残存なし)', () => {
    const m = pages.match(/async function loadWelcomeCoupon\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/orange-\d00/);
    expect(m![0]).toContain('btn-coral');
    expect(m![0]).toContain('text-coral');
    // 「あなた専用」バッジの白文字は AA 合格の #b85c41 背景
    expect(m![0]).toContain('background:#b85c41');
  });

  it('3日以上の連続服用はストリーク数字がコーラル (達成の温かさ)', () => {
    const m = pages.match(/async function loadIntakeData\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/currentStreak >= 3 \? 'text-coral' : 'text-gray-800'/);
  });

  it('スクロール進捗バーは teal → coral のグラデ', () => {
    expect(pages).toMatch(/#scroll-progress\{[^}]*linear-gradient\(90deg,#80c8cd,#2fa8ad,#ffb39c\)/);
  });

  it('reduced-motion で btn-coral の押し込みも無効化', () => {
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,900}\.btn-coral:active[\s\S]{0,120}transform:none !important/);
  });
});
