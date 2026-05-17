#!/usr/bin/env node
/**
 * Phase 5α-1 + 5α-9 seed script のテスト (brand 変数版)。
 *
 * 検証ポイント:
 *  - 5 件 / core 4 + naturism-plugin 1
 *  - required fields すべて存在
 *  - **brand 値が hardcode されていない** (大方針 2 / Ultraplan v4)
 *    - "naturism" / "ケンコーエクスプレス" / "support@naturism-diet.com" /
 *      "https://naturism-diet.com" / "Blue 7日分" / "#06C755" 等が html/text/subject/preheader に無いこと
 *    - 名前 (TEMPLATES.name) は brand 非依存 (admin UI 用)
 *  - 全 7 brand placeholder ({{brand_name}}, {{company_name}}, {{support_email}},
 *    {{shop_url}}, {{subscription_url}}, {{primary_color}}, {{intro_product_label}}) が少なくとも 1 テンプレで使われる
 *  - send-time placeholder ({{name}} {{order_number}} 等) は保持
 *  - 薬機法 NG ワード無し
 *  - SQL は INSERT...ON CONFLICT で UPSERT、 brand_id 列含む
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TEMPLATES, sqlEscape, buildUpsertSql, buildAllSql } from './seed-email-templates.mjs';

test('TEMPLATES — 6 件 / core 5 + naturism-plugin 1', () => {
  assert.equal(TEMPLATES.length, 6);
  assert.equal(TEMPLATES.filter((t) => t.kind === 'core').length, 5);
  assert.equal(TEMPLATES.filter((t) => t.kind === 'naturism-plugin').length, 1);
  assert.equal(TEMPLATES.find((t) => t.kind === 'naturism-plugin').id, 'tpl-reorder-reminder-v1');
});

test('TEMPLATES — opt_in_invitation (Phase 5β-1) 含む', () => {
  const t = TEMPLATES.find((tpl) => tpl.id === 'tpl-opt-in-invitation-v1');
  assert.ok(t, 'tpl-opt-in-invitation-v1 must exist');
  assert.equal(t.category, 'transactional');
  assert.equal(t.kind, 'core');
  // opt_in_url placeholder が html/text 両方に存在
  assert.ok(t.html.includes('{{opt_in_url}}'), 'html missing {{opt_in_url}}');
  assert.ok(t.text.includes('{{opt_in_url}}'), 'text missing {{opt_in_url}}');
  // name placeholder
  assert.ok(t.html.includes('{{name}}'));
});

test('TEMPLATES — required fields すべて存在', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id);
    assert.ok(t.name);
    assert.ok(['transactional', 'marketing'].includes(t.category));
    assert.ok(t.subject);
    assert.ok(t.preheader);
    assert.ok(t.html && t.html.length > 100);
    assert.ok(t.text && t.text.length > 50);
    assert.ok(['core', 'naturism-plugin'].includes(t.kind));
  }
});

test('TEMPLATES — subject/preheader 文字数制限内', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.subject.length <= 200, `${t.id}: subject ${t.subject.length} chars`);
    assert.ok(t.preheader.length <= 150, `${t.id}: preheader ${t.preheader.length} chars`);
  }
});

test('TEMPLATES — brand 値が html/text/subject/preheader に hardcode されていない (大方針 2)', () => {
  // 検証対象 brand hardcode 候補
  const forbidden = [
    'naturism',
    'ケンコーエクスプレス',
    'support@naturism-diet.com',
    'https://naturism-diet.com',
    'Blue 7日分',
    '#06C755',
  ];
  for (const t of TEMPLATES) {
    for (const field of ['subject', 'preheader', 'html', 'text']) {
      const value = t[field];
      for (const bad of forbidden) {
        assert.ok(
          !value.includes(bad),
          `${t.id}.${field} に brand hardcode "${bad}" が残存 (brand 変数化されていない)`,
        );
      }
    }
  }
});

test('TEMPLATES — name は brand 非依存 (admin UI 共用、 大方針 2)', () => {
  for (const t of TEMPLATES) {
    assert.ok(
      !t.name.includes('naturism'),
      `${t.id}.name に "naturism" が含まれる (brand 非依存にすべき): ${t.name}`,
    );
    // {{var}} placeholder も name には不要 (admin 表示で raw に出る)
    assert.ok(
      !/\{\{\w+\}\}/.test(t.name),
      `${t.id}.name に {{var}} placeholder (admin UI で raw 表示されるので避ける): ${t.name}`,
    );
  }
});

test('TEMPLATES — 全 7 brand placeholder が少なくとも 1 テンプレで使用', () => {
  const allText = TEMPLATES.flatMap((t) => [t.subject, t.preheader, t.html, t.text]).join('\n');
  const required = [
    'brand_name',
    'company_name',
    'support_email',
    'shop_url',
    'subscription_url',
    'primary_color',
    'intro_product_label',
  ];
  for (const v of required) {
    assert.match(allText, new RegExp(`\\{\\{${v}\\}\\}`), `brand placeholder {{${v}}} がどのテンプレでも使われていない`);
  }
});

test('TEMPLATES — send-time placeholder が保持 (brand 変数化で誤って消されていない)', () => {
  const welcome = TEMPLATES.find((t) => t.id === 'tpl-welcome-v1');
  assert.match(welcome.html, /\{\{name\}\}/);
  assert.match(welcome.text, /\{\{name\}\}/);

  const order = TEMPLATES.find((t) => t.id === 'tpl-order-confirmation-v1');
  for (const v of ['name', 'order_number', 'order_date', 'total_amount', 'shipping_address']) {
    assert.match(order.html, new RegExp(`\\{\\{${v}\\}\\}`), `order html missing {{${v}}}`);
  }

  const reorder = TEMPLATES.find((t) => t.id === 'tpl-reorder-reminder-v1');
  for (const v of ['name', 'product_name', 'product_price', 'product_url', 'days_since_last']) {
    assert.match(reorder.html, new RegExp(`\\{\\{${v}\\}\\}`), `reorder html missing {{${v}}}`);
  }

  const cart = TEMPLATES.find((t) => t.id === 'tpl-cart-recovery-v1');
  assert.match(cart.html, /\{\{name\}\}/);
  assert.match(cart.html, /\{\{cart_url\}\}/);

  const ship = TEMPLATES.find((t) => t.id === 'tpl-shipping-notification-v1');
  for (const v of ['name', 'order_number', 'carrier', 'tracking_number', 'estimated_delivery_date', 'tracking_url']) {
    assert.match(ship.html, new RegExp(`\\{\\{${v}\\}\\}`), `ship html missing {{${v}}}`);
  }
});

test('TEMPLATES — 薬機法 NG 表現が含まれていない', () => {
  const ngWords = ['治る', '治療', '効果が出る', '効きます', '改善します', '予防できる', '完治'];
  for (const t of TEMPLATES) {
    for (const ng of ngWords) {
      assert.ok(!t.html.includes(ng), `${t.id} html: ${ng}`);
      assert.ok(!t.text.includes(ng), `${t.id} text: ${ng}`);
    }
  }
});

test('sqlEscape — single quote 2 重化', () => {
  assert.equal(sqlEscape(`it's`), `it''s`);
  assert.equal(sqlEscape(`a'b'c`), `a''b''c`);
  assert.equal(sqlEscape(``), ``);
});

test('buildUpsertSql — INSERT...ON CONFLICT + brand_id 列含む', () => {
  const sql = buildUpsertSql(TEMPLATES[0]);
  assert.match(sql, /^INSERT INTO email_templates/);
  assert.match(sql, /brand_id/);
  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(sql, /updated_at = strftime/);
  for (const col of ['name', 'category', 'subject', 'html_content', 'text_content', 'preheader', 'is_active', 'brand_id']) {
    assert.match(sql, new RegExp(`${col} = excluded\\.${col}`), `UPDATE 文に ${col} 漏れ`);
  }
});

test('buildAllSql — header/body/footer + 全テンプレ含む', () => {
  const sql = buildAllSql();
  assert.match(sql, /Phase 5α-1 \+ 5α-9: email_templates seed \(brand 変数版/);
  for (const t of TEMPLATES) {
    assert.ok(sql.includes(`'${t.id}'`));
  }
  assert.match(sql, /SELECT id, name, category/);
  assert.ok(!/INSERT OR REPLACE/i.test(sql), 'INSERT OR REPLACE 禁止');
});
