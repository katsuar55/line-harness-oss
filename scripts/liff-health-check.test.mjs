/**
 * Tests for scripts/liff-health-check.mjs
 *
 * node:test (built-in) で動作。pnpm liff-health:test で実行。
 *
 * CLAUDE.md「ガードを足したら、バグを再注入して実際に落ちることを確認したか?」に従い、
 * 73 日障害 (script 打ち切り) の実形態 3 種 + 回避 2 種を再注入して全て検出できることを固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_PAGES,
  WATCHDOG_MARKER,
  WATCHDOG_BODY_SIGNATURE,
  extractInlineScripts,
  findTruncationProblems,
  findParseProblems,
  checkPageHealth,
  runLiffHealth,
  hasNoStoreDirective,
  healthExitCode,
} from './liff-health-check.mjs';

// ─────────────────────────────────────
// フィクスチャ (打ち切りが起きていない健全ページ)
// ─────────────────────────────────────

// watchdog は**実寸相当** (>1,000 文字) にする。短いスタブだと「watchdog 自身の長さが
// 最小長軸を tautology 化する」退行をテストが検出できない (採点 R1 で実際に起きた)。
const WATCHDOG_TAG =
  '<script data-liff-watchdog="v1">/* ' +
  WATCHDOG_BODY_SIGNATURE +
  ' */(function(){' +
  'var pad;'.repeat(200) +
  'setTimeout(function(){},15000);})();</script>';

// 本体 script: sentinel (liff.init) を含み、最小長 1,000 文字を超える
const MAIN_BODY = 'var pad = 1;\n'.repeat(100) + 'liff.init({ liffId: "x" });\n';
const MAIN_TAG = '<script>\n' + MAIN_BODY + '</script>';

const LIFF_PAGE_DEF = { path: '/liff/portal', sentinel: 'liff.init', watchdog: true };
const ADMIN_PAGE_DEF = { path: '/admin', sentinel: null, watchdog: false };

function buildPage({ watchdog = WATCHDOG_TAG, main = MAIN_TAG, extraHead = '' } = {}) {
  // 実ページと同じ配置: watchdog は <head> の最初の外部 script より前 (CDN ハングで arm されない配置の回避)
  return (
    '<!DOCTYPE html><html><head>' +
    watchdog +
    '<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>' +
    extraHead +
    '</head><body><div id="loading"></div>' +
    main +
    '</body></html>'
  );
}

// ─────────────────────────────────────
// extractInlineScripts
// ─────────────────────────────────────

test('extractInlineScripts: src 付き外部 script を除外し inline のみ返す', () => {
  const scripts = extractInlineScripts(buildPage());
  assert.equal(scripts.length, 2); // watchdog + main
  assert.match(scripts[0], /setTimeout/);
  assert.match(scripts[1], /liff\.init/);
});

// ─────────────────────────────────────
// 打ち切り検出 — 実形態の再注入ドリル
// ─────────────────────────────────────

// 73 日障害の実形態: 本体 script の途中に終了タグが literal で紛れる。
// tokenizer は「終了タグ名 + 空白 / スラッシュ / 閉じ括弧」を全て終端として扱う。
const CLOSE_FORMS = ['</' + 'script>', '</' + 'script >', '</' + 'script/>', '</' + 'script foo>'];

for (const form of CLOSE_FORMS) {
  test(`findTruncationProblems: 本体への「${form}」再注入を検出する`, () => {
    const broken = buildPage({
      main: '<script>\n' + MAIN_BODY.slice(0, 200) + form + MAIN_BODY.slice(200) + '</script>',
    });
    const problems = findTruncationProblems(broken);
    assert.ok(problems.length > 0, `再注入 ${form} が素通りした`);
  });
}

test('findTruncationProblems: 開始+終了をコメントに書いて数を釣り合わせる回避も検出する', () => {
  // 個数比較だけだと釣り合って素通りする形 (liff-script-syntax.test.ts の監査で実証済みの回避)
  const trick = '/* <' + 'script>x</' + 'script> */';
  const broken = buildPage({
    main: '<script>\n' + MAIN_BODY.slice(0, 200) + trick + MAIN_BODY.slice(200) + '</script>',
  });
  const problems = findTruncationProblems(broken);
  assert.ok(problems.length > 0, '数合わせ回避が素通りした');
});

test('findTruncationProblems: 健全ページでは空 (釣り合った HTML コメントは許容)', () => {
  assert.deepEqual(findTruncationProblems(buildPage({ extraHead: '<!-- legit comment -->' })), []);
});

test('findTruncationProblems: watchdog 直前への未閉鎖 <!-- 注入を検出する (呑み込みドリル)', () => {
  // 未閉鎖コメントは EOF まで全てを呑み、watchdog も本体も実行されない。
  // script タグ数は釣り合ったままなので既存 2 軸では原理的に見えない (採点 R1)。
  const page = buildPage();
  const broken = page.replace('<script data-liff-watchdog', '<!--<script data-liff-watchdog');
  assert.notEqual(broken, page);
  const problems = findTruncationProblems(broken);
  assert.ok(problems.some((p) => p.includes('コメント不釣合い')), String(problems));
});

test('findTruncationProblems: inline script 内の --> (i-->0 等) はコメント軸で誤検出しない', () => {
  const page = buildPage({ main: '<script>\n' + 'var pad = 1;\n'.repeat(100) + 'var i = 3; while (i-->0) {}\nliff.init({});\n</script>' });
  assert.deepEqual(findTruncationProblems(page), []);
});

// ─────────────────────────────────────
// parse 検証
// ─────────────────────────────────────

test('findParseProblems: SyntaxError を script 番号つきで報告する (#193 の \\\' 事故クラス)', () => {
  const broken = buildPage({ main: '<script>var a = \';\nliff.init({});</script>' });
  const problems = findParseProblems(broken);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /#2/);
  assert.match(problems[0], /SyntaxError/i);
});

test('findParseProblems: inline script ゼロは fail (HTML 全損の形)', () => {
  assert.ok(findParseProblems('<html><body>maintenance</body></html>').length > 0);
});

test('findParseProblems: 健全ページでは空', () => {
  assert.deepEqual(findParseProblems(buildPage()), []);
});

// ─────────────────────────────────────
// checkPageHealth (統合判定)
// ─────────────────────────────────────

test('checkPageHealth: 健全な LIFF ページは問題ゼロ', () => {
  assert.deepEqual(checkPageHealth(buildPage(), LIFF_PAGE_DEF), []);
});

test('checkPageHealth: 本体が丸ごと消えた形 (sentinel 不在) を検出する — 73 日障害の見え方そのもの', () => {
  // 打ち切り後に本番が実際に配っていたのは「コメント数十文字だけの script」
  const broken = buildPage({ main: '<script>/* 43 文字のコメント断片だけが残る */</script>' });
  const problems = checkPageHealth(broken, LIFF_PAGE_DEF);
  assert.ok(problems.some((p) => p.includes('sentinel')), String(problems));
});

test('checkPageHealth: sentinel はあるが最小長未満 (断片) を検出する — 実寸 watchdog が居ても軸が生きている', () => {
  // watchdog (実寸 >1,000 文字) を合算すると閾値を常に超えて軸が死ぬ。
  // 除外して測ることをこのテストが固定する (フィクスチャが実寸であることが前提条件)。
  assert.ok(WATCHDOG_TAG.length > 1_000, 'フィクスチャの watchdog が実寸でない — このテスト自体が無意味になる');
  const broken = buildPage({ main: '<script>liff.init({});</script>' });
  const problems = checkPageHealth(broken, LIFF_PAGE_DEF);
  assert.ok(problems.some((p) => p.includes('文字')), String(problems));
});

test('checkPageHealth: watchdog 不在を検出する', () => {
  const broken = buildPage({ watchdog: '' });
  const problems = checkPageHealth(broken, LIFF_PAGE_DEF);
  assert.ok(problems.some((p) => p.includes('watchdog')), String(problems));
});

test('checkPageHealth: watchdog が本体より後ろ (巻き添え配置) を検出する', () => {
  const broken = buildPage({ watchdog: '', main: MAIN_TAG + WATCHDOG_TAG });
  const problems = checkPageHealth(broken, LIFF_PAGE_DEF);
  assert.ok(problems.some((p) => p.includes('後ろ')), String(problems));
});

test('checkPageHealth: watchdog が CDN script より後ろ (arm されない配置) を検出する', () => {
  // head 内だが外部 script の後ろ = CDN ハング時に parser がそこまで到達しない
  const broken = buildPage({ watchdog: '', extraHead: WATCHDOG_TAG });
  const problems = checkPageHealth(broken, LIFF_PAGE_DEF);
  assert.ok(problems.some((p) => p.includes('arm されない')), String(problems));
});

test('findTruncationProblems: 釣り合ったコメントで script を包む形も検出する (コメントアウト・ドリル)', () => {
  // コメント数もタグ数も釣り合い、抽出・parse も通るが、ブラウザでは一切実行されない形
  const broken = buildPage({ watchdog: '<!--' + WATCHDOG_TAG + '-->' });
  const problems = findTruncationProblems(broken);
  assert.ok(problems.some((p) => p.includes('コメント内に script')), String(problems));
});

test('checkPageHealth: admin ページは watchdog / sentinel を要求しない', () => {
  const adminPage = buildPage({ watchdog: '', main: '<script>var adminApp = 1;</script>' });
  assert.deepEqual(checkPageHealth(adminPage, ADMIN_PAGE_DEF), []);
});

test('checkPageHealth: 空 HTML は fail (fail-closed)', () => {
  assert.ok(checkPageHealth('', LIFF_PAGE_DEF).length > 0);
});

// ─────────────────────────────────────
// runLiffHealth (ランナー)
// ─────────────────────────────────────

const FAST = { maxAttemptsPerPage: 2, retryDelayMs: 0, fetchTimeoutMs: 1_000 };

test('runLiffHealth: 全ページ健全なら ok=true、対象 URL は workerUrl + path', async () => {
  const fetched = [];
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF, ADMIN_PAGE_DEF],
    fetchHtml: async (url) => {
      fetched.push(url);
      return url.includes('/admin') ? buildPage({ watchdog: '' }) : buildPage();
    },
    ...FAST,
  });
  assert.equal(health.ok, true);
  assert.deepEqual(fetched, [
    'https://example.workers.dev/liff/portal',
    'https://example.workers.dev/admin',
  ]);
});

test('runLiffHealth: 1 ページでも打ち切られていれば ok=false でパスを特定できる', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF, ADMIN_PAGE_DEF],
    fetchHtml: async (url) =>
      url.includes('/liff/portal')
        ? buildPage({ main: '<script>/* 断片 */</script>' })
        : buildPage({ watchdog: '' }),
    ...FAST,
  });
  assert.equal(health.ok, false);
  const bad = health.results.find((r) => r.path === '/liff/portal');
  assert.ok(bad.problems.length > 0);
  const good = health.results.find((r) => r.path === '/admin');
  assert.equal(good.problems.length, 0);
});

test('runLiffHealth: ネットワーク例外の全滅は fail-closed (確認不能扱い) + リトライする', async () => {
  let calls = 0;
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF],
    fetchHtml: async () => {
      calls++;
      throw new Error('fetch failed: ENOTFOUND example.workers.dev');
    },
    ...FAST,
  });
  assert.equal(health.ok, false);
  assert.equal(calls, 2); // maxAttemptsPerPage
  assert.match(health.results[0].problems[0], /fetch 失敗/);
  assert.equal(health.results[0].fetchFailed, true);
});

test('runLiffHealth: HTTP 5xx はページ自体が落ちている「実測」= 確認不能でなく exit 1 系に分類', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF],
    fetchHtml: async () => {
      throw new Error('HTTP 500');
    },
    ...FAST,
  });
  assert.equal(health.ok, false);
  assert.equal(health.results[0].fetchFailed, false);
  assert.match(health.results[0].problems[0], /HTTP エラー応答/);
  assert.equal(healthExitCode(health), 1);
});

// ─────────────────────────────────────
// exit code 意味論 (0=healthy / 1=不健全を実測 / 2=確認不能)
// ─────────────────────────────────────

test('healthExitCode: healthy=0 / 実測の不健全=1 / fetch 全滅のみ=2', () => {
  assert.equal(healthExitCode({ ok: true, results: [] }), 0);
  assert.equal(
    healthExitCode({ ok: false, results: [{ path: '/x', problems: ['打ち切り'], fetchFailed: false }] }),
    1,
  );
  assert.equal(
    healthExitCode({
      ok: false,
      results: [{ path: '/x', problems: ['fetch 失敗: ENOTFOUND example.workers.dev'], fetchFailed: true }],
    }),
    2,
  );
  // 混在は「不健全の実測あり」を優先して 1
  assert.equal(
    healthExitCode({
      ok: false,
      results: [
        { path: '/x', problems: ['fetch 失敗: ENOTFOUND example.workers.dev'], fetchFailed: true },
        { path: '/y', problems: ['打ち切り'], fetchFailed: false },
      ],
    }),
    1,
  );
});

test('runLiffHealth: 1 回目失敗 → 2 回目成功なら healthy (deploy 直後の瞬断対策)', async () => {
  let calls = 0;
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF],
    fetchHtml: async () => {
      calls++;
      if (calls === 1) throw new Error('HTTP 503');
      return buildPage();
    },
    ...FAST,
  });
  assert.equal(health.ok, true);
});

test('runLiffHealth: 1 回目「不健全」→ 2 回目健全なら healthy (旧コード propagation 遅延の誤警報対策)', async () => {
  // deploy 直後は edge がまだ旧 worker を配ることがある (c6a54d7 初回デプロイで実発生:
  // watchdog 配備直後の検証が「マーカー 0 個」を観測して赤になった)。
  // fetch 成功でも不健全なら残り試行でリトライすることを固定する。
  let calls = 0;
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF],
    fetchHtml: async () => {
      calls++;
      return calls === 1 ? buildPage({ watchdog: '' }) : buildPage();
    },
    ...FAST,
  });
  assert.equal(calls, 2);
  assert.equal(health.ok, true);
});

test('runLiffHealth: 全試行で不健全のままなら fail-closed を維持', async () => {
  let calls = 0;
  const health = await runLiffHealth({
    workerUrl: 'https://example.workers.dev',
    pages: [LIFF_PAGE_DEF],
    fetchHtml: async () => {
      calls++;
      return buildPage({ watchdog: '' });
    },
    ...FAST,
  });
  assert.equal(calls, 2); // maxAttemptsPerPage を使い切る
  assert.equal(health.ok, false);
});

// ─────────────────────────────────────
// 台帳の整合
// ─────────────────────────────────────

test('HEALTH_PAGES: LIFF 7 + 管理 6 + contact/docs 2 の 15 件で、LIFF は全て watchdog 必須', () => {
  // #238 で /admin/ops (§10-3 受理台帳) を追加 → 管理 5 → 6
  assert.equal(HEALTH_PAGES.length, 15);
  const liff = HEALTH_PAGES.filter((p) => p.path.startsWith('/liff/'));
  assert.equal(liff.length, 7);
  assert.ok(liff.every((p) => p.watchdog && p.sentinel === 'liff.init'));
});

test('WATCHDOG_MARKER / 本体シグネチャが liff-watchdog.ts と一致している (drift 検出)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../apps/worker/src/utils/liff-watchdog.ts', import.meta.url), 'utf8');
  // 属性名は「定数定義そのもの」を抽出して等値比較する (含まれるだけの弱い検査だと
  // 名前変更 + 旧名がコメントに残る形の drift を素通りする)
  const attr = /export const LIFF_WATCHDOG_ATTR = '([^']+)'/.exec(src)?.[1];
  assert.equal(attr, WATCHDOG_MARKER, 'liff-watchdog.ts の LIFF_WATCHDOG_ATTR と WATCHDOG_MARKER が drift');
  assert.ok(
    src.includes(WATCHDOG_BODY_SIGNATURE),
    `liff-watchdog.ts に本体シグネチャ「${WATCHDOG_BODY_SIGNATURE}」が無い — 除外フィルタが効かなくなる drift`,
  );
});

// ─── 配信物の鮮度ガード (2026-08-23) ───────────────────────────────────
// #271 で LIFF HTML に no-store を付けたが、コード側テストは「これから出荷する形」しか守らない。
// 本番が今この瞬間に何を返しているかは、この health check だけが見ている。
const FRESH_PAGE_DEF = { path: '/liff/portal', sentinel: 'liff.init', watchdog: true, requireNoStore: true };

test('Cache-Control: no-store があれば healthy', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [FRESH_PAGE_DEF],
    fetchHtml: async () => ({
      html: buildPage(),
      headers: new Headers({ 'cache-control': 'no-store, no-cache, must-revalidate' }),
    }),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, true, JSON.stringify(health.results));
});

test('🚨 Cache-Control が無い本番を unhealthy として実測する (#271 の事故そのもの)', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [FRESH_PAGE_DEF],
    fetchHtml: async () => ({ html: buildPage(), headers: new Headers() }),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, false);
  assert.match(health.results[0].problems.join(' | '), /no-store/);
  // 「ページ自体は落ちていないが実機に届かない」= rollback 検討対象の実測 (exit 1)
  assert.equal(healthExitCode(health), 1);
});

test('no-store 以外のキャッシュ指定 (max-age 等) も unhealthy', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [FRESH_PAGE_DEF],
    fetchHtml: async () => ({
      html: buildPage(),
      headers: new Headers({ 'cache-control': 'public, max-age=3600' }),
    }),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, false);
  assert.match(health.results[0].problems.join(' | '), /no-store/);
});

test('🚨 fail-closed: ヘッダを取得できない fetch 実装は「検証不能」として unhealthy', async () => {
  // 「string を返す旧実装」= ヘッダを落とした形。ここを静かに成功にすると
  // 鮮度ガードが恒久的に発火不能になる (73 日障害と同じ壊れ方)
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [FRESH_PAGE_DEF],
    fetchHtml: async () => buildPage(),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, false);
  assert.match(health.results[0].problems.join(' | '), /検証できなかった/);
});

test('requireNoStore を持たないページ定義はヘッダを要求しない (段階導入の余地)', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [{ path: '/x', sentinel: null, watchdog: false }],
    fetchHtml: async () => buildPage(),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, true, JSON.stringify(health.results));
});

test('本番台帳 HEALTH_PAGES の全ページが requireNoStore を持つ (付け忘れ検出)', () => {
  const missing = HEALTH_PAGES.filter((p) => p.requireNoStore !== true).map((p) => p.path);
  assert.deepEqual(missing, [], '鮮度ガードが外れているページ: ' + missing.join(', '));
});

test('🚨 no-store は「ディレクティブ」として照合する — 部分一致で偽 healthy にしない (Codex P2)', () => {
  // 本物
  assert.equal(hasNoStoreDirective('no-store'), true);
  assert.equal(hasNoStoreDirective('no-store, no-cache, must-revalidate'), true);
  assert.equal(hasNoStoreDirective('NO-STORE'), true);
  assert.equal(hasNoStoreDirective('private,  no-store  , max-age=0'), true);
  // 偽物 — キャッシュは no-store と解釈しないので healthy にしてはいけない
  assert.equal(hasNoStoreDirective('x-no-store'), false);
  assert.equal(hasNoStoreDirective('no-store-disabled'), false);
  assert.equal(hasNoStoreDirective('foo=no-store'), false);
  assert.equal(hasNoStoreDirective('public, max-age=3600'), false);
  assert.equal(hasNoStoreDirective(''), false);
  assert.equal(hasNoStoreDirective(undefined), false);
});

test('🚨 x-no-store を返す本番は unhealthy として実測する (偽 healthy の回帰)', async () => {
  const health = await runLiffHealth({
    workerUrl: 'https://w.example',
    pages: [FRESH_PAGE_DEF],
    fetchHtml: async () => ({
      html: buildPage(),
      headers: new Headers({ 'cache-control': 'x-no-store, max-age=600' }),
    }),
    maxAttemptsPerPage: 1,
    retryDelayMs: 0,
  });
  assert.equal(health.ok, false);
  assert.match(health.results[0].problems.join(' | '), /no-store/);
});
