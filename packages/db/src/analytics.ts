import { jstNow } from './utils.js';

// ===== Analytics Settings =====

export async function upsertAnalyticsSettings(
  db: D1Database,
  settings: {
    lineAccountId?: string;
    provider?: string;
    measurementId?: string;
    apiSecret?: string;
    enabled?: boolean;
    config?: string;
  },
): Promise<Record<string, unknown>> {
  const now = jstNow();

  const existing = await db
    .prepare(
      `SELECT * FROM analytics_settings WHERE line_account_id IS ? AND provider = ?`,
    )
    .bind(settings.lineAccountId ?? null, settings.provider ?? 'ga4')
    .first<Record<string, unknown>>();

  if (existing) {
    await db
      .prepare(
        `UPDATE analytics_settings SET measurement_id = COALESCE(?, measurement_id), api_secret = COALESCE(?, api_secret), enabled = COALESCE(?, enabled), config = COALESCE(?, config), updated_at = ? WHERE id = ?`,
      )
      .bind(
        settings.measurementId ?? null,
        settings.apiSecret ?? null,
        settings.enabled != null ? (settings.enabled ? 1 : 0) : null,
        settings.config ?? null,
        now,
        existing.id,
      )
      .run();

    return (await db
      .prepare(`SELECT * FROM analytics_settings WHERE id = ?`)
      .bind(existing.id)
      .first<Record<string, unknown>>())!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO analytics_settings (id, line_account_id, provider, measurement_id, api_secret, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      settings.lineAccountId ?? null,
      settings.provider ?? 'ga4',
      settings.measurementId ?? null,
      settings.apiSecret ?? null,
      settings.enabled !== false ? 1 : 0,
      settings.config ?? '{}',
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM analytics_settings WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>())!;
}

export async function getAnalyticsSettings(
  db: D1Database,
  lineAccountId?: string,
): Promise<Array<Record<string, unknown>>> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM analytics_settings WHERE line_account_id = ?`)
      .bind(lineAccountId)
      .all<Record<string, unknown>>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM analytics_settings WHERE enabled = 1`)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function getAnalyticsSettingsById(
  db: D1Database,
  id: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM analytics_settings WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function deleteAnalyticsSettings(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM analytics_settings WHERE id = ?`)
    .bind(id)
    .run();
}

// ===== Analytics Events =====

export async function logAnalyticsEvent(
  db: D1Database,
  event: {
    friendId?: string;
    eventName: string;
    eventParams?: string;
    measurementId?: string;
    status?: string;
    errorMessage?: string;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO analytics_events (id, friend_id, event_name, event_params, measurement_id, status, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      event.friendId ?? null,
      event.eventName,
      event.eventParams ?? '{}',
      event.measurementId ?? null,
      event.status ?? 'sent',
      event.errorMessage ?? null,
      now,
    )
    .run();
}

export async function getAnalyticsEvents(
  db: D1Database,
  filters?: {
    friendId?: string;
    eventName?: string;
    limit?: number;
    offset?: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  if (filters?.friendId && filters?.eventName) {
    const result = await db
      .prepare(
        `SELECT * FROM analytics_events WHERE friend_id = ? AND event_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(filters.friendId, filters.eventName, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  if (filters?.friendId) {
    const result = await db
      .prepare(
        `SELECT * FROM analytics_events WHERE friend_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(filters.friendId, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  if (filters?.eventName) {
    const result = await db
      .prepare(
        `SELECT * FROM analytics_events WHERE event_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(filters.eventName, limit, offset)
      .all<Record<string, unknown>>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Record<string, unknown>>();
  return result.results;
}

// ===== UTM Templates =====

export async function createUtmTemplate(
  db: D1Database,
  template: {
    name: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    lineAccountId?: string;
  },
): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO utm_templates (id, name, utm_source, utm_medium, utm_campaign, utm_content, utm_term, line_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      template.name,
      template.utmSource ?? 'line',
      template.utmMedium ?? 'message',
      template.utmCampaign ?? null,
      template.utmContent ?? null,
      template.utmTerm ?? null,
      template.lineAccountId ?? null,
      now,
      now,
    )
    .run();

  return (await db
    .prepare(`SELECT * FROM utm_templates WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>())!;
}

export async function getUtmTemplates(
  db: D1Database,
  lineAccountId?: string,
): Promise<Array<Record<string, unknown>>> {
  if (lineAccountId) {
    const result = await db
      .prepare(
        `SELECT * FROM utm_templates WHERE line_account_id = ? ORDER BY created_at DESC`,
      )
      .bind(lineAccountId)
      .all<Record<string, unknown>>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM utm_templates ORDER BY created_at DESC`)
    .all<Record<string, unknown>>();
  return result.results;
}

export async function getUtmTemplateById(
  db: D1Database,
  id: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(`SELECT * FROM utm_templates WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function updateUtmTemplate(
  db: D1Database,
  id: string,
  updates: {
    name?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
  },
): Promise<Record<string, unknown> | null> {
  const now = jstNow();

  await db
    .prepare(
      `UPDATE utm_templates SET name = COALESCE(?, name), utm_source = COALESCE(?, utm_source), utm_medium = COALESCE(?, utm_medium), utm_campaign = COALESCE(?, utm_campaign), utm_content = COALESCE(?, utm_content), utm_term = COALESCE(?, utm_term), updated_at = ? WHERE id = ?`,
    )
    .bind(
      updates.name ?? null,
      updates.utmSource ?? null,
      updates.utmMedium ?? null,
      updates.utmCampaign ?? null,
      updates.utmContent ?? null,
      updates.utmTerm ?? null,
      now,
      id,
    )
    .run();

  return db
    .prepare(`SELECT * FROM utm_templates WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function deleteUtmTemplate(
  db: D1Database,
  id: string,
): Promise<void> {
  await db.prepare(`DELETE FROM utm_templates WHERE id = ?`).bind(id).run();
}
