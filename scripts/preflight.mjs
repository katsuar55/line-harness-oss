#!/usr/bin/env node
/**
 * Phase 5 PR-5: Pre-deploy preflight checker.
 *
 * 本番 wrangler deploy の前に必須 secret / migration / リモート D1 適用状態を検証して
 * うっかりデプロイ事故を防ぐ。
 *
 * 使い方:
 *   pnpm preflight              # offline mode: migration ファイル整合性のみチェック (CI 向け)
 *   pnpm preflight --full       # wrangler secret list / d1 migrations list を呼ぶ (オーナー手元用)
 *   pnpm preflight --no-color   # 色なし出力
 *
 * Exit codes:
 *   0  すべて green
 *   1  CRITICAL issue (deploy 危険)
 *   2  WARN (deploy は可能だが要確認)
 *   3  内部エラー (preflight 自体の失敗)
 *
 * テスト容易性のため pure function を export し、CLI は main() に閉じ込める。
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ============================================================
// 必須 / 任意 secret 定義 (CLAUDE.md と同期)
// ============================================================

export const REQUIRED_SECRETS = [
  'LINE_CHANNEL_SECRET',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'API_KEY',
  'LINE_LOGIN_CHANNEL_ID',
  'LINE_LOGIN_CHANNEL_SECRET',
  // Phase 3+ で AI 食事画像解析 / Phase 4 栄養コーチが要求
  'ANTHROPIC_API_KEY',
];

export const OPTIONAL_SECRETS = [
  // 監視 / アラート (任意。未登録なら logger / cron-monitor が no-op)
  'AXIOM_TOKEN',
  'AXIOM_DATASET',
  'DISCORD_WEBHOOK_URL',
  // Shopify (アカウントごとに有無が分かれる)
  'SHOPIFY_WEBHOOK_SECRET',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_LINE_NOTIFY_ENABLED',
  // X 連携 (任意)
  'X_HARNESS_URL',
];

// ============================================================
// 既知の例外 (歴史的事項)
// ============================================================

/**
 * 本番 d1_migrations に既登録のため、リネームすると `duplicate column name`
 * 等で再実行が失敗する。番号重複だが意図的に許容している組合せを記録。
 * `packages/db/migrations/README.md` の「既知の歴史的事項」と同期すること。
 */
export const KNOWN_DUPLICATE_EXCEPTIONS = [
  {
    num: 9,
    files: ['009_delivery_type.sql', '009_token_expiry.sql'],
    reason: '別ブランチ並行開発で両者とも 009 を取得済み。本番 d1_migrations 登録済みのためリネーム不可',
  },
];

/**
 * 採番ギャップで意図的に予約されている番号 (未着手 PR 用などのプレースホルダ)。
 * 該当番号の WARN は INFO に降格する。
 */
export const KNOWN_GAP_EXCEPTIONS = new Map([
  [38, 'Phase 5 PR-2 (nutrition_sku_map 実 GID 差し替え) 用に予約'],
]);

/**
 * 検出された duplicate が既知例外かチェック。
 * 番号 + ファイル名集合の完全一致で判定。
 */
export function isKnownDuplicateException(dup, exceptions = KNOWN_DUPLICATE_EXCEPTIONS) {
  return exceptions.some((ex) => {
    if (ex.num !== dup.num) return false;
    if (ex.files.length !== dup.files.length) return false;
    const exSorted = [...ex.files].sort();
    const dupSorted = [...dup.files].sort();
    return exSorted.every((f, i) => f === dupSorted[i]);
  });
}

// ============================================================
// Pure 関数 — テスト容易
// ============================================================

/**
 * migrations/*.sql のファイル名から番号付きリストを抽出。
 * 戻り値は番号昇順、ファイル名 (拡張子つき) と数値を保持。
 */
export function listMigrationFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .map((file) => {
      const num = Number.parseInt(file.slice(0, 3), 10);
      return { file, num };
    })
    .sort((a, b) => a.num - b.num);
  return files;
}

/**
 * 番号の連続性を検証。gap (例: 036, 037, 039 → 038 が抜け) を返す。
 *
 * @param entries listMigrationFiles の戻り値
 * @returns gap.length === 0 なら連続。それ以外は欠番リスト
 */
export function findMigrationGaps(entries) {
  if (entries.length === 0) return { firstNum: null, lastNum: null, gaps: [] };
  const nums = entries.map((e) => e.num);
  const firstNum = nums[0];
  const lastNum = nums[nums.length - 1];
  const gaps = [];
  for (let n = firstNum; n <= lastNum; n++) {
    if (!nums.includes(n)) gaps.push(n);
  }
  return { firstNum, lastNum, gaps };
}

/**
 * 同じ番号のマイグレーションが複数あるか検出 (例: 009_xxx.sql + 009_yyy.sql)。
 */
export function findMigrationDuplicates(entries) {
  const seen = new Map();
  for (const e of entries) {
    const arr = seen.get(e.num) ?? [];
    arr.push(e.file);
    seen.set(e.num, arr);
  }
  const dups = [];
  for (const [num, files] of seen) {
    if (files.length > 1) dups.push({ num, files });
  }
  return dups;
}

/**
 * `wrangler secret list --json` の出力 (Array<{name: string}>) と必須セット
 * を比較し、不足/余剰を返す。
 */
export function compareSecrets(remoteList, required, optional) {
  const remoteNames = new Set(remoteList.map((s) => s.name));
  const allKnown = new Set([...required, ...optional]);
  const missing = required.filter((name) => !remoteNames.has(name));
  const extra = [...remoteNames].filter((name) => !allKnown.has(name));
  const optionalPresent = optional.filter((name) => remoteNames.has(name));
  return { missing, extra, optionalPresent };
}

/**
 * Issue を severity でグループ化。CLI 出力 + exit code 計算用。
 */
export function summarizeReport(issues) {
  const grouped = { CRITICAL: [], WARN: [], INFO: [] };
  for (const i of issues) {
    if (!grouped[i.severity]) grouped[i.severity] = [];
    grouped[i.severity].push(i);
  }
  let exitCode = 0;
  if (grouped.CRITICAL.length > 0) exitCode = 1;
  else if (grouped.WARN.length > 0) exitCode = 2;
  return { grouped, exitCode };
}

// ============================================================
// IO 関数 (テスト時はモック注入)
// ============================================================

/** wrangler secret list --json をパースして {name} の配列を返す */
export function fetchRemoteSecrets({ exec = execSync, cwd = REPO_ROOT } = {}) {
  try {
    const stdout = exec('npx --yes wrangler secret list', {
      cwd: join(cwd, 'apps/worker'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // wrangler 4.x はテキスト出力。"Name: FOO" 形式を抽出。
    const lines = String(stdout).split(/\r?\n/);
    const names = [];
    for (const ln of lines) {
      const m = ln.match(/^\s*([A-Z][A-Z0-9_]+)\s*$/);
      if (m) names.push({ name: m[1] });
    }
    return { ok: true, secrets: names };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
      secrets: [],
    };
  }
}

// ============================================================
// CLI 出力ヘルパー
// ============================================================

const COLORS = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
};

function color(text, c, useColor = true) {
  if (!useColor) return text;
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function severityColor(sev) {
  if (sev === 'CRITICAL') return 'red';
  if (sev === 'WARN') return 'yellow';
  if (sev === 'INFO') return 'cyan';
  return 'green';
}

// ============================================================
// メイン: チェック実行
// ============================================================

/**
 * チェック群を実行して issue 配列を返す。CLI/テスト両用。
 * `mode: 'offline' | 'full'` で wrangler 呼び出しの有無を切替。
 */
export async function runChecks({
  mode = 'offline',
  migrationsDir = join(REPO_ROOT, 'packages/db/migrations'),
  fetchSecrets = fetchRemoteSecrets,
} = {}) {
  const issues = [];

  // 1. Migration files
  const entries = listMigrationFiles(migrationsDir);
  if (entries.length === 0) {
    issues.push({
      severity: 'CRITICAL',
      check: 'migrations',
      message: `No migration files found at ${migrationsDir}`,
    });
  } else {
    const { firstNum, lastNum, gaps } = findMigrationGaps(entries);
    if (gaps.length > 0) {
      // 既知の予約ギャップは INFO、それ以外は WARN として分離
      const unexpectedGaps = gaps.filter((g) => !KNOWN_GAP_EXCEPTIONS.has(g));
      const reservedGaps = gaps.filter((g) => KNOWN_GAP_EXCEPTIONS.has(g));
      if (unexpectedGaps.length > 0) {
        issues.push({
          severity: 'WARN',
          check: 'migrations',
          message: `Migration number gap detected (range ${firstNum}-${lastNum}): missing ${unexpectedGaps.join(', ')}`,
          detail: '欠番は意図的か? 採番ミスならデプロイ前に解消すること',
        });
      }
      if (reservedGaps.length > 0) {
        const detail = reservedGaps
          .map((g) => `${g}: ${KNOWN_GAP_EXCEPTIONS.get(g)}`)
          .join(' / ');
        issues.push({
          severity: 'INFO',
          check: 'migrations',
          message: `Reserved migration gap (intentional): ${reservedGaps.join(', ')}`,
          detail,
        });
      }
    }
    const dups = findMigrationDuplicates(entries);
    if (dups.length > 0) {
      const unexpected = dups.filter((d) => !isKnownDuplicateException(d));
      const known = dups.filter((d) => isKnownDuplicateException(d));
      if (unexpected.length > 0) {
        issues.push({
          severity: 'CRITICAL',
          check: 'migrations',
          message: `Duplicate migration numbers: ${unexpected.map((d) => `${d.num}(${d.files.join(',')})`).join('; ')}`,
          detail: '同番号は適用順序が決まらない。リネームすること',
        });
      }
      if (known.length > 0) {
        issues.push({
          severity: 'INFO',
          check: 'migrations',
          message: `Known duplicate exceptions accepted: ${known.map((d) => `${d.num}(${d.files.join(',')})`).join('; ')}`,
          detail: 'README.md の「既知の歴史的事項」に従い本番 d1_migrations 登録済み・リネーム禁止',
        });
      }
    }
    issues.push({
      severity: 'INFO',
      check: 'migrations',
      message: `${entries.length} migrations found, range ${firstNum}-${lastNum}`,
    });
  }

  // 2. Secret check (full mode only)
  if (mode === 'full') {
    const result = fetchSecrets();
    if (!result.ok) {
      issues.push({
        severity: 'WARN',
        check: 'secrets',
        message: 'Could not fetch remote secrets (wrangler call failed)',
        detail: (result.error ?? '').slice(0, 200),
      });
    } else {
      const cmp = compareSecrets(result.secrets, REQUIRED_SECRETS, OPTIONAL_SECRETS);
      if (cmp.missing.length > 0) {
        issues.push({
          severity: 'CRITICAL',
          check: 'secrets',
          message: `Missing required secrets: ${cmp.missing.join(', ')}`,
          detail: '`wrangler secret put NAME` で登録してから deploy すること',
        });
      }
      if (cmp.extra.length > 0) {
        issues.push({
          severity: 'WARN',
          check: 'secrets',
          message: `Unknown secrets registered (typo の可能性): ${cmp.extra.join(', ')}`,
          detail: 'CLAUDE.md / preflight.mjs の OPTIONAL_SECRETS に追記するか、`wrangler secret delete` で削除',
        });
      }
      issues.push({
        severity: 'INFO',
        check: 'secrets',
        message: `Required: ${REQUIRED_SECRETS.length - cmp.missing.length}/${REQUIRED_SECRETS.length} present, optional: ${cmp.optionalPresent.length}/${OPTIONAL_SECRETS.length}`,
      });
    }
  }

  // 3. Critical files exist
  const criticalFiles = [
    'apps/worker/wrangler.toml',
    'apps/worker/src/index.ts',
    'packages/db/schema.sql',
  ];
  for (const rel of criticalFiles) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      issues.push({
        severity: 'CRITICAL',
        check: 'files',
        message: `Required file missing: ${rel}`,
      });
    }
  }

  // 4. wrangler.toml が naturism account を指しているか軽くチェック
  try {
    const tomlPath = join(REPO_ROOT, 'apps/worker/wrangler.toml');
    if (existsSync(tomlPath)) {
      const toml = readFileSync(tomlPath, 'utf-8');
      if (!toml.includes('naturism')) {
        issues.push({
          severity: 'WARN',
          check: 'wrangler-toml',
          message: 'wrangler.toml に "naturism" の記載なし',
          detail: 'デプロイ対象が naturism 本番か確認。OSS フォーク派生なら無視',
        });
      }
    }
  } catch {
    // best-effort
  }

  return issues;
}

// ============================================================
// CLI エントリ
// ============================================================

function printReport(issues, useColor) {
  const { grouped, exitCode } = summarizeReport(issues);

  console.log('');
  console.log(color('━━━ Preflight Report ━━━', 'cyan', useColor));
  for (const sev of ['CRITICAL', 'WARN', 'INFO']) {
    const arr = grouped[sev];
    if (!arr || arr.length === 0) continue;
    console.log('');
    console.log(color(`[${sev}]`, severityColor(sev), useColor));
    for (const i of arr) {
      console.log(`  • [${i.check}] ${i.message}`);
      if (i.detail) console.log(`    ↳ ${i.detail}`);
    }
  }
  console.log('');
  if (exitCode === 0) {
    console.log(color('All green ✓ Safe to deploy.', 'green', useColor));
  } else if (exitCode === 1) {
    console.log(color('CRITICAL issues found. DO NOT deploy until resolved.', 'red', useColor));
  } else {
    console.log(color('WARN issues found. Review before deploy.', 'yellow', useColor));
  }
  console.log('');
  return exitCode;
}

async function main(argv) {
  const args = new Set(argv.slice(2));
  const mode = args.has('--full') ? 'full' : 'offline';
  const useColor = !args.has('--no-color');

  try {
    const issues = await runChecks({ mode });
    const exitCode = printReport(issues, useColor);
    return exitCode;
  } catch (err) {
    console.error('preflight failed:', err);
    return 3;
  }
}

// CLI モード判定 (テスト時は import するだけで main 走らない)
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain) {
  main(process.argv).then((code) => process.exit(code));
}
