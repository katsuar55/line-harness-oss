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
import { signEmailOptInToken } from '../services/email-opt-in.js';
import {
  sendBulkOptInInvitations,
  type BulkInvitationRecipient,
} from '../services/bulk-opt-in-invitation.js';
import { buildEmailDispatchConfig } from '../services/email-dispatch-config.js';
import { requireRole } from '../middleware/role-guard.js';
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

/** email_messages_log.status の許容値 (DB schema の status enum と一致させる) */
const MESSAGE_LOG_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'complained',
  'failed',
] as const;
type MessageLogStatus = (typeof MESSAGE_LOG_STATUSES)[number];

function isValidMessageLogStatus(s: string | undefined): s is MessageLogStatus {
  return typeof s === 'string' && (MESSAGE_LOG_STATUSES as readonly string[]).includes(s);
}

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

    if (status !== undefined && !isValidMessageLogStatus(status)) {
      return c.json(
        {
          success: false,
          error: `invalid status (allowed: ${MESSAGE_LOG_STATUSES.join(', ')})`,
        },
        400,
      );
    }
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

// ============================================================
// Phase 5β-1: opt-in URL 生成 (Shopify 顧客 1,891 名 への一斉送信下準備)
//
// POST /api/admin/email/opt-in/generate-url
//   body: { email: string, ttlSeconds?: number }
//   resp: { url, expiresAt }
//
// 用途:
//   - bulk send 用に email を行送りでURL 生成
//   - 1 件テスト送信用にコピペで URL 取得
//
// セキュリティ:
//   - admin 認証 (親 app の authMiddleware) を経由
//   - EMAIL_OPTIN_HMAC_KEY 必須、 未設定なら 503
// ============================================================
emailAdmin.post('/api/admin/email/opt-in/generate-url', async (c) => {
  const hmacKey = c.env.EMAIL_OPTIN_HMAC_KEY;
  if (!hmacKey) {
    return c.json({ success: false, error: 'EMAIL_OPTIN_HMAC_KEY not configured' }, 503);
  }
  const workerUrl = c.env.WORKER_URL;
  if (!workerUrl) {
    return c.json({ success: false, error: 'WORKER_URL not configured' }, 503);
  }

  let body: { email?: unknown; ttlSeconds?: unknown };
  try {
    body = await c.req.json<{ email?: unknown; ttlSeconds?: unknown }>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!isValidEmail(email)) {
    return c.json({ success: false, error: 'Invalid email format' }, 400);
  }

  let ttlSeconds: number | undefined;
  if (body.ttlSeconds !== undefined) {
    const n = Number(body.ttlSeconds);
    if (!Number.isFinite(n) || n <= 0 || n > 60 * 60 * 24 * 30) {
      // 上限 30 日 (token は stateless / 取り消し不可、 寿命が長いほど security risk)
      return c.json({ success: false, error: 'ttlSeconds must be 1..2592000 (30 days)' }, 400);
    }
    ttlSeconds = Math.floor(n);
  }

  try {
    const signed = await signEmailOptInToken(hmacKey, email, { ttlSeconds });
    const base = workerUrl.replace(/\/$/, '');
    const url = `${base}/email/opt-in?email=${encodeURIComponent(signed.email)}&e=${signed.expiresAt}&token=${signed.token}`;
    return c.json({
      success: true,
      data: {
        url,
        email: signed.email,
        expiresAt: signed.expiresAt,
      },
    });
  } catch (err) {
    console.error('POST /api/admin/email/opt-in/generate-url error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// Phase 5β-1d-1: opt-in 招待 campaign 用 endpoints
//
// 1. GET  /api/admin/email/opt-in/candidates       — 送信候補 (Shopify customer に email あり、
//                                                     marketing opt-in 未取得) を一覧
// 2. POST /api/admin/email/opt-in/send-invitations — 指定 email list に opt-in 招待 transactional email 送信
//
// 想定運用 (Katsu):
//   1. GET candidates で送信候補リスト取得 (limit/offset でページング)
//   2. POST send-invitations に email 配列を渡す (dryRun=true で preview 推奨)
//   3. 結果を見て problem なければ dryRun=false で実送信
//   4. Resend 無料 plan の 100/day 制限を考慮、 limit 50-100 ずつ複数日に分けて送信
// ============================================================

emailAdmin.get('/api/admin/email/opt-in/candidates', async (c) => {
  const limit = clampLimit(c.req.query('limit'), 50, 500);
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const offset =
    Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(Math.round(offsetRaw), 100000) : 0;

  // shopify_customers の email + first_name + last_name を返す
  // 除外条件: email NULL / email_subscribers で既に is_active=1 AND transactional_only=0 (= 既に marketing 同意済)
  // 残: not_subscribed (Shopify 側) / unsubscribed / transactional_only=1 / 未登録
  try {
    const result = await c.env.DB.prepare(
      `SELECT sc.email, sc.first_name, sc.last_name, sc.shopify_customer_id
         FROM shopify_customers sc
         LEFT JOIN email_subscribers es ON LOWER(es.email) = LOWER(sc.email)
        WHERE sc.email IS NOT NULL AND sc.email != ''
          AND (es.id IS NULL OR es.is_active = 0 OR es.transactional_only = 1)
        ORDER BY sc.created_at DESC
        LIMIT ? OFFSET ?`,
    )
      .bind(limit, offset)
      .all<{
        email: string;
        first_name: string | null;
        last_name: string | null;
        shopify_customer_id: string;
      }>();
    const rows = (result.results ?? []).map((r) => ({
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      shopifyCustomerId: r.shopify_customer_id,
    }));
    return c.json({
      success: true,
      data: {
        candidates: rows,
        count: rows.length,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('GET /api/admin/email/opt-in/candidates error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// POST /api/admin/email/opt-in/send-invitations
//
// body:
//   {
//     recipients: [{ email, firstName? }, ...],  // 必須 (max 200 件)
//     templateId?: string,                        // default 'tpl-opt-in-invitation-v1'
//     dryRun?: boolean                            // default false
//   }
//
// resp:
//   {
//     success: true,
//     data: { total, sent, skipped, failed, dryRun, details: [{ email, status, reason?, providerMessageId? }] }
//   }
// ============================================================

const MAX_BATCH_SIZE = 200;

emailAdmin.post('/api/admin/email/opt-in/send-invitations', requireRole('owner', 'admin'), async (c) => {
  const hmacKey = c.env.EMAIL_OPTIN_HMAC_KEY;
  if (!hmacKey) {
    return c.json({ success: false, error: 'EMAIL_OPTIN_HMAC_KEY not configured' }, 503);
  }
  const workerUrl = c.env.WORKER_URL;
  if (!workerUrl) {
    return c.json({ success: false, error: 'WORKER_URL not configured' }, 503);
  }

  let body: { recipients?: unknown; templateId?: unknown; dryRun?: unknown };
  try {
    body = await c.req.json<{ recipients?: unknown; templateId?: unknown; dryRun?: unknown }>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return c.json({ success: false, error: 'recipients must be non-empty array' }, 400);
  }
  if (body.recipients.length > MAX_BATCH_SIZE) {
    return c.json(
      { success: false, error: `recipients exceeds max batch size ${MAX_BATCH_SIZE}` },
      400,
    );
  }

  // recipients validate + normalize
  const recipients: BulkInvitationRecipient[] = [];
  for (const r of body.recipients) {
    if (typeof r !== 'object' || r === null) {
      return c.json({ success: false, error: 'each recipient must be { email, firstName? }' }, 400);
    }
    const rec = r as { email?: unknown; firstName?: unknown };
    if (typeof rec.email !== 'string') {
      return c.json({ success: false, error: 'each recipient.email must be string' }, 400);
    }
    recipients.push({
      email: rec.email,
      firstName: typeof rec.firstName === 'string' ? rec.firstName : null,
    });
  }

  const templateId = typeof body.templateId === 'string' ? body.templateId : undefined;
  const dryRun = body.dryRun === true;

  // email config を構築 (dryRun でも build しておく — 送信時に変更しないため)
  const emailConfig = buildEmailDispatchConfig(c.env);
  if (!emailConfig) {
    return c.json(
      { success: false, error: 'email config not available (missing RESEND_API_KEY / EMAIL_FROM etc.)' },
      503,
    );
  }

  try {
    const result = await sendBulkOptInInvitations(
      c.env.DB,
      {
        emailConfig,
        optInUrlConfig: { hmacKey, workerUrl },
      },
      {
        recipients,
        templateId,
        dryRun,
      },
    );
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/admin/email/opt-in/send-invitations error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// Phase 5β-1d-3: opt-in campaign KPI dashboard
//
// GET /api/admin/email/opt-in/kpi?days=30
//   - days: 1..365 (default 30)
//
// resp:
//   {
//     success: true,
//     data: {
//       window: { days, fromDate, toDate },
//       totals: { all, new, reConsent, reactivated, web, liff, other },
//       trend: [{ date: 'YYYY-MM-DD', count }, ...],   // daily counts, 0-padded for full window
//       candidatesRemaining: number                     // shopify_customers without active opt-in
//     }
//   }
//
// 集計ロジック (audit_logs.action='email.opt_in' を ground truth とする):
//   - metadata.outcome ∈ {'new', 're_consent', 'reactivated'} で分類
//   - metadata.channel ∈ {'web', 'liff'} で分類
//   - 不明 outcome / channel は other / 集計に含めない
//   - candidatesRemaining は send-invitations 用残数 (既存 candidates query と同じ JOIN)
// ============================================================

const KPI_DAYS_DEFAULT = 30;
const KPI_DAYS_MIN = 1;
const KPI_DAYS_MAX = 365;

interface OptInKpiTotalsRow {
  all_count: number | null;
  new_count: number | null;
  re_consent_count: number | null;
  reactivated_count: number | null;
  web_count: number | null;
  liff_count: number | null;
}

interface OptInKpiTrendRow {
  date: string;
  count: number;
}

function buildZeroPaddedTrend(
  fromDateMs: number,
  days: number,
  rows: ReadonlyArray<OptInKpiTrendRow>,
): Array<{ date: string; count: number }> {
  const byDate = new Map<string, number>();
  for (const r of rows) {
    if (r.date) byDate.set(r.date, Number(r.count) || 0);
  }
  const out: Array<{ date: string; count: number }> = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(fromDateMs + i * 86400000);
    const date = dt.toISOString().slice(0, 10);
    out.push({ date, count: byDate.get(date) ?? 0 });
  }
  return out;
}

emailAdmin.get('/api/admin/email/opt-in/kpi', async (c) => {
  const daysRaw = c.req.query('days');
  const daysNum = daysRaw !== undefined ? Number(daysRaw) : KPI_DAYS_DEFAULT;
  if (!Number.isFinite(daysNum) || daysNum < KPI_DAYS_MIN || daysNum > KPI_DAYS_MAX) {
    return c.json(
      { success: false, error: `days must be ${KPI_DAYS_MIN}..${KPI_DAYS_MAX}` },
      400,
    );
  }
  const days = Math.floor(daysNum);

  // single source of truth: fromDateOnly から fromMs と fromQueryBoundary を derive
  // (SQL の SUBSTR(created_at,1,10) と buildZeroPaddedTrend の date iteration を確実に一致させる)
  const nowMs = Date.now();
  const fromDateOnly = new Date(nowMs - (days - 1) * 86400000).toISOString().slice(0, 10);
  const fromQueryBoundary = `${fromDateOnly}T00:00:00.000Z`;
  const fromMs = Date.parse(fromQueryBoundary);
  const toDateOnly = new Date(nowMs).toISOString().slice(0, 10);

  try {
    const totalsRow = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS all_count,
         SUM(CASE WHEN JSON_EXTRACT(metadata, '$.outcome') = 'new' THEN 1 ELSE 0 END) AS new_count,
         SUM(CASE WHEN JSON_EXTRACT(metadata, '$.outcome') = 're_consent' THEN 1 ELSE 0 END) AS re_consent_count,
         SUM(CASE WHEN JSON_EXTRACT(metadata, '$.outcome') = 'reactivated' THEN 1 ELSE 0 END) AS reactivated_count,
         SUM(CASE WHEN JSON_EXTRACT(metadata, '$.channel') = 'web' THEN 1 ELSE 0 END) AS web_count,
         SUM(CASE WHEN JSON_EXTRACT(metadata, '$.channel') = 'liff' THEN 1 ELSE 0 END) AS liff_count
       FROM audit_logs
       WHERE action = 'email.opt_in'
         AND created_at >= ?`,
    )
      .bind(fromQueryBoundary)
      .first<OptInKpiTotalsRow>();

    const trendResult = await c.env.DB.prepare(
      `SELECT SUBSTR(created_at, 1, 10) AS date, COUNT(*) AS count
         FROM audit_logs
        WHERE action = 'email.opt_in'
          AND created_at >= ?
        GROUP BY date
        ORDER BY date ASC`,
    )
      .bind(fromQueryBoundary)
      .all<OptInKpiTrendRow>();

    const candidatesRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM shopify_customers sc
         LEFT JOIN email_subscribers es ON LOWER(es.email) = LOWER(sc.email)
        WHERE sc.email IS NOT NULL AND sc.email != ''
          AND (es.id IS NULL OR es.is_active = 0 OR es.transactional_only = 1)`,
    ).first<{ count: number | null }>();

    const all = Number(totalsRow?.all_count ?? 0);
    const newCount = Number(totalsRow?.new_count ?? 0);
    const reConsent = Number(totalsRow?.re_consent_count ?? 0);
    const reactivated = Number(totalsRow?.reactivated_count ?? 0);
    const web = Number(totalsRow?.web_count ?? 0);
    const liff = Number(totalsRow?.liff_count ?? 0);

    return c.json({
      success: true,
      data: {
        window: { days, fromDate: fromDateOnly, toDate: toDateOnly },
        totals: {
          all,
          new: newCount,
          reConsent,
          reactivated,
          web,
          liff,
          other: Math.max(0, all - (newCount + reConsent + reactivated)),
        },
        trend: buildZeroPaddedTrend(fromMs, days, trendResult.results ?? []),
        candidatesRemaining: Number(candidatesRow?.count ?? 0),
      },
    });
  } catch (err) {
    console.error('GET /api/admin/email/opt-in/kpi error', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// __test__ exports (5β-1d-3 unit-test 用)
export const __test__ = {
  buildZeroPaddedTrend,
  KPI_DAYS_DEFAULT,
  KPI_DAYS_MIN,
  KPI_DAYS_MAX,
};

export { emailAdmin };
