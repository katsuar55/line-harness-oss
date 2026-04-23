#!/usr/bin/env node
/**
 * schema.sql 再生成ツール
 *
 * migrations/*.sql から schema.sql を更新する。以下の操作を行う:
 *   1. migrations にしか存在しない CREATE TABLE を schema.sql に追記
 *   2. migrations に存在する ALTER TABLE ADD COLUMN を、schema.sql の
 *      該当 CREATE TABLE 定義内へマージ（重複追加しない）
 *   3. 新規/既存テーブル向けの CREATE INDEX も取り込む
 *
 * ALTER TABLE ADD COLUMN を inline すれば、schema.sql 単独でフレッシュ DB
 * から正しく立ち上がる（wrangler d1 execute --file=schema.sql）。
 *
 * Usage (from packages/db/):
 *   pnpm regenerate-schema
 *   # or: node scripts/regenerate-schema.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '..');
const SCHEMA_FILE = join(DB_DIR, 'schema.sql');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** テキストから CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN を抽出 */
function extractStatements(sql) {
  const tables = new Map();
  const indexes = [];
  const alters = []; // { table, column, def }

  const tableRe = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    tables.set(m[1], m[0]);
  }

  const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s+ON\s+([a-z_][a-z0-9_]*)[^;]*;/gi;
  while ((m = idxRe.exec(sql)) !== null) {
    indexes.push({ name: m[1], table: m[2], text: m[0] });
  }

  // ALTER TABLE <name> ADD COLUMN <col> <rest>;
  const alterRe = /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+([a-z_][a-z0-9_]*)\s+([^;]+);/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    alters.push({ table: m[1], column: m[2], def: m[3].trim() });
  }

  return { tables, indexes, alters };
}

/** CREATE TABLE のカラム一覧を列名だけ抜き出す（簡易パーサ） */
function extractColumnNames(createTableSql) {
  const bodyMatch = createTableSql.match(/\(([\s\S]*)\)\s*;$/);
  if (!bodyMatch) return new Set();
  const body = bodyMatch[1];
  const columns = new Set();
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    const idMatch = trimmed.match(/^([a-z_][a-z0-9_]*)\s/i);
    if (!idMatch) continue;
    const word = idMatch[1].toUpperCase();
    if (['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'INDEX'].includes(word)) continue;
    columns.add(idMatch[1].toLowerCase());
  }
  return columns;
}

/**
 * CREATE TABLE 本体に新カラムを注入する。
 *
 * SQLite はカラム定義の後にテーブル制約 (UNIQUE/PRIMARY KEY/FOREIGN KEY/CHECK
 * /CONSTRAINT) が来る文法なので、カラムは必ず「最初のテーブル制約の前」に
 * 差し込む。制約が無ければ閉じカッコの直前に追加する。
 */
function injectColumn(createTableSql, column, def) {
  const openIdx = createTableSql.indexOf('(');
  const closeIdx = createTableSql.lastIndexOf(')');
  if (openIdx === -1 || closeIdx === -1) return createTableSql;

  const head = createTableSql.slice(0, openIdx + 1);
  const body = createTableSql.slice(openIdx + 1, closeIdx);
  const tail = createTableSql.slice(closeIdx);

  const lines = body.split('\n');
  const constraintKeywords = /^\s*(UNIQUE\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|CHECK\s*\(|CONSTRAINT\b)/i;

  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (constraintKeywords.test(lines[i])) {
      insertAt = i;
      break;
    }
  }

  // 直前の行にカンマが無ければ付ける
  if (insertAt > 0) {
    let prev = insertAt - 1;
    while (prev > 0 && lines[prev].trim() === '') prev--;
    if (lines[prev] && !lines[prev].trim().endsWith(',')) {
      lines[prev] = lines[prev].replace(/\s*$/, ',');
    }
  }

  const newLine = `  ${column.padEnd(20)} ${def.endsWith(',') ? def : def + (insertAt < lines.length ? ',' : '')}`;
  // 新カラム末尾にカンマが必要なのは「まだ後ろに内容がある場合」のみ
  const finalLine = insertAt < lines.length && !newLine.trimEnd().endsWith(',')
    ? newLine + ','
    : newLine.replace(/,\s*$/, insertAt < lines.length ? ',' : '');

  lines.splice(insertAt, 0, finalLine);

  return `${head}${lines.join('\n')}${tail}`;
}

function main() {
  let schemaSql = readFileSync(SCHEMA_FILE, 'utf8');

  // 1) migrations を順番に読み、 ALTER TABLE ADD COLUMN を CREATE TABLE に merge
  const migrationFiles = listMigrations();
  let columnsAdded = 0;

  for (const f of migrationFiles) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const { alters } = extractStatements(content);
    for (const { table, column, def } of alters) {
      // schema.sql にその CREATE TABLE があるか
      const ctRe = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\([\\s\\S]*?\\)\\s*;`, 'i');
      const match = schemaSql.match(ctRe);
      if (!match) continue; // あとで追記される分には columns が migration CREATE TABLE に含まれている
      const existingColumns = extractColumnNames(match[0]);
      if (existingColumns.has(column.toLowerCase())) continue; // 既に存在
      const newCreate = injectColumn(match[0], column, def);
      schemaSql = schemaSql.replace(match[0], newCreate);
      columnsAdded++;
    }
  }

  // 2) AUTO-APPENDED セクションを差し替え（既存があれば削除して作り直し）
  const autoMarker = '-- AUTO-APPENDED from migrations';
  if (schemaSql.includes(autoMarker)) {
    const markerIdx = schemaSql.indexOf(autoMarker);
    const precedingSectionStart = schemaSql.lastIndexOf('-- =====', markerIdx);
    schemaSql = schemaSql.slice(0, precedingSectionStart).trimEnd() + '\n';
  }

  // 3) schema.sql に無い CREATE TABLE と未知の CREATE INDEX を追記
  const { tables: schemaTables, indexes: schemaIndexes } = extractStatements(schemaSql);
  const existingIndexNames = new Set(schemaIndexes.map((i) => i.name));
  const covered = new Set(schemaTables.keys());
  const appendTables = [];
  const appendIndexes = [];

  for (const f of migrationFiles) {
    const content = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const { tables, indexes } = extractStatements(content);
    for (const [name, text] of tables) {
      if (!covered.has(name)) {
        appendTables.push({ source: f, name, text });
        covered.add(name);
      }
    }
    for (const idx of indexes) {
      if (!existingIndexNames.has(idx.name)) {
        appendIndexes.push({ source: f, ...idx });
        existingIndexNames.add(idx.name);
      }
    }
  }

  if (appendTables.length > 0 || appendIndexes.length > 0) {
    const header = `
-- ============================================================
-- AUTO-APPENDED from migrations/*.sql
-- Regenerated by scripts/regenerate-schema.mjs
-- Do NOT edit this section by hand; rerun the script instead.
-- ============================================================
`;
    let additions = header;
    for (const t of appendTables) {
      additions += `\n-- from ${t.source}\n${t.text}\n`;
    }
    if (appendIndexes.length > 0) {
      additions += `\n-- Indexes from migrations\n`;
      for (const i of appendIndexes) {
        additions += `${i.text}\n`;
      }
    }
    schemaSql = schemaSql.trimEnd() + '\n' + additions;
  }

  writeFileSync(SCHEMA_FILE, schemaSql);
  console.log(`Regenerated schema.sql:`);
  console.log(`  - ${columnsAdded} columns merged via ALTER TABLE`);
  console.log(`  - ${appendTables.length} tables appended`);
  console.log(`  - ${appendIndexes.length} indexes appended`);
}

main();
