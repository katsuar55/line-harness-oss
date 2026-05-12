/**
 * audit_logs DB layer (Phase 5α-3 / Ultraplan v4 大方針 3)
 *
 * 役割:
 *   - destructive / 重要操作の append-only 記録
 *   - admin / system / cron / webhook / api アクター区別
 *   - 5η RBAC 強化、 GDPR エクスポート、 トラブルシューティングの基盤
 *
 * 設計方針:
 *   - **append-only**: insertAuditLog のみ (UPDATE/DELETE 関数提供しない、 運用ルールで担保)
 *   - **best-effort**: 書き込み失敗を caller に伝播しない (logger 経由)。 caller は別途 throw
 *   - **PII 最小化**: ipHash は呼び出し側で SHA-256 化済の値を渡す前提
 *   - **JSON snapshot**: before/after は呼び出し側で JSON.stringify 済の文字列を渡す
 *
 * 関連: packages/db/migrations/048_audit_logs.sql
 *       apps/worker/src/services/audit-logger.ts (helper / context 取得)
 */

import { jstNow } from './utils.js';

export type AuditActorType = 'admin' | 'system' | 'cron' | 'webhook' | 'api';
export type AuditResult = 'success' | 'failure';

export interface AuditLog {
  id: string;
  line_account_id: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip_hash: string | null;
  user_agent: string | null;
  before_value: string | null;
  after_value: string | null;
  result: AuditResult;
  error_message: string | null;
  metadata: string;
  created_at: string;
}

export interface InsertAuditLogInput {
  lineAccountId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  /** 任意の object を JSON で snapshot (destructive 操作で推奨) */
  before?: unknown;
  /** 任意の object を JSON で snapshot */
  after?: unknown;
  result?: AuditResult;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * audit_log を 1 件 INSERT。 失敗時は throw (caller 側で best-effort wrap 推奨)。
 *
 * @returns 挿入された audit log row
 */
export async function insertAuditLog(
  db: D1Database,
  input: InsertAuditLogInput,
): Promise<AuditLog> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const beforeJson = input.before === undefined ? null : JSON.stringify(input.before);
  const afterJson = input.after === undefined ? null : JSON.stringify(input.after);
  const metadataJson = JSON.stringify(input.metadata ?? {});

  await db
    .prepare(
      `INSERT INTO audit_logs (
        id, line_account_id, actor_type, actor_id, actor_name, action,
        target_type, target_id, request_id, ip_hash, user_agent,
        before_value, after_value, result, error_message, metadata, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.actorName ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.requestId ?? null,
      input.ipHash ?? null,
      input.userAgent ?? null,
      beforeJson,
      afterJson,
      input.result ?? 'success',
      input.errorMessage ?? null,
      metadataJson,
      now,
    )
    .run();

  const result = await db
    .prepare(`SELECT * FROM audit_logs WHERE id = ?`)
    .bind(id)
    .first<AuditLog>();
  if (!result) throw new Error(`insertAuditLog: failed to read back id=${id}`);
  return result;
}

export interface QueryAuditLogsInput {
  lineAccountId?: string | null;
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  /** like 'broadcast.%' (prefix match) */
  actionPrefix?: string;
  targetType?: string;
  targetId?: string;
  result?: AuditResult;
  /** ISO datetime, 含む */
  since?: string;
  /** ISO datetime, 含まない */
  until?: string;
  /** 最大 1000 (admin UI 表示) */
  limit?: number;
  offset?: number;
}

/**
 * audit_log を timeline 順 (created_at DESC) で取得。 admin UI 用。
 * limit はデフォルト 100、 最大 1000。
 */
export async function queryAuditLogs(
  db: D1Database,
  input: QueryAuditLogsInput = {},
): Promise<AuditLog[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (input.lineAccountId !== undefined) {
    conditions.push('line_account_id IS ?');
    values.push(input.lineAccountId ?? null);
  }
  if (input.actorType) {
    conditions.push('actor_type = ?');
    values.push(input.actorType);
  }
  if (input.actorId) {
    conditions.push('actor_id = ?');
    values.push(input.actorId);
  }
  if (input.action) {
    conditions.push('action = ?');
    values.push(input.action);
  }
  if (input.actionPrefix) {
    conditions.push('action LIKE ?');
    values.push(`${input.actionPrefix.replace(/[%_]/g, '\\$&')}%`);
  }
  if (input.targetType) {
    conditions.push('target_type = ?');
    values.push(input.targetType);
  }
  if (input.targetId) {
    conditions.push('target_id = ?');
    values.push(input.targetId);
  }
  if (input.result) {
    conditions.push('result = ?');
    values.push(input.result);
  }
  if (input.since) {
    conditions.push('created_at >= ?');
    values.push(input.since);
  }
  if (input.until) {
    conditions.push('created_at < ?');
    values.push(input.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const offset = Math.max(input.offset ?? 0, 0);

  const result = await db
    .prepare(
      `SELECT * FROM audit_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...values, limit, offset)
    .all<AuditLog>();
  return result.results;
}

/** count (pagination 用) */
export async function countAuditLogs(
  db: D1Database,
  input: QueryAuditLogsInput = {},
): Promise<number> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (input.lineAccountId !== undefined) {
    conditions.push('line_account_id IS ?');
    values.push(input.lineAccountId ?? null);
  }
  if (input.actorType) {
    conditions.push('actor_type = ?');
    values.push(input.actorType);
  }
  if (input.actorId) {
    conditions.push('actor_id = ?');
    values.push(input.actorId);
  }
  if (input.action) {
    conditions.push('action = ?');
    values.push(input.action);
  }
  if (input.actionPrefix) {
    conditions.push('action LIKE ?');
    values.push(`${input.actionPrefix.replace(/[%_]/g, '\\$&')}%`);
  }
  if (input.targetType) {
    conditions.push('target_type = ?');
    values.push(input.targetType);
  }
  if (input.targetId) {
    conditions.push('target_id = ?');
    values.push(input.targetId);
  }
  if (input.result) {
    conditions.push('result = ?');
    values.push(input.result);
  }
  if (input.since) {
    conditions.push('created_at >= ?');
    values.push(input.since);
  }
  if (input.until) {
    conditions.push('created_at < ?');
    values.push(input.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs ${where}`)
    .bind(...values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
