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

        // ── 2. Broadcasts 統計 (= status='sent' のみ) ──
        c.env.DB.prepare(
          `SELECT
             COUNT(*) AS total_broadcasts,
             COALESCE(SUM(success_count), 0) AS total_delivered,
             COALESCE(SUM(total_count), 0) AS total_target
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
          // read/click は insights_json + link_clicks 集計 (= 次 Phase 5β-5b)
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

