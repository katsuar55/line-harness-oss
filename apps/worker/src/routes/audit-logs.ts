/**
 * audit_logs admin route (Phase 5β-1d-2f-followup / 課題 1 真因確定 UI 基盤).
 *
 * 役割:
 *   - admin web `/audit-logs` page から filter + pagination で append-only な audit_logs を閲覧
 *   - 5β-1d-2 で issueCouponForFriend が silent fail した時の真因確定を容易化
 *   - 将来的に GDPR エクスポート / RBAC 強化の基盤としても使う
 *
 * 設計:
 *   - **read-only**: UPDATE / DELETE endpoint は提供しない (= append-only 性担保)
 *   - **filter は packages/db queryAuditLogs / countAuditLogs を re-use** (重複実装回避)
 *   - **limit clamp**: 100 default / 500 max (= UI 性能担保)
 *   - **validation**: result / actorType は enum 値のみ受付 (= 400 で reject)
 */
import { Hono } from 'hono';
import {
  queryAuditLogs,
  countAuditLogs,
  type AuditActorType,
  type AuditResult,
} from '@line-crm/db';

import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const auditLogs = new Hono<Env>();

const VALID_RESULTS: readonly AuditResult[] = ['success', 'failure'] as const;
const VALID_ACTOR_TYPES: readonly AuditActorType[] = [
  'admin',
  'system',
  'cron',
  'webhook',
  'api',
] as const;

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// 監査ログには staff スナップショット (氏名・役割) が入るため owner/admin 限定。
// staff ロールから ?actionPrefix=admin.staff. で名簿を迂回閲覧できる穴を塞ぐ (採点 HIGH)。
auditLogs.get('/api/audit-logs', requireRole('owner', 'admin'), async (c) => {
  try {
    const action = c.req.query('action') || undefined;
    const actionPrefix = c.req.query('actionPrefix') || undefined;
    const resultParam = c.req.query('result') || undefined;
    const actorTypeParam = c.req.query('actorType') || undefined;
    const targetType = c.req.query('targetType') || undefined;
    const targetId = c.req.query('targetId') || undefined;
    const since = c.req.query('since') || undefined;
    const until = c.req.query('until') || undefined;
    const lineAccountIdQ = c.req.query('lineAccountId');

    // limit: 1〜500、 default 100
    const limit = Math.min(Math.max(parseIntOr(c.req.query('limit'), 100), 1), 500);
    // offset: >= 0、 default 0
    const offset = Math.max(parseIntOr(c.req.query('offset'), 0), 0);

    // validation
    if (resultParam !== undefined && !VALID_RESULTS.includes(resultParam as AuditResult)) {
      return c.json(
        { success: false, error: `invalid result: ${resultParam} (allowed: ${VALID_RESULTS.join('|')})` },
        400,
      );
    }
    if (
      actorTypeParam !== undefined &&
      !VALID_ACTOR_TYPES.includes(actorTypeParam as AuditActorType)
    ) {
      return c.json(
        {
          success: false,
          error: `invalid actorType: ${actorTypeParam} (allowed: ${VALID_ACTOR_TYPES.join('|')})`,
        },
        400,
      );
    }

    const filter = {
      action,
      actionPrefix,
      result: resultParam as AuditResult | undefined,
      actorType: actorTypeParam as AuditActorType | undefined,
      targetType,
      targetId,
      since,
      until,
      limit,
      offset,
      // 明示的に渡された場合のみ filter ('' の場合は null として渡す = no line_account_id)
      ...(lineAccountIdQ !== undefined ? { lineAccountId: lineAccountIdQ || null } : {}),
    };

    const [logs, total] = await Promise.all([
      queryAuditLogs(c.env.DB, filter),
      countAuditLogs(c.env.DB, filter),
    ]);

    return c.json({
      success: true,
      data: {
        logs,
        total,
        limit,
        offset,
        // logs が empty の時は hasMore=false (= UI 側のループ防止)
        hasMore: logs.length > 0 && offset + logs.length < total,
      },
    });
  } catch (err) {
    console.error('GET /api/audit-logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { auditLogs };
