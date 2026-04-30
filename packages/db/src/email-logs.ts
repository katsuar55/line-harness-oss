/**
 * email_messages_log CRUD (Round 4 PR-2)
 *
 * 配信履歴 + Phase 6 連携追跡 (source_order_id / source_kind / category)。
 * Resend webhook 受信時に provider_message_id で照合し status を更新する。
 */

import { jstNow } from './utils.js';

export type EmailLogStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'bounced'
  | 'complained'
  | 'failed';

export type EmailSourceKind =
  | 'reorder'
  | 'cross_sell'
  | 'broadcast'
  | 'transactional'
  | 'manual';

export type EmailCategory = 'transactional' | 'marketing';

export interface EmailMessageLog {
  id: string;
  subscriber_id: string;
  template_id: string | null;
  broadcast_id: string | null;
  scenario_step_id: string | null;
  source_order_id: string | null;
  source_kind: string;
  category: string;
  subject: string;
  from_address: string;
  reply_to: string | null;
  provider: string;
  provider_message_id: string | null;
  status: string;
  error_summary: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  first_opened_at: string | null;
  last_event_at: string | null;
  open_count: number;
  click_count: number;
  created_at: string;
}

export interface InsertEmailLogInput {
  subscriberId: string;
  templateId?: string | null;
  broadcastId?: string | null;
  scenarioStepId?: string | null;
  sourceOrderId?: string | null;
  sourceKind: EmailSourceKind;
  category: EmailCategory;
  subject: string;
  fromAddress: string;
  replyTo?: string | null;
  provider: string;
  providerMessageId?: string | null;
  status?: EmailLogStatus;
  errorSummary?: string | null;
}

// ============================================================
// 取得
// ============================================================

export async function getEmailLogById(
  db: D1Database,
  id: string,
): Promise<EmailMessageLog | null> {
  return await db
    .prepare(`SELECT * FROM email_messages_log WHERE id = ?`)
    .bind(id)
    .first<EmailMessageLog>();
}

export async function getEmailLogByProviderId(
  db: D1Database,
  provider: string,
  providerMessageId: string,
): Promise<EmailMessageLog | null> {
  return await db
    .prepare(
      `SELECT * FROM email_messages_log
         WHERE provider = ? AND provider_message_id = ?`,
    )
    .bind(provider, providerMessageId)
    .first<EmailMessageLog>();
}

// ============================================================
// 挿入
// ============================================================

export async function insertEmailLog(
  db: D1Database,
  input: InsertEmailLogInput,
): Promise<EmailMessageLog> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO email_messages_log
          (id, subscriber_id, template_id, broadcast_id, scenario_step_id,
           source_order_id, source_kind, category, subject, from_address, reply_to,
           provider, provider_message_id, status, error_summary, sent_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.subscriberId,
      input.templateId ?? null,
      input.broadcastId ?? null,
      input.scenarioStepId ?? null,
      input.sourceOrderId ?? null,
      input.sourceKind,
      input.category,
      input.subject,
      input.fromAddress,
      input.replyTo ?? null,
      input.provider,
      input.providerMessageId ?? null,
      input.status ?? 'queued',
      input.errorSummary ?? null,
      input.status === 'sent' || input.status === 'delivered' ? now : null,
      now,
    )
    .run();

  return (await getEmailLogById(db, id)) as EmailMessageLog;
}

// ============================================================
// 状態更新 (Resend webhook 受信時に呼ばれる)
// ============================================================

export interface UpdateEmailLogStatusInput {
  provider: string;
  providerMessageId: string;
  newStatus: EmailLogStatus;
  errorSummary?: string;
  /** クリック / 開封の場合は累計をインクリメント */
  incrementOpenCount?: boolean;
  incrementClickCount?: boolean;
}

/**
 * 状態を更新する。各タイムスタンプ列も合わせて埋める。
 *
 * - delivered_at は status='delivered' で初回のみ
 * - first_opened_at は status='opened' で初回のみ
 * - last_event_at は常に更新
 *
 * @returns 更新された行があれば true
 */
export async function updateEmailLogStatus(
  db: D1Database,
  input: UpdateEmailLogStatusInput,
): Promise<boolean> {
  const log = await getEmailLogByProviderId(db, input.provider, input.providerMessageId);
  if (!log) return false;

  const now = jstNow();
  const updates: string[] = ['status = ?', 'last_event_at = ?'];
  const params: unknown[] = [input.newStatus, now];

  if (input.newStatus === 'delivered' && !log.delivered_at) {
    updates.push('delivered_at = ?');
    params.push(now);
  }
  if (input.newStatus === 'opened' && !log.first_opened_at) {
    updates.push('first_opened_at = ?');
    params.push(now);
  }
  if (input.errorSummary !== undefined) {
    updates.push('error_summary = ?');
    params.push(input.errorSummary);
  }
  if (input.incrementOpenCount) {
    updates.push('open_count = open_count + 1');
  }
  if (input.incrementClickCount) {
    updates.push('click_count = click_count + 1');
  }

  params.push(log.id);
  const sql = `UPDATE email_messages_log SET ${updates.join(', ')} WHERE id = ?`;

  const result = await db.prepare(sql).bind(...params).run();
  return (result.meta.changes ?? 0) > 0;
}

// ============================================================
// link click 記録
// ============================================================

export async function recordEmailClick(
  db: D1Database,
  emailLogId: string,
  url: string,
  options: { userAgent?: string; ipHash?: string } = {},
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO email_link_clicks (id, email_log_id, url, user_agent, ip_hash)
        VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, emailLogId, url, options.userAgent ?? null, options.ipHash ?? null)
    .run();
}
