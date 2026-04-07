import { Hono } from 'hono';
import {
  getAmbassadors,
  getAmbassadorStats,
  updateAmbassador,
} from '@line-crm/db';
import type { Env } from '../index.js';

const ambassadors = new Hono<Env>();

/**
 * GET /api/ambassadors — 一覧取得（ページネーション・フィルター付き）
 */
ambassadors.get('/api/ambassadors', async (c) => {
  try {
    const status = c.req.query('status') || undefined;
    const tier = c.req.query('tier') || undefined;
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 20), 100);
    const offset = Math.max(0, Number(c.req.query('offset')) || 0);

    const result = await getAmbassadors(c.env.DB, { status, tier, limit, offset });

    return c.json({
      success: true,
      data: {
        ambassadors: result.ambassadors.map((a) => ({
          ...a,
          preferences: typeof a.preferences === 'string' ? JSON.parse(a.preferences) : a.preferences,
        })),
        total: result.total,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/ambassadors error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/ambassadors/stats — 統計サマリー
 */
ambassadors.get('/api/ambassadors/stats', async (c) => {
  try {
    const stats = await getAmbassadorStats(c.env.DB);
    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /api/ambassadors/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/ambassadors/:id — ステータス・ティア変更
 */
ambassadors.put('/api/ambassadors/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      status?: string;
      tier?: string;
      note?: string;
    }>();

    // Validate status
    const validStatuses = ['active', 'inactive', 'suspended'];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
    }

    // Validate tier
    const validTiers = ['bronze', 'silver', 'gold', 'platinum'];
    if (body.tier && !validTiers.includes(body.tier)) {
      return c.json({ success: false, error: `tier must be one of: ${validTiers.join(', ')}` }, 400);
    }

    // Validate note length
    if (body.note && body.note.length > 500) {
      return c.json({ success: false, error: 'note must be 500 characters or less' }, 400);
    }

    // Check existence
    const existing = await c.env.DB
      .prepare('SELECT id FROM ambassadors WHERE id = ?')
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      return c.json({ success: false, error: 'Ambassador not found' }, 404);
    }

    await updateAmbassador(c.env.DB, id, {
      status: body.status,
      tier: body.tier,
      note: body.note,
    });

    return c.json({ success: true, data: { id } });
  } catch (err) {
    console.error('PUT /api/ambassadors/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { ambassadors };
