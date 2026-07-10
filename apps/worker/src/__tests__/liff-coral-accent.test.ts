/**
 * コーラル挿し色 — 再バランス (2026-07-08 Katsu 実機FB第7弾「色が濃すぎ・薄くして・他タブにも」):
 *
 * #187 の #a44e37/#b85c41 は brown/rust に見えて重かった。judge panel (design workflow) の
 * 勝ち筋「chip」を採用:
 *   - 14px 白文字×コーラルは物理的に AA 不可 → .btn-coral を「淡ピーチ chip」へ (白文字塗り廃止)
 *   - 艶コーラル #d9573d は大数字 (≥24px/太字 = 3:1 で足りる) 専用に隔離
 *   - 小文字は #b84a2e (白 5.18:1 / #fff3ec 4.75:1 = AA)
 *
 * コーラルの正 = テーマ実測 `--color-coral: #FFB39C` (theme-live/assets/pp-styles.css:29)。
 * 三層設計: ティール=基調・構造・購入CTA / コーラル=感情・お得・アクション / ゴールド=プレミア。
 * 配置 (三層規律・全体1〜2割): 診断(quiz) + マイページ(home: welcome/next-move/紹介実績) + 服用(intake: streak)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('コーラル トークンとクラス (再バランス: 薄く明るいピーチ + AA)', () => {
  it(':root トークン: coral #ffb39c / deep #d9573d (艶・大数字) / ink #b84a2e (小文字AA) / soft #fff3ec', () => {
    expect(pages).toMatch(/--coral:#ffb39c;--coral-deep:#d9573d;--coral-ink:#b84a2e;--coral-soft:#fff3ec/);
    // 旧 brown/rust トーンは全廃
    expect(pages).not.toContain('--coral-ink:#a44e37');
  });

  it('.btn-coral は淡ピーチ chip (白文字塗り廃止 → 薄地 #fff3ec + コーラル文字 #b84a2e + コーラル枠)', () => {
    expect(pages).toMatch(/\.btn-coral\{background:#fff3ec;color:#b84a2e;border:1\.5px solid #eaa588/);
    expect(pages).toMatch(/\.btn-coral\{[^}]*border-radius:999px !important/);
    expect(pages).toMatch(/\.btn-coral:active\{transform:scale\(0\.95\) translateY\(1\.5px\);background:#ffe6db/);
    // 旧・重い白文字塗りが残っていない
    expect(pages).not.toMatch(/\.btn-coral\{[^}]*color:#fff/);
    expect(pages).not.toMatch(/\.btn-coral\{[^}]*#b85c41/);
  });

  it('.text-coral=#b84a2e (小文字AA) / .text-coral-lg=#d9573d (艶・大数字専用) / .chip-coral', () => {
    expect(pages).toMatch(/\.text-coral\{color:#b84a2e !important\}/);
    expect(pages).toMatch(/\.text-coral-lg\{color:#d9573d !important\}/);
    expect(pages).toMatch(/\.chip-coral\{background:#fff3ec;color:#b84a2e;border:1px solid #f0b49f\}/);
  });
});

describe('適用箇所 (quiz + home + intake の3タブ、三層規律)', () => {
  it('診断スタート CTA は btn-coral (感情アクション)', () => {
    expect(pages).toMatch(/onclick="startQuiz\(\)" class="btn-coral/);
  });

  it('quiz progress bar は明コーラルグラデ (#ffb39c→#d9573d)', () => {
    expect(pages).toMatch(/#quiz-progress-bar\{background:linear-gradient\(90deg,#ffb39c,#d9573d\) !important\}/);
  });

  it('「はじめの一歩」「あなたにおすすめ」「紹介数」の小ラベル/数字が text-coral (#b84a2e)', () => {
    expect(pages).toMatch(/text-coral[^>]*>はじめの一歩|はじめの一歩[\s\S]{0,40}text-coral/);
    expect(pages).toMatch(/class="text-xs text-coral font-bold mb-2">あなたにおすすめ/);
    // 実機FB第5弾: 紹介カード刷新で「紹介実績:」→「これまでの紹介:」(coral 数字は維持)
    expect(pages).toMatch(/これまでの紹介: <span class="font-bold text-coral">/);
  });

  it('welcome クーポン: 大数字は艶コーラル text-coral-lg、バッジは chip-coral (白文字塗り廃止)', () => {
    const m = pages.match(/async function loadWelcomeCoupon\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/orange-\d00/);
    expect(m![0]).toContain('text-coral-lg'); // OFF 大数字 (24px)
    expect(m![0]).toContain('chip-coral');    // 「あなた専用」バッジ
    expect(m![0]).toContain('btn-coral');     // 購入 CTA (お得の主役の例外)
    // 旧・濃い #b85c41 バッジ背景は残っていない
    expect(m![0]).not.toContain('background:#b85c41');
  });

  it('3日以上の連続服用ストリークは艶コーラル大数字 (text-coral-lg, 30px = 3:1 OK)', () => {
    const m = pages.match(/async function loadIntakeData\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/currentStreak >= 3 \? 'text-coral-lg' : 'text-gray-800'/);
  });

  it('スクロール進捗バーは teal → coral のグラデ', () => {
    expect(pages).toMatch(/#scroll-progress\{[^}]*linear-gradient\(90deg,#80c8cd,#2fa8ad,#ffb39c\)/);
  });

  it('reduced-motion で btn-coral の押し込みも無効化', () => {
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,900}\.btn-coral:active[\s\S]{0,120}transform:none !important/);
  });
});
