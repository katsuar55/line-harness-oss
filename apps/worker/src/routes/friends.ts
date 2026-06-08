import { Hono } from 'hono';
import {
  getFriends,
  getFriendById,
  getFriendByLineUserId,
  getFriendCount,
  upsertFriend,
  addTagToFriend,
  removeTagFromFriend,
  getFriendTags,
  getScenarios,
  enrollFriendInScenario,
  jstNow,
} from '@line-crm/db';
import type { Friend as DbFriend, Tag as DbTag } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildEmailDispatchConfig } from '../services/email-dispatch-config.js';
import { buildMessage } from '../services/step-delivery.js';
import { auditAdmin } from '../services/audit-logger.js';
import { importFriendsRows } from '../services/friends-import.js';
import { parseCsvWithHeader } from '../utils/csv-parser.js';
import type { Env } from '../index.js';

const friends = new Hono<Env>();

/** Convert a D1 snake_case Friend row to the shared camelCase shape */
function serializeFriend(row: DbFriend) {
  const r = row as unknown as Record<string, unknown>;
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    pictureUrl: row.picture_url,
    statusMessage: row.status_message,
    isFollowing: Boolean(row.is_following),
    metadata: JSON.parse(row.metadata || '{}'),
    refCode: r.ref_code as string | null,
    userId: row.user_id,
    // ⑮ ステータス管理
    status: (r.status as string) || 'none',
    // ⑲ ユーザー情報拡充
    phone: r.phone as string | null,
    email: r.email as string | null,
    birthday: r.birthday as string | null,
    gender: r.gender as string | null,
    address: r.address as string | null,
    memo: r.memo as string | null,
    // ⑳ 担当者
    assignedStaffId: r.assigned_staff_id as string | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert a D1 snake_case Tag row to the shared camelCase shape */
function serializeTag(row: DbTag) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at,
  };
}

// GET /api/friends - list with pagination
friends.get('/api/friends', async (c) => {
  try {
    const limit = Number(c.req.query('limit') ?? '50');
    const offset = Number(c.req.query('offset') ?? '0');
    const tagId = c.req.query('tagId');
    const lineAccountId = c.req.query('lineAccountId');
    const search = c.req.query('search');

    const db = c.env.DB;

    // Build WHERE conditions
    const conditions: string[] = [];
    const binds: unknown[] = [];
    if (tagId) {
      conditions.push('EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
      binds.push(tagId);
    }
    if (lineAccountId) {
      conditions.push('f.line_account_id = ?');
      binds.push(lineAccountId);
    }
    if (search) {
      conditions.push('f.display_name LIKE ?');
      binds.push(`%${search}%`);
    }
    // Metadata filters: ?metadata.key=value (e.g. ?metadata.monthly_cost=〜100万円)
    const url = new URL(c.req.url);
    for (const [key, value] of url.searchParams.entries()) {
      if (key.startsWith('metadata.')) {
        const metaKey = key.slice('metadata.'.length);
        conditions.push(`json_extract(f.metadata, '$.' || ?) = ?`);
        binds.push(metaKey, value);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM friends f ${where}`);
    const totalRow = await (binds.length > 0 ? countStmt.bind(...binds) : countStmt).first<{ count: number }>();
    const total = totalRow?.count ?? 0;

    const listStmt = db.prepare(
      `SELECT f.* FROM friends f ${where} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
    );
    const listBinds = [...binds, limit, offset];
    const listResult = await listStmt.bind(...listBinds).all<DbFriend>();
    const items = listResult.results;

    // Fetch tags for each friend in parallel so the list response includes tags
    const itemsWithTags = await Promise.all(
      items.map(async (friend) => {
        const tags = await getFriendTags(db, friend.id);
        return { ...serializeFriend(friend), tags: tags.map(serializeTag) };
      }),
    );

    return c.json({
      success: true,
      data: {
        items: itemsWithTags,
        total,
        page: Math.floor(offset / limit) + 1,
        limit,
        hasNextPage: offset + limit < total,
      },
    });
  } catch (err) {
    console.error('GET /api/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/count - friend count (must be before /:id)
friends.get('/api/friends/count', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    let count: number;
    if (lineAccountId) {
      const row = await c.env.DB.prepare('SELECT COUNT(*) as count FROM friends WHERE is_following = 1 AND line_account_id = ?')
        .bind(lineAccountId).first<{ count: number }>();
      count = row?.count ?? 0;
    } else {
      count = await getFriendCount(c.env.DB);
    }
    return c.json({ success: true, data: { count } });
  } catch (err) {
    console.error('GET /api/friends/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/import - CSV bulk import (LSTEP audit H1)
// body: { csv: string, dryRun?: boolean }
// max 5,000 data rows / 1 MB body
friends.post('/api/friends/import', async (c) => {
  const MAX_CSV_BYTES = 1_048_576; // 1 MB
  const MAX_DATA_ROWS = 5000;
  try {
    const body = (await c.req
      .json<{ csv?: unknown; dryRun?: unknown }>()
      .catch(() => ({}))) as { csv?: unknown; dryRun?: unknown };
    const csv = body.csv;
    const dryRun = body.dryRun === true;
    if (typeof csv !== 'string' || csv.trim().length === 0) {
      return c.json({ success: false, error: '"csv" string is required' }, 400);
    }
    if (csv.length > MAX_CSV_BYTES) {
      return c.json(
        { success: false, error: `CSV exceeds max size ${MAX_CSV_BYTES} bytes` },
        413,
      );
    }

    let parsed: { headers: string[]; rows: string[][] };
    try {
      parsed = parseCsvWithHeader(csv, { maxRows: MAX_DATA_ROWS + 1 });
    } catch (err) {
      return c.json(
        {
          success: false,
          error: `CSV parse failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
        },
        400,
      );
    }

    if (parsed.rows.length > MAX_DATA_ROWS) {
      return c.json(
        { success: false, error: `Too many rows (max ${MAX_DATA_ROWS})` },
        413,
      );
    }

    const result = await importFriendsRows(c.env.DB, parsed.headers, parsed.rows, dryRun);

    // audit (= dryRun でも記録、 admin 履歴に残す)
    // errorCount > 0 でも全 row failure ではないので 'success' (= 部分成功は metadata.errorCount で識別)
    await auditAdmin(c, {
      action: dryRun ? 'friends.import.dry_run' : 'friends.import.run',
      targetType: 'friends',
      result: result.created + result.updated === 0 && result.errors.length > 0 ? 'failure' : 'success',
      metadata: {
        totalRows: result.totalRows,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errorCount: result.errors.length,
        dryRun: result.dryRun,
      },
    });

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/friends/import error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/ref-stats - ref code attribution stats
friends.get('/api/friends/ref-stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const where = lineAccountId ? 'WHERE line_account_id = ?' : 'WHERE ref_code IS NOT NULL';
    const binds = lineAccountId ? [lineAccountId] : [];
    const stmt = c.env.DB.prepare(
      `SELECT ref_code, COUNT(*) as count FROM friends ${where} AND ref_code IS NOT NULL GROUP BY ref_code ORDER BY count DESC`,
    );
    const result = await (binds.length > 0 ? stmt.bind(...binds) : stmt).all<{ ref_code: string; count: number }>();
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM friends ${lineAccountId ? 'WHERE line_account_id = ?' : ''} ${lineAccountId ? 'AND' : 'WHERE'} ref_code IS NOT NULL`,
    ).bind(...(lineAccountId ? [lineAccountId] : [])).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        routes: result.results.map((r) => ({ refCode: r.ref_code, friendCount: r.count })),
        totalWithRef: total?.count ?? 0,
      },
    });
  } catch (err) {
    console.error('GET /api/friends/ref-stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id - get single friend with tags
friends.get('/api/friends/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const db = c.env.DB;

    const [friend, tags] = await Promise.all([
      getFriendById(db, id),
      getFriendTags(db, id),
    ]);

    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        ...serializeFriend(friend),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/tags - add tag
friends.post('/api/friends/:id/tags', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ tagId: string }>();

    if (!body.tagId) {
      return c.json({ success: false, error: 'tagId is required' }, 400);
    }

    const db = c.env.DB;
    await addTagToFriend(db, friendId, body.tagId);

    // Enroll in tag_added scenarios that match this tag
    const allScenarios = await getScenarios(db);
    for (const scenario of allScenarios) {
      if (scenario.trigger_type === 'tag_added' && scenario.is_active && scenario.trigger_tag_id === body.tagId) {
        const existing = await db
          .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
          .bind(friendId, scenario.id)
          .first();
        if (!existing) {
          await enrollFriendInScenario(db, friendId, scenario.id);
        }
      }
    }

    // イベントバス発火: tag_change (Round 4 PR-6: email automation 用 config を渡す)
    await fireEvent(
      db,
      'tag_change',
      { friendId, eventData: { tagId: body.tagId, action: 'add' } },
      undefined,
      undefined,
      buildEmailDispatchConfig(c.env),
    );

    return c.json({ success: true, data: null }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/tags error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:id/tags/:tagId - remove tag
friends.delete('/api/friends/:id/tags/:tagId', async (c) => {
  try {
    const friendId = c.req.param('id');
    const tagId = c.req.param('tagId');

    await removeTagFromFriend(c.env.DB, friendId, tagId);

    // イベントバス発火: tag_change
    await fireEvent(
      c.env.DB,
      'tag_change',
      { friendId, eventData: { tagId, action: 'remove' } },
      undefined,
      undefined,
      buildEmailDispatchConfig(c.env),
    );

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/friends/:id/tags/:tagId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/metadata - merge metadata fields
friends.put('/api/friends/:id/metadata', async (c) => {
  try {
    const friendId = c.req.param('id');
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const existing = JSON.parse(friend.metadata || '{}');
    const merged = { ...existing, ...body };
    const now = jstNow();

    await db
      .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(merged), now, friendId)
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);

    return c.json({
      success: true,
      data: {
        ...serializeFriend(updated!),
        tags: tags.map(serializeTag),
      },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/metadata error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ⑮ PUT /api/friends/:id/status - ステータス更新（per-friend）
friends.put('/api/friends/:id/status', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ status: string }>();
    const allowed = ['none', 'prospect', 'active', 'vip', 'dormant', 'churned'];
    if (!body.status || !allowed.includes(body.status)) {
      return c.json({ success: false, error: `status must be one of: ${allowed.join(', ')}` }, 400);
    }
    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    await db
      .prepare('UPDATE friends SET status = ?, updated_at = ? WHERE id = ?')
      .bind(body.status, jstNow(), friendId)
      .run();
    return c.json({ success: true, data: { friendId, status: body.status } });
  } catch (err) {
    console.error('PUT /api/friends/:id/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ⑲ PUT /api/friends/:id/profile - ユーザー情報編集（住所・電話・メール・誕生日・性別・メモ）
friends.put('/api/friends/:id/profile', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      phone?: string | null;
      email?: string | null;
      birthday?: string | null;
      gender?: string | null;
      address?: string | null;
      memo?: string | null;
      displayName?: string | null;
    }>();

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    await db
      .prepare(
        `UPDATE friends SET
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           birthday = COALESCE(?, birthday),
           gender = COALESCE(?, gender),
           address = COALESCE(?, address),
           memo = COALESCE(?, memo),
           display_name = COALESCE(?, display_name),
           updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        body.phone ?? null,
        body.email ?? null,
        body.birthday ?? null,
        body.gender ?? null,
        body.address ?? null,
        body.memo ?? null,
        body.displayName ?? null,
        jstNow(),
        friendId,
      )
      .run();

    const updated = await getFriendById(db, friendId);
    const tags = await getFriendTags(db, friendId);
    return c.json({
      success: true,
      data: { ...serializeFriend(updated!), tags: tags.map(serializeTag) },
    });
  } catch (err) {
    console.error('PUT /api/friends/:id/profile error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ⑳ PUT /api/friends/:id/assign-staff - 担当者割り当て
friends.put('/api/friends/:id/assign-staff', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{ staffId: string | null }>();

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);

    // staffId が指定された場合は存在確認
    if (body.staffId) {
      const staffExists = await db
        .prepare('SELECT id FROM staff_members WHERE id = ? AND is_active = 1')
        .bind(body.staffId)
        .first();
      if (!staffExists) return c.json({ success: false, error: 'Staff not found or inactive' }, 404);
    }

    await db
      .prepare('UPDATE friends SET assigned_staff_id = ?, updated_at = ? WHERE id = ?')
      .bind(body.staffId ?? null, jstNow(), friendId)
      .run();

    return c.json({ success: true, data: { friendId, assignedStaffId: body.staffId } });
  } catch (err) {
    console.error('PUT /api/friends/:id/assign-staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/friends/:id/blacklist - ブラックリスト設定/解除
friends.put('/api/friends/:id/blacklist', async (c) => {
  const friendId = c.req.param('id');
  try {
    const body = await c.req.json<{ blacklisted: boolean }>();
    const value = body.blacklisted ? 1 : 0;
    // Phase 5α-3b: blacklist は配信影響大の destructive 操作なので before/after audit
    const before = await c.env.DB
      .prepare('SELECT is_blacklisted, line_account_id FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ is_blacklisted: number | null; line_account_id: string | null }>();
    await c.env.DB
      .prepare('UPDATE friends SET is_blacklisted = ?, updated_at = ? WHERE id = ?')
      .bind(value, new Date(Date.now() + 9 * 3600_000).toISOString().replace('Z', ''), friendId)
      .run();
    await auditAdmin(c, {
      action: value === 1 ? 'friend.blacklist.set' : 'friend.blacklist.unset',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId: before?.line_account_id ?? null,
      before: { is_blacklisted: before?.is_blacklisted ?? 0 },
      after: { is_blacklisted: value },
    });
    return c.json({ success: true, data: { friendId, is_blacklisted: value } });
  } catch (err) {
    console.error('PUT /api/friends/:id/blacklist error:', err);
    await auditAdmin(c, {
      action: 'friend.blacklist',
      targetType: 'friend',
      targetId: friendId,
      result: 'failure',
      errorMessage: err instanceof Error ? err.message.slice(0, 480) : 'unknown',
    });
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:id/messages - get message history
friends.get('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const result = await c.env.DB
      .prepare(
        `SELECT id, direction, message_type as messageType, content, created_at as createdAt
         FROM messages_log WHERE friend_id = ? ORDER BY created_at ASC LIMIT 200`,
      )
      .bind(friendId)
      .all<{ id: string; direction: string; messageType: string; content: string; createdAt: string }>();
    return c.json({ success: true, data: result.results });
  } catch (err) {
    console.error('GET /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:id/messages - send message to friend
friends.post('/api/friends/:id/messages', async (c) => {
  try {
    const friendId = c.req.param('id');
    const body = await c.req.json<{
      messageType?: string;
      content: string;
      altText?: string;
    }>();

    if (!body.content) {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    // Resolve access token from friend's account (multi-account support)
    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if ((friend as unknown as Record<string, unknown>).line_account_id) {
      const { getLineAccountById } = await import('@line-crm/db');
      const account = await getLineAccountById(db, (friend as unknown as Record<string, unknown>).line_account_id as string);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    const messageType = body.messageType ?? 'text';

    // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
    const { autoTrackContent } = await import('../services/auto-track.js');
    const tracked = await autoTrackContent(
      db, messageType, body.content,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );

    const message = buildMessage(tracked.messageType, tracked.content, body.altText);
    await lineClient.pushMessage(friend.line_user_id, [message]);

    // Log outgoing message
    const logId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, messageType, body.content, jstNow())
      .run();

    return c.json({ success: true, data: { messageId: logId } });
  } catch (err) {
    console.error('POST /api/friends/:id/messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/import-followers
// 移行core (DMM 移行): LINE OA から友だちを直接投入する (getFollowerIds + getProfile)。
// CSV import と異なり LINE プラットフォームから直接取得するため userId が常に正確。
// ⚠️ getFollowerIds は「認証済 / プレミアム」 OA 限定 — 未認証 OA は LINE 403 を返す
//    (その場合は友だちが再アクションした時に webhook follow handler が逐次登録する)。
// 冪等: upsertFriend で再実行安全。 env default account 運用のため line_account_id は設定しない
//    (= follow handler の matchedAccountId=null 時と同じ挙動)。
// body: { start?, maxPages?, fetchProfiles?, maxProfiles?, dryRun? }
//   大量フォロワーは maxPages で 1 リクエストを区切り、 返却 nextCursor を次回 start に渡して再開
//   (Worker の CPU 時間制限と getProfile レート制限への配慮)。
friends.post('/api/friends/import-followers', async (c) => {
  const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;
  const PAGE_SIZE = 1000;
  // ⚠️ Worker の CPU/wall-clock (~30s) と subrequest 上限への配慮で 1 リクエストの作業量を小さく保つ。
  //    大量フォロワーは nextCursor を次回 start に渡して複数回に分けて取り込む (resumable)。
  const DEFAULT_MAX_PAGES = 2; // = 最大 2,000 id/リクエスト
  const MAX_PAGES_CAP = 5; // = 最大 5,000 id/リクエスト (backstop)
  const DEFAULT_MAX_PROFILES = 50;
  const MAX_PROFILES_CAP = 200;
  const MAX_START_LEN = 512; // LINE cursor は短い base64url。 異常に長い入力を弾く

  const toInt = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, v));

  try {
    const body = (await c.req
      .json<{
        start?: unknown;
        maxPages?: unknown;
        fetchProfiles?: unknown;
        maxProfiles?: unknown;
        dryRun?: unknown;
      }>()
      .catch(() => ({}))) as {
      start?: unknown;
      maxPages?: unknown;
      fetchProfiles?: unknown;
      maxProfiles?: unknown;
      dryRun?: unknown;
    };

    const start =
      typeof body.start === 'string' &&
      body.start.length > 0 &&
      body.start.length <= MAX_START_LEN
        ? body.start
        : undefined;
    const dryRun = body.dryRun === true;
    const fetchProfiles = body.fetchProfiles !== false; // default: true
    const maxPages = clamp(toInt(body.maxPages, DEFAULT_MAX_PAGES), 1, MAX_PAGES_CAP);
    const maxProfiles = clamp(
      toInt(body.maxProfiles, DEFAULT_MAX_PROFILES),
      0,
      MAX_PROFILES_CAP,
    );

    const accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) {
      return c.json(
        { success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' },
        500,
      );
    }

    const { LineClient } = await import('@line-crm/line-sdk');
    const lineClient = new LineClient(accessToken);

    let cursor = start;
    let pages = 0;
    let scanned = 0; // LINE から返った id 総数
    let matched = 0; // 形式が valid な id (= 取り込み候補。 dryRun でもカウント)
    let upserted = 0; // 実際に DB へ書き込んだ件数 (dryRun では 0)
    let profilesFetched = 0;
    let skipped = 0;
    const errors: string[] = [];
    let nextCursor: string | null = null;
    let hasMore = false;

    try {
      do {
        const page = await lineClient.getFollowerIds(cursor, PAGE_SIZE);
        pages++;
        const ids = Array.isArray(page.userIds) ? page.userIds : [];
        for (const userId of ids) {
          scanned++;
          if (typeof userId !== 'string' || !LINE_USER_ID_RE.test(userId)) {
            skipped++;
            continue;
          }
          matched++;
          let profile:
            | { displayName?: string; pictureUrl?: string; statusMessage?: string }
            | undefined;
          if (fetchProfiles && !dryRun && profilesFetched < maxProfiles) {
            try {
              const existing = await getFriendByLineUserId(c.env.DB, userId);
              // 新規友だちのみ profile 取得 (既存は upsertFriend が ?? で維持)
              if (!existing) {
                profile = await lineClient.getProfile(userId);
                profilesFetched++;
              }
            } catch (err) {
              // best-effort: profile 取得失敗でも id は登録する。 PII 最小化で userId は記録せず ordinal のみ
              const m = err instanceof Error ? err.message : String(err);
              if (errors.length < 50) errors.push(`profile (record ${scanned}): ${m.slice(0, 100)}`);
            }
          }
          if (!dryRun) {
            try {
              await upsertFriend(c.env.DB, {
                lineUserId: userId,
                displayName: profile?.displayName ?? null,
                pictureUrl: profile?.pictureUrl ?? null,
                statusMessage: profile?.statusMessage ?? null,
              });
              upserted++;
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              if (errors.length < 50) errors.push(`upsert (record ${scanned}): ${m.slice(0, 100)}`);
            }
          }
        }
        cursor = page.next;
        // 通常終了 (cursor 無し) + 空ページが cursor 付きで続く異常時の暴走防止 (= maxPages backstop で必ず止まる)
        if (!cursor) break;
        if (pages >= maxPages) {
          nextCursor = cursor;
          hasMore = true;
          break;
        }
      } while (cursor);
    } catch (err) {
      // getFollowerIds 自体の失敗 (例: 未認証 OA = 403)。 部分結果 + 明確な理由を返す。
      // 生の LINE API body は client に返さない (= 情報漏洩防止)。 詳細は audit に内部記録。
      const status = (err as { status?: number })?.status;
      const m = err instanceof Error ? err.message : String(err);
      const unverified = status === 403 || /LINE API error: 403\b/.test(m);
      await auditAdmin(c, {
        action: 'friends.import_followers.error',
        targetType: 'friends',
        result: 'failure',
        metadata: {
          scanned,
          matched,
          upserted,
          profilesFetched,
          pages,
          status: status ?? null,
          error: m.slice(0, 300),
        },
      });
      return c.json(
        {
          success: false,
          error: unverified
            ? 'LINE getFollowerIds は認証済/プレミアム公式アカウント限定です (HTTP 403)。 友だちは再アクション時に自動登録されます。'
            : `LINE API error${status ? ` (HTTP ${status})` : ''}`,
          data: { scanned, matched, upserted, profilesFetched, pages },
        },
        unverified ? 422 : 502,
      );
    }

    await auditAdmin(c, {
      action: dryRun
        ? 'friends.import_followers.dry_run'
        : 'friends.import_followers.run',
      targetType: 'friends',
      result: 'success',
      metadata: {
        scanned,
        matched,
        upserted,
        profilesFetched,
        skipped,
        pages,
        errorCount: errors.length,
        hasMore,
        dryRun,
      },
    });

    return c.json({
      success: true,
      data: {
        scanned,
        matched,
        upserted,
        profilesFetched,
        skipped,
        pages,
        errors: errors.slice(0, 50),
        nextCursor,
        hasMore,
      },
    });
  } catch (err) {
    console.error('POST /api/friends/import-followers error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friends };
