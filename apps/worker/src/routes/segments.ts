/**
 * Segments route (AIネイティブ オペレーター体験 — A案 MVP)
 *
 * POST /api/segments/count — SegmentCondition のドライラン該当人数。
 *   AI/手動で組んだセグメント条件を「配信前に何人に当たるか」確認するための読み取り専用 API。
 *   buildSegmentQuery (ブラックリスト自動除外込み) をそのまま COUNT で包む — 配信経路と同一の
 *   クエリビルダーを使うことで「count と実配信の母集団が一致する」ことを保証する。
 *
 * 認証: 上位 authMiddleware (API_KEY ベアラー)。書き込みなし。
 */

import { Hono } from 'hono';
import { buildSegmentQuery } from '../services/segment-query.js';
import { segmentConditionSchema } from '../services/segment-conductor.js';
import type { Env } from '../index.js';

export const segments = new Hono<Env>();

segments.post('/api/segments/count', async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'invalid JSON body' }, 400);
    }

    const condition = (body as { condition?: unknown })?.condition;
    const validated = segmentConditionSchema.safeParse(condition);
    if (!validated.success) {
      return c.json(
        {
          success: false,
          error: `invalid condition: ${validated.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join(', ')}`,
        },
        400,
      );
    }

    const { sql, bindings } = buildSegmentQuery(validated.data);
    const countSql = `SELECT COUNT(*) as cnt FROM (${sql})`;
    const row = await c.env.DB.prepare(countSql)
      .bind(...bindings)
      .first<{ cnt: number }>();

    return c.json({ success: true, data: { count: row?.cnt ?? 0 } });
  } catch (err) {
    console.error('POST /api/segments/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
