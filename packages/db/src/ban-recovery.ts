/**
 * Phase 5α-7: ブロック復活施策 (block recovery) クエリヘルパー
 *
 * friends テーブルの last_unfollowed_at / last_refollowed_at / unfollow_count を集計し、
 * 「ブロックされたが復活した友だち」 と 「現在ブロック中の友だち」 を可視化する。
 *
 * 設計方針:
 *   - 全クエリは line_account_id でオプショナルにフィルタ (multi-tenant 整合)
 *   - 日付比較は ISO 8601 (+09:00) 文字列の lexicographic ordering で実施
 *   - cutoff timestamp は JS 側で算出して bind (SQLite の datetime modifier 連結 制約回避)
 */

import { toJstString } from './utils';

export interface BanRecoveryStats {
  /** 現在 follow 中の友だち数 (is_following=1) */
  totalFollowers: number;
  /** 現在ブロック中の友だち数 (is_following=0) */
  totalBlocked: number;
  /** 直近 N 日に再 follow した友だち数 (last_refollowed_at >= cutoff AND is_following=1) */
  recoveredLastNDays: number;
  /** 2 回以上 unfollow したリピート離脱 友だち数 */
  repeatBlockers: number;
}

export interface RecoveredFriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  last_unfollowed_at: string | null;
  last_refollowed_at: string | null;
  unfollow_count: number;
}

export interface BlockedFriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  last_unfollowed_at: string | null;
  unfollow_count: number;
}

/**
 * cutoff timestamp を「N 日前」 の JST ISO 8601 文字列で算出。
 * SQLite の datetime modifier に `?` 連結を含められない制約の回避策。
 */
function nDaysAgoJst(days: number): string {
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  return toJstString(new Date(cutoffMs));
}

/**
 * ブロック復活施策の統計を取得。
 *
 * @param db D1 database
 * @param lineAccountId optional account filter (multi-tenant)
 * @param withinDays recoveredLastNDays の N (default 30)
 */
export async function getBanRecoveryStats(
  db: D1Database,
  lineAccountId?: string,
  withinDays = 30,
): Promise<BanRecoveryStats> {
  const accountFilter = lineAccountId ? 'AND line_account_id = ?' : '';
  const accountBind = lineAccountId ? [lineAccountId] : [];
  const cutoff = nDaysAgoJst(withinDays);

  const followers = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM friends WHERE is_following = 1 ${accountFilter}`,
    )
    .bind(...accountBind)
    .first<{ cnt: number }>();

  const blocked = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM friends WHERE is_following = 0 ${accountFilter}`,
    )
    .bind(...accountBind)
    .first<{ cnt: number }>();

  const recovered = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM friends
        WHERE last_refollowed_at IS NOT NULL
          AND last_refollowed_at >= ?
          AND is_following = 1
          ${accountFilter}`,
    )
    .bind(cutoff, ...accountBind)
    .first<{ cnt: number }>();

  const repeat = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM friends WHERE unfollow_count >= 2 ${accountFilter}`,
    )
    .bind(...accountBind)
    .first<{ cnt: number }>();

  return {
    totalFollowers: followers?.cnt ?? 0,
    totalBlocked: blocked?.cnt ?? 0,
    recoveredLastNDays: recovered?.cnt ?? 0,
    repeatBlockers: repeat?.cnt ?? 0,
  };
}

/**
 * 直近に再 follow した (= ブロック復活した) 友だちを timeline 順で取得。
 * 現在 follow 中 (is_following=1) のみ含める。
 */
export async function getRecentlyRecoveredFriends(
  db: D1Database,
  lineAccountId?: string,
  limit = 50,
): Promise<RecoveredFriendRow[]> {
  const accountFilter = lineAccountId ? 'AND line_account_id = ?' : '';
  const bindings: unknown[] = lineAccountId ? [lineAccountId, limit] : [limit];
  const result = await db
    .prepare(
      `SELECT id, line_user_id, display_name, picture_url,
              last_unfollowed_at, last_refollowed_at, unfollow_count
         FROM friends
        WHERE last_refollowed_at IS NOT NULL
          AND is_following = 1
          ${accountFilter}
        ORDER BY last_refollowed_at DESC
        LIMIT ?`,
    )
    .bind(...bindings)
    .all<RecoveredFriendRow>();
  return result.results;
}

/**
 * 現在ブロック中 (履歴あり) の友だちを timeline 順で取得。
 * 再アプローチ施策の対象候補。
 */
export async function getCurrentlyBlockedFriends(
  db: D1Database,
  lineAccountId?: string,
  limit = 50,
): Promise<BlockedFriendRow[]> {
  const accountFilter = lineAccountId ? 'AND line_account_id = ?' : '';
  const bindings: unknown[] = lineAccountId ? [lineAccountId, limit] : [limit];
  const result = await db
    .prepare(
      `SELECT id, line_user_id, display_name, picture_url,
              last_unfollowed_at, unfollow_count
         FROM friends
        WHERE is_following = 0
          AND last_unfollowed_at IS NOT NULL
          ${accountFilter}
        ORDER BY last_unfollowed_at DESC
        LIMIT ?`,
    )
    .bind(...bindings)
    .all<BlockedFriendRow>();
  return result.results;
}
