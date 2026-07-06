/**
 * タブ フリック切替 + ヘッダー刷新 + ツアー スワイプ (2026-07-04 Katsu 実機 FB):
 *
 * 1. 上部タブ (マイページ/診断/服用記録/体調/ストア/その他) を左右フリックで
 *    「ページがめくれる」ようにスライド切替 (先進性方針: 柔らかく心地よく)
 * 2. ヘッダー「naturism」→ オフィシャルティール「ナチュリズム | インナーケア」
 * 3. オンボーディングツアー 4 ページもフリックで前後移動 (つぎへボタン併存)
 *
 * liff-pages.ts は inline template のため source 静的検査で担保する。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('ヘッダー刷新', () => {
  it('ブランド見出しがティールグラデ + 「ナチュリズム | インナーケア」', () => {
    expect(pages).toMatch(/<h1[^>]*#0ABAB5[^>]*>ナチュリズム/);
    expect(pages).toContain('インナーケア');
    // 旧 LINE グリーン (#06C755) の h1 グラデは残っていない
    expect(pages).not.toMatch(/<h1[^>]*#06C755[^>]*>naturism</);
  });
});

describe('タブ フリック切替', () => {
  it('TAB_ORDER が 6 タブを画面順で定義している', () => {
    expect(pages).toMatch(/var TAB_ORDER = \['home', 'quiz', 'intake', 'health', 'shop', 'more'\]/);
  });

  it('touchstart/touchend の passive リスナーで水平フリックを判定する', () => {
    expect(pages).toMatch(/function initTabSwipe/);
    expect(pages).toMatch(/touchstart[\s\S]{0,300}passive: true/);
    // 縦スクロール優位の除外 (dx が dy を明確に上回るときだけ)
    expect(pages).toMatch(/Math\.abs\(dx\) < Math\.abs\(dy\)/);
  });

  it('端のタブでは wrap しない (clamp)', () => {
    expect(pages).toMatch(/next < 0 \|\| next >= TAB_ORDER\.length/);
  });

  it('スライド切替は reduced-motion で即時切替に fallback する', () => {
    expect(pages).toMatch(/function switchTabAnimated/);
    expect(pages).toMatch(/TAB_REDUCED_MOTION[\s\S]{0,120}switchTab\(name\)/);
  });

  it('fadeUp keyframe とスライドが二重発火しない (animation none で抑止)', () => {
    expect(pages).toMatch(/switchTabAnimated[\s\S]*?animation = 'none'/);
  });

  it('ナビのタブボタンは方向つきアニメ切替 (switchTabTo) を使う', () => {
    expect(pages).toContain('onclick="switchTabTo(\'quiz\')"');
    expect(pages).toContain('onclick="switchTabTo(\'shop\')"');
    expect(pages).not.toContain('onclick="switchTab(\'quiz\')"');
  });

  it('ツアー overlay 上のフリックはタブ切替に波及しない (data-no-tab-swipe)', () => {
    expect(pages).toMatch(/id="onboarding-tour"[^>]*data-no-tab-swipe/);
    expect(pages).toMatch(/closest\('\[data-no-tab-swipe\]'\)/);
  });
});

describe('ツアー スワイプ', () => {
  it('tour-content wrapper が存在しスライド対象になる', () => {
    expect(pages).toContain('id="tour-content"');
  });

  it('initTourSwipe が前後フリック (tourAdvance ±1) を配線する', () => {
    expect(pages).toMatch(/function initTourSwipe/);
    expect(pages).toMatch(/function tourAdvance/);
    expect(pages).toMatch(/tourIndex--/);
  });

  it('つぎへボタン (tourPrimary) は維持され、内部でアニメ経路を使う', () => {
    expect(pages).toContain('onclick="tourPrimary()"');
    expect(pages).toMatch(/function tourPrimary\(\) \{[\s\S]{0,120}tourAdvance\(1\)/);
  });

  it('初期化で initTabSwipe / initTourSwipe が呼ばれる', () => {
    expect(pages).toMatch(/initTabSwipe\(\);/);
    expect(pages).toMatch(/initTourSwipe\(\);/);
  });
});

describe('esbuild backtick trap', () => {
  it('新規ブロック (タブ/ツアー) に backtick を含まない', () => {
    // ファイル内の定義順: ツアー系 (tourAdvance〜initTourSwipe) が先、タブ系 (TAB_ORDER〜initTabSwipe) が後
    const tourBlock = pages.match(/function tourAdvance[\s\S]*?function initTourSwipe[\s\S]*?\n\}/);
    const tabBlock = pages.match(/var TAB_ORDER[\s\S]*?function initTabSwipe[\s\S]*?\n\}/);
    expect(tourBlock).not.toBeNull();
    expect(tabBlock).not.toBeNull();
    expect(tourBlock![0]).not.toContain('`');
    expect(tabBlock![0]).not.toContain('`');
  });
});
