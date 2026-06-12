/**
 * Auto-Replies admin CRUD (AIネイティブ オペレーター体験 — A案)
 *
 * `auto_replies` テーブルは今まで webhook.ts が読むだけで **管理画面/APIが皆無**だった
 * (DMM パリティの隠れた穴)。本ルートで初の CRUD を提供する。
 * AI Conductor (POST /api/conductor/auto-reply) が起草した内容をここで保存/編集/削除する。
 *
 * 認証: 上位 authMiddleware (API_KEY ベアラー) で保護。
 * schema (packages/db/schema.sql:245): id, keyword, match_type('exact'|'contains'),
 *   response_type(default 'text'), response_content, is_active, created_at。
 *   ※ line_account_id 列は base schema に無いため本 CRUD では扱わない (= 全アカウント共通ルール)。
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { redactProhibitedPhrases } from '@line-crm/ai-provider';
import { auditAdmin } from '../services/audit-logger.js';
import type { Env } from '../index.js';

export const autoReplies = new Hono<Env>();

const MATCH_TYPES = ['exact', 'contains'] as const;
// buildMessage (webhook 送信側) が解釈できる型のみ許可 (review security MED: 自由文字列を禁止)
const RESPONSE_TYPES = ['text', 'image', 'flex', 'quick_reply'] as const;
const KEYWORD_MAX = 40;
const RESPONSE_MAX = 2000;
const BATCH_MAX = 6; // conductor の main + alternateKeywords(5) を 1 回で保存できる上限

type MatchType = (typeof MATCH_TYPES)[number];
type ResponseType = (typeof RESPONSE_TYPES)[number];

function isMatchType(v: unknown): v is MatchType {
  return typeof v === 'string' && (MATCH_TYPES as readonly string[]).includes(v);
}

function isResponseType(v: unknown): v is ResponseType {
  return typeof v === 'string' && (RESPONSE_TYPES as readonly string[]).includes(v);
}

/**
 * 書き込み境界の薬機ガード (review security MED): AI 生成経路だけでなく
 * 手動 POST/PATCH/batch でも responseContent を redact し、検出語を warnings で返す。
 * (webhook 送信側は read-time redact しないため、書き込み時が最終防衛線)
 */
function redactResponse(content: string): { text: string; warnings: string[] } {
  const r = redactProhibitedPhrases(content);
  return {
    text: r.text,
    warnings:
      r.detectedPhrases.length > 0
        ? [`返信文に薬機注意語 ${r.detectedPhrases.map((p) => `"${p}"`).join(', ')} を検出 — 置換しました。`]
        : [],
  };
}

// GET /api/auto-replies — 一覧 (有効/無効すべて、新しい順)
autoReplies.get('/api/auto-replies', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      `SELECT id, keyword, match_type, response_type, response_content, is_active, created_at
       FROM auto_replies ORDER BY created_at DESC LIMIT 500`,
    ).all<Record<string, unknown>>();
    return c.json({ success: true, data: result.results ?? [] });
  } catch (err) {
    console.error('GET /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/auto-replies — 作成
autoReplies.post('/api/auto-replies', async (c) => {
  try {
    const body = (await c.req.json<{
      keyword?: unknown;
      matchType?: unknown;
      responseType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    }>().catch(() => ({}))) as {
      keyword?: unknown;
      matchType?: unknown;
      responseType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    };

    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
    const rawResponse =
      typeof body.responseContent === 'string' ? body.responseContent.trim() : '';
    const matchType: MatchType = isMatchType(body.matchType) ? body.matchType : 'contains';
    const responseType: ResponseType = isResponseType(body.responseType)
      ? body.responseType
      : 'text';
    const isActive = body.isActive === false ? 0 : 1;

    if (!keyword || keyword.length > KEYWORD_MAX) {
      return c.json(
        { success: false, error: `keyword is required (1-${KEYWORD_MAX} chars)` },
        400,
      );
    }
    if (!rawResponse || rawResponse.length > RESPONSE_MAX) {
      return c.json(
        { success: false, error: `responseContent is required (1-${RESPONSE_MAX} chars)` },
        400,
      );
    }
    const { text: responseContent, warnings } = redactResponse(rawResponse);

    const id = crypto.randomUUID();
    const now = jstNow();
    await c.env.DB.prepare(
      `INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, keyword, matchType, responseType, responseContent, isActive, now)
      .run();

    await auditAdmin(c, {
      action: 'auto_reply.create',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
      metadata: { keyword, matchType, isActive, redacted: warnings.length > 0 },
    });

    const created = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ success: true, data: created, warnings }, 201);
  } catch (err) {
    console.error('POST /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/auto-replies/:id — 部分更新
autoReplies.patch('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    const body = (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as {
      keyword?: unknown;
      matchType?: unknown;
      responseContent?: unknown;
      isActive?: unknown;
    };

    // 空更新は no-op でなく 400 (review correctness MED: POST と整合)
    if (typeof body.keyword === 'string' && body.keyword.trim().length === 0) {
      return c.json({ success: false, error: 'keyword cannot be empty' }, 400);
    }
    if (typeof body.responseContent === 'string' && body.responseContent.trim().length === 0) {
      return c.json({ success: false, error: 'responseContent cannot be empty' }, 400);
    }
    // isActive は boolean のみ (review correctness MED: null 送信で勝手に有効化されるのを防ぐ)
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
      return c.json({ success: false, error: 'isActive must be a boolean' }, 400);
    }

    const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : null;
    if (keyword && keyword.length > KEYWORD_MAX) {
      return c.json({ success: false, error: `keyword too long (max ${KEYWORD_MAX})` }, 400);
    }
    const rawResponse =
      typeof body.responseContent === 'string' ? body.responseContent.trim() : null;
    if (rawResponse && rawResponse.length > RESPONSE_MAX) {
      return c.json({ success: false, error: `responseContent too long (max ${RESPONSE_MAX})` }, 400);
    }
    const redactedPatch = rawResponse !== null ? redactResponse(rawResponse) : null;
    const responseContent = redactedPatch?.text ?? null;
    const warnings = redactedPatch?.warnings ?? [];
    const matchType = isMatchType(body.matchType) ? body.matchType : null;
    const isActive =
      body.isActive === undefined ? null : body.isActive === false ? 0 : 1;

    await c.env.DB.prepare(
      `UPDATE auto_replies SET
         keyword = COALESCE(?, keyword),
         match_type = COALESCE(?, match_type),
         response_content = COALESCE(?, response_content),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
    )
      .bind(keyword, matchType, responseContent, isActive, id)
      .run();

    await auditAdmin(c, {
      action: 'auto_reply.update',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
      metadata: { keyword, matchType, isActive },
    });

    const updated = await c.env.DB.prepare(`SELECT * FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ success: true, data: updated, warnings });
  } catch (err) {
    console.error('PATCH /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/auto-replies/batch — 複数キーワードの原子的一括作成 (review correctness HIGH 対応)
//   conductor の「main + 別キーワード」保存用。D1 の db.batch はトランザクション実行されるため
//   部分失敗で orphan 行が残らない。既存の (keyword, match_type) と重複する item は insert せず
//   skipped で返す → 同じドラフトの二度保存・部分失敗後のリトライが安全 (重複行が生まれない)。
//   body: { items: [{ keyword, matchType?, responseContent, isActive? }] } (1〜BATCH_MAX 件)
autoReplies.post('/api/auto-replies/batch', async (c) => {
  try {
    const body = (await c.req
      .json<{ items?: unknown }>()
      .catch(() => ({}))) as { items?: unknown };

    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > BATCH_MAX) {
      return c.json(
        { success: false, error: `items array is required (1-${BATCH_MAX} items)` },
        400,
      );
    }

    // 1) 全 item を先に検証 (1 件でも不正なら何も書かない)
    const warnings: string[] = [];
    const parsed: Array<{
      keyword: string;
      matchType: MatchType;
      responseContent: string;
      isActive: 0 | 1;
    }> = [];
    const seenInPayload = new Set<string>();
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i] as Record<string, unknown>;
      const keyword = typeof item?.keyword === 'string' ? item.keyword.trim() : '';
      const rawResponse =
        typeof item?.responseContent === 'string' ? item.responseContent.trim() : '';
      if (!keyword || keyword.length > KEYWORD_MAX) {
        return c.json(
          { success: false, error: `items[${i}].keyword is required (1-${KEYWORD_MAX} chars)` },
          400,
        );
      }
      if (!rawResponse || rawResponse.length > RESPONSE_MAX) {
        return c.json(
          { success: false, error: `items[${i}].responseContent is required (1-${RESPONSE_MAX} chars)` },
          400,
        );
      }
      if (item?.isActive !== undefined && typeof item.isActive !== 'boolean') {
        return c.json({ success: false, error: `items[${i}].isActive must be a boolean` }, 400);
      }
      const matchType: MatchType = isMatchType(item?.matchType) ? (item.matchType as MatchType) : 'contains';
      // payload 内重複は黙って 1 つに畳む (= UI の Set dedupe の保険)
      const dedupeKey = `${keyword} ${matchType}`;
      if (seenInPayload.has(dedupeKey)) continue;
      seenInPayload.add(dedupeKey);
      const redacted = redactResponse(rawResponse);
      warnings.push(...redacted.warnings.map((w) => `items[${i}]: ${w}`));
      parsed.push({
        keyword,
        matchType,
        responseContent: redacted.text,
        isActive: item?.isActive === false ? 0 : 1,
      });
    }

    // 2) 既存重複 (keyword + match_type) は skip (リトライ・二度保存の冪等性)
    const placeholders = parsed.map(() => '(keyword = ? AND match_type = ?)').join(' OR ');
    const existingRows = await c.env.DB.prepare(
      `SELECT keyword, match_type FROM auto_replies WHERE ${placeholders}`,
    )
      .bind(...parsed.flatMap((p) => [p.keyword, p.matchType]))
      .all<{ keyword: string; match_type: string }>();
    const existing = new Set(
      (existingRows.results ?? []).map((r) => `${r.keyword} ${r.match_type}`),
    );

    const toInsert = parsed.filter((p) => !existing.has(`${p.keyword} ${p.matchType}`));
    const skipped = parsed
      .filter((p) => existing.has(`${p.keyword} ${p.matchType}`))
      .map((p) => p.keyword);

    // 3) 原子的 insert (D1 batch はトランザクション)
    const now = jstNow();
    const created: Array<{ id: string; keyword: string }> = [];
    if (toInsert.length > 0) {
      const stmts = toInsert.map((p) => {
        const id = crypto.randomUUID();
        created.push({ id, keyword: p.keyword });
        return c.env.DB.prepare(
          `INSERT INTO auto_replies (id, keyword, match_type, response_type, response_content, is_active, created_at)
           VALUES (?, ?, ?, 'text', ?, ?, ?)`,
        ).bind(id, p.keyword, p.matchType, p.responseContent, p.isActive, now);
      });
      await c.env.DB.batch(stmts);
    }

    await auditAdmin(c, {
      action: 'auto_reply.batch_create',
      targetType: 'auto_reply',
      result: 'success',
      metadata: {
        requested: body.items.length,
        created: created.length,
        skippedExisting: skipped.length,
        redacted: warnings.length > 0,
      },
    });

    return c.json(
      { success: true, data: { created, skipped }, warnings },
      created.length > 0 ? 201 : 200,
    );
  } catch (err) {
    console.error('POST /api/auto-replies/batch error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/auto-replies/:id
autoReplies.delete('/api/auto-replies/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(`SELECT id FROM auto_replies WHERE id = ?`)
      .bind(id)
      .first();
    if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

    await c.env.DB.prepare(`DELETE FROM auto_replies WHERE id = ?`).bind(id).run();
    await auditAdmin(c, {
      action: 'auto_reply.delete',
      targetType: 'auto_reply',
      targetId: id,
      result: 'success',
    });
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
