import { jstNow } from './utils.js';
// =============================================================================
// Tracked Links — URL click tracking with automatic actions
// =============================================================================

export interface TrackedLink {
  id: string;
  name: string;
  original_url: string;
  tag_id: string | null;
  scenario_id: string | null;
  is_active: number;
  click_count: number;
  created_at: string;
  updated_at: string;
}

export interface LinkClick {
  id: string;
  tracked_link_id: string;
  friend_id: string | null;
  clicked_at: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getTrackedLinks(db: D1Database): Promise<TrackedLink[]> {
  const result = await db
    .prepare(`SELECT * FROM tracked_links ORDER BY created_at DESC`)
    .all<TrackedLink>();
  return result.results;
}

export async function getTrackedLinkById(
  db: D1Database,
  id: string,
): Promise<TrackedLink | null> {
  return db
    .prepare(`SELECT * FROM tracked_links WHERE id = ?`)
    .bind(id)
    .first<TrackedLink>();
}

export interface CreateTrackedLinkInput {
  name: string;
  originalUrl: string;
  tagId?: string | null;
  scenarioId?: string | null;
}

export async function createTrackedLink(
  db: D1Database,
  input: CreateTrackedLinkInput,
): Promise<TrackedLink> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO tracked_links (id, name, original_url, tag_id, scenario_id, is_active, click_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .bind(id, input.name, input.originalUrl, input.tagId ?? null, input.scenarioId ?? null, now, now)
    .run();

  return (await getTrackedLinkById(db, id))!;
}

export async function deleteTrackedLink(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM tracked_links WHERE id = ?`).bind(id).run();
}

// ── Click Recording ───────────────────────────────────────────────────────────

export async function recordLinkClick(
  db: D1Database,
  trackedLinkId: string,
  friendId?: string | null,
): Promise<LinkClick> {
  const id = crypto.randomUUID();
  const now = jstNow();

  await db
    .prepare(
      `INSERT INTO link_clicks (id, tracked_link_id, friend_id, clicked_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(id, trackedLinkId, friendId ?? null, now)
    .run();

  await db
    .prepare(
      `UPDATE tracked_links SET click_count = click_count + 1, updated_at = ? WHERE id = ?`,
    )
    .bind(now, trackedLinkId)
    .run();

  return (await db
    .prepare(`SELECT * FROM link_clicks WHERE id = ?`)
    .bind(id)
    .first<LinkClick>())!;
}

export interface LinkClickWithFriend extends LinkClick {
  friend_display_name: string | null;
}

export interface TrafficSourceStat {
  link_id: string;
  link_name: string;
  original_url: string;
  tag_id: string | null;
  scenario_id: string | null;
  total_clicks: number;
  identified_clicks: number;
  unique_friends: number;
  clicks_30d: number;
  clicks_7d: number;
  last_click_at: string | null;
}

/**
 * Aggregate click stats across all tracked links for the traffic-sources dashboard.
 * Uses JST boundaries already encoded on clicked_at via jstNow().
 */
export async function getTrafficSourceStats(db: D1Database): Promise<TrafficSourceStat[]> {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT
        tl.id as link_id,
        tl.name as link_name,
        tl.original_url,
        tl.tag_id,
        tl.scenario_id,
        COUNT(lc.id) as total_clicks,
        SUM(CASE WHEN lc.friend_id IS NOT NULL THEN 1 ELSE 0 END) as identified_clicks,
        COUNT(DISTINCT lc.friend_id) as unique_friends,
        SUM(CASE WHEN lc.clicked_at >= ? THEN 1 ELSE 0 END) as clicks_30d,
        SUM(CASE WHEN lc.clicked_at >= ? THEN 1 ELSE 0 END) as clicks_7d,
        MAX(lc.clicked_at) as last_click_at
       FROM tracked_links tl
       LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id
       GROUP BY tl.id
       ORDER BY total_clicks DESC, tl.created_at DESC`,
    )
    .bind(d30, d7)
    .all<TrafficSourceStat>();
  return result.results;
}

export async function getLinkClicks(
  db: D1Database,
  trackedLinkId: string,
): Promise<LinkClickWithFriend[]> {
  const result = await db
    .prepare(
      `SELECT lc.*, f.display_name as friend_display_name
       FROM link_clicks lc
       LEFT JOIN friends f ON f.id = lc.friend_id
       WHERE lc.tracked_link_id = ?
       ORDER BY lc.clicked_at DESC`,
    )
    .bind(trackedLinkId)
    .all<LinkClickWithFriend>();
  return result.results;
}
