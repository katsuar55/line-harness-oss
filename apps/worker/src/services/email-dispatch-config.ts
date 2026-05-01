/**
 * EmailDispatchConfig — env vars をまとめた email 送信設定
 *
 * 使い方:
 *   const config = buildEmailDispatchConfig(env);
 *   if (!config) return; // RESEND_API_KEY 未設定なら skip
 *   const deps = await buildChannelDispatcherDeps(db, lineClient, config);
 *   await dispatch(deps, input);
 *
 * 設計方針:
 * - すべて optional。`RESEND_API_KEY` が無ければ `null` を返す → email 機能 OFF。
 * - 旧コード (lineAccessToken だけ受け取っていた fireEvent 等) を破壊しない。
 * - 関連: docs/ROUND4_EMAIL_ULTRAPLAN.md §5 PR-6
 */

import {
  ResendClient,
  EmailRenderer,
  type EmailProvider,
} from '@line-crm/email-sdk';
import type { ChannelDispatcherDeps } from './channel-dispatcher.js';

export interface EmailDispatchConfig {
  resendApiKey: string;
  emailFrom: string;
  emailReplyTo?: string;
  emailUnsubscribeBaseUrl: string;
  emailUnsubscribeHmacKey: string;
  emailLegalFooterHtml: string;
  emailLegalFooterText: string;
}

/**
 * 環境変数から EmailDispatchConfig を組み立てる。
 * RESEND_API_KEY が無いか、必須 env が欠けていれば `null`。
 *
 * @param env Worker bindings (typed loosely to avoid circular import)
 */
export function buildEmailDispatchConfig(env: {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_UNSUBSCRIBE_BASE_URL?: string;
  EMAIL_UNSUBSCRIBE_HMAC_KEY?: string;
  EMAIL_LEGAL_FOOTER_HTML?: string;
  EMAIL_LEGAL_FOOTER_TEXT?: string;
}): EmailDispatchConfig | null {
  if (
    !env.RESEND_API_KEY ||
    !env.EMAIL_FROM ||
    !env.EMAIL_UNSUBSCRIBE_BASE_URL ||
    !env.EMAIL_UNSUBSCRIBE_HMAC_KEY ||
    !env.EMAIL_LEGAL_FOOTER_HTML ||
    !env.EMAIL_LEGAL_FOOTER_TEXT
  ) {
    return null;
  }
  return {
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    emailReplyTo: env.EMAIL_REPLY_TO,
    emailUnsubscribeBaseUrl: env.EMAIL_UNSUBSCRIBE_BASE_URL,
    emailUnsubscribeHmacKey: env.EMAIL_UNSUBSCRIBE_HMAC_KEY,
    emailLegalFooterHtml: env.EMAIL_LEGAL_FOOTER_HTML,
    emailLegalFooterText: env.EMAIL_LEGAL_FOOTER_TEXT,
  };
}

/**
 * config から ChannelDispatcher の email 関連 deps を構築する。
 * provider/renderer のインスタンス化はこの関数 1 か所に集約 (= 設定統一)。
 */
export function buildEmailDispatcherDeps(
  config: EmailDispatchConfig,
): Pick<
  ChannelDispatcherDeps,
  'emailProvider' | 'emailRenderer' | 'emailFrom' | 'emailReplyTo'
> {
  const provider: EmailProvider = new ResendClient({
    apiKey: config.resendApiKey,
  });
  const renderer = new EmailRenderer({
    unsubscribeBaseUrl: config.emailUnsubscribeBaseUrl,
    unsubscribeHmacKey: config.emailUnsubscribeHmacKey,
    legalFooterHtml: config.emailLegalFooterHtml,
    legalFooterText: config.emailLegalFooterText,
  });
  return {
    emailProvider: provider,
    emailRenderer: renderer,
    emailFrom: config.emailFrom,
    emailReplyTo: config.emailReplyTo,
  };
}
