#!/usr/bin/env node
/**
 * Phase 5α-2 seed script のテスト。
 *
 * 検証ポイント:
 *  - tags 14 件 / core 9 + naturism-plugin 5
 *  - automations 6 件 / core 4 + naturism-plugin 2
 *  - automation actions が参照する tag id が必ず TAGS 内に存在 (validateTagReferences)
 *  - tag id / name / color が必須 + name UNIQUE 制約 (重複 name エラー)
 *  - automation id 重複なし、 event_type は既知 7 種に含まれる
 *  - SQL は INSERT...ON CONFLICT で UPSERT (created_at 保持)
 *  - JSON.stringify で保存される actions に tagId が文字列で含まれる
 *  - SQL escape (single quote 2 重化)
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  TAGS,
  AUTOMATIONS,
  validateTagReferences,
  sqlEscape,
  buildTagUpsertSql,
  buildAutomationUpsertSql,
  buildAllSql,
} from './seed-tags-and-automations.mjs';

const KNOWN_EVENT_TYPES = new Set([
  'friend_add',
  'message_received',
  'food_logged',
  'purchase_completed',
  'cv_fire',
  'tag_change',
  'intake_log',
]);

test('TAGS — 14 件 / core 9 + naturism-plugin 5', () => {
  assert.equal(TAGS.length, 14);
  assert.equal(TAGS.filter((t) => t.kind === 'core').length, 9);
  assert.equal(TAGS.filter((t) => t.kind === 'naturism-plugin').length, 5);
});

test('TAGS — id / name / color 必須 + name UNIQUE', () => {
  const ids = new Set();
  const names = new Set();
  for (const t of TAGS) {
    assert.ok(t.id?.startsWith('tag-'), `tag id must start with 'tag-': ${t.id}`);
    assert.ok(t.name, `${t.id}: name required`);
    assert.match(t.color, /^#[0-9A-Fa-f]{6}$/, `${t.id}: color must be #RRGGBB`);
    assert.ok(['core', 'naturism-plugin'].includes(t.kind), `${t.id}: kind invalid`);
    assert.ok(!ids.has(t.id), `duplicate tag id: ${t.id}`);
    assert.ok(!names.has(t.name), `duplicate tag name (UNIQUE 制約違反): ${t.name}`);
    ids.add(t.id);
    names.add(t.name);
  }
});

test('TAGS — naturism plugin tag id は naturism prefix', () => {
  const naturismTags = TAGS.filter((t) => t.kind === 'naturism-plugin');
  for (const t of naturismTags) {
    assert.match(t.id, /^tag-naturism-/, `naturism plugin tag id must include 'naturism-': ${t.id}`);
  }
});

test('AUTOMATIONS — 6 件 / core 4 + naturism-plugin 2', () => {
  assert.equal(AUTOMATIONS.length, 6);
  assert.equal(AUTOMATIONS.filter((a) => a.kind === 'core').length, 4);
  assert.equal(AUTOMATIONS.filter((a) => a.kind === 'naturism-plugin').length, 2);
});

test('AUTOMATIONS — id 重複なし + event_type は既知 7 種', () => {
  const ids = new Set();
  for (const a of AUTOMATIONS) {
    assert.ok(a.id?.startsWith('auto-'), `automation id must start with 'auto-': ${a.id}`);
    assert.ok(!ids.has(a.id), `duplicate automation id: ${a.id}`);
    assert.ok(KNOWN_EVENT_TYPES.has(a.eventType), `unknown event_type: ${a.eventType}`);
    assert.ok(['core', 'naturism-plugin'].includes(a.kind), `${a.id}: kind invalid`);
    assert.ok(Array.isArray(a.actions) && a.actions.length > 0, `${a.id}: actions required`);
    assert.equal(typeof a.priority, 'number');
    ids.add(a.id);
  }
});

test('validateTagReferences — automation が参照する tag id が必ず TAGS に存在', () => {
  const errors = validateTagReferences();
  assert.deepEqual(errors, [], 'tag reference errors detected:\n' + errors.join('\n'));
});

test('AUTOMATIONS — welcome email は templateId tpl-welcome-v1 を参照 (Phase 5α-1 と整合)', () => {
  const welcome = AUTOMATIONS.find((a) => a.id === 'auto-friend-add-welcome-email');
  assert.ok(welcome, 'auto-friend-add-welcome-email must exist');
  const sendEmailAction = welcome.actions.find((act) => act.type === 'send_email');
  assert.ok(sendEmailAction, 'must have send_email action');
  assert.equal(sendEmailAction.params.templateId, 'tpl-welcome-v1');
  assert.equal(sendEmailAction.params.category, 'transactional');
});

test('AUTOMATIONS — naturism plugin automation は naturism tag のみ参照', () => {
  const plugin = AUTOMATIONS.filter((a) => a.kind === 'naturism-plugin');
  for (const a of plugin) {
    for (const action of a.actions) {
      if (action.type === 'add_tag' || action.type === 'remove_tag') {
        assert.match(
          action.params.tagId,
          /^tag-naturism-/,
          `naturism plugin automation ${a.id} must reference naturism tag, got ${action.params.tagId}`,
        );
      }
    }
  }
});

test('sqlEscape — single quote 2 重化', () => {
  assert.equal(sqlEscape(`it's`), `it''s`);
  assert.equal(sqlEscape(`a'b'c`), `a''b''c`);
  assert.equal(sqlEscape(``), ``);
});

test('buildTagUpsertSql — INSERT...ON CONFLICT(id) DO UPDATE', () => {
  const sql = buildTagUpsertSql(TAGS[0]);
  assert.match(sql, /^INSERT INTO tags/);
  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  assert.match(sql, /name = excluded\.name/);
  assert.match(sql, /color = excluded\.color/);
});

test('buildAutomationUpsertSql — UPDATE 列に actions / conditions / event_type 含む (memory feedback_upsert_update_column_drift 教訓)', () => {
  const sql = buildAutomationUpsertSql(AUTOMATIONS[0]);
  assert.match(sql, /^INSERT INTO automations/);
  assert.match(sql, /ON CONFLICT\(id\) DO UPDATE SET/);
  for (const col of ['name', 'description', 'event_type', 'conditions', 'actions', 'is_active', 'priority']) {
    assert.match(sql, new RegExp(`${col} = excluded\\.${col}`), `UPDATE 文に ${col} 漏れ`);
  }
  assert.match(sql, /updated_at = strftime/);
});

test('buildAutomationUpsertSql — actions JSON が SQL 内に文字列で正しく埋め込まれる', () => {
  const sql = buildAutomationUpsertSql(AUTOMATIONS[0]); // auto-friend-add-tag-new
  // actions は JSON.stringify で `[{"type":"add_tag","params":{"tagId":"tag-status-new"}}]` になる
  // SQL escape で " はそのまま、 ' のみ '' 化
  assert.match(sql, /'\[\{"type":"add_tag","params":\{"tagId":"tag-status-new"\}\}\]'/);
});

test('buildAllSql — header / tags section / automations section / footer 全部', () => {
  const sql = buildAllSql();
  assert.match(sql, /Phase 5α-2: tags \+ automations seed/);
  assert.match(sql, /-- Tags:/);
  assert.match(sql, /-- Automations:/);
  for (const t of TAGS) assert.ok(sql.includes(`'${t.id}'`), `SQL missing tag ${t.id}`);
  for (const a of AUTOMATIONS) assert.ok(sql.includes(`'${a.id}'`), `SQL missing automation ${a.id}`);
  // 結果確認 SELECT
  assert.match(sql, /SELECT 'tags' AS kind, COUNT/);
  assert.match(sql, /SELECT 'automations' AS kind, COUNT/);
});

test('buildAllSql — INSERT OR REPLACE 使用禁止 (created_at 保持)', () => {
  const sql = buildAllSql();
  assert.ok(!/INSERT OR REPLACE/i.test(sql), 'INSERT OR REPLACE は created_at を破壊するので使用禁止');
});
