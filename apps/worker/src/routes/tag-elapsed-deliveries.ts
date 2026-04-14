/**
 * 日数経過トリガー配信 管理 API
 *
 * - GET    /api/tag-elapsed-deliveries      — ルール一覧
 * - POST   /api/tag-elapsed-deliveries      — ルール作成
 * - PUT    /api/tag-elapsed-deliveries/:id  — ルール更新
 * - DELETE /api/tag-elapsed-deliveries/:id  — ルール削除
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

export const tagElapsedDeliveries = new Hono<Env>();

// GET /api/tag-elapsed-deliveries
tagElapsedDeliveries.get('/api/tag-elapsed-deliveries', async (c) => {
  const db = c.env.DB;
  const result = await db
    .prepare(
      `SELECT d.*, t.name as tag_name,
              (SELECT COUNT(*) FROM tag_elapsed_delivery_logs l WHERE l.delivery_id = d.id) as sent_count
       FROM tag_elapsed_deliveries d
       LEFT JOIN tags t ON t.id = d.trigger_tag_id
       ORDER BY d.created_at DESC`,
    )
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: result.results });
});

// POST /api/tag-elapsed-deliveries
tagElapsedDeliveries.post('/api/tag-elapsed-deliveries', async (c) => {
  const body = await c.req.json<{
    name: string;
    triggerTagId: string;
    elapsedDays: number;
    messageType?: string;
    messageContent: string;
    sendHour?: number;
  }>();

  if (!body.name?.trim() || !body.triggerTagId || !body.elapsedDays || !body.messageContent) {
    return c.json({ success: false, error: 'name, triggerTagId, elapsedDays, messageContent are required' }, 400);
  }

  const db = c.env.DB;
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO tag_elapsed_deliveries (id, name, trigger_tag_id, elapsed_days, message_type, message_content, send_hour, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, body.name.trim(), body.triggerTagId, body.elapsedDays, body.messageType ?? 'text', body.messageContent, body.sendHour ?? 10, now, now)
    .run();

  const created = await db.prepare('SELECT * FROM tag_elapsed_deliveries WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: created }, 201);
});

// PUT /api/tag-elapsed-deliveries/:id
tagElapsedDeliveries.put('/api/tag-elapsed-deliveries/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{
    name?: string;
    triggerTagId?: string;
    elapsedDays?: number;
    messageType?: string;
    messageContent?: string;
    sendHour?: number;
    isActive?: boolean;
  }>();

  const db = c.env.DB;
  const existing = await db.prepare('SELECT * FROM tag_elapsed_deliveries WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

  await db
    .prepare(
      `UPDATE tag_elapsed_deliveries SET
         name = COALESCE(?, name),
         trigger_tag_id = COALESCE(?, trigger_tag_id),
         elapsed_days = COALESCE(?, elapsed_days),
         message_type = COALESCE(?, message_type),
         message_content = COALESCE(?, message_content),
         send_hour = COALESCE(?, send_hour),
         is_active = COALESCE(?, is_active),
         updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      body.name ?? null,
      body.triggerTagId ?? null,
      body.elapsedDays ?? null,
      body.messageType ?? null,
      body.messageContent ?? null,
      body.sendHour ?? null,
      body.isActive !== undefined ? (body.isActive ? 1 : 0) : null,
      jstNow(),
      id,
    )
    .run();

  const updated = await db.prepare('SELECT * FROM tag_elapsed_deliveries WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: updated });
});

// DELETE /api/tag-elapsed-deliveries/:id
tagElapsedDeliveries.delete('/api/tag-elapsed-deliveries/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  await db.prepare('DELETE FROM tag_elapsed_deliveries WHERE id = ?').bind(id).run();
  return c.json({ success: true, data: null });
});
