/**
 * 診断タブの商品ヒーロー動画 (2026-07-08 Katsu 提供の 5 秒動画で 💊 を差し替え):
 *
 * - quiz-intro カード上端に full-bleed 16:9 動画。R2 (/images/quiz-hero-v1.mp4) 配信。
 * - poster (quiz-hero-poster-v1.jpg) を先出しして読み込み体感をゼロに。
 * - autoplay 属性は付けず JS で「診断タブ表示時のみ再生」= データ節約 + reduced-motion 尊重。
 * - onerror で 💊 fallback (R2 未アップロード/障害でもレイアウトが崩れない)。
 *
 * inline template のため静的ガード。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('診断ヒーロー動画', () => {
  it('quiz-intro から 💊 の単独アイコンが消え、video 要素になった', () => {
    // 旧: <div class="text-5xl mb-3">💊</div> (heading の上の装飾)
    expect(pages).not.toContain('<div class="text-5xl mb-3">💊</div>');
    expect(pages).toContain('id="quiz-hero-video"');
  });

  it('R2 の mp4 を src、poster を先出し、preload=metadata', () => {
    // src を video に直接付与 (onerror が確実に発火する = <source> child より fallback が堅牢)
    expect(pages).toMatch(/src="\$\{apiBase\}\/images\/quiz-hero-v1\.mp4"/);
    expect(pages).toMatch(/poster="\$\{apiBase\}\/images\/quiz-hero-poster-v1\.jpg"/);
    expect(pages).toContain('preload="metadata"');
  });

  it('muted loop playsinline で LINE 内自動再生可・音なし', () => {
    const m = pages.match(/<video id="quiz-hero-video"[\s\S]*?>/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('muted');
    expect(m![0]).toContain('loop');
    expect(m![0]).toContain('playsinline');
    // autoplay 属性は付けない (JS 制御で reduced-motion / データ節約)
    expect(m![0]).not.toContain('autoplay');
  });

  it('16:9 を full-bleed で最大化 (card padding を打ち消す negative margin + 上角 round)', () => {
    expect(pages).toMatch(/-mt-6 -mx-6 mb-5 overflow-hidden rounded-t-\[20px\]/);
    expect(pages).toMatch(/aspect-ratio:16\/9;object-fit:cover/);
  });

  it('onerror で 💊 fallback を出す (R2 未アップロード/障害でも崩れない)', () => {
    expect(pages).toMatch(/id="quiz-hero-video"[\s\S]*?onerror=[\s\S]*?quiz-hero-fallback/);
    expect(pages).toContain('id="quiz-hero-fallback"');
  });

  it('診断タブ表示時のみ再生 (switchTab の quiz 分岐 → playQuizHeroVideo)', () => {
    expect(pages).toMatch(/name === 'quiz'\) playQuizHeroVideo\(\)/);
    expect(pages).toContain('function playQuizHeroVideo()');
  });

  it('reduced-motion では再生しない (poster 静止で motion を出さない)', () => {
    const m = pages.match(/function playQuizHeroVideo\(\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/TAB_REDUCED_MOTION\) return/);
    expect(m![0]).not.toContain('`');
  });
});
