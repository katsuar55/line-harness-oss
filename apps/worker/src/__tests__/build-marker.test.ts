/**
 * 版マーカー (2026-08-23)。
 *
 * #270 で「deploy 済み・本番 curl では新マーカーが出るのに実機は何も変わらない」の
 * 切り分けに丸 1 日かかった。真因は 2 つ重なっていた:
 *   (a) 観測が deploy の 95 分**前**だった
 *   (b) LIFF HTML に Cache-Control が皆無だった (#271 で修正)
 * どちらも「その画面がどの版か」を名乗る手段がゼロだったせいで判別できなかった。
 *
 * → HTML 自身に版を名乗らせる。スマホでは HTML ソースを見られないので、
 *   **画面上にも**出す (アカウントタブ最下部)。
 */
import { describe, it, expect } from 'vitest';
import { BUILD_SHA, BUILD_META_NAME, buildMetaTag } from '../utils/build-info.js';
import { renderPortal, PORTAL_GATE_MATRIX } from './helpers/render-portal.js';

describe('build-info', () => {
  it('vite の define が無い環境 (vitest/dev) では dev に落ちる — テストが SHA に依存しない', () => {
    expect(BUILD_SHA).toBe('dev');
  });

  it('meta タグは name=x-build で content に版を持つ', () => {
    expect(BUILD_META_NAME).toBe('x-build');
    expect(buildMetaTag()).toBe('<meta name="x-build" content="dev">');
  });

  it('content は英数字・._- のみに絞られる (HTML 属性への注入を構造的に不能にする)', () => {
    // BUILD_SHA は build 時に外から入る値なので、万一おかしな値でも属性を割らない
    const tag = buildMetaTag();
    const content = tag.match(/content="([^"]*)"/)![1];
    expect(content).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('portal に版マーカーが載る', () => {
  it('head に <meta name="x-build"> がある (post-deploy-check の照合対象)', async () => {
    const html = await renderPortal();
    expect(html).toContain('<meta name="x-build" content="dev">');
    // head 内にあること (body に落ちていない)
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toContain('name="x-build"');
  });

  it('🚨 画面上にも版が出る — スマホでは HTML ソースを見られないため', async () => {
    const html = await renderPortal();
    expect(html).toMatch(/id="app-build"[^>]*>ver dev</);
  });

  it('版表示はアカウントタブの App Info 内にある (顧客の邪魔をしない位置)', async () => {
    const html = await renderPortal();
    const acc = html.slice(html.indexOf('id="section-account"'));
    const appInfoIdx = acc.indexOf('Powered by LINE Harness OSS');
    const buildIdx = acc.indexOf('id="app-build"');
    expect(appInfoIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(appInfoIdx);
  });

  for (const [label, env] of PORTAL_GATE_MATRIX) {
    it(`${label}: 版マーカーが必ず出る (gate に関係なく)`, async () => {
      const html = await renderPortal(env);
      expect(html).toContain('name="x-build"');
      expect(html).toContain('id="app-build"');
    });
  }
});
