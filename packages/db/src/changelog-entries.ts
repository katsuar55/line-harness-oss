/**
 * Cloudflare changelog entries (= 自動 update 戦略 #2、 2026-05-26)
 *
 * RSS で取得した changelog entry を「通知済 marker」 として保存。
 * 同 entry を二度 Discord 通知しないことを保証。
 */

import { jstNow } from './utils.js';

// ============================================================
// 型
// ============================================================

export interface ChangelogEntryRow {
  id: string;
  entry_url: string;
  title: string;
  category: string;
  published_at: string | null;
  first_seen_at: string;
  notified_at: string | null;
  description: string | null;
}

export interface ChangelogEntry {
  id: string;
  entryUrl: string;
  title: string;
  category: string;
  publishedAt: string | null;
  firstSeenAt: string;
  notifiedAt: string | null;
  description: string | null;
}

export interface UpsertChangelogEntryInput {
  entryUrl: string;
  title: string;
  category: string;
  publishedAt?: string | null;
  description?: string | null;
}

export interface UpsertChangelogEntryResult {
  /** この row が今回の sync で新規追加されたか (= 通知対象判定に使用) */
  isNew: boolean;
}

function rowToEntry(row: ChangelogEntryRow): ChangelogEntry {
  return {
    id: row.id,
    entryUrl: row.entry_url,
    title: row.title,
    category: row.category,
    publishedAt: row.published_at,
    firstSeenAt: row.first_seen_at,
    notifiedAt: row.notified_at,
    description: row.description,
  };
}

// ============================================================
// クエリ
// ============================================================

/**
 * entry を INSERT (= 既存なら no-op)。
 * 戻り値で「新規追加か」 を返す (= 通知判定用)。
 */
export async function upsertChangelogEntry(
  db: D1Database,
  input: UpsertChangelogEntryInput,
): Promise<UpsertChangelogEntryResult> {
  const existing = await db
    .prepare(`SELECT id FROM changelog_entries_seen WHERE entry_url = ?`)
    .bind(input.entryUrl)
    .first<{ id: string }>();

  if (existing) {
    return { isNew: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO changelog_entries_seen
        (id, entry_url, title, category, published_at, first_seen_at, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.entryUrl,
      input.title,
      input.category,
      input.publishedAt ?? null,
      jstNow(),
      input.description ?? null,
    )
    .run();
  return { isNew: true };
}

/** 未通知 entry 一覧 (= 通知 batch 用) */
export async function listUnnotifiedChangelogEntries(
  db: D1Database,
  limit = 50,
): Promise<ChangelogEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM changelog_entries_seen
        WHERE notified_at IS NULL
        ORDER BY published_at DESC NULLS LAST, first_seen_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<ChangelogEntryRow>();
  return (result.results ?? []).map(rowToEntry);
}

/** 通知済 marker (= entry id list) */
export async function markChangelogEntriesNotified(
  db: D1Database,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const now = jstNow();
  // D1 は IN (?, ?, ...) を bind 個別パラメータで処理可
  const placeholders = ids.map(() => '?').join(', ');
  await db
    .prepare(
      `UPDATE changelog_entries_seen
          SET notified_at = ?
        WHERE id IN (${placeholders})`,
    )
    .bind(now, ...ids)
    .run();
}

/** 最近 N 日の entry 一覧 (= admin web 表示用 = 後続 PR) */
export async function listRecentChangelogEntries(
  db: D1Database,
  sinceIso: string,
): Promise<ChangelogEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM changelog_entries_seen
        WHERE first_seen_at >= ?
        ORDER BY published_at DESC NULLS LAST, first_seen_at DESC`,
    )
    .bind(sinceIso)
    .all<ChangelogEntryRow>();
  return (result.results ?? []).map(rowToEntry);
}

export interface ChangelogStats {
  total: number;
  unnotified: number;
  byCategory: Record<string, number>;
}

export async function getChangelogStats(db: D1Database): Promise<ChangelogStats> {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN notified_at IS NULL THEN 1 ELSE 0 END) AS unnotified
         FROM changelog_entries_seen`,
    )
    .first<{ total: number; unnotified: number }>();

  const byCategoryRows = await db
    .prepare(
      `SELECT category, COUNT(*) AS cnt FROM changelog_entries_seen
        GROUP BY category`,
    )
    .all<{ category: string; cnt: number }>();

  const byCategory: Record<string, number> = {};
  for (const row of byCategoryRows.results ?? []) byCategory[row.category] = row.cnt;

  return {
    total: totals?.total ?? 0,
    unnotified: totals?.unnotified ?? 0,
    byCategory,
  };
}
