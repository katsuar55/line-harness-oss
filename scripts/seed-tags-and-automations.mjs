#!/usr/bin/env node
/**
 * Phase 5α-2: tags + automations seed
 *
 * 目的:
 *   業種非依存コア + naturism 専用に分離した tags / automations を idempotent に投入する。
 *
 * 設計方針 (大方針 2 「汎用性 multi-brand/industry」 反映):
 *   - **コア tags (9 件)**: 業種非依存。 全 brand で再利用 (新規 / アクティブ / 休眠 / VIP / ブロック / 初回 / リピーター / 高 LTV / Email opt-in 済)
 *   - **naturism 特化 tags (5 件)**: Phase 5κ で plugin 切出し対象 (Blue/Pink/Premium ユーザー / 食事診断完了 / 栄養コーチ利用)
 *   - **コア automations (3 件)**: friend_add → welcome email + 新規タグ付与、 cv_fire → アクティブタグ付与
 *   - **naturism 特化 automations (3 件)**: food_logged → 栄養コーチタグ、 intake_log → 診断完了タグ
 *
 * 重要な scope 制約 (2026-05-12 発見):
 *   現状 send_email action (apps/worker/src/services/send-email-action.ts) は variables を
 *   `{ name: display_name }` しか展開しない。
 *   → {{order_number}} 等の送信時 var が必要な order_confirmation / shipping_notification /
 *     cart_recovery / reorder_reminder の automation は **scope 外**。
 *     Phase 5β-X で send_email action に variables passthrough を追加した後に再着手。
 *
 * 冪等性:
 *   - tags: INSERT INTO ... ON CONFLICT(id) DO UPDATE SET ...
 *   - automations: 同上
 *
 * 使い方:
 *   node scripts/seed-tags-and-automations.mjs                   # dry-run (default)
 *   node scripts/seed-tags-and-automations.mjs --local           # ローカル D1 投入
 *   node scripts/seed-tags-and-automations.mjs --remote --force  # 本番投入 (Katsu 承認後)
 *   node scripts/seed-tags-and-automations.mjs --output PATH     # SQL を PATH へ書き出し
 *
 * Exit codes: 0 OK / 1 CLI error / 2 internal error
 */

import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const D1_DATABASE_NAME = 'naturism-line-crm';

// ============================================================
// Tag 定義 (14 件)
// ============================================================

/**
 * @typedef {Object} TagEntry
 * @property {string} id     - tags.id (slug 形式、 automation actions から参照する)
 * @property {string} name   - tags.name (UNIQUE 制約あり)
 * @property {string} color  - tags.color (#hex)
 * @property {'core'|'naturism-plugin'} kind
 * @property {string} note
 */

/** @type {TagEntry[]} */
export const TAGS = [
  // ----- コア (業種非依存) - 9 件 -----
  { id: 'tag-status-new', name: '新規友だち', color: '#3B82F6', kind: 'core',
    note: 'コア。 friend_add で自動付与。 オンボード対象判定に使う。' },
  { id: 'tag-status-active', name: 'アクティブ', color: '#10B981', kind: 'core',
    note: 'コア。 cv_fire や購入完了で付与。 marketing 対象。' },
  { id: 'tag-status-dormant', name: '休眠', color: '#6B7280', kind: 'core',
    note: 'コア。 90 日無アクション cron で付与。 復活施策対象。' },
  { id: 'tag-status-vip', name: 'VIP', color: '#F59E0B', kind: 'core',
    note: 'コア。 LTV 上位 5% に運用者が手動付与。 限定キャンペーン対象。' },
  { id: 'tag-status-blocked', name: 'ブロック中', color: '#EF4444', kind: 'core',
    note: 'コア。 friend.is_blacklisted から ETL 同期。 配信除外用。' },
  { id: 'tag-purchase-first', name: '初回購入', color: '#84CC16', kind: 'core',
    note: 'コア。 1 回目の purchase_completed で付与。 initial_thank_you 対象。' },
  { id: 'tag-purchase-repeat', name: 'リピーター', color: '#22C55E', kind: 'core',
    note: 'コア。 2 回目以降の purchase_completed で付与。 cross_sell 対象。' },
  { id: 'tag-purchase-high-ltv', name: '高 LTV', color: '#A855F7', kind: 'core',
    note: 'コア。 累計購入 30,000 円以上で付与。 VIP 候補。' },
  { id: 'tag-email-opted-in', name: 'Email opt-in 済', color: '#14B8A6', kind: 'core',
    note: 'コア。 email_subscribers.is_active=1 から ETL 同期。 marketing 配信対象。' },

  // ----- naturism 特化 (Phase 5κ plugin 切出し対象) - 5 件 -----
  { id: 'tag-naturism-blue-user', name: 'Blue ユーザー', color: '#06B6D4', kind: 'naturism-plugin',
    note: 'naturism plugin。 Blue (7694090469629) 購入者に付与 (cron で SKU 判定)。' },
  { id: 'tag-naturism-pink-user', name: 'Pink ユーザー', color: '#EC4899', kind: 'naturism-plugin',
    note: 'naturism plugin。 Pink (7694096367869) 購入者に付与。' },
  { id: 'tag-naturism-premium-user', name: 'Premium ユーザー', color: '#FCD34D', kind: 'naturism-plugin',
    note: 'naturism plugin。 Premium (9081674006781) 購入者に付与。 20 日サイクルリピート。' },
  { id: 'tag-naturism-diagnosed', name: '食事診断完了', color: '#F97316', kind: 'naturism-plugin',
    note: 'naturism plugin。 LIFF intake_log で付与。' },
  { id: 'tag-naturism-coach-active', name: '栄養コーチ利用中', color: '#16A34A', kind: 'naturism-plugin',
    note: 'naturism plugin。 food_logged で付与。 30 日間更新なしで OFF。' },
];

// ============================================================
// Automation 定義 (6 件)
// ============================================================

/**
 * @typedef {Object} AutomationEntry
 * @property {string} id          - automations.id
 * @property {string} name
 * @property {string} description
 * @property {string} eventType   - 既知: friend_add / message_received / purchase_completed / cv_fire / tag_change / food_logged / intake_log
 * @property {Object} conditions  - 空 {} なら常時マッチ
 * @property {Array}  actions     - [{ type, params }]
 * @property {number} priority    - 高優先度を先に実行
 * @property {'core'|'naturism-plugin'} kind
 * @property {string} note
 */

/** @type {AutomationEntry[]} */
export const AUTOMATIONS = [
  // ----- コア (業種非依存) - 3 件 -----
  {
    id: 'auto-friend-add-tag-new',
    name: '友だち追加 → 新規タグ付与',
    description: 'friend_add イベントで「新規友だち」タグを自動付与する。 オンボードシナリオ起点。',
    eventType: 'friend_add',
    conditions: {},
    actions: [{ type: 'add_tag', params: { tagId: 'tag-status-new' } }],
    priority: 100, // tag 系は早く実行
    kind: 'core',
    note: 'コア。 全 brand で再利用可能。',
  },
  {
    id: 'auto-friend-add-welcome-email',
    name: '友だち追加 → ウェルカム email 送信',
    description: 'friend_add で welcome (transactional) を送信。 email_subscribers 紐付済が前提 (LIFF opt-in 後)。',
    eventType: 'friend_add',
    conditions: {},
    actions: [
      {
        type: 'send_email',
        params: {
          templateId: 'tpl-welcome-v1',
          category: 'transactional',
        },
      },
    ],
    priority: 50,
    kind: 'core',
    note: 'コア。 send_email action は variables={name} のみ自動展開 (現状制約)。 welcome は {{name}} だけ使うので問題なし。',
  },
  {
    id: 'auto-cv-fire-tag-active',
    name: 'コンバージョン → アクティブタグ付与',
    description: 'cv_fire / purchase_completed で「アクティブ」 タグを自動付与。 dormant の自動解除も兼ねる。',
    eventType: 'cv_fire',
    conditions: {},
    actions: [{ type: 'add_tag', params: { tagId: 'tag-status-active' } }],
    priority: 100,
    kind: 'core',
    note: 'コア。 purchase_completed 用は別 automation で同じ action (event_type 1 つしか持てないため複製)。',
  },
  {
    id: 'auto-purchase-tag-active',
    name: '購入完了 → アクティブタグ付与',
    description: 'purchase_completed (Shopify webhook) で「アクティブ」 タグを自動付与。',
    eventType: 'purchase_completed',
    conditions: {},
    actions: [{ type: 'add_tag', params: { tagId: 'tag-status-active' } }],
    priority: 100,
    kind: 'core',
    note: 'コア。 cv_fire 用と分離 (Shopify or Stripe どちらの起点でも反応するため)。',
  },

  // ----- naturism 特化 (Phase 5κ plugin 切出し対象) - 2 件 -----
  {
    id: 'auto-naturism-food-logged-tag-coach',
    name: 'food_logged → 栄養コーチ利用中タグ',
    description: 'food_logged イベント (LIFF 食事記録) で栄養コーチ利用中タグを自動付与。 30 日 inactive で cron が remove。',
    eventType: 'food_logged',
    conditions: {},
    actions: [{ type: 'add_tag', params: { tagId: 'tag-naturism-coach-active' } }],
    priority: 100,
    kind: 'naturism-plugin',
    note: 'naturism plugin。 Phase 5κ で packages/plugin-naturism/ に移管。',
  },
  {
    id: 'auto-naturism-intake-log-tag-diagnosed',
    name: 'intake_log → 食事診断完了タグ',
    description: 'intake_log イベント (LIFF intake) で食事診断完了タグを自動付与。',
    eventType: 'intake_log',
    conditions: {},
    actions: [{ type: 'add_tag', params: { tagId: 'tag-naturism-diagnosed' } }],
    priority: 100,
    kind: 'naturism-plugin',
    note: 'naturism plugin。 Phase 5κ で plugin 切出し。',
  },
];

// ============================================================
// 整合性チェック
// ============================================================

/** automations.actions が参照する tag id がすべて TAGS に存在するか検証 */
export function validateTagReferences() {
  const tagIds = new Set(TAGS.map((t) => t.id));
  const errors = [];
  for (const a of AUTOMATIONS) {
    for (const action of a.actions) {
      if (action.type === 'add_tag' || action.type === 'remove_tag') {
        const refId = action.params.tagId;
        if (!tagIds.has(refId)) {
          errors.push(`automation ${a.id}: action ${action.type} references unknown tag '${refId}'`);
        }
      }
    }
  }
  return errors;
}

// ============================================================
// SQL 生成
// ============================================================

export function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** Tag UPSERT SQL (created_at 保持) */
export function buildTagUpsertSql(t) {
  const v = (s) => `'${sqlEscape(s)}'`;
  return `INSERT INTO tags (id, name, color)
VALUES (${v(t.id)}, ${v(t.name)}, ${v(t.color)})
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  color = excluded.color;`;
}

/** Automation UPSERT SQL (created_at 保持、 updated_at 更新) */
export function buildAutomationUpsertSql(a) {
  const v = (s) => `'${sqlEscape(s)}'`;
  const conditions = JSON.stringify(a.conditions ?? {});
  const actions = JSON.stringify(a.actions);
  return `INSERT INTO automations (id, name, description, event_type, conditions, actions, is_active, priority)
VALUES (
  ${v(a.id)},
  ${v(a.name)},
  ${v(a.description)},
  ${v(a.eventType)},
  ${v(conditions)},
  ${v(actions)},
  1,
  ${a.priority}
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  event_type = excluded.event_type,
  conditions = excluded.conditions,
  actions = excluded.actions,
  is_active = excluded.is_active,
  priority = excluded.priority,
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours');`;
}

export function buildAllSql(tags = TAGS, automations = AUTOMATIONS) {
  const tagCore = tags.filter((t) => t.kind === 'core').length;
  const tagPlugin = tags.filter((t) => t.kind === 'naturism-plugin').length;
  const autoCore = automations.filter((a) => a.kind === 'core').length;
  const autoPlugin = automations.filter((a) => a.kind === 'naturism-plugin').length;

  const header = `-- ============================================================
-- Phase 5α-2: tags + automations seed (auto-generated)
-- DO NOT EDIT this file directly. Edit scripts/seed-tags-and-automations.mjs.
-- ============================================================
-- Generated: ${new Date().toISOString()}
-- Tags: ${tags.length} (core: ${tagCore}, naturism-plugin: ${tagPlugin})
-- Automations: ${automations.length} (core: ${autoCore}, naturism-plugin: ${autoPlugin})
-- ============================================================
`;

  const tagsSection = `
-- =============================
-- Tags
-- =============================
${tags
  .map(
    (t) => `
-- ${t.id} (${t.kind}): ${t.note}
${buildTagUpsertSql(t)}`,
  )
  .join('\n')}
`;

  const autoSection = `
-- =============================
-- Automations
-- =============================
${automations
  .map(
    (a) => `
-- ${a.id} (${a.kind}): ${a.note}
${buildAutomationUpsertSql(a)}`,
  )
  .join('\n')}
`;

  const footer = `

-- 結果確認
SELECT 'tags' AS kind, COUNT(*) AS n FROM tags WHERE id LIKE 'tag-%';
SELECT 'automations' AS kind, COUNT(*) AS n FROM automations WHERE id LIKE 'auto-%';
SELECT id, name, event_type, priority, is_active FROM automations WHERE id LIKE 'auto-%' ORDER BY priority DESC;
`;

  return header + tagsSection + autoSection + footer;
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = { dryRun: true, local: false, remote: false, force: false, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') { args.local = true; args.dryRun = false; }
    else if (a === '--remote') { args.remote = true; args.dryRun = false; }
    else if (a === '--force') { args.force = true; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--output') { args.output = argv[++i]; }
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/seed-tags-and-automations.mjs [options]

Options:
  --dry-run       SQL を stdout に出力 (default)
  --local         ローカル D1 に投入
  --remote        本番 D1 に投入 (要 --force)
  --force         本番投入の確認をスキップ
  --output PATH   SQL を指定 PATH へ書き出し
  --help, -h      ヘルプ表示
`);
}

function execWrangler(sqlPath, { remote }) {
  const flag = remote ? '--remote' : '--local';
  const cmd = `pnpm --filter worker exec wrangler d1 execute ${D1_DATABASE_NAME} ${flag} --file=${sqlPath}`;
  console.error(`[seed-tags-and-automations] $ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv);

  // 整合性チェック (必ず実行)
  const errors = validateTagReferences();
  if (errors.length > 0) {
    console.error('ERROR: tag reference validation failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }

  const sql = buildAllSql();

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, sql, 'utf8');
    console.error(`[seed-tags-and-automations] Wrote SQL to ${args.output}`);
  }

  if (args.dryRun) {
    process.stdout.write(sql);
    return;
  }

  if (args.remote && !args.force) {
    console.error('ERROR: --remote requires --force (本番投入の確認)');
    console.error('       Katsu レビュー承認後に再実行してください。');
    process.exit(1);
  }

  const tmpPath = join(tmpdir(), `seed-tags-automations-${Date.now()}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    execWrangler(tmpPath, { remote: args.remote });
    console.error(`[seed-tags-and-automations] ✅ ${args.remote ? '本番' : 'ローカル'} D1 投入完了`);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
