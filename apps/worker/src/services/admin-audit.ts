/**
 * 管理操作の監査記録ヘルパー (2026-07-23 Katsu 指示「誰が何を変更したかが残らない」への対応)。
 *
 * 設計原則 (memory: audit_log 設計原則):
 *   - **append-only / best-effort**: 監査書込の失敗で業務操作を失敗させない (必ず握り潰す)
 *   - **PII 最小化**: 本 helper 自身は生 IP・User-Agent 全文・API キーを保存しない
 *     (IP は salt 付き SHA-256 の先頭 16 hex。無塩だと IPv4 は総当たりで復元できる)。
 *     **before/after に何を入れるかは呼び出し側の責任** — audit_logs は append-only で
 *     後から削除できないため、メール等の PII は呼び出し側で落としてから渡すこと
 *     (例: routes/staff.ts の auditSnapshot)
 *   - actor は authMiddleware が c.set('staff') した本人。env API_KEY fallback の場合は
 *     actorId='env-owner' となり「共有キー経由の操作」であることが後から判別できる
 *
 * action 命名: `admin.<domain>.<verb>` (例 admin.staff.create / admin.faq.update)。
 * 一覧は GET /api/audit-logs?actionPrefix=admin. で引ける。
 */
import type { Context } from 'hono';
import { insertAuditLog } from '@line-crm/db';
import type { Env } from '../index.js';

export interface AdminAuditInput {
  action: string;
  targetType?: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  result?: 'success' | 'failure';
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

/**
 * IP を短いハッシュに (生 IP を保存しない = PII 最小化)。失敗時は null。
 * salt を混ぜる: 無塩 SHA-256 だと IPv4 は 43 億通りの総当たりで復元できるため
 * (採点 LOW)。salt は API_KEY を流用せず専用の固定文字列 + ドメインで導出する。
 */
const IP_HASH_SALT = 'lh-audit-ip-v1:';

async function hashIp(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;
  try {
    const data = new TextEncoder().encode(IP_HASH_SALT + ip);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/**
 * 管理操作を audit_logs に記録する (best-effort — 例外は握り潰す)。
 * 呼び出し側は await するが、失敗しても操作結果に影響しない。
 */
export async function auditAdminAction(
  c: Context<Env>,
  input: AdminAuditInput,
): Promise<void> {
  try {
    const staff = c.get('staff') as { id: string; name: string; role: string } | undefined;
    const ipHash = await hashIp(c.req.header('CF-Connecting-IP'));
    await insertAuditLog(c.env.DB, {
      actorType: 'admin',
      actorId: staff?.id ?? null,
      actorName: staff?.name ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      ipHash,
      userAgent: (c.req.header('User-Agent') ?? '').slice(0, 200) || null,
      ...(input.before !== undefined ? { before: input.before } : {}),
      ...(input.after !== undefined ? { after: input.after } : {}),
      result: input.result ?? 'success',
      errorMessage: input.errorMessage ?? null,
      metadata: { role: staff?.role ?? 'unknown', ...(input.metadata ?? {}) },
    });
  } catch (e: unknown) {
    // 監査失敗で業務操作を落とさない (append-only / best-effort 原則)
    console.error(`admin-audit: failed to record ${input.action}: ${e instanceof Error ? e.message : e}`);
  }
}
