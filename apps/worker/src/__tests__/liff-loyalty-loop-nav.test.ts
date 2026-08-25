/**
 * Regression guard (2026-06-29 UX ブラッシュアップ — 回遊・LINE一本化への動機付け):
 *
 * 採点 consolidation HIGH: ①ホーム rank card が「次のランクまであと¥X」を text のみで表示し、
 * 購入への CTA が無く購入意欲に繋がらない。②服用記録(intake)タブが記録 → streak/calendar/reminder で
 * 終わり、ランク・購入など「次のアクション」への導線が無く dead-end になっていた (単一機能で完結=回遊が閉じない)。
 *
 * 本 PR で rank card に会員特典購入 CTA を、intake タブ末尾に次アクション回遊導線を追加する。
 * liff-pages.ts は inline template-literal なので静的検査。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const pages = readFileSync(join(root, '..', 'routes', 'liff-pages.ts'), 'utf8');

describe('回遊ループ導線 (consolidation)', () => {
  it('ホーム rank card に会員特典・購入への CTA がある (text dead-end を解消)', () => {
    // 2026-08-25: 統合ランクヒーローに置き換わり、CTA は fragment 側のフッターボタンへ移った。
    // 導線の有無 (ここが消えると回遊が閉じる) はここで、文言と挙動は liff-rank-hero.test.ts で固定する。
    const heroJs = readFileSync(
      join(root, '..', 'routes', 'liff-portal-fragments', 'rank-hero.ts'),
      'utf8',
    );
    // 🚨 コメント本文でも満たせる素の部分一致にしない。 コード位置 (引用符に囲まれた実文字列) で照合する。
    //    逐語の可視テキストは liff-rank-hero.test.ts が実 DOM で固定している。
    expect(heroJs).toContain('"会員特典を見る →"');
    expect(heroJs).toMatch(/openFeaturePage\("\/liff\/my-rank"\)/);
    // fragment が実際にポータルへ emit されていること (import しただけで配線漏れ、を防ぐ)
    expect(pages).toContain('${rankHeroJs()}');
  });

  it('服用記録(intake)タブ末尾に次アクション回遊導線を追加 (記録→ランク/購入)', () => {
    expect(pages).toContain('続けるほど、おトク');
    // 続けるほどおトク card は home tab (ランク/バッジ) と 会員購入 (my-rank) へ繋ぐ
    // (2026-07-04: タブ遷移は方向つきアニメの switchTabTo に統一)
    expect(pages).toMatch(/続けるほど、おトク[\s\S]{0,400}switchTabTo\('home'\)/);
    expect(pages).toMatch(/続けるほど、おトク[\s\S]{0,400}openFeaturePage\('\/liff\/my-rank'\)/);
  });
});
