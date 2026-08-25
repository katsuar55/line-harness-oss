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
  it('ブランド見出しは公式ロゴ + fallback (2026-07-07 実機FBでテキスト見出しから変更、PM: self-host 化)', () => {
    expect(pages).toContain('src="/liff/brand-logo.png"');
    expect(pages).toContain('id="brand-fallback"');
    // 旧 LINE グリーン (#06C755) の h1 グラデは残っていない
    expect(pages).not.toMatch(/<h1[^>]*#06C755[^>]*>naturism</);
  });
});

describe('タブ フリック切替', () => {
  it('TAB_ORDER が 4 タブを画面順で定義している (4タブ再設計: account はスワイプ対象外)', () => {
    expect(pages).toMatch(/var TAB_ORDER = \['home', 'quiz', 'shop', 'intake'\]/);
    // account はアバターから開く隠しセクション (タブバー/スワイプに出さない)
    expect(pages).not.toMatch(/TAB_ORDER = \[[^\]]*'account'/);
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
    // 採点R3: range スライダー (睡眠時間) の drag もタブ切替から除外
    expect(pages).toMatch(/closest\('\[data-no-tab-swipe\],input\[type="range"\]'\)/);
  });

  it('他の overlay/横スクロール要素も swipe 除外されている (review HIGH/LOW)', () => {
    // survey modal: 開いたままタブが裏で切り替わる desync を防ぐ
    expect(pages).toMatch(/id="survey-answer-modal"[^>]*data-no-tab-swipe/);
    // FAQ カテゴリチップ (overflow-x-auto): 横ドラッグでタブが切り替わらない
    expect(pages).toMatch(/id="faq-cats"[^>]*data-no-tab-swipe/);
  });

  it('switchTab は未知タブで throw せず現状維持する (review HIGH: deadlock 防止)', () => {
    expect(pages).toMatch(/function switchTab\(name, keepScroll\) \{[\s\S]{0,300}if \(!section\)/);
  });

  it('tabAnimating / tourAnimating は例外時も finally 系で必ず復帰する', () => {
    expect(pages).toMatch(/finally \{ tabAnimating = false; \}/);
    expect(pages).toMatch(/catch \(e\) \{\s*tabAnimating = false;/);
    expect(pages).toMatch(/var tourAnimating = false;/);
    expect(pages).toMatch(/finally \{ tourAnimating = false; \}/);
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
