/**
 * AI models catalog queries (= 自動 update 戦略 #1、 2026-05-26)
 *
 * 目的:
 *   Cloudflare Workers AI で利用可能な model 一覧を蓄積/取得。
 *   - daily cron で API sync (= services/ai-models-catalog.ts)
 *   - admin web で可視化 (= /ai-models page)
 *   - 将来的に ai-router auto-select 候補 (= 戦略 #3)
 *
 * 関連 memory:
 *   - feedback_ai_model_silent_fallback.md (= Qwen 常時 fail 教訓)
 *   - feedback_secret_overrides_hardcoded_default.md
 */

import { jstNow } from './utils.js';

// ============================================================
// 型
// ============================================================

export interface AiModelCatalogRow {
  id: string;
  model_id: string;
  vendor: string;
  family: string;
  size_label: string | null;
  task: string;
  capabilities: string | null;
  context_window: number | null;
  description: string | null;
  is_beta: number;
  is_deprecated: number;
  primary_candidate: number;
  fallback_candidate: number;
  first_seen_at: string;
  last_seen_at: string;
  last_synced_at: string | null;
  raw_metadata: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface AiModelCatalogEntry {
  id: string;
  modelId: string;
  vendor: string;
  family: string;
  sizeLabel: string | null;
  task: string;
  capabilities: string[];
  contextWindow: number | null;
  description: string | null;
  isBeta: boolean;
  isDeprecated: boolean;
  primaryCandidate: boolean;
  fallbackCandidate: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSyncedAt: string | null;
  source: string;
}

export interface UpsertAiModelInput {
  modelId: string;
  vendor: string;
  family: string;
  sizeLabel?: string | null;
  task: string;
  capabilities?: string[];
  contextWindow?: number | null;
  description?: string | null;
  isBeta?: boolean;
  rawMetadata?: object | null;
  source?: 'sync' | 'manual' | 'seed';
}

export interface AiModelCatalogFilters {
  vendor?: string;
  family?: string;
  task?: string;
  includeDeprecated?: boolean;
  primaryOnly?: boolean;
  fallbackOnly?: boolean;
}

// ============================================================
// 変換 helper
// ============================================================

export function rowToEntry(row: AiModelCatalogRow): AiModelCatalogEntry {
  return {
    id: row.id,
    modelId: row.model_id,
    vendor: row.vendor,
    family: row.family,
    sizeLabel: row.size_label,
    task: row.task,
    capabilities: parseCapabilities(row.capabilities),
    contextWindow: row.context_window,
    description: row.description,
    isBeta: row.is_beta === 1,
    isDeprecated: row.is_deprecated === 1,
    primaryCandidate: row.primary_candidate === 1,
    fallbackCandidate: row.fallback_candidate === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastSyncedAt: row.last_synced_at,
    source: row.source,
  };
}

function parseCapabilities(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function stringifyCapabilities(value: string[] | undefined): string | null {
  if (!value || value.length === 0) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function stringifyMetadata(value: object | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ============================================================
// SELECT
// ============================================================

export async function listAiModels(
  db: D1Database,
  filters: AiModelCatalogFilters = {},
): Promise<AiModelCatalogEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (!filters.includeDeprecated) {
    where.push('is_deprecated = 0');
  }
  if (filters.vendor) {
    where.push('vendor = ?');
    params.push(filters.vendor);
  }
  if (filters.family) {
    where.push('family = ?');
    params.push(filters.family);
  }
  if (filters.task) {
    where.push('task = ?');
    params.push(filters.task);
  }
  if (filters.primaryOnly) {
    where.push('primary_candidate = 1');
  }
  if (filters.fallbackOnly) {
    where.push('fallback_candidate = 1');
  }

  const sql = `SELECT * FROM ai_models_catalog
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY vendor ASC, family ASC, last_seen_at DESC`;

  const stmt = db.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  const result = await bound.all<AiModelCatalogRow>();
  return (result.results ?? []).map(rowToEntry);
}

export async function getAiModelById(
  db: D1Database,
  modelId: string,
): Promise<AiModelCatalogEntry | null> {
  const row = await db
    .prepare(`SELECT * FROM ai_models_catalog WHERE model_id = ? LIMIT 1`)
    .bind(modelId)
    .first<AiModelCatalogRow>();
  return row ? rowToEntry(row) : null;
}

export async function getRecentlyAddedModels(
  db: D1Database,
  sinceIso: string,
): Promise<AiModelCatalogEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ai_models_catalog
        WHERE first_seen_at >= ? AND source != 'seed'
        ORDER BY first_seen_at DESC`,
    )
    .bind(sinceIso)
    .all<AiModelCatalogRow>();
  return (result.results ?? []).map(rowToEntry);
}

export async function getRecentlyDeprecatedModels(
  db: D1Database,
  sinceIso: string,
): Promise<AiModelCatalogEntry[]> {
  const result = await db
    .prepare(
      `SELECT * FROM ai_models_catalog
        WHERE is_deprecated = 1 AND updated_at >= ?
        ORDER BY updated_at DESC`,
    )
    .bind(sinceIso)
    .all<AiModelCatalogRow>();
  return (result.results ?? []).map(rowToEntry);
}

export interface AiModelCatalogStats {
  total: number;
  active: number;
  deprecated: number;
  primaryCandidates: number;
  fallbackCandidates: number;
  byVendor: Record<string, number>;
  byTask: Record<string, number>;
}

export async function getAiModelCatalogStats(db: D1Database): Promise<AiModelCatalogStats> {
  const totals = await db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN is_deprecated = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN is_deprecated = 1 THEN 1 ELSE 0 END) AS deprecated,
        SUM(CASE WHEN primary_candidate = 1 AND is_deprecated = 0 THEN 1 ELSE 0 END) AS primary_cnt,
        SUM(CASE WHEN fallback_candidate = 1 AND is_deprecated = 0 THEN 1 ELSE 0 END) AS fallback_cnt
       FROM ai_models_catalog`,
    )
    .first<{
      total: number;
      active: number;
      deprecated: number;
      primary_cnt: number;
      fallback_cnt: number;
    }>();

  const byVendorRows = await db
    .prepare(
      `SELECT vendor, COUNT(*) AS cnt FROM ai_models_catalog
        WHERE is_deprecated = 0 GROUP BY vendor`,
    )
    .all<{ vendor: string; cnt: number }>();

  const byTaskRows = await db
    .prepare(
      `SELECT task, COUNT(*) AS cnt FROM ai_models_catalog
        WHERE is_deprecated = 0 GROUP BY task`,
    )
    .all<{ task: string; cnt: number }>();

  const byVendor: Record<string, number> = {};
  for (const row of byVendorRows.results ?? []) byVendor[row.vendor] = row.cnt;
  const byTask: Record<string, number> = {};
  for (const row of byTaskRows.results ?? []) byTask[row.task] = row.cnt;

  return {
    total: totals?.total ?? 0,
    active: totals?.active ?? 0,
    deprecated: totals?.deprecated ?? 0,
    primaryCandidates: totals?.primary_cnt ?? 0,
    fallbackCandidates: totals?.fallback_cnt ?? 0,
    byVendor,
    byTask,
  };
}

// ============================================================
// UPSERT (= cron sync で使用)
// ============================================================

export interface UpsertResult {
  inserted: boolean;
  updated: boolean;
  /** sync 前から catalog に存在したか (= 新着検出用) */
  preExisting: boolean;
}

/**
 * model を upsert。 INSERT/UPDATE どちらでも last_seen_at + last_synced_at を更新。
 * preExisting は呼び出し前の SELECT 結果で判定するため、 ここでは関知しない。
 */
export async function upsertAiModel(
  db: D1Database,
  input: UpsertAiModelInput,
): Promise<{ inserted: boolean }> {
  const now = jstNow();
  const capabilities = stringifyCapabilities(input.capabilities);
  const metadata = stringifyMetadata(input.rawMetadata ?? null);
  const source = input.source ?? 'sync';
  const isBeta = input.isBeta ? 1 : 0;

  const existing = await db
    .prepare(`SELECT id FROM ai_models_catalog WHERE model_id = ?`)
    .bind(input.modelId)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE ai_models_catalog SET
          vendor = ?, family = ?, size_label = ?, task = ?,
          capabilities = COALESCE(?, capabilities),
          context_window = COALESCE(?, context_window),
          description = COALESCE(?, description),
          is_beta = ?,
          last_seen_at = ?, last_synced_at = ?, updated_at = ?,
          raw_metadata = COALESCE(?, raw_metadata)
         WHERE model_id = ?`,
      )
      .bind(
        input.vendor,
        input.family,
        input.sizeLabel ?? null,
        input.task,
        capabilities,
        input.contextWindow ?? null,
        input.description ?? null,
        isBeta,
        now,
        now,
        now,
        metadata,
        input.modelId,
      )
      .run();
    return { inserted: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ai_models_catalog (
        id, model_id, vendor, family, size_label, task,
        capabilities, context_window, description, is_beta,
        first_seen_at, last_seen_at, last_synced_at,
        raw_metadata, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.modelId,
      input.vendor,
      input.family,
      input.sizeLabel ?? null,
      input.task,
      capabilities,
      input.contextWindow ?? null,
      input.description ?? null,
      isBeta,
      now,
      now,
      now,
      metadata,
      source,
      now,
      now,
    )
    .run();
  return { inserted: true };
}

/**
 * sync 実行時に「API response に居なかった」 既存 row を deprecate マーク。
 * threshold 日数より長く last_seen_at が更新されていない row 対象 (= 一時的な API
 * fail で誤検出しないための grace period)。
 */
export async function markStaleModelsAsDeprecated(
  db: D1Database,
  staleThresholdIso: string,
): Promise<{ deprecatedCount: number; modelIds: string[] }> {
  const now = jstNow();
  const stale = await db
    .prepare(
      `SELECT model_id FROM ai_models_catalog
        WHERE is_deprecated = 0
          AND source != 'seed'
          AND last_seen_at < ?`,
    )
    .bind(staleThresholdIso)
    .all<{ model_id: string }>();

  const modelIds = (stale.results ?? []).map((r) => r.model_id);
  if (modelIds.length === 0) {
    return { deprecatedCount: 0, modelIds: [] };
  }

  for (const modelId of modelIds) {
    await db
      .prepare(
        `UPDATE ai_models_catalog
            SET is_deprecated = 1, updated_at = ?
          WHERE model_id = ?`,
      )
      .bind(now, modelId)
      .run();
  }

  return { deprecatedCount: modelIds.length, modelIds };
}

/** primary/fallback 候補の手動 toggle (= admin UI 用) */
export async function setModelCandidate(
  db: D1Database,
  modelId: string,
  flags: { primary?: boolean; fallback?: boolean },
): Promise<void> {
  const now = jstNow();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (flags.primary !== undefined) {
    sets.push('primary_candidate = ?');
    params.push(flags.primary ? 1 : 0);
  }
  if (flags.fallback !== undefined) {
    sets.push('fallback_candidate = ?');
    params.push(flags.fallback ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now);
  params.push(modelId);

  await db
    .prepare(`UPDATE ai_models_catalog SET ${sets.join(', ')} WHERE model_id = ?`)
    .bind(...params)
    .run();
}
