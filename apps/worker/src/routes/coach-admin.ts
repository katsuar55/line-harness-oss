/**
 * 栄養コーチ (Phase 4) — 管理画面用 API
 *
 * エンドポイント:
 *   GET  /api/admin/coach/analytics       — 期間内の生成 / クリック / CV / CTR / CVR + 不足キー別集計
 *   GET  /api/admin/coach/recommendations — 直近のレコメンド一覧 (friend 名と LEFT JOIN)
 *   GET  /api/admin/coach/sku-map         — SKU マッピング一覧
 *   PUT  /api/admin/coach/sku-map         — SKU マッピング upsert
 *   GET  /api/admin/coach/summary         — Phase 5: 直近 N 日のサマリー (push 数を含む)
 *
 * 認証は親 app の authMiddleware が `/api/*` 全体に効いている前提。
 */
import { Hono } from 'hono';
import {
  getCoachAnalytics,
  listSkuMaps,
  upsertSkuMap,
  type CoachAnalytics,
  type SkuMapRow,
} from '@line-crm/db';
import type { Env } from '../index.js';

const coachAdmin = new Hono<Env>();

// ============================================================
// 定数 / バリデーション
// ============================================================

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_DEFICIT_KEYS = [
  'protein_low',
  'fiber_low',
  'iron_low',
  'calorie_low',
  'calorie_high',
] as const;
type AllowedDeficitKey = (typeof ALLOWED_DEFICIT_KEYS)[number];

const PRODUCT_TITLE_MAX = 100;
const COPY_TEMPLATE_MAX = 200;

interface ByDeficitRow {
  deficitKey: string;
  generatedCount: number;
  clickedCount: number;
  convertedCount: number;
  ctr: number;
  cvr: number;
}

interface AnalyticsResponseData {
  totals: CoachAnalytics;
  byDeficit: ByDeficitRow[];
}

interface RecommendationListItem {
  id: string;
  friendId: string;
  friendName: string | null;
  generatedAt: string;
  status: string;
  aiMessage: string;
  deficitCount: number;
  skuCount: number;
}

// ============================================================
// GET /api/admin/coach/analytics
// ============================================================
coachAdmin.get('/api/admin/coach/analytics', async (c) => {
  try {
    const from = c.req.query('from');
    const to = c.req.query('to');

    if (!from || !to) {
      return c.json(
        { success: false, error: 'from / to are required (YYYY-MM-DD)' },
        400,
      );
    }

    if (!DATE_REGEX.test(from) || !DATE_REGEX.test(to)) {
      return c.json(
        { success: false, error: 'from / to must be in YYYY-MM-DD format' },
        400,
      );
    }

    if (from > to) {
      return c.json(
        { success: false, error: 'from must be <= to' },
        400,
      );
    }

    // 期間境界は generated_at の TEXT 比較で行うため、「to」は当日の終わりまで含める。
    const fromBoundary = `${from}T00:00:00`;
    const toBoundary = `${to}T23:59:59`;

    const totals = await getCoachAnalytics(c.env.DB, fromBoundary, toBoundary);

    // 不足キー別集計 — sku_suggestions_json は SkuSuggestion[] なので
    // json_each で要素を展開し、deficitKey でグルーピングする。
    interface ByDeficitDbRow {
      deficit_key: string | null;
      generated_count: number;
      clicked_count: number | null;
      converted_count: number | null;
    }

    const byDeficitResult = await c.env.DB
      .prepare(
        `SELECT
           json_extract(value, '$.deficitKey') AS deficit_key,
           COUNT(*) AS generated_count,
           SUM(CASE WHEN nr.status IN ('clicked', 'converted') THEN 1 ELSE 0 END) AS clicked_count,
           SUM(CASE WHEN nr.status = 'converted' THEN 1 ELSE 0 END) AS converted_count
         FROM nutrition_recommendations nr,
              json_each(nr.sku_suggestions_json)
         WHERE nr.generated_at >= ? AND nr.generated_at <= ?
         GROUP BY deficit_key
         ORDER BY generated_count DESC`,
      )
      .bind(fromBoundary, toBoundary)
      .all<ByDeficitDbRow>();

    const byDeficit: ByDeficitRow[] = (byDeficitResult.results ?? [])
      .filter((row) => row.deficit_key !== null)
      .map((row) => {
        const generated = row.generated_count ?? 0;
        const clicked = row.clicked_count ?? 0;
        const converted = row.converted_count ?? 0;
        return {
          deficitKey: String(row.deficit_key),
          generatedCount: generated,
          clickedCount: clicked,
          convertedCount: converted,
          ctr: generated > 0 ? clicked / generated : 0,
          cvr: generated > 0 ? converted / generated : 0,
        };
      });

    const data: AnalyticsResponseData = { totals, byDeficit };
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/coach/analytics error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/coach/recommendations
// ============================================================
coachAdmin.get('/api/admin/coach/recommendations', async (c) => {
  try {
    const limitParam = c.req.query('limit');
    const status = c.req.query('status') ?? 'active';

    const parsedLimit = Number.parseInt(limitParam ?? '50', 10);
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(1, parsedLimit), 200)
      : 50;

    const allowedStatuses = ['active', 'all'] as const;
    if (!allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
      return c.json(
        { success: false, error: "status must be 'active' or 'all'" },
        400,
      );
    }

    interface RecoDbRow {
      id: string;
      friend_id: string;
      friend_name: string | null;
      generated_at: string;
      status: string;
      ai_message: string;
      deficit_json: string;
      sku_suggestions_json: string;
    }

    const sql =
      status === 'active'
        ? `SELECT nr.id, nr.friend_id, f.display_name AS friend_name,
                  nr.generated_at, nr.status, nr.ai_message,
                  nr.deficit_json, nr.sku_suggestions_json
             FROM nutrition_recommendations nr
             LEFT JOIN friends f ON f.id = nr.friend_id
            WHERE nr.status = 'active'
            ORDER BY nr.generated_at DESC
            LIMIT ?`
        : `SELECT nr.id, nr.friend_id, f.display_name AS friend_name,
                  nr.generated_at, nr.status, nr.ai_message,
                  nr.deficit_json, nr.sku_suggestions_json
             FROM nutrition_recommendations nr
             LEFT JOIN friends f ON f.id = nr.friend_id
            ORDER BY nr.generated_at DESC
            LIMIT ?`;

    const result = await c.env.DB
      .prepare(sql)
      .bind(safeLimit)
      .all<RecoDbRow>();

    const data: RecommendationListItem[] = (result.results ?? []).map((row) => {
      let deficitCount = 0;
      let skuCount = 0;
      try {
        const parsed = JSON.parse(row.deficit_json);
        if (Array.isArray(parsed)) deficitCount = parsed.length;
      } catch {
        deficitCount = 0;
      }
      try {
        const parsed = JSON.parse(row.sku_suggestions_json);
        if (Array.isArray(parsed)) skuCount = parsed.length;
      } catch {
        skuCount = 0;
      }
      return {
        id: row.id,
        friendId: row.friend_id,
        friendName: row.friend_name,
        generatedAt: row.generated_at,
        status: row.status,
        aiMessage: row.ai_message,
        deficitCount,
        skuCount,
      };
    });

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/coach/recommendations error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/coach/sku-map
// ============================================================
coachAdmin.get('/api/admin/coach/sku-map', async (c) => {
  try {
    const data: SkuMapRow[] = await listSkuMaps(c.env.DB);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/coach/sku-map error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// PUT /api/admin/coach/sku-map
// ============================================================
interface PutSkuMapBody {
  deficitKey?: unknown;
  shopifyProductId?: unknown;
  productTitle?: unknown;
  copyTemplate?: unknown;
  isActive?: unknown;
}

function isAllowedDeficitKey(value: unknown): value is AllowedDeficitKey {
  return (
    typeof value === 'string' &&
    (ALLOWED_DEFICIT_KEYS as readonly string[]).includes(value)
  );
}

coachAdmin.put('/api/admin/coach/sku-map', async (c) => {
  try {
    const body: PutSkuMapBody = await c.req
      .json<PutSkuMapBody>()
      .catch((): PutSkuMapBody => ({}));

    if (!isAllowedDeficitKey(body.deficitKey)) {
      return c.json(
        {
          success: false,
          error: `deficitKey must be one of: ${ALLOWED_DEFICIT_KEYS.join(', ')}`,
        },
        400,
      );
    }

    if (
      typeof body.shopifyProductId !== 'string' ||
      body.shopifyProductId.trim() === ''
    ) {
      return c.json(
        { success: false, error: 'shopifyProductId is required' },
        400,
      );
    }

    if (
      typeof body.productTitle !== 'string' ||
      body.productTitle.trim() === ''
    ) {
      return c.json(
        { success: false, error: 'productTitle is required' },
        400,
      );
    }
    if (body.productTitle.length > PRODUCT_TITLE_MAX) {
      return c.json(
        {
          success: false,
          error: `productTitle must be <= ${PRODUCT_TITLE_MAX} chars`,
        },
        400,
      );
    }

    if (
      typeof body.copyTemplate !== 'string' ||
      body.copyTemplate.trim() === ''
    ) {
      return c.json(
        { success: false, error: 'copyTemplate is required' },
        400,
      );
    }
    if (body.copyTemplate.length > COPY_TEMPLATE_MAX) {
      return c.json(
        {
          success: false,
          error: `copyTemplate must be <= ${COPY_TEMPLATE_MAX} chars`,
        },
        400,
      );
    }

    const isActive =
      typeof body.isActive === 'boolean' ? body.isActive : undefined;

    await upsertSkuMap(c.env.DB, {
      deficitKey: body.deficitKey,
      shopifyProductId: body.shopifyProductId,
      productTitle: body.productTitle,
      copyTemplate: body.copyTemplate,
      isActive,
    });

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/admin/coach/sku-map error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ============================================================
// GET /api/admin/coach/summary — Phase 5 PR-1
//
// 直近 N 日 (default 7) のレコメンド集計 + 直近の生成行を 1 リクエストで取得。
// 既存の analytics と違い:
// - days = 過去 N 日 (デフォルト 7)
// - **pushed (sent_at NOT NULL の数)** を別途返す → 週次 push が動いているか可視化
// - recent には ai_message を 80 字で切り詰めた抜粋を含める
// ============================================================

const SUMMARY_DEFAULT_DAYS = 7;
const SUMMARY_MAX_DAYS = 90;
const RECENT_LIMIT = 20;
const AI_MESSAGE_EXCERPT_LEN = 80;

export interface CoachSummary {
  /** 期間内に生成されたレコメンド総数 */
  generated: number;
  /** sent_at が設定された数 (= 実際 LINE push が試行された) */
  pushed: number;
  /** クリック (status='clicked' or 'converted') */
  clicked: number;
  /** 購入に至った数 (status='converted') */
  converted: number;
  /** clicked / generated (0 件期間は 0) */
  ctr: number;
  /** converted / generated (0 件期間は 0) */
  cvr: number;
  /** 集計対象期間 (JST 基準の境界) */
  fromDate: string;
  toDate: string;
  /** 過去 N 日 (paramater 由来) */
  days: number;
  /** 直近 20 件 — ai_message は 80 字に切り詰め */
  recent: Array<{
    id: string;
    friendId: string;
    generatedAt: string;
    status: string;
    aiMessageExcerpt: string;
  }>;
}

function truncate(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  // Surrogate pair safe truncate (Array.from で文字単位)
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('') + '…';
}

/** 現在時刻 (UTC) を JST 基準の YYYY-MM-DDTHH:mm:ss 文字列に変換 (秒精度) */
function nowJstIso(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 19);
}

/** JST ISO 文字列から N 日前の同じ時刻を返す */
function daysAgoJstIso(jstIsoString: string, days: number): string {
  const ms = Date.parse(`${jstIsoString}Z`); // Z にして UTC 扱いで Date.parse に流し込む
  const past = new Date(ms - days * 86_400_000);
  return past.toISOString().slice(0, 19);
}

coachAdmin.get('/api/admin/coach/summary', async (c) => {
  try {
    const daysParam = c.req.query('days');
    const parsed = Number.parseInt(daysParam ?? String(SUMMARY_DEFAULT_DAYS), 10);
    const days = Number.isFinite(parsed) && parsed > 0
      ? Math.min(parsed, SUMMARY_MAX_DAYS)
      : SUMMARY_DEFAULT_DAYS;

    const toDate = nowJstIso();
    const fromDate = daysAgoJstIso(toDate, days);

    interface AggRow {
      generated: number;
      pushed: number | null;
      clicked: number | null;
      converted: number | null;
    }

    const aggRow = await c.env.DB
      .prepare(
        `SELECT
           COUNT(*) AS generated,
           SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS pushed,
           SUM(CASE WHEN status IN ('clicked', 'converted') THEN 1 ELSE 0 END) AS clicked,
           SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted
         FROM nutrition_recommendations
         WHERE generated_at >= ? AND generated_at <= ?`,
      )
      .bind(fromDate, toDate)
      .first<AggRow>();

    const generated = aggRow?.generated ?? 0;
    const pushed = aggRow?.pushed ?? 0;
    const clicked = aggRow?.clicked ?? 0;
    const converted = aggRow?.converted ?? 0;

    interface RecentRow {
      id: string;
      friend_id: string;
      generated_at: string;
      status: string;
      ai_message: string;
    }

    const recentResult = await c.env.DB
      .prepare(
        `SELECT id, friend_id, generated_at, status, ai_message
           FROM nutrition_recommendations
          WHERE generated_at >= ? AND generated_at <= ?
          ORDER BY generated_at DESC
          LIMIT ?`,
      )
      .bind(fromDate, toDate, RECENT_LIMIT)
      .all<RecentRow>();

    const recent = (recentResult.results ?? []).map((row) => ({
      id: row.id,
      friendId: row.friend_id,
      generatedAt: row.generated_at,
      status: row.status,
      aiMessageExcerpt: truncate(row.ai_message ?? '', AI_MESSAGE_EXCERPT_LEN),
    }));

    const data: CoachSummary = {
      generated,
      pushed,
      clicked,
      converted,
      ctr: generated > 0 ? clicked / generated : 0,
      cvr: generated > 0 ? converted / generated : 0,
      fromDate,
      toDate,
      days,
      recent,
    };

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/admin/coach/summary error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { coachAdmin };
