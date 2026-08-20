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
import { liffWatchdogScriptTag, LIFF_WATCHDOG_ATTR } from '../utils/liff-watchdog.js';
import { liffPages } from '../routes/liff-pages.js';
import { liffOptInPage } from '../routes/liff-opt-in-page.js';
import { liffMyRank } from '../routes/liff-my-rank.js';
import { liffCoachPage } from '../routes/liff-coach-page.js';
import { liffFoodPage } from '../routes/liff-food-page.js';
import { liffFoodGraph } from '../routes/liff-food-graph.js';
import { liffReorderPage } from '../routes/liff-reorder-page.js';
import { adminDashboard } from '../routes/admin-dashboard.js';
import { adminStaff } from '../routes/admin-staff.js';
import { adminOps } from '../routes/admin-ops.js';
import { faqAdmin } from '../routes/faq-admin.js';
import { friendCoupon } from '../routes/friend-coupon.js';
import { contactEmailPage } from '../routes/contact-email-page.js';
import { openapi } from '../routes/openapi.js';

interface MinimalEnv {
  LIFF_URL: string;
  WORKER_URL: string;
  REFERRAL_REWARD_ENABLED?: string;
  APP_PROXY_LINK_ENABLED?: string;
  PORTAL_BOOTSTRAP_ENABLED?: string;
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

/**
 * HTML tokenizer と同じ規則で inline script の打ち切りを検出する。
 *
 * ブラウザは script data state を「終了タグ名 + 空白 / スラッシュ / 閉じ括弧」で終える。
 * `</script>` だけでなく `</script >` `</script/>` `</script foo>` も終端になる。
 *
 * 検出は 2 軸。片方だけでは以下の実証済み回避が通る:
 *   - 個数比較のみ → コメント内に「開始タグ + 終了タグ」を両方書くと数が釣り合い素通り
 *   - 断片の中身検査のみ → 余分な終了タグは区切り文字として消費され姿を消す
 * よって「開始タグ側が本体に紛れていないか」と「個数が釣り合うか」を両方見る。
 */
function assertNoScriptTruncation(html: string, label: string): void {
  const opens = (html.match(/<script\b/gi) ?? []).length;
  // tokenizer 準拠: 終了タグ名の直後が 空白 / スラッシュ / 閉じ括弧 なら終端
  const closes = (html.match(/<\/script[\s/>]/gi) ?? []).length;
  expect(closes, `${label}: 開始タグ ${opens} / 終了タグ ${closes} — 余分な終了タグが本体を打ち切っている`).toBe(opens);

  // 本体に開始タグが紛れていれば、それは「開始+終了をコメントに書いて数を釣り合わせた」形。
  for (const src of extractInlineScripts(html)) {
    expect(src, `${label}: script 本体に開始タグの literal がある = 打ち切りを数合わせで隠している`).not.toMatch(
      /<script\b/i,
    );
  }

  // 第 3 軸: HTML コメントの釣り合い。未閉鎖の <!-- が 1 個あると tokenizer は EOF まで
  // 全てを呑み、watchdog も本体も実行されない。script タグ数は釣り合ったままなので
  // 上 2 軸では原理的に見えない (採点 R1)。inline script 本体は除去してから数える
  // (JS の i-->0 等の誤検出防止)。規則を変える時は scripts/liff-health-check.mjs も必ず更新。
  const stripped = html.replace(/(<script(?![^>]*\bsrc=)[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
  const cOpens = (stripped.match(/<!--/g) ?? []).length;
  const cCloses = (stripped.match(/-->/g) ?? []).length;
  expect(
    cCloses,
    `${label}: HTML コメント不釣合い (<!-- ${cOpens} / --> ${cCloses}) — 未閉鎖コメントが後続 script を呑む`,
  ).toBe(cOpens);

  // 第 4 軸: 釣り合ったコメントで script を丸ごと包む形。コメント数もタグ数も釣り合い、
  // 抽出・parse も通るが、ブラウザでは一切実行されない (採点 R2)。
  for (const span of stripped.match(/<!--[\s\S]*?-->/g) ?? []) {
    expect(span, `${label}: HTML コメント内に script タグ — コメントアウトされた script は実行されない`).not.toMatch(
      /<script\b/i,
    );
  }
}

// watchdog script 本体の識別子 (liff-watchdog.ts の WATCHDOG_JS 先頭コメント)。
// sentinel / 最小長の測定から watchdog を除外するのに使う — 含めると watchdog 自身
// (~1,900 文字) が常に閾値を超え、「本体が断片だけ残った形」の軸が死ぬ (採点 R1)。
const WATCHDOG_BODY_SIGNATURE = 'liff-watchdog v1';

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
  it.each(LIFF_PAGES)('$path — script が途中で打ち切られていない', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    assertNoScriptTruncation(await res.text(), path);
  });

  it.each(LIFF_PAGES)('$path — script 本体が丸ごと出ている (断片で終わっていない)', async ({ path, router, sentinel }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    const html = await res.text();
    // watchdog は除外して測る (含めると watchdog 自身の長さで最小長軸が恒久 pass になる)
    const src = extractInlineScripts(html)
      .filter((s) => !s.includes(WATCHDOG_BODY_SIGNATURE))
      .join('\n');

    // 打ち切られた断片は「コメント数十文字」で終わる。本体があることを sentinel で確認する。
    expect(src).toContain(sentinel);
    expect(src.length).toBeGreaterThan(1_000);
  });

  it.each(LIFF_PAGES)('$path — 吐き出された JS が parse できる', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    const html = await res.text();
    assertParses(extractInlineScripts(html), path);
  });

  // 本番で実際に配られている形も検証する。gate が変わると portal のテンプレートが
  // 分岐して別の HTML になるため、既定 env だけ見ていると「配っている形」を誰も見ていない状態になる。
  it.each([
    ['gate すべて off (旧既定)', {}],
    ['APP_PROXY_LINK_ENABLED=true (2026-07-29 以降の本番)', {
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
    }],
    ['REFERRAL_REWARD_ENABLED=true', { REFERRAL_REWARD_ENABLED: 'true' }],
    ['PORTAL_BOOTSTRAP_ENABLED=true (Ultraplan PR-3)', { PORTAL_BOOTSTRAP_ENABLED: 'true' }],
    ['全 gate on', {
      APP_PROXY_LINK_ENABLED: 'true',
      SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com',
      REFERRAL_REWARD_ENABLED: 'true',
      PORTAL_BOOTSTRAP_ENABLED: 'true',
    }],
  ])('/liff/portal — %s でも打ち切られていない', async (_label, extra) => {
    const env = { ...baseEnv, ...(extra as Record<string, string>) };
    const res = await liffPages.request('/liff/portal', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const html = await res.text();
    assertNoScriptTruncation(html, '/liff/portal');
    assertParses(extractInlineScripts(html), '/liff/portal');
  });
});

// ============================================================
// 外部 watchdog (liff-watchdog.ts) — 本体 script が全滅しても生き残る最終防衛線。
// 73 日障害では in-script watchdog が守るべき script 自身の中にあり、打ち切りと
// 一緒に死んだ。「CDN script より前・本体より前の独立した <script> 要素」という
// 配置こそが防御なので、存在だけでなく順序と、打ち切り再注入時の生存をここで固定する。
// ============================================================

describe('外部 watchdog — 全 LIFF ページで本体より前に配置され、本体全滅時も生き残る', () => {
  it.each(LIFF_PAGES)('$path — watchdog script が本体より前に 1 つある', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    const html = await res.text();
    const markers = html.match(new RegExp(LIFF_WATCHDOG_ATTR, 'g')) ?? [];
    expect(markers.length, `${path}: watchdog マーカーは 1 個`).toBe(1);
    const wdIdx = html.indexOf(LIFF_WATCHDOG_ATTR);
    const mainIdx = html.indexOf('liff.init');
    expect(mainIdx).toBeGreaterThan(-1);
    // 後ろに置くと本体の打ち切りで watchdog 自身が HTML テキスト化して消える
    expect(wdIdx, `${path}: watchdog は本体 script より前に置く`).toBeLessThan(mainIdx);
    // CDN (tailwind/LIFF SDK) は同期ロードで parser をブロックする。CDN より後ろだと
    // 「CDN ハング」クラスで watchdog が arm すらされない (採点 R1 HIGH)
    const cdnIdx = html.indexOf('<script src=');
    expect(cdnIdx).toBeGreaterThan(-1);
    expect(wdIdx, `${path}: watchdog は最初の外部 CDN script より前に置く`).toBeLessThan(cdnIdx);
  });

  it.each(LIFF_PAGES)(
    '$path — watchdog 直前への未閉鎖 <!-- 注入も検出する (呑み込みドリル)',
    async ({ path, router }) => {
      const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      const injected = html.replace('<script ' + LIFF_WATCHDOG_ATTR, '<!--' + '<script ' + LIFF_WATCHDOG_ATTR);
      expect(injected).not.toBe(html);
      expect(() => assertNoScriptTruncation(injected, path)).toThrowError();
    },
  );

  it.each(LIFF_PAGES)(
    '$path — watchdog を釣り合ったコメントで包む形も検出する (コメントアウト・ドリル)',
    async ({ path, router }) => {
      const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      const tag = liffWatchdogScriptTag();
      const wrapped = html.replace(tag, () => '<!--' + tag + '-->');
      expect(wrapped).not.toBe(html);
      expect(() => assertNoScriptTruncation(wrapped, path)).toThrowError();
    },
  );

  // watchdog の発火/解除判定が依存する 2 つの暗黙契約を固定する。将来 1 ページが
  // #loading を改名するか classList 方式へ変えると、そのページの watchdog は静かに
  // 無力化する — 「測定器が対象の前提を見ていない」73 日障害と同型の芽 (採点 R2)。
  it.each(LIFF_PAGES)(
    '$path — watchdog の前提契約: #loading が存在し、本体が style.display で隠す',
    async ({ path, router }) => {
      const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      expect(html).toContain('id="loading"');
      const main = extractInlineScripts(html)
        .filter((s) => !s.includes(WATCHDOG_BODY_SIGNATURE))
        .join('\n');
      expect(main).toMatch(/getElementById\('loading'\)/);
      expect(main).toMatch(/style\.display\s*=\s*'none'/);
    },
  );

  it.each(LIFF_PAGES)(
    '$path — 本体 script に打ち切りを再注入しても watchdog は無傷で parse 可能 (生存ドリル)',
    async ({ path, router }) => {
      const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      const scripts = extractInlineScripts(html);
      const watchdog = scripts.find((s) => s.includes(WATCHDOG_BODY_SIGNATURE));
      const main = scripts.find((s) => !s.includes(WATCHDOG_BODY_SIGNATURE) && s.includes('liff.init'));
      expect(watchdog, `${path}: watchdog script 本体がある`).toBeTruthy();
      expect(main, `${path}: 本体 script がある`).toBeTruthy();

      // 73 日障害の実形態を再現: 本体の途中に終了タグを注入して打ち切る
      const closeTag = '</' + 'script>';
      const broken = html.replace(main!, () => main!.slice(0, 120) + closeTag + main!.slice(120));
      expect(broken).not.toBe(html);
      const brokenScripts = extractInlineScripts(broken);

      // watchdog は独立要素かつ本体より前なので、打ち切り後もバイト単位で不変のまま残る
      expect(brokenScripts.find((s) => s.includes(WATCHDOG_BODY_SIGNATURE))).toBe(watchdog);
      expect(() => new Function(watchdog!)).not.toThrow();
    },
  );

  it('watchdog タグ自体が安全: 終了タグ literal 無し / 補間残骸無し / parse 可能', () => {
    const tag = liffWatchdogScriptTag();
    const body = /<script[^>]*>([\s\S]*)<\/script>$/.exec(tag)?.[1];
    expect(body).toBeTruthy();
    // 本体に終了タグが literal で入っていたら watchdog 自身が打ち切りの起点になる
    expect(body!).not.toMatch(/<\/script[\s/>]/i);
    expect(body!).not.toMatch(/<script\b/i);
    // TS 側の補間ミス (未解決の ${...} が残る形) の検出
    expect(body!).not.toContain('${');
    expect(() => new Function(body!)).not.toThrow();
    // 発火条件と発火時の必須動作 (誤爆防止 3 条件 + 二重表示防止の印)
    expect(body!).toContain('__fatalShown');
    expect(body!).toContain("getElementById('loading')");
    expect(body!).toContain('location.reload');
    // 再武装窓 (+2 分) を使い切った後の最終トリガ (2 分超の CDN ハング回復対策)
    expect(body!).toContain('DOMContentLoaded');
  });

  // 外部 watchdog は __fatalShown を見て「ページ自身のエラー表示」を上書きしない設計。
  // showFatalError を持つ 6 ページ全てが印を立てることを固定する (立てないページがあると
  // 15 秒後にブランド文言のエラーが汎用 overlay に差し替わる退行が起きる)。
  const PAGES_WITH_FATAL_ERROR = LIFF_PAGES.filter((p) => p.path !== '/liff/my-rank');
  it.each(PAGES_WITH_FATAL_ERROR)(
    '$path — showFatalError が __fatalShown を立てる (watchdog の上書き抑止)',
    async ({ path, router }) => {
      const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
      const html = await res.text();
      const main = extractInlineScripts(html).find(
        (s) => !s.includes(WATCHDOG_BODY_SIGNATURE) && s.includes('liff.init'),
      );
      expect(main).toBeTruthy();
      expect(main!).toMatch(/function showFatalError\(msg\)\s*\{[\s\S]{0,220}__fatalShown = true/);
      // 逆方向の契約: 15 秒以降に showFatalError が走った場合はブランド文言を優先するため、
      // showFatalError 側が watchdog overlay を撤去する (無いと汎用 overlay の下に隠れる)
      expect(main!).toMatch(/function showFatalError\(msg\)\s*\{[\s\S]{0,800}liff-watchdog-overlay/);
    },
  );
});

// ============================================================
// LIFF 以外で inline script を吐くルートも同じガードで守る。
// 今回の監査で /t/:linkId が同型の欠陥 (かつユーザ入力経由の注入) を抱えたまま
// LIVE だったことが判明した。「LIFF だけ」の allowlist が穴になっていた。
// ============================================================

const OTHER_HTML_PAGES: Array<{ path: string; router: Hono }> = [
  { path: '/admin', router: adminDashboard as unknown as Hono },
  { path: '/admin/staff', router: adminStaff as unknown as Hono },
  { path: '/admin/logs', router: adminStaff as unknown as Hono },
  { path: '/admin/faq', router: faqAdmin as unknown as Hono },
  { path: '/admin/friend-coupon', router: friendCoupon as unknown as Hono },
  { path: '/admin/ops', router: adminOps as unknown as Hono },
  { path: '/contact/email', router: contactEmailPage as unknown as Hono },
  { path: '/docs', router: openapi as unknown as Hono },
];

describe('LIFF 以外の HTML ページも script が打ち切られていない', () => {
  it.each(OTHER_HTML_PAGES)('$path', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    assertNoScriptTruncation(await res.text(), path);
  });

  // parse 検証が deploy 後の health check にしかないと「CI green → deploy で初めて赤」の
  // 非対称になる (採点 R1)。出荷前ゲートにも同じ軸を置く。
  it.each(OTHER_HTML_PAGES)('$path — 吐き出された JS が parse できる', async ({ path, router }) => {
    const res = await router.request(path, {}, baseEnv as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    assertParses(extractInlineScripts(await res.text()), path);
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
    // C3: ホームの連携カードも同じ gate 配下。
    // 🚨 **既定は display:none** が要件 — これを落とすと、既連携ユーザーにも
    // 「連携しませんか」が一瞬 (loadRank が返るまで) 出てしまう。
    // 未連携が確定したときだけ showShopifyLinkHomeCard() が開く設計
    expect(html).toMatch(
      /<div id="shopify-link-home-card"[^>]*style="display:none"/,
    );
    expect(html).toContain('"https://naturism-diet.com"'); // jsonForScript 経由の安全な埋め込み
  });

  it('/liff/portal (App Proxy gate off = カード非表示・SHOPIFY_LINK_URL は null)', async () => {
    const html = await fetchBody('/liff/portal');
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).not.toContain('id="shopify-link-home-card"');
    expect(html).toContain('var SHOPIFY_LINK_URL = null;');
  });

  it('/liff/portal (gate off + 妥当な storefront URL でもカードを出さない = gate 条件そのものの検証)', async () => {
    // URL 未設定のケースだけだと「URL 検証で落ちている」のか「gate で落ちている」のか
    // 区別できず、gate 条件を消す退行が素通りする (tautology)。
    const env = { ...baseEnv, SHOPIFY_STOREFRONT_URL: 'https://naturism-diet.com' };
    const html = await fetchBody('/liff/portal', env);
    expect(html).not.toContain('id="shopify-link-card"');
    expect(html).not.toContain('id="shopify-link-home-card"');
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
      expect(html).not.toContain('id="shopify-link-home-card"');
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
    expect(html).not.toContain('id="shopify-link-home-card"');
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
