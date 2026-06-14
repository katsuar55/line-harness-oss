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
      'http://localhost:3001',
      'http://localhost:3000',
    ]) {
      expect(resolveCorsOrigin(o)).toBe(o);
    }
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
