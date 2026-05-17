#!/usr/bin/env node
/**
 * Phase 5α-9: 既存 email_templates の hardcode "naturism" 等を {{brand_name}} 等に migrate
 *
 * 目的:
 *   案 C ハイブリッド (Ultraplan v4): 5α-1 で hardcode 投入済の 5 templates を
 *   brand 変数化版に上書きする。 投入は seed-email-templates.mjs (brand 変数版) を
 *   --remote --force で再実行する方が clean なので、 本 script は **検証 + 補助** 用途。
 *
 *   想定使用:
 *   1. 本 script で migrate SQL を生成 (--output)
 *   2. 必要なら直接 --remote --force で実行 (idempotent な REPLACE)
 *   3. 通常は seed-email-templates.mjs --remote --force で UPSERT (推奨)
 *
 * 設計方針:
 *   - REPLACE は **長い文字列を先に置換** (subscription_url を shop_url の前に処理)
 *   - 1 列ずつ UPDATE (subject / html_content / text_content / preheader)
 *   - WHERE id LIKE 'tpl-%' で seed テンプレのみ対象 (DMARC test 等を巻き込まない)
 *   - brand_id は NULL のまま (= default brand = naturism via brand_config.is_default=1)
 *
 * 使い方:
 *   node scripts/migrate-templates-to-brand-vars.mjs               # dry-run
 *   node scripts/migrate-templates-to-brand-vars.mjs --output PATH # SQL 出力
 *   node scripts/migrate-templates-to-brand-vars.mjs --remote --force  # 本番実行
 */

import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const D1_DATABASE_NAME = 'naturism-line-crm';

/**
 * 置換ルール: [ from, to ] の配列。 順序重要 (長い文字列を先に処理)。
 * 例: subscription_url を shop_url の前に置換 (URL prefix が同じため)。
 */
export const REPLACEMENTS = [
  // URL 系 (長い prefix を先に)
  ['https://naturism-diet.com/pages/subscription', '{{subscription_url}}'],
  ['https://naturism-diet.com', '{{shop_url}}'],
  // メール
  ['support@naturism-diet.com', '{{support_email}}'],
  // 商品ラベル
  ['Blue 7日分（42粒）¥696', '{{intro_product_label}}'],
  // 法人名
  ['株式会社ケンコーエクスプレス', '{{company_name}}'],
  // ブランド名 (最後 — "naturism" は他の文字列の部分一致を起こすため)
  ['naturism', '{{brand_name}}'],
  // 色 (UI 系 hex)
  ['#06C755', '{{primary_color}}'],
];

const COLUMNS = ['subject', 'html_content', 'text_content', 'preheader', 'name'];

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** ネストした REPLACE 関数を 1 列分生成 */
export function buildReplaceExpression(column) {
  let expr = column;
  for (const [from, to] of REPLACEMENTS) {
    expr = `REPLACE(${expr}, '${sqlEscape(from)}', '${sqlEscape(to)}')`;
  }
  return expr;
}

export function buildMigrateSql() {
  const setClauses = COLUMNS.map((col) => `  ${col} = ${buildReplaceExpression(col)}`).join(',\n');
  return `-- ============================================================
-- Phase 5α-9: email_templates 既存 hardcode → brand 変数 migrate
-- Generated: ${new Date().toISOString()}
-- 対象: id LIKE 'tpl-%' (5 templates)
-- 冪等: 既に置換済の場合は no-op (REPLACE は match しなければ無変化)
-- ============================================================

UPDATE email_templates SET
${setClauses},
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
WHERE id LIKE 'tpl-%';

-- 結果確認: brand 変数化されたか (naturism 残存件数 = 0 になるべき)
SELECT id, name, category,
  (CASE WHEN html_content LIKE '%naturism%' OR html_content LIKE '%ケンコーエクスプレス%' THEN 'HARDCODE残存' ELSE 'OK' END) AS status,
  length(html_content) AS html_len
FROM email_templates
WHERE id LIKE 'tpl-%'
ORDER BY id;
`;
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = { dryRun: true, remote: false, force: false, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote') { args.remote = true; args.dryRun = false; }
    else if (a === '--force') { args.force = true; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--output') { args.output = argv[++i]; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-templates-to-brand-vars.mjs [options]

Options:
  --dry-run       SQL を stdout (default)
  --output PATH   SQL を PATH へ書き出し
  --remote        本番 D1 で実行 (要 --force)
  --force         本番実行の確認スキップ
  --help, -h      ヘルプ表示
`);
}

function execWrangler(sqlPath, { remote }) {
  const flag = remote ? '--remote' : '--local';
  const cmd = `pnpm --filter worker exec wrangler d1 execute ${D1_DATABASE_NAME} ${flag} --file=${sqlPath}`;
  console.error(`[migrate-templates] $ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv);
  const sql = buildMigrateSql();

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, sql, 'utf8');
    console.error(`[migrate-templates] Wrote SQL to ${args.output}`);
  }

  if (args.dryRun) {
    process.stdout.write(sql);
    return;
  }

  if (args.remote && !args.force) {
    console.error('ERROR: --remote requires --force');
    process.exit(1);
  }

  const tmpPath = join(tmpdir(), `migrate-templates-${Date.now()}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    execWrangler(tmpPath, { remote: args.remote });
    console.error(`[migrate-templates] ✅ ${args.remote ? '本番' : 'ローカル'} D1 migrate 完了`);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* */ }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
