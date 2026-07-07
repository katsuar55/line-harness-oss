/**
 * 実機FB第4弾 (2026-07-07 Katsu スクショ):
 *
 * 1. ヘッダー = 公式ロゴ SVG (officialLOGO_800x267.svg、Shopify CDN 直参照 + onerror fallback)。
 *    テキスト「ナチュリズム | インナーケア」は廃止 (オフィシャルと同じ本物のロゴを使う)。
 * 2. タブ可読性: tab-inactive が薄すぎ (#94a3b8 ≈ 2.8:1) → #475569 に濃色化。
 *    「マイページ」だけ改行される → nav button に white-space:nowrap + tab-strip を
 *    横スクロール可能に (スクロールバー非表示、swipe 設計原則により data-no-tab-swipe 必須)。
 * 3. 紹介リンク: workers.dev 生 URL (katsu-7d5 が見える) は不信感で離脱要因 →
 *    liff.line.me permalink (LINE 内で最も自然に開ける) へ変更。
 * 4. 没入スクロール (Katsu 指示「重要」: 高級感×先進性、大胆に、ただし軽量):
 *    - 3D カード cascade (.sr → .sr-in: perspective + rotateX + translateY、stagger)
 *    - スクロール進捗バー (#scroll-progress、ブランドグラデ、transform:scaleX のみ)
 *    - IntersectionObserver ベース (ライブラリなし)・reveal 後は will-change を解放
 *    - reduced-motion / TAB_REDUCED_MOTION / IO 非対応で完全 fallback (内容は常に見える)
 *
 * inline template-literal のため source 静的検査 (既存 liff-* テストと同流儀)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('ヘッダー: 公式ロゴ', () => {
  it('公式ロゴを使用し、テキスト見出しを廃止 (2026-07-07 PM: self-host PNG 化 — liff-brand-skin.test.ts 参照)', () => {
    expect(pages).toContain('src="/liff/brand-logo.png"');
    expect(pages).not.toMatch(/<h1[^>]*>ナチュリズム/);
  });

  it('取得失敗時は onerror でブランド名 fallback を表示 (ロゴ消失でヘッダーが空にならない)', () => {
    expect(pages).toMatch(/brand-logo\.png[^>]*onerror/);
    expect(pages).toContain('id="brand-fallback"');
  });
});

describe('タブ可読性と改行', () => {
  it('tab-inactive は #475569 (薄すぎ #94a3b8 を廃止)', () => {
    expect(pages).toMatch(/\.tab-inactive\{color:#475569/);
    expect(pages).not.toMatch(/\.tab-inactive\{color:#94a3b8/);
  });

  it('nav button は white-space:nowrap (「マイページ」の途中改行を防ぐ)', () => {
    expect(pages).toMatch(/nav button\{[^}]*white-space:nowrap/);
  });

  it('tab-strip は横スクロール可 + scrollbar 非表示 + data-no-tab-swipe (swipe 設計原則)', () => {
    expect(pages).toMatch(/tab-strip\{[^}]*overflow-x:auto/);
    expect(pages).toMatch(/tab-strip::-webkit-scrollbar\{display:none\}/);
    expect(pages).toMatch(/tab-strip"[^>]*data-no-tab-swipe/);
  });
});

describe('紹介リンク URL', () => {
  it('共有 URL は liff.line.me permalink (workers.dev 生 URL を顧客に見せない)', () => {
    expect(pages).toMatch(/https:\/\/liff\.line\.me\/' \+ LIFF_ID \+ '\?ref='/);
  });

  it('LIFF_ID 未設定時のみ従来 URL に fallback', () => {
    const m = pages.match(/async function loadReferralCard\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/LIFF_ID \?/);
  });
});

describe('没入スクロール (3D cascade + 進捗バー)', () => {
  it('#scroll-progress 要素とブランドグラデ CSS (transform:scaleX のみ)', () => {
    expect(pages).toContain('<div id="scroll-progress"');
    expect(pages).toMatch(/#scroll-progress\{[^}]*linear-gradient\(90deg,#80c8cd/);
    expect(pages).toMatch(/#scroll-progress\{[^}]*transform:scaleX\(0\)/);
  });

  it('.sr / .sr-in は perspective + rotateX の 3D cascade (transform/opacity のみ)', () => {
    expect(pages).toMatch(/\.sr\{opacity:0;transform:perspective/);
    expect(pages).toMatch(/rotateX\(/);
    expect(pages).toMatch(/\.sr-in\{[^}]*cubic-bezier/);
  });

  it('initScrollReveal は IntersectionObserver ベースで reveal 後 unobserve + will-change 解放', () => {
    const m = pages.match(/function initScrollReveal\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    const b = m![0];
    expect(b).toContain('IntersectionObserver');
    expect(b).toContain('unobserve');
    expect(b).toMatch(/classList\.remove\('sr'/); // will-change 解放
    expect(b).not.toContain('`');
  });

  it('reduced-motion / IO 非対応では内容が常に見える (opacity:0 で固まらない)', () => {
    // JS guard
    expect(pages).toMatch(/function initScrollReveal\(\) \{[\s\S]{0,700}TAB_REDUCED_MOTION/);
    expect(pages).toMatch(/function initScrollReveal\(\) \{[\s\S]{0,1400}'IntersectionObserver' in window/);
    // CSS guard (.sr を強制表示 + 進捗バー非表示)
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,700}\.sr\{opacity:1 !important;transform:none !important\}/);
    expect(pages).toMatch(/prefers-reduced-motion:reduce\)[\s\S]{0,900}#scroll-progress(,#scroll-leaf)?\{display:none\}/);
  });

  it('.sr の付与は initScrollReveal 実行時のみ (JS 未実行 = 全カード可視) + loading 非表示後に起動', () => {
    const m = pages.match(/function initScrollReveal\(\) \{[\s\S]*?\n\}/);
    expect(m![0]).toMatch(/classList\.add\('sr'\)/);
    // initLiff 内: loading を消した後に呼ぶ (overlay 下で cascade が空撃ちされない)
    expect(pages).toMatch(/loading'\)\.style\.display = 'none';[\s\S]{0,120}initScrollReveal\(\)/);
  });

  it('スクロール進捗は rAF throttle + passive listener (低スペック端末で 60fps)', () => {
    const m = pages.match(/function initScrollReveal\(\) \{[\s\S]*?\n\}/);
    expect(m![0]).toContain('requestAnimationFrame');
    expect(m![0]).toContain('passive: true');
  });
});
