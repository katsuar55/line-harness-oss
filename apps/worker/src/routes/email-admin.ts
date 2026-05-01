/**
 * Email channel (Round 4 PR-7) — 管理画面用 API
 *
 * エンドポイント:
 *   GET    /api/admin/email/kpi                 — 期間集計 (sent/delivered/opened/clicked/bounced/...)
 *   GET    /api/admin/email/subscribers         — 配信対象者一覧 (status filter)
 *   POST   /api/admin/email/subscribers         — 新規 / 上書き登録
 *   PATCH  /api/admin/email/subscribers/:id     — 配信停止 / 再開
 *   GET    /api/admin/email/templates           — テンプレ一覧
 *   PUT    /api/admin/email/templates           — テンプレ upsert
 *   DELETE /api/admin/email/templates/:id       — テンプレ削除
 *   GET    /api/admin/email/messages            — 配信ログ一覧 (LEFT JOIN email_subscribers)
 *
 * 認証は親 app の authMiddleware が `/api/*` 全体に効いている前提。
 */
import { Hono } from 'hono';
import {
  upsertEmailSubscriber,
  unsubscribeById,
  resubscribeById,
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
  type ConsentSource,
  type UpsertEmailTemplateInput,
} from '@line-crm/db';
import type { Env } from '../index.js';

const emailAdmin = new Hono<Env>();

// ============================================================
// 定数 / バリデーション
// ============================================================

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

const TEMPLATE_NAME_MAX = 100;
const TEMPLATE_SUBJECT_MAX = 200;
const TEMPLATE_HTML_MAX = 100_000;
const TEMPLATE_TEXT_MAX = 50_000;
const TEMPLATE_PREHEADER_MAX = 200;
const TEMPLATE_CATEGORY_MAX = 50;

const SUBSCRIBERS_DEFAULT_LIMIT = 200;
const SUBSCRIBERS_MAX_LIMIT = 500;
const MESSAGES_DEFAULT_LIMIT = 50;
const MESSAGES_MAX_LIMIT = 200;

type SubscriberStatus = 'active' | 'inactive' | 'transactional' | 'all';

const SUBSCRIBER_STATUSES: readonly SubscriberStatus[] = [
  'active',
  'inactive',
  'transactional',
  'all',
] as const;

// ============================================================
// helpers
// ============================================================

function isValidDate(s: string): boolean {
  return DATE_REGEX.test(s) && !Number.isNaN(Date.parse(s));
}

function isValidEmail(s: string): boolean {
  return s.length > 0 && s.length <= EMAIL_MAX_LENGTH && EMAIL_REGEX.test(s);
}

function clampLimit(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.round(n), max);
}

// ============================================================
// GET /api/admin/email/kpi
// ============================================================
emailAdmin.get('/api/admin/email/kpi', async (c) => {
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
           SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END)         AS sent,
           SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END)    AS delivered,
           SUM(CASE WHEN first_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
           SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END)             AS clicked,
           SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END)          AS bounced,
           SUM(CASE WHEN status = 'complained' THEN 1 ELSE 0 END)       AS complained
         FROM email_messages_log
         WHERE created_at >= ? AND created_at <= ?`,
      )
      .bind(fromIso, toIso)
      .first<{
        sent: number | null;
        delivered: number | null;
        opened: number | null;
        clicked: number | null;
        bounced: number | null;
        complained: number | null;
      }>();

    // unsubscribed 数 (期間内に解除した人)
    const unsubscribedRow = await db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM email_subscribers
         WHERE unsubscribed_at IS NOT NULL
           AND unsubscribed_at >= ? AND unsubscribed_at <= ?`,
      )
      .bind(fromIso, toIso)
      .first<{ n: number }>();

    // category 別 (transactional / marketing)
    const { results: byCategoryRows } = await db
      .prepare(
        `SELECT
           category,
           SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END)         AS sent,
           SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END)    AS delivered,
           SUM(CASE WHEN first_opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
           SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END)             AS clicked
         FROM email_messages_log
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY category
         ORDER BY category`,
      )
      .bind(fromIso, toIso)
      .all<{
        category: string;
        sent: number | null;
        delivered: number | null;
        opened: number | null;
        clicked: number | null;
      }>();

    // subscriber 全体スナップショット (期間に依存しない現状値)
    const subscribersRow = await db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN is_active = 1 AND transactional_only = 0 THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END)                            AS inactive,
           SUM(CASE WHEN transactional_only = 1 THEN 1 ELSE 0 END)                   AS transactional_only
         FROM email_subscribers`,
      )
      .first<{
        total: number | null;
        active: number | null;
        inactive: number | null;
        transactional_only: number | null;
      }>();

    const data = {
      totals: {
        sent: Number(totalsRow?.sent ?? 0),
        delivered: Number(totalsRow?.delivered ?? 0),
        opened: Number(totalsRow?.opened ?? 0),
        clicked: Number(totalsRow?.clicked ?? 0),
        bounced: Number(totalsRow?.bounced ?? 0),
        complained: Number(totalsRow?.complained ?? 0),
        unsubscribed: Number(unsubscribedRow?.n ?? 0),
        fromDate: from,
        toDate: to,
      },
      byCategory: (byCategoryRows ?? []).map((r) => ({
        category: r.category,
        sent: Number(r.sent ?? 0),
        delivered: Number(r.delivered ?? 0),
        opened: Number(r.opened ?? 0),
        clicked: Number(r.clicked ?? 0),
      })),
      subscribers: {
        total: Number(subscribersRow?.total ?? 0),
        active: Number(subscribersRow?.active ?? 0),
        inactive: Number(subscribersRow?.inactive ?? 0),
        transactionalOnly: Number(subscribersRow?.transactional_only ?? 0),
      },
    };

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/email/kpi error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/email/subscribers
// ============================================================
emailAdmin.get('/api/admin/email/subscribers', async (c) => {
  try {
    const status = (c.req.query('status') ?? 'all') as SubscriberStatus;
    if (!SUBSCRIBER_STATUSES.includes(status)) {
      return c.json(
        {
          success: false,
          error: `invalid status (allowed: ${SUBSCRIBER_STATUSES.join(',')})`,
        },
        400,
      );
    }
    const limit = clampLimit(
      c.req.query('limit'),
      SUBSCRIBERS_DEFAULT_LIMIT,
      SUBSCRIBERS_MAX_LIMIT,
    );

    const where: string[] = [];
    if (status === 'active') {
      where.push('is_active = 1', 'transactional_only = 0');
    } else if (status === 'inactive') {
      where.push('is_active = 0');
    } else if (status === 'transactional') {
      where.push('transactional_only = 1');
    }
    const sql = `SELECT * FROM email_subscribers ${
      where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY created_at DESC LIMIT ?`;

    const result = await c.env.DB.prepare(sql).bind(limit).all();
    return c.json({ success: true, data: { subscribers: result.results ?? [] } });
  } catch (err) {
    console.error('GET /api/admin/email/subscribers error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// POST /api/admin/email/subscribers
// ============================================================
emailAdmin.post('/api/admin/email/subscribers', async (c) => {
  try {
    const body = await c.req.json<{
      email?: string;
      friendId?: string | null;
      marketingOptIn?: boolean;
      consentSource?: ConsentSource;
    }>();

    if (!body.email || !isValidEmail(body.email)) {
      return c.json({ success: false, error: 'invalid email' }, 400);
    }
    if (typeof body.marketingOptIn !== 'boolean') {
      return c.json(
        { success: false, error: 'marketingOptIn (boolean) required' },
        400,
      );
    }

    const subscriber = await upsertEmailSubscriber(c.env.DB, {
      email: body.email,
      friendId: body.friendId ?? null,
      marketingOptIn: body.marketingOptIn,
      consentSource: body.consentSource,
    });

    return c.json({ success: true, data: { subscriber } });
  } catch (err) {
    console.error('POST /api/admin/email/subscribers error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// PATCH /api/admin/email/subscribers/:id
// ============================================================
emailAdmin.patch('/api/admin/email/subscribers/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ success: false, error: 'id required' }, 400);
    }

    const body = await c.req.json<{ isActive?: boolean }>();
    if (typeof body.isActive !== 'boolean') {
      return c.json(
        { success: false, error: 'isActive (boolean) required' },
        400,
      );
    }

    const ok = body.isActive
      ? await resubscribeById(c.env.DB, id)
      : await unsubscribeById(c.env.DB, id);

    if (!ok) {
      return c.json(
        { success: false, error: 'subscriber not found or no change' },
        404,
      );
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/admin/email/subscribers/:id error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/email/templates
// ============================================================
emailAdmin.get('/api/admin/email/templates', async (c) => {
  try {
    const activeOnlyRaw = c.req.query('activeOnly');
    const activeOnly = activeOnlyRaw === 'true' || activeOnlyRaw === '1';
    const category = c.req.query('category') || undefined;

    const templates = await listEmailTemplates(c.env.DB, { category, activeOnly });
    return c.json({ success: true, data: { templates } });
  } catch (err) {
    console.error('GET /api/admin/email/templates error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// PUT /api/admin/email/templates
// ============================================================
emailAdmin.put('/api/admin/email/templates', async (c) => {
  try {
    const body = await c.req.json<Partial<UpsertEmailTemplateInput>>();

    if (!body.name || body.name.length < 1 || body.name.length > TEMPLATE_NAME_MAX) {
      return c.json(
        { success: false, error: `name required (1-${TEMPLATE_NAME_MAX})` },
        400,
      );
    }
    if (
      !body.subject ||
      body.subject.length < 1 ||
      body.subject.length > TEMPLATE_SUBJECT_MAX
    ) {
      return c.json(
        { success: false, error: `subject required (1-${TEMPLATE_SUBJECT_MAX})` },
        400,
      );
    }
    if (
      !body.htmlContent ||
      body.htmlContent.length < 1 ||
      body.htmlContent.length > TEMPLATE_HTML_MAX
    ) {
      return c.json(
        { success: false, error: `htmlContent required (1-${TEMPLATE_HTML_MAX})` },
        400,
      );
    }
    if (
      !body.textContent ||
      body.textContent.length < 1 ||
      body.textContent.length > TEMPLATE_TEXT_MAX
    ) {
      return c.json(
        { success: false, error: `textContent required (1-${TEMPLATE_TEXT_MAX})` },
        400,
      );
    }
    if (body.preheader && body.preheader.length > TEMPLATE_PREHEADER_MAX) {
      return c.json(
        { success: false, error: `preheader too long (max ${TEMPLATE_PREHEADER_MAX})` },
        400,
      );
    }
    if (body.category && body.category.length > TEMPLATE_CATEGORY_MAX) {
      return c.json(
        { success: false, error: `category too long (max ${TEMPLATE_CATEGORY_MAX})` },
        400,
      );
    }

    const template = await upsertEmailTemplate(c.env.DB, {
      id: body.id,
      name: body.name,
      category: body.category,
      subject: body.subject,
      htmlContent: body.htmlContent,
      textContent: body.textContent,
      preheader: body.preheader,
      isActive: body.isActive,
    });

    return c.json({ success: true, data: { template } });
  } catch (err) {
    console.error('PUT /api/admin/email/templates error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// DELETE /api/admin/email/templates/:id
// ============================================================
emailAdmin.delete('/api/admin/email/templates/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!id) {
      return c.json({ success: false, error: 'id required' }, 400);
    }
    await deleteEmailTemplate(c.env.DB, id);
    // 0 行削除でも 200 (idempotent)
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/email/templates/:id error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/email/messages
// ============================================================
emailAdmin.get('/api/admin/email/messages', async (c) => {
  try {
    const limit = clampLimit(
      c.req.query('limit'),
      MESSAGES_DEFAULT_LIMIT,
      MESSAGES_MAX_LIMIT,
    );
    const status = c.req.query('status') || undefined;
    const from = c.req.query('from');
    const to = c.req.query('to');

    if (from && !isValidDate(from)) {
      return c.json({ success: false, error: 'invalid from format' }, 400);
    }
    if (to && !isValidDate(to)) {
      return c.json({ success: false, error: 'invalid to format' }, 400);
    }

    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (status) {
      where.push('l.status = ?');
      params.push(status);
    }
    if (from) {
      where.push('l.created_at >= ?');
      params.push(`${from}T00:00:00Z`);
    }
    if (to) {
      where.push('l.created_at <= ?');
      params.push(`${to}T23:59:59Z`);
    }

    const sql = `SELECT l.id, l.subscriber_id, s.email, l.subject, l.category,
                        l.source_kind, l.status, l.open_count, l.click_count,
                        l.sent_at, l.delivered_at, l.first_opened_at,
                        l.last_event_at, l.created_at
                 FROM email_messages_log l
                 LEFT JOIN email_subscribers s ON s.id = l.subscriber_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY l.created_at DESC
                 LIMIT ?`;
    params.push(limit);

    const result = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        id: string;
        subscriber_id: string;
        email: string | null;
        subject: string;
        category: string;
        source_kind: string;
        status: string;
        open_count: number;
        click_count: number;
        sent_at: string | null;
        delivered_at: string | null;
        first_opened_at: string | null;
        last_event_at: string | null;
        created_at: string;
      }>();

    const messages = (result.results ?? []).map((r) => ({
      id: r.id,
      subscriberId: r.subscriber_id,
      email: r.email,
      subject: r.subject,
      category: r.category,
      sourceKind: r.source_kind,
      status: r.status,
      openCount: Number(r.open_count ?? 0),
      clickCount: Number(r.click_count ?? 0),
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      firstOpenedAt: r.first_opened_at,
      lastEventAt: r.last_event_at,
      createdAt: r.created_at,
    }));

    return c.json({ success: true, data: { messages } });
  } catch (err) {
    console.error('GET /api/admin/email/messages error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { emailAdmin };
