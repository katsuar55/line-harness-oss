/**
 * Google Merchant Audit DB queries (= LP launch blocker fix、 2026-05-27)
 *
 * 目的:
 *   Shopify-Google Merchant Center 12 商品 Limited 解消のための audit 結果 + 修正履歴 を管理。
 *   migration 056 で table 2 つ追加。
 *
 * 関連 service: apps/worker/src/services/shopify-google-audit.ts
 */
import { jstNow } from './utils.js';

// ============================================================
// 型
// ============================================================

export type AuditTrigger = 'cron' | 'manual' | 'admin-ui';
export type AuditStatus = 'success' | 'partial' | 'error';
export type IssueSeverity = 'high' | 'medium' | 'low';
export type IssueCategory =
  | 'ng_keyword'
  | 'missing_gtin'
  | 'missing_gpc'
  | 'missing_brand'
  | 'image_overlay_suspected'
  | 'price_inconsistency'
  | 'inventory_zero'
  | 'missing_description'
  | 'missing_image'
  | 'invalid_identifier_exists';

export interface GoogleMerchantAuditRunRow {
  id: string;
  run_at: string;
  trigger: string;
  status: string;
  total_products: number;
  products_with_issues: number;
  high_severity_count: number;
  medium_severity_count: number;
  low_severity_count: number;
  issues_by_category: string | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface ProductAuditIssueRow {
  id: string;
  run_id: string;
  shopify_product_id: string;
  product_title: string;
  product_handle: string | null;
  category: string;
  severity: string;
  field: string | null;
  original_value: string | null;
  suggested_value: string | null;
  applied: number;
  applied_at: string | null;
  applied_by: string | null;
  metadata: string | null;
  created_at: string;
}

export interface InsertAuditRunInput {
  id: string;
  trigger: AuditTrigger;
  status: AuditStatus;
  totalProducts: number;
  productsWithIssues: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
  issuesByCategory?: Record<string, number>;
  durationMs?: number;
  errorMessage?: string | null;
}

export interface InsertProductIssueInput {
  runId: string;
  shopifyProductId: string;
  productTitle: string;
  productHandle?: string | null;
  category: IssueCategory;
  severity: IssueSeverity;
  field?: string | null;
  originalValue?: string | null;
  suggestedValue?: string | null;
  metadata?: object | null;
}

// ============================================================
// run insert
// ============================================================

export async function insertAuditRun(
  db: D1Database,
  input: InsertAuditRunInput,
): Promise<void> {
  const issuesByCategoryJson = input.issuesByCategory
    ? JSON.stringify(input.issuesByCategory)
    : null;
  await db
    .prepare(
      `INSERT INTO google_merchant_audit_runs (
        id, run_at, trigger, status, total_products, products_with_issues,
        high_severity_count, medium_severity_count, low_severity_count,
        issues_by_category, duration_ms, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      jstNow(),
      input.trigger,
      input.status,
      input.totalProducts,
      input.productsWithIssues,
      input.highSeverityCount,
      input.mediumSeverityCount,
      input.lowSeverityCount,
      issuesByCategoryJson,
      input.durationMs ?? null,
      input.errorMessage ?? null,
    )
    .run();
}

// ============================================================
// issue batch insert (= 1 run の全 issue を一括登録)
// ============================================================

export async function insertProductIssues(
  db: D1Database,
  issues: InsertProductIssueInput[],
): Promise<void> {
  if (issues.length === 0) return;
  const now = jstNow();
  for (const issue of issues) {
    const id = crypto.randomUUID();
    const metadataJson = issue.metadata ? JSON.stringify(issue.metadata) : null;
    await db
      .prepare(
        `INSERT INTO product_audit_issues (
          id, run_id, shopify_product_id, product_title, product_handle,
          category, severity, field, original_value, suggested_value,
          metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        issue.runId,
        issue.shopifyProductId,
        issue.productTitle,
        issue.productHandle ?? null,
        issue.category,
        issue.severity,
        issue.field ?? null,
        issue.originalValue ?? null,
        issue.suggestedValue ?? null,
        metadataJson,
        now,
      )
      .run();
  }
}

// ============================================================
// query
// ============================================================

export async function getLatestAuditRun(
  db: D1Database,
): Promise<GoogleMerchantAuditRunRow | null> {
  return await db
    .prepare(
      `SELECT * FROM google_merchant_audit_runs ORDER BY run_at DESC LIMIT 1`,
    )
    .first<GoogleMerchantAuditRunRow>();
}

export async function listAuditRuns(
  db: D1Database,
  limit = 20,
): Promise<GoogleMerchantAuditRunRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM google_merchant_audit_runs ORDER BY run_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<GoogleMerchantAuditRunRow>();
  return result.results ?? [];
}

export async function listIssuesForRun(
  db: D1Database,
  runId: string,
  filters: {
    severity?: IssueSeverity;
    category?: IssueCategory;
    appliedOnly?: boolean;
    pendingOnly?: boolean;
  } = {},
): Promise<ProductAuditIssueRow[]> {
  const where: string[] = ['run_id = ?'];
  const params: unknown[] = [runId];
  if (filters.severity) {
    where.push('severity = ?');
    params.push(filters.severity);
  }
  if (filters.category) {
    where.push('category = ?');
    params.push(filters.category);
  }
  if (filters.appliedOnly) where.push('applied = 1');
  if (filters.pendingOnly) where.push('applied = 0');

  const sql = `SELECT * FROM product_audit_issues
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      shopify_product_id`;
  const result = await db.prepare(sql).bind(...params).all<ProductAuditIssueRow>();
  return result.results ?? [];
}

export async function markIssueApplied(
  db: D1Database,
  issueId: string,
  appliedBy: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE product_audit_issues
        SET applied = 1, applied_at = ?, applied_by = ?
        WHERE id = ?`,
    )
    .bind(jstNow(), appliedBy, issueId)
    .run();
}

export async function getIssueById(
  db: D1Database,
  issueId: string,
): Promise<ProductAuditIssueRow | null> {
  return await db
    .prepare(`SELECT * FROM product_audit_issues WHERE id = ?`)
    .bind(issueId)
    .first<ProductAuditIssueRow>();
}

// ============================================================
// cleanup (= 古い run の issues を削除、 retention 管理)
// ============================================================

export async function cleanupOldAuditRuns(
  db: D1Database,
  keepRuns: number,
): Promise<{ deletedRuns: number; deletedIssues: number }> {
  // 直近 keepRuns 件以外を削除
  const oldRuns = await db
    .prepare(
      `SELECT id FROM google_merchant_audit_runs
        ORDER BY run_at DESC LIMIT -1 OFFSET ?`,
    )
    .bind(keepRuns)
    .all<{ id: string }>();
  const oldIds = (oldRuns.results ?? []).map((r) => r.id);
  if (oldIds.length === 0) return { deletedRuns: 0, deletedIssues: 0 };

  let deletedIssues = 0;
  for (const oldId of oldIds) {
    const r = await db
      .prepare(`DELETE FROM product_audit_issues WHERE run_id = ?`)
      .bind(oldId)
      .run();
    deletedIssues += (r.meta?.changes as number | undefined) ?? 0;
    await db
      .prepare(`DELETE FROM google_merchant_audit_runs WHERE id = ?`)
      .bind(oldId)
      .run();
  }
  return { deletedRuns: oldIds.length, deletedIssues };
}
