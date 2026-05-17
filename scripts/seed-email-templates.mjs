#!/usr/bin/env node
/**
 * Phase 5α-1 + 5α-9: transactional / marketing email templates seed (brand 変数版)
 *
 * 目的:
 *   email_templates テーブルへ 5 種テンプレを idempotent に投入する。
 *
 * 設計方針 (大方針 2 「汎用性 multi-brand/industry」 反映、 Ultraplan v4 Phase 5α-9 統合):
 *   - **全テンプレを brand 変数化**: 文字列内の "naturism" / "ケンコーエクスプレス" / shop URL 等は
 *     placeholder `{{brand_name}}` `{{company_name}}` `{{support_email}}` `{{shop_url}}`
 *     `{{subscription_url}}` `{{primary_color}}` `{{intro_product_label}}` で保存。
 *     送信時に brand_config テーブルから自動注入 (apps/worker/src/services/send-email-action.ts)。
 *   - **name は brand 非依存** (Welcome / 注文確認 / etc.)、 admin UI で他 brand と共有可能
 *   - **コア 4 (welcome/order_confirmation/cart_recovery/shipping_notification) + naturism-plugin 1 (reorder_reminder)**
 *     kind='naturism-plugin' は Phase 5κ で packages/plugin-naturism/ に移管予定
 *
 * 冪等性:
 *   INSERT INTO email_templates ... ON CONFLICT(id) DO UPDATE SET ...
 *   created_at は保持、 updated_at のみ更新。
 *
 * 使い方:
 *   node scripts/seed-email-templates.mjs                   # dry-run (default、 SQL を stdout 出力)
 *   node scripts/seed-email-templates.mjs --local           # ローカル D1 へ投入
 *   node scripts/seed-email-templates.mjs --remote --force  # 本番 D1 へ投入 (Katsu 承認後)
 *   node scripts/seed-email-templates.mjs --output PATH     # SQL を指定 PATH へ書き出し
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
// テンプレート定義 (5 種、 brand 変数化済)
// ============================================================

/**
 * @typedef {Object} TemplateEntry
 * @property {string} id
 * @property {string} name          - brand 非依存 (admin UI 表示)
 * @property {'transactional'|'marketing'} category
 * @property {string} subject
 * @property {string} preheader
 * @property {string} html
 * @property {string} text
 * @property {'core'|'naturism-plugin'} kind
 * @property {string} note
 */

/** @type {TemplateEntry[]} */
export const TEMPLATES = [
  // --------------------------------------------------------
  // 1. welcome (友だち追加 + opt-in 確認)
  // --------------------------------------------------------
  {
    id: 'tpl-welcome-v1',
    name: 'Welcome (opt-in 確認)',
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} + brand_config 注入 (brand_name/company_name/support_email/shop_url/primary_color/intro_product_label)',
    subject: '[{{brand_name}}] ご登録ありがとうございます 🌿',
    preheader: '{{brand_name}} のメールマガジン購読のご確認です',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">🌿 {{brand_name}} へようこそ</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    {{brand_name}} ({{company_name}}) にご登録いただき、ありがとうございます。<br>
    本メールはご登録確認のためにお送りしています。
  </p>
  <p style="font-size:15px;line-height:1.7;">
    今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。<br>
    配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;">
    <p style="font-size:15px;margin:0 0 12px 0;"><strong>🎁 まずはお試しを</strong></p>
    <p style="font-size:14px;margin:0;line-height:1.6;">
      {{intro_product_label}} から始められます。<br>
      <a href="{{shop_url}}" style="color:{{primary_color}};text-decoration:none;">公式サイトはこちら</a>
    </p>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ご不明点は <a href="mailto:{{support_email}}" style="color:{{primary_color}};">{{support_email}}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `🌿 {{brand_name}} へようこそ

{{name}} 様

{{brand_name}} ({{company_name}}) にご登録いただき、ありがとうございます。
本メールはご登録確認のためにお送りしています。

今後、新商品のご案内・キャンペーン情報・お得なクーポン等をお届けします。
配信を希望されない場合は本メール末尾の「配信停止」 リンクからお手続きください。

🎁 まずはお試しを
{{intro_product_label}} から始められます。
公式サイト: {{shop_url}}

ご不明点は {{support_email}} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 2. order_confirmation (Shopify 注文確認)
  // --------------------------------------------------------
  {
    id: 'tpl-order-confirmation-v1',
    name: '注文確認',
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{order_number}} {{order_date}} {{total_amount}} {{shipping_address}} + brand 注入',
    subject: '[{{brand_name}}] ご注文ありがとうございます (#{{order_number}})',
    preheader: 'ご注文内容のご確認 — 合計 ¥{{total_amount}}',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">ご注文ありがとうございます</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    このたびは {{brand_name}} をご注文いただきありがとうございます。<br>
    以下のご注文内容で受け付けました。
  </p>
  <table style="width:100%;border-collapse:collapse;margin:20px 0;">
    <tr><td style="padding:8px 0;color:#666;width:40%;">注文番号</td><td style="padding:8px 0;font-weight:bold;">#{{order_number}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">注文日時</td><td style="padding:8px 0;">{{order_date}}</td></tr>
    <tr><td style="padding:8px 0;color:#666;">合計金額</td><td style="padding:8px 0;font-weight:bold;color:{{primary_color}};">¥{{total_amount}}</td></tr>
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
    ご不明点は <a href="mailto:{{support_email}}" style="color:{{primary_color}};">{{support_email}}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `ご注文ありがとうございます

{{name}} 様

このたびは {{brand_name}} をご注文いただきありがとうございます。
以下のご注文内容で受け付けました。

注文番号: #{{order_number}}
注文日時: {{order_date}}
合計金額: ¥{{total_amount}}
配送先: {{shipping_address}}

📦 配送について
ご注文の確認後、通常 1-2 営業日で発送いたします。
発送完了時に追跡番号をメールでお知らせします。

ご不明点は {{support_email}} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 3. reorder_reminder (再購入リマインダー、 naturism plugin 候補)
  // --------------------------------------------------------
  // NOTE (Phase 5κ plugin 切出し対象):
  //   定期便キャンペーン文言 + subscription_url は naturism brand 特化なので
  //   将来 packages/plugin-naturism/ に移管予定。 ただし brand 変数化済のため
  //   他 brand でも brand_config.subscription_url を設定すれば再利用可能。
  {
    id: 'tpl-reorder-reminder-v1',
    name: '再購入リマインダー',
    category: 'marketing',
    kind: 'naturism-plugin',
    note: 'naturism plugin 候補。 send 時 vars: {{name}} {{product_name}} {{product_price}} {{product_url}} {{days_since_last}} + brand 注入',
    subject: '[{{brand_name}}] {{product_name}} そろそろお手元になくなる頃ではありませんか?',
    preheader: '最後のご購入から {{days_since_last}} 日経ちました',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">🌿 そろそろリピートしませんか?</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    最後に <strong>{{product_name}}</strong> をご購入いただいてから {{days_since_last}} 日が経ちました。<br>
    そろそろお手元のお品物が少なくなる頃ではないでしょうか。
  </p>
  <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:24px 0;text-align:center;">
    <p style="font-size:15px;margin:0 0 12px 0;color:#15803d;"><strong>{{product_name}}</strong></p>
    <p style="font-size:14px;margin:0 0 16px 0;color:#555;">¥{{product_price}}</p>
    <a href="{{product_url}}" style="display:inline-block;background:{{primary_color}};color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
      公式ストアで購入する
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    定期便で 10% OFF + 送料無料も承っています。<br>
    詳しくは <a href="{{subscription_url}}" style="color:{{primary_color}};">公式サイト</a> をご確認ください。
  </p>
</div>`,
    text: `🌿 そろそろリピートしませんか?

{{name}} 様

最後に {{product_name}} をご購入いただいてから {{days_since_last}} 日が経ちました。
そろそろお手元のお品物が少なくなる頃ではないでしょうか。

{{product_name}} ¥{{product_price}}
公式ストアで購入: {{product_url}}

定期便で 10% OFF + 送料無料も承っています。
詳しくは {{subscription_url}} をご確認ください。`,
  },

  // --------------------------------------------------------
  // 4. cart_recovery (カート放棄リカバリ)
  // --------------------------------------------------------
  {
    id: 'tpl-cart-recovery-v1',
    name: 'カート放棄リカバリ',
    category: 'marketing',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{cart_url}} + brand 注入',
    subject: '[{{brand_name}}] お買い物かごに商品が残っています 🛒',
    preheader: 'カートのお品物のご確認とご注文完了について',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">🛒 お買い物かごに商品が残っています</h1>
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
    <a href="{{cart_url}}" style="display:inline-block;background:{{primary_color}};color:#fff;padding:14px 32px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:15px;">
      カートを見る
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    商品が在庫切れになる前にご注文ください。<br>
    ご不明点は <a href="mailto:{{support_email}}" style="color:{{primary_color}};">{{support_email}}</a> までお気軽にお問い合わせください。
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
ご不明点は {{support_email}} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 6. opt_in_invitation (Phase 5β-1: marketing 同意再取得)
  // --------------------------------------------------------
  // NOTE:
  //   - 既存 Shopify 顧客 1,891 名のうち subscribed=2/0.1% という低 opt-in 率を是正する施策。
  //   - send 時 vars: {{name}} {{opt_in_url}} + brand 注入
  //   - {{opt_in_url}} は caller (admin endpoint POST /api/admin/email/opt-in/generate-url
  //     または bulk send script) が事前に signEmailOptInToken で生成した URL を渡す。
  //   - category='transactional' で送信することで not_subscribed 1,690 名にも届く。
  //     (法令上、 marketing への opt-in を依頼する 1 回限りの transactional は OK)
  {
    id: 'tpl-opt-in-invitation-v1',
    name: 'メールマガジン登録のお願い',
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{opt_in_url}} + brand 注入。 既存顧客への opt-in 再取得 (1 回限り) 用',
    subject: '[{{brand_name}}] メールマガジン配信のご確認 (クーポン同封)',
    preheader: 'ご登録いただくと 500 円 OFF クーポンをプレゼント',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">📧 メールマガジン配信のご確認</h1>
  <p style="font-size:16px;line-height:1.7;">{{name}} 様</p>
  <p style="font-size:15px;line-height:1.7;">
    いつも {{brand_name}} をご愛用いただきありがとうございます。<br>
    {{brand_name}} では、 ご愛用者様向けに <strong>新商品のご案内</strong>・<strong>季節のキャンペーン</strong>・<strong>健康コラム</strong> をメールでお届けしています。
  </p>
  <div style="background:#fef3c7;padding:20px;border-radius:8px;margin:24px 0;text-align:center;border:1px solid #fde68a;">
    <p style="font-size:14px;margin:0 0 8px 0;color:#92400e;"><strong>🎁 ご登録で 500 円 OFF クーポン</strong></p>
    <p style="font-size:12px;margin:0;line-height:1.6;color:#a16207;">次回 {{shop_url}} でのご購入時にご利用いただけます</p>
  </div>
  <div style="text-align:center;margin:32px 0;">
    <a href="{{opt_in_url}}" style="display:inline-block;background:{{primary_color}};color:#fff;padding:14px 36px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:15px;">
      配信を希望する
    </a>
  </div>
  <p style="font-size:13px;color:#666;line-height:1.6;">
    ・配信を希望されない場合は、 このメールをそのまま閉じていただいて大丈夫です。<br>
    ・ご登録後は、 メール末尾の「配信停止」 リンクからいつでも解除できます。<br>
    ・ご注文確認・発送通知などの取引メールは引き続きお届けします。
  </p>
  <p style="font-size:13px;color:#666;line-height:1.6;margin-top:24px;">
    ご不明点は <a href="mailto:{{support_email}}" style="color:{{primary_color}};">{{support_email}}</a> までお気軽にお問い合わせください。
  </p>
</div>`,
    text: `📧 メールマガジン配信のご確認

{{name}} 様

いつも {{brand_name}} をご愛用いただきありがとうございます。
{{brand_name}} では、 ご愛用者様向けに 新商品のご案内・季節のキャンペーン・健康コラム をメールでお届けしています。

🎁 ご登録で 500 円 OFF クーポン
次回 {{shop_url}} でのご購入時にご利用いただけます

配信を希望する: {{opt_in_url}}

・配信を希望されない場合は、 このメールをそのまま閉じていただいて大丈夫です。
・ご登録後は、 メール末尾の「配信停止」 リンクからいつでも解除できます。
・ご注文確認・発送通知などの取引メールは引き続きお届けします。

ご不明点は {{support_email}} までお気軽にお問い合わせください。`,
  },

  // --------------------------------------------------------
  // 5. shipping_notification (発送通知)
  // --------------------------------------------------------
  {
    id: 'tpl-shipping-notification-v1',
    name: '発送通知',
    category: 'transactional',
    kind: 'core',
    note: 'コア。 send 時 vars: {{name}} {{order_number}} {{carrier}} {{tracking_number}} {{estimated_delivery_date}} {{tracking_url}} + brand 注入',
    subject: '[{{brand_name}}] 商品を発送しました (#{{order_number}})',
    preheader: '配送状況の確認はこちらから',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px;">
  <h1 style="color:{{primary_color}};font-size:22px;margin-bottom:16px;">📦 商品を発送しました</h1>
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
    <a href="{{tracking_url}}" style="display:inline-block;background:{{primary_color}};color:#fff;padding:12px 28px;border-radius:24px;text-decoration:none;font-weight:bold;font-size:14px;">
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
    商品到着後、お気づきの点がございましたら <a href="mailto:{{support_email}}" style="color:{{primary_color}};">{{support_email}}</a> までお問い合わせください。
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

商品到着後、お気づきの点がございましたら {{support_email}} までお問い合わせください。`,
  },
];

// ============================================================
// SQL 生成
// ============================================================

export function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * テンプレ 1 件を UPSERT する SQL を生成。
 * brand_id NULL (= default brand = naturism via brand_config.is_default=1)。
 */
export function buildUpsertSql(t) {
  const v = (s) => `'${sqlEscape(s)}'`;
  return `INSERT INTO email_templates (id, name, category, subject, html_content, text_content, preheader, is_active, brand_id)
VALUES (
  ${v(t.id)},
  ${v(t.name)},
  ${v(t.category)},
  ${v(t.subject)},
  ${v(t.html)},
  ${v(t.text)},
  ${v(t.preheader)},
  1,
  NULL
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  category = excluded.category,
  subject = excluded.subject,
  html_content = excluded.html_content,
  text_content = excluded.text_content,
  preheader = excluded.preheader,
  is_active = excluded.is_active,
  brand_id = excluded.brand_id,
  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours');`;
}

export function buildAllSql(templates = TEMPLATES) {
  const header = `-- ============================================================
-- Phase 5α-1 + 5α-9: email_templates seed (brand 変数版、 auto-generated)
-- DO NOT EDIT this file directly. Edit scripts/seed-email-templates.mjs.
-- ============================================================
-- Generated: ${new Date().toISOString()}
-- Templates: ${templates.length} (core: ${templates.filter((t) => t.kind === 'core').length}, naturism-plugin: ${templates.filter((t) => t.kind === 'naturism-plugin').length})
-- brand 値は migration 047 で seed された brand_config から送信時に注入される。
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
SELECT id, name, category, length(html_content) AS html_len, length(text_content) AS text_len, brand_id, updated_at
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
  console.log(`Usage: node scripts/seed-email-templates.mjs [options]

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
    process.exit(1);
  }

  const tmpPath = join(tmpdir(), `seed-email-templates-${Date.now()}.sql`);
  writeFileSync(tmpPath, sql, 'utf8');
  try {
    execWrangler(tmpPath, { remote: args.remote });
    console.error(`[seed-email-templates] ✅ ${args.remote ? '本番' : 'ローカル'} D1 投入完了`);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
