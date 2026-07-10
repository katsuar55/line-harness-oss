/**
 * 第1波-② メール配信オプトイン導線 (2026-06-30):
 *
 * subscribed=2/1,891 (0.1%) というローンチ最大のボトルネックに、ポータルhomeから既存の
 * /liff/opt-in ページへ辿り着く導線が事実上存在しなかった (放置)。home に opt-in 募集カードを
 * 露出する。新規配信は発生しない (= risk low)。「あとで」 (×) で localStorage 記録し再表示しない。
 *
 * liff-pages.ts は inline template-literal なので source を静的検査する慣習に従う。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('LIFF opt-in 導線 (PR②)', () => {
  it('home に opt-in-card がある', () => {
    expect(pages).toContain('id="opt-in-card"');
    // 4タブ再設計: マイアカウント>設定の「メール受信設定」行として常時表示
    expect(pages).toContain('メール受信設定');
  });

  it('CTA は既存 /liff/opt-in ページへ openFeaturePage で遷移する', () => {
    expect(pages).toContain("openFeaturePage('/liff/opt-in')");
  });

  it('initOptInCard が init で呼ばれ、設定行として常時表示する (dismiss 廃止)', () => {
    expect(pages).toContain('function initOptInCard');
    expect(pages).toMatch(/Promise\.all\([\s\S]*?\]\);\s*initOptInCard\(\);/);
    // 設定行に × は無い (過去に×した人が永久到達不能になる問題の解消)
    expect(pages).not.toContain('onclick="dismissOptIn()"');
  });

  it('opt-in card はマイアカウント (section-account) 内にある', () => {
    const accountIdx = pages.indexOf('id="section-account"');
    const cardIdx = pages.indexOf('id="opt-in-card"');
    expect(accountIdx).toBeGreaterThan(-1);
    expect(cardIdx).toBeGreaterThan(accountIdx);
  });
});
