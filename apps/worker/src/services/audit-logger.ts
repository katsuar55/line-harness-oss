/**
 * audit-logger service (Phase 5α-3 / Ultraplan v4 大方針 3)
 *
 * 役割:
 *   - 各 route handler / cron / system から呼び出しやすい thin wrapper
 *   - request context (IP, user-agent) 自動抽出
 *   - best-effort: 失敗を caller に伝播しない (logger.warn のみ)
 *
 * 使い方:
 *   // admin endpoint:
 *   await auditAdmin(c, { action: 'broadcast.send', targetType: 'broadcast', targetId: id, after: { ... } });
 *
 *   // system / cron:
 *   await auditSystem(env.DB, { action: 'cron.repurchase_reminder.run', metadata: { processed: 5 } });
 *
 * 関連: packages/db/src/audit-logs.ts
 */

import type { Context } from 'hono';
import {
  insertAuditLog,
  type AuditActorType,
  type AuditResult,
  type InsertAuditLogInput,
} from '@line-crm/db';

/**
 * Hono context から request 情報を抽出 (IP / user-agent)。
 * IP は Cloudflare CF-Connecting-IP ヘッダから取得 → SHA-256 hash で保存。
 */
async function extractRequestContext(
  c: Context,
): Promise<{ ipHash: string | null; userAgent: string | null }> {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? null;
  const userAgent = c.req.header('User-Agent') ?? null;
  const ipHash = ip ? await sha256Hex(ip) : null;
  return { ipHash, userAgent };
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface AuditAdminInput {
  /** 'broadcast.send' / 'friend.delete' 等の dot-notation */
  action: string;
  /** 操作対象 (broadcast / friend / template 等) */
  targetType?: string;
  targetId?: string;
  /** 操作前 snapshot (UPDATE/DELETE の場合に推奨) */
  before?: unknown;
  /** 操作後 snapshot (CREATE/UPDATE で推奨) */
  after?: unknown;
  result?: AuditResult;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  /** admin user 識別 (取得経路は handler 依存) */
  actorId?: string;
  actorName?: string;
  lineAccountId?: string | null;
}

/**
 * admin 操作を記録 (best-effort、 失敗時は console.warn のみ)。
 *
 * @param c Hono Context (IP / user-agent 抽出に使用)
 * @param input 記録内容
 */
export async function auditAdmin(c: Context, input: AuditAdminInput): Promise<void> {
  const env = c.env as { DB: D1Database };
  if (!env?.DB) return;
  try {
    const { ipHash, userAgent } = await extractRequestContext(c);
    const requestId = c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? null;
    await insertAuditLog(env.DB, {
      lineAccountId: input.lineAccountId,
      actorType: 'admin',
      actorId: input.actorId,
      actorName: input.actorName,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId,
      ipHash,
      userAgent,
      before: input.before,
      after: input.after,
      result: input.result,
      errorMessage: input.errorMessage,
      metadata: input.metadata,
    });
  } catch (err) {
    console.warn(
      '[audit-logger] auditAdmin failed:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}

export interface AuditSystemInput {
  /** 'cron.repurchase_reminder.run' / 'webhook.shopify.order_paid' 等 */
  action: string;
  /** デフォルト 'system'。 cron / webhook / api を明示する場合に指定 */
  actorType?: Exclude<AuditActorType, 'admin'>;
  actorId?: string;
  actorName?: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  result?: AuditResult;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  lineAccountId?: string | null;
}

/**
 * system / cron / webhook 起点の操作を記録 (best-effort)。
 * Hono Context が無い場面 (cron handler / queue handler) で使う。
 */
export async function auditSystem(db: D1Database, input: AuditSystemInput): Promise<void> {
  if (!db) return;
  try {
    await insertAuditLog(db, {
      lineAccountId: input.lineAccountId,
      actorType: input.actorType ?? 'system',
      actorId: input.actorId,
      actorName: input.actorName,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      result: input.result,
      errorMessage: input.errorMessage,
      metadata: input.metadata,
    });
  } catch (err) {
    console.warn(
      '[audit-logger] auditSystem failed:',
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    );
  }
}
