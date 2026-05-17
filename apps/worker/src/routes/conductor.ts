/**
 * Phase 5γ-1: AI Conductor route
 *
 * AI による自然言語 → 構造化 JSON 生成エンドポイント群の入り口。
 * 5γ-1 では scenario 生成のみ対応 (5γ-2: rich menu / 5γ-3: form /
 * 5γ-4: message / 5γ-5: UI 統合 で順次拡張)。
 *
 * 認証は他 /api/* ルートと同じく上位 authMiddleware (API_KEY ベアラー) で保護される。
 *
 * エンドポイント:
 *   POST /api/conductor/scenario
 *     body: { prompt: string }
 *     200: { success: true, data: { scenario, steps, warnings, provider, model } }
 *     400: prompt 不正 (短すぎ / 長すぎ / 欠落)
 *     502: AI 応答が JSON でない / schema 違反
 *     503: 利用可能な provider なし (API key 不足)
 *     504: AI provider timeout
 *     500: 想定外
 */

import { Hono } from 'hono';
import type { Env } from '../index.js';
import { createAIRouterFromEnv } from '../services/ai-router-factory.js';
import {
  generateScenarioFromPrompt,
  ScenarioConductorError,
} from '../services/scenario-conductor.js';
import {
  generateRichMenuFromPrompt,
  RichMenuConductorError,
} from '../services/rich-menu-conductor.js';

const conductor = new Hono<Env>();

/**
 * Conductor error code → HTTP status mapping (5γ-1 / 5γ-2 共通)
 */
function mapErrorCodeToStatus(
  code:
    | 'prompt_too_short'
    | 'prompt_too_long'
    | 'api_key_missing'
    | 'timeout'
    | 'invalid_response'
    | 'schema_validation_failed'
    | 'api_error',
): 400 | 502 | 503 | 504 | 500 {
  switch (code) {
    case 'prompt_too_short':
    case 'prompt_too_long':
      return 400;
    case 'api_key_missing':
      return 503;
    case 'timeout':
      return 504;
    case 'invalid_response':
    case 'schema_validation_failed':
      return 502;
    case 'api_error':
    default:
      return 500;
  }
}

conductor.post('/api/conductor/scenario', async (c) => {
  let body: { prompt?: unknown };
  try {
    body = await c.req.json<{ prompt?: unknown }>();
  } catch {
    return c.json(
      { success: false, error: 'invalid JSON body' },
      400,
    );
  }

  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return c.json(
      { success: false, error: 'prompt is required (non-empty string)' },
      400,
    );
  }

  try {
    const router = createAIRouterFromEnv(c.env);
    const result = await generateScenarioFromPrompt({
      prompt: body.prompt,
      router,
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof ScenarioConductorError) {
      return c.json(
        { success: false, error: err.message, code: err.code },
        mapErrorCodeToStatus(err.code),
      );
    }
    console.error('POST /api/conductor/scenario error:', err);
    return c.json(
      { success: false, error: 'Internal server error' },
      500,
    );
  }
});

/**
 * POST /api/conductor/rich-menu (Phase 5γ-2)
 * body: { prompt: string }
 * 200: { success: true, data: { richMenu, warnings, provider, model } }
 * 400/502/503/504/500: error code mapping
 */
conductor.post('/api/conductor/rich-menu', async (c) => {
  let body: { prompt?: unknown };
  try {
    body = await c.req.json<{ prompt?: unknown }>();
  } catch {
    return c.json({ success: false, error: 'invalid JSON body' }, 400);
  }

  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    return c.json(
      { success: false, error: 'prompt is required (non-empty string)' },
      400,
    );
  }

  try {
    const router = createAIRouterFromEnv(c.env);
    const result = await generateRichMenuFromPrompt({
      prompt: body.prompt,
      router,
    });
    return c.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof RichMenuConductorError) {
      return c.json(
        { success: false, error: err.message, code: err.code },
        mapErrorCodeToStatus(err.code),
      );
    }
    console.error('POST /api/conductor/rich-menu error:', err);
    return c.json(
      { success: false, error: 'Internal server error' },
      500,
    );
  }
});

export default conductor;
