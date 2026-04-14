/**
 * グループ管理 API ルート
 *
 * - GET    /api/groups              — グループ一覧
 * - POST   /api/groups              — グループ作成
 * - PUT    /api/groups/:id          — グループ更新
 * - DELETE /api/groups/:id          — グループ削除
 * - GET    /api/groups/:id/friends  — グループメンバー一覧
 * - POST   /api/friends/:id/groups  — 友だちをグループに追加
 * - DELETE /api/friends/:id/groups/:groupId — 友だちをグループから除外
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

export const groups = new Hono<Env>();

// GET /api/groups
groups.get('/api/groups', async (c) => {
  const db = c.env.DB;
  const result = await db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM friend_groups fg WHERE fg.group_id = g.id) as member_count
       FROM groups g ORDER BY g.created_at DESC`,
    )
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: result.results });
});

// POST /api/groups
groups.post('/api/groups', async (c) => {
  const body = await c.req.json<{ name: string; description?: string; color?: string }>();
  if (!body.name?.trim()) {
    return c.json({ success: false, error: 'name is required' }, 400);
  }
  const db = c.env.DB;
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare('INSERT INTO groups (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, body.name.trim(), body.description ?? '', body.color ?? '#6B7280', now, now)
    .run();
  const group = await db.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: group }, 201);
});

// PUT /api/groups/:id
groups.put('/api/groups/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; description?: string; color?: string }>();
  const db = c.env.DB;
  const existing = await db.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, error: 'Group not found' }, 404);

  await db
    .prepare('UPDATE groups SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color), updated_at = ? WHERE id = ?')
    .bind(body.name ?? null, body.description ?? null, body.color ?? null, jstNow(), id)
    .run();
  const updated = await db.prepare('SELECT * FROM groups WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: updated });
});

// DELETE /api/groups/:id
groups.delete('/api/groups/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  await db.prepare('DELETE FROM groups WHERE id = ?').bind(id).run();
  return c.json({ success: true, data: null });
});

// GET /api/groups/:id/friends
groups.get('/api/groups/:id/friends', async (c) => {
  const groupId = c.req.param('id');
  const db = c.env.DB;
  const result = await db
    .prepare(
      `SELECT f.id, f.line_user_id, f.display_name, f.picture_url, fg.assigned_at
       FROM friend_groups fg
       JOIN friends f ON f.id = fg.friend_id
       WHERE fg.group_id = ?
       ORDER BY fg.assigned_at DESC`,
    )
    .bind(groupId)
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: result.results });
});

// POST /api/friends/:id/groups — 友だちをグループに追加
groups.post('/api/friends/:id/groups', async (c) => {
  const friendId = c.req.param('id');
  const body = await c.req.json<{ groupId: string }>();
  if (!body.groupId) return c.json({ success: false, error: 'groupId is required' }, 400);

  const db = c.env.DB;
  await db
    .prepare('INSERT OR IGNORE INTO friend_groups (friend_id, group_id, assigned_at) VALUES (?, ?, ?)')
    .bind(friendId, body.groupId, jstNow())
    .run();
  return c.json({ success: true, data: null });
});

// DELETE /api/friends/:id/groups/:groupId — 友だちをグループから除外
groups.delete('/api/friends/:id/groups/:groupId', async (c) => {
  const friendId = c.req.param('id');
  const groupId = c.req.param('groupId');
  const db = c.env.DB;
  await db
    .prepare('DELETE FROM friend_groups WHERE friend_id = ? AND group_id = ?')
    .bind(friendId, groupId)
    .run();
  return c.json({ success: true, data: null });
});
