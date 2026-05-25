/**
 * Tests for intent-router.ts (ULTRATHINK fix、 2026-05-26)
 *
 * 範囲:
 *   - detectIntent: 各 keyword pattern → 正しい intent
 *   - 未 match → null
 *   - quiz_invite / price_table / feature_unavailable の出力 Message structure
 *   - 部分一致が広すぎないか (= 「価格」 単独 等は AI 任せに、 「価格教えて」 は intent matched)
 */

import { describe, it, expect } from 'vitest';
import { detectIntent, __test__ } from '../services/intent-router.js';

describe('intent-router — quiz_invite', () => {
  it.each([
    '私におすすめは？',
    '私に合うのはどれ？',
    '私はどれを買えばいい？',
    '初めてでどれを選べばいい?',
    'おすすめ教えて',
    'どれがおすすめ?',
    'どれを選べばいい?',
  ])('matches "%s" → quiz_invite', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('quiz_invite');
    expect(r?.messages).toHaveLength(1);
    expect(r?.messages[0]?.type).toBe('flex');
    if (r?.messages[0]?.type === 'flex') {
      expect(String(r.messages[0].altText)).toContain('診断');
    }
  });
});

describe('intent-router — price_table', () => {
  it.each([
    '価格教えて',
    '価格一覧',
    '価格比較',
    '料金教えて',
    '値段教えて',
    'いくらする',
    '3 種類の価格教えて',
    '3つの価格を教えて',
    'どれが一番安い',
  ])('matches "%s" → price_table', (text) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('price_table');
    expect(r?.messages[0]?.type).toBe('flex');
    if (r?.messages[0]?.type === 'flex') {
      expect(String(r.messages[0].altText)).toContain('価格');
    }
  });

  it('matches short "価格" alone (= 5/26 user feedback、 auto_replies deactivated)', () => {
    // 「価格」 単独でも grid flex で返す = user が「価格」 とだけ送っても見やすい
    const r = detectIntent('価格');
    expect(r?.intent.type).toBe('price_table');
  });

  it('matches "値段" and "料金" short forms', () => {
    expect(detectIntent('値段')?.intent.type).toBe('price_table');
    expect(detectIntent('料金')?.intent.type).toBe('price_table');
  });
});

describe('intent-router — feature_unavailable', () => {
  it.each<[string, string]>([
    ['私の会員ランクは？', '会員ランク'],
    ['マイランク教えて', '会員ランク'],
    ['私のステータスは？', '会員ランク'],
    ['ポイント残高は？', 'ポイント / マイル'],
    ['マイル何個持ってる？', 'ポイント / マイル'],
    ['紹介プログラム教えて', '紹介プログラム'],
    ['友だち紹介で割引ある？', '紹介プログラム'],
    ['アンバサダー制度は？', 'アンバサダープログラム'],
    ['専用バッジある？', '専用バッジ / 称号'],
  ])('matches "%s" → feature_unavailable (%s)', (text, expectedFeature) => {
    const r = detectIntent(text);
    expect(r).not.toBeNull();
    expect(r?.intent.type).toBe('feature_unavailable');
    if (r?.intent.type === 'feature_unavailable') {
      expect(r.intent.feature).toBe(expectedFeature);
    }
    expect(r?.messages[0]?.type).toBe('text');
    if (r?.messages[0]?.type === 'text') {
      expect(r.messages[0].text).toMatch(/近日リリース/);
      expect(r.messages[0].text).toContain(expectedFeature);
    }
  });
});

describe('intent-router — fallthrough (= null for unrelated)', () => {
  it.each([
    'こんにちは',
    'ありがとう',
    'naturism の歴史は?',
    'Blue の成分教えて',
    '飲み方',
    '送料はいくら?',
    '',
    '   ',
  ])('returns null for "%s"', (text) => {
    expect(detectIntent(text)).toBeNull();
  });

  it('returns null for empty/whitespace', () => {
    expect(detectIntent('')).toBeNull();
    expect(detectIntent('   \n  ')).toBeNull();
  });
});

describe('intent-router — priority', () => {
  it('quiz_invite checked before price_table when keywords overlap', () => {
    // 「価格教えて」 vs 「私におすすめ」 が両方含まれる → 上から順なので quiz_invite (= 上位定義) が勝つ
    const r = detectIntent('私におすすめの価格教えて');
    expect(r?.intent.type).toBe('quiz_invite');
  });

  it('returns first matched keyword string for debugging', () => {
    const r = detectIntent('価格教えて、 3 商品の');
    expect(r?.matchedKeyword).toBe('価格教えて');
  });
});

describe('intent-router — constants', () => {
  it('PATTERNS has all 3 intent types covered', () => {
    const types = new Set(__test__.PATTERNS.map((p) => p.intent.type));
    expect(types.has('quiz_invite')).toBe(true);
    expect(types.has('price_table')).toBe(true);
    expect(types.has('feature_unavailable')).toBe(true);
  });

  it('all keywords are non-empty strings', () => {
    for (const p of __test__.PATTERNS) {
      for (const k of p.keywords) {
        expect(typeof k).toBe('string');
        expect(k.length).toBeGreaterThan(0);
      }
    }
  });
});
