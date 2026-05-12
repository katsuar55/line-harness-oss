#!/usr/bin/env node
/**
 * Phase 5α-1 seed script のテスト。
 *
 * 検証ポイント:
 *  - SQL escape が SQLite 仕様 (single quote → '')
 *  - UPSERT SQL に INSERT...ON CONFLICT(id) DO UPDATE が含まれる
 *  - 全テンプレに required field が揃っている
 *  - 汎用化方針: コアテンプレに naturism 文字列が seed 時展開されている (BRAND const 反映)
 *  - {{var}} 形式の send-time placeholder は SQL 内に保持されている (置換されていない)
 *  - naturism plugin marker 1 件 / core 4 件
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TEMPLATES, sqlEscape, buildUpsertSql, buildAllSql } from './seed-email-templates.mjs';

test('sqlEscape — single quote を 2 重化', () => {
  assert.equal(sqlEscape(`it's`), `it''s`);
  assert.equal(sqlEscape(`a'b'c`), `a''b''c`);
  assert.equal(sqlEscape(`no quotes`), `no quotes`);
  assert.equal(sqlEscape(``), ``);
});

test('sqlEscape — 非文字列も String 化して escape', () => {
  assert.equal(sqlEscape(123), `123`);
  assert.equal(sqlEscape(null), `null`);
});

test('TEMPLATES — 5 件 / core 4 + naturism-plugin 1', () => {
  assert.equal(TEMPLATES.length, 5);
  const core = TEMPLATES.filter((t) => t.kind === 'core');
  const plugin = TEMPLATES.filter((t) => t.kind === 'naturism-plugin');
  assert.equal(core.length, 4);
  assert.equal(plugin.length, 1);
  assert.equal(plugin[0].id, 'tpl-reorder-reminder-v1');
});

test('TEMPLATES — required fields がすべて存在', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.id, `${t.id || '?'}: id required`);
    assert.ok(t.name, `${t.id}: name required`);
    assert.ok(['transactional', 'marketing'].includes(t.category), `${t.id}: category must be transactional|marketing`);
    assert.ok(t.subject, `${t.id}: subject required`);
    assert.ok(t.preheader, `${t.id}: preheader required`);
    assert.ok(t.html && t.html.length > 100, `${t.id}: html required and non-trivial`);
    assert.ok(t.text && t.text.length > 50, `${t.id}: text required and non-trivial`);
    assert.ok(['core', 'naturism-plugin'].includes(t.kind), `${t.id}: kind must be core|naturism-plugin`);
  }
});

test('TEMPLATES — preheader / subject は受信箱プレビュー文字数制限内', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.subject.length <= 200, `${t.id}: subject must be <=200 chars (got ${t.subject.length})`);
    assert.ok(t.preheader.length <= 150, `${t.id}: preheader must be <=150 chars (got ${t.preheader.length})`);
  }
});

test('TEMPLATES — BRAND 値が seed 時展開済 (naturism / ケンコーエクスプレス が hardcode)', () => {
  // welcome テンプレに naturism brand 値が展開されていること
  const welcome = TEMPLATES.find((t) => t.id === 'tpl-welcome-v1');
  assert.ok(welcome.html.includes('naturism'), 'welcome html should contain "naturism"');
  assert.ok(welcome.html.includes('ケンコーエクスプレス'), 'welcome html should contain company name');
  assert.ok(welcome.html.includes('support@naturism-diet.com'), 'welcome html should contain support email');
  assert.ok(welcome.html.includes('https://naturism-diet.com'), 'welcome html should contain shop url');
});

test('TEMPLATES — {{var}} send-time placeholder が保持 (BRAND 展開で誤って消されていない)', () => {
  // welcome は {{name}} のみ
  const welcome = TEMPLATES.find((t) => t.id === 'tpl-welcome-v1');
  assert.match(welcome.html, /\{\{name\}\}/);
  assert.match(welcome.text, /\{\{name\}\}/);

  // order_confirmation は複数変数
  const order = TEMPLATES.find((t) => t.id === 'tpl-order-confirmation-v1');
  for (const v of ['name', 'order_number', 'order_date', 'total_amount', 'shipping_address']) {
    assert.match(order.html, new RegExp(`\\{\\{${v}\\}\\}`), `order html missing {{${v}}}`);
    assert.match(order.text, new RegExp(`\\{\\{${v}\\}\\}`), `order text missing {{${v}}}`);
  }

  // reorder_reminder
  const reorder = TEMPLATES.find((t) => t.id === 'tpl-reorder-reminder-v1');
  for (const v of ['name', 'product_name', 'product_price', 'product_url', 'days_since_last']) {
    assert.match(reorder.html, new RegExp(`\\{\\{${v}\\}\\}`), `reorder html missing {{${v}}}`);
  }

  // cart_recovery
  const cart = TEMPLATES.find((t) => t.id === 'tpl-cart-recovery-v1');
  assert.match(cart.html, /\{\{name\}\}/);
  assert.match(cart.html, /\{\{cart_url\}\}/);

  // shipping_notification
  const ship = TEMPLATES.find((t) => t.id === 'tpl-shipping-notification-v1');
  for (const v of ['name', 'order_number', 'carrier', 'tracking_number', 'estimated_delivery_date', 'tracking_url']) {
    assert.match(ship.html, new RegExp(`\\{\\{${v}\\}\\}`), `ship html missing {{${v}}}`);
  }
});

test('TEMPLATES — 薬機法 NG 表現が含まれていない', () => {
  const ngWords = ['治る', '治療', '効果が出る', '効きます', '改善します', '予防できる', '完治'];
  for (const t of TEMPLATES) {
    for (const ng of ngWords) {
      assert.ok(!t.html.includes(ng), `${t.id} html contains 薬機法 NG word: ${ng}`);
      assert.ok(!t.text.includes(ng), `${t.id} text contains 薬機法 NG word: ${ng}`);
    }
  }
});

test('buildUpsertSql — INSERT...ON CONFLICT が生成される', () => {
  const sql = buildUpsertSql(TEMPLATES[0]);
  assert.match(sql, /^INSERT INTO email_templates/);
  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(sql, /updated_at = strftime/);
  // category 等の更新列が漏れていないか (memory feedback_upsert_update_column_drift.md 教訓)
  for (const col of ['name', 'category', 'subject', 'html_content', 'text_content', 'preheader', 'is_active']) {
    assert.match(sql, new RegExp(`${col} = excluded\\.${col}`), `UPDATE 文に ${col} = excluded.${col} が無い`);
  }
});

test('buildUpsertSql — 値内の single quote が escape される', () => {
  const t = {
    id: 'tpl-test',
    name: `it's a test`,
    category: 'transactional',
    kind: 'core',
    note: 'test',
    subject: 'test',
    preheader: 'test',
    html: `<p>can't break</p>`,
    text: `can't break`,
  };
  const sql = buildUpsertSql(t);
  assert.match(sql, /'it''s a test'/);
  assert.match(sql, /'<p>can''t break<\/p>'/);
});

test('buildAllSql — header / footer / 全テンプレ含む', () => {
  const sql = buildAllSql();
  assert.match(sql, /Phase 5α-1: email_templates seed/);
  assert.match(sql, /Brand: naturism/);
  for (const t of TEMPLATES) {
    assert.ok(sql.includes(`'${t.id}'`), `SQL missing template id ${t.id}`);
  }
  // 結果確認 SELECT が末尾にある
  assert.match(sql, /SELECT id, name, category/);
});

test('buildAllSql — UPSERT (INSERT OR REPLACE 使用禁止 — created_at 上書きされてしまうため)', () => {
  const sql = buildAllSql();
  assert.ok(!/INSERT OR REPLACE/i.test(sql), 'INSERT OR REPLACE は created_at を破壊するので使用禁止');
  assert.ok(sql.includes('ON CONFLICT(id) DO UPDATE'), 'UPSERT に ON CONFLICT...DO UPDATE が必要');
});
