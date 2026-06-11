/**
 * Auto-Replies admin CRUD (AIネイティブ オペレーター体験 — A案)
 *
 * `auto_replies` テーブルは今まで webhook.ts が読むだけで **管理画面/APIが皆無**だった
 * (DMM パリティの隠れた穴)。本ルートで初の CRUD を提供する。
 * AI Conductor (POST /api/conductor/auto-reply) が起草した内容をここで保存/編集/削除する。
 *
 * 認証: 上位 authMiddleware (API_KEY ベアラー) で保護。
 * schema (packages/db/schema.sql:245): id, keyword, match_type('exact'|'contains'),
 *   response_type(default 'text'), response_content, is_active, created_at。
 *   ※ line_account_id 列は base schema に無いため本 CRUD では扱わない (= 全アカウント共通ルール)。
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { auditAdmin } from '../services/audit-logger.js';
import type { Env } from '../index.js';

export const autoReplies = new Hono<Env>();

const MATCH_TYPES = ['exact', 'contains'] as const;
const KEYWORD_MAX = 40;
const RESPONSE_MAX = 2000;

type MatchType = (typeof MATCH_TYPES)[number];

function isMatchType(v: unknown): v is MatchType {
  return typeof v === 'string' && (MATCH_TYPES as readonly string[]).includes(v);
}

// GET /api/auto-replies — 一覧 (有効/無効すべて、新しい順)
autoReplies.get('/api/auto-replies', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `SELECT id, keyword, match_type, response_type, response_content, is_active, created_at
       FROM auto_replies ORDER BY created_at DESC LIMIT 500`,
    ).all<Record<string, unknown>>();
    return c.json({ success: true, data: result.results ?? [] });
  } catch (err) {
    console.error('GET /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/auto-replies — 作成
autoReplies.post('/api/auto-replies', async (c) => {
  try {
    const body = (await c.req.json<{
      keyword?: unknown;
      matchType?: unknown;
      responseType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    }>().catch(() => ({}))) as {
      keyword?: unknown;
      matchType?: unknown;
      responseType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    };

    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    const responseContent =
      typeof body.responseContent === 'string' ? body.responseContent.trim() : '';
    const matchType: MatchType = isMatchType(body.matchType) ? body.matchType : 'contains';
    const responseType =
      typeof body.responseType === 'string' && body.responseType.length > 0
        ? body.responseType
        : 'text';
    const isActive = body.isActive === false ? 0 : 1;

    if (!keyword || keyword.length > KEYWORD_MAX) {
      return c.json(
        { success: false, error: `keyword is required (1-${KEYWORD_MAX} chars)` },
        400,
      );
    }
    if (!responseContent || responseContent.length > RESPONSE_MAX) {
      return c.json(
        { success: false, error: `responseContent is required (1-${RESPONSE_MAX} chars)` },
        400,
      );
    }

    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB.prepare(
      `INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, keyword, matchType, responseType, responseContent, isActive, now)
      .run();

    await auditAdmin(c, {
      action: 'auto_reply.create',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
      metadata: { keyword, matchType, isActive },
    });

    const created = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    console.error('POST /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/auto-replies/:id — 部分更新
autoReplies.patch('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as {
      keyword?: unknown;
      matchType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    };

    const keyword =
      typeof body.keyword === 'string' && body.keyword.trim().length > 0
        ? body.keyword.trim()
        : null;
    if (keyword && keyword.length > KEYWORD_MAX) {
      return c.json({ success: false, error: `keyword too long (max ${KEYWORD_MAX})` }, 400);
    }
    const responseContent =
      typeof body.responseContent === 'string' && body.responseContent.trim().length > 0
        ? body.responseContent.trim()
        : null;
    if (responseContent && responseContent.length > RESPONSE_MAX) {
      return c.json({ success: false, error: `responseContent too long (max ${RESPONSE_MAX})` }, 400);
    }
    const matchType = isMatchType(body.matchType) ? body.matchType : null;
    const isActive =
      body.isActive === undefined ? null : body.isActive === false ? 0 : 1;

    await c.env.DB.prepare(
      `UPDATE auto_replies SET
         keyword = COALESCE(?, keyword),
         match_type = COALESCE(?, match_type),
         response_content = COALESCE(?, response_content),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
    )
      .bind(keyword, matchType, responseContent, isActive, id)
      .run();

    await auditAdmin(c, {
      action: 'auto_reply.update',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
      metadata: { keyword, matchType, isActive },
    });

    const updated = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ success: true, data: updated });
  } catch (err) {
    console.error('PATCH /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/auto-replies/:id
autoReplies.delete('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(`SELECT id FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    await c.env.DB.prepare(`DELETE FROM auto_replies WHERE id = ?`).bind(id).run();
    await auditAdmin(c, {
      action: 'auto_reply.delete',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
    });
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
