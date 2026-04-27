/**
 * Tests for scripts/preflight.mjs (Phase 5 PR-5)
 *
 * Runs with node:test (built-in, no devDependency added).
 * Invoke via: pnpm preflight:test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  listMigrationFiles,
  findMigrationGaps,
  findMigrationDuplicates,
  compareSecrets,
  summarizeReport,
  runChecks,
  REQUIRED_SECRETS,
  OPTIONAL_SECRETS,
} from './preflight.mjs';

// ─────────────────────────────────────
// listMigrationFiles
// ─────────────────────────────────────
test('listMigrationFiles parses NNN_xxx.sql files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-mig-'));
  try {
    writeFileSync(join(dir, '001_init.sql'), '');
    writeFileSync(join(dir, '003_users.sql'), '');
    writeFileSync(join(dir, '002_friends.sql'), '');
    writeFileSync(join(dir, 'README.md'), '');           // ignored
    writeFileSync(join(dir, '004.sql'), '');              // ignored (no underscore)

    const out = listMigrationFiles(dir);
    assert.deepEqual(
      out,
      [
        { file: '001_init.sql', num: 1 },
        { file: '002_friends.sql', num: 2 },
        { file: '003_users.sql', num: 3 },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listMigrationFiles returns [] for missing directory', () => {
  assert.deepEqual(listMigrationFiles('/non/existent/dir/xyz123'), []);
});

// ─────────────────────────────────────
// findMigrationGaps
// ─────────────────────────────────────
test('findMigrationGaps returns no gaps for contiguous range', () => {
  const out = findMigrationGaps([
    { file: '001_a.sql', num: 1 },
    { file: '002_b.sql', num: 2 },
    { file: '003_c.sql', num: 3 },
  ]);
  assert.deepEqual(out, { firstNum: 1, lastNum: 3, gaps: [] });
});

test('findMigrationGaps detects missing numbers', () => {
  const out = findMigrationGaps([
    { file: '036_a.sql', num: 36 },
    { file: '037_b.sql', num: 37 },
    { file: '039_c.sql', num: 39 },
  ]);
  assert.deepEqual(out, { firstNum: 36, lastNum: 39, gaps: [38] });
});

test('findMigrationGaps handles empty input', () => {
  const out = findMigrationGaps([]);
  assert.deepEqual(out, { firstNum: null, lastNum: null, gaps: [] });
});

// ─────────────────────────────────────
// findMigrationDuplicates
// ─────────────────────────────────────
test('findMigrationDuplicates finds same-number files', () => {
  const out = findMigrationDuplicates([
    { file: '009_delivery_type.sql', num: 9 },
    { file: '009_token_expiry.sql', num: 9 },
    { file: '010_other.sql', num: 10 },
  ]);
  assert.deepEqual(out, [
    { num: 9, files: ['009_delivery_type.sql', '009_token_expiry.sql'] },
  ]);
});

test('findMigrationDuplicates returns [] when all unique', () => {
  const out = findMigrationDuplicates([
    { file: '001_a.sql', num: 1 },
    { file: '002_b.sql', num: 2 },
  ]);
  assert.deepEqual(out, []);
});

// ─────────────────────────────────────
// compareSecrets
// ─────────────────────────────────────
test('compareSecrets reports missing required + extras + optional present', () => {
  const remote = [
    { name: 'LINE_CHANNEL_SECRET' },
    { name: 'LINE_CHANNEL_ACCESS_TOKEN' },
    { name: 'API_KEY' },
    { name: 'AXIOM_TOKEN' },           // optional present
    { name: 'WEIRD_TYPO_KEY' },        // unknown
  ];
  const required = ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'API_KEY', 'ANTHROPIC_API_KEY'];
  const optional = ['AXIOM_TOKEN', 'DISCORD_WEBHOOK_URL'];
  const out = compareSecrets(remote, required, optional);
  assert.deepEqual(out.missing, ['ANTHROPIC_API_KEY']);
  assert.deepEqual(out.extra, ['WEIRD_TYPO_KEY']);
  assert.deepEqual(out.optionalPresent, ['AXIOM_TOKEN']);
});

test('compareSecrets all-green case', () => {
  const remote = [{ name: 'A' }, { name: 'B' }];
  const out = compareSecrets(remote, ['A', 'B'], []);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.extra, []);
});

// ─────────────────────────────────────
// summarizeReport
// ─────────────────────────────────────
test('summarizeReport returns exit 0 for INFO only', () => {
  const out = summarizeReport([{ severity: 'INFO', check: 'x', message: 'ok' }]);
  assert.equal(out.exitCode, 0);
});

test('summarizeReport returns exit 2 for WARN', () => {
  const out = summarizeReport([{ severity: 'WARN', check: 'x', message: 'meh' }]);
  assert.equal(out.exitCode, 2);
});

test('summarizeReport returns exit 1 for CRITICAL (overrides WARN)', () => {
  const out = summarizeReport([
    { severity: 'WARN', check: 'a', message: 'meh' },
    { severity: 'CRITICAL', check: 'b', message: 'bad' },
  ]);
  assert.equal(out.exitCode, 1);
});

// ─────────────────────────────────────
// runChecks (integration)
// ─────────────────────────────────────
test('runChecks offline mode flags missing migrations dir', async () => {
  const issues = await runChecks({
    mode: 'offline',
    migrationsDir: '/non/existent/path-xyz',
  });
  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  assert.ok(
    critical.some((i) => i.check === 'migrations'),
    'expected CRITICAL migrations issue',
  );
});

test('runChecks offline mode reports gap correctly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-run-'));
  try {
    writeFileSync(join(dir, '001_a.sql'), '');
    writeFileSync(join(dir, '003_c.sql'), '');           // 002 missing
    const issues = await runChecks({ mode: 'offline', migrationsDir: dir });
    const warn = issues.filter((i) => i.severity === 'WARN' && i.check === 'migrations');
    assert.equal(warn.length, 1);
    assert.match(warn[0].message, /missing 2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runChecks full mode uses fetchSecrets injection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-full-'));
  try {
    writeFileSync(join(dir, '001_a.sql'), '');
    const fakeSecrets = () => ({
      ok: true,
      secrets: REQUIRED_SECRETS.map((name) => ({ name })),
    });
    const issues = await runChecks({
      mode: 'full',
      migrationsDir: dir,
      fetchSecrets: fakeSecrets,
    });
    // No CRITICAL secrets issue when all required present
    const critical = issues.filter((i) => i.severity === 'CRITICAL' && i.check === 'secrets');
    assert.equal(critical.length, 0);
    // INFO secrets summary should be there
    const info = issues.filter((i) => i.severity === 'INFO' && i.check === 'secrets');
    assert.equal(info.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runChecks full mode flags missing required secrets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-miss-'));
  try {
    writeFileSync(join(dir, '001_a.sql'), '');
    const fakeSecrets = () => ({
      ok: true,
      secrets: [{ name: 'LINE_CHANNEL_SECRET' }], // others missing
    });
    const issues = await runChecks({
      mode: 'full',
      migrationsDir: dir,
      fetchSecrets: fakeSecrets,
    });
    const critical = issues.filter((i) => i.severity === 'CRITICAL' && i.check === 'secrets');
    assert.equal(critical.length, 1);
    assert.match(critical[0].message, /Missing required secrets/);
    assert.match(critical[0].message, /ANTHROPIC_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runChecks full mode tolerates wrangler failure (WARN not CRITICAL)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-wfail-'));
  try {
    writeFileSync(join(dir, '001_a.sql'), '');
    const fakeSecrets = () => ({ ok: false, error: 'auth failed', secrets: [] });
    const issues = await runChecks({
      mode: 'full',
      migrationsDir: dir,
      fetchSecrets: fakeSecrets,
    });
    const warn = issues.filter((i) => i.check === 'secrets' && i.severity === 'WARN');
    const crit = issues.filter((i) => i.check === 'secrets' && i.severity === 'CRITICAL');
    assert.equal(warn.length, 1);
    assert.equal(crit.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
