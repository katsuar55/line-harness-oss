/**
 * CORS origin リゾルバの regression test (Launch-readiness review B5)。
 *
 * 以前は未許可オリジンを verbatim echo しており allowlist が実質無効化されていた。
 * resolveCorsOrigin は未許可オリジンに null を返し、 ブラウザがレスポンスをブロックする。
 */

import { describe, it, expect } from 'vitest';
import { resolveCorsOrigin } from '../index.js';

describe('resolveCorsOrigin', () => {
  it('allows admin / LIFF / localhost origins (echoed back)', () => {
    for (const o of [
      'https://naturism-admin.pages.dev',
      'https://liff.line.me',
      // 独自ドメイン (docs/CUSTOM_DOMAIN_RUNBOOK.md)
      'https://crm.naturism-diet.com',
      'http://localhost:3001',
      'http://localhost:3000',
    ]) {
      expect(resolveCorsOrigin(o)).toBe(o);
    }
  });

  it('独自ドメインの類似ホストは拒否する (サフィックス一致の穴を作らない)', () => {
    expect(resolveCorsOrigin('https://crm.naturism-diet.com.evil.com')).toBeNull();
    expect(resolveCorsOrigin('http://crm.naturism-diet.com')).toBeNull(); // http は不可
    expect(resolveCorsOrigin('https://naturism-diet.com')).toBeNull(); // apex は Shopify
  });

  it('returns "*" when there is no Origin header', () => {
    expect(resolveCorsOrigin(undefined)).toBe('*');
    expect(resolveCorsOrigin(null)).toBe('*');
    expect(resolveCorsOrigin('')).toBe('*');
  });

  it('DENIES unlisted origins (no ACAO echo) — CORS bypass regression', () => {
    expect(resolveCorsOrigin('https://evil.example.com')).toBeNull();
    expect(resolveCorsOrigin('https://naturism-admin.pages.dev.evil.com')).toBeNull();
    expect(resolveCorsOrigin('http://localhost:9999')).toBeNull();
  });
});
