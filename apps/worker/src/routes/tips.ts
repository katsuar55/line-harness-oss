import { Hono } from 'hono';
import {
  getDailyTips,
  getTodayTip,
  createDailyTip,
  updateDailyTip,
  deleteDailyTip,
} from '@line-crm/db';
import type { Env } from '../index.js';

const tips = new Hono<Env>();

// ─── Validation helpers ───
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 50;

function validateTipInput(data: Record<string, unknown>): { error?: string } {
  if (typeof data.title === 'string' && data.title.length > MAX_TITLE_LENGTH) {
    return { error: `title must be ${MAX_TITLE_LENGTH} characters or less` };
  }
  if (typeof data.content === 'string' && data.content.length > MAX_CONTENT_LENGTH) {
    return { error: `content must be ${MAX_CONTENT_LENGTH} characters or less` };
  }
  if (typeof data.category === 'string' && data.category.length > MAX_CATEGORY_LENGTH) {
    return { error: `category must be ${MAX_CATEGORY_LENGTH} characters or less` };
  }
  return {};
}

/**
 * GET /api/tips — 一覧取得（ページネーション付き）
 */
tips.get('/api/tips', async (c) => {
  try {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 30), 100);
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const result = await getDailyTips(c.env.DB, { limit, offset });

    return c.json({
      success: true,
      data: {
        tips: result.tips,
        total: result.total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/tips error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/tips/:id — 単一取得
 */
tips.get('/api/tips/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB
      .prepare('SELECT * FROM daily_tips WHERE id = ?')
      .bind(id)
      .first();

    if (!row) {
      return c.json({ success: false, error: 'Tip not found' }, 404);
    }

    return c.json({ success: true, data: row });
  } catch (err) {
    console.error('GET /api/tips/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/tips — 新規作成
 */
tips.post('/api/tips', async (c) => {
  try {
    const body = await c.req.json<{
      tipDate: string;
      category: string;
      title: string;
      content: string;
      imageUrl?: string;
      source?: string;
    }>();

    if (!body.tipDate || !DATE_RE.test(body.tipDate)) {
      return c.json({ success: false, error: 'tipDate is required (YYYY-MM-DD)' }, 400);
    }
    if (!body.category || typeof body.category !== 'string') {
      return c.json({ success: false, error: 'category is required' }, 400);
    }
    if (!body.title || typeof body.title !== 'string') {
      return c.json({ success: false, error: 'title is required' }, 400);
    }
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ success: false, error: 'content is required' }, 400);
    }

    const validation = validateTipInput(body);
    if (validation.error) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    const result = await createDailyTip(c.env.DB, {
      tipDate: body.tipDate,
      category: body.category,
      title: body.title,
      content: body.content,
      imageUrl: body.imageUrl,
      source: body.source,
    });

    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    console.error('POST /api/tips error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/tips/:id — 更新
 */
tips.put('/api/tips/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      category?: string;
      title?: string;
      content?: string;
      imageUrl?: string;
    }>();

    const validation = validateTipInput(body);
    if (validation.error) {
      return c.json({ success: false, error: validation.error }, 400);
    }

    // Check existence
    const existing = await c.env.DB
      .prepare('SELECT id FROM daily_tips WHERE id = ?')
      .bind(id)
      .first();
    if (!existing) {
      return c.json({ success: false, error: 'Tip not found' }, 404);
    }

    await updateDailyTip(c.env.DB, id, {
      category: body.category,
      title: body.title,
      content: body.content,
      imageUrl: body.imageUrl,
    });

    return c.json({ success: true, data: { id } });
  } catch (err) {
    console.error('PUT /api/tips/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /api/tips/:id — 削除
 */
tips.delete('/api/tips/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const existing = await c.env.DB
      .prepare('SELECT id FROM daily_tips WHERE id = ?')
      .bind(id)
      .first();
    if (!existing) {
      return c.json({ success: false, error: 'Tip not found' }, 404);
    }

    await deleteDailyTip(c.env.DB, id);

    return c.json({ success: true, data: { deleted: id } });
  } catch (err) {
    console.error('DELETE /api/tips/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/tips/today — 今日のTip（認証不要 — LIFFポータルからも利用）
 */
tips.get('/api/tips/today', async (c) => {
  try {
    const tip = await getTodayTip(c.env.DB);
    return c.json({ success: true, data: tip });
  } catch (err) {
    console.error('GET /api/tips/today error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { tips };
