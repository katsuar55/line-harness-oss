#!/usr/bin/env node
/**
 * Phase 5β-1d-2b: naturism Welcome シナリオ step 2 (text) に
 * LINE 友だち追加クーポン用の {{#if_coupon}} block を末尾追記する。
 *
 * 動作:
 *   1. scenarios.naturism-welcome-v1 の step_order=2 の message_content を取得
 *   2. 末尾に COUPON_BLOCK が既に含まれていれば skip (idempotent)
 *   3. なければ末尾に追記して UPDATE
 *
 * 使い方:
 *   node scripts/update-welcome-scenario-add-coupon.mjs                # dry-run (SQL preview)
 *   node scripts/update-welcome-scenario-add-coupon.mjs --local        # local D1
 *   node scripts/update-welcome-scenario-add-coupon.mjs --remote --force  # 本番 D1
 *
 * 前提:
 *   - PR #31 (5β-1d-2a) merge + worker deploy 済 (issueCouponForFriend が webhook で動作)
 *   - PR #32 (5β-1d-2b) merge + worker deploy 済 (expandVariables が {{#if_coupon}} 対応)
 *   - Shopify scope (write_discounts, write_price_rules) を Katsu が grant 済
 *
 * Exit codes: 0 OK / 1 CLI error / 2 internal error
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const D1_DATABASE_NAME = 'naturism-line-crm';

const SCENARIO_ID = 'naturism-welcome-v1';
const STEP_ORDER = 2;

const COUPON_BLOCK = `\n{{#if_coupon}}\n\n🎁 あなた専用 500 円 OFF クーポン\n\`{{line_friend_coupon_code}}\`\n初回ご注文限定 (発行日から 90 日間有効)\nnaturism-diet.com でご利用いただけます\n{{/if_coupon}}`;

// SQLite で末尾の COUPON_BLOCK を idempotent に追記するため、 既に含まれていない場合のみ UPDATE
// (CASE WHEN ... THEN ... ELSE message_content END で no-op)
function buildUpdateSql() {
  // signature 文字列: {{#if_coupon}} を含めば既に追記済とみなす
  const signature = '{{#if_coupon}}';
  const escapedBlock = COUPON_BLOCK.replace(/'/g, "''");
  const escapedSignature = signature.replace(/'/g, "''");
  // 注: scenario_steps テーブルには updated_at column が無い (schema.sql 確認済、 created_at のみ)
  return `UPDATE scenario_steps
SET message_content = CASE
  WHEN message_content LIKE '%${escapedSignature}%' THEN message_content
  ELSE message_content || '${escapedBlock}'
END
WHERE scenario_id = '${SCENARIO_ID}' AND step_order = ${STEP_ORDER};`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    local: args.includes('--local'),
    remote: args.includes('--remote'),
    force: args.includes('--force'),
  };
}

function main() {
  const { local, remote, force } = parseArgs(process.argv);
  const sql = buildUpdateSql();

  if (!local && !remote) {
    console.log('=== DRY-RUN (SQL preview only、 投入には --local or --remote --force 必要) ===');
    console.log(sql);
    console.log('\n投入する場合:');
    console.log('  node scripts/update-welcome-scenario-add-coupon.mjs --local');
    console.log('  node scripts/update-welcome-scenario-add-coupon.mjs --remote --force');
    process.exit(0);
  }

  if (remote && !force) {
    console.error('本番 D1 投入には --force flag が必須 (誤投入防止)');
    process.exit(1);
  }

  // wrangler d1 execute は --command または --file。 ここでは --command で短く済ませる
  const target = local ? '--local' : '--remote';
  const cmd = `npx wrangler --config apps/worker/wrangler.toml d1 execute ${D1_DATABASE_NAME} ${target} --command "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

  console.log(`実行: ${target}`);
  try {
    const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' });
    console.log(out);
    console.log('[update-welcome-scenario] ✅ 投入完了 (idempotent、 既に追記済みなら no-op)');
  } catch (err) {
    console.error('[update-welcome-scenario] ❌ 失敗');
    console.error(err.message ?? err);
    process.exit(2);
  }
}

main();
