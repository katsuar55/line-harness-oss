#!/usr/bin/env node
/**
 * Post-deploy bundle ID verification.
 *
 * Bundle ID 同期問題 (再発: 2026-05-02 朝 / 2026-05-07 朝) 対策。
 * deploy 直後に本番 HTML を fetch し、ローカル `apps/worker/dist/client/index.html`
 * の bundle ID と一致するかを検証する。不一致なら exit 1 で警告を出し、
 * オーナーが「deploy したのに古いまま」状態を見落とすのを防ぐ。
 *
 * 過去観測された不一致の原因仮説:
 *   - vite build スキップ (predeploy が走らなかった)
 *   - dist が古いまま deploy (build 失敗を見落とし)
 *   - CDN cache 不整合 (deploy 後 30〜60 秒で解消するケースあり)
 *
 * 仕組み:
 *   ローカル: apps/worker/dist/client/index.html の <script src="/assets/index-XXX.js">
 *   本番:    `${WORKER_URL}/` の同 script タグ
 *   一致するまで最大 6 回 (5 秒間隔 = 最大 30 秒) リトライ
 *
 * Exit codes:
 *   0  一致
 *   1  両方の bundle ID 取得に成功したが値が違う (要 redeploy)
 *   2  事前条件失敗 / fetch 失敗 / 本番 HTML に script タグなし (要環境確認)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runLiffHealth, printHealthResults, healthExitCode } from './liff-health-check.mjs';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_WORKER_URL = 'https://naturism-line-crm.katsu-7d5.workers.dev';
const DEFAULT_LOCAL_HTML = join(REPO_ROOT, 'apps/worker/dist/client/index.html');
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * SSRF 防止: 許可ホストの正規表現。WORKER_URL は CI/CD 環境変数で設定されるが、
 * 攻撃者が制御した場合や誤設定の場合に Node.js プロセスから内部エンドポイント
 * (169.254.169.254 メタデータサーバ等) や file:// に向かないようガードする。
 *
 * 環境変数 `POST_DEPLOY_HOST_ALLOWLIST` で正規表現 (host を test するパターン) を上書き可能。
 * デフォルトは Cloudflare Workers のサブドメインと naturism-diet.com 系のみ許可。
 */
const DEFAULT_ALLOWED_HOST_PATTERN = process.env.POST_DEPLOY_HOST_ALLOWLIST
  ? new RegExp(process.env.POST_DEPLOY_HOST_ALLOWLIST, 'i')
  : /^([a-z0-9-]+\.)*(workers\.dev|naturism-diet\.com)$/i;

// ============================================================
// Pure 関数
// ============================================================

/**
 * `<script src="/assets/index-XXX.js">` から bundle ファイル名を抽出。
 * 該当タグがない場合は null を返す。
 */
export function extractBundleId(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/);
  return m ? m[1] : null;
}

/**
 * URL を allowlist で検証 (SSRF 防止)。
 * - URL parse 不能、http(s) 以外のプロトコル、host が pattern にマッチしない場合は false
 */
export function isAllowedWorkerUrl(workerUrl, pattern = DEFAULT_ALLOWED_HOST_PATTERN) {
  if (typeof workerUrl !== 'string' || workerUrl.length === 0) return false;
  try {
    const url = new URL(workerUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return pattern.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * 結果オブジェクトを生成 (テスト容易性のため pure に)。
 *
 * Exit code semantics:
 *   0  両方の bundle ID 取得に成功し、一致
 *   1  両方取得できたが値が違う = redeploy 必要 (CDN cache propagation 待ち含む)
 *   2  事前条件失敗 (local dist 不在 / 本番 fetch 不可 / 本番 HTML に script タグなし)
 */
export function buildResult({ localBundle, prodBundle, attempts, lastError }) {
  if (localBundle && prodBundle && localBundle === prodBundle) {
    return { ok: true, exitCode: 0, localBundle, prodBundle, attempts, lastError: null };
  }
  if (!localBundle) {
    return {
      ok: false,
      exitCode: 2,
      localBundle: null,
      prodBundle,
      attempts,
      lastError: lastError ? String(lastError).slice(0, 300) : 'local bundle unavailable',
    };
  }
  if (!prodBundle) {
    return {
      ok: false,
      exitCode: 2,
      localBundle,
      prodBundle: null,
      attempts,
      lastError: lastError
        ? String(lastError).slice(0, 300)
        : 'prod HTML did not contain expected <script src="/assets/index-*.js"> tag',
    };
  }
  // 両方 present だが値が違う = redeploy 推奨
  return {
    ok: false,
    exitCode: 1,
    localBundle,
    prodBundle,
    attempts,
    lastError: null,
  };
}

// ============================================================
// IO 関数 (テスト時はモック注入可能)
// ============================================================

/**
 * 本番 HTML を fetch (AbortController でタイムアウト制御)。
 * `signal` を受け取り、外部から timeout を制御できる設計。
 */
async function defaultFetchProdHtml(workerUrl, signal) {
  const res = await fetch(workerUrl + '/', {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// メインロジック (CLI/テスト両用)
// ============================================================

export async function runCheck({
  workerUrl = process.env.WORKER_URL || DEFAULT_WORKER_URL,
  localHtmlPath = DEFAULT_LOCAL_HTML,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  allowedHostPattern = DEFAULT_ALLOWED_HOST_PATTERN,
  fetchProdHtml = defaultFetchProdHtml,
  onProgress = null,
} = {}) {
  // SSRF 防止: WORKER_URL の host を allowlist で検証
  if (!isAllowedWorkerUrl(workerUrl, allowedHostPattern)) {
    return buildResult({
      localBundle: null,
      prodBundle: null,
      attempts: 0,
      lastError: `WORKER_URL not allowed by host pattern: ${workerUrl}`,
    });
  }
  if (!existsSync(localHtmlPath)) {
    return buildResult({
      localBundle: null,
      prodBundle: null,
      attempts: 0,
      lastError: `Local dist HTML not found: ${localHtmlPath} (run \`pnpm --filter worker build\` first)`,
    });
  }
  const localHtml = readFileSync(localHtmlPath, 'utf-8');
  const localBundle = extractBundleId(localHtml);
  if (!localBundle) {
    return buildResult({
      localBundle: null,
      prodBundle: null,
      attempts: 0,
      lastError: 'Could not extract bundle ID from local HTML',
    });
  }

  let prodBundle = null;
  let lastError = null;
  let attempts = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), fetchTimeoutMs);
    try {
      const prodHtml = await fetchProdHtml(workerUrl, ac.signal);
      prodBundle = extractBundleId(prodHtml);
      if (onProgress) onProgress({ attempt: i, prodBundle, localBundle });
      if (prodBundle === localBundle) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (onProgress) onProgress({ attempt: i, error: lastError });
    } finally {
      clearTimeout(timer);
    }
    if (i < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return buildResult({ localBundle, prodBundle, attempts, lastError });
}

/**
 * 複数チェックの exit code 合成。「実測の障害 (1)」は「確認不能 (2)」より常に優先する
 * (healthExitCode の混在規則と同じ。Math.max だと 1 が 2 に降格し初動指示が誤る — 採点 R2)。
 */
export function combineExitCodes(codes) {
  if (codes.includes(1)) return 1;
  if (codes.includes(2)) return 2;
  return 0;
}

// ============================================================
// CLI 出力
// ============================================================

function printResult(result, workerUrl) {
  console.log('');
  console.log('━━━ Post-deploy bundle check ━━━');
  console.log(`  Worker URL : ${workerUrl}`);
  console.log(`  Local      : ${result.localBundle ?? '(unknown)'}`);
  console.log(`  Prod       : ${result.prodBundle ?? '(failed to fetch)'}`);
  console.log(`  Attempts   : ${result.attempts}`);
  if (result.lastError) {
    console.log(`  Last error : ${result.lastError}`);
  }
  console.log('');
  if (result.ok) {
    console.log('✓ Bundle ID match — deploy verified.');
  } else if (result.exitCode === 1) {
    console.error('✗ Bundle ID MISMATCH between local build and prod.');
    console.error('');
    console.error('  Possible causes:');
    console.error('  1. CDN cache not yet propagated (rare; usually <30s) — wait then re-run');
    console.error('  2. Build skipped or stale dist used → re-run `pnpm --filter worker run deploy`');
    console.error('  3. wrangler deploy partially failed → check Cloudflare dashboard');
    console.error('  4. apex DNS pointing elsewhere → verify route bindings');
  } else {
    console.error('✗ Pre-condition failed (local dist missing / fetch unreachable / WORKER_URL not allowed / prod HTML lacks script tag).');
  }
  console.log('');
}

/**
 * 本番 HTML の版マーカー (`<meta name="x-build">`) と ローカル HEAD の照合 (2026-08-23)。
 *
 * bundle 照合は**管理画面 SPA の asset** を見ており、Hono がレンダリングする LIFF の HTML が
 * 新しいかは 1 度も見ていなかった。#270 で『deploy 済みなのに実機が古い』の切り分けに
 * 丸 1 日かかった主因がこれ。ここで LIFF 本体の版を直接照合する。
 *
 * fail-closed ではなく **警告のみ** (exit code に混ぜない): git が無い CI や
 * BUILD_SHA を渡さない手動 deploy でも deploy 自体は通したい。値が食い違ったときに
 * 「実機が古いのは配信が古いから」と即断できることが目的。
 */
export async function checkBuildMarker(workerUrl, fetchImpl = fetch) {
  let local = process.env.BUILD_SHA?.trim() || null;
  if (!local) {
    try {
      local = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      local = null;
    }
  }
  let prod = null;
  try {
    const res = await fetchImpl(`${workerUrl}/liff/portal`, { cache: 'no-store' });
    if (res.ok) {
      const html = await res.text();
      prod = html.match(/<meta name="x-build" content="([^"]*)">/)?.[1] ?? null;
    }
  } catch {
    prod = null;
  }
  return { local, prod, match: local != null && prod != null && local === prod };
}

function printBuildMarker(marker) {
  console.log('');
  console.log('━━━ LIFF build marker ━━━');
  console.log(`  Local HEAD : ${marker.local ?? '(unknown)'}`);
  console.log(`  Prod meta  : ${marker.prod ?? '(not found)'}`);
  if (marker.match) {
    console.log('✓ LIFF HTML は今の HEAD を配っています。');
  } else if (marker.local && marker.prod) {
    console.warn('⚠ LIFF HTML の版が HEAD と違います — 配信が古い可能性 (実機が古いのはこれが原因)。');
  } else {
    console.warn('⚠ 版マーカーを照合できませんでした (git 不在 / meta 未検出)。');
  }
  console.log('');
}

async function main() {
  const workerUrl = process.env.WORKER_URL || DEFAULT_WORKER_URL;
  const result = await runCheck({
    workerUrl,
    onProgress: ({ attempt, prodBundle, localBundle, error }) => {
      if (error) {
        console.log(`  attempt ${attempt}: fetch error: ${error}`);
      } else {
        const status = prodBundle === localBundle ? 'match' : 'mismatch';
        console.log(`  attempt ${attempt}: prod=${prodBundle ?? '(none)'} (${status})`);
      }
    },
  });
  printResult(result, workerUrl);

  // LIFF/管理ページ健全性 — bundle 照合とは独立に必ず実行する。
  // bundle が一致していても「inline script が打ち切られた HTML」を配っている形
  // (= /liff/opt-in の 73 日障害) がありうるため、bundle 結果に関わらず見る。
  // 確認できなかった (allowlist 外 / fetch 全滅) を成功扱いにしない = fail-closed。
  let healthExit = 2;
  if (isAllowedWorkerUrl(workerUrl)) {
    const health = await runLiffHealth({ workerUrl });
    printHealthResults(health, workerUrl);
    healthExit = healthExitCode(health);
  } else {
    console.error('✗ LIFF health check skipped: WORKER_URL not allowed by host pattern.');
  }
  // LIFF 本体の版照合 (警告のみ — exit code には混ぜない)
  if (isAllowedWorkerUrl(workerUrl)) {
    printBuildMarker(await checkBuildMarker(workerUrl));
  }

  return combineExitCodes([result.exitCode, healthExit]);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  main()
    .then((code) => {
      // process.exit() を直接呼ぶと Node + Windows + fetch (undici) の組み合わせで
      // libuv の UV_HANDLE_CLOSING assertion が出ることがある (exit code 127 で誤検知)。
      // exitCode を設定してイベントループが自然に空になるのを待つ方が安全。
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('post-deploy-check failed:', err);
      process.exitCode = 2;
    });
}
