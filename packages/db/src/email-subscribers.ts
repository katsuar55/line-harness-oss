/**
 * email_subscribers CRUD (Round 4 PR-2)
 *
 * 配信対象者の登録 / 解除 / bounce-complaint suppress を担う。
 * email_messages_log とは別テーブル管理 (購読権利と配信履歴を分離)。
 */

import { jstNow } from './utils.js';

export interface EmailSubscriber {
  id: string;
  friend_id: string | null;
  email: string;
  is_active: number;
  transactional_only: number;
  unsubscribed_at: string | null;
  bounce_count: number;
  complaint_count: number;
  consent_source: string | null;
  consent_at: string;
  created_at: string;
  updated_at: string;
}

export type ConsentSource =
  | 'shopify_checkout'
  | 'liff_signup'
  | 'manual_import'
  | 'opt_in_form';

export interface UpsertEmailSubscriberInput {
  email: string;
  friendId?: string | null;
  consentSource?: ConsentSource;
  /** marketing 配信に opt-in しているか (false なら transactional_only=1) */
  marketingOptIn: boolean;
}

const BOUNCE_THRESHOLD = 3;
const COMPLAINT_THRESHOLD = 1;

// ============================================================
// 取得
// ============================================================

export async function getEmailSubscriberById(
  db: D1Database,
  id: string,
): Promise<EmailSubscriber | null> {
  return await db
    .prepare(`SELECT * FROM email_subscribers WHERE id = ?`)
    .bind(id)
    .first<EmailSubscriber>();
}

export async function getEmailSubscriberByEmail(
  db: D1Database,
  email: string,
): Promise<EmailSubscriber | null> {
  return await db
    .prepare(`SELECT * FROM email_subscribers WHERE email = ?`)
    .bind(email)
    .first<EmailSubscriber>();
}

// ============================================================
// upsert
// ============================================================

/**
 * email を主キーとして upsert する。
 *
 * - 既存レコードあり: friend_id / consent_source を上書き、is_active は維持
 * - 新規: marketingOptIn=true なら is_active=1, false なら transactional_only=1
 *
 * 副作用: updated_at を必ず更新する。
 */
export async function upsertEmailSubscriber(
  db: D1Database,
  input: UpsertEmailSubscriberInput,
): Promise<EmailSubscriber> {
  const existing = await getEmailSubscriberByEmail(db, input.email);
  const now = jstNow();

  if (existing) {
    // friend_id と consent_source を patch するが is_active には触らない
    await db
      .prepare(
        `UPDATE email_subscribers
            SET friend_id = COALESCE(?, friend_id),
                consent_source = COALESCE(?, consent_source),
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        input.friendId ?? null,
        input.consentSource ?? null,
        now,
        existing.id,
      )
      .run();
    return (await getEmailSubscriberById(db, existing.id)) as EmailSubscriber;
  }

  // 新規
  const id = crypto.randomUUID();
  const isActive = input.marketingOptIn ? 1 : 0;
  const transactionalOnly = input.marketingOptIn ? 0 : 1;
  await db
    .prepare(
      `INSERT INTO email_subscribers
          (id, friend_id, email, is_active, transactional_only, consent_source,
           consent_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.friendId ?? null,
      input.email,
      isActive,
      transactionalOnly,
      input.consentSource ?? null,
      now,
      now,
      now,
    )
    .run();

  return (await getEmailSubscriberById(db, id)) as EmailSubscriber;
}

// ============================================================
// bounce / complaint 自動抑制
// ============================================================

/**
 * bounce イベント受信時。閾値超えで is_active=0 に。
 * @returns 抑制 (deactivated) されたかどうか
 */
export async function recordBounce(
  db: D1Database,
  email: string,
): Promise<{ bounceCount: number; deactivated: boolean }> {
  const sub = await getEmailSubscriberByEmail(db, email);
  if (!sub) return { bounceCount: 0, deactivated: false };

  const newCount = sub.bounce_count + 1;
  const shouldDeactivate = newCount >= BOUNCE_THRESHOLD && sub.is_active === 1;

  await db
    .prepare(
      `UPDATE email_subscribers
          SET bounce_count = ?,
              is_active = CASE WHEN ? = 1 THEN 0 ELSE is_active END,
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(newCount, shouldDeactivate ? 1 : 0, jstNow(), sub.id)
    .run();

  return { bounceCount: newCount, deactivated: shouldDeactivate };
}

/**
 * complaint (spam 苦情) 受信時。1 回で即 is_active=0 に。
 */
export async function recordComplaint(
  db: D1Database,
  email: string,
): Promise<{ complaintCount: number; deactivated: boolean }> {
  const sub = await getEmailSubscriberByEmail(db, email);
  if (!sub) return { complaintCount: 0, deactivated: false };

  const newCount = sub.complaint_count + 1;
  const shouldDeactivate = newCount >= COMPLAINT_THRESHOLD && sub.is_active === 1;

  await db
    .prepare(
      `UPDATE email_subscribers
          SET complaint_count = ?,
              is_active = CASE WHEN ? = 1 THEN 0 ELSE is_active END,
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(newCount, shouldDeactivate ? 1 : 0, jstNow(), sub.id)
    .run();

  return { complaintCount: newCount, deactivated: shouldDeactivate };
}

// ============================================================
// unsubscribe
// ============================================================

/**
 * 配信停止 (List-Unsubscribe / 解除リンク経由)。
 * is_active=0 + unsubscribed_at 記録。transactional_only は触らない (注文確認等は届けたい)。
 */
export async function unsubscribeById(
  db: D1Database,
  subscriberId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_subscribers
          SET is_active = 0,
              unsubscribed_at = ?,
              updated_at = ?
        WHERE id = ? AND is_active = 1`,
    )
    .bind(jstNow(), jstNow(), subscriberId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * 配信停止解除 (= 再 opt-in)。
 */
export async function resubscribeById(
  db: D1Database,
  subscriberId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE email_subscribers
          SET is_active = 1,
              unsubscribed_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(jstNow(), subscriberId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
