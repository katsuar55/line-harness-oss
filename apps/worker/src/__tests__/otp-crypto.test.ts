/**
 * Tests for otp-crypto (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hmacSha256Hex, constantTimeEqual, generateNumericCode } from '../services/otp-crypto.js';

afterEach(() => vi.restoreAllMocks());

describe('generateNumericCode', () => {
  it('default 6 桁の数字文字列', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateNumericCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('桁数指定が効く', () => {
    expect(generateNumericCode(4)).toMatch(/^\d{4}$/);
    expect(generateNumericCode(8)).toMatch(/^\d{8}$/);
  });

  it('全数字 0-9 が出現しうる (= modulo bias rejection で偏らない)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const ch of generateNumericCode(6)) seen.add(ch);
    }
    // 統計的にほぼ確実に 0-9 全部出る
    expect(seen.size).toBe(10);
  });

  it('bias 範囲 (>=250) を破棄する (= 決定的 rejection 検証)', () => {
    // 250,251 は破棄、 5→"5" / 99→"9"(99%10) / 3→"3"
    const queue = [250, 5, 99, 251, 3];
    let i = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as Uint8Array)[0] = queue[i++];
      return arr as never;
    });
    expect(generateNumericCode(3)).toBe('593');
  });
});

describe('hmacSha256Hex', () => {
  it('64 文字 hex + 決定的', async () => {
    const a = await hmacSha256Hex('key', 'msg');
    const b = await hmacSha256Hex('key', 'msg');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
  });

  it('key / message が変われば変わる', async () => {
    const base = await hmacSha256Hex('key', 'msg');
    expect(await hmacSha256Hex('key2', 'msg')).not.toBe(base);
    expect(await hmacSha256Hex('key', 'msg2')).not.toBe(base);
  });
});

describe('constantTimeEqual', () => {
  it('一致 → true / 不一致 → false / 長さ違い → false', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
