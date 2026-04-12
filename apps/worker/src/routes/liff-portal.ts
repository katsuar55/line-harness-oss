import { Hono } from 'hono';
import { getShopifyAccessToken } from '../services/shopify-token.js';
import {
  getFriendRank,
  getMemberRanks,
  getCouponAssignmentsByFriend,
  getShopifyOrders,
  getShopifyProducts,
  getShopifyOrderById,
  createIntakeLog,
  getIntakeLogs,
  getIntakeStreak,
  upsertIntakeReminder,
  addIntakeReminder,
  updateIntakeReminder,
  deleteIntakeReminder,
  getIntakeReminders,
  getIntakeReminder,
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
  submitAmbassadorFeedback,
  getAmbassadorFeedbacks,
  getPendingSurveys,
  getSurveyById,
  submitSurveyResponse,
  getTodayTip,
  getFriendLanguage,
  setFriendLanguage,
  getTipTranslation,
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
 * POST /api/liff/reorder/create — Draft Order作成（ワンクリック再購入）
 *
 * body: { orderId?: string, items?: Array<{ variantId: string, quantity: number }> }
 *   - orderId: 過去の注文IDから全品目を再注文
 *   - items: 個別商品を指定して再注文
 *
 * Shopify Draft Orders API でチェックアウトURLを生成し返却
 */
liffPortal.post('/api/liff/reorder/create', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    // Rate limit: 同一ユーザー5分以内の連続作成を防止
    const recentDraft = await c.env.DB
      .prepare(
        `SELECT created_at FROM shopify_draft_orders
         WHERE friend_id = ? AND created_at > datetime('now', '-5 minutes')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(user.friendId)
      .first<{ created_at: string }>();

    if (recentDraft) {
      return c.json({ success: false, error: '再注文は5分に1回までです。しばらくお待ちください。' }, 429);
    }

    const { orderId, items } = await c.req.json<{
      orderId?: string;
      items?: Array<{ variantId: string; quantity: number }>;
    }>();

    // Build line items for draft order
    let lineItems: Array<{ variantId: string; quantity: number }> = [];

    if (orderId) {
      // Reorder from past order
      const order = await getShopifyOrderById(c.env.DB, orderId);
      if (!order) return c.json({ success: false, error: 'Order not found' }, 404);

      const parsed = order.line_items ? JSON.parse(order.line_items as string) : [];
      lineItems = parsed
        .filter((li: Record<string, unknown>) => li.variant_id)
        .map((li: Record<string, unknown>) => ({
          variantId: `gid://shopify/ProductVariant/${li.variant_id}`,
          quantity: Number(li.quantity) || 1,
        }));
    } else if (items && items.length > 0) {
      lineItems = items.map((item) => ({
        variantId: item.variantId.startsWith('gid://')
          ? item.variantId
          : `gid://shopify/ProductVariant/${item.variantId}`,
        quantity: Math.max(1, Math.min(99, item.quantity)),
      }));
    }

    if (lineItems.length === 0) {
      return c.json({ success: false, error: 'No items to reorder' }, 400);
    }

    // Get Shopify access token
    const accessToken = await getShopifyAccessToken(c.env.DB, c.env);
    const storeDomain = c.env.SHOPIFY_STORE_DOMAIN;
    if (!storeDomain) {
      return c.json({ success: false, error: 'Shopify not configured' }, 500);
    }

    // Look up customer email from friend's orders
    const recentOrders = await getShopifyOrders(c.env.DB, { friendId: user.friendId, limit: 1 });
    const customerEmail = recentOrders[0]?.email as string | undefined;

    // Create Draft Order via Shopify Admin REST API
    const draftOrderPayload: Record<string, unknown> = {
      draft_order: {
        line_items: lineItems.map((li) => ({
          variant_id: li.variantId.replace('gid://shopify/ProductVariant/', ''),
          quantity: li.quantity,
        })),
        use_customer_default_address: true,
        ...(customerEmail ? { email: customerEmail } : {}),
        tags: 'liff-reorder',
        note: 'LIFF再購入',
      },
    };

    // Idempotency key: ユーザーID + タイムスタンプ(分単位) で重複防止
    const idempotencyKey = `liff-reorder-${user.friendId}-${Math.floor(Date.now() / 60000)}`;

    const draftRes = await fetch(
      `https://${storeDomain}/admin/api/2026-04/draft_orders.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(draftOrderPayload),
      },
    );

    if (!draftRes.ok) {
      const errBody = await draftRes.text();
      console.error('Shopify Draft Order API error:', draftRes.status, errBody);
      return c.json({ success: false, error: 'Failed to create draft order' }, 502);
    }

    const draftData = await draftRes.json() as {
      draft_order: {
        id: number;
        invoice_url: string;
        status: string;
        total_price: string;
        currency: string;
        line_items: Array<Record<string, unknown>>;
      };
    };

    const draft = draftData.draft_order;

    // Save to D1
    const draftId = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO shopify_draft_orders
         (id, friend_id, shopify_draft_order_id, invoice_url, status, total_price, currency, line_items, source_order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        draftId,
        user.friendId,
        String(draft.id),
        draft.invoice_url,
        draft.status,
        Number(draft.total_price) || 0,
        draft.currency || 'JPY',
        JSON.stringify(draft.line_items),
        orderId ?? null,
        jstNow(),
        jstNow(),
      )
      .run();

    return c.json({
      success: true,
      data: {
        draftOrderId: draftId,
        shopifyDraftOrderId: String(draft.id),
        invoiceUrl: draft.invoice_url,
        totalPrice: Number(draft.total_price),
        currency: draft.currency || 'JPY',
      },
    });
  } catch (err) {
    console.error('POST /api/liff/reorder/create error:', err);
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

/**
 * GET /api/liff/intake/reminder — リマインダー設定取得
 */
liffPortal.get('/api/liff/intake/reminder', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const reminder = await getIntakeReminder(c.env.DB, user.friendId);

    return c.json({
      success: true,
      data: reminder
        ? { reminderTime: reminder.reminder_time, isActive: Boolean(reminder.is_active) }
        : null,
    });
  } catch (err) {
    console.error('GET /api/liff/intake/reminder error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── 複数リマインダー管理API ──

/**
 * GET /api/liff/intake/reminders — 全リマインダー一覧取得
 */
liffPortal.get('/api/liff/intake/reminders', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const reminders = await getIntakeReminders(c.env.DB, user.friendId);
    return c.json({
      success: true,
      data: reminders.map((r) => ({
        id: r.id,
        label: r.label,
        reminderTime: r.reminder_time,
        isActive: Boolean(r.is_active),
      })),
    });
  } catch (err) {
    console.error('GET /api/liff/intake/reminders error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/intake/reminders/add — リマインダー追加（最大5件）
 */
liffPortal.post('/api/liff/intake/reminders/add', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const { label, reminderTime } = await c.req.json<{ label?: string; reminderTime?: string }>();

    if (reminderTime && !TIME_RE.test(reminderTime)) {
      return c.json({ success: false, error: 'Invalid time format. Use HH:MM' }, 400);
    }

    const result = await addIntakeReminder(c.env.DB, {
      friendId: user.friendId,
      label,
      reminderTime,
    });

    return c.json({
      success: true,
      data: { id: result.id, label: result.label, reminderTime: result.reminder_time, isActive: Boolean(result.is_active) },
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'MAX_REMINDERS_REACHED') {
      return c.json({ success: false, error: 'リマインダーは最大5件までです' }, 400);
    }
    console.error('POST /api/liff/intake/reminders/add error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/liff/intake/reminders/:id — リマインダー更新
 */
liffPortal.put('/api/liff/intake/reminders/:id', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const reminderId = c.req.param('id');
    const { label, reminderTime, isActive } = await c.req.json<{ label?: string; reminderTime?: string; isActive?: boolean }>();

    if (reminderTime && !TIME_RE.test(reminderTime)) {
      return c.json({ success: false, error: 'Invalid time format. Use HH:MM' }, 400);
    }

    const result = await updateIntakeReminder(c.env.DB, {
      id: reminderId,
      friendId: user.friendId,
      label,
      reminderTime,
      isActive,
    });

    return c.json({
      success: true,
      data: { id: result.id, label: result.label, reminderTime: result.reminder_time, isActive: Boolean(result.is_active) },
    });
  } catch (err) {
    console.error('PUT /api/liff/intake/reminders/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /api/liff/intake/reminders/:id — リマインダー削除
 */
liffPortal.delete('/api/liff/intake/reminders/:id', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const reminderId = c.req.param('id');
    await deleteIntakeReminder(c.env.DB, reminderId, user.friendId);
    return c.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/liff/intake/reminders/:id error:', err);
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

    const { logDate, weight, condition, skinCondition, meals, sleepHours, note, bowelForm, bowelCount, mood } =
      await c.req.json<{
        logDate?: string;
        weight?: number;
        condition?: string;
        skinCondition?: string;
        meals?: Record<string, string>;
        sleepHours?: number;
        note?: string;
        bowelForm?: string;
        bowelCount?: number;
        mood?: string;
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

    // Validate new fields
    const validBowelForms = ['hard', 'normal', 'soft'];
    const validMoods = ['great', 'good', 'normal', 'bad', 'terrible'];
    const safeBowelForm = bowelForm && validBowelForms.includes(bowelForm) ? bowelForm : undefined;
    const safeBowelCount = typeof bowelCount === 'number' && bowelCount >= 0 && bowelCount <= 10 ? bowelCount : undefined;
    const safeMood = mood && validMoods.includes(mood) ? mood : undefined;

    const result = await upsertHealthLog(c.env.DB, {
      friendId: user.friendId,
      logDate: safeLogDate,
      weight,
      condition,
      skinCondition,
      meals,
      sleepHours,
      note: validateNote(note),
      bowelForm: safeBowelForm,
      bowelCount: safeBowelCount,
      mood: safeMood,
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

    // 紹介クーポン定義を取得（LINE CRM内部クーポン）
    const referrerCoupon = await c.env.DB
      .prepare('SELECT id, code, discount_value, expires_days FROM referral_coupons WHERE id = ? AND is_active = 1')
      .bind('ref-coupon-referrer')
      .first<{ id: string; code: string; discount_value: number; expires_days: number }>();
    const referredCoupon = await c.env.DB
      .prepare('SELECT id, code, discount_value, expires_days FROM referral_coupons WHERE id = ? AND is_active = 1')
      .bind('ref-coupon-referred')
      .first<{ id: string; code: string; discount_value: number; expires_days: number }>();

    // 紹介成立記録
    const reward = await createReferralReward(c.env.DB, {
      referrerFriendId: link.friend_id,
      referredFriendId: user.friendId,
      referrerCouponId: referrerCoupon?.id,
      referredCouponId: referredCoupon?.id,
    });

    // クーポン自動発行（30日期限）
    const now = jstNow();
    const couponResults: { referrer?: string; referred?: string } = {};

    if (referrerCoupon) {
      const expiresAt = new Date(Date.now() + referrerCoupon.expires_days * 86400000).toISOString();
      const couponCode = `${referrerCoupon.code}-${reward.id.slice(0, 6).toUpperCase()}`;
      await c.env.DB
        .prepare(
          `INSERT INTO shopify_coupon_assignments (id, coupon_id, friend_id, assigned_at, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), referrerCoupon.id, link.friend_id, now,
          JSON.stringify({ type: 'referral_reward', code: couponCode, expires_at: expiresAt, reward_id: reward.id }), now)
        .run();
      couponResults.referrer = couponCode;
    }

    if (referredCoupon) {
      const expiresAt = new Date(Date.now() + referredCoupon.expires_days * 86400000).toISOString();
      const couponCode = `${referredCoupon.code}-${reward.id.slice(0, 6).toUpperCase()}`;
      await c.env.DB
        .prepare(
          `INSERT INTO shopify_coupon_assignments (id, coupon_id, friend_id, assigned_at, metadata, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), referredCoupon.id, user.friendId, now,
          JSON.stringify({ type: 'referral_reward', code: couponCode, expires_at: expiresAt, reward_id: reward.id }), now)
        .run();
      couponResults.referred = couponCode;
    }

    return c.json({
      success: true,
      data: {
        alreadyClaimed: false,
        rewardId: reward.id,
        status: reward.status,
        coupons: couponResults,
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

/**
 * POST /api/liff/ambassador/feedback — フィードバック送信
 */
liffPortal.post('/api/liff/ambassador/feedback', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const ambassador = await getAmbassador(c.env.DB, user.friendId);
    if (!ambassador || ambassador.status !== 'active') {
      return c.json({ success: false, error: 'Not an active ambassador' }, 403);
    }

    const body = await c.req.json<{
      type?: string;
      category?: string;
      content: string;
      rating?: number;
    }>();

    if (!body.content || body.content.trim().length === 0) {
      return c.json({ success: false, error: 'Content is required' }, 400);
    }
    if (body.content.length > 2000) {
      return c.json({ success: false, error: 'Content too long (max 2000 chars)' }, 400);
    }
    if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
      return c.json({ success: false, error: 'Rating must be 1-5' }, 400);
    }

    const validTypes = ['feedback', 'survey', 'product_review'];
    const validCategories = ['general', 'product', 'service', 'suggestion', 'other'];
    if (body.type && !validTypes.includes(body.type)) {
      return c.json({ success: false, error: 'Invalid type' }, 400);
    }
    if (body.category && !validCategories.includes(body.category)) {
      return c.json({ success: false, error: 'Invalid category' }, 400);
    }

    const result = await submitAmbassadorFeedback(c.env.DB, ambassador.id, user.friendId, {
      type: body.type,
      category: body.category,
      content: body.content.trim(),
      rating: body.rating,
    });

    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/liff/ambassador/feedback error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/ambassador/feedbacks — フィードバック履歴取得
 */
liffPortal.post('/api/liff/ambassador/feedbacks', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const ambassador = await getAmbassador(c.env.DB, user.friendId);
    if (!ambassador) {
      return c.json({ success: true, data: [] });
    }

    const feedbacks = await getAmbassadorFeedbacks(c.env.DB, ambassador.id);
    return c.json({ success: true, data: feedbacks });
  } catch (err) {
    console.error('POST /api/liff/ambassador/feedbacks error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ═══════════════════════════════════════════════
// アンバサダー: アンケート回答
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/ambassador/surveys — 未回答アンケート一覧取得
 */
liffPortal.post('/api/liff/ambassador/surveys', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const ambassador = await getAmbassador(c.env.DB, user.friendId);
    if (!ambassador || ambassador.status !== 'active') {
      return c.json({ success: true, data: [] });
    }

    const surveys = await getPendingSurveys(c.env.DB, ambassador.id);
    return c.json({
      success: true,
      data: surveys.map((s) => ({
        ...s,
        questions: JSON.parse(s.questions),
      })),
    });
  } catch (err) {
    console.error('POST /api/liff/ambassador/surveys error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/ambassador/survey/respond — アンケート回答送信
 */
liffPortal.post('/api/liff/ambassador/survey/respond', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const ambassador = await getAmbassador(c.env.DB, user.friendId);
    if (!ambassador || ambassador.status !== 'active') {
      return c.json({ success: false, error: 'Not an active ambassador' }, 403);
    }

    const body = await c.req.json<{ surveyId: string; answers: Record<string, unknown> }>();

    if (!body.surveyId || typeof body.surveyId !== 'string') {
      return c.json({ success: false, error: 'surveyId is required' }, 400);
    }
    if (!body.answers || typeof body.answers !== 'object') {
      return c.json({ success: false, error: 'answers is required as object' }, 400);
    }

    // Verify survey exists and is active
    const survey = await getSurveyById(c.env.DB, body.surveyId);
    if (!survey || survey.status !== 'active') {
      return c.json({ success: false, error: 'Survey not found or closed' }, 404);
    }

    const result = await submitSurveyResponse(
      c.env.DB,
      body.surveyId,
      ambassador.id,
      user.friendId,
      body.answers,
    );

    return c.json({ success: true, data: result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : '';
    if (errMsg.includes('UNIQUE constraint')) {
      return c.json({ success: false, error: 'Already responded to this survey' }, 409);
    }
    console.error('POST /api/liff/ambassador/survey/respond error:', err);
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

// ═══════════════════════════════════════════════
// 多言語 (i18n)
// ═══════════════════════════════════════════════

/**
 * POST /api/liff/language — 言語設定取得
 */
liffPortal.post('/api/liff/language', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const lang = await getFriendLanguage(c.env.DB, user.friendId);
    return c.json({ success: true, data: { lang } });
  } catch (err) {
    console.error('POST /api/liff/language error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/liff/language — 言語設定変更
 */
liffPortal.put('/api/liff/language', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const body = await c.req.json<{ lang: string }>();
    const validLangs = ['ja', 'en', 'ko', 'zh', 'th'];
    if (!body.lang || !validLangs.includes(body.lang)) {
      return c.json({ success: false, error: `lang must be one of: ${validLangs.join(', ')}` }, 400);
    }
    await setFriendLanguage(c.env.DB, user.friendId, body.lang);
    return c.json({ success: true, data: { lang: body.lang } });
  } catch (err) {
    console.error('PUT /api/liff/language error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/translate — AI翻訳 (on-demand)
 */
liffPortal.post('/api/liff/translate', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const body = await c.req.json<{ text: string; targetLang: string }>();
    if (!body.text || body.text.length > 2000) {
      return c.json({ success: false, error: 'text required (max 2000 chars)' }, 400);
    }
    const validLangs = ['ja', 'en', 'ko', 'zh', 'th'];
    if (!body.targetLang || !validLangs.includes(body.targetLang)) {
      return c.json({ success: false, error: 'Invalid targetLang' }, 400);
    }

    // Use AI translation service
    const { translateText } = await import('../services/translate.js');
    const translated = await translateText(
      c.env.DB,
      c.env.AI,
      body.text,
      'ja',
      body.targetLang,
      'LINE CRM health supplement context',
    );

    return c.json({ success: true, data: { text: translated } });
  } catch (err) {
    console.error('POST /api/liff/translate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── 紹介ランキング ──

/**
 * マスク処理: 「田中太郎」→「田○太○」（1文字おき伏字）
 */
function maskDisplayName(name: string | null): string {
  if (!name) return '匿名';
  const chars = [...name]; // Unicode-safe split
  return chars.map((ch, i) => (i % 2 === 1 ? '○' : ch)).join('');
}

liffPortal.get('/api/liff/referral/ranking', async (c) => {
  try {
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 10), 50);

    const { results } = await c.env.DB
      .prepare(
        `SELECT
           rr.referrer_id,
           f.display_name,
           COUNT(*) as referral_count
         FROM referral_rewards rr
         JOIN friends f ON f.id = rr.referrer_id
         WHERE rr.reward_type = 'referrer'
         GROUP BY rr.referrer_id
         ORDER BY referral_count DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<{ referrer_id: string; display_name: string | null; referral_count: number }>();

    const ranking = results.map((r, i) => ({
      rank: i + 1,
      displayName: maskDisplayName(r.display_name),
      referralCount: r.referral_count,
    }));

    return c.json({ success: true, data: ranking });
  } catch (err) {
    console.error('GET /api/liff/referral/ranking error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ── プロフィール更新（gender/birthday） ──

const VALID_GENDERS = ['male', 'female', 'other', 'unspecified'];

liffPortal.put('/api/liff/profile', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const body = await c.req.json<{ gender?: string; birthday?: string }>();
    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (body.gender !== undefined) {
      if (!VALID_GENDERS.includes(body.gender)) {
        return c.json({ success: false, error: `gender must be one of: ${VALID_GENDERS.join(', ')}` }, 400);
      }
      updates.push('gender = ?');
      values.push(body.gender);
    }

    if (body.birthday !== undefined) {
      if (body.birthday && !/^\d{4}-\d{2}-\d{2}$/.test(body.birthday)) {
        return c.json({ success: false, error: 'birthday must be YYYY-MM-DD format' }, 400);
      }
      updates.push('birthday = ?');
      values.push(body.birthday || null);
    }

    if (updates.length === 0) {
      return c.json({ success: false, error: 'No fields to update' }, 400);
    }

    const { jstNow: jst } = await import('@line-crm/db');
    updates.push('updated_at = ?');
    values.push(jst());
    values.push(user.friendId);

    await c.env.DB
      .prepare(`UPDATE friends SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    return c.json({ success: true, message: 'Profile updated' });
  } catch (err) {
    console.error('PUT /api/liff/profile error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

liffPortal.get('/api/liff/profile', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const friend = await c.env.DB
      .prepare('SELECT display_name, gender, birthday FROM friends WHERE id = ?')
      .bind(user.friendId)
      .first<{ display_name: string | null; gender: string | null; birthday: string | null }>();

    return c.json({ success: true, data: friend || {} });
  } catch (err) {
    console.error('GET /api/liff/profile error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Notification Preferences ───

/**
 * GET /api/liff/notification-prefs — 通知設定取得
 */
liffPortal.get('/api/liff/notification-prefs', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const prefs = await c.env.DB
      .prepare('SELECT restock_alert, delivery_complete, order_confirm, campaign_message, reorder_reminder FROM friend_notification_preferences WHERE friend_id = ?')
      .bind(user.friendId)
      .first<{ restock_alert: number; delivery_complete: number; order_confirm: number; campaign_message: number; reorder_reminder: number }>();

    // Default all on if no record
    return c.json({
      success: true,
      data: prefs || { restock_alert: 1, delivery_complete: 1, order_confirm: 1, campaign_message: 1, reorder_reminder: 1 },
    });
  } catch (err) {
    console.error('GET /api/liff/notification-prefs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/liff/notification-prefs — 通知設定変更
 */
liffPortal.put('/api/liff/notification-prefs', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const body = await c.req.json<Record<string, unknown>>();
    const allowed = ['restock_alert', 'delivery_complete', 'order_confirm', 'campaign_message', 'reorder_reminder'];
    const now = new Date().toISOString();

    // Check existing
    const existing = await c.env.DB
      .prepare('SELECT id FROM friend_notification_preferences WHERE friend_id = ?')
      .bind(user.friendId)
      .first<{ id: string }>();

    if (existing) {
      const updates: string[] = [];
      const values: (string | number)[] = [];
      for (const key of allowed) {
        if (key in body) {
          updates.push(`${key} = ?`);
          values.push(body[key] ? 1 : 0);
        }
      }
      if (updates.length > 0) {
        updates.push('updated_at = ?');
        values.push(now, existing.id);
        await c.env.DB.prepare(`UPDATE friend_notification_preferences SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }
    } else {
      const id = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO friend_notification_preferences (id, friend_id, restock_alert, delivery_complete, order_confirm, campaign_message, reorder_reminder, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, user.friendId,
        body.restock_alert !== undefined ? (body.restock_alert ? 1 : 0) : 1,
        body.delivery_complete !== undefined ? (body.delivery_complete ? 1 : 0) : 1,
        body.order_confirm !== undefined ? (body.order_confirm ? 1 : 0) : 1,
        body.campaign_message !== undefined ? (body.campaign_message ? 1 : 0) : 1,
        body.reorder_reminder !== undefined ? (body.reorder_reminder ? 1 : 0) : 1,
        now, now,
      ).run();
    }

    return c.json({ success: true, message: 'Preferences updated' });
  } catch (err) {
    console.error('PUT /api/liff/notification-prefs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── Subscription Reminders ───

/**
 * GET /api/liff/subscriptions — 定期購買リマインダー一覧
 */
liffPortal.get('/api/liff/subscriptions', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const subs = await c.env.DB
      .prepare('SELECT id, product_title, interval_days, next_reminder_at, is_active, created_at FROM subscription_reminders WHERE friend_id = ? ORDER BY created_at DESC')
      .bind(user.friendId)
      .all<{ id: string; product_title: string; interval_days: number; next_reminder_at: string; is_active: number; created_at: string }>();

    return c.json({ success: true, data: { subscriptions: subs.results || [] } });
  } catch (err) {
    console.error('GET /api/liff/subscriptions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * POST /api/liff/subscriptions — 定期購買リマインダー作成
 */
liffPortal.post('/api/liff/subscriptions', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const body = await c.req.json<{ productTitle: string; intervalDays?: number; variantId?: string; sourceOrderId?: string }>();
    if (!body.productTitle) return c.json({ success: false, error: 'productTitle required' }, 400);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const intervalDays = body.intervalDays || 30;
    const nextAt = new Date(Date.now() + intervalDays * 86400000).toISOString();

    await c.env.DB.prepare(
      `INSERT INTO subscription_reminders (id, friend_id, product_title, variant_id, interval_days, next_reminder_at, source_order_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.friendId, body.productTitle, body.variantId || null, intervalDays, nextAt, body.sourceOrderId || null, now, now).run();

    return c.json({ success: true, data: { id, nextReminderAt: nextAt } });
  } catch (err) {
    console.error('POST /api/liff/subscriptions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * PUT /api/liff/subscriptions/:id — 定期購買リマインダー更新（間隔変更/停止）
 */
liffPortal.put('/api/liff/subscriptions/:id', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const subId = c.req.param('id');
    const body = await c.req.json<{ intervalDays?: number; isActive?: boolean }>();
    const now = new Date().toISOString();

    const updates: string[] = ['updated_at = ?'];
    const values: (string | number)[] = [now];

    if (body.intervalDays !== undefined) {
      updates.push('interval_days = ?');
      values.push(body.intervalDays);
      const nextAt = new Date(Date.now() + body.intervalDays * 86400000).toISOString();
      updates.push('next_reminder_at = ?');
      values.push(nextAt);
    }
    if (body.isActive !== undefined) {
      updates.push('is_active = ?');
      values.push(body.isActive ? 1 : 0);
    }

    values.push(subId, user.friendId);
    await c.env.DB.prepare(`UPDATE subscription_reminders SET ${updates.join(', ')} WHERE id = ? AND friend_id = ?`).bind(...values).run();

    return c.json({ success: true, message: 'Subscription updated' });
  } catch (err) {
    console.error('PUT /api/liff/subscriptions/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /api/liff/subscriptions/:id — 定期購買リマインダー削除
 */
liffPortal.delete('/api/liff/subscriptions/:id', async (c) => {
  try {
    const user = getLiffUser(c);
    if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

    const subId = c.req.param('id');
    await c.env.DB.prepare('DELETE FROM subscription_reminders WHERE id = ? AND friend_id = ?').bind(subId, user.friendId).run();

    return c.json({ success: true, message: 'Subscription deleted' });
  } catch (err) {
    console.error('DELETE /api/liff/subscriptions/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ─── FAQ ───

/**
 * GET /api/liff/faq — FAQ一覧
 */
liffPortal.get('/api/liff/faq', async (c) => {
  try {
    const faqs = await c.env.DB
      .prepare('SELECT id, question, answer, category FROM faq_items WHERE is_active = 1 ORDER BY sort_order ASC, created_at ASC')
      .all<{ id: string; question: string; answer: string; category: string }>();

    return c.json({ success: true, data: { faqs: faqs.results || [] } });
  } catch (err) {
    console.error('GET /api/liff/faq error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { liffPortal };
