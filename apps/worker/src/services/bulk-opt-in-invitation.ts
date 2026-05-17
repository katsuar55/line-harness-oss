/**
 * Bulk Opt-In Invitation Sender (Phase 5β-1d-1)
 *
 * 役割:
 *   - Shopify 顧客リスト (LINE 友だち未紐付きも含む) に opt-in 招待 transactional email を送信
 *   - 各 recipient 向けに per-email HMAC token 署名 URL を embed
 *   - email_subscribers に transactional_only=1 で pre-register (存在しなければ)
 *   - 既に marketing opted-in な email は skip (再送防止)
 *
 * 設計:
 *   - send-email-action.ts を呼ばずに、 channel-dispatcher を直接使用
 *     (理由: friend_id 必須の send-email-action と違い、 こちらは email 主導)
 *   - dryRun フラグで「送らずに preview」 が可能 (operator 検証用)
 *   - Resend rate limit を考慮し、 caller (admin endpoint) 側で limit を制御
 *
 * 関連: services/email-opt-in.ts (signEmailOptInToken), services/send-email-action.ts (auto-inject pattern)
 */

import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
import {
  buildEmailDispatcherDeps,
  type EmailDispatchConfig,
} from './email-dispatch-config.js';
import { signEmailOptInToken, isValidEmail } from './email-opt-in.js';
import { brandToVariables, getBrandConfigForAccount } from '@line-crm/db';

export interface BulkInvitationRecipient {
  email: string;
  /** 任意: 「{{name}}」 placeholder に使う表示名 (Shopify first_name 等)。 省略時は「お客様」 */
  firstName?: string | null;
}

export interface BulkInvitationConfig {
  emailConfig: EmailDispatchConfig;
  optInUrlConfig: { hmacKey: string; workerUrl: string; ttlSeconds?: number };
}

export type BulkInvitationOutcome =
  | { email: string; status: 'sent'; providerMessageId?: string }
  | { email: string; status: 'skipped'; reason: string }
  | { email: string; status: 'failed'; reason: string };

export interface BulkInvitationResult {
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  details: BulkInvitationOutcome[];
  /** dryRun=true なら details は実際の送信なし (validation + URL 生成までで停止) */
  dryRun: boolean;
}

export interface SendBulkInvitationsInput {
  recipients: BulkInvitationRecipient[];
  /** email_templates.id を指定 (default: 'tpl-opt-in-invitation-v1') */
  templateId?: string;
  /** true なら実送信せず、 各 email の validation + URL 生成までで停止 */
  dryRun?: boolean;
}

const DEFAULT_TEMPLATE_ID = 'tpl-opt-in-invitation-v1';

/**
 * recipients を 1 件ずつ処理。 既に marketing opted-in の email は skip。
 * dryRun=true の場合は実送信せず、 各 email の outcome を「dry_run」 で返す。
 */
export async function sendBulkOptInInvitations(
  db: D1Database,
  config: BulkInvitationConfig,
  input: SendBulkInvitationsInput,
): Promise<BulkInvitationResult> {
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const dryRun = input.dryRun === true;

  // template 1 回だけロード
  const tpl = await db
    .prepare(
      `SELECT subject, html_content, text_content, preheader
         FROM email_templates WHERE id = ? AND is_active = 1`,
    )
    .bind(templateId)
    .first<{
      subject: string;
      html_content: string;
      text_content: string;
      preheader: string | null;
    }>();
  if (!tpl) {
    return {
      total: input.recipients.length,
      sent: 0,
      skipped: 0,
      failed: input.recipients.length,
      details: input.recipients.map((r) => ({
        email: r.email,
        status: 'failed' as const,
        reason: 'template_not_found',
      })),
      dryRun,
    };
  }

  // brand_config (default brand = naturism) を 1 回だけロード
  // multi-brand 対応 (大方針 2): account_id null → default brand_config
  const brand = await getBrandConfigForAccount(db, null); // null = default brand
  const brandVars = brand ? brandToVariables(brand) : {};

  // dispatcher 共有 deps (dryRun でも build しておく — validate 用)
  const deps: ChannelDispatcherDeps | null = dryRun
    ? null
    : {
        db,
        ...buildEmailDispatcherDeps(config.emailConfig),
      };

  const details: BulkInvitationOutcome[] = [];

  for (const recipient of input.recipients) {
    const email = recipient.email.trim().toLowerCase();

    // validate
    if (!isValidEmail(email)) {
      details.push({ email, status: 'skipped', reason: 'invalid_email' });
      continue;
    }

    // 既に marketing opted-in なら skip (重複送信防止)
    const existing = await db
      .prepare(
        `SELECT id, is_active, transactional_only FROM email_subscribers WHERE email = ?`,
      )
      .bind(email)
      .first<{ id: string; is_active: number; transactional_only: number }>();
    if (existing && existing.is_active === 1 && existing.transactional_only === 0) {
      details.push({ email, status: 'skipped', reason: 'already_marketing_opted_in' });
      continue;
    }

    // subscriber 行を find-or-create (transactional_only=1)
    // 既存なら id 再利用、 新規なら INSERT で transactional 配信権を確保
    let subscriberId: string;
    if (existing) {
      subscriberId = existing.id;
    } else {
      subscriberId = crypto.randomUUID();
      try {
        await db
          .prepare(
            `INSERT INTO email_subscribers
              (id, email, is_active, transactional_only, consent_source, consent_at, created_at, updated_at)
            VALUES (?, ?, 0, 1, 'manual_import', ?, ?, ?)`,
          )
          .bind(
            subscriberId,
            email,
            new Date().toISOString(),
            new Date().toISOString(),
            new Date().toISOString(),
          )
          .run();
      } catch (err) {
        details.push({
          email,
          status: 'failed',
          reason: `db_insert_failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    // opt_in_url 署名 (per-recipient)
    let optInUrl: string;
    try {
      const signed = await signEmailOptInToken(config.optInUrlConfig.hmacKey, email, {
        ttlSeconds: config.optInUrlConfig.ttlSeconds,
      });
      const base = config.optInUrlConfig.workerUrl.replace(/\/$/, '');
      optInUrl = `${base}/email/opt-in?email=${encodeURIComponent(signed.email)}&e=${signed.expiresAt}&token=${signed.token}`;
    } catch (err) {
      details.push({
        email,
        status: 'failed',
        reason: `sign_token_failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // variables 構築
    const variables: Record<string, string> = {
      ...brandVars,
      name: recipient.firstName?.trim() || 'お客様',
      opt_in_url: optInUrl,
    };

    if (dryRun) {
      details.push({ email, status: 'sent', providerMessageId: 'dry_run' });
      continue;
    }

    // 実送信 (deps は dryRun=false なら必ず存在)
    try {
      const result = await dispatch(deps!, {
        recipient: { email, subscriberId },
        channel: 'email',
        category: 'transactional', // opt-in 招待は法令上 transactional 扱い
        sourceKind: 'manual',
        emailPayload: {
          subjectTemplate: tpl.subject,
          htmlTemplate: tpl.html_content,
          textTemplate: tpl.text_content,
          preheader: tpl.preheader ?? undefined,
          variables,
          templateId,
        },
      });
      const r = result.results[0];
      if (!r || r.channel !== 'email') {
        details.push({ email, status: 'failed', reason: 'unexpected_dispatcher_result' });
      } else if (r.status === 'sent') {
        details.push({ email, status: 'sent', providerMessageId: r.providerMessageId });
      } else if (r.status === 'skipped') {
        details.push({ email, status: 'skipped', reason: r.reason ?? 'unknown' });
      } else {
        details.push({ email, status: 'failed', reason: r.error ?? 'unknown' });
      }
    } catch (err) {
      details.push({
        email,
        status: 'failed',
        reason: `dispatch_threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    total: input.recipients.length,
    sent: details.filter((d) => d.status === 'sent').length,
    skipped: details.filter((d) => d.status === 'skipped').length,
    failed: details.filter((d) => d.status === 'failed').length,
    details,
    dryRun,
  };
}
