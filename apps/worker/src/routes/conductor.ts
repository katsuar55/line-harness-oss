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

const conductor = new Hono<Env>();

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
      const status =
        err.code === 'prompt_too_short' || err.code === 'prompt_too_long'
          ? 400
          : err.code === 'api_key_missing'
            ? 503
            : err.code === 'timeout'
              ? 504
              : err.code === 'invalid_response' || err.code === 'schema_validation_failed'
                ? 502
                : 500;
      return c.json(
        { success: false, error: err.message, code: err.code },
        status,
      );
    }
    console.error('POST /api/conductor/scenario error:', err);
    return c.json(
      { success: false, error: 'Internal server error' },
      500,
    );
  }
});

export default conductor;
