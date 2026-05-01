/**
 * Tests for buildEmailDispatchConfig (Round 4 PR-6)
 */

import { describe, it, expect } from 'vitest';
import { buildEmailDispatchConfig } from '../services/email-dispatch-config.js';

const FULL = {
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'naturism <noreply@x.com>',
  EMAIL_REPLY_TO: 'support@x.com',
  EMAIL_UNSUBSCRIBE_BASE_URL: 'https://x.com/email/unsubscribe',
  EMAIL_UNSUBSCRIBE_HMAC_KEY: 'a'.repeat(64),
  EMAIL_LEGAL_FOOTER_HTML: '<p>footer</p>',
  EMAIL_LEGAL_FOOTER_TEXT: 'footer',
};

describe('buildEmailDispatchConfig', () => {
  it('全 env 揃っていれば config を返す', () => {
    const c = buildEmailDispatchConfig(FULL);
    expect(c).not.toBeNull();
    expect(c?.resendApiKey).toBe('re_x');
    expect(c?.emailFrom).toBe('naturism <noreply@x.com>');
    expect(c?.emailReplyTo).toBe('support@x.com');
    expect(c?.emailUnsubscribeBaseUrl).toBe('https://x.com/email/unsubscribe');
  });

  it('RESEND_API_KEY が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, RESEND_API_KEY: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_FROM が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_FROM: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_UNSUBSCRIBE_BASE_URL が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_UNSUBSCRIBE_BASE_URL: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_UNSUBSCRIBE_HMAC_KEY が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_UNSUBSCRIBE_HMAC_KEY: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_LEGAL_FOOTER_HTML が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_LEGAL_FOOTER_HTML: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_LEGAL_FOOTER_TEXT が無いと null', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_LEGAL_FOOTER_TEXT: undefined });
    expect(c).toBeNull();
  });

  it('EMAIL_REPLY_TO は optional (無くても config 返る)', () => {
    const c = buildEmailDispatchConfig({ ...FULL, EMAIL_REPLY_TO: undefined });
    expect(c).not.toBeNull();
    expect(c?.emailReplyTo).toBeUndefined();
  });
});
