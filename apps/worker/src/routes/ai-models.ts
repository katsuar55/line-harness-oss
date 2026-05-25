/**
 * AI models catalog admin route (= 戦略 #1、 2026-05-26)
 *
 * 役割:
 *   - admin web `/ai-models` page から catalog を一覧 + filter
 *   - primary/fallback candidate の手動 toggle
 *   - 戦略 #1 (= PR #71) で蓄積した model を可視化
 *
 * 設計:
 *   - read endpoints は filter 可 (= vendor / family / task / activeOnly)
 *   - candidate toggle は PATCH /api/ai-models/:modelId/candidate
 *     (= primary/fallback 個別 boolean、 setModelCandidate query 使用)
 *   - 手動 sync trigger も用意 (= AI_MODELS_SYNC_FORCE=true 経路と同じ syncAiModelsCatalog 呼び出し)
 */
import { Hono } from 'hono';
import {
  listAiModels,
  getAiModelById,
  setModelCandidate,
  getAiModelCatalogStats,
  getRecentlyAddedModels,
} from '@line-crm/db';
import { syncAiModelsCatalog } from '../services/ai-models-catalog.js';

import type { Env } from '../index.js';

const aiModels = new Hono<Env>();

/**
 * GET /api/ai-models
 *   query: vendor / family / task / includeDeprecated (= 'true') / primaryOnly / fallbackOnly
 *   response: { success: true, data: { models: [], stats: { ... } } }
 */
aiModels.get('/api/ai-models', async (c) => {
  try {
    const vendor = c.req.query('vendor') || undefined;
    const family = c.req.query('family') || undefined;
    const task = c.req.query('task') || undefined;
    const includeDeprecated = c.req.query('includeDeprecated') === 'true';
    const primaryOnly = c.req.query('primaryOnly') === 'true';
    const fallbackOnly = c.req.query('fallbackOnly') === 'true';

    const [models, stats] = await Promise.all([
      listAiModels(c.env.DB, {
        vendor,
        family,
        task,
        includeDeprecated,
        primaryOnly,
        fallbackOnly,
      }),
      getAiModelCatalogStats(c.env.DB),
    ]);

    // 新着判定 (= 過去 7 日内に first_seen_at)
    const sinceMs = Date.now() - 7 * 24 * 3600 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();
    const newlyAdded = await getRecentlyAddedModels(c.env.DB, sinceIso);
    const newlyAddedIds = new Set(newlyAdded.map((m) => m.modelId));

    return c.json({
      success: true,
      data: {
        models: models.map((m) => ({
          ...m,
          isNewlyAdded: newlyAddedIds.has(m.modelId),
        })),
        stats,
      },
    });
  } catch (err) {
    console.error('[ai-models GET] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'failed to fetch ai_models' }, 500);
  }
});

/** GET /api/ai-models/:modelId — 1 件詳細 */
aiModels.get('/api/ai-models/:modelId{.+}', async (c) => {
  try {
    const modelId = decodeURIComponent(c.req.param('modelId') ?? '');
    if (!modelId) {
      return c.json({ success: false, error: 'modelId is required' }, 400);
    }
    const model = await getAiModelById(c.env.DB, modelId);
    if (!model) {
      return c.json({ success: false, error: 'not found' }, 404);
    }
    return c.json({ success: true, data: model });
  } catch (err) {
    console.error('[ai-models GET/:id] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'failed to fetch model' }, 500);
  }
});

/**
 * PATCH /api/ai-models/:modelId/candidate
 *   body: { primary?: boolean, fallback?: boolean }
 *   response: { success: true, data: { modelId, primary, fallback } }
 */
aiModels.patch('/api/ai-models/:modelId{.+}/candidate', async (c) => {
  try {
    const modelId = decodeURIComponent(c.req.param('modelId') ?? '');
    if (!modelId) {
      return c.json({ success: false, error: 'modelId is required' }, 400);
    }

    const body = await c.req.json<{ primary?: unknown; fallback?: unknown }>();
    const primary = typeof body.primary === 'boolean' ? body.primary : undefined;
    const fallback = typeof body.fallback === 'boolean' ? body.fallback : undefined;

    if (primary === undefined && fallback === undefined) {
      return c.json(
        { success: false, error: 'at least one of primary / fallback (boolean) is required' },
        400,
      );
    }

    const existing = await getAiModelById(c.env.DB, modelId);
    if (!existing) {
      return c.json({ success: false, error: 'model not found in catalog' }, 404);
    }

    await setModelCandidate(c.env.DB, modelId, { primary, fallback });
    const refreshed = await getAiModelById(c.env.DB, modelId);

    return c.json({
      success: true,
      data: {
        modelId,
        primary: refreshed?.primaryCandidate ?? false,
        fallback: refreshed?.fallbackCandidate ?? false,
      },
    });
  } catch (err) {
    console.error('[ai-models PATCH candidate] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'failed to update candidate' }, 500);
  }
});

/**
 * POST /api/ai-models/sync
 *   manual trigger (= AI_MODELS_SYNC_FORCE=true 経由と同じ syncAiModelsCatalog 呼び出し)
 *   response: { success: true, data: AiModelsSyncResult }
 */
aiModels.post('/api/ai-models/sync', async (c) => {
  try {
    const result = await syncAiModelsCatalog(
      { ...c.env, AI_MODELS_SYNC_FORCE: 'true' },
    );
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('[ai-models POST sync] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'sync failed' }, 500);
  }
});

export { aiModels };
