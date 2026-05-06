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

import { extractBundleId, buildResult, runCheck } from './post-deploy-check.mjs';

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

test('buildResult: exit 1 when local missing but prod present', () => {
  // 通常は起こらないが定義として local null + prod present は不一致扱い
  const r = buildResult({ localBundle: null, prodBundle: 'x.js', attempts: 1, lastError: null });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
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
