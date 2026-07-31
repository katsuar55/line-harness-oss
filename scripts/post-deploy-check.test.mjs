/**
 * Tests for scripts/post-deploy-check.mjs
 *
 * node:test (built-in) で動作。pnpm post-deploy-check:test で実行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { extractBundleId, buildResult, runCheck, isAllowedWorkerUrl, combineExitCodes } from './post-deploy-check.mjs';

// ─────────────────────────────────────
// combineExitCodes — 「実測の障害 (1)」は「確認不能 (2)」より常に優先
// (Math.max だと bundle=1 + health=2 の混在で 1 が 2 に降格し、rollback すべき局面で
//  「ネットワーク確認」の初動コードが返る — 採点 R2)
// ─────────────────────────────────────
test('combineExitCodes: 全て 0 なら 0', () => {
  assert.equal(combineExitCodes([0, 0]), 0);
});
test('combineExitCodes: 1 が混ざれば常に 1 (2 との混在でも降格しない)', () => {
  assert.equal(combineExitCodes([1, 0]), 1);
  assert.equal(combineExitCodes([1, 2]), 1);
  assert.equal(combineExitCodes([2, 1]), 1);
});
test('combineExitCodes: 2 のみなら 2', () => {
  assert.equal(combineExitCodes([2, 0]), 2);
  assert.equal(combineExitCodes([2, 2]), 2);
});

// ─────────────────────────────────────
// extractBundleId
// ─────────────────────────────────────
test('extractBundleId returns bundle filename from script tag', () => {
  const html = '<html><body><script type="module" crossorigin src="/assets/index-DuC2JoJn.js"></script></body></html>';
  assert.equal(extractBundleId(html), 'index-DuC2JoJn.js');
});

test('extractBundleId handles bundles with mixed alphanumeric and hyphen', () => {
  const html = '<script src="/assets/index-Abc-DEF_123.js"></script>';
  assert.equal(extractBundleId(html), 'index-Abc-DEF_123.js');
});

test('extractBundleId returns null when no script tag present', () => {
  assert.equal(extractBundleId('<html></html>'), null);
});

test('extractBundleId returns null for non-string input', () => {
  assert.equal(extractBundleId(null), null);
  assert.equal(extractBundleId(undefined), null);
  assert.equal(extractBundleId(42), null);
});

test('extractBundleId picks first script tag if multiple present', () => {
  const html = '<script src="/assets/index-AAAA0000.js"></script><script src="/assets/index-BBBB1111.js"></script>';
  assert.equal(extractBundleId(html), 'index-AAAA0000.js');
});

// ─────────────────────────────────────
// buildResult
// ─────────────────────────────────────
test('buildResult: ok when local and prod match', () => {
  const r = buildResult({ localBundle: 'x.js', prodBundle: 'x.js', attempts: 1, lastError: null });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
});

test('buildResult: exit 1 when bundles differ', () => {
  const r = buildResult({ localBundle: 'x.js', prodBundle: 'y.js', attempts: 3, lastError: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

test('buildResult: exit 2 when prod fetch failed throughout', () => {
  const r = buildResult({ localBundle: 'x.js', prodBundle: null, attempts: 6, lastError: 'HTTP 503' });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.lastError, /HTTP 503/);
});

test('buildResult: exit 2 when local missing (pre-condition failure)', () => {
  const r = buildResult({ localBundle: null, prodBundle: 'x.js', attempts: 1, lastError: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.lastError, /local bundle unavailable/);
});

test('buildResult: exit 2 when prod returns HTML without script tag', () => {
  // fetch は成功した (lastError なし) が <script src="/assets/index-*.js"> が見つからなかったケース
  const r = buildResult({ localBundle: 'x.js', prodBundle: null, attempts: 6, lastError: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
  assert.match(r.lastError, /<script src/);
});

// ─────────────────────────────────────
// isAllowedWorkerUrl (SSRF 防止)
// ─────────────────────────────────────
test('isAllowedWorkerUrl: accepts workers.dev subdomain (default pattern)', () => {
  assert.equal(isAllowedWorkerUrl('https://naturism-line-crm.katsu-7d5.workers.dev'), true);
});

test('isAllowedWorkerUrl: accepts naturism-diet.com', () => {
  assert.equal(isAllowedWorkerUrl('https://naturism-diet.com'), true);
});

test('isAllowedWorkerUrl: rejects link-local IMDS (169.254.169.254)', () => {
  assert.equal(isAllowedWorkerUrl('http://169.254.169.254/latest/meta-data/'), false);
});

test('isAllowedWorkerUrl: rejects localhost / loopback', () => {
  assert.equal(isAllowedWorkerUrl('http://localhost/'), false);
  assert.equal(isAllowedWorkerUrl('http://127.0.0.1/'), false);
});

test('isAllowedWorkerUrl: rejects file:// and other protocols', () => {
  assert.equal(isAllowedWorkerUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedWorkerUrl('ftp://example.com/'), false);
});

test('isAllowedWorkerUrl: rejects malformed URLs', () => {
  assert.equal(isAllowedWorkerUrl('not a url'), false);
  assert.equal(isAllowedWorkerUrl(''), false);
  assert.equal(isAllowedWorkerUrl(null), false);
});

test('isAllowedWorkerUrl: respects custom pattern', () => {
  const pattern = /^example\.test$/i;
  assert.equal(isAllowedWorkerUrl('https://example.test', pattern), true);
  assert.equal(isAllowedWorkerUrl('https://other.test', pattern), false);
});

// ─────────────────────────────────────
// runCheck (integration with mocked fetch)
// ─────────────────────────────────────
test('runCheck: returns ok=true when prod matches on first attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-ok-'));
  try {
    const html = '<script src="/assets/index-MATCH123.js"></script>';
    const path = join(dir, 'index.html');
    writeFileSync(path, html);

    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 1,
      retryDelayMs: 0,
      fetchProdHtml: async () => html,
    });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.localBundle, 'index-MATCH123.js');
    assert.equal(result.prodBundle, 'index-MATCH123.js');
    assert.equal(result.attempts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: retries until prod catches up, then succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-retry-'));
  try {
    const localHtml = '<script src="/assets/index-NEW.js"></script>';
    const oldHtml = '<script src="/assets/index-OLD.js"></script>';
    const path = join(dir, 'index.html');
    writeFileSync(path, localHtml);

    let calls = 0;
    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 4,
      retryDelayMs: 1,
      fetchProdHtml: async () => {
        calls++;
        return calls < 3 ? oldHtml : localHtml;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
    assert.equal(result.prodBundle, 'index-NEW.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: returns mismatch result when prod never matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-mismatch-'));
  try {
    const localHtml = '<script src="/assets/index-NEW.js"></script>';
    const oldHtml = '<script src="/assets/index-OLD.js"></script>';
    const path = join(dir, 'index.html');
    writeFileSync(path, localHtml);

    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 3,
      retryDelayMs: 1,
      fetchProdHtml: async () => oldHtml,
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.localBundle, 'index-NEW.js');
    assert.equal(result.prodBundle, 'index-OLD.js');
    assert.equal(result.attempts, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: returns exit 2 when fetch keeps throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-fetcherr-'));
  try {
    const localHtml = '<script src="/assets/index-NEW.js"></script>';
    const path = join(dir, 'index.html');
    writeFileSync(path, localHtml);

    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 2,
      retryDelayMs: 1,
      fetchProdHtml: async () => {
        throw new Error('ECONNREFUSED test');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.localBundle, 'index-NEW.js');
    assert.equal(result.prodBundle, null);
    assert.match(result.lastError, /ECONNREFUSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: returns exit 2 when local dist HTML missing', async () => {
  const result = await runCheck({
    localHtmlPath: '/non/existent/dist/index.html',
    workerUrl: 'https://example.test',
    allowedHostPattern: /.*/,
    maxAttempts: 1,
    retryDelayMs: 0,
    fetchProdHtml: async () => '<script src="/assets/index-X.js"></script>',
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.localBundle, null);
  assert.match(result.lastError, /Local dist HTML not found/);
});

test('runCheck: returns exit 2 when local HTML has no script tag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-nolocal-'));
  try {
    const path = join(dir, 'index.html');
    writeFileSync(path, '<html><body>no script</body></html>');

    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 1,
      retryDelayMs: 0,
      fetchProdHtml: async () => '<script src="/assets/index-X.js"></script>',
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.lastError, /extract bundle ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: returns exit 2 when WORKER_URL not in allowlist (SSRF guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-ssrf-'));
  try {
    const path = join(dir, 'index.html');
    writeFileSync(path, '<script src="/assets/index-X.js"></script>');

    let fetched = false;
    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'http://169.254.169.254/',
      maxAttempts: 1,
      retryDelayMs: 0,
      fetchProdHtml: async () => {
        fetched = true;
        return '';
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.match(result.lastError, /not allowed/);
    assert.equal(fetched, false, 'fetch must NOT be called when URL is rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: returns exit 2 when prod HTML has no script tag (M-1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-prodempty-'));
  try {
    const path = join(dir, 'index.html');
    writeFileSync(path, '<script src="/assets/index-LOCAL.js"></script>');

    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchProdHtml: async () => '<html><body>maintenance page, no bundle</body></html>',
    });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.localBundle, 'index-LOCAL.js');
    assert.equal(result.prodBundle, null);
    assert.match(result.lastError, /<script src/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCheck: passes AbortSignal to fetchProdHtml (timeout enforcement)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-signal-'));
  try {
    const path = join(dir, 'index.html');
    writeFileSync(path, '<script src="/assets/index-X.js"></script>');

    let receivedSignal = null;
    const result = await runCheck({
      localHtmlPath: path,
      workerUrl: 'https://example.test',
      allowedHostPattern: /.*/,
      maxAttempts: 1,
      retryDelayMs: 0,
      fetchTimeoutMs: 1_000,
      fetchProdHtml: async (_url, signal) => {
        receivedSignal = signal;
        return '<script src="/assets/index-X.js"></script>';
      },
    });
    assert.equal(result.ok, true);
    assert.ok(receivedSignal, 'fetchProdHtml must receive a signal');
    assert.equal(typeof receivedSignal.aborted, 'boolean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
