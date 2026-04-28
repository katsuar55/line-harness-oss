/**
 * 再購入リマインダー (Phase 6) — 管理画面用 API
 *
 * エンドポイント:
 *   GET    /api/admin/reorder/summary            — 期間内の登録数 / 配信数 / interval_source 別 breakdown
 *   GET    /api/admin/reorder/reminders          — 直近の subscription_reminders 一覧 (friend 名 LEFT JOIN)
 *   GET    /api/admin/reorder/cross-sell         — purchase_cross_sell_map 一覧
 *   PUT    /api/admin/reorder/cross-sell         — クロスセルルール upsert
 *   DELETE /api/admin/reorder/cross-sell         — ルール削除 (source + recommended の組合せで)
 *   GET    /api/admin/reorder/product-intervals  — product_repurchase_intervals 一覧
 *   PUT    /api/admin/reorder/product-intervals  — 商品間隔 upsert
 *   DELETE /api/admin/reorder/product-intervals/:id — 商品間隔削除
 *
 * 認証は親 app の authMiddleware が `/api/*` 全体に効いている前提。
 */
import { Hono } from 'hono';
import {
  upsertCrossSellRule,
  listCrossSellRules,
  deleteCrossSellRule,
  upsertProductInterval,
  listProductIntervals,
  deleteProductInterval,
  type IntervalSource,
} from '@line-crm/db';
import type { Env } from '../index.js';

const reorderAdmin = new Hono<Env>();

// ============================================================
// 定数 / バリデーション
// ============================================================

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const VALID_INTERVAL_SOURCES: IntervalSource[] = [
  'manual',
  'product_default',
  'user_history',
  'seed',
  'auto_estimated',
  'fallback',
];

const PRODUCT_TITLE_MAX = 200;
const REASON_MAX = 200;
const NOTES_MAX = 500;
const MIN_INTERVAL = 7;
const MAX_INTERVAL = 90;

interface SourceBreakdownRow {
  source: string;
  count: number;
  active: number;
}

interface SummaryResponse {
  totals: {
    enrolled: number;
    active: number;
    pushed: number;
    pushedRecent: number;
    fromDate: string;
    toDate: string;
  };
  bySource: SourceBreakdownRow[];
  recent: Array<{
    id: string;
    friendId: string;
    friendName: string | null;
    productTitle: string;
    intervalDays: number;
    intervalSource: string | null;
    nextReminderAt: string;
    lastSentAt: string | null;
    isActive: boolean;
    createdAt: string;
  }>;
}

// ============================================================
// helpers
// ============================================================

function isValidDate(s: string): boolean {
  return DATE_REGEX.test(s) && !Number.isNaN(Date.parse(s));
}

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return 30;
  const r = Math.round(n);
  if (r < MIN_INTERVAL) return MIN_INTERVAL;
  if (r > MAX_INTERVAL) return MAX_INTERVAL;
  return r;
}

// ============================================================
// GET /api/admin/reorder/summary
// ============================================================
reorderAdmin.get('/api/admin/reorder/summary', async (c) => {
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');

    if (!from || !to) {
      return c.json(
        { success: false, error: 'from / to are required (YYYY-MM-DD)' },
        400,
      );
    }
    if (!isValidDate(from) || !isValidDate(to)) {
      return c.json({ success: false, error: 'invalid date format' }, 400);
    }
    if (from > to) {
      return c.json({ success: false, error: 'from must be <= to' }, 400);
    }

    const fromIso = `${from}T00:00:00Z`;
    const toIso = `${to}T23:59:59Z`;
    const db = c.env.DB;

    // 全体集計
    const totalsRow = await db
      .prepare(
        `SELECT
           COUNT(*) AS enrolled,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN last_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS pushed
         FROM subscription_reminders
         WHERE created_at >= ? AND created_at <= ?`,
      )
      .bind(fromIso, toIso)
      .first<{ enrolled: number; active: number; pushed: number }>();

    const pushedRecentRow = await db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM subscription_reminders
         WHERE last_sent_at IS NOT NULL
           AND last_sent_at >= ? AND last_sent_at <= ?`,
      )
      .bind(fromIso, toIso)
      .first<{ n: number }>();

    // interval_source 別の breakdown (期間内 enrolled)
    const { results: bySourceRows } = await db
      .prepare(
        `SELECT
           COALESCE(interval_source, 'manual') AS source,
           COUNT(*) AS count,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active
         FROM subscription_reminders
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY COALESCE(interval_source, 'manual')
         ORDER BY count DESC`,
      )
      .bind(fromIso, toIso)
      .all<{ source: string; count: number; active: number }>();

    // 直近の reminder 20 件 (friend 名 LEFT JOIN)
    const { results: recentRows } = await db
      .prepare(
        `SELECT sr.id, sr.friend_id, sr.product_title, sr.interval_days,
                sr.interval_source, sr.next_reminder_at, sr.last_sent_at,
                sr.is_active, sr.created_at, f.display_name
         FROM subscription_reminders sr
         LEFT JOIN friends f ON f.id = sr.friend_id
         WHERE sr.created_at >= ? AND sr.created_at <= ?
         ORDER BY sr.created_at DESC
         LIMIT 20`,
      )
      .bind(fromIso, toIso)
      .all<{
        id: string;
        friend_id: string;
        product_title: string;
        interval_days: number;
        interval_source: string | null;
        next_reminder_at: string;
        last_sent_at: string | null;
        is_active: number;
        created_at: string;
        display_name: string | null;
      }>();

    const data: SummaryResponse = {
      totals: {
        enrolled: Number(totalsRow?.enrolled ?? 0),
        active: Number(totalsRow?.active ?? 0),
        pushed: Number(totalsRow?.pushed ?? 0),
        pushedRecent: Number(pushedRecentRow?.n ?? 0),
        fromDate: from,
        toDate: to,
      },
      bySource: (bySourceRows ?? []).map((r) => ({
        source: r.source,
        count: Number(r.count),
        active: Number(r.active),
      })),
      recent: (recentRows ?? []).map((r) => ({
        id: r.id,
        friendId: r.friend_id,
        friendName: r.display_name,
        productTitle: r.product_title,
        intervalDays: Number(r.interval_days),
        intervalSource: r.interval_source,
        nextReminderAt: r.next_reminder_at,
        lastSentAt: r.last_sent_at,
        isActive: Number(r.is_active) === 1,
        createdAt: r.created_at,
      })),
    };

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/reorder/summary error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/reorder/cross-sell
// ============================================================
reorderAdmin.get('/api/admin/reorder/cross-sell', async (c) => {
  try {
    const sourceProductId = c.req.query('sourceProductId') || undefined;
    const limit = Math.min(Number(c.req.query('limit') ?? '200') || 200, 500);
    const rows = await listCrossSellRules(c.env.DB, { sourceProductId, limit });
    return c.json({ success: true, data: { rules: rows } });
  } catch (err) {
    console.error('GET /api/admin/reorder/cross-sell error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// PUT /api/admin/reorder/cross-sell
// ============================================================
reorderAdmin.put('/api/admin/reorder/cross-sell', async (c) => {
  try {
    const body = await c.req.json<{
      sourceProductId?: string;
      recommendedProductId?: string;
      reason?: string;
      priority?: number;
      isActive?: boolean;
    }>();

    if (!body.sourceProductId || !body.recommendedProductId) {
      return c.json(
        { success: false, error: 'sourceProductId / recommendedProductId required' },
        400,
      );
    }
    if (body.sourceProductId === body.recommendedProductId) {
      return c.json({ success: false, error: 'source and recommended must differ' }, 400);
    }
    if (body.reason && body.reason.length > REASON_MAX) {
      return c.json({ success: false, error: `reason too long (max ${REASON_MAX})` }, 400);
    }
    const priority =
      typeof body.priority === 'number' && Number.isFinite(body.priority)
        ? Math.max(0, Math.min(1000, Math.round(body.priority)))
        : 0;

    await upsertCrossSellRule(c.env.DB, {
      sourceProductId: body.sourceProductId,
      recommendedProductId: body.recommendedProductId,
      reason: body.reason ?? null,
      priority,
      isActive: body.isActive !== false,
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('PUT /api/admin/reorder/cross-sell error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// DELETE /api/admin/reorder/cross-sell
// ============================================================
reorderAdmin.delete('/api/admin/reorder/cross-sell', async (c) => {
  try {
    const sourceProductId = c.req.query('sourceProductId');
    const recommendedProductId = c.req.query('recommendedProductId');
    if (!sourceProductId || !recommendedProductId) {
      return c.json(
        { success: false, error: 'sourceProductId / recommendedProductId required' },
        400,
      );
    }
    await deleteCrossSellRule(c.env.DB, sourceProductId, recommendedProductId);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/reorder/cross-sell error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/reorder/product-intervals
// ============================================================
reorderAdmin.get('/api/admin/reorder/product-intervals', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') ?? '200') || 200, 500);
    const rows = await listProductIntervals(c.env.DB, { limit });
    return c.json({ success: true, data: { intervals: rows } });
  } catch (err) {
    console.error('GET /api/admin/reorder/product-intervals error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// PUT /api/admin/reorder/product-intervals
// ============================================================
reorderAdmin.put('/api/admin/reorder/product-intervals', async (c) => {
  try {
    const body = await c.req.json<{
      shopifyProductId?: string;
      productTitle?: string;
      defaultIntervalDays?: number;
      source?: string;
      sampleSize?: number;
      notes?: string;
    }>();

    if (!body.shopifyProductId) {
      return c.json({ success: false, error: 'shopifyProductId required' }, 400);
    }
    if (
      typeof body.defaultIntervalDays !== 'number' ||
      !Number.isFinite(body.defaultIntervalDays)
    ) {
      return c.json(
        { success: false, error: 'defaultIntervalDays (number) required' },
        400,
      );
    }
    if (body.productTitle && body.productTitle.length > PRODUCT_TITLE_MAX) {
      return c.json(
        { success: false, error: `productTitle too long (max ${PRODUCT_TITLE_MAX})` },
        400,
      );
    }
    if (body.notes && body.notes.length > NOTES_MAX) {
      return c.json({ success: false, error: `notes too long (max ${NOTES_MAX})` }, 400);
    }
    if (body.source && !VALID_INTERVAL_SOURCES.includes(body.source as IntervalSource)) {
      return c.json(
        { success: false, error: `invalid source (allowed: ${VALID_INTERVAL_SOURCES.join(',')})` },
        400,
      );
    }
    const sampleSize =
      typeof body.sampleSize === 'number' && Number.isFinite(body.sampleSize)
        ? Math.max(0, Math.min(1_000_000, Math.round(body.sampleSize)))
        : 0;

    await upsertProductInterval(c.env.DB, {
      shopifyProductId: body.shopifyProductId,
      productTitle: body.productTitle ?? null,
      defaultIntervalDays: clampInterval(body.defaultIntervalDays),
      source: (body.source as IntervalSource) ?? 'manual',
      sampleSize,
      notes: body.notes ?? null,
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('PUT /api/admin/reorder/product-intervals error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// DELETE /api/admin/reorder/product-intervals/:id
// ============================================================
reorderAdmin.delete('/api/admin/reorder/product-intervals/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) return c.json({ success: false, error: 'id required' }, 400);
    await deleteProductInterval(c.env.DB, id);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/reorder/product-intervals/:id error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { reorderAdmin };
