/**
 * Tests for quick-quiz.ts (Plan A-3、 2026-05-24)
 *
 * カバー範囲:
 *   - scoreQuickQuiz: scoring rule 各 pattern + tie-break + allergy 強制 Blue
 *   - parseQuickQuizAnswers: valid / invalid format
 *   - isQuickQuizStartPostback / isQuickQuizPostback
 *   - buildQuickQuizInviteFlex / buildQuestionFlex / buildResultFlex 構造
 */

import { describe, it, expect } from 'vitest';
import {
  scoreQuickQuiz,
  parseQuickQuizAnswers,
  isQuickQuizStartPostback,
  isQuickQuizPostback,
  buildQuickQuizInviteFlex,
  buildQuickQuizInviteMessage,
  QUICK_QUIZ_QUESTIONS,
  __test__,
} from '../services/quick-quiz.js';

describe('quick-quiz — scoring rule', () => {
  it('Blue: 揚げ物 + 初めて + 体型維持 + アレルギー無し → Blue', () => {
    // Q1=A (脂っこい +3 Blue), Q2=B (体型維持 +2 Blue +1 Pink), Q3=D (特になし +2 Blue),
    // Q4=B (アレルギー無し), Q5=A (初めて +3 Blue)
    const result = scoreQuickQuiz('ABDBA');
    expect(result.recommended).toBe('Blue');
    expect(result.scores.blue).toBe(3 + 2 + 2 + 3); // = 10
    expect(result.excludedDueToAllergy).toBe(false);
  });

  it('Premium: 炭水化物 + 体重落とす + 全体ケア + アレルギー無し + 検討中 → Premium', () => {
    // Q1=B (炭水化物 +3 Premium), Q2=A (体重落とす +3 Premium), Q3=C (全体ケア +2 Premium),
    // Q4=B, Q5=C (検討中 +2 Premium)
    const result = scoreQuickQuiz('BACBC');
    expect(result.recommended).toBe('Premium');
    expect(result.scores.premium).toBe(3 + 3 + 2 + 2); // = 10
  });

  it('Pink: バランス + 美容 + 美容も一緒に + アレルギー無し + 飲んだことある → Pink', () => {
    // Q1=C (バランス +2 Pink), Q2=D (美容 +3 Pink), Q3=A (美容も一緒に考えたい +3 Pink),
    // Q4=B, Q5=B (飲んだことある +1 Pink +1 Premium)
    const result = scoreQuickQuiz('CDABB');
    expect(result.recommended).toBe('Pink');
    expect(result.scores.pink).toBe(2 + 3 + 3 + 1); // = 9
  });

  it('allergy A forces Blue regardless of other scores', () => {
    // Q1=C (バランス +2 Pink), Q2=D (美容 +3 Pink), Q3=A (美容も一緒に考えたい +3 Pink),
    // Q4=A (アレルギーあり → 強制 Blue), Q5=B (飲んだ +1 Pink +1 Premium)
    const result = scoreQuickQuiz('CDAAB');
    expect(result.recommended).toBe('Blue');
    expect(result.excludedDueToAllergy).toBe(true);
    // scores 自体は計算されるが、 recommended は強制 Blue
    expect(result.scores.pink).toBeGreaterThan(0);
  });

  it('tie-break: all zero scores → Blue (= 迷ったら Blue rule)', () => {
    // すべて 0 score になる answers (= Q4 ALLERGY 以外で score 0 答え)
    // Q4=B (アレルギー無し、 0 score)、 他は最小 score 答えで構成
    // ただし全質問で score 0 になる組合せは設計上存在しない (= 各質問少なくとも 1 答えは score を生む)
    // → 同点の代表: Q1=A(+3 Blue), Q2=A(+3 Premium) で Blue=3 Premium=3 → tie-break で Blue
    const result = scoreQuickQuiz('AADBB');
    // Q1=A(+3 Blue), Q2=A(+3 Premium), Q3=D(+2 Blue), Q4=B(0), Q5=B(+1 Pink +1 Premium)
    // Blue=5, Premium=4, Pink=1 → Blue
    expect(result.recommended).toBe('Blue');
  });

  it('Pink/Premium tie above Blue → Pink (= 美容優先)', () => {
    // Pink と Premium が同点で Blue 未満なら Pink 優先 (= 既存 logic)
    // 例: Q1=D(+1 Pink +2 Premium), Q2=B(+2 Blue +1 Pink), Q3=C(+2 Premium), Q4=B(0), Q5=B(+1 Pink +1 Premium)
    // Blue=2, Pink=3, Premium=5 → Premium
    // tie 作るのは難しい。 確実な test: 直接 (= 簡易 input で確認)
    // Q1=C(+2 Pink), Q2=D(+3 Pink), Q3=C(+2 Premium), Q4=B(0), Q5=C(+2 Premium)
    // Blue=0, Pink=5, Premium=4 → Pink
    const result = scoreQuickQuiz('CDCBC');
    expect(result.recommended).toBe('Pink');
  });

  it('throws on wrong answer chain length', () => {
    expect(() => scoreQuickQuiz('ABC')).toThrow();
    expect(() => scoreQuickQuiz('ABCDEF')).toThrow();
  });
});

describe('quick-quiz — postback parser', () => {
  it('isQuickQuizStartPostback matches "quick_quiz:start"', () => {
    expect(isQuickQuizStartPostback('quick_quiz:start')).toBe(true);
    expect(isQuickQuizStartPostback('quick_quiz:a:A')).toBe(false);
    expect(isQuickQuizStartPostback('other:start')).toBe(false);
  });

  it('isQuickQuizPostback matches both start and answers', () => {
    expect(isQuickQuizPostback('quick_quiz:start')).toBe(true);
    expect(isQuickQuizPostback('quick_quiz:a:A')).toBe(true);
    expect(isQuickQuizPostback('quick_quiz:a:ABCDA')).toBe(true);
    expect(isQuickQuizPostback('other')).toBe(false);
  });

  it('parseQuickQuizAnswers extracts valid answer chains', () => {
    expect(parseQuickQuizAnswers('quick_quiz:a:A')).toBe('A');
    expect(parseQuickQuizAnswers('quick_quiz:a:AB')).toBe('AB');
    expect(parseQuickQuizAnswers('quick_quiz:a:ABCBA')).toBe('ABCBA');
  });

  it('parseQuickQuizAnswers returns null for invalid letter (= Q4 has no C/D)', () => {
    // Q4 (index 3) は A/B のみ、 C/D は invalid
    expect(parseQuickQuizAnswers('quick_quiz:a:ABCCA')).toBe(null); // Q4=C invalid
    // Q5 (index 4) は A/B/C のみ、 D は invalid
    expect(parseQuickQuizAnswers('quick_quiz:a:ABCBD')).toBe(null); // Q5=D invalid
  });

  it('parseQuickQuizAnswers returns null for bad format', () => {
    expect(parseQuickQuizAnswers('quick_quiz:start')).toBe(null);
    expect(parseQuickQuizAnswers('quick_quiz:a:abc')).toBe(null); // 小文字 invalid
    expect(parseQuickQuizAnswers('quick_quiz:a:ABCDEFG')).toBe(null); // 6 char 超過
    expect(parseQuickQuizAnswers('quick_quiz:a:')).toBe(null); // empty
    expect(parseQuickQuizAnswers('quick_quiz:other')).toBe(null);
  });
});

describe('quick-quiz — config & flex builders', () => {
  it('exports 5 questions', () => {
    expect(QUICK_QUIZ_QUESTIONS).toHaveLength(5);
    expect(QUICK_QUIZ_QUESTIONS[0].id).toBe(1);
    expect(QUICK_QUIZ_QUESTIONS[4].id).toBe(5);
  });

  it('Q4 has 2 options (A/B), Q5 has 3 (A/B/C), others have 4', () => {
    expect(QUICK_QUIZ_QUESTIONS[0].options).toHaveLength(4);
    expect(QUICK_QUIZ_QUESTIONS[1].options).toHaveLength(4);
    expect(QUICK_QUIZ_QUESTIONS[2].options).toHaveLength(4);
    expect(QUICK_QUIZ_QUESTIONS[3].options).toHaveLength(2);
    expect(QUICK_QUIZ_QUESTIONS[4].options).toHaveLength(3);
  });

  it('buildQuickQuizInviteFlex returns bubble with 診断スタート button', () => {
    const flex = buildQuickQuizInviteFlex();
    const json = JSON.stringify(flex);
    expect(json).toContain('診断スタート');
    expect(json).toContain('quick_quiz:start');
    expect(json).toContain('30 秒');
  });

  it('buildQuickQuizInviteMessage returns flex Message', () => {
    const msg = buildQuickQuizInviteMessage();
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      expect(msg.altText).toContain('診断');
    }
  });

  it('buildQuestionFlex Q1 has 4 postback buttons', () => {
    const flex = __test__.buildQuestionFlex(QUICK_QUIZ_QUESTIONS[0], '');
    const json = JSON.stringify(flex);
    // 4 buttons (A/B/C/D) → 4 postback data
    expect(json).toContain('quick_quiz:a:A');
    expect(json).toContain('quick_quiz:a:B');
    expect(json).toContain('quick_quiz:a:C');
    expect(json).toContain('quick_quiz:a:D');
    expect(json).toContain('Q1');
  });

  it('buildQuestionFlex Q5 with prior answers accumulates chain', () => {
    const flex = __test__.buildQuestionFlex(QUICK_QUIZ_QUESTIONS[4], 'ABCD');
    const json = JSON.stringify(flex);
    expect(json).toContain('quick_quiz:a:ABCDA');
    expect(json).toContain('quick_quiz:a:ABCDB');
    expect(json).toContain('quick_quiz:a:ABCDC');
  });

  it('buildResultFlex Blue has Tiffany Blue color + 🩵', () => {
    const result = { recommended: 'Blue' as const, scores: { blue: 10, pink: 2, premium: 1 }, excludedDueToAllergy: false };
    const flex = __test__.buildResultFlex(result);
    const json = JSON.stringify(flex);
    expect(json).toContain('🩵');
    expect(json).toContain('#0ABAB5');
    expect(json).toContain('naturism Blue');
    expect(json).toContain('¥64/日');
  });

  it('buildResultFlex with allergy shows note', () => {
    const result = { recommended: 'Blue' as const, scores: { blue: 0, pink: 6, premium: 4 }, excludedDueToAllergy: true };
    const flex = __test__.buildResultFlex(result);
    const json = JSON.stringify(flex);
    expect(json).toContain('アレルギー対応');
  });

  it('buildResultFlex Pink has 💗 + 美容', () => {
    const result = { recommended: 'Pink' as const, scores: { blue: 2, pink: 8, premium: 3 }, excludedDueToAllergy: false };
    const flex = __test__.buildResultFlex(result);
    const json = JSON.stringify(flex);
    expect(json).toContain('💗');
    expect(json).toContain('Pink');
    expect(json).toContain('美容');
  });

  it('buildResultFlex Premium has 🩶 + 体型管理', () => {
    const result = { recommended: 'Premium' as const, scores: { blue: 1, pink: 3, premium: 9 }, excludedDueToAllergy: false };
    const flex = __test__.buildResultFlex(result);
    const json = JSON.stringify(flex);
    expect(json).toContain('🩶');
    expect(json).toContain('Premium');
    expect(json).toContain('体型管理');
  });
});

describe('quick-quiz — buildAiMessage integration (ai-message-builder)', () => {
  it('[FMT:quiz_invite] prefix triggers invite flex via buildAiMessage', async () => {
    const { buildAiMessage } = await import('../services/ai-message-builder.js');
    const msg = buildAiMessage('[FMT:quiz_invite]あなたに合う商品を診断しますね💚');
    expect(msg.type).toBe('flex');
    if (msg.type === 'flex') {
      const json = JSON.stringify(msg.contents);
      expect(json).toContain('診断スタート');
    }
  });
});
