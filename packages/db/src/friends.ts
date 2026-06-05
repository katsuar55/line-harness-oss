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
  /** Shopify customer 数値 ID (= migration 060。 PR3 で metafield 逆引きにより populate)。 未 link は null。 */
  shopify_customer_id: string | null;
  /**
   * ブラックリスト (= do-not-contact)。 全配信から除外される (consent/景表法)。
   * 列は `INTEGER NOT NULL DEFAULT 0` で常に存在するが、 多くの既存 Friend literal が
   * 省略しているため optional として宣言 (= blast radius 最小化)。 読む側は 0/undefined を falsy 扱い。
   */
  is_blacklisted?: number;
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
    // Phase 5α-7: 既存友だちが is_following=0 (ブロック済) かつ last_unfollowed_at が
    //   セット済の場合は last_refollowed_at を now でマーク (= ブロック復活)
    await db
      .prepare(
        `UPDATE friends
         SET display_name = ?,
             picture_url = ?,
             status_message = ?,
             is_following = 1,
             last_refollowed_at = CASE
               WHEN is_following = 0 AND last_unfollowed_at IS NOT NULL THEN ?
               ELSE last_refollowed_at
             END,
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(
        // null/undefined は「値なし = 既存維持」。 profile 取得失敗 (= getProfile throw) や
        // LIFF 由来 null での re-follow で、 既存の display_name 等を null 上書きしないため。
        // (= 明示 null で「clear」 する用途は profile sync には無い)
        input.displayName ?? existing.display_name,
        input.pictureUrl ?? existing.picture_url,
        input.statusMessage ?? existing.status_message,
        now,
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
  const now = jstNow();
  if (isFollowing) {
    // Phase 5α-7: 直前に unfollow されていたら last_refollowed_at をマーク (ブロック復活)
    await db
      .prepare(
        `UPDATE friends
         SET is_following = 1,
             last_refollowed_at = CASE
               WHEN is_following = 0 AND last_unfollowed_at IS NOT NULL THEN ?
               ELSE last_refollowed_at
             END,
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(now, now, lineUserId)
      .run();
  } else {
    // Phase 5α-7: unfollow を timestamp + count で記録
    await db
      .prepare(
        `UPDATE friends
         SET is_following = 0,
             last_unfollowed_at = ?,
             unfollow_count = unfollow_count + 1,
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(now, now, lineUserId)
      .run();
  }
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

/**
 * friends.shopify_customer_id を設定 (= PR3 friend↔Shopify customer link)。
 * 既に link 済 (= shopify_customer_id IS NOT NULL) の場合は上書きせず no-op (idempotent)。
 * UNIQUE partial index (idx_friends_shopify_customer_id) により、 同 customer が別 friend に
 * 既 link 済の場合は constraint violation で throw する (= caller が getFriendByShopifyCustomerId で事前検査)。
 *
 * @returns linked=true なら新規に link した (changes>0)、 false なら既 link 済で no-op。
 */
export async function setFriendShopifyCustomerId(
  db: D1Database,
  friendId: string,
  shopifyCustomerId: string,
): Promise<{ linked: boolean }> {
  const res = await db
    .prepare(
      `UPDATE friends SET shopify_customer_id = ?, updated_at = ?
        WHERE id = ? AND shopify_customer_id IS NULL`,
    )
    .bind(shopifyCustomerId, jstNow(), friendId)
    .run();
  return { linked: (res.meta?.changes ?? 0) > 0 };
}

/**
 * shopify_customer_id 未設定 (= 未 link) かつ line_user_id を持つ friend を取得 (= PR3 link scan 用)。
 * line_user_id は metafield 逆引きの key なので必須。 created_at 昇順で古い friend を優先。
 */
export async function listUnlinkedFriends(
  db: D1Database,
  limit = 25,
): Promise<Array<{ id: string; line_user_id: string }>> {
  const res = await db
    .prepare(
      `SELECT id, line_user_id FROM friends
        WHERE shopify_customer_id IS NULL
          AND line_user_id IS NOT NULL AND line_user_id != ''
        ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; line_user_id: string }>();
  return res.results ?? [];
}

/**
 * shopify_customer_id から friend を逆引き (= link 重複検査用。 UNIQUE 制約 throw を事前回避)。
 */
export async function getFriendByShopifyCustomerId(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE shopify_customer_id = ?`)
    .bind(shopifyCustomerId)
    .first<Friend>();
}
