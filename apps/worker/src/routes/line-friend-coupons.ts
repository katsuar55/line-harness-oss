/**
 * GET /api/line-friend-coupons (Phase 5β-1d-2-followup admin UI)
 *
 * 役割:
 *   - line_friend_coupons テーブルを admin web から閲覧可能にする
 *   - filter (status / source / friend_id / 期間) + pagination
 *   - friends JOIN で display_name 取得 (= 名前 + coupon を 1 row で確認)
 *
 * 設計:
 *   - read-only (UPDATE/DELETE は redeem trigger 等 既存 webhook 側で実装)
 *   - PII 露出最小: line_user_id は返さず friend.id + display_name のみ
 *   - 5β-1d-2 課題 1 (= issueCouponForFriend silent fail) の **発行実績 監視** に直結
 *
 * 関連:
 *   - apps/worker/src/services/shopify-coupon-issuer.ts (= 発行 logic、 audit_logs と連動)
 *   - apps/worker/src/routes/audit-logs.ts (= audit_logs 閲覧、 同じ pattern)
 *   - packages/db/migrations/050_line_friend_coupons.sql (= schema)
 */

import { Hono } from 'hono';
import { getCouponRedemptionStats } from '@line-crm/db';
import type { Env } from '../index.js';

const VALID_STATUSES = new Set(['issued', 'redeemed']);
// line_friend_coupons.source の CHECK 制約と一致させる (schema.sql)。
// 以前は 'manual' を受け付けていたが DB 側に存在せず常に 0 件、実在する 'static_fallback' は 400 で弾いていた。
const VALID_SOURCES = new Set(['shopify', 'static_fallback']);

interface CouponRow {
  id: string;
  friend_id: string;
  display_name: string | null;
  line_account_id: string | null;
  coupon_code: string;
  shopify_discount_code_id: string | null;
  discount_value: number;
  discount_currency: string;
  issued_at: string;
  expires_at: string | null;
  status: string;
  source: string;
}

interface CountRow {
  n: number;
}

const lineFriendCoupons = new Hono<Env>();

lineFriendCoupons.get('/api/line-friend-coupons', async (c) => {
  try {
    const status = c.req.query('status') ?? undefined;
    const source = c.req.query('source') ?? undefined;
    const friendId = c.req.query('friendId') ?? undefined;
    const since = c.req.query('since') ?? undefined;
    const until = c.req.query('until') ?? undefined;
    // parse with NaN handling (= '0' は valid 値、 falsy fallback 不可)
    const limitRaw = parseInt(c.req.query('limit') ?? '100', 10);
    const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 100 : limitRaw, 1), 500);
    const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
    const offset = Math.max(Number.isNaN(offsetRaw) ? 0 : offsetRaw, 0);

    // enum validation
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return c.json({ success: false, error: `invalid status: ${status}` }, 400);
    }
    if (source !== undefined && !VALID_SOURCES.has(source)) {
      return c.json({ success: false, error: `invalid source: ${source}` }, 400);
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) {
      conditions.push('c.status = ?');
      values.push(status);
    }
    if (source) {
      conditions.push('c.source = ?');
      values.push(source);
    }
    if (friendId) {
      conditions.push('c.friend_id = ?');
      values.push(friendId);
    }
    if (since) {
      conditions.push('c.issued_at >= ?');
      values.push(since);
    }
    if (until) {
      conditions.push('c.issued_at < ?');
      values.push(until);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rowsResult, countResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT c.id, c.friend_id, f.display_name, c.line_account_id, c.coupon_code,
                c.shopify_discount_code_id, c.discount_value, c.discount_currency,
                c.issued_at, c.expires_at, c.status, c.source
         FROM line_friend_coupons c
         LEFT JOIN friends f ON c.friend_id = f.id
         ${where}
         ORDER BY c.issued_at DESC
         LIMIT ? OFFSET ?`,
      )
        .bind(...values, limit, offset)
        .all<CouponRow>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM line_friend_coupons c ${where}`,
      )
        .bind(...values)
        .first<CountRow>(),
    ]);

    const logs = rowsResult.results ?? [];
    const total = countResult?.n ?? 0;
    const hasMore = logs.length > 0 && offset + logs.length < total;

    return c.json({
      success: true,
      data: {
        coupons: logs,
        total,
        limit,
        offset,
        hasMore,
      },
    });
  } catch (err) {
    console.error('GET /api/line-friend-coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/line-friend-coupons/stats — 第2波-⑤ (2026-07-01)
 *
 * welcome クーポンの「発行 → 使用」転換率を 1 query で返す admin 閲覧 API。
 * 「友だち追加 → welcome クーポン → 実購入」 の ROI を初めて数値化する。
 * 任意で since/until (issued_at) と lineAccountId で絞り込み可能。
 */
lineFriendCoupons.get('/api/line-friend-coupons/stats', async (c) => {
  try {
    const since = c.req.query('since') ?? undefined;
    const until = c.req.query('until') ?? undefined;
    const lineAccountId = c.req.query('lineAccountId') ?? undefined;

    const stats = await getCouponRedemptionStats(c.env.DB, { since, until, lineAccountId });

    return c.json({ success: true, data: stats });
  } catch (err) {
    console.error('GET /api/line-friend-coupons/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { lineFriendCoupons };
