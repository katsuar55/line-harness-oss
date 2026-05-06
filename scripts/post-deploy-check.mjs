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
 *   1  不一致 (要確認 / redeploy)
 *   2  内部エラー (dist 不在 / fetch 失敗が継続)
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_WORKER_URL = 'https://naturism-line-crm.katsu-7d5.workers.dev';
const DEFAULT_LOCAL_HTML = join(REPO_ROOT, 'apps/worker/dist/client/index.html');
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RETRY_DELAY_MS = 5_000;

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
 * 結果オブジェクトを生成 (テスト容易性のため pure に)。
 */
export function buildResult({ localBundle, prodBundle, attempts, lastError }) {
  if (localBundle && prodBundle && localBundle === prodBundle) {
    return { ok: true, exitCode: 0, localBundle, prodBundle, attempts, lastError: null };
  }
  return {
    ok: false,
    exitCode: prodBundle === null && lastError ? 2 : 1,
    localBundle,
    prodBundle,
    attempts,
    lastError: lastError ? String(lastError).slice(0, 300) : null,
  };
}

// ============================================================
// IO 関数 (テスト時はモック注入可能)
// ============================================================

async function defaultFetchProdHtml(workerUrl) {
  const res = await fetch(workerUrl + '/', {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
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
  fetchProdHtml = defaultFetchProdHtml,
  onProgress = null,
} = {}) {
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
    try {
      const prodHtml = await fetchProdHtml(workerUrl);
      prodBundle = extractBundleId(prodHtml);
      if (onProgress) onProgress({ attempt: i, prodBundle, localBundle });
      if (prodBundle === localBundle) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (onProgress) onProgress({ attempt: i, error: lastError });
    }
    if (i < maxAttempts && prodBundle !== localBundle) {
      await sleep(retryDelayMs);
    }
  }

  return buildResult({ localBundle, prodBundle, attempts, lastError });
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
    console.error('✗ Bundle ID MISMATCH (or fetch keeps failing).');
    console.error('');
    console.error('  Possible causes:');
    console.error('  1. CDN cache not yet propagated (rare; usually <30s) — wait then re-run');
    console.error('  2. Build skipped or stale dist used → re-run `pnpm --filter worker run deploy`');
    console.error('  3. wrangler deploy partially failed → check Cloudflare dashboard');
    console.error('  4. apex DNS pointing elsewhere → verify route bindings');
  } else {
    console.error('✗ Pre-condition failed (no local build or fetch unreachable).');
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
  return result.exitCode;
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
