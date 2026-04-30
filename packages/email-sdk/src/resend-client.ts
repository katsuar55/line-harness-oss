/**
 * Resend API クライアント (Round 4 PR-1)
 *
 * Cloudflare Workers では fetch() のみ使用 (Node SDK は使わない)。
 * https://resend.com/docs/api-reference/emails/send-email
 */

import type { EmailProvider } from './provider.js';
import type { EmailMessage, EmailResult } from './types.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

export interface ResendClientOptions {
  apiKey: string;
  /** fetch 実装 (テスト用 override 可) */
  fetchImpl?: typeof fetch;
  /** API base URL (テスト用 override 可) */
  baseUrl?: string;
}

export class ResendClient implements EmailProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: ResendClientOptions) {
    if (!options.apiKey) {
      throw new Error('ResendClient: apiKey is required');
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? RESEND_API_URL;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const payload: Record<string, unknown> = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };
    if (message.replyTo) {
      payload.reply_to = message.replyTo;
    }
    if (message.headers && Object.keys(message.headers).length > 0) {
      payload.headers = message.headers;
    }
    if (message.tags && message.tags.length > 0) {
      payload.tags = message.tags;
    }

    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Resend send failed: HTTP ${res.status} ${errBody.slice(0, 200)}`);
    }

    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!data || !data.id) {
      throw new Error('Resend send: response missing id');
    }

    return {
      providerMessageId: data.id,
      provider: 'resend',
      sentAt: new Date().toISOString(),
    };
  }
}
