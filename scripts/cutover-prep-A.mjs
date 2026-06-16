#!/usr/bin/env node
/**
 * Cutover Prep A — カットオーバー前日 (Stage A) の 🟢 自律分を検証する冪等ランナー。
 *
 * `docs/CUTOVER_RUNBOOK.md` の Stage A を「一発で監査できる go/no-go チェック」に実体化したもの。
 * preflight.mjs が secret/migration を見るのに対し、 本スクリプトは **本番 D1 の seed 投入状態**
 * (A-4) と **Shopify webhook 購読** (A-5)、 本番 smoke (A-1) を検証する (相補的)。
 *
 * 何も書き換えない (--register を明示しない限り read-only)。 🔴 Katsu ゲート (A-2 secret 差替 /
 * A-6 OA Manager / リッチメニュー) は実行せず「未確認」として表示するだけ。
 *
 * 使い方:
 *   node scripts/cutover-prep-A.mjs                 # read-only 監査 (要 wrangler ログイン)
 *   API_KEY=xxx node scripts/cutover-prep-A.mjs     # + Shopify webhook 購読状態も検証
 *   API_KEY=xxx node scripts/cutover-prep-A.mjs --register   # 不足 webhook を登録してから検証
 *   node scripts/cutover-prep-A.mjs --no-color
 *
 * Exit codes:
 *   0  Stage A の自律分はすべて緑 (= B カットオーバーへ進める)
 *   1  ギャップあり (要対応)
 *   3  内部エラー
 *
 * テスト容易性のため pure function を export し、CLI は main() に閉じ込める。
 */

import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const WORKER_URL = process.env.WORKER_URL || 'https://naturism-line-crm.katsu-7d5.workers.dev';
const D1_NAME = process.env.D1_NAME || 'naturism-line-crm';

// ============================================================
// 期待値 (2026-06-16 本番実測を基準にした最小しきい値)
// ============================================================

/**
 * A-4 seed の期待。 min は「未投入 (空) を検出する」ための保守的な下限であって、
 * 厳密一致ではない (運用で件数が増減しても緑のまま)。 観測値は doc / コメントに記録。
 */
export const SEED_EXPECTATIONS = [
  { table: 'auto_replies', min: 10, label: 'キーワード自動応答 / FAQ', observed: 40 },
  { table: 'scenarios', min: 1, label: 'ウェルカムシナリオ', observed: 1 },
  { table: 'automations', min: 3, label: 'automation ルール', observed: 6 },
  { table: 'tags', min: 5, label: 'タグ', observed: 14 },
  { table: 'email_templates', min: 3, label: 'email テンプレート', observed: 7 },
  { table: 'broadcasts', min: 6, label: '月次ブロードキャスト', observed: 14 },
  { table: 'brand_config', min: 1, label: 'ブランド設定', observed: 1 },
  { table: 'shopify_products', min: 1, label: 'Shopify 商品同期', observed: 25 },
];

/** A-5: register エンドポイントが購読する Shopify webhook topic 一覧 (shopify.ts と同期)。 */
export const REQUIRED_SHOPIFY_TOPICS = [
  'orders/create',
  'orders/updated',
  'customers/create',
  'customers/update',
  'products/create',
  'products/update',
  'products/delete',
  'fulfillments/create',
  'fulfillments/update',
  'inventory_levels/update', // 再入荷通知の駆動 (#117)
];

/** 🔴 Katsu / 後続ゲート (本スクリプトは実行しない。 当日チェック用に列挙)。 */
export const GATED_ITEMS = [
  { id: 'A-2', label: '本番 OA secret 差替 (wrangler secret bulk)', owner: '🔴 Katsu' },
  { id: 'A-6', label: 'OA Manager 応答設定 (チャットON手動/応答・あいさつ OFF/AIボット不使用)', owner: '🔴 Katsu' },
  { id: 'A-4', label: 'リッチメニュー作成 (A-2 後・scripts/setup-rich-menu.mjs)', owner: '⏳ A-2 後' },
];

// ============================================================
// pure functions (テスト対象)
// ============================================================

/** wrangler d1 `--json` 出力 (SELECT COUNT(*) n ...) から件数を取り出す。 失敗時 null。 */
export function parseD1Count(stdout) {
  const m = String(stdout).match(/"n"\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** seed 件数を期待値と突合し、 結果行配列を返す。 */
export function evaluateSeed(counts, expectations = SEED_EXPECTATIONS) {
  return expectations.map((e) => {
    const n = counts[e.table];
    const ok = typeof n === 'number' && n >= e.min;
    return { id: 'A-4', table: e.table, label: e.label, count: n ?? null, min: e.min, ok };
  });
}

/** 登録済み topic 集合に必須 topic がすべて含まれるか。 */
export function checkTopics(registeredTopics, required = REQUIRED_SHOPIFY_TOPICS) {
  const set = new Set(registeredTopics || []);
  const missing = required.filter((t) => !set.has(t));
  return { ok: missing.length === 0, missing, registeredCount: set.size };
}

/** 全チェック行から go/no-go と exit code を決める。 gated / skipped は no-go にしない。 */
export function summarize(rows) {
  const gaps = rows.filter((r) => r.status === 'GAP');
  return { go: gaps.length === 0, gapCount: gaps.length, exitCode: gaps.length === 0 ? 0 : 1 };
}

// ============================================================
// I/O (テストでは exec / fetchImpl を注入)
// ============================================================

/** A-4: 本番 D1 の seed 件数を 1 テーブルずつ取得 (compound SELECT 上限回避)。 */
export function runSeedAudit({ exec = execSync, cwd = REPO_ROOT } = {}) {
  const counts = {};
  for (const e of SEED_EXPECTATIONS) {
    try {
      const out = exec(
        `npx --yes wrangler d1 execute ${D1_NAME} --remote --command "SELECT COUNT(*) n FROM ${e.table}" --json`,
        { cwd: join(cwd, 'apps/worker'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      counts[e.table] = parseD1Count(out);
    } catch {
      counts[e.table] = null;
    }
  }
  return counts;
}

/** A-3: migration 065 の証跡 = 全 shopify_products が inventory_item_id を持つか (0 件で OK)。 */
export function runInventoryCoverage({ exec = execSync, cwd = REPO_ROOT } = {}) {
  try {
    const out = exec(
      `npx --yes wrangler d1 execute ${D1_NAME} --remote --command "SELECT COUNT(*) n FROM shopify_products WHERE variants_json NOT LIKE '%inventory_item_id%'" --json`,
      { cwd: join(cwd, 'apps/worker'), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return parseD1Count(out);
  } catch {
    return null;
  }
}

/** A-1: 本番 worker root が 200 か。 */
export async function runSmoke({ fetchImpl = fetch, url = WORKER_URL } = {}) {
  try {
    const res = await fetchImpl(`${url}/`, { signal: AbortSignal.timeout(8000) });
    return res.status;
  } catch {
    return null;
  }
}

/** A-5: Shopify webhook 購読状態を worker API 経由で取得 (要 API_KEY)。 register=true で先に登録。 */
export async function runShopifyTopics({ fetchImpl = fetch, url = WORKER_URL, apiKey, register = false } = {}) {
  if (!apiKey) return { skipped: true, reason: 'API_KEY 未設定 (検証 skip)' };
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    if (register) {
      await fetchImpl(`${url}/api/integrations/shopify/webhooks/register`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(20000),
      });
    }
    const res = await fetchImpl(`${url}/api/integrations/shopify/webhooks`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { skipped: false, error: `API ${res.status}` };
    const json = await res.json();
    const list = json?.data?.webhooks ?? json?.data ?? [];
    const topics = Array.isArray(list) ? list.map((w) => w.topic).filter(Boolean) : [];
    return { skipped: false, ...checkTopics(topics) };
  } catch (err) {
    return { skipped: false, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}

// ============================================================
// CLI 出力
// ============================================================

const COLORS = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };
function color(text, c, useColor = true) {
  return useColor ? `${COLORS[c]}${text}${COLORS.reset}` : text;
}
function mark(status, useColor) {
  if (status === 'OK') return color('✅ OK  ', 'green', useColor);
  if (status === 'GAP') return color('⚠️ GAP ', 'yellow', useColor);
  if (status === 'GATE') return color('🔴 GATE', 'red', useColor);
  return color('• SKIP ', 'cyan', useColor);
}

// ============================================================
// メイン
// ============================================================

export async function gatherRows({ exec = execSync, fetchImpl = fetch, cwd = REPO_ROOT, apiKey, register = false } = {}) {
  const rows = [];

  // A-1 smoke
  const smoke = await runSmoke({ fetchImpl });
  rows.push({ id: 'A-1', label: `本番 worker root (${smoke ?? 'no response'})`, status: smoke === 200 ? 'OK' : 'GAP' });

  // A-3 inventory coverage (migration 065)
  const missingInv = runInventoryCoverage({ exec, cwd });
  rows.push({
    id: 'A-3',
    label: `inventory_item_id 欠落商品 (${missingInv ?? '?'})`,
    status: missingInv === 0 ? 'OK' : 'GAP',
  });

  // A-4 seed
  const counts = runSeedAudit({ exec, cwd });
  for (const r of evaluateSeed(counts)) {
    rows.push({ id: r.id, label: `${r.label} (${r.count ?? '?'} / 最低 ${r.min})`, status: r.ok ? 'OK' : 'GAP' });
  }

  // A-5 Shopify webhooks
  const topics = await runShopifyTopics({ fetchImpl, apiKey, register });
  if (topics.skipped) {
    rows.push({ id: 'A-5', label: `Shopify webhook 購読 — ${topics.reason}`, status: 'SKIP' });
  } else if (topics.error) {
    rows.push({ id: 'A-5', label: `Shopify webhook 購読 — エラー: ${topics.error}`, status: 'GAP' });
  } else {
    rows.push({
      id: 'A-5',
      label: topics.ok
        ? `Shopify webhook 全 ${REQUIRED_SHOPIFY_TOPICS.length} topic 購読済`
        : `Shopify webhook 不足: ${topics.missing.join(', ')}`,
      status: topics.ok ? 'OK' : 'GAP',
    });
  }

  return rows;
}

async function main(argv) {
  const args = new Set(argv.slice(2));
  const useColor = !args.has('--no-color');
  const register = args.has('--register');
  const apiKey = process.env.API_KEY;

  console.log(color('\n━━━ Cutover Prep A — Stage A 自律分チェック ━━━', 'cyan', useColor));
  console.log(color(`worker: ${WORKER_URL} / D1: ${D1_NAME}`, 'dim', useColor));

  let rows;
  try {
    rows = await gatherRows({ apiKey, register });
  } catch (err) {
    console.error(color(`内部エラー: ${err instanceof Error ? err.message : err}`, 'red', useColor));
    return 3;
  }

  console.log('');
  for (const r of rows) {
    console.log(`  ${mark(r.status, useColor)}  [${r.id}] ${r.label}`);
  }

  console.log(color('\n  ── 🔴 Katsu / 後続ゲート (本スクリプトは実行しない) ──', 'dim', useColor));
  for (const g of GATED_ITEMS) {
    console.log(`  ${mark('GATE', useColor)}  [${g.id}] ${g.label}  ${color(g.owner, 'dim', useColor)}`);
  }

  const { go, gapCount, exitCode } = summarize(rows);
  console.log('');
  if (go) {
    console.log(color('Stage A 自律分はすべて緑 ✓ — 🔴 ゲート (A-2/A-6) を Katsu が済ませれば B へ。', 'green', useColor));
  } else {
    console.log(color(`⚠️ ${gapCount} 件のギャップあり。 上記 GAP を解消してから B へ。`, 'yellow', useColor));
  }
  if (!apiKey) {
    console.log(color('  ※ A-5 は API_KEY 未設定のため skip。 `API_KEY=xxx node scripts/cutover-prep-A.mjs` で検証可。', 'dim', useColor));
  }
  return exitCode;
}

// CLI として実行された時のみ main を走らせる (import 時は pure functions だけ使える)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cutover-prep-A.mjs')) {
  main(process.argv).then((code) => process.exit(code)).catch((err) => {
    console.error(err);
    process.exit(3);
  });
}
