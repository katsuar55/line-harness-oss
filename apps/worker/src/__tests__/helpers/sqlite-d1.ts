/**
 * node:sqlite (実 SQLite) を D1Database 互換に包むテストヘルパー (2026-08-13)。
 *
 * 動機: fake が SQL の述語を自前で再実装すると「実装のガードを消しても fake が代わりに守る」
 *   (#252 mutation の教訓) / 「WHERE の意味の取り違いを検出できない」。順次活性化 queue の
 *   単文 UPDATE claim (NOT EXISTS ×2 + 相関サブクエリ) は述語こそが仕様なので、実 SQLite で
 *   packages/db/schema.sql をそのまま流して検証する。
 *
 * 注意:
 *   - node:sqlite は Node 22.13+/24 で flag 不要 (ExperimentalWarning は出るが動作は安定)。
 *   - D1 の `meta.changes` は sqlite の `changes` に対応させる。
 *   - D1 は FK 既定 ON。テストでも PRAGMA foreign_keys=ON にして親行 (friends 等) を用意する。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// vite は 'node:sqlite' を builtin として解決できない (builtin リストが古い) ため、
// 静的 import でなく process.getBuiltinModule で取得する (Node 22.3+)。
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
interface NodeSqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}
const { DatabaseSync } = (
  process as unknown as { getBuiltinModule(name: string): NodeSqliteModule }
).getBuiltinModule('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** packages/db/schema.sql を丸ごと適用した in-memory DB を作る */
export function createSchemaDb(): SqliteDatabase {
  // helpers → __tests__ → src → worker → apps → (repo root)
  const schemaPath = path.resolve(__dirname, '../../../../../packages/db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(sql);
  return db;
}

type SqlParam = string | number | null;

/** DatabaseSync を D1Database の使用サブセット (prepare/bind/run/first/all) に適合させる */
export function asD1(db: SqliteDatabase): D1Database {
  return {
    prepare(sql: string) {
      const make = (params: SqlParam[]) => ({
        run: async () => {
          const stmt = db.prepare(sql);
          const info = stmt.run(...params);
          return {
            success: true,
            meta: { changes: Number(info.changes), duration: 0, last_row_id: Number(info.lastInsertRowid) },
          };
        },
        first: async <T>() => {
          const stmt = db.prepare(sql);
          const row = stmt.get(...params);
          return (row ?? null) as T | null;
        },
        all: async <T>() => {
          const stmt = db.prepare(sql);
          const rows = stmt.all(...params);
          return { results: rows as T[], success: true };
        },
      });
      return {
        bind: (...params: SqlParam[]) => make(params),
        // bind なし直接呼び出しにも対応
        ...make([]),
      };
    },
    batch: async () => {
      throw new Error('batch not implemented in sqlite-d1 helper');
    },
    dump: async () => {
      throw new Error('dump not implemented');
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

/** friends 親行を最小構成で挿入 (FK 用) */
export function insertFriend(db: SqliteDatabase, id: string): void {
  db.prepare(
    `INSERT INTO friends (id, line_user_id, is_following, created_at, updated_at)
     VALUES (?, ?, 1, '2026-08-01T00:00:00', '2026-08-01T00:00:00')`,
  ).run(id, `U_${id}`);
}

/** line_referral_coupons へ台帳行を挿入 (テスト状況の組み立て用) */
export function insertReferralLedgerRow(
  db: SqliteDatabase,
  o: {
    id: string;
    friendId: string;
    rewardId: string;
    code: string;
    status?: string;
    redeemedAt?: string | null;
    expiresAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO line_referral_coupons (
       id, friend_id, reward_id, role, coupon_code, discount_value, discount_currency,
       issued_at, expires_at, status, redeemed_at
     ) VALUES (?, ?, ?, 'referrer', ?, 500, 'JPY', '2026-08-01T00:00:00.000Z', ?, ?, ?)`,
  ).run(
    o.id,
    o.friendId,
    o.rewardId,
    o.code,
    o.expiresAt ?? null,
    o.status ?? 'issued',
    o.redeemedAt ?? null,
  );
}
