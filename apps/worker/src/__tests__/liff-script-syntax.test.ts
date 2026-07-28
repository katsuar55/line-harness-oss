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
import { liffPages } from '../routes/liff-pages.js';

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
    expect(html).toContain('shopify-link-card');
    expect(html).toContain('"https://naturism-diet.com"'); // JSON.stringify 経由の安全な埋め込み
  });

  it('/liff/portal (App Proxy gate off = カード非表示・SHOPIFY_LINK_URL は null)', async () => {
    const html = await fetchBody('/liff/portal');
    expect(html).not.toContain('shopify-link-card');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
  });

  it('/liff/portal (storefront URL が不正形式なら gate on でもカードを出さない)', async () => {
    const env = {
      ...baseEnv,
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'javascript:alert(1)',
    };
    const html = await fetchBody('/liff/portal', env);
    assertParses(extractInlineScripts(html), '/liff/portal (bad storefront url)');
    expect(html).not.toContain('shopify-link-card');
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
