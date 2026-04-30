/**
 * EmailRenderer (Round 4 PR-1)
 *
 * 役割:
 * - テンプレ HTML / text に法定フッターを **強制注入** (作成者が省略する事故を防ぐ)
 * - List-Unsubscribe ヘッダ用 URL を HMAC token 付きで生成
 * - {{var}} 形式の変数置換 (mustache 風、ネストなし、エスケープなし)
 *
 * 設計方針:
 * - HTML エスケープは呼び出し側責任 (テンプレ作成時に <%- %> 等で扱う前提)。
 *   この renderer はあくまで「テンプレ + 変数 → 完成 HTML」の単純な置換器。
 * - フッターは category ごとに文言が異なる (transactional は配信停止リンク不要、
 *   marketing は必須)。
 * - HMAC token は subscriberId + secret で生成。一方向ハッシュなので逆算不可。
 */

import type { RenderInput, RenderedEmail } from './types.js';

export interface EmailRendererOptions {
  /** 配信停止 URL のベース (例: https://naturism-line-crm.example/email/unsubscribe) */
  unsubscribeBaseUrl: string;
  /** HMAC キー (env 経由で渡す) */
  unsubscribeHmacKey: string;
  /** 法定フッター HTML (株式会社情報、住所等) */
  legalFooterHtml: string;
  /** 法定フッター text (HTML 同等) */
  legalFooterText: string;
}

export class EmailRenderer {
  private readonly opts: EmailRendererOptions;

  constructor(options: EmailRendererOptions) {
    if (!options.unsubscribeBaseUrl || !options.unsubscribeHmacKey) {
      throw new Error('EmailRenderer: unsubscribeBaseUrl and unsubscribeHmacKey are required');
    }
    if (!options.legalFooterHtml || !options.legalFooterText) {
      throw new Error('EmailRenderer: legalFooterHtml and legalFooterText are required');
    }
    this.opts = options;
  }

  async render(input: RenderInput): Promise<RenderedEmail> {
    const subject = applyVars(input.subjectTemplate, input.variables);
    const baseHtml = applyVars(input.htmlTemplate, input.variables);
    const baseText = applyVars(input.textTemplate, input.variables);

    const unsubscribeUrl = await this.buildUnsubscribeUrl(input.subscriberId);

    const html = this.injectFooter(baseHtml, input.preheader, input.category, unsubscribeUrl, 'html');
    const text = this.injectFooter(baseText, input.preheader, input.category, unsubscribeUrl, 'text');

    return { subject, html, text, unsubscribeUrl };
  }

  private async buildUnsubscribeUrl(subscriberId: string): Promise<string> {
    const token = await hmacSha256Hex(this.opts.unsubscribeHmacKey, subscriberId);
    const u = new URL(this.opts.unsubscribeBaseUrl);
    u.searchParams.set('id', subscriberId);
    u.searchParams.set('token', token);
    return u.toString();
  }

  private injectFooter(
    body: string,
    preheader: string | undefined,
    category: 'transactional' | 'marketing',
    unsubscribeUrl: string,
    format: 'html' | 'text',
  ): string {
    if (format === 'html') {
      const preheaderHtml = preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>`
        : '';
      const unsubscribeHtml =
        category === 'marketing'
          ? `<p style="font-size:11px;color:#888;margin-top:24px;text-align:center;">
配信停止は <a href="${unsubscribeUrl}">こちら</a> から</p>`
          : '';
      return [
        preheaderHtml,
        body,
        '<hr style="margin:24px 0;border:none;border-top:1px solid #e0e0e0;">',
        this.opts.legalFooterHtml,
        unsubscribeHtml,
      ]
        .filter(Boolean)
        .join('\n');
    }

    // text
    const unsubscribeText =
      category === 'marketing'
        ? `\n配信停止: ${unsubscribeUrl}\n`
        : '';
    return [body, '\n---\n', this.opts.legalFooterText, unsubscribeText]
      .filter(Boolean)
      .join('\n');
  }
}

// ============================================================
// helpers
// ============================================================

/**
 * mustache 風変数置換 ({{var}})。エスケープしないのでテンプレ作成側で
 * すでに HTML safe な値を入れる前提。
 */
function applyVars(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    return variables[name] ?? '';
  });
}

/**
 * HMAC-SHA256 を hex で返す (Web Crypto API、Cloudflare Workers 互換)。
 */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
