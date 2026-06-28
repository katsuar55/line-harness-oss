/**
 * Regression guard (2026-06-29 顧客導線監査 rank 7): マイランクの error card は
 * API の英語生エラーコード (Friend not found / Invalid or expired ID token 等) を
 * そのまま顧客に出さず、日本語固定文言にマップする。未知コードは友好的デフォルト。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'routes', 'liff-my-rank.ts'),
  'utf8',
);

describe('マイランク エラー表示の日本語化 (監査 rank 7)', () => {
  it('localizeError ヘルパが既知の英語コードを日本語にマップ', () => {
    expect(src).toContain('function localizeError');
    expect(src).toContain('Friend not found');
    expect(src).toContain('Invalid or expired ID token');
    expect(src).toContain('同期中');
  });

  it('showError は生コードを直接 textContent せず localizeError を通す', () => {
    const m = src.match(/function showError\([\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('localizeError(msg)');
    // 旧実装の生コード直挿し (textContent = msg) が残っていない
    expect(m![0]).not.toMatch(/textContent\s*=\s*msg\b/);
  });
});
