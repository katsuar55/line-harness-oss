/**
 * リマインドメッセージテンプレート管理API
 *
 * メーカー側が ~1000種のメッセージを登録・管理
 * 時間帯（morning/noon/evening/any）別に設定
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const reminderMessages = new Hono<Env>();

const VALID_TIME_SLOTS = ['morning', 'noon', 'evening', 'any'];
const MAX_MESSAGE_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 50;

// ─── GET /api/reminder-messages — 一覧取得 ───
reminderMessages.get('/api/reminder-messages', async (c) => {
  try {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 50), 200);
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);
    const timeSlot = c.req.query('time_slot');
    const category = c.req.query('category');

    let where = 'WHERE 1=1';
    const params: string[] = [];

    if (timeSlot && VALID_TIME_SLOTS.includes(timeSlot)) {
      where += ' AND time_slot = ?';
      params.push(timeSlot);
    }
    if (category) {
      where += ' AND category = ?';
      params.push(category);
    }

    const countStmt = c.env.DB.prepare(`SELECT COUNT(*) as total FROM reminder_messages ${where}`);
    const countResult = await (params.length > 0
      ? countStmt.bind(...params)
      : countStmt
    ).first<{ total: number }>();

    const dataStmt = c.env.DB.prepare(
      `SELECT id, time_slot, message, category, weight, is_active, created_at, updated_at
       FROM reminder_messages ${where}
       ORDER BY time_slot ASC, created_at DESC
       LIMIT ? OFFSET ?`,
    );
    const allParams = [...params, String(limit), String(offset)];
    const { results } = await dataStmt.bind(...allParams).all();

    return c.json({
      success: true,
      data: {
        messages: results,
        total: countResult?.total ?? 0,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/reminder-messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── GET /api/reminder-messages/stats — 統計 ───
reminderMessages.get('/api/reminder-messages/stats', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT time_slot, COUNT(*) as count, SUM(is_active) as active_count
         FROM reminder_messages GROUP BY time_slot`,
      )
      .all<{ time_slot: string; count: number; active_count: number }>();

    const total = results.reduce((sum, r) => sum + r.count, 0);
    const active = results.reduce((sum, r) => sum + r.active_count, 0);

    return c.json({
      success: true,
      data: {
        total,
        active,
        byTimeSlot: results,
      },
    });
  } catch (err) {
    console.error('GET /api/reminder-messages/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── POST /api/reminder-messages — 新規作成 ───
reminderMessages.post('/api/reminder-messages', async (c) => {
  try {
    const body = await c.req.json<{
      timeSlot?: string;
      message: string;
      category?: string;
      weight?: number;
    }>();

    if (!body.message || body.message.trim().length === 0) {
      return c.json({ success: false, error: 'message is required' }, 400);
    }
    if (body.message.length > MAX_MESSAGE_LENGTH) {
      return c.json({ success: false, error: `message must be ${MAX_MESSAGE_LENGTH} characters or less` }, 400);
    }
    if (body.timeSlot && !VALID_TIME_SLOTS.includes(body.timeSlot)) {
      return c.json({ success: false, error: `time_slot must be one of: ${VALID_TIME_SLOTS.join(', ')}` }, 400);
    }
    if (body.category && body.category.length > MAX_CATEGORY_LENGTH) {
      return c.json({ success: false, error: `category must be ${MAX_CATEGORY_LENGTH} characters or less` }, 400);
    }

    const id = crypto.randomUUID();
    const now = jstNow();

    await c.env.DB
      .prepare(
        `INSERT INTO reminder_messages (id, time_slot, message, category, weight, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        id,
        body.timeSlot ?? 'any',
        body.message.trim(),
        body.category ?? 'general',
        body.weight ?? 1,
        now,
        now,
      )
      .run();

    return c.json({ success: true, data: { id } }, 201);
  } catch (err) {
    console.error('POST /api/reminder-messages error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── POST /api/reminder-messages/bulk — 一括作成 ───
reminderMessages.post('/api/reminder-messages/bulk', async (c) => {
  try {
    const body = await c.req.json<{
      messages: Array<{ timeSlot?: string; message: string; category?: string }>;
    }>();

    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ success: false, error: 'messages array is required' }, 400);
    }
    if (body.messages.length > 100) {
      return c.json({ success: false, error: 'Maximum 100 messages per batch' }, 400);
    }

    const now = jstNow();
    let inserted = 0;
    const errors: string[] = [];

    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i];
      if (!msg.message || msg.message.trim().length === 0) {
        errors.push(`[${i}] message is required`);
        continue;
      }
      if (msg.message.length > MAX_MESSAGE_LENGTH) {
        errors.push(`[${i}] message too long`);
        continue;
      }
      if (msg.timeSlot && !VALID_TIME_SLOTS.includes(msg.timeSlot)) {
        errors.push(`[${i}] invalid time_slot`);
        continue;
      }

      try {
        await c.env.DB
          .prepare(
            `INSERT INTO reminder_messages (id, time_slot, message, category, weight, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .bind(crypto.randomUUID(), msg.timeSlot ?? 'any', msg.message.trim(), msg.category ?? 'general', now, now)
          .run();
        inserted++;
      } catch (err) {
        errors.push(`[${i}] DB error`);
      }
    }

    return c.json({ success: true, data: { inserted, errors } });
  } catch (err) {
    console.error('POST /api/reminder-messages/bulk error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── PUT /api/reminder-messages/:id — 更新 ───
reminderMessages.put('/api/reminder-messages/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      timeSlot?: string;
      message?: string;
      category?: string;
      weight?: number;
      isActive?: boolean;
    }>();

    if (body.message !== undefined && body.message.length > MAX_MESSAGE_LENGTH) {
      return c.json({ success: false, error: `message must be ${MAX_MESSAGE_LENGTH} characters or less` }, 400);
    }
    if (body.timeSlot && !VALID_TIME_SLOTS.includes(body.timeSlot)) {
      return c.json({ success: false, error: `time_slot must be one of: ${VALID_TIME_SLOTS.join(', ')}` }, 400);
    }

    const now = jstNow();
    await c.env.DB
      .prepare(
        `UPDATE reminder_messages SET
         time_slot = COALESCE(?, time_slot),
         message = COALESCE(?, message),
         category = COALESCE(?, category),
         weight = COALESCE(?, weight),
         is_active = COALESCE(?, is_active),
         updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        body.timeSlot ?? null,
        body.message ?? null,
        body.category ?? null,
        body.weight ?? null,
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : null,
        now,
        id,
      )
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error('PUT /api/reminder-messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── DELETE /api/reminder-messages/:id — 削除 ───
reminderMessages.delete('/api/reminder-messages/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM reminder_messages WHERE id = ?').bind(id).run();
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/reminder-messages/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { reminderMessages };
