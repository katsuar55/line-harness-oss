/**
 * Tests for /liff/portal のリッチメニュー deep-link 配線 (= マイランク導線, 2026-06-03)。
 *
 * 背景: LIFF endpoint URL は /liff/portal。リッチメニュー「マイランク」ボタンは
 *   `${LIFF_URL}#rank` (= ハッシュ) を開くため、必ずポータル経由になる。
 *   新・会員証ページ /liff/my-rank (trailing-12mo ランク) を canonical entry にするため、
 *   ポータルは liff.init 後・重い data load 前に #rank を検知して /liff/my-rank へ集約 redirect する。
 *
 * inline HTML page なので、レンダリング結果に配線ロジックが含まれることを検証 (regression guard)。
 */

import { describe, it, expect } from 'vitest';
import { liffPages } from '../routes/liff-pages.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
}

const baseEnv: MinimalEnv = {
  LIFF_URL: 'https://liff.line.me/2000000000-abcd1234',
  WORKER_URL: 'https://example.workers.dev',
};

async function fetchPage(path: string, env: MinimalEnv = baseEnv): Promise<{ status: number; body: string }> {
  const res = await liffPages.request(path, {}, env as unknown as Record<string, unknown>);
  return { status: res.status, body: await res.text() };
}

describe('GET /liff/portal — マイランク deep-link 配線', () => {
  it('200 を返し、ポータル SPA がレンダリングされる', async () => {
    const r = await fetchPage('/liff/portal');
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/<title>naturism 公式ポータル/);
    expect(r.body).toMatch(/static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
  });

  it('末尾スラッシュも 200', async () => {
    const r = await fetchPage('/liff/portal/');
    expect(r.status).toBe(200);
  });

  it('リッチメニュー #rank 導線: 新・会員証ページ /liff/my-rank へ redirect する', async () => {
    const r = await fetchPage('/liff/portal');
    expect(r.body).toContain("location.hash === '#rank'");
    expect(r.body).toMatch(/location\.replace\('\/liff\/my-rank'\)/);
  });

  it('redirect は重い data load (Promise.all) より前に配置される (flash/二重ロード防止)', async () => {
    const r = await fetchPage('/liff/portal');
    const idxRedirect = r.body.indexOf("location.replace('/liff/my-rank')");
    const idxHeavyLoad = r.body.indexOf('Promise.all([loadLanguage');
    expect(idxRedirect).toBeGreaterThan(-1);
    expect(idxHeavyLoad).toBeGreaterThan(-1);
    expect(idxRedirect).toBeLessThan(idxHeavyLoad);
  });

  it('redirect は liff.init / ログインガードより後に配置される (LIFF context 確立後)', async () => {
    const r = await fetchPage('/liff/portal');
    const idxInit = r.body.indexOf('await liff.init(');
    const idxRedirect = r.body.indexOf("location.replace('/liff/my-rank')");
    expect(idxInit).toBeGreaterThan(-1);
    expect(idxRedirect).toBeGreaterThan(idxInit);
  });

  it('demo モード (?demo=1) では redirect しない (guard)', async () => {
    const r = await fetchPage('/liff/portal');
    expect(r.body).toContain("get('demo') !== '1'");
  });

  it('テンプレートリテラル汚染がないこと: 未展開の ${ が body に残らない', async () => {
    const r = await fetchPage('/liff/portal');
    // サーバ側 template literal の誤展開 (feedback_template_literal_backtick_trap) を検出。
    // 注入された LIFF_ID/API_BASE は正しく展開されるため、生の "${" は残らないはず。
    expect(r.body).not.toContain('${');
  });
});

// ─── deep-link 台帳 (Ultraplan PR-6): DEEP_LINK_TAB_MAP が単一の正 ───
// リッチメニュー・openLiffPage・bootstrapPortal の早期 reveal 判定が全て同じ写像を参照する。
// 台帳の行が消える/写像先が変わる事故は顧客導線の無言の断線になるため、内容ごと固定する。

describe('deep-link 台帳 (DEEP_LINK_TAB_MAP)', () => {
  it('台帳が単一定義で、handleDeepLink と deepLinkDest の両方が参照する', async () => {
    const r = await fetchPage('/liff/portal');
    expect((r.body.match(/var DEEP_LINK_TAB_MAP = \{/g) ?? []).length).toBe(1);
    expect(r.body).toMatch(/function handleDeepLink\(\) \{[\s\S]{0,400}DEEP_LINK_TAB_MAP\[hash\]/);
    expect(r.body).toMatch(/function deepLinkDest\(\) \{[\s\S]{0,300}DEEP_LINK_TAB_MAP\[hash\]/);
    // 台帳外の重複写像 (旧 tabMap の復活) を許さない
    expect(r.body).not.toContain('var tabMap =');
  });

  it('台帳の写像が全行そのまま存在する (リッチメニュー/openLiffPage の既存契約)', async () => {
    const r = await fetchPage('/liff/portal');
    const m = /var DEEP_LINK_TAB_MAP = \{([^}]*)\}/.exec(r.body);
    expect(m).toBeTruthy();
    const ledger = m![1];
    const EXPECTED: Array<[string, string]> = [
      ['shop', 'shop'],
      ['store', 'shop'],
      ['home', 'home'],
      ['mypage', 'home'],
      ['rank', 'home'],
      ['referral', 'home'],
      ['quiz', 'quiz'],
      ['intake', 'intake'],
      ['health', 'intake'],
      ['delivery', 'shop'],
      ['reorder', 'shop'],
      ['more', 'account'],
      ['account', 'account'],
      ['settings', 'account'],
    ];
    for (const [key, tab] of EXPECTED) {
      expect(ledger, key + ' → ' + tab + ' の行が台帳から消えている').toMatch(
        new RegExp(key + ":\\s*'" + tab + "'"),
      );
    }
    // 行数も固定 (増えるときは台帳とこのテストを同時に更新する = 台帳が正である契約)
    expect((ledger.match(/:/g) ?? []).length).toBe(EXPECTED.length);
  });
});
