/**
 * LINE Insight Overview API (Phase 5β-5a)
 *
 * 既存 /api/dashboard/* (= friends/orders/intake/health) と棲み分けて、
 * 「LINE 特化分析」 (= AI reply rate, broadcast 配信統計, scenario delivery, coupon issue) を返す。
 *
 * MVP scope:
 *  - aiReplyRate: messages_log で outgoing の AI / 手動 / scenario / broadcast 内訳
 *  - broadcasts:   broadcasts table の status='sent' 集計 (read/click は次 Phase)
 *  - scenarios:    friend_scenarios の status 別 + active scenario 別 count
 *  - coupons:      line_friend_coupons + audit_logs 連動 (= 5β-1d-2f log 強化と連動)
 *
 * window: 7-90 日 (default 30)、 LINE 24h-only push の運用感覚に合わせて短期視点優先。
 *
 * 関連: routes/dashboard.ts (= 既存 main dashboard、 friends 増減等)、
 *       services/shopify-coupon-issuer.ts + audit-logger.ts (= 5β-1d-2f log)
 */

import { Hono } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import type { Env } from '../index.js';

export const lineInsights = new Hono<Env>();

interface AiReplyRow {
  total: number | null;
  ai_replies: number | null;
  manual_replies: number | null;
  scenario_replies: number | null;
  broadcast_messages: number | null;
}

interface BroadcastRow {
  total_broadcasts: number | null;
  total_delivered: number | null;
  total_target: number | null;
  /** 5β-5c-prep: insights_json が取込済の broadcast 数 (= LINE Insight API fetched) */
  with_insights: number | null;
  /** SUM(insights_json.overview.uniqueImpression) (= 既読相当のユニーク数) */
  total_read: number | null;
  /** SUM(insights_json.overview.uniqueClick) (= クリック相当のユニーク数) */
  total_clicks: number | null;
}

interface StatusRow {
  status: string;
  count: number;
}

interface ScenarioRow {
  scenario_id: string;
  count: number;
}

interface CouponTotalRow {
  total: number | null;
  redeemed: number | null;
  issued_last_n: number | null;
}

interface CouponStageRow {
  stage: string | null;
  count: number;
}

interface CouponAuditSummaryRow {
  succeeded: number | null;
  failed: number | null;
  threw: number | null;
}

function roundPct(num: number, denom: number): number {
  if (denom <= 0) return 0;
  return Math.round((num / denom) * 1000) / 10;
}

/**
 * GET /api/line-insights/overview?days=30
 * → AI reply rate / broadcasts / scenarios / coupons の overview を 1 response で返す
 */
lineInsights.get('/api/line-insights/overview', async (c) => {
  try {
    const rawDays = Number(c.req.query('days')) || 30;
    const days = Math.min(Math.max(rawDays, 7), 90);

    const [aiRow, bRow, statusRowsResult, scenarioRowsResult, cTotal, failByStageResult, auditSummary] =
      await Promise.all([
        // ── 1. AI reply rate ──
        c.env.DB.prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN content LIKE '[ai:%' THEN 1 ELSE 0 END) AS ai_replies,
             SUM(CASE WHEN content NOT LIKE '[ai:%' AND delivery_type='reply' THEN 1 ELSE 0 END) AS manual_replies,
             SUM(CASE WHEN scenario_step_id IS NOT NULL THEN 1 ELSE 0 END) AS scenario_replies,
             SUM(CASE WHEN broadcast_id IS NOT NULL THEN 1 ELSE 0 END) AS broadcast_messages
           FROM messages_log
           WHERE direction='outgoing' AND created_at >= date('now', '-' || ? || ' days')`,
        )
          .bind(days)
          .first<AiReplyRow>(),

        // ── 2. Broadcasts 統計 (= status='sent' のみ、 insights_json 取込 5β-5c-prep) ──
        c.env.DB.prepare(
          `SELECT
             COUNT(*) AS total_broadcasts,
             COALESCE(SUM(success_count), 0) AS total_delivered,
             COALESCE(SUM(total_count), 0) AS total_target,
             COALESCE(SUM(CASE WHEN insights_json IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_insights,
             COALESCE(SUM(CAST(COALESCE(json_extract(insights_json, '$.overview.uniqueImpression'), 0) AS INTEGER)), 0) AS total_read,
             COALESCE(SUM(CAST(COALESCE(json_extract(insights_json, '$.overview.uniqueClick'), 0) AS INTEGER)), 0) AS total_clicks
           FROM broadcasts
           WHERE status='sent' AND sent_at >= date('now', '-' || ? || ' days')`,
        )
          .bind(days)
          .first<BroadcastRow>(),

        // ── 3a. friend_scenarios status 別 ──
        c.env.DB.prepare(
          `SELECT status, COUNT(*) AS count FROM friend_scenarios GROUP BY status`,
        ).all<StatusRow>(),

        // ── 3b. active な scenario 別 (LINE 配信中の scenario_id breakdown) ──
        c.env.DB.prepare(
          `SELECT scenario_id, COUNT(*) AS count FROM friend_scenarios
            WHERE status='active' GROUP BY scenario_id`,
        ).all<ScenarioRow>(),

        // ── 4a. coupon 全体カウント ──
        c.env.DB.prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status='redeemed' THEN 1 ELSE 0 END) AS redeemed,
             SUM(CASE WHEN issued_at >= date('now', '-' || ? || ' days') THEN 1 ELSE 0 END) AS issued_last_n
           FROM line_friend_coupons`,
        )
          .bind(days)
          .first<CouponTotalRow>(),

        // ── 4b. failed by stage (= 5β-1d-2f audit_logs 連動) ──
        c.env.DB.prepare(
          `SELECT
             COALESCE(json_extract(metadata, '$.stage'), 'unknown') AS stage,
             COUNT(*) AS count
           FROM audit_logs
           WHERE action='line_friend_coupon.issue_failed'
             AND created_at >= date('now', '-' || ? || ' days')
           GROUP BY stage`,
        )
          .bind(days)
          .all<CouponStageRow>(),

        // ── 4c. audit_logs summary (succeeded / failed / threw) ──
        c.env.DB.prepare(
          `SELECT
             SUM(CASE WHEN action='line_friend_coupon.issue_succeeded' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN action='line_friend_coupon.issue_failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN action='line_friend_coupon.issue_threw' THEN 1 ELSE 0 END) AS threw
           FROM audit_logs
           WHERE action LIKE 'line_friend_coupon%' AND created_at >= date('now', '-' || ? || ' days')`,
        )
          .bind(days)
          .first<CouponAuditSummaryRow>(),
      ]);

    const totalOutgoing = aiRow?.total ?? 0;
    const aiReplies = aiRow?.ai_replies ?? 0;
    const manualReplies = aiRow?.manual_replies ?? 0;
    const scenarioReplies = aiRow?.scenario_replies ?? 0;
    const broadcastMessages = aiRow?.broadcast_messages ?? 0;
    // scenario_step_id IS NOT NULL と broadcast_id IS NOT NULL は別 column 由来なので
    // 重複 count しないが、 ai_replies は content prefix から識別、 これも独立。
    // other = 全 outgoing から 識別可能な category を引いた残り (= scenario でも broadcast でも
    // AI でも reply でもない、 例えば 手動 push 等)
    const knownSum = aiReplies + manualReplies + scenarioReplies + broadcastMessages;
    const other = Math.max(0, totalOutgoing - knownSum);

    const totalDelivered = bRow?.total_delivered ?? 0;
    const totalTarget = bRow?.total_target ?? 0;

    return c.json({
      success: true,
      data: {
        window: { days },
        aiReplyRate: {
          totalOutgoing,
          aiReplies,
          manualReplies,
          scenarioReplies,
          broadcastMessages,
          other,
          aiPct: roundPct(aiReplies, totalOutgoing),
        },
        broadcasts: {
          totalBroadcasts: bRow?.total_broadcasts ?? 0,
          totalDelivered,
          totalTarget,
          deliverRate: roundPct(totalDelivered, totalTarget),
          // 5β-5c-prep: insights_json 連動 (= LINE Insight API で fetch した read/click 集計)
          withInsights: bRow?.with_insights ?? 0,
          totalRead: bRow?.total_read ?? 0,
          totalClicks: bRow?.total_clicks ?? 0,
          readRate: roundPct(bRow?.total_read ?? 0, totalDelivered),
          clickRate: roundPct(bRow?.total_clicks ?? 0, totalDelivered),
        },
        scenarios: {
          statusCounts: statusRowsResult?.results ?? [],
          activeByScenario: scenarioRowsResult?.results ?? [],
        },
        coupons: {
          totalIssued: cTotal?.total ?? 0,
          redeemed: cTotal?.redeemed ?? 0,
          issuedLastNDays: cTotal?.issued_last_n ?? 0,
          failByStage: (failByStageResult?.results ?? []).map((r) => ({
            stage: r.stage ?? 'unknown',
            count: r.count,
          })),
          succeededLastNDays: auditSummary?.succeeded ?? 0,
          failedLastNDays: auditSummary?.failed ?? 0,
          threwLastNDays: auditSummary?.threw ?? 0,
        },
      },
    });
  } catch (err) {
    console.error('GET /api/line-insights/overview error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * GET /api/line-insights/quota
 * → LINE Messaging API の月次 quota + 今月の usage を取得
 *
 * (LSTEP audit H4、 2026-05-22)
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       type: 'none' | 'limited',     // 'none' = 無制限 (Pro/Premium)
 *       limit?: number,               // 月間上限 (type='limited' 時のみ)
 *       usage: number,                // 今月の使用数 (= reply/push/multicast/broadcast 合算)
 *       remaining?: number,           // 残り (= limit - usage、 type='limited' 時のみ)
 *       ratio?: number,               // usage / limit (= type='limited' 時のみ)
 *       percentDisplay?: string,      // '80.0%' 等 (= UI 表示用)
 *       severity?: 'warning' | 'critical' | 'reached',  // 閾値判定結果
 *       fetchedAt: string,            // ISO 8601
 *     }
 *   }
 *
 * LINE API:
 *   - GET /v2/bot/message/quota
 *   - GET /v2/bot/message/quota/consumption
 *
 * 関連: services/line-quota-monitor.ts (= cron で同 API を叩いて Discord alert)
 */
lineInsights.get('/api/line-insights/quota', async (c) => {
  try {
    const token = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!token) {
      return c.json(
        { success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN not configured' },
        500,
      );
    }
    const line = new LineClient(token);
    const [quota, consumption] = await Promise.all([
      line.getMessageQuota(),
      line.getMessageQuotaConsumption(),
    ]);
    const fetchedAt = new Date().toISOString();
    if (quota.type === 'none' || quota.value === undefined || quota.value <= 0) {
      return c.json({
        success: true,
        data: {
          type: 'none' as const,
          usage: consumption.totalUsage,
          fetchedAt,
        },
      });
    }
    const limit = quota.value;
    const usage = consumption.totalUsage;
    const remaining = Math.max(0, limit - usage);
    const ratio = usage / limit;
    const severity: 'warning' | 'critical' | 'reached' | undefined =
      ratio >= 1.0 ? 'reached' : ratio >= 0.95 ? 'critical' : ratio >= 0.8 ? 'warning' : undefined;
    return c.json({
      success: true,
      data: {
        type: 'limited' as const,
        limit,
        usage,
        remaining,
        ratio: Math.round(ratio * 1000) / 1000,
        percentDisplay: `${(ratio * 100).toFixed(1)}%`,
        severity,
        fetchedAt,
      },
    });
  } catch (err) {
    console.error('GET /api/line-insights/quota error:', err);
    return c.json({ success: false, error: 'Failed to fetch LINE quota' }, 502);
  }
});

