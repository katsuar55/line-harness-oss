import { jstNow } from './utils.js';
export interface Friend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  user_id: string | null;
  line_account_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface GetFriendsOptions {
  limit?: number;
  offset?: number;
  tagId?: string;
}

export async function getFriends(
  db: D1Database,
  opts: GetFriendsOptions = {},
): Promise<Friend[]> {
  const { limit = 50, offset = 0, tagId } = opts;

  if (tagId) {
    const result = await db
      .prepare(
        `SELECT f.*
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         WHERE ft.tag_id = ?
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tagId, limit, offset)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM friends
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Friend>();
  return result.results;
}

export async function getFriendByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
    .bind(lineUserId)
    .first<Friend>();
}

export async function getFriendById(
  db: D1Database,
  id: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE id = ?`)
    .bind(id)
    .first<Friend>();
}

export interface UpsertFriendInput {
  lineUserId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
}

export async function upsertFriend(
  db: D1Database,
  input: UpsertFriendInput,
): Promise<Friend> {
  const now = jstNow();
  const existing = await getFriendByLineUserId(db, input.lineUserId);

  if (existing) {
    await db
      .prepare(
        `UPDATE friends
         SET display_name = ?,
             picture_url = ?,
             status_message = ?,
             is_following = 1,
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(
        'displayName' in input ? (input.displayName ?? null) : existing.display_name,
        'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
        'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
        now,
        input.lineUserId,
      )
      .run();

    return (await getFriendByLineUserId(db, input.lineUserId))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, picture_url, status_message, is_following, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      id,
      input.lineUserId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.statusMessage ?? null,
      now,
      now,
    )
    .run();

  return (await getFriendById(db, id))!;
}

export async function updateFriendFollowStatus(
  db: D1Database,
  lineUserId: string,
  isFollowing: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
       SET is_following = ?, updated_at = ?
       WHERE line_user_id = ?`,
    )
    .bind(isFollowing ? 1 : 0, jstNow(), lineUserId)
    .run();
}

export async function getFriendCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM friends`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * friends.metadata (JSON) の特定キーを更新。
 * - 未存在/空文字/不正JSON は {} から始める
 * - value が空文字なら該当キーを削除する (segment フィルタの metadata_not_equals と整合させる)
 */
export async function setFriendMetadataField(
  db: D1Database,
  friendId: string,
  key: string,
  value: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT metadata FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ metadata: string | null }>();

  let obj: Record<string, unknown> = {};
  if (row?.metadata) {
    try {
      const parsed: unknown = JSON.parse(row.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = {};
    }
  }

  if (value === '') {
    delete obj[key];
  } else {
    obj[key] = value;
  }

  await db
    .prepare(`UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?`)
    .bind(JSON.stringify(obj), jstNow(), friendId)
    .run();
}
