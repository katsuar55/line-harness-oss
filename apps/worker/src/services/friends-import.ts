/**
 * Friends CSV Import service (LSTEP audit H1、 2026-05-22)
 *
 * 役割:
 *   - admin から bulk friends 登録 / 更新を受け付ける
 *   - upsertFriend で line_user_id 単位 upsert + phone/email/memo の patch UPDATE
 *   - validation + 各行 dry-run / 結果集計
 *
 * column mapping (header 名 → DB column):
 *   - line_user_id, lineuserid, line user id, lineuser_id  → friends.line_user_id
 *   - display_name, name                                   → friends.display_name
 *   - email, mail                                          → friends.email
 *   - phone, tel, phone_number                             → friends.phone
 *   - memo, note, notes                                    → friends.memo
 *
 * validation:
 *   - line_user_id: required、 形式 /^U[0-9a-f]{32}$/ (= LINE OA platform 形式)
 *   - email: optional、 簡易 RFC 5321 lite
 *   - phone: optional、 数値 / ハイフン / 空白 / + のみ
 *
 * 関連:
 *   - utils/csv-parser.ts
 *   - routes/friends.ts (= POST /api/friends/import handler)
 *   - packages/db/src/friends.ts (= upsertFriend)
 */

import { upsertFriend, jstNow } from '@line-crm/db';

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+\d\s\-()]+$/;

const HEADER_ALIASES: Record<string, string> = {
  line_user_id: 'line_user_id',
  lineuserid: 'line_user_id',
  'line user id': 'line_user_id',
  lineuser_id: 'line_user_id',
  user_id: 'line_user_id',
  display_name: 'display_name',
  name: 'display_name',
  displayname: 'display_name',
  email: 'email',
  mail: 'email',
  e_mail: 'email',
  phone: 'phone',
  tel: 'phone',
  phone_number: 'phone',
  telephone: 'phone',
  memo: 'memo',
  note: 'memo',
  notes: 'memo',
  comment: 'memo',
};

export interface ImportRowError {
  /** 1-indexed (= header を 0、 1 行目 data を 1 とする) */
  row: number;
  lineUserId?: string;
  field?: string;
  message: string;
}

export interface ImportFriendsRow {
  line_user_id: string;
  display_name?: string;
  email?: string;
  phone?: string;
  memo?: string;
}

export interface ImportFriendsResult {
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  dryRun: boolean;
}

/**
 * header 行を canonical column name に変換。
 * 不明な header は無視 (errors に追加せず、 単にスルー)。
 */
export function normalizeHeaders(headers: string[]): (string | null)[] {
  return headers.map((h) => HEADER_ALIASES[h.trim().toLowerCase()] ?? null);
}

/**
 * row 配列 + normalized headers → typed row。
 * line_user_id がない行は null を返す (errors に追加する判定は呼出側)。
 */
export function rowToTyped(
  headers: (string | null)[],
  values: string[],
): { row: Partial<ImportFriendsRow>; missingLineUserId: boolean } {
  const row: Partial<ImportFriendsRow> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i];
    if (!key) continue;
    const raw = (values[i] ?? '').trim();
    if (raw.length === 0) continue;
    (row as Record<string, string>)[key] = raw;
  }
  return {
    row,
    missingLineUserId: !row.line_user_id,
  };
}

/**
 * 1 行を validate。 OK なら typed row 返す、 NG なら errors を返す。
 */
export function validateRow(rowIndex: number, row: Partial<ImportFriendsRow>): {
  ok: boolean;
  errors: ImportRowError[];
  parsed?: ImportFriendsRow;
} {
  const errors: ImportRowError[] = [];
  if (!row.line_user_id) {
    errors.push({ row: rowIndex, field: 'line_user_id', message: 'line_user_id is required' });
    return { ok: false, errors };
  }
  if (!LINE_USER_ID_PATTERN.test(row.line_user_id)) {
    errors.push({
      row: rowIndex,
      lineUserId: row.line_user_id,
      field: 'line_user_id',
      message: 'line_user_id must match /^U[0-9a-f]{32}$/i',
    });
    return { ok: false, errors };
  }
  if (row.email && !EMAIL_PATTERN.test(row.email)) {
    errors.push({
      row: rowIndex,
      lineUserId: row.line_user_id,
      field: 'email',
      message: `Invalid email format: ${row.email}`,
    });
  }
  if (row.phone && !PHONE_PATTERN.test(row.phone)) {
    errors.push({
      row: rowIndex,
      lineUserId: row.line_user_id,
      field: 'phone',
      message: `Invalid phone format: ${row.phone}`,
    });
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    errors: [],
    parsed: {
      line_user_id: row.line_user_id,
      display_name: row.display_name,
      email: row.email,
      phone: row.phone,
      memo: row.memo,
    },
  };
}

/**
 * 行を 1 件 import (= upsertFriend + 追加 column UPDATE)。
 * 既存 friend がいた → updated、 なかった → created。
 * dryRun=true なら DB 触らずに「created/updated」 判定のみ返す。
 */
export async function importOneRow(
  db: D1Database,
  parsed: ImportFriendsRow,
  dryRun: boolean,
): Promise<{ action: 'created' | 'updated' }> {
  // 既存判定
  const existing = await db
    .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
    .bind(parsed.line_user_id)
    .first<{ id: string }>();

  if (dryRun) {
    return { action: existing ? 'updated' : 'created' };
  }

  // upsert (display_name は upsertFriend で UPDATE される、 INSERT 時は statusMessage/pictureUrl=null)
  await upsertFriend(db, {
    lineUserId: parsed.line_user_id,
    displayName: parsed.display_name ?? null,
  });

  // phone / email / memo の patch UPDATE (= upsertFriend が触らない column)
  if (parsed.phone !== undefined || parsed.email !== undefined || parsed.memo !== undefined) {
    const now = jstNow();
    await db
      .prepare(
        `UPDATE friends
         SET phone = COALESCE(?, phone),
             email = COALESCE(?, email),
             memo  = COALESCE(?, memo),
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(
        parsed.phone ?? null,
        parsed.email ?? null,
        parsed.memo ?? null,
        now,
        parsed.line_user_id,
      )
      .run();
  }

  return { action: existing ? 'updated' : 'created' };
}

/**
 * import 全体 orchestration。
 *
 * @param db D1
 * @param headers CSV header (= raw、 normalize はここで)
 * @param dataRows CSV data 行配列
 * @param dryRun true なら DB 触らずに count のみ
 */
export async function importFriendsRows(
  db: D1Database,
  headers: string[],
  dataRows: string[][],
  dryRun = false,
): Promise<ImportFriendsResult> {
  const normalized = normalizeHeaders(headers);
  if (!normalized.includes('line_user_id')) {
    return {
      totalRows: dataRows.length,
      created: 0,
      updated: 0,
      skipped: dataRows.length,
      errors: [
        {
          row: 0,
          field: 'line_user_id',
          message: 'CSV must contain a "line_user_id" column (aliases: lineuserid, user_id, etc)',
        },
      ],
      dryRun,
    };
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: ImportRowError[] = [];

  for (let i = 0; i < dataRows.length; i++) {
    const rowIndex = i + 1;
    const { row } = rowToTyped(normalized, dataRows[i]);
    const validation = validateRow(rowIndex, row);
    if (!validation.ok || !validation.parsed) {
      errors.push(...validation.errors);
      skipped++;
      continue;
    }
    try {
      const result = await importOneRow(db, validation.parsed, dryRun);
      if (result.action === 'created') created++;
      else updated++;
    } catch (err) {
      errors.push({
        row: rowIndex,
        lineUserId: validation.parsed.line_user_id,
        message: err instanceof Error ? err.message.slice(0, 200) : 'Unknown error',
      });
      skipped++;
    }
  }

  return {
    totalRows: dataRows.length,
    created,
    updated,
    skipped,
    errors,
    dryRun,
  };
}
