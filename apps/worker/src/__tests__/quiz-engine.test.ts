/**
 * Quiz Engine unit tests — 本サイト9問版 (nx-lineup-v2.js ミラー) の採点ロジック
 *
 * Q1,Q3-Q8=加点 / Q2=料理ランキング(1位+2,2位+1,3位+1) / Q9=加点なし(同点処理のみ)
 */

import { describe, it, expect } from 'vitest';
import { scoreQuiz, NATURISM_QUIZ_CONFIG, Q2_CUISINE_TYPE } from '../services/quiz-engine.js';

describe('Quiz Engine — naturism 商品診断 (9問版)', () => {
  it('has 9 questions with q2 as rank kind', () => {
    expect(NATURISM_QUIZ_CONFIG.questions).toHaveLength(9);
    const q2 = NATURISM_QUIZ_CONFIG.questions[1];
    expect(q2.id).toBe('q2');
    expect(q2.kind).toBe('rank');
    expect(q2.options).toEqual(['和食', '中華', '焼肉', 'イタリアン', 'ラーメン／麺類']);
  });

  it('recommends Blue for fatty-food, gut-concerned first-timer', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '揚げ物・脂っこい料理が好き', // blue2 premium2
      q2: ['中華', '焼肉', '和食'], // blue2 + blue1 + pink1
      q3: '体型を維持したい', // pink1 blue2
      q4: '外食・会食がとても多い', // pink1 blue3 premium2
      q5: '食事の量が多くなりがち', // blue2 premium1
      q6: 'ほとんど食べない', // pink2
      q7: 'しっかり運動している', // pink2
      q8: 'まずは手軽に・コスパ重視', // pink1 blue2
      q9: '初めて',
    });
    expect(result.scores).toEqual({ blue: 14, pink: 8, premium: 5 });
    expect(result.recommendedProduct).toBe('naturism Blue');
  });

  it('recommends Pink for beauty-focused user', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: 'バランスを意識', // pink2 blue1
      q2: ['和食', 'イタリアン', '中華'], // pink2 + pink1 + blue1
      q3: '美容のため', // pink1 premium2
      q4: '自炊中心・今の食習慣を保ちたい', // pink1 blue1
      q5: '美容も一緒に考えたい', // pink3
      q6: 'ほとんど食べない', // pink2
      q7: 'しっかり運動している', // pink2
      q8: 'まずは手軽に・コスパ重視', // pink1 blue2
      q9: '飲んだことある',
    });
    expect(result.scores).toEqual({ blue: 5, pink: 15, premium: 2 });
    expect(result.recommendedProduct).toContain('Pink');
  });

  it('recommends Premium for carb-heavy, invest-minded user', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: 'ご飯・パン・麺類が多い', // pink1 premium2
      q2: ['ラーメン／麺類', '中華', '焼肉'], // premium2 + blue1 + blue1
      q3: '体重を落としたい', // blue1 premium2
      q4: '食事の時間が不規則になりがち', // blue2 premium1
      q5: '全体的にケアしたい', // premium3
      q6: 'ほぼ毎日食べる', // blue1 premium3
      q7: 'ほとんど運動しない', // blue1 premium2
      q8: '効果重視でしっかり投資したい', // premium3
      q9: '今飲んでいて別種類を検討中',
    });
    expect(result.scores).toEqual({ blue: 7, pink: 1, premium: 18 });
    expect(result.recommendedProduct).toContain('Premium');
  });

  it('Q2 rank order changes points (1位+2, 2位+1, 3位+1)', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q2: ['中華', '和食', '焼肉'], // 中華1位 blue+2, 和食2位 pink+1, 焼肉3位 blue+1
    });
    expect(result.scores.blue).toBe(3);
    expect(result.scores.pink).toBe(1);
    expect(result.scores.premium).toBe(0);
  });

  it('tie-break: q9=初めて prefers Blue', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, { q9: '初めて' });
    expect(result.scores).toEqual({ blue: 0, pink: 0, premium: 0 });
    expect(result.recommendedProduct).toBe('naturism Blue');
  });

  it('tie-break: q9=別種類検討中 prefers Premium', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, { q9: '今飲んでいて別種類を検討中' });
    expect(result.scores).toEqual({ blue: 0, pink: 0, premium: 0 });
    expect(result.recommendedProduct).toBe('naturism Premium');
  });

  it('tie-break without q9 answer defaults to premium>blue>pink priority', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {});
    expect(result.recommendedProduct).toBe('naturism Premium');
  });

  it('handles partial answers gracefully', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, { q1: 'バランスを意識' });
    expect(result.scores).toEqual({ blue: 1, pink: 2, premium: 0 });
    expect(result.recommendedProduct).toContain('Pink');
  });

  it('ignores malformed values (q2 as string / unknown labels) without crashing', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q2: '和食', // rank 質問に string → 無視
      q3: '存在しない選択肢', // 未知ラベル → 無視
      q9: '初めて',
    });
    expect(result.scores).toEqual({ blue: 0, pink: 0, premium: 0 });
    expect(result.recommendedProduct).toBe('naturism Blue');
  });

  it('every Q2 cuisine maps to a product type', () => {
    const q2 = NATURISM_QUIZ_CONFIG.questions[1];
    for (const cuisine of q2.options as ReadonlyArray<string>) {
      expect(['blue', 'pink', 'premium']).toContain(Q2_CUISINE_TYPE[cuisine]);
    }
  });

  it('returns productInfo with store/compare URLs and reason', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, { q9: '初めて' });
    expect(result.productInfo.storeUrl).toContain('naturism-diet.com/products/');
    expect(result.productInfo.compareUrl).toContain('/pages/compare#nxcp-blue');
    expect(result.reason).toBeTruthy();
  });
});
