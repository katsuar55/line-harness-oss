/**
 * §7-1 コントラストガードの一元化 (Ultraplan PR-1)。
 *
 * 従来は禁止 hex の文字列検出が liff-vital-strip / liff-sublink-fastpath に分散し、
 * 検査対象も「ソースの一部ブロック」だった。ここでは:
 *   1. **レンダリング済み出力** に対する禁止 hex 検査 (LIFF 全ページ × gate matrix)
 *   2. :root トークンを parse して WCAG AA (4.5:1) を実計算する宣言表
 * の 2 軸に一元化する。既存の分散検査は削除しない (二重化はこのリポジトリの流儀)。
 *
 * 視覚刷新 (PR-7/8) で色を足す/変えるときは、まず宣言表に (文字色, 地色) を足して
 * 赤くなることを確認してから実装する (テストファースト)。
 */

import { describe, it, expect } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';
import { liffMyRank } from '../routes/liff-my-rank.js';
import { liffFoodPage } from '../routes/liff-food-page.js';
import { liffCoachPage } from '../routes/liff-coach-page.js';
import { liffFoodGraph } from '../routes/liff-food-graph.js';
import { liffReorderPage } from '../routes/liff-reorder-page.js';
import { liffOptInPage } from '../routes/liff-opt-in-page.js';
import {
  PORTAL_BASE_ENV,
  PORTAL_GATE_MATRIX,
  renderPortal,
  extractStyles,
} from './helpers/render-portal.js';
import { contrastRatio, parseRootHexTokens, resolveColor } from './helpers/contrast.js';

type AnyHono = { request: (p: string, i: Record<string, never>, e: unknown) => Promise<Response> };

const PAGES: ReadonlyArray<readonly [string, AnyHono, string]> = [
  ['/liff/portal', liffPages as unknown as AnyHono, 'portal'],
  ['/liff/my-rank', liffMyRank as unknown as AnyHono, 'my-rank'],
  ['/liff/food', liffFoodPage as unknown as AnyHono, 'food'],
  ['/liff/coach', liffCoachPage as unknown as AnyHono, 'coach'],
  ['/liff/food/graph', liffFoodGraph as unknown as AnyHono, 'food-graph'],
  ['/liff/reorder', liffReorderPage as unknown as AnyHono, 'reorder'],
  ['/liff/opt-in', liffOptInPage as unknown as AnyHono, 'opt-in'],
];

async function renderPage(path: string, app: AnyHono): Promise<string> {
  const res = await app.request(path, {}, PORTAL_BASE_ENV as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

describe('§7-1 禁止 hex — レンダリング済み出力で検査 (LIFF 全ページ)', () => {
  // ブランド原色ティール: 白文字 2.3:1 で AA 不合格。全ページ・全文脈で禁止。
  it.each(PAGES.map(([p, a, label]) => [label, p, a] as const))(
    '%s に #0ABAB5 系が出力されない',
    async (_label, path, app) => {
      const html = await renderPage(path, app);
      expect(html).not.toMatch(/#0abab5/i);
      // 同輝度帯の近縁も禁止 (過去に「少しずらして再導入」が起きないよう幅を持たせる)
      expect(html).not.toMatch(/#0bbab5|#0acab5/i);
    },
  );

  it('portal — gate 全組合せでも #0ABAB5 系が出力されない', async () => {
    for (const [, extra] of PORTAL_GATE_MATRIX) {
      const html = await renderPortal(extra);
      expect(html).not.toMatch(/#0abab5/i);
    }
  });

  it('LINE 緑 #06C755 は「LINEで送る」文脈の近傍のみ (封印の例外は 1 用途だけ)', async () => {
    const html = await renderPortal();
    const hits = [...html.matchAll(/#06C755/gi)];
    expect(hits.length).toBeGreaterThan(0); // 共有ボタン自体は存在する
    for (const m of hits) {
      const ctx = html.slice(Math.max(0, m.index - 400), m.index + 400);
      const isShareContext =
        ctx.includes('LINEで送る') || ctx.includes('openLineShare') || ctx.includes('shareRefLine');
      expect(isShareContext, `#06C755 が共有ボタン以外の文脈で使われています: …${ctx.slice(180, 320)}…`).toBe(true);
    }
  });
});

describe('§7-1 コントラスト実計算 — トークン宣言表 (WCAG AA 4.5:1)', () => {
  // 「この文字色はこの地色の上に載る」という設計上の組合せの台帳。
  // 色を追加/変更する PR は、先にここへ行を足して赤を確認してから実装する。
  const DECLARED_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
    // [文字色, 地色, どこで使うか]
    ['#ffffff', '--action', '.btn-primary 白文字 × アクション緑'],
    ['#ffffff', '--action-2', 'グラデ終端でも白文字が立つこと'],
    ['--ink', '#ffffff', '本文 × カード白地'],
    ['--ink-2', '#ffffff', 'セカンダリ本文 × カード白地'],
    ['--muted', '#ffffff', '補足文 × カード白地'],
    ['--brand-deep', '#ffffff', 'ブランド見出し × 白地'],
    ['--gold-ink', '--gold-wash', '金チケットの文字 × 金ウォッシュ地'],
    ['--coral-ink', '--coral-soft', 'コーラルチップ文字 × コーラル淡地'],
  ];

  it('宣言表の全ペアが AA (4.5:1) を満たす', async () => {
    const css = extractStyles(await renderPortal());
    const tokens = parseRootHexTokens(css);
    expect(tokens.size).toBeGreaterThan(8); // parse が壊れていないこと (0 件素通り防止)

    const failures: string[] = [];
    for (const [fg, bg, where] of DECLARED_PAIRS) {
      const ratio = contrastRatio(resolveColor(tokens, fg), resolveColor(tokens, bg));
      if (ratio < 4.5) failures.push(`${where}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (< 4.5)`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('計測器の自己検証: 既知の不合格ペアをちゃんと落とす (0ABAB5 × 白文字)', () => {
    // ガード自身が壊れて「常に合格」になっていないことの mutation 内蔵版
    expect(contrastRatio('#ffffff', '#0abab5')).toBeLessThan(4.5);
    expect(contrastRatio('#ffffff', '#0f766e')).toBeGreaterThanOrEqual(4.5);
  });
});
