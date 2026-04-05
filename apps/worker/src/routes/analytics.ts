/**
 * Google Analytics 4 連携ルート
 *
 * - GA4設定管理 (CRUD)
 * - UTMテンプレート管理 (CRUD)
 * - UTMリンク生成
 * - イベントログ閲覧
 */

import { Hono } from 'hono';
import {
  upsertAnalyticsSettings,
  getAnalyticsSettings,
  getAnalyticsSettingsById,
  deleteAnalyticsSettings,
  getAnalyticsEvents,
  createUtmTemplate,
  getUtmTemplates,
  getUtmTemplateById,
  updateUtmTemplate,
  deleteUtmTemplate,
} from '@line-crm/db';
import { buildUtmUrl, buildLineUtmUrl } from '../services/analytics.js';
import type { Env } from '../index.js';

const analyticsRoutes = new Hono<Env>();

// ─── GA4 Settings ─────────────────────────────────────────────

/** GET /api/analytics/settings — list analytics settings */
analyticsRoutes.get('/settings', async (c) => {
  const lineAccountId = c.req.query('lineAccountId');
  const settings = await getAnalyticsSettings(c.env.DB, lineAccountId);
  return c.json({ success: true, data: settings });
});

/** GET /api/analytics/settings/:id — get single setting */
analyticsRoutes.get('/settings/:id', async (c) => {
  const setting = await getAnalyticsSettingsById(c.env.DB, c.req.param('id'));
  if (!setting) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  // Mask API secret in response
  return c.json({
    success: true,
    data: {
      ...setting,
      api_secret: setting.api_secret ? '****' : null,
    },
  });
});

/** POST /api/analytics/settings — create or update GA4 settings */
analyticsRoutes.post('/settings', async (c) => {
  const body = await c.req.json<{
    lineAccountId?: string;
    provider?: string;
    measurementId?: string;
    apiSecret?: string;
    enabled?: boolean;
    config?: string;
  }>();

  if (!body.measurementId) {
    return c.json({ success: false, error: 'measurementId is required' }, 400);
  }

  const setting = await upsertAnalyticsSettings(c.env.DB, body);
  return c.json({ success: true, data: setting });
});

/** DELETE /api/analytics/settings/:id — delete setting */
analyticsRoutes.delete('/settings/:id', async (c) => {
  await deleteAnalyticsSettings(c.env.DB, c.req.param('id'));
  return c.json({ success: true });
});

// ─── Analytics Events ─────────────────────────────────────────

/** GET /api/analytics/events — list event logs */
analyticsRoutes.get('/events', async (c) => {
  const friendId = c.req.query('friendId');
  const eventName = c.req.query('eventName');
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Number(c.req.query('offset') || 0);

  const events = await getAnalyticsEvents(c.env.DB, {
    friendId: friendId || undefined,
    eventName: eventName || undefined,
    limit,
    offset,
  });
  return c.json({ success: true, data: events, meta: { limit, offset } });
});

// ─── UTM Templates ────────────────────────────────────────────

/** GET /api/analytics/utm — list UTM templates */
analyticsRoutes.get('/utm', async (c) => {
  const lineAccountId = c.req.query('lineAccountId');
  const templates = await getUtmTemplates(c.env.DB, lineAccountId || undefined);
  return c.json({ success: true, data: templates });
});

/** GET /api/analytics/utm/:id — get single UTM template */
analyticsRoutes.get('/utm/:id', async (c) => {
  const template = await getUtmTemplateById(c.env.DB, c.req.param('id'));
  if (!template) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.json({ success: true, data: template });
});

/** POST /api/analytics/utm — create UTM template */
analyticsRoutes.post('/utm', async (c) => {
  const body = await c.req.json<{
    name: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    lineAccountId?: string;
  }>();

  if (!body.name) {
    return c.json({ success: false, error: 'name is required' }, 400);
  }

  const template = await createUtmTemplate(c.env.DB, body);
  return c.json({ success: true, data: template });
});

/** PUT /api/analytics/utm/:id — update UTM template */
analyticsRoutes.put('/utm/:id', async (c) => {
  const body = await c.req.json<{
    name?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
  }>();

  const updated = await updateUtmTemplate(c.env.DB, c.req.param('id'), body);
  if (!updated) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  return c.json({ success: true, data: updated });
});

/** DELETE /api/analytics/utm/:id — delete UTM template */
analyticsRoutes.delete('/utm/:id', async (c) => {
  await deleteUtmTemplate(c.env.DB, c.req.param('id'));
  return c.json({ success: true });
});

// ─── UTM Link Builder ─────────────────────────────────────────

/** POST /api/analytics/utm/build — generate UTM URL */
analyticsRoutes.post('/utm/build', async (c) => {
  const body = await c.req.json<{
    url: string;
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    term?: string;
    templateId?: string;
  }>();

  if (!body.url) {
    return c.json({ success: false, error: 'url is required' }, 400);
  }

  // If templateId provided, load template params
  if (body.templateId) {
    const template = await getUtmTemplateById(c.env.DB, body.templateId);
    if (!template) {
      return c.json({ success: false, error: 'Template not found' }, 404);
    }
    const utmUrl = buildUtmUrl(body.url, {
      source: (template.utm_source as string) || 'line',
      medium: (template.utm_medium as string) || 'message',
      campaign: (template.utm_campaign as string) || undefined,
      content: (template.utm_content as string) || undefined,
      term: (template.utm_term as string) || undefined,
    });
    return c.json({ success: true, data: { url: utmUrl } });
  }

  // Use provided params or LINE defaults
  const utmUrl = body.source
    ? buildUtmUrl(body.url, {
        source: body.source,
        medium: body.medium,
        campaign: body.campaign,
        content: body.content,
        term: body.term,
      })
    : buildLineUtmUrl(body.url, {
        campaign: body.campaign,
        content: body.content,
        term: body.term,
      });

  return c.json({ success: true, data: { url: utmUrl } });
});

export { analyticsRoutes };
