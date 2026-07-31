#!/usr/bin/env node
/**
 * 本番 LIFF / 管理ページの inline script 健全性チェック (2026-07-31)
 *
 * 背景: /liff/opt-in が inline script の打ち切り (コメント内の script 終了タグ 1 個) で
 * 2026-05-17〜07-29 の 73 日間「読み込み中...」固着のまま誰にも気付かれなかった。
 * テスト (apps/worker/src/__tests__/liff-script-syntax.test.ts) は「これから出荷する
 * コード」を守るが、**今この瞬間の本番が配っている HTML** を見る仕組みが存在しなかった
 * のが 73 日の主因。本チェックは deploy 直後に本番 HTML を fetch し、以下を検証する:
 *
 *   1. HTTP 200
 *   2. script 打ち切りが無い (tokenizer 準拠 2 軸 — テスト側と同一規則)
 *   3. 全 inline script が parse できる (new Function = ブラウザの parse 相当)
 *   4. 本体 script が丸ごと出ている (sentinel 文字列 + 最小長)
 *   5. 外部 watchdog (liff-watchdog.ts) が本体 script より前に 1 つ配置されている
 *
 * 検出規則を変える時は liff-script-syntax.test.ts 側と**必ず両方**更新すること。
 * 二重化は意図的: テストは出荷前ゲート、本チェックは本番側の独立した最終防衛線で、
 * 「テストが素通りした形」(まさに 73 日障害) をもう一度掬うために別実装で立っている。
 *
 * post-deploy-check.mjs から bundle 照合と併せて呼ばれる。単体実行:
 *   node scripts/liff-health-check.mjs
 */

/**
 * チェック対象ページの台帳。ルートを追加/削除したらここも更新する
 * (liff-script-syntax.test.ts の LIFF_PAGES / OTHER_HTML_PAGES と対応)。
 *
 * sentinel: 本体 script に必ず含まれる文字列。打ち切りで本体が消えた形を検出する。
 * watchdog: 外部 watchdog の配置を要求するか (顧客向け LIFF ページのみ)。
 */
export const HEALTH_PAGES = [
  { path: '/liff/portal', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/opt-in', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/my-rank', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/coach', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/food', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/food/graph', sentinel: 'liff.init', watchdog: true },
  { path: '/liff/reorder', sentinel: 'liff.init', watchdog: true },
  { path: '/admin', sentinel: null, watchdog: false },
  { path: '/admin/staff', sentinel: null, watchdog: false },
  { path: '/admin/logs', sentinel: null, watchdog: false },
  { path: '/admin/faq', sentinel: null, watchdog: false },
  { path: '/admin/friend-coupon', sentinel: null, watchdog: false },
  // /contact/email = mailto ブリッジ (#191)。公開固定パスで inline script を持つため対象 (採点 R1)。
  // /auth/line は素の GET だと script 0 本の HTML を返すため対象外 (query 依存の springboard)。
  { path: '/contact/email', sentinel: null, watchdog: false },
  // /docs = Swagger UI (openapi.ts)。公開固定パスで inline init script を持つ (採点 R2)。
  { path: '/docs', sentinel: null, watchdog: false },
];

/** liff-watchdog.ts の LIFF_WATCHDOG_ATTR と一致させること (worker 側 import は不可)。 */
export const WATCHDOG_MARKER = 'data-liff-watchdog';

/**
 * watchdog script 本体の識別子 (liff-watchdog.ts の WATCHDOG_JS 先頭コメントと一致)。
 * sentinel / 最小長の測定から watchdog を除外するのに使う — watchdog 自身が約 1,900 文字
 * あるため、除外しないと「本体が断片だけ残った形」の検出軸が恒久的に発火不能になる (採点 R1)。
 */
export const WATCHDOG_BODY_SIGNATURE = 'liff-watchdog v1';

/** 本体 script の最小長。打ち切りで残る断片 (数十文字) と本体を区別する。 */
const MIN_MAIN_SCRIPT_LENGTH = 1_000;

// ============================================================
// Pure 関数 (テスト対象)
// ============================================================

/** inline <script> の本体を抽出 (src= 付き外部 script は除外)。 */
export function extractInlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/**
 * script 打ち切りの検出 (tokenizer 準拠 2 軸)。
 * ブラウザは script data state を「終了タグ名 + 空白 / スラッシュ / 閉じ括弧」で終える。
 * 片軸だけでは回避が通る (個数比較のみ → コメントに開始+終了を両方書くと釣り合う /
 * 本体検査のみ → 余分な終了タグは区切りとして消費され姿を消す) ため必ず 2 軸。
 */
export function findTruncationProblems(html) {
  const problems = [];
  const opens = (html.match(/<script\b/gi) ?? []).length;
  const closes = (html.match(/<\/script[\s/>]/gi) ?? []).length;
  if (opens !== closes) {
    problems.push(`script タグ不釣合い (開始 ${opens} / 終了 ${closes}) — 打ち切りの疑い`);
  }
  for (const src of extractInlineScripts(html)) {
    if (/<script\b/i.test(src)) {
      problems.push('script 本体に開始タグの literal — 打ち切りを数合わせで隠した形');
      break;
    }
  }
  // 第 3 軸: HTML コメントの釣り合い。未閉鎖の `<!--` が 1 個あると tokenizer は EOF まで
  // 全てをコメントとして呑み、後続の watchdog も本体も一切実行されない (採点 R1)。
  // inline script 本体は除去してから数える (JS の `i-->0` 等を誤検出しないため)。
  const stripped = html.replace(/(<script(?![^>]*\bsrc=)[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2');
  const commentOpens = (stripped.match(/<!--/g) ?? []).length;
  const commentCloses = (stripped.match(/-->/g) ?? []).length;
  if (commentOpens !== commentCloses) {
    problems.push(
      `HTML コメント不釣合い (<!-- ${commentOpens} / --> ${commentCloses}) — 未閉鎖コメントが後続 script を呑む形`,
    );
  }
  // 第 4 軸: 釣り合ったコメントで script を丸ごと包む形。コメント数もタグ数も釣り合い、
  // 抽出・parse も通るが、ブラウザでは一切実行されない (採点 R2)。
  for (const span of stripped.match(/<!--[\s\S]*?-->/g) ?? []) {
    if (/<script\b/i.test(span)) {
      problems.push('HTML コメント内に script タグ — コメントアウトされた script は実行されない');
      break;
    }
  }
  return problems;
}

/** 全 inline script の parse 検証。エラーは「どの script か + メッセージ」で返す。 */
export function findParseProblems(html) {
  const problems = [];
  const scripts = extractInlineScripts(html);
  if (scripts.length === 0) {
    problems.push('inline script が 1 つも無い');
    return problems;
  }
  scripts.forEach((src, i) => {
    try {
      new Function(src);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`inline script #${i + 1} が SyntaxError: ${msg}`);
    }
  });
  return problems;
}

/**
 * 1 ページ分の健全性判定。問題ゼロなら空配列。
 * page = HEALTH_PAGES の 1 要素 ({ path, sentinel, watchdog })。
 */
export function checkPageHealth(html, page) {
  if (typeof html !== 'string' || html.length === 0) {
    return ['HTML が空'];
  }
  const problems = [...findTruncationProblems(html), ...findParseProblems(html)];

  if (page.sentinel) {
    // watchdog を除外して測る。含めると watchdog 自身 (~1,900 文字) が常に閾値を超え、
    // 「sentinel はあるが本体は断片」の検出軸が恒久的に発火不能になる (採点 R1 HIGH)。
    const joined = extractInlineScripts(html)
      .filter((s) => !s.includes(WATCHDOG_BODY_SIGNATURE))
      .join('\n');
    if (!joined.includes(page.sentinel)) {
      problems.push(`本体 script に sentinel「${page.sentinel}」が無い — 本体が丸ごと消えている疑い`);
    } else if (joined.length < MIN_MAIN_SCRIPT_LENGTH) {
      problems.push(`本体 script 合計 ${joined.length} 文字 (< ${MIN_MAIN_SCRIPT_LENGTH}) — 断片だけが残った形`);
    }
  }

  if (page.watchdog) {
    const markers = html.match(new RegExp(WATCHDOG_MARKER, 'g')) ?? [];
    if (markers.length !== 1) {
      problems.push(`外部 watchdog マーカーが ${markers.length} 個 (期待 1)`);
    } else {
      // watchdog は本体より前に無ければ、本体の打ち切りに巻き込まれて意味を失う
      const wdIdx = html.indexOf(WATCHDOG_MARKER);
      const mainIdx = page.sentinel ? html.indexOf(page.sentinel) : -1;
      if (mainIdx >= 0 && wdIdx > mainIdx) {
        problems.push('外部 watchdog が本体 script より後ろにある — 打ち切りの巻き添えになる配置');
      }
      // CDN 同期 script は parser をブロックする。CDN より後ろだと「CDN ハング」クラスで
      // watchdog が arm すらされない (採点 R2: この軸が CI 側にしか無く片翼だった)
      const cdnIdx = html.indexOf('<script src=');
      if (cdnIdx >= 0 && wdIdx > cdnIdx) {
        problems.push('外部 watchdog が最初の外部 script より後ろ — CDN ハングで arm されない配置');
      }
    }
  }

  return problems;
}

// ============================================================
// IO + ランナー (fetch はモック注入可能)
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultFetchHtml(url, signal) {
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
    signal,
  });
  if (!res.ok) {
    // この 'HTTP <code>' 形式は runLiffHealth の分類 regex (/^HTTP \d{3}$/) と契約。
    // 文言を変える時は分類側も必ず同時に変える (ズレると実測の障害が「確認不能」へ静かに降格する)
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

/**
 * 全ページを順に fetch して健全性判定。
 * 戻り値: { ok, results: [{ path, problems }] } — problems 空 = healthy。
 * fetch 失敗は 1 回だけリトライ (deploy 直後の瞬断対策)。それでも失敗なら fail
 * (73 日障害の教訓: 「確認できなかった」を成功扱いにしない = fail-closed)。
 */
export async function runLiffHealth({
  workerUrl,
  pages = HEALTH_PAGES,
  fetchHtml = defaultFetchHtml,
  maxAttemptsPerPage = 2,
  retryDelayMs = 3_000,
  fetchTimeoutMs = 10_000,
  onProgress = null,
} = {}) {
  const results = [];
  for (const page of pages) {
    let problems = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttemptsPerPage; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
      try {
        const html = await fetchHtml(workerUrl + page.path, ac.signal);
        problems = checkPageHealth(html, page);
        lastError = null;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttemptsPerPage) {
        await sleep(retryDelayMs);
      }
    }
    // HTTP 4xx/5xx はページ自体が落ちている「実測」であり「確認不能」ではない (採点 R2)。
    // ネットワーク例外 (DNS/timeout 等) だけを fetchFailed = 確認不能に分類する。
    // regex は defaultFetchHtml の throw 文言 ('HTTP <code>') と契約 — 変更時は両方同時に。
    const httpError = problems === null && lastError !== null && /^HTTP \d{3}$/.test(lastError);
    const fetchFailed = problems === null && !httpError;
    if (problems === null) {
      problems = httpError
        ? [`HTTP エラー応答 (${lastError}) — ページ自体が落ちている実測`]
        : [`fetch 失敗: ${lastError ?? 'unknown'}`];
    }
    results.push({ path: page.path, problems, fetchFailed });
    if (onProgress) onProgress({ path: page.path, problems });
  }
  return { ok: results.every((r) => r.problems.length === 0), results };
}

/**
 * exit code の意味論 (post-deploy-check.mjs の bundle 側と揃える):
 *   0 = 全ページ healthy / 1 = 不健全なページを実測 (本番障害の可能性) /
 *   2 = 確認不能 (fetch 全滅のみで不健全の実測なし)。1 と 2 の区別は初動を変える
 *   (1 = rollback 検討、2 = ネットワーク/URL の確認) ため fail-closed のまま分ける。
 */
export function healthExitCode(health) {
  if (health.ok) return 0;
  const anyRealProblem = health.results.some((r) => !r.fetchFailed && r.problems.length > 0);
  return anyRealProblem ? 1 : 2;
}

/** CLI 出力 (post-deploy-check.mjs からも利用)。 */
export function printHealthResults(health, workerUrl) {
  console.log('');
  console.log('━━━ LIFF/管理ページ健全性チェック ━━━');
  console.log(`  Worker URL : ${workerUrl}`);
  for (const r of health.results) {
    if (r.problems.length === 0) {
      console.log(`  ✓ ${r.path}`);
    } else {
      for (const p of r.problems) {
        console.error(`  ✗ ${r.path} — ${p}`);
      }
    }
  }
  console.log('');
  if (health.ok) {
    console.log('✓ 全ページ healthy — inline script は打ち切り無しで配信されています。');
  } else {
    console.error('✗ 不健全なページがあります。「読み込み中」固着クラスの障害が本番で起きている可能性 —');
    console.error('  即 wrangler rollback または前 commit を再 deploy し、原因の inline script を修正してください。');
  }
  console.log('');
}

// ============================================================
// 単体実行 (post-deploy-check.mjs 経由でなく直接叩く用)
// ============================================================

const DEFAULT_WORKER_URL = 'https://naturism-line-crm.katsu-7d5.workers.dev';

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  const workerUrl = process.env.WORKER_URL || DEFAULT_WORKER_URL;
  // SSRF 防止: post-deploy-check.mjs と同じ allowlist。単体実行経路 (pnpm liff-health) も
  // 同水準で守る (deploy 経路は post-deploy-check 側の isAllowedWorkerUrl が担当)。
  let allowed = false;
  try {
    const u = new URL(workerUrl);
    allowed =
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      /^([a-z0-9-]+\.)*(workers\.dev|naturism-diet\.com)$/i.test(u.hostname);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    console.error(`liff-health-check: WORKER_URL not allowed by host pattern: ${workerUrl}`);
    process.exitCode = 2;
  } else {
    runLiffHealth({ workerUrl })
      .then((health) => {
        printHealthResults(health, workerUrl);
        process.exitCode = healthExitCode(health);
      })
      .catch((err) => {
        console.error('liff-health-check failed:', err);
        process.exitCode = 2;
      });
  }
}
