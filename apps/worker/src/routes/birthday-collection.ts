/**
 * 誕生月再収集 — DMM 解約 (2026-06〜07) 前にデータを救出するためのトリガー API
 *
 * エンドポイント:
 *   GET  /api/birthday-collection/stats   — 登録済/未登録の件数
 *   POST /api/birthday-collection/preview — Quick Reply メッセージプレビュー (送信せず)
 *   POST /api/birthday-collection/send    — 未登録の友だちに一斉 multicast
 *                                          (default: dryRun=true で誤発射防止)
 *
 * 実装メモ:
 * - LINE multicast は 1リクエスト最大 500 ID のため 500件ずつチャンク
 * - 誕生月は friends.metadata.birth_month (TEXT "1"〜"12") に保存
 *   → segment_query の metadata_not_equals フィルタとも整合
 */
import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import {
  BIRTHDAY_METADATA_KEY,
  buildBirthdayCollectionMessage,
} from '../services/birthday-collection.js';
import type { Env } from '../index.js';

const birthdayCollection = new Hono<Env>();

const METADATA_PATH = `$.${BIRTHDAY_METADATA_KEY}`;

birthdayCollection.get('/api/birthday-collection/stats', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId');
    const accountFilter = lineAccountId ? ' AND line_account_id = ?' : '';
    const params: unknown[] = lineAccountId ? [lineAccountId] : [];

    const totalRow = await c.env.DB
      .prepare(`SELECT COUNT(*) AS c FROM friends WHERE is_following = 1${accountFilter}`)
      .bind(...params)
      .first<{ c: number }>();

    const registeredRow = await c.env.DB
      .prepare(
        `SELECT COUNT(*) AS c FROM friends
         WHERE is_following = 1${accountFilter}
           AND json_extract(metadata, ?) IS NOT NULL`,
      )
      .bind(...params, METADATA_PATH)
      .first<{ c: number }>();

    const total = totalRow?.c ?? 0;
    const registered = registeredRow?.c ?? 0;

    return c.json({
      success: true,
      data: {
        total,
        registered,
        unregistered: total - registered,
      },
    });
  } catch (err) {
    console.error('GET /api/birthday-collection/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

interface PreviewBody {
  customText?: string;
}

interface SendBody {
  customText?: string;
  dryRun?: boolean;
  lineAccountId?: string;
}

birthdayCollection.post('/api/birthday-collection/preview', async (c) => {
  try {
    const body: PreviewBody = await c.req
      .json<PreviewBody>()
      .catch((): PreviewBody => ({}));
    const message = buildBirthdayCollectionMessage(body.customText);
    return c.json({ success: true, data: message });
  } catch (err) {
    console.error('POST /api/birthday-collection/preview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

birthdayCollection.post('/api/birthday-collection/send', async (c) => {
  try {
    const body: SendBody = await c.req
      .json<SendBody>()
      .catch((): SendBody => ({}));

    // 安全側: dryRun を明示的に false にした時だけ実送信
    const dryRun = body.dryRun !== false;

    const accountFilter = body.lineAccountId ? ' AND line_account_id = ?' : '';
    const params: unknown[] = body.lineAccountId ? [body.lineAccountId] : [];

    const result = await c.env.DB
      .prepare(
        `SELECT line_user_id FROM friends
         WHERE is_following = 1${accountFilter}
           AND json_extract(metadata, ?) IS NULL`,
      )
      .bind(...params, METADATA_PATH)
      .all<{ line_user_id: string }>();

    const targetIds = result.results.map((r) => r.line_user_id);

    if (dryRun) {
      return c.json({
        success: true,
        data: { dryRun: true, targetCount: targetIds.length },
      });
    }

    const message = buildBirthdayCollectionMessage(body.customText);
    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);

    const CHUNK_SIZE = 500;
    let sent = 0;
    let errors = 0;
    for (let i = 0; i < targetIds.length; i += CHUNK_SIZE) {
      const chunk = targetIds.slice(i, i + CHUNK_SIZE);
      try {
        await lineClient.multicast(chunk, [message]);
        sent += chunk.length;
      } catch (err) {
        console.error('birthday-collection multicast chunk error:', err);
        errors += chunk.length;
      }
    }

    return c.json({
      success: true,
      data: {
        dryRun: false,
        targetCount: targetIds.length,
        sent,
        errors,
      },
    });
  } catch (err) {
    console.error('POST /api/birthday-collection/send error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { birthdayCollection };
