/**
 * モーション憲法の実行可能化 (Ultraplan PR-1)。
 *
 * 憲法 (liff-pages.ts L287-290): 「動く枠は .ref-hero 1 枚だけ。常時アニメの新設禁止。
 * 達成演出は 1 回きり。新規 animation は reduced-motion ブロックへ同時追記」。
 * 従来はコメントと部分的検査のみだった。ここで機械検証する:
 *   1. @keyframes は allowlist と完全一致 (新設は必ずこのテストの意図的更新として diff に出る)
 *   2. 無限ループ animation の使用箇所は既知の台帳と一致 (常時アニメの黙った新設を阻止)
 *   3. reduced-motion ブロックが存在し、既知の神経遮断が全部残っている
 *
 * 視覚刷新 (PR-8) でモーションを足すときの手順: まず allowlist / 台帳に追加して
 * 赤を確認 → 実装 (reduced-motion 追記込み) → green。
 */

import { describe, it, expect } from 'vitest';
import { renderPortal, extractStyles, PORTAL_GATE_MATRIX } from './helpers/render-portal.js';

/** portal の @keyframes 完全台帳 (2026-08-20 時点)。増減は意図的な diff としてここに現れる。 */
const PORTAL_KEYFRAMES_ALLOWLIST = [
  'avatarPulse',
  'badgePop',
  'confetti-fall',
  'fadeUp',
  'pulse',
  'refBorder',
  'refPop',
  'refShine',
  'rosUp',
  'shimmer',
  'sparkle',
  'sparkleRotate',
].sort();

/**
 * 無限ループ (常時) アニメの使用台帳。「動く枠は .ref-hero 1 枚だけ」の実体:
 * - shimmer = skeleton (ロード中のみ表示される要素なので常時ではない)
 * - pulse = .streak-fire / avatarPulse = アバター誘導 (1 要素・小)
 * - sparkle 系 = アンバサダー限定装飾
 * - refBorder/refShine/refPop = **唯一の「動く枠」(.ref-hero) の演出群**
 * ここに行を足す変更 = 憲法改正。安易に増やさないこと。
 */
const INFINITE_ANIMATION_LEDGER = [
  'avatarPulse',
  'pulse',
  'refBorder',
  'refPop',
  'refShine',
  'shimmer',
  'sparkle',
  'sparkleRotate',
].sort();

function keyframeNames(css: string): string[] {
  return [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).sort();
}

describe('モーション憲法 (portal)', () => {
  it('@keyframes は allowlist と完全一致 (黙った新設/削除を許さない)', async () => {
    const css = extractStyles(await renderPortal());
    expect(keyframeNames(css)).toEqual(PORTAL_KEYFRAMES_ALLOWLIST);
  });

  it('gate 全組合せでも keyframes 台帳は不変 (gate 分岐でアニメを密輸しない)', async () => {
    for (const [label, extra] of PORTAL_GATE_MATRIX) {
      const css = extractStyles(await renderPortal(extra));
      expect(keyframeNames(css), `gate: ${label}`).toEqual(PORTAL_KEYFRAMES_ALLOWLIST);
    }
  });

  it('無限ループ animation の使用は台帳と一致 (常時アニメの黙った新設を阻止)', async () => {
    const css = extractStyles(await renderPortal());
    const used = new Set<string>();
    // `animation: <name> ... infinite` / `animation:...infinite ... <name>` の両順序を拾う
    for (const m of css.matchAll(/animation:([^;}]*infinite[^;}]*)[;}]/g)) {
      const decl = m[1];
      for (const name of PORTAL_KEYFRAMES_ALLOWLIST) {
        if (new RegExp(`(^|[\\s,])${name}([\\s,]|$)`).test(decl)) used.add(name);
      }
    }
    expect([...used].sort()).toEqual(INFINITE_ANIMATION_LEDGER);
  });

  it('reduced-motion ブロックが既知の神経遮断を全部保持している', async () => {
    const css = extractStyles(await renderPortal());
    // media ブロックは**複数個**ある (quiz 用 L164 / シート用 L182 / 全体 L340) うえ、
    // 内側に {} がネストするため regex 非貪欲では最初の閉じで切れる。
    // 全 marker のスライスを合算して必須文字列を検査する (存在 0 素通り防止つき)。
    const markers = [...css.matchAll(/@media\(prefers-reduced-motion:reduce\)/g)].map((m) => m.index);
    expect(markers.length, 'reduced-motion ブロックが存在しない').toBeGreaterThanOrEqual(1);
    const block = markers.map((i) => css.slice(i, i + 1500)).join('\n');
    for (const required of [
      'animation:none',
      'transform:none',
      '.sr{opacity:1',
      '#scroll-progress,#scroll-leaf{display:none}',
    ]) {
      expect(block).toContain(required);
    }
  });
});
