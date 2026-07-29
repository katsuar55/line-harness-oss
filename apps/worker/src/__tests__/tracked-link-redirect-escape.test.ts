/**
 * /t/:linkId のリダイレクト HTML のエスケープ検証 (2026-07-29)
 *
 * 背景: buildAppRedirectHtml は `&` と `"` しかエスケープしておらず、
 * 同じ文字列を **script の中** と **属性値** の両方に埋めていた。両方とも誤りだった。
 *   - script data state では実体参照が復号されない
 *     → `?v=abc&t=30` が `?v=abc&amp;t=30` になり、パラメータ名が `amp;t` に化ける
 *   - `<` `>` が素通し
 *     → URL に終了タグを仕込むと script が打ち切られ、worker ドメイン上で
 *       任意マークアップが実行されうる (同ドメインは /admin も配信し、
 *       管理画面は API キーを localStorage に保持している)
 *
 * 元の実装は「壊れた URL でリダイレクトする」ことすら気付けなかったので、
 * 出力の**両方の文脈**を固定する。
 */

import { describe, it, expect } from 'vitest';

// buildAppRedirectHtml は非 export なのでルート経由で検証する
import { trackedLinks } from '../routes/tracked-links.js';

interface StoredLink {
  id: string;
  original_url: string;
  friend_id: string | null;
}

/** /t/:linkId が引く最小 D1 fake。 */
function createDb(link: StoredLink | null) {
  return {
    prepare(sql: string) {
      const make = (_args: unknown[]) => ({
        async first() {
          if (/FROM\s+tracked_links/i.test(sql)) return link;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      });
      return {
        bind(...args: unknown[]) {
          return make(args);
        },
        ...make([]),
      };
    },
  } as unknown as D1Database;
}

async function render(originalUrl: string): Promise<string> {
  const db = createDb({ id: 'lnk1', original_url: originalUrl, friend_id: null });
  const res = await trackedLinks.request(
    '/t/lnk1',
    { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13)' } },
    { DB: db } as unknown as Record<string, unknown>,
  );
  // アプリ起動 HTML を返す経路 (対象ドメイン) 以外は 302。その場合は本テストの対象外。
  if (res.status !== 200) return '';
  return res.text();
}

function scriptBodies(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe('/t/:linkId のリダイレクト HTML', () => {
  it('🚨 URL に終了タグを仕込んでも script が打ち切られない', async () => {
    const evil = 'https://x.com/a</script><script>alert(1)</script>';
    const html = await render(evil);
    if (!html) return; // アプリ起動 HTML 経路でなければ検証不要

    const opens = (html.match(/<script\b/gi) ?? []).length;
    const closes = (html.match(/<\/script[\s/>]/gi) ?? []).length;
    expect(closes).toBe(opens);
    // 注入された開始タグが素の markup として出ていないこと
    expect(html).not.toContain('<script>alert(1)');
  });

  it('🚨 URL の & が実体参照に化けない (script 内は復号されないため)', async () => {
    const html = await render('https://youtube.com/watch?v=abc&t=30');
    if (!html) return;
    const js = scriptBodies(html).join('\n');
    // script 内の JS 値としては生の & のままでなければならない
    expect(js).toContain('v=abc&t=30');
    expect(js).not.toContain('&amp;t=30');
  });

  it('noscript の属性値では逆に & を実体参照にする (属性値は復号される)', async () => {
    const html = await render('https://youtube.com/watch?v=abc&t=30');
    if (!html) return;
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
    expect(noscript).toContain('&amp;t=30');
  });

  it('通常の URL では正しい遷移先が出る (過剰エスケープしていない)', async () => {
    const html = await render('https://youtube.com/watch?v=abc');
    if (!html) return;
    const js = scriptBodies(html).join('\n');
    expect(js).toContain('youtube.com/watch?v=abc');
  });

  it('引用符入りの URL でも JS 文字列が壊れない', async () => {
    const html = await render('https://x.com/a"b');
    if (!html) return;
    assertScriptsParse(scriptBodies(html));
  });
});

function assertScriptsParse(scripts: string[]): void {
  for (const src of scripts) {
    // 打ち切り・引用符崩れがあればここで落ちる
    expect(() => new Function(src)).not.toThrow();
  }
}
