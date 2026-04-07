import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import type { Env } from '../index.js';

const dashboard = new Hono<Env>();

/**
 * GET /api/dashboard/summary — 全体サマリー（カード用）
 */
dashboard.get('/api/dashboard/summary', async (c) => {
  try {
    const [friendsRow, ordersRow, intakeRow, referralRow] = await Promise.all([
      c.env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN is_following = 1 THEN 1 ELSE 0 END) as following,
           SUM(CASE WHEN created_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as new_7d
         FROM friends`,
      ).first<{ total: number; following: number; new_7d: number }>(),

      c.env.DB.prepare(
        `SELECT
           COUNT(*) as total_orders,
           COALESCE(SUM(total_price), 0) as total_revenue,
           COUNT(CASE WHEN created_at >= date('now', '-30 days') THEN 1 END) as orders_30d,
           COALESCE(SUM(CASE WHEN created_at >= date('now', '-30 days') THEN total_price ELSE 0 END), 0) as revenue_30d
         FROM shopify_orders`,
      ).first<{ total_orders: number; total_revenue: number; orders_30d: number; revenue_30d: number }>(),

      c.env.DB.prepare(
        `SELECT
           COUNT(DISTINCT friend_id) as active_users,
           COUNT(*) as total_logs,
           COUNT(CASE WHEN logged_at >= date('now', '-7 days') THEN 1 END) as logs_7d
         FROM intake_logs`,
      ).first<{ active_users: number; total_logs: number; logs_7d: number }>(),

      c.env.DB.prepare(
        `SELECT COUNT(*) as total FROM referral_rewards`,
      ).first<{ total: number }>(),
    ]);

    return c.json({
      success: true,
      data: {
        friends: {
          total: friendsRow?.total ?? 0,
          following: friendsRow?.following ?? 0,
          newLast7Days: friendsRow?.new_7d ?? 0,
        },
        orders: {
          totalOrders: ordersRow?.total_orders ?? 0,
          totalRevenue: ordersRow?.total_revenue ?? 0,
          ordersLast30Days: ordersRow?.orders_30d ?? 0,
          revenueLast30Days: ordersRow?.revenue_30d ?? 0,
        },
        intake: {
          activeUsers: intakeRow?.active_users ?? 0,
          totalLogs: intakeRow?.total_logs ?? 0,
          logsLast7Days: intakeRow?.logs_7d ?? 0,
        },
        referrals: {
          total: referralRow?.total ?? 0,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/dashboard/summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/friends-trend — 友だち増減推移（日別・最大90日）
 */
dashboard.get('/api/dashboard/friends-trend', async (c) => {
  try {
    const days = Math.min(Math.max(7, Number(c.req.query('days')) || 30), 90);

    const { results } = await c.env.DB.prepare(
      `SELECT
         date(created_at) as date,
         COUNT(*) as new_friends
       FROM friends
       WHERE created_at >= date('now', '-' || ? || ' days')
       GROUP BY date(created_at)
       ORDER BY date ASC`,
    ).bind(days).all();

    // Also get unfollows by day
    const { results: unfollows } = await c.env.DB.prepare(
      `SELECT
         date(updated_at) as date,
         COUNT(*) as unfollowed
       FROM friends
       WHERE is_following = 0
         AND updated_at >= date('now', '-' || ? || ' days')
       GROUP BY date(updated_at)
       ORDER BY date ASC`,
    ).bind(days).all();

    // Merge into a single series
    const dateMap = new Map<string, { new_friends: number; unfollowed: number }>();
    for (const r of results as Array<{ date: string; new_friends: number }>) {
      dateMap.set(r.date, { new_friends: r.new_friends, unfollowed: 0 });
    }
    for (const r of unfollows as Array<{ date: string; unfollowed: number }>) {
      const existing = dateMap.get(r.date);
      if (existing) {
        existing.unfollowed = r.unfollowed;
      } else {
        dateMap.set(r.date, { new_friends: 0, unfollowed: r.unfollowed });
      }
    }

    const trend = Array.from(dateMap.entries())
      .map(([date, data]) => ({ date, ...data, net: data.new_friends - data.unfollowed }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return c.json({ success: true, data: { days, trend } });
  } catch (err) {
    console.error('GET /api/dashboard/friends-trend error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/revenue-trend — 売上推移（日別・最大90日）
 */
dashboard.get('/api/dashboard/revenue-trend', async (c) => {
  try {
    const days = Math.min(Math.max(7, Number(c.req.query('days')) || 30), 90);

    const { results } = await c.env.DB.prepare(
      `SELECT
         date(created_at) as date,
         COUNT(*) as orders,
         COALESCE(SUM(total_price), 0) as revenue
       FROM shopify_orders
       WHERE created_at >= date('now', '-' || ? || ' days')
       GROUP BY date(created_at)
       ORDER BY date ASC`,
    ).bind(days).all();

    return c.json({
      success: true,
      data: {
        days,
        trend: results as Array<{ date: string; orders: number; revenue: number }>,
      },
    });
  } catch (err) {
    console.error('GET /api/dashboard/revenue-trend error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/rank-distribution — ランク分布
 */
dashboard.get('/api/dashboard/rank-distribution', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT mr.name, mr.color, COUNT(fr.id) as count
       FROM member_ranks mr
       LEFT JOIN friend_ranks fr ON fr.rank_id = mr.id
       GROUP BY mr.id
       ORDER BY mr.sort_order ASC`,
    ).all();

    return c.json({
      success: true,
      data: { distribution: results },
    });
  } catch (err) {
    console.error('GET /api/dashboard/rank-distribution error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/intake-rate — 服用率推移（日別）
 * 各日の (服用記録数 / フォロー中ユーザー数) × 100
 */
dashboard.get('/api/dashboard/intake-rate', async (c) => {
  try {
    const days = Math.min(Math.max(7, Number(c.req.query('days')) || 30), 90);

    const followingRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM friends WHERE is_following = 1`,
    ).first<{ cnt: number }>();
    const totalFollowing = followingRow?.cnt ?? 1;

    const { results } = await c.env.DB.prepare(
      `SELECT
         date(logged_at) as date,
         COUNT(DISTINCT friend_id) as users_logged
       FROM intake_logs
       WHERE logged_at >= date('now', '-' || ? || ' days')
       GROUP BY date(logged_at)
       ORDER BY date ASC`,
    ).bind(days).all();

    const trend = (results as Array<{ date: string; users_logged: number }>).map((r) => ({
      date: r.date,
      usersLogged: r.users_logged,
      rate: Math.round((r.users_logged / totalFollowing) * 1000) / 10,
    }));

    return c.json({ success: true, data: { days, totalFollowing, trend } });
  } catch (err) {
    console.error('GET /api/dashboard/intake-rate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/health-score — 体調スコア推移（日別平均）
 * condition: good=3, normal=2, bad=1
 */
dashboard.get('/api/dashboard/health-score', async (c) => {
  try {
    const days = Math.min(Math.max(7, Number(c.req.query('days')) || 30), 90);

    const { results } = await c.env.DB.prepare(
      `SELECT
         date(logged_at) as date,
         COUNT(*) as entries,
         AVG(CASE condition
           WHEN 'good' THEN 3
           WHEN 'normal' THEN 2
           WHEN 'bad' THEN 1
           ELSE 2
         END) as avg_score,
         SUM(CASE WHEN condition = 'good' THEN 1 ELSE 0 END) as good_count,
         SUM(CASE WHEN condition = 'normal' THEN 1 ELSE 0 END) as normal_count,
         SUM(CASE WHEN condition = 'bad' THEN 1 ELSE 0 END) as bad_count
       FROM health_logs
       WHERE logged_at >= date('now', '-' || ? || ' days')
       GROUP BY date(logged_at)
       ORDER BY date ASC`,
    ).bind(days).all();

    const trend = (results as Array<{
      date: string; entries: number; avg_score: number;
      good_count: number; normal_count: number; bad_count: number;
    }>).map((r) => ({
      date: r.date,
      entries: r.entries,
      avgScore: Math.round(r.avg_score * 10) / 10,
      good: r.good_count,
      normal: r.normal_count,
      bad: r.bad_count,
    }));

    return c.json({ success: true, data: { days, trend } });
  } catch (err) {
    console.error('GET /api/dashboard/health-score error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/dashboard/referral-funnel — 紹介コンバージョン漏斗
 * 紹介リンク発行 → 友だち追加 → 購入 の3段階
 */
dashboard.get('/api/dashboard/referral-funnel', async (c) => {
  try {
    const [linksRow, addedRow, purchasedRow] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(DISTINCT friend_id) as cnt FROM friends WHERE referral_code IS NOT NULL`,
      ).first<{ cnt: number }>(),

      c.env.DB.prepare(
        `SELECT COUNT(*) as cnt FROM referral_rewards`,
      ).first<{ cnt: number }>(),

      c.env.DB.prepare(
        `SELECT COUNT(DISTINCT rr.referred_friend_id) as cnt
         FROM referral_rewards rr
         INNER JOIN shopify_orders so ON so.friend_id = rr.referred_friend_id`,
      ).first<{ cnt: number }>(),
    ]);

    const referrersWithLink = linksRow?.cnt ?? 0;
    const friendsAdded = addedRow?.cnt ?? 0;
    const friendsPurchased = purchasedRow?.cnt ?? 0;

    return c.json({
      success: true,
      data: {
        funnel: [
          { stage: 'referral_link', label: '紹介リンク発行', count: referrersWithLink },
          { stage: 'friend_added', label: '友だち追加', count: friendsAdded },
          { stage: 'purchased', label: '購入完了', count: friendsPurchased },
        ],
        conversionRates: {
          linkToAdd: referrersWithLink > 0 ? Math.round((friendsAdded / referrersWithLink) * 1000) / 10 : 0,
          addToPurchase: friendsAdded > 0 ? Math.round((friendsPurchased / friendsAdded) * 1000) / 10 : 0,
          overall: referrersWithLink > 0 ? Math.round((friendsPurchased / referrersWithLink) * 1000) / 10 : 0,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/dashboard/referral-funnel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { dashboard };
