/**
 * Quiz Engine unit tests — naturism商品診断クイズ
 *
 * Tests scoring logic for Blue/Pink/Premium recommendations
 * based on naturism knowledge base.
 */

import { describe, it, expect } from 'vitest';
import { scoreQuiz, NATURISM_QUIZ_CONFIG } from '../services/quiz-engine.js';

describe('Quiz Engine — naturism 商品診断', () => {
  it('recommends Blue for first-time, fatty-food user', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '初めてです',
      q2: '揚げ物・脂っこい料理が多い',
      q3: 'ほとんど食べない',
      q4: '特に気にならない',
      q5: 'まずは気軽に始めたい',
      q6: '特にない',
      q7: '¥60〜70くらい（コーヒー1杯分）',
      q8: '毎日の食事のお供としてシンプルに始めたい',
    });
    expect(result.recommendedProduct).toBe('naturism Blue');
    expect(result.scores.blue).toBeGreaterThan(result.scores.pink);
    expect(result.scores.blue).toBeGreaterThan(result.scores.premium);
  });

  it('recommends Pink for beauty-focused user', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '飲んだことがあります',
      q2: 'バランスよく食べている',
      q3: '週1〜2回',
      q4: '肌のハリやツヤが気になる',
      q5: '少し意識している程度',
      q6: '特にない',
      q7: '¥70〜100くらい',
      q8: '美容と食事ケアを両立したい',
    });
    expect(result.recommendedProduct).toContain('Pink');
    expect(result.scores.pink).toBeGreaterThan(result.scores.blue);
  });

  it('recommends Premium for carb-heavy, serious user', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '今飲んでいて、別の種類を検討中',
      q2: 'ご飯・パン・麺類など炭水化物が中心',
      q3: 'ほぼ毎日',
      q4: '全体的にケアしたい',
      q5: '本格的に取り組みたい',
      q6: '特にない',
      q7: '¥100〜150くらい、しっかり投資したい',
      q8: '炭水化物や糖質が気になる食生活を本格サポートしてほしい',
    });
    expect(result.recommendedProduct).toContain('Premium');
    expect(result.scores.premium).toBeGreaterThan(result.scores.blue);
    expect(result.scores.premium).toBeGreaterThan(result.scores.pink);
  });

  it('excludes Pink/Premium when allergens selected, forces Blue', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '飲んだことがあります',
      q2: 'ご飯・パン・麺類など炭水化物が中心',
      q3: 'ほぼ毎日',
      q4: '全体的にケアしたい',
      q5: '本格的に取り組みたい',
      q6: 'オレンジ・キウイ・バナナ・大豆・ゴマ等にアレルギーがある',
      q7: '¥100〜150くらい、しっかり投資したい',
      q8: '炭水化物や糖質が気になる食生活を本格サポートしてほしい',
    });
    // Despite Premium-favoring answers, allergen forces Blue
    expect(result.recommendedProduct).toBe('naturism Blue');
    expect(result.excluded).toContain('pink');
    expect(result.excluded).toContain('premium');
    expect(result.scores.pink).toBe(0);
    expect(result.scores.premium).toBe(0);
  });

  it('tie-breaks to Blue (迷ったらBlue rule)', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {});
    expect(result.recommendedProduct).toBe('naturism Blue');
  });

  it('returns product info with reason and emoji', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '初めてです',
      q8: '毎日の食事のお供としてシンプルに始めたい',
    });
    expect(result.productInfo.emoji).toBe('💙');
    expect(result.productInfo.price).toBe('¥64/日〜');
    expect(result.productInfo.components).toBe(8);
    expect(result.reason).toBeTruthy();
  });

  it('handles partial answers gracefully', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, { q1: '初めてです' });
    expect(result.recommendedProduct).toBeTruthy();
    expect(result.scores).toBeDefined();
  });

  it('Premium reason mentions 機能性表示食品', () => {
    const result = scoreQuiz(NATURISM_QUIZ_CONFIG, {
      q1: '今飲んでいて、別の種類を検討中',
      q2: 'ご飯・パン・麺類など炭水化物が中心',
      q3: 'ほぼ毎日',
      q4: '全体的にケアしたい',
      q5: '本格的に取り組みたい',
      q6: '特にない',
      q7: '¥100〜150くらい、しっかり投資したい',
      q8: '炭水化物や糖質が気になる食生活を本格サポートしてほしい',
    });
    expect(result.reason).toContain('機能性表示食品');
  });
});
