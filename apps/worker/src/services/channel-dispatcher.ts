/**
 * ChannelDispatcher (Round 4 PR-3)
 *
 * 役割:
 * - 1 つのメッセージ送信意図 (DispatchInput) を受け取り、
 *   LINE / email / 両方のいずれかへ振り分けて送信する。
 * - 法令ゲート (transactional vs marketing) は本層で判定する。
 *   呼び出し側はテンプレ/メッセージ構築のみに責任を持つ。
 *
 * 設計方針:
 * - **fail-soft**: 1 channel の送信失敗が他 channel をブロックしない。
 * - **decoupled**: LineClient と EmailProvider は **任意 dep**。
 *   片方だけセットされた dispatcher は、もう片方は `skipped:no_client` で帰る。
 * - **observable**: すべての結果は ChannelResult 配列で返す。caller がログる。
 * - **既存テーブル汚染禁止**: email 配信なら email_messages_log にだけ記録、
 *   LINE 配信は既存の cron_run_logs / friends 履歴に従う (本 dispatcher は LINE 履歴更新しない)。
 *
 * v2 スコープ (PR-3):
 * - dispatcher 本体 + テスト
 * - 既存 5 call-site の改修は **channel='line' 固定** で機械置換 (behavior 不変)
 * - PR-6 で channel='email' / 'both' のケースを段階導入
 *
 * 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-3
 */

import type { LineClient } from '@line-crm/line-sdk';
import type { EmailProvider, EmailRenderer, EmailCategory, EmailSourceKind } from '@line-crm/email-sdk';
import {
  getEmailSubscriberByEmail,
  insertEmailLog,
  type EmailSubscriber,
} from '@line-crm/db';

// ============================================================
// 型
// ============================================================

export interface ChannelDispatcherDeps {
  db: D1Database;
  /** LINE 送信を行う場合のみ必須 */
  lineClient?: LineClient;
  /** Email 送信を行う場合のみ必須 (3 つセットで意味を持つ) */
  emailProvider?: EmailProvider;
  emailRenderer?: EmailRenderer;
  /** EMAIL_FROM env (例: "naturism <noreply@mail.naturism-diet.com>") */
  emailFrom?: string;
  /** EMAIL_REPLY_TO env */
  emailReplyTo?: string;
}

export interface DispatchRecipient {
  /** LINE 送信に使う (channel includes 'line' のとき必須) */
  friend?: { id: string; lineUserId: string };
  /** Email 送信に使う (channel includes 'email' のとき必須) */
  email?: string;
  /** 既知の subscriber ID。未指定なら email から lookup */
  subscriberId?: string;
}

/** LINE message オブジェクト (Flex/Text/etc) */
export interface LinePayload {
  messages: unknown[];
}

/** Email テンプレートと変数 (EmailRenderer 入力前段) */
export interface EmailPayload {
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate: string;
  preheader?: string;
  variables: Record<string, string>;
  /** email_messages_log.template_id に記録 (任意) */
  templateId?: string;
}

export type ChannelKind = 'line' | 'email' | 'both';

export interface DispatchInput {
  recipient: DispatchRecipient;
  channel: ChannelKind;
  /** 法令ゲート判定に使う。'transactional' は配信停止後も届く */
  category: EmailCategory;
  /** ログ + KPI 用の起点識別 */
  sourceKind: EmailSourceKind;
  /** channel includes 'line' のとき必須 */
  linePayload?: LinePayload;
  /** channel includes 'email' のとき必須 */
  emailPayload?: EmailPayload;
  /** ログ用の関連 ID */
  source?: {
    orderId?: string;
    broadcastId?: string;
    scenarioStepId?: string;
  };
}

// ============================================================
// 結果型 (discriminated union)
// ============================================================

export type LineSkipReason =
  | 'not_following'
  | 'blacklisted'
  | 'no_friend'
  | 'no_client'
  | 'no_payload';

export type EmailSkipReason =
  | 'no_subscriber'
  | 'unsubscribed'
  | 'inactive_marketing'
  | 'inactive_transactional'
  | 'no_email'
  | 'no_provider'
  | 'no_payload'
  | 'no_renderer';

export type LineResult =
  | { channel: 'line'; status: 'sent' }
  | { channel: 'line'; status: 'skipped'; reason: LineSkipReason }
  | { channel: 'line'; status: 'failed'; error: string };

export type EmailResult =
  | { channel: 'email'; status: 'sent'; providerMessageId: string; subscriberId: string }
  | { channel: 'email'; status: 'skipped'; reason: EmailSkipReason }
  | { channel: 'email'; status: 'failed'; error: string };

export type ChannelResult = LineResult | EmailResult;

export interface DispatchResult {
  results: ChannelResult[];
}

// ============================================================
// 公開 API
// ============================================================

export async function dispatch(
  deps: ChannelDispatcherDeps,
  input: DispatchInput,
): Promise<DispatchResult> {
  const results: ChannelResult[] = [];

  if (input.channel === 'line' || input.channel === 'both') {
    results.push(await sendLine(deps, input));
  }

  if (input.channel === 'email' || input.channel === 'both') {
    results.push(await sendEmail(deps, input));
  }

  return { results };
}

// ============================================================
// LINE 送信
// ============================================================

async function sendLine(
  deps: ChannelDispatcherDeps,
  input: DispatchInput,
): Promise<LineResult> {
  if (!deps.lineClient) {
    return { channel: 'line', status: 'skipped', reason: 'no_client' };
  }
  if (!input.linePayload) {
    return { channel: 'line', status: 'skipped', reason: 'no_payload' };
  }
  if (!input.recipient.friend) {
    return { channel: 'line', status: 'skipped', reason: 'no_friend' };
  }

  // 友だち状態チェック (既存パターンと同じ)
  const friendRow = await deps.db
    .prepare(
      'SELECT is_following, is_blacklisted FROM friends WHERE id = ?',
    )
    .bind(input.recipient.friend.id)
    .first<{ is_following: number; is_blacklisted: number | null }>();

  if (!friendRow) {
    return { channel: 'line', status: 'skipped', reason: 'no_friend' };
  }
  if (friendRow.is_blacklisted) {
    return { channel: 'line', status: 'skipped', reason: 'blacklisted' };
  }
  if (!friendRow.is_following) {
    return { channel: 'line', status: 'skipped', reason: 'not_following' };
  }

  try {
    await deps.lineClient.pushMessage(
      input.recipient.friend.lineUserId,
      input.linePayload.messages as Parameters<LineClient['pushMessage']>[1],
    );
    return { channel: 'line', status: 'sent' };
  } catch (err) {
    return {
      channel: 'line',
      status: 'failed',
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

// ============================================================
// Email 送信
// ============================================================

async function sendEmail(
  deps: ChannelDispatcherDeps,
  input: DispatchInput,
): Promise<EmailResult> {
  if (!deps.emailProvider) {
    return { channel: 'email', status: 'skipped', reason: 'no_provider' };
  }
  if (!deps.emailRenderer) {
    return { channel: 'email', status: 'skipped', reason: 'no_renderer' };
  }
  if (!input.emailPayload) {
    return { channel: 'email', status: 'skipped', reason: 'no_payload' };
  }
  if (!input.recipient.email) {
    return { channel: 'email', status: 'skipped', reason: 'no_email' };
  }

  // subscriber lookup (まず subscriberId、無ければ email でルックアップ)
  let subscriber: EmailSubscriber | null = null;
  if (input.recipient.subscriberId) {
    subscriber = await deps.db
      .prepare(`SELECT * FROM email_subscribers WHERE id = ?`)
      .bind(input.recipient.subscriberId)
      .first<EmailSubscriber>();
  }
  if (!subscriber) {
    subscriber = await getEmailSubscriberByEmail(deps.db, input.recipient.email);
  }
  if (!subscriber) {
    return { channel: 'email', status: 'skipped', reason: 'no_subscriber' };
  }

  // 法令ゲート判定
  const gate = consentGate(subscriber, input.category);
  if (!gate.allowed) {
    // gate.allowed=false の場合 reason は必ず付く (consentGate の post-condition)
    return { channel: 'email', status: 'skipped', reason: gate.reason as EmailSkipReason };
  }

  // テンプレ → HTML/text (失敗時も failed log を残して KPI 整合性を保つ)
  const fromAddress = deps.emailFrom ?? 'noreply@example.invalid';
  let rendered;
  try {
    rendered = await deps.emailRenderer.render({
      subjectTemplate: input.emailPayload.subjectTemplate,
      htmlTemplate: input.emailPayload.htmlTemplate,
      textTemplate: input.emailPayload.textTemplate,
      preheader: input.emailPayload.preheader,
      variables: input.emailPayload.variables,
      subscriberId: subscriber.id,
      category: input.category,
    });
  } catch (err) {
    // render 失敗 (URL 不正 / テンプレ構文エラー等) も failed log に記録
    await safeInsertEmailLog(deps.db, {
      subscriberId: subscriber.id,
      templateId: input.emailPayload.templateId ?? null,
      broadcastId: input.source?.broadcastId ?? null,
      scenarioStepId: input.source?.scenarioStepId ?? null,
      sourceOrderId: input.source?.orderId ?? null,
      sourceKind: input.sourceKind,
      category: input.category,
      subject: input.emailPayload.subjectTemplate.slice(0, 200),
      fromAddress,
      replyTo: deps.emailReplyTo ?? null,
      provider: 'unknown',
      providerMessageId: null,
      status: 'failed',
      errorSummary: `render: ${err instanceof Error ? err.message.slice(0, 480) : 'unknown'}`,
    });
    return {
      channel: 'email',
      status: 'failed',
      error: err instanceof Error ? err.message : 'render failed',
    };
  }

  // provider 送信
  let providerResult;
  try {
    providerResult = await deps.emailProvider.send({
      to: subscriber.email,
      from: fromAddress,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: deps.emailReplyTo,
      headers: {
        'List-Unsubscribe': `<${rendered.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      category: input.category,
      sourceKind: input.sourceKind,
      sourceOrderId: input.source?.orderId,
    });
  } catch (err) {
    // provider 失敗でも email_messages_log に failed として記録 (KPI 計測のため)
    await safeInsertEmailLog(deps.db, {
      subscriberId: subscriber.id,
      templateId: input.emailPayload.templateId ?? null,
      broadcastId: input.source?.broadcastId ?? null,
      scenarioStepId: input.source?.scenarioStepId ?? null,
      sourceOrderId: input.source?.orderId ?? null,
      sourceKind: input.sourceKind,
      category: input.category,
      subject: rendered.subject,
      fromAddress,
      replyTo: deps.emailReplyTo ?? null,
      provider: 'unknown',
      providerMessageId: null,
      status: 'failed',
      errorSummary: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
    });
    return {
      channel: 'email',
      status: 'failed',
      error: err instanceof Error ? err.message : 'unknown',
    };
  }

  // 成功ログ
  await safeInsertEmailLog(deps.db, {
    subscriberId: subscriber.id,
    templateId: input.emailPayload.templateId ?? null,
    broadcastId: input.source?.broadcastId ?? null,
    scenarioStepId: input.source?.scenarioStepId ?? null,
    sourceOrderId: input.source?.orderId ?? null,
    sourceKind: input.sourceKind,
    category: input.category,
    subject: rendered.subject,
    fromAddress,
    replyTo: deps.emailReplyTo ?? null,
    provider: providerResult.provider,
    providerMessageId: providerResult.providerMessageId,
    status: 'sent',
  });

  return {
    channel: 'email',
    status: 'sent',
    providerMessageId: providerResult.providerMessageId,
    subscriberId: subscriber.id,
  };
}

// ============================================================
// helpers
// ============================================================

interface ConsentGateResult {
  allowed: boolean;
  reason?: EmailSkipReason;
}

/**
 * 法令ゲート判定。
 *
 * - marketing: `is_active=1 AND unsubscribed_at IS NULL`
 * - transactional: `transactional_only=1 OR is_active=1`
 *   (= 完全 opt-out 状態 [is_active=0 AND transactional_only=0] のみブロック)
 *
 * 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-3 法令準拠
 */
export function consentGate(
  subscriber: EmailSubscriber,
  category: EmailCategory,
): ConsentGateResult {
  if (category === 'marketing') {
    if (subscriber.unsubscribed_at) {
      return { allowed: false, reason: 'unsubscribed' };
    }
    if (subscriber.is_active !== 1) {
      return { allowed: false, reason: 'inactive_marketing' };
    }
    return { allowed: true };
  }

  // transactional
  if (subscriber.transactional_only !== 1 && subscriber.is_active !== 1) {
    return { allowed: false, reason: 'inactive_transactional' };
  }
  return { allowed: true };
}

/**
 * insertEmailLog の失敗を吸収する wrapper。
 * ログ DB の障害が dispatch 全体を巻き込まないようにする。
 */
async function safeInsertEmailLog(
  db: D1Database,
  input: Parameters<typeof insertEmailLog>[1],
): Promise<void> {
  try {
    await insertEmailLog(db, input);
  } catch (err) {
    console.error(
      '[channel-dispatcher] insertEmailLog failed',
      err instanceof Error ? err.name : 'unknown',
    );
  }
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  consentGate,
};
