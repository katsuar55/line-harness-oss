#!/usr/bin/env node
/**
 * Phase 5α-1: transactional / marketing email templates seed
 *
 * 目的:
 *   docs/SEED_EMAIL_TEMPLATES.md で Katsu レビュー済の 5 種テンプレを
 *   email_templates テーブルへ idempotent に投入する。
 *
 * 設計方針 (大方針 2 「汎用性 multi-brand/industry」 反映):
 *   - コアテンプレ 4 種 (welcome / order_confirmation / cart_recovery / shipping_notification)
 *     は brand 値 (社名 / shop URL / support メアド) を `BRAND` const から展開する構造。
 *     将来 brand config テーブル化 / Phase 5κ で plugin 切出し時に再利用容易。
 *   - naturism 特化 1 種 (reorder_reminder) は naturism plugin 切出し対象として
 *     `kind: 'naturism-plugin'` で marker。 Phase 5κ で packages/plugin-naturism/ に移管予定。
 *   - {{var}} 形式の placeholder はテンプレ内に残す (= 送信時に caller が埋める変数)。
 *     例: {{name}}, {{order_number}}, {{product_name}} 等。 BRAND 値は seed 時に展開済 ("naturism" 文字列が DB に入る)。
 *
 * 冪等性:
 *   INSERT INTO email_templates ... ON CONFLICT(id) DO UPDATE SET ...
 *   created_at は保持、 updated_at のみ更新。
 *
 * 使い方:
 *   node scripts/seed-email-templates.mjs                   # dry-run (default、 SQL を stdout 出力)
 *   node scripts/seed-email-templates.mjs --local           # ローカル D1 へ投入
 *   node scripts/seed-email-templates.mjs --remote          # 本番 D1 へ投入 (要 --force)
 *   node scripts/seed-email-templates.mjs --remote --force  # 本番 D1 へ投入 (Katsu 承認後)
 *   node scripts/seed-email-templates.mjs --output PATH     # SQL を指定 PATH へ書き出し
 *
 * Exit codes:
 *   0  成功
 *   1  CLI 引数不正 / wrangler 実行失敗
 *   2  内部エラー (SQL 生成失敗等)
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
// Brand config (将来 Phase 5κ で brand_id 別に DB 化予定)
// ============================================================

/**
 * naturism brand values。 他 brand を seed する際は本 const を差し替えるだけで
 * core 4 種は再利用可能 (汎用性大方針)。
 */
const BRAND = Object.freeze({
  name: 'naturism',
  companyName: '株式会社ケンコーエクスプレス',
  supportEmail: 'support@naturism-diet.com',
  shopUrl: 'https://naturism-diet.com',
  subscriptionUrl: 'https://naturism-diet.com/pages/subscription',
  primaryColor: '#06C755',
  // welcome テンプレで紹介する代表 SKU (entry product)
  introProductLabel: 'Blue 7日分（42粒）¥696',
});

// ============================================================
// テンプレート定義 (5 種)
// ============================================================

/**
 * テンプレ entry の型 (JSDoc):
 * @typedef {Object} TemplateEntry
 * @property {string} id            - email_templates.id (slug 形式)
 * @property {string} name          - 管理画面表示名
 * @property {'transactional'|'marketing'} category
 * @property {string} subject       - 件名 (送信時 {{var}} 置換あり)
 * @property {string} preheader     - プレヘッダ (受信箱プレビュー)
 * @property {string} html          - HTML 本文 (送信時 {{var}} 置換あり)
 * @property {string} text          - text 本文 (送信時 {{var}} 置換あり)
 * @property {'core'|'naturism-plugin'} kind  - 汎用 core か brand 特化か
 * @property {string} note          - レビュー / 将来移管時の memo
 */

/** @type {TemplateEntry[]} */
export const TEMPLATES = [
  // --------------------------------------------------------
  // 1. welcome (友だち追加 + opt-in 確認)
  // --------------------------------------------------------
  {
    id: 'tpl-welcome-v1',
    name: `${BRAND.name} ウェルカム + opt-in 確認`,
    category: 'transactional',
    kind: 'core',
    note: 'コア。 brand 値は BRAND const から展開済。 send 時 vars: {{name}}',
    subject: `[${BRAND.name}] ご登録ありがとうございます 🌿`,
    preheader: `${BRAND.name} のメールマガジン購読のご確認です`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:${BRAND.primaryColor};font-size:22px;margin-bottom:16px;">🌿 ${BRAND.name} へようこそ</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    ${BRAND.name} (${BRAND.companyName}) にご登録いただき、ありがとうございます。<br>
    本メールはご登録確認のためにお送りしています。
  </p>
  <p style="font-size:15px;line-height:1.7;">
    今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。<br>
    配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;">
    <p style="font-size:15px;margin:0 0 12px 0;"><strong>🎁 まずはお試しを</strong></p>
    <p style="font-size:14px;margin:0;line-height:1.6;">
      ${BRAND.introProductLabel} から始められます。<br>
      <a href="${BRAND.shopUrl}" style="color:${BRAND.primaryColor};text-decoration:none;">公式サイトはこちら</a>
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ご不明点は <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.primaryColor};">${BRAND.supportEmail}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `🌿 ${BRAND.name} へようこそ

{{name}} 様

${BRAND.name} (${BRAND.companyName}) にご登録いただき、ありがとうございます。
本メールはご登録確認のためにお送りしています。

今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。
配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。

🎁 まずはお試しを
${BRAND.introProductLabel} から始められます。
公式サイト: ${BRAND.shopUrl}

ご不明点は ${BRAND.supportEmail} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 2. order_confirmation (Shopify 注文確認)
  // --------------------------------------------------------
  {
    id: 'tpl-order-confirmation-v1',
    name: `${BRAND.name} ご注文確認`,
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{order_number}} {{order_date}} {{total_amount}} {{shipping_address}}',
    subject: `[${BRAND.name}] ご注文ありがとうございます (#{{order_number}})`,
    preheader: `ご注文内容のご確認 — 合計 ¥{{total_amount}}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:${BRAND.primaryColor};font-size:22px;margin-bottom:16px;">ご注文ありがとうございます</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    このたびは ${BRAND.name} をご注文いただきありがとうございます。<br>
    以下のご注文内容で受け付けました。
  </p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr><td style="padding:8px 0;color:#666;width:40%;">注文番号</td><td style="padding:8px 0;font-weight:bold;">#{{order_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">注文日時</td><td style="padding:8px 0;">{{order_date}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">合計金額</td><td style="padding:8px 0;font-weight:bold;color:${BRAND.primaryColor};">¥{{total_amount}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">配送先</td><td style="padding:8px 0;">{{shipping_address}}</td></tr>
  </table>
  <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:20px 0;">
    <p style="font-size:14px;margin:0 0 8px 0;"><strong>📦 配送について</strong></p>
    <p style="font-size:13px;margin:0;line-height:1.6;color:#555;">
      ご注文の確認後、通常 1-2 営業日で発送いたします。<br>
      発送完了時に追跡番号をメールでお知らせします。
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ご不明点は <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.primaryColor};">${BRAND.supportEmail}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `ご注文ありがとうございます

{{name}} 様

このたびは ${BRAND.name} をご注文いただきありがとうございます。
以下のご注文内容で受け付けました。

注文番号: #{{order_number}}
注文日時: {{order_date}}
合計金額: ¥{{total_amount}}
配送先: {{shipping_address}}

📦 配送について
ご注文の確認後、通常 1-2 営業日で発送いたします。
発送完了時に追跡番号をメールでお知らせします。

ご不明点は ${BRAND.supportEmail} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 3. reorder_reminder (再購入リマインダー、 naturism plugin 候補)
  // --------------------------------------------------------
  // NOTE (Phase 5κ plugin 切出し対象):
  //   定期便キャンペーン文言・サブスクリプション URL は naturism brand 特化。
  //   将来 packages/plugin-naturism/ に移管予定。
  //   汎用 reorder_reminder template は別途 Phase 5β で設計予定。
  {
    id: 'tpl-reorder-reminder-v1',
    name: `${BRAND.name} 再購入リマインダー`,
    category: 'marketing',
    kind: 'naturism-plugin',
    note: 'naturism plugin 候補。 send 時 vars: {{name}} {{product_name}} {{product_price}} {{product_url}} {{days_since_last}}',
    subject: `[${BRAND.name}] {{product_name}} そろそろお手元になくなる頃ではありませんか?`,
    preheader: `最後のご購入から {{days_since_last}} 日経ちました`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:${BRAND.primaryColor};font-size:22px;margin-bottom:16px;">🌿 そろそろリピートしませんか?</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    最後に <strong>{{product_name}}</strong> をご購入いただいてから {{days_since_last}} 日が経ちました。<br>
    そろそろお手元のお品物が少なくなる頃ではないでしょうか。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;text-align:center;">
    <p style="font-size:15px;margin:0 0 12px 0;color:#15803d;"><strong>{{product_name}}</strong></p>
    <p style="font-size:14px;margin:0 0 16px 0;color:#555;">¥{{product_price}}</p>
    <a href="{{product_url}}" style="display:inline-block;background:${BRAND.primaryColor};color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
      公式ストアで購入する
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    定期便で 10% OFF + 送料無料も承っています。<br>
    詳しくは <a href="${BRAND.subscriptionUrl}" style="color:${BRAND.primaryColor};">公式サイト</a> をご確認ください。
  </p>
</div>`,
    text: `🌿 そろそろリピートしませんか?

{{name}} 様

最後に {{product_name}} をご購入いただいてから {{days_since_last}} 日が経ちました。
そろそろお手元のお品物が少なくなる頃ではないでしょうか。

{{product_name}} ¥{{product_price}}
公式ストアで購入: {{product_url}}

定期便で 10% OFF + 送料無料も承っています。
詳しくは ${BRAND.subscriptionUrl} をご確認ください。`,
  },

  // --------------------------------------------------------
  // 4. cart_recovery (カート放棄リカバリ)
  // --------------------------------------------------------
  {
    id: 'tpl-cart-recovery-v1',
    name: `${BRAND.name} カート放棄リカバリ`,
    category: 'marketing',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{cart_url}}',
    subject: `[${BRAND.name}] お買い物かごに商品が残っています 🛒`,
    preheader: `カートのお品物のご確認とご注文完了について`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:${BRAND.primaryColor};font-size:22px;margin-bottom:16px;">🛒 お買い物かごに商品が残っています</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    お買い物かごに商品をお入れいただきありがとうございます。<br>
    まだご注文が完了していないようですので、お知らせさせていただきました。
  </p>
  <div style="background:#fff7ed;padding:20px;border-radius:8px;margin:24px 0;border:1px solid #fed7aa;">
    <p style="font-size:14px;margin:0 0 12px 0;color:#c2410c;"><strong>🎁 ただいま限定キャンペーン中</strong></p>
    <p style="font-size:13px;margin:0;line-height:1.6;color:#7c2d12;">
      5,500 円以上のご注文で <strong>送料無料</strong>。<br>
      ご注文確定はカートページから 24 時間以内にお願いします。
    </p>
  </div>
  <div style="text-align:center;margin:24px 0;">
    <a href="{{cart_url}}" style="display:inline-block;background:${BRAND.primaryColor};color:#fff;padding:14px 32px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:15px;">
      カートを見る
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    商品が在庫切れになる前にご注文ください。<br>
    ご不明点は <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.primaryColor};">${BRAND.supportEmail}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `🛒 お買い物かごに商品が残っています

{{name}} 様

お買い物かごに商品をお入れいただきありがとうございます。
まだご注文が完了していないようですので、お知らせさせていただきました。

🎁 ただいま限定キャンペーン中
5,500 円以上のご注文で送料無料。
ご注文確定はカートページから 24 時間以内にお願いします。

カートを見る: {{cart_url}}

商品が在庫切れになる前にご注文ください。
ご不明点は ${BRAND.supportEmail} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 5. shipping_notification (発送通知)
  // --------------------------------------------------------
  {
    id: 'tpl-shipping-notification-v1',
    name: `${BRAND.name} 発送通知`,
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{order_number}} {{carrier}} {{tracking_number}} {{estimated_delivery_date}} {{tracking_url}}',
    subject: `[${BRAND.name}] 商品を発送しました (#{{order_number}})`,
    preheader: `配送状況の確認はこちらから`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:${BRAND.primaryColor};font-size:22px;margin-bottom:16px;">📦 商品を発送しました</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    お待たせいたしました。ご注文の商品を発送いたしました。
  </p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr><td style="padding:8px 0;color:#666;width:40%;">注文番号</td><td style="padding:8px 0;font-weight:bold;">#{{order_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">配送業者</td><td style="padding:8px 0;">{{carrier}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">追跡番号</td><td style="padding:8px 0;font-family:monospace;">{{tracking_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">到着予定</td><td style="padding:8px 0;">{{estimated_delivery_date}}</td></tr>
  </table>
  <div style="text-align:center;margin:24px 0;">
    <a href="{{tracking_url}}" style="display:inline-block;background:${BRAND.primaryColor};color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
      配送状況を確認する
    </a>
  </div>
  <div style="background:#f9fafb;padding:16px;border-radius:8px;margin:20px 0;">
    <p style="font-size:13px;margin:0;line-height:1.6;color:#555;">
      💡 <strong>ご不在時の取り扱い</strong><br>
      ご不在の場合は不在票が投函されます。再配達のご連絡は配送業者のサイトをご利用ください。
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    商品到着後、お気づきの点がございましたら <a href="mailto:${BRAND.supportEmail}" style="color:${BRAND.primaryColor};">${BRAND.supportEmail}</a> までお問い合わせください。
  </p>
</div>`,
    text: `📦 商品を発送しました

{{name}} 様

お待たせいたしました。ご注文の商品を発送いたしました。

注文番号: #{{order_number}}
配送業者: {{carrier}}
追跡番号: {{tracking_number}}
到着予定: {{estimated_delivery_date}}

配送状況を確認: {{tracking_url}}

💡 ご不在時の取り扱い
ご不在の場合は不在票が投函されます。再配達のご連絡は配送業者のサイトをご利用ください。

商品到着後、お気づきの点がございましたら ${BRAND.supportEmail} までお問い合わせください。`,
  },
];

// ============================================================
// SQL 生成
// ============================================================

/** SQLite 文字列リテラル escape (single quote のみ) */
export function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * テンプレ 1 件を UPSERT する SQL を生成。
 * created_at は保持、 updated_at は now で更新。
 * @param {TemplateEntry} t
 */
export function buildUpsertSql(t) {
  const v = (s) => `'${sqlEscape(s)}'`;
  return `INSERT INTO email_templates (id, name, category, subject, html_content, text_content, preheader, is_active)
VALUES (
  ${v(t.id)},
  ${v(t.name)},
  ${v(t.category)},
  ${v(t.subject)},
  ${v(t.html)},
  ${v(t.text)},
  ${v(t.preheader)},
  1
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  category = excluded.category,
  subject = excluded.subject,
  html_content = excluded.html_content,
  text_content = excluded.text_content,
  preheader = excluded.preheader,
  is_active = excluded.is_active,
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours');`;
}

export function buildAllSql(templates = TEMPLATES) {
  const header = `-- ============================================================
-- Phase 5α-1: email_templates seed (auto-generated by scripts/seed-email-templates.mjs)
-- DO NOT EDIT this file directly. Edit the source script and re-run.
-- ============================================================
-- Brand: ${BRAND.name} (${BRAND.companyName})
-- Generated: ${new Date().toISOString()}
-- Templates: ${templates.length} (core: ${templates.filter((t) => t.kind === 'core').length}, naturism-plugin: ${templates.filter((t) => t.kind === 'naturism-plugin').length})
-- ============================================================
`;

  const body = templates
    .map(
      (t) => `
-- ----------------------------------------------------------
-- ${t.id} (${t.kind}, ${t.category})
-- ${t.note}
-- ----------------------------------------------------------
${buildUpsertSql(t)}`,
    )
    .join('\n');

  const footer = `

-- 結果確認
SELECT id, name, category, length(html_content) AS html_len, length(text_content) AS text_len, updated_at
FROM email_templates
WHERE id IN (${templates.map((t) => `'${sqlEscape(t.id)}'`).join(', ')})
ORDER BY id;
`;

  return header + body + footer;
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const args = {
    dryRun: true,
    local: false,
    remote: false,
    force: false,
    output: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') {
      args.local = true;
      args.dryRun = false;
    } else if (a === '--remote') {
      args.remote = true;
      args.dryRun = false;
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--output') {
      args.output = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/seed-email-templates.mjs [options]

Options:
  --dry-run       SQL を stdout に出力 (default)
  --local         ローカル D1 に投入 (wrangler d1 execute --local)
  --remote        本番 D1 に投入 (要 --force)
  --force         本番投入の確認をスキップ
  --output PATH   SQL を指定 PATH へ書き出し
  --help, -h      ヘルプ表示
`);
}

function execWrangler(sqlPath, { remote }) {
  const flag = remote ? '--remote' : '--local';
  const cmd = `pnpm --filter worker exec wrangler d1 execute ${D1_DATABASE_NAME} ${flag} --file=${sqlPath}`;
  console.error(`[seed-email-templates] $ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv);
  const sql = buildAllSql();

  if (args.output) {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, sql, 'utf8');
    console.error(`[seed-email-templates] Wrote SQL to ${args.output}`);
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

  // 一時ファイルへ書き出し → wrangler 実行
  const tmpPath = join(tmpdir(), `seed-email-templates-${Date.now()}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    execWrangler(tmpPath, { remote: args.remote });
    console.error(`[seed-email-templates] ✅ ${args.remote ? '本番' : 'ローカル'} D1 投入完了`);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
