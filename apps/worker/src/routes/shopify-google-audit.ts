/**
 * Shopify-Google Merchant Audit admin route (= LP launch blocker fix、 2026-05-27)
 *
 * 役割:
 *   - admin web `/google-audit` page から audit 実行 + 結果取得 + 1-click apply
 *   - 既存 service runProductAudit + applyIssueFix を呼ぶ thin wrapper
 *
 * endpoints:
 *   POST /api/google-audit/run          → audit 新規実行 (= trigger=manual)
 *   GET  /api/google-audit/latest        → 直近 run + summary + issues
 *   GET  /api/google-audit/runs          → run history (= 直近 20)
 *   GET  /api/google-audit/runs/:runId   → 1 run の全 issues
 *   POST /api/google-audit/issues/:id/apply (dryRun=true|false) → 個別修正適用
 *   POST /api/google-audit/issues/bulk-apply body={ ids: [], severity?, category? } → 一括 apply
 */
import { Hono } from 'hono';
import {
  getLatestAuditRun,
  listAuditRuns,
  listIssuesForRun,
  getIssueById,
  type IssueSeverity,
  type IssueCategory,
} from '@line-crm/db';
import { runProductAudit, applyIssueFix } from '../services/shopify-google-audit.js';

import type { Env } from '../index.js';

const googleAudit = new Hono<Env>();

// ============================================================
// POST /api/google-audit/run — 新規 audit 実行
// ============================================================
googleAudit.post('/api/google-audit/run', async (c) => {
  try {
    const result = await runProductAudit(c.env, { trigger: 'admin-ui' });
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('[google-audit POST run] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'audit run failed' }, 500);
  }
});

// ============================================================
// GET /api/google-audit/latest — 直近 run + summary + issues
// ============================================================
googleAudit.get('/api/google-audit/latest', async (c) => {
  try {
    const latest = await getLatestAuditRun(c.env.DB);
    if (!latest) {
      return c.json({ success: true, data: { run: null, issues: [] } });
    }

    const severity = c.req.query('severity') as IssueSeverity | undefined;
    const category = c.req.query('category') as IssueCategory | undefined;
    const pendingOnly = c.req.query('pendingOnly') === 'true';
    const issues = await listIssuesForRun(c.env.DB, latest.id, {
      severity,
      category,
      pendingOnly,
    });

    return c.json({ success: true, data: { run: latest, issues } });
  } catch (err) {
    console.error('[google-audit GET latest] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'failed to fetch latest audit' }, 500);
  }
});

// ============================================================
// GET /api/google-audit/runs — run history
// ============================================================
googleAudit.get('/api/google-audit/runs', async (c) => {
  try {
    const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
    const runs = await listAuditRuns(c.env.DB, limit);
    return c.json({ success: true, data: runs });
  } catch (err) {
    return c.json({ success: false, error: 'failed to list runs' }, 500);
  }
});

// ============================================================
// GET /api/google-audit/runs/:runId — 1 run の全 issues
// ============================================================
googleAudit.get('/api/google-audit/runs/:runId', async (c) => {
  try {
    const runId = c.req.param('runId');
    const severity = c.req.query('severity') as IssueSeverity | undefined;
    const category = c.req.query('category') as IssueCategory | undefined;
    const issues = await listIssuesForRun(c.env.DB, runId, { severity, category });
    return c.json({ success: true, data: { runId, issues } });
  } catch (err) {
    return c.json({ success: false, error: 'failed to fetch run' }, 500);
  }
});

// ============================================================
// POST /api/google-audit/issues/:id/apply
// ============================================================
googleAudit.post('/api/google-audit/issues/:id/apply', async (c) => {
  try {
    const issueId = c.req.param('id');
    const body = await c.req.json<{ dryRun?: boolean; appliedBy?: string }>().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const appliedBy = body.appliedBy || 'admin-ui';

    const result = await applyIssueFix(c.env, issueId, appliedBy, { dryRun });
    if (!result.success) {
      return c.json({ success: false, error: result.error ?? 'apply failed', data: result }, 400);
    }
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('[google-audit POST apply] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'apply failed' }, 500);
  }
});

// ============================================================
// POST /api/google-audit/issues/bulk-apply
//   body: { runId: string, severity?, category?, dryRun?, appliedBy? }
//   → 該当 issues を順次 apply (= dry-run / actual)
// ============================================================
googleAudit.post('/api/google-audit/issues/bulk-apply', async (c) => {
  try {
    const body = await c.req.json<{
      runId?: string;
      severity?: IssueSeverity;
      category?: IssueCategory;
      dryRun?: boolean;
      appliedBy?: string;
      maxApply?: number;
    }>();

    if (!body.runId) return c.json({ success: false, error: 'runId required' }, 400);

    const dryRun = body.dryRun === true;
    const appliedBy = body.appliedBy || 'admin-ui-bulk';
    const maxApply = Math.min(body.maxApply ?? 100, 500);

    const issues = await listIssuesForRun(c.env.DB, body.runId, {
      severity: body.severity,
      category: body.category,
      pendingOnly: true,
    });

    const applyResults: Array<{
      issueId: string;
      success: boolean;
      dryRun: boolean;
      applied?: { field: string; before: string | null; after: string | null };
      error?: string;
    }> = [];

    let appliedCount = 0;
    for (const issue of issues) {
      if (appliedCount >= maxApply) break;
      const r = await applyIssueFix(c.env, issue.id, appliedBy, { dryRun });
      applyResults.push({ issueId: issue.id, ...r });
      if (r.success) appliedCount += 1;
    }

    return c.json({
      success: true,
      data: {
        runId: body.runId,
        totalCandidates: issues.length,
        attempted: applyResults.length,
        succeeded: applyResults.filter((r) => r.success).length,
        failed: applyResults.filter((r) => !r.success).length,
        dryRun,
        results: applyResults,
      },
    });
  } catch (err) {
    console.error('[google-audit POST bulk-apply] failed', err instanceof Error ? err.message : 'unknown');
    return c.json({ success: false, error: 'bulk apply failed' }, 500);
  }
});

// ============================================================
// GET /api/google-audit/issues/:id — 1 issue 詳細
// ============================================================
googleAudit.get('/api/google-audit/issues/:id', async (c) => {
  try {
    const issueId = c.req.param('id');
    const issue = await getIssueById(c.env.DB, issueId);
    if (!issue) return c.json({ success: false, error: 'not found' }, 404);
    return c.json({ success: true, data: issue });
  } catch (err) {
    return c.json({ success: false, error: 'failed to fetch issue' }, 500);
  }
});

export { googleAudit };
