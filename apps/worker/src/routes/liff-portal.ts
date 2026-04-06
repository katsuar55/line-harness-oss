import { Hono } from 'hono';
import {
  getFriendRank,
  getMemberRanks,
  getCouponAssignmentsByFriend,
  getShopifyOrders,
  getShopifyProducts,
  createIntakeLog,
  getIntakeLogs,
  getIntakeStreak,
  upsertIntakeReminder,
  createReferralLink,
  getReferralLink,
  getReferralLinkByRefCode,
  getReferralStats,
  createReferralReward,
  createRecommendationResult,
  upsertHealthLog,
  getHealthLogs,
  getHealthTrends,
  getHealthSummary,
  enrollAmbassador,
  getAmbassador,
  getTodayTip,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const liffPortal = new Hono<Env>();

// ─── Validation helpers ───
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAYS = 365;
const MAX_NOTE_LENGTH = 500;

function clampDays(days: unknown): number {
  const n = typeof days === 'number' ? days : 30;
  return Math.min(Math.max(1, n), MAX_DAYS);
}

function validateNote(note: unknown): string | undefined {
  if (typeof note !== 'string') return undefined;
  return note.slice(0, MAX_NOTE_LENGTH);
}

// ─── Helper: get verified friend from liffUser middleware ───
function getLiffUser(c: { get: (key: string) => unknown }) {
  return c.get('liffUser') as { lineUserId: string; friendId: string } | undefined;
}

// ═══════════════════════════════════════════════
// 第1段階: ランク・クーポン・再購入（既存データ活用）
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/rank — ランク＋進捗バー＋特典
 */
liffPortal.post('/api/liff/rank', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const friendRank = await getFriendRank(c.env.DB, user.friendId);
    const allRanks = await getMemberRanks(c.env.DB);

    if (!friendRank) {
      return c.json({
        success: true,
        data: {
          currentRank: null,
          totalSpent: 0,
          ordersCount: 0,
          nextRank: allRanks[0] ?? null,
          progressPercent: 0,
          benefits: null,
          allRanks: allRanks.map((r) => ({
            name: r.name,
            color: r.color,
            icon: r.icon,
            minTotalSpent: r.min_total_spent,
          })),
        },
      });
    }

    const currentRankDetail = allRanks.find(
      (r) => r.id === (friendRank as Record<string, unknown>).rank_id,
    );
    const currentIdx = allRanks.findIndex(
      (r) => r.id === (friendRank as Record<string, unknown>).rank_id,
    );
    const nextRank = currentIdx < allRanks.length - 1 ? allRanks[currentIdx + 1] : null;

    const totalSpent = (friendRank as Record<string, unknown>).total_spent as number ?? 0;
    let progressPercent = 100;
    if (nextRank) {
      const currentMin = currentRankDetail?.min_total_spent ?? 0;
      const nextMin = nextRank.min_total_spent ?? 0;
      const range = nextMin - currentMin;
      progressPercent = range > 0 ? Math.min(100, Math.round(((totalSpent - currentMin) / range) * 100)) : 100;
    }

    return c.json({
      success: true,
      data: {
        currentRank: currentRankDetail
          ? {
              name: currentRankDetail.name,
              color: currentRankDetail.color,
              icon: currentRankDetail.icon,
              benefits: currentRankDetail.benefits_json
                ? JSON.parse(currentRankDetail.benefits_json as string)
                : null,
            }
          : null,
        totalSpent,
        ordersCount: (friendRank as Record<string, unknown>).orders_count ?? 0,
        nextRank: nextRank
          ? {
              name: nextRank.name,
              color: nextRank.color,
              minTotalSpent: nextRank.min_total_spent,
              remaining: Math.max(0, (nextRank.min_total_spent ?? 0) - totalSpent),
            }
          : null,
        progressPercent,
        allRanks: allRanks.map((r) => ({
          name: r.name,
          color: r.color,
          icon: r.icon,
          minTotalSpent: r.min_total_spent,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/rank error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/coupons — 未使用クーポン一覧
 */
liffPortal.post('/api/liff/coupons', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const assignments = await getCouponAssignmentsByFriend(c.env.DB, user.friendId, true);

    return c.json({
      success: true,
      data: {
        coupons: assignments.map((a: Record<string, unknown>) => ({
          id: a.coupon_id,
          code: a.code,
          title: a.title,
          description: a.description,
          discountType: a.discount_type,
          discountValue: a.discount_value,
          minimumOrderAmount: a.minimum_order_amount,
          expiresAt: a.expires_at,
          assignedAt: a.assigned_at,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/coupons error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/reorder — 再購入用: 直近の注文情報+商品一覧
 */
liffPortal.post('/api/liff/reorder', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const recentOrders = await getShopifyOrders(c.env.DB, { friendId: user.friendId, limit: 3 });
    const { products } = await getShopifyProducts(c.env.DB, { status: 'active', limit: 10 });
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN || 'naturism-diet.com';

    return c.json({
      success: true,
      data: {
        recentOrders: recentOrders.map((o: Record<string, unknown>) => ({
          id: o.id,
          orderNumber: o.order_number,
          totalPrice: o.total_price,
          lineItems: o.line_items ? JSON.parse(o.line_items as string) : [],
          createdAt: o.created_at,
          fulfillmentStatus: o.fulfillment_status,
        })),
        products: products.map((p: Record<string, unknown>) => ({
          id: p.id,
          shopifyProductId: p.shopify_product_id,
          title: p.title,
          price: p.price,
          compareAtPrice: p.compare_at_price,
          imageUrl: p.image_url,
          handle: p.handle,
          storeUrl: `https://${storeDomain}/products/${p.handle}`,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/reorder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/fulfillments — 配送状況確認
 */
liffPortal.post('/api/liff/fulfillments', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { results } = await c.env.DB
      .prepare(
        `SELECT sf.*, so.order_number
         FROM shopify_fulfillments sf
         JOIN shopify_orders so ON so.shopify_order_id = sf.shopify_order_id
         WHERE sf.friend_id = ?
         ORDER BY sf.created_at DESC LIMIT 10`,
      )
      .bind(user.friendId)
      .all();

    return c.json({
      success: true,
      data: {
        fulfillments: (results ?? []).map((f: Record<string, unknown>) => ({
          id: f.id,
          orderNumber: f.order_number,
          trackingNumber: f.tracking_number,
          trackingUrl: f.tracking_url,
          trackingCompany: f.tracking_company,
          status: f.status,
          lineItems: f.line_items ? JSON.parse(f.line_items as string) : [],
          createdAt: f.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/fulfillments error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// 第3段階: 服用記録 + 体調記録
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/intake — 服用ログ記録
 */
liffPortal.post('/api/liff/intake', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { productName, shopifyProductId, note } =
      await c.req.json<{
        productName?: string;
        shopifyProductId?: string;
        note?: string;
      }>();

    const result = await createIntakeLog(c.env.DB, {
      friendId: user.friendId,
      productName,
      shopifyProductId,
      note: validateNote(note),
    });

    return c.json({
      success: true,
      data: {
        id: result.id,
        streakCount: result.streak_count,
        loggedAt: result.logged_at,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/intake error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/intake/streak — streak情報+履歴
 */
liffPortal.post('/api/liff/intake/streak', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { days } = await c.req.json<{ days?: number }>();
    const safeDays = clampDays(days);

    const streak = await getIntakeStreak(c.env.DB, user.friendId);
    const logs = await getIntakeLogs(c.env.DB, user.friendId, safeDays);

    return c.json({
      success: true,
      data: {
        ...streak,
        recentLogs: logs.map((l) => ({
          id: l.id,
          productName: l.product_name,
          streakCount: l.streak_count,
          loggedAt: l.logged_at,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/intake/streak error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/intake/reminder — リマインダー設定
 */
liffPortal.post('/api/liff/intake/reminder', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { reminderTime, timezone, isActive } =
      await c.req.json<{
        reminderTime?: string;
        timezone?: string;
        isActive?: boolean;
      }>();

    // Validate reminderTime format (HH:MM)
    if (reminderTime && !TIME_RE.test(reminderTime)) {
      return c.json({ success: false, error: 'Invalid reminderTime format. Use HH:MM (00:00-23:59)' }, 400);
    }

    const result = await upsertIntakeReminder(c.env.DB, {
      friendId: user.friendId,
      reminderTime,
      timezone,
      isActive,
    });

    return c.json({
      success: true,
      data: {
        reminderTime: result.reminder_time,
        isActive: Boolean(result.is_active),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/intake/reminder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// 体調記録
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/health/log — 体調記録
 */
liffPortal.post('/api/liff/health/log', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { logDate, weight, condition, skinCondition, meals, sleepHours, note } =
      await c.req.json<{
        logDate?: string;
        weight?: number;
        condition?: string;
        skinCondition?: string;
        meals?: Record<string, string>;
        sleepHours?: number;
        note?: string;
      }>();

    // Validate logDate format
    const today = jstNow().slice(0, 10);
    let safeLogDate = today;
    if (logDate) {
      if (!DATE_RE.test(logDate)) {
        return c.json({ success: false, error: 'Invalid logDate format. Use YYYY-MM-DD' }, 400);
      }
      // Only allow dates within last 7 days to today
      const logDateMs = new Date(logDate + 'T00:00:00+09:00').getTime();
      const todayMs = new Date(today + 'T00:00:00+09:00').getTime();
      const sevenDaysAgo = todayMs - 7 * 86400000;
      if (logDateMs > todayMs || logDateMs < sevenDaysAgo) {
        return c.json({ success: false, error: 'logDate must be within the last 7 days' }, 400);
      }
      safeLogDate = logDate;
    }

    const result = await upsertHealthLog(c.env.DB, {
      friendId: user.friendId,
      logDate: safeLogDate,
      weight,
      condition,
      skinCondition,
      meals,
      sleepHours,
      note: validateNote(note),
    });

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/liff/health/log error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/health/logs — 期間指定で記録一覧
 */
liffPortal.post('/api/liff/health/logs', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { days } = await c.req.json<{ days?: number }>();
    const safeDays = clampDays(days);

    const logs = await getHealthLogs(c.env.DB, user.friendId, safeDays);

    return c.json({
      success: true,
      data: {
        logs: logs.map((l) => ({
          ...l,
          meals: l.meals ? JSON.parse(l.meals) : null,
        })),
      },
    });
  } catch (err) {
    console.error('POST /api/liff/health/logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/health/trends — グラフ用推移データ
 */
liffPortal.post('/api/liff/health/trends', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { days } = await c.req.json<{ days?: number }>();
    const safeDays = clampDays(days);

    const trends = await getHealthTrends(c.env.DB, user.friendId, safeDays);

    return c.json({ success: true, data: { trends } });
  } catch (err) {
    console.error('POST /api/liff/health/trends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/health/summary — 直近7日サマリー
 */
liffPortal.post('/api/liff/health/summary', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const summary = await getHealthSummary(c.env.DB, user.friendId);

    return c.json({ success: true, data: summary });
  } catch (err) {
    console.error('POST /api/liff/health/summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// 診断クイズ
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/quiz/submit — 診断クイズ結果保存
 */
liffPortal.post('/api/liff/quiz/submit', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { answers } =
      await c.req.json<{ answers: Record<string, string> }>();

    if (!answers || typeof answers !== 'object') {
      return c.json({ success: false, error: 'answers is required' }, 400);
    }

    // Validate answer keys count (max 20 to prevent abuse)
    if (Object.keys(answers).length > 20) {
      return c.json({ success: false, error: 'Too many answer keys' }, 400);
    }

    const { scoreQuiz, NATURISM_QUIZ_CONFIG } = await import('../services/quiz-engine.js');
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, answers);

    await createRecommendationResult(c.env.DB, {
      friendId: user.friendId,
      quizAnswers: answers,
      recommendedProduct: result.recommendedProduct,
      scoreBreakdown: result.scores,
    });

    return c.json({
      success: true,
      data: {
        recommendedProduct: result.recommendedProduct,
        reason: result.reason,
        scores: result.scores,
        productInfo: result.productInfo,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/quiz/submit error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// 友だち紹介
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/referral/generate — 紹介リンク生成
 */
liffPortal.post('/api/liff/referral/generate', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const existing = await getReferralLink(c.env.DB, user.friendId);
    if (existing) {
      const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
      return c.json({
        success: true,
        data: {
          refCode: existing.ref_code,
          url: `${workerUrl}/r/${existing.ref_code}`,
          isNew: false,
        },
      });
    }

    // Generate unique 8-char hex code (32 bits entropy)
    const refCode = `ref-${Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

    const link = await createReferralLink(c.env.DB, {
      friendId: user.friendId,
      refCode,
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;

    return c.json({
      success: true,
      data: {
        refCode: link.ref_code,
        url: `${workerUrl}/r/${link.ref_code}`,
        isNew: true,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/referral/generate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/referral/stats — 紹介実績
 */
liffPortal.post('/api/liff/referral/stats', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const stats = await getReferralStats(c.env.DB, user.friendId);
    const link = await getReferralLink(c.env.DB, user.friendId);

    return c.json({
      success: true,
      data: {
        ...stats,
        refCode: link?.ref_code ?? null,
        hasLink: !!link,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/referral/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/referral/claim — 紹介成立処理
 *
 * LIFF起動時に ?ref=xxx パラメータがあれば呼び出される。
 * - 紹介リンク(refCode)から紹介者(referrer)を特定
 * - 自分自身を紹介できない
 * - 同じペアの重複記録を防止
 * - referral_rewards に記録
 */
liffPortal.post('/api/liff/referral/claim', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { refCode } = await c.req.json<{ refCode: string }>();
    if (!refCode || typeof refCode !== 'string') {
      return c.json({ success: false, error: 'refCode is required' }, 400);
    }

    // 紹介リンクを取得
    const link = await getReferralLinkByRefCode(c.env.DB, refCode);
    if (!link) {
      return c.json({ success: false, error: 'Invalid or inactive referral code' }, 400);
    }

    // 自己紹介防止
    if (link.friend_id === user.friendId) {
      return c.json({ success: false, error: 'Cannot refer yourself' }, 400);
    }

    // 重複チェック
    const existing = await c.env.DB
      .prepare(
        'SELECT id FROM referral_rewards WHERE referrer_friend_id = ? AND referred_friend_id = ?',
      )
      .bind(link.friend_id, user.friendId)
      .first<{ id: string }>();

    if (existing) {
      return c.json({
        success: true,
        data: { alreadyClaimed: true, rewardId: existing.id },
      });
    }

    // 紹介成立記録
    const reward = await createReferralReward(c.env.DB, {
      referrerFriendId: link.friend_id,
      referredFriendId: user.friendId,
      referrerCouponId: link.referrer_coupon_id ?? undefined,
      referredCouponId: link.referred_coupon_id ?? undefined,
    });

    return c.json({
      success: true,
      data: {
        alreadyClaimed: false,
        rewardId: reward.id,
        status: reward.status,
      },
    });
  } catch (err) {
    console.error('POST /api/liff/referral/claim error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// アンバサダー
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/ambassador/enroll — アンバサダー登録
 */
liffPortal.post('/api/liff/ambassador/enroll', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { preferences } =
      await c.req.json<{
        preferences?: { survey_ok?: boolean; product_test_ok?: boolean; sns_share_ok?: boolean };
      }>();

    const result = await enrollAmbassador(c.env.DB, user.friendId, preferences);

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/liff/ambassador/enroll error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/ambassador/status — アンバサダーステータス
 */
liffPortal.post('/api/liff/ambassador/status', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const ambassador = await getAmbassador(c.env.DB, user.friendId);

    return c.json({
      success: true,
      data: ambassador
        ? {
            status: ambassador.status,
            tier: ambassador.tier,
            enrolledAt: ambassador.enrolled_at,
            surveysCompleted: ambassador.total_surveys_completed,
            productTests: ambassador.total_product_tests,
            preferences: JSON.parse(ambassador.preferences),
          }
        : null,
    });
  } catch (err) {
    console.error('POST /api/liff/ambassador/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// 日替わりTips
// ═══════════════════════════════════════════════

/**
 * GET /api/liff/tips/today — 今日のTip（認証不要）
 */
liffPortal.get('/api/liff/tips/today', async (c) => {
  try {
    const tip = await getTodayTip(c.env.DB);

    if (!tip) {
      return c.json({
        success: true,
        data: null,
        message: '今日のTipはまだ登録されていません',
      });
    }

    return c.json({ success: true, data: tip });
  } catch (err) {
    console.error('GET /api/liff/tips/today error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { liffPortal };
