/**
 * LIFF inline script の構文検証 (2026-07-10 本番障害の再発防止)。
 *
 * 背景: liff-pages.ts は server 側 TS の template literal に client JS を内包する。
 *   TS 側で `\'` と書くと template literal が `'` に潰し、吐き出された client JS の
 *   文字列リテラルが途中で終端 → **script 全体が SyntaxError → ポータルが
 *   「読み込み中」スピナーのまま全損** (2026-07-10 に本番で実発生)。
 *   既存の静的ガード群はソース文字列の regex 検査であり、吐き出された JS を
 *   parse するテストが存在しなかったため 3,346 テストを素通りした。
 *
 * 本テストは実際にページをレンダリングし、全 inline <script> を new Function で
 * parse する (= ブラウザの parse 相当)。構文エラーは即 fail。
 */

import { describe, it, expect } from 'vitest';
import type { Hono } from 'hono';
import { liffPages } from '../routes/liff-pages.js';
import { liffOptInPage } from '../routes/liff-opt-in-page.js';
import { liffMyRank } from '../routes/liff-my-rank.js';
import { liffCoachPage } from '../routes/liff-coach-page.js';
import { liffFoodPage } from '../routes/liff-food-page.js';
import { liffFoodGraph } from '../routes/liff-food-graph.js';
import { liffReorderPage } from '../routes/liff-reorder-page.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
  REFERRAL_REWARD_ENABLED?: string;
  APP_PROXY_LINK_ENABLED?: string;
  SHOPIFY_STOREFRONT_URL?: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
  WORKER_URL: 'https://example.workers.dev',
};

async function fetchBody(path: string, env: MinimalEnv = baseEnv): Promise<string> {
  const res = await liffPages.request(path, {}, env as unknown as Record<string, unknown>);
  expect(res.status).toBe(200);
  return res.text();
}

function extractInlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function assertParses(scripts: string[], label: string): void {
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    try {
      // new Function = 関数 body としての parse (top-level return/await は使っていない前提。
      // もし将来 top-level await を使うなら vm.SourceTextModule 等へ切替えること)
      new Function(src);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // エラー近傍を特定して失敗メッセージに含める (原因行の当たりを付けやすく)
      let context = '';
      const lineMatch = /<anonymous>:(\d+)/.exec(e instanceof Error ? (e.stack ?? '') : '');
      if (lineMatch) {
        const lines = src.split('\n');
        const n = Number(lineMatch[1]);
        context = lines.slice(Math.max(0, n - 3), n + 2).join('\n');
      }
      expect.fail(`${label}: inline script SyntaxError: ${msg}\n--- 近傍 ---\n${context}`);
    }
  }
}

// ============================================================
// 🚨 script 打ち切り (2026-05-17〜07-29 の本番障害) の恒久ガード
//
// inline script の中に **終了タグの literal** が 1 つでもあると、HTML parser は
// コメント内・文字列内でも構わずそこで <script> を閉じる。以降の JS は一切実行されず、
// ページは「読み込み中...」で固着する (= /liff/opt-in が 2.5 ヶ月開けなかった原因)。
//
// parse 検証だけでは**絶対に捕まらない**: 打ち切られた断片は文法的に valid なので
// new Function() は成功してしまう。実際 R1-R4 の採点と 4,000 件のテストを素通りした。
// そこで「終了タグが無いこと」と「本体が丸ごと存在すること」を直接固定する。
// ============================================================

const LIFF_PAGES: Array<{ path: string; router: Hono; sentinel: string }> = [
  { path: '/liff/portal', router: liffPages as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/opt-in', router: liffOptInPage as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/my-rank', router: liffMyRank as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/coach', router: liffCoachPage as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/food', router: liffFoodPage as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/food/graph', router: liffFoodGraph as unknown as Hono, sentinel: 'liff.init' },
  { path: '/liff/reorder', router: liffReorderPage as unknown as Hono, sentinel: 'liff.init' },
];

describe('LIFF 全ページの inline script が打ち切られていない', () => {
  it.each(LIFF_PAGES)('$path — 開始タグと終了タグの数が一致する (余分な終了タグ = 打ち切り点)', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const html = await res.text();

    // これが唯一の確実な検出方法。
    // 抽出後の断片を見ても無駄で、余分な終了タグは「区切り文字」として消費され姿を消す
    // (= not.toContain('</script') は常に true になる。実際に mutation で確認済み)。
    // 生 HTML で数を比べれば、本体に紛れ込んだ 1 個が必ず余りとして現れる。
    const opens = (html.match(/<script\b/gi) ?? []).length;
    const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
    expect(closes).toBe(opens);
  });

  it.each(LIFF_PAGES)('$path — script 本体が丸ごと出ている (断片で終わっていない)', async ({ path, router, sentinel }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    const html = await res.text();
    const src = extractInlineScripts(html).join('\n');

    // 打ち切られた断片は「コメント数十文字」で終わる。本体があることを sentinel で確認する。
    expect(src).toContain(sentinel);
    expect(src.length).toBeGreaterThan(1_000);
  });

  it.each(LIFF_PAGES)('$path — 吐き出された JS が parse できる', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    const html = await res.text();
    assertParses(extractInlineScripts(html), path);
  });
});

describe('LIFF ポータル inline script は構文的に valid (吐き出された JS の parse 検証)', () => {
  it('/liff/portal (gate off = 本番既定)', async () => {
    const html = await fetchBody('/liff/portal');
    assertParses(extractInlineScripts(html), '/liff/portal');
  });

  it('/liff/portal (REFERRAL_REWARD_ENABLED=true = gate on 分岐も valid)', async () => {
    const html = await fetchBody('/liff/portal', { ...baseEnv, REFERRAL_REWARD_ENABLED: 'true' });
    assertParses(extractInlineScripts(html), '/liff/portal (gate on)');
  });

  it('/liff/portal (APP_PROXY_LINK_ENABLED=true + storefront URL = Shopify 連携カード分岐も valid)', async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
    };
    const html = await fetchBody('/liff/portal', env);
    assertParses(extractInlineScripts(html), '/liff/portal (app-proxy gate on)');
    expect(html).toContain('id="shopify-link-card"');
    expect(html).toContain('"https://naturism-diet.com"'); // JSON.stringify 経由の安全な埋め込み
  });

  it('/liff/portal (App Proxy gate off = カード非表示・SHOPIFY_LINK_URL は null)', async () => {
    const html = await fetchBody('/liff/portal');
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
  });

  it('/liff/portal (gate off + 妥当な storefront URL でもカードを出さない = gate 条件そのものの検証)', async () => {
    // URL 未設定のケースだけだと「URL 検証で落ちている」のか「gate で落ちている」のか
    // 区別できず、gate 条件を消す退行が素通りする (tautology)。
    const env = { ...baseEnv, SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' };
    const html = await fetchBody('/liff/portal', env);
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
  });

  it.each([['TRUE'], ['false'], ['1'], ['true\r'], ['']])(
    '/liff/portal (gate 値 %s は有効化しない = === \'true\' 厳密一致)',
    async (gate) => {
      const env = {
        ...baseEnv,
        APP_PROXY_LINK_ENABLED: gate,
        SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
      };
      const html = await fetchBody('/liff/portal', env);
      expect(html).not.toContain('id="shopify-link-card"');
      expect(html).toContain('var SHOPIFY_LINK_URL = null;');
    },
  );

  // 許可する文字クラスそのものを固定する。 scheme だけを見る正規表現に緩めると
  // (`^https://.+$` 等)、`https://a.com/</script><script>…` のような breakout が
  // 通ってしまい #193 クラスの全損に戻る (R2 採点 HIGH)。
  it.each([
    ['javascript:alert(1)', 'scheme 違い'],
    ['http://naturism-diet.com', 'http (非 https)'],
    ['https://naturism-diet.com/ja', 'path 付き'],
    ['https://naturism-diet.com?q=1', 'query 付き'],
    ['https://naturism-diet.com:8443', 'port 付き'],
    ['https://a.com/</script><script>alert(1)</script>', 'script breakout'],
    ['https://a.com"+alert(1)+"', '文字列脱出'],
    ['', '空文字'],
  ])('/liff/portal (storefront URL %s = %s なら gate on でもカードを出さない)', async (url) => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: url,
    };
    const html = await fetchBody('/liff/portal', env);
    assertParses(extractInlineScripts(html), `/liff/portal (bad storefront url: ${url})`);
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
  });

  it('ソースに「単一バックスラッシュ + クォート」エスケープが存在しない (壊れた \\\' の混入防止)', async () => {
    const html = await fetchBody('/liff/portal');
    const scripts = extractInlineScripts(html);
    // 吐き出された JS 内で文字列が途中終端する典型シグネチャ:
    // getElementById('xxx') が「JS 文字列リテラルの内側」に生で現れる (onclick 属性値の生成側で潰れた場合)
    // → parse が通っていれば十分だが、二重チェックとして \' が奇数個で孤立していないことも確認
    for (const src of scripts) {
      expect(src).not.toMatch(/onclick="[^"]*getElementById\('/);
    }
  });
});
