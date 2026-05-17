/**
 * send_email automation action ハンドラ (Round 4 PR-6)
 *
 * 役割:
 * - automations / event-bus から呼ばれる `{ type: 'send_email', params: ... }` を実行
 * - friendId → email_subscribers でメールアドレスを解決
 * - ChannelDispatcher (channel='email') でメール送信
 *
 * 設計方針:
 * - **fail-soft**: subscriber 未登録 / consent OFF / provider 失敗 → 無音 skip + log
 *   (LINE 配信が動いてる別 action を巻き込まない)
 * - **template_id 指定 OR 直接 content** の両方に対応
 *   - templateId 指定: email_templates から件名/本文を取得 (将来 PR-7 で UI 編集)
 *   - 直接 content: action.params.subject / htmlContent / textContent
 * - **category デフォルト 'marketing'**: automations は基本マーケ用途
 *   transactional にしたい時は明示指定
 * - **variables**: 現状 friend.display_name のみ自動展開。将来拡張可能。
 *
 * 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-6, services/channel-dispatcher.ts
 */

import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
import {
  buildEmailDispatcherDeps,
  type EmailDispatchConfig,
} from './email-dispatch-config.js';
import type { EmailCategory } from '@line-crm/email-sdk';
import { brandToVariables, getBrandConfigForAccount } from '@line-crm/db';
import { signEmailOptInToken } from './email-opt-in.js';

export interface SendEmailActionParams {
  /** email_templates.id を指定すると DB からテンプレ取得 (subject/htmlContent/textContent 不要) */
  templateId?: string;
  /** 直接指定する場合の件名 */
  subject?: string;
  /** 直接指定する場合の HTML 本文 */
  htmlContent?: string;
  /** 直接指定する場合の text 本文 */
  textContent?: string;
  /** preheader (inbox preview text) */
  preheader?: string;
  /** デフォルト 'marketing'。'transactional' で配信停止後も届く */
  category?: EmailCategory;
  /**
   * Phase 5α-8: caller (event-bus / cron / webhook handler) が template の {{var}}
   * 用に渡す追加変数。 brand 変数 (Phase 5α-9) と friend.name の上に merge され、
   * **同 key があれば caller 側を優先**。
   *
   * 例: {{order_number}} を埋めたい場合、 caller が
   *   { eventVariables: { order_number: String(orderNumber), total_amount: String(totalPrice) } }
   * を渡す。 値は文字列に変換して渡すこと (renderer は string 型しか受けない)。
   *
   * 用途:
   * - automation send_email action: event-bus が payload.eventData を mapping して渡す
   * - Shopify webhook handler: order_paid 等の data を直接渡す
   * - cron handler: scheduled reminder で動的値を埋める
   */
  eventVariables?: Record<string, string>;
}

export interface SendEmailActionContext {
  db: D1Database;
  friendId: string;
  emailConfig: EmailDispatchConfig;
  /**
   * Phase 5β-1d-1: {{opt_in_url}} placeholder の自動 inject 用 config。
   * - 省略時: template の {{opt_in_url}} は literal で残る (旧挙動互換)
   * - 設定時 + template に {{opt_in_url}} 含む + eventVariables.opt_in_url 未設定 → 自動生成
   */
  optInUrlConfig?: {
    hmacKey: string;
    workerUrl: string;
    /** 省略時は service の default (14 日) */
    ttlSeconds?: number;
  };
}

export interface SendEmailActionResult {
  status: 'sent' | 'skipped' | 'failed';
  /** skipped/failed の場合の理由 */
  reason?: string;
  providerMessageId?: string;
}

/**
 * automations / event-bus から呼ばれる send_email アクションのエントリポイント。
 */
export async function executeSendEmailAction(
  ctx: SendEmailActionContext,
  params: SendEmailActionParams,
): Promise<SendEmailActionResult> {
  // 1. friend → email_subscribers 解決
  const subscriber = await ctx.db
    .prepare(
      `SELECT id, email FROM email_subscribers
        WHERE friend_id = ? LIMIT 1`,
    )
    .bind(ctx.friendId)
    .first<{ id: string; email: string }>();

  if (!subscriber) {
    return { status: 'skipped', reason: 'no_subscriber_for_friend' };
  }

  // 2. テンプレ解決 (templateId 指定 OR 直接 content)
  let subject: string;
  let htmlContent: string;
  let textContent: string;
  let preheader: string | undefined;

  if (params.templateId) {
    const tpl = await ctx.db
      .prepare(
        `SELECT subject, html_content, text_content, preheader
           FROM email_templates WHERE id = ? AND is_active = 1`,
      )
      .bind(params.templateId)
      .first<{
        subject: string;
        html_content: string;
        text_content: string;
        preheader: string | null;
      }>();
    if (!tpl) {
      return { status: 'skipped', reason: 'template_not_found' };
    }
    subject = tpl.subject;
    htmlContent = tpl.html_content;
    textContent = tpl.text_content;
    preheader = tpl.preheader ?? undefined;
  } else {
    if (!params.subject || !params.htmlContent || !params.textContent) {
      return { status: 'skipped', reason: 'missing_subject_or_content' };
    }
    subject = params.subject;
    htmlContent = params.htmlContent;
    textContent = params.textContent;
    preheader = params.preheader;
  }

  // 3. friend display_name + brand 値を variables に展開
  // - friend.display_name → {{name}}
  // - brand_config (account-specific or default) → {{brand_name}} {{shop_url}} 等
  // brand 注入は Phase 5α-9 / Ultraplan v4 大方針 2 (汎用性 multi-brand) 対応。
  // friend.line_account_id が NULL なら default brand (= naturism) が返る。
  const friend = await ctx.db
    .prepare(`SELECT display_name, line_account_id FROM friends WHERE id = ? LIMIT 1`)
    .bind(ctx.friendId)
    .first<{ display_name: string | null; line_account_id: string | null }>();
  const brand = await getBrandConfigForAccount(ctx.db, friend?.line_account_id ?? null);
  // Phase 5α-8: variables の merge 順序 (後勝ち)
  //   1. brand_config (brand_name / shop_url 等) - 全送信共通
  //   2. friend.display_name → name
  //   3. caller eventVariables (order_number 等) - イベント由来、 上書き可能
  // この順序で「brand を caller から override 可能」 「event vars が name を override 可能」 にする。
  const variables: Record<string, string> = {
    ...(brand ? brandToVariables(brand) : {}),
    name: friend?.display_name ?? 'お客様',
    ...(params.eventVariables ?? {}),
  };

  // Phase 5β-1d-1: {{opt_in_url}} 自動 inject
  // 条件: template が placeholder を含む + caller が opt_in_url を未指定 + config あり
  // → recipient email から HMAC token 署名済 URL を生成
  const templateMentionsOptInUrl =
    htmlContent.includes('{{opt_in_url}}') || textContent.includes('{{opt_in_url}}');
  if (templateMentionsOptInUrl && variables.opt_in_url === undefined && ctx.optInUrlConfig) {
    try {
      const signed = await signEmailOptInToken(ctx.optInUrlConfig.hmacKey, subscriber.email, {
        ttlSeconds: ctx.optInUrlConfig.ttlSeconds,
      });
      const base = ctx.optInUrlConfig.workerUrl.replace(/\/$/, '');
      variables.opt_in_url = `${base}/email/opt-in?email=${encodeURIComponent(signed.email)}&e=${signed.expiresAt}&token=${signed.token}`;
    } catch (err) {
      // signing 失敗時は inject せず、 template literal が残る (送信は継続)
      // 致命的バグでない限り起きないが、 fail-soft 設計
      console.warn(
        '[send-email-action] opt_in_url 自動 inject 失敗:',
        err instanceof Error ? err.message : String(err),
      );
    }
  } else if (templateMentionsOptInUrl && variables.opt_in_url === undefined && !ctx.optInUrlConfig) {
    console.warn(
      '[send-email-action] template に {{opt_in_url}} があるが optInUrlConfig 未指定 — caller が eventVariables.opt_in_url を渡すか optInUrlConfig を設定すること',
    );
  }

  // 4. dispatcher 経由で送信
  const deps: ChannelDispatcherDeps = {
    db: ctx.db,
    ...buildEmailDispatcherDeps(ctx.emailConfig),
  };

  const result = await dispatch(deps, {
    recipient: { email: subscriber.email, subscriberId: subscriber.id },
    channel: 'email',
    category: params.category ?? 'marketing',
    sourceKind: 'manual', // automations 起点は manual カテゴリで集計
    emailPayload: {
      subjectTemplate: subject,
      htmlTemplate: htmlContent,
      textTemplate: textContent,
      preheader,
      variables,
      templateId: params.templateId,
    },
  });

  const r = result.results[0];
  if (!r || r.channel !== 'email') {
    return { status: 'failed', reason: 'unexpected_dispatcher_result' };
  }
  if (r.status === 'sent') {
    return { status: 'sent', providerMessageId: r.providerMessageId };
  }
  if (r.status === 'skipped') {
    return { status: 'skipped', reason: r.reason };
  }
  return { status: 'failed', reason: r.error };
}
