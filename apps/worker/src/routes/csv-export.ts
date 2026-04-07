import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const csvExport = new Hono<Env>();

// ─── CSV Helpers ───
function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

function csvResponse(c: { header: (k: string, v: string) => void; body: (b: string) => Response }, filename: string, csv: string): Response {
  return new Response('\uFEFF' + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

/**
 * GET /api/export/friends — 友だち一覧CSV
 */
csvExport.get('/api/export/friends', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT f.id, f.line_user_id, f.display_name, f.is_following, f.created_at,
                GROUP_CONCAT(t.name, ';') as tags
         FROM friends f
         LEFT JOIN friend_tags ft ON ft.friend_id = f.id
         LEFT JOIN tags t ON t.id = ft.tag_id
         GROUP BY f.id
         ORDER BY f.created_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'line_user_id', 'display_name', 'is_following', 'tags', 'created_at'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `friends_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/orders — 購入履歴CSV
 */
csvExport.get('/api/export/orders', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT so.id, so.order_number, so.total_price, so.financial_status, so.fulfillment_status,
                so.line_items, so.created_at, f.display_name, f.line_user_id
         FROM shopify_orders so
         LEFT JOIN friends f ON f.id = so.friend_id
         ORDER BY so.created_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'order_number', 'display_name', 'total_price', 'financial_status', 'fulfillment_status', 'created_at'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `orders_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/orders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/coupons — クーポン利用CSV
 */
csvExport.get('/api/export/coupons', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT a.id, c.code, c.title, c.discount_type, c.discount_value,
                a.assigned_at, a.used_at, f.display_name
         FROM shopify_coupon_assignments a
         JOIN shopify_coupons c ON c.id = a.coupon_id
         LEFT JOIN friends f ON f.id = a.friend_id
         ORDER BY a.assigned_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'code', 'title', 'discount_type', 'discount_value', 'display_name', 'assigned_at', 'used_at'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `coupons_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/intake — 服用記録CSV
 */
csvExport.get('/api/export/intake', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT il.id, il.product_name, il.streak_count, il.logged_at, il.note,
                f.display_name
         FROM intake_logs il
         LEFT JOIN friends f ON f.id = il.friend_id
         ORDER BY il.logged_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'display_name', 'product_name', 'streak_count', 'note', 'logged_at'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `intake_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/intake error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/health — 体調記録CSV
 */
csvExport.get('/api/export/health', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT hl.id, hl.log_date, hl.weight, hl.condition, hl.skin_condition,
                hl.sleep_hours, hl.note, f.display_name
         FROM health_logs hl
         LEFT JOIN friends f ON f.id = hl.friend_id
         ORDER BY hl.log_date DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'display_name', 'log_date', 'weight', 'condition', 'skin_condition', 'sleep_hours', 'note'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `health_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/health error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/referrals — 紹介実績CSV
 */
csvExport.get('/api/export/referrals', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT rr.id, rr.status, rr.created_at,
                f1.display_name as referrer_name,
                f2.display_name as referred_name
         FROM referral_rewards rr
         LEFT JOIN friends f1 ON f1.id = rr.referrer_friend_id
         LEFT JOIN friends f2 ON f2.id = rr.referred_friend_id
         ORDER BY rr.created_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'referrer_name', 'referred_name', 'status', 'created_at'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `referrals_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/referrals error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/ambassadors — アンバサダーCSV
 */
csvExport.get('/api/export/ambassadors', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT a.id, a.status, a.tier, a.enrolled_at, a.total_surveys_completed,
                a.total_product_tests, a.feedback_score, a.preferences,
                f.display_name
         FROM ambassadors a
         LEFT JOIN friends f ON f.id = a.friend_id
         ORDER BY a.created_at DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'display_name', 'status', 'tier', 'enrolled_at', 'total_surveys_completed', 'total_product_tests', 'feedback_score'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `ambassadors_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/ambassadors error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/export/ranks — ランク別CSV
 */
csvExport.get('/api/export/ranks', async (c) => {
  try {
    const { results } = await c.env.DB
      .prepare(
        `SELECT fr.id, fr.total_spent, fr.orders_count, fr.rank_period_start,
                mr.name as rank_name, f.display_name, f.line_user_id
         FROM friend_ranks fr
         JOIN friends f ON f.id = fr.friend_id
         LEFT JOIN member_ranks mr ON mr.id = fr.rank_id
         ORDER BY fr.total_spent DESC
         LIMIT 10000`,
      )
      .all();

    const csv = toCsv(
      ['id', 'display_name', 'rank_name', 'total_spent', 'orders_count'],
      results as Array<Record<string, unknown>>,
    );

    return csvResponse(c as never, `ranks_${jstNow().slice(0, 10)}.csv`, csv);
  } catch (err) {
    console.error('GET /api/export/ranks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { csvExport };
