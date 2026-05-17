import { describe, it, expect } from 'vitest';
import {
  PROHIBITED_PHRASES,
  REDACTION_TOKEN,
  redactProhibitedPhrases,
  hasProhibitedPhrases,
} from '@line-crm/ai-provider';

describe('PROHIBITED_PHRASES', () => {
  it('治療系 / 効能系 / 病気系 / 予防系 / 医薬品系 / 英語 全カテゴリを含む', () => {
    // 各カテゴリ代表
    for (const phrase of ['治る', '効く', '病気が改善', '予防できる', '医薬品', 'cure']) {
      expect(PROHIBITED_PHRASES).toContain(phrase);
    }
  });

  it('全て string 型の非空フレーズ (空文字や undefined が混入しない)', () => {
    expect(PROHIBITED_PHRASES.length).toBeGreaterThan(10);
    for (const phrase of PROHIBITED_PHRASES) {
      expect(typeof phrase).toBe('string');
      expect(phrase.length).toBeGreaterThan(0);
    }
  });
});

describe('redactProhibitedPhrases', () => {
  it('NG フレーズ単体を REDACTION_TOKEN に置換する', () => {
    const out = redactProhibitedPhrases('この商品は病気を治す効果があります');
    expect(out.text).toContain(REDACTION_TOKEN);
    expect(out.text).not.toContain('治す');
    expect(out.detectedPhrases).toContain('治す');
  });

  it('複数の NG フレーズを同時に置換する', () => {
    const out = redactProhibitedPhrases('これは医薬品で症状が消える保証があります');
    expect(out.text).not.toContain('医薬品');
    expect(out.text).not.toContain('症状が消える');
    expect(out.text).not.toContain('保証');
    expect(out.detectedPhrases.length).toBeGreaterThanOrEqual(3);
  });

  it('NG フレーズが無い場合は元文字列をそのまま返し、 detected は空', () => {
    const out = redactProhibitedPhrases('健康をサポートするサプリメント');
    expect(out.text).toBe('健康をサポートするサプリメント');
    expect(out.detectedPhrases).toEqual([]);
  });

  it('大文字小文字を不問で英語フレーズも検出する', () => {
    const out = redactProhibitedPhrases('This will Cure your illness');
    expect(out.text).not.toMatch(/cure/i);
    expect(out.detectedPhrases).toContain('cure');
  });
});

describe('hasProhibitedPhrases', () => {
  it('NG フレーズ含有時 true', () => {
    expect(hasProhibitedPhrases('この薬は副作用なしです')).toBe(true);
  });

  it('NG フレーズ無し時 false', () => {
    expect(hasProhibitedPhrases('栄養バランスをサポート')).toBe(false);
  });
});
