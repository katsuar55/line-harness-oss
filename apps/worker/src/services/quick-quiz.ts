/**
 * Quick Quiz (LINE chat 内 5 質問 diagnose、 Plan A-3、 2026-05-24)
 *
 * 役割:
 *   AI が「おすすめ」 intent を検出 → quick_quiz 招待 flex を reply
 *   user が「診断スタート ▶」 tap → 5 質問 postback chain
 *   全 reply API で push 0 通 (= cost zero design)
 *
 * postback data 形式 (= sessionless、 answers を chain 後段に積む):
 *   - `quick_quiz:start`                  → Q1 reply
 *   - `quick_quiz:a:Aa`                   → Q2 reply (= Q1 答え 'a' を蓄積、 答えは a/b/c/d)
 *   - `quick_quiz:a:AaBb`                 → Q3 reply
 *   - `quick_quiz:a:AaBbCc`               → Q4 reply
 *   - `quick_quiz:a:AaBbCcDd`             → Q5 reply
 *   - `quick_quiz:a:AaBbCcDdEa` (5 答え揃ったら) → 結果 flex reply
 *
 *   答え encoding: 各質問の答えは大文字 (Q1=A/B/C/D, Q2=A/B/C/D, ...、 Q4=A/B、 Q5=A/B/C) を 1 文字で表現
 *   例: 'AaCcAa...' = Q1:A, Q2 だけ a (= 5 chars = 5 question 完了)
 *   → encode を simple にするため、 各 question の答えは大文字 1 char で 'Aa' / 'Ba' 等の "Letter+id" 2 文字
 *
 *   simpler: pos-encoded 1 char per question:
 *     answers chain: 'A'..'D' (Q1) + 'A'..'D' (Q2) + 'A'..'D' (Q3) + 'A'..'B' (Q4) + 'A'..'C' (Q5) = 5 chars
 *   data: `quick_quiz:a:XXXX` (X = answer letter、 累積 1-5 char)
 *
 * 関連:
 *   - apps/worker/src/services/welcome-postback.ts (= postback chain pattern reference)
 *   - apps/worker/src/services/ai-message-builder.ts (= [FMT:quiz_invite] prefix handler)
 *   - apps/worker/src/services/ai-response.ts (= system prompt 「おすすめ」 intent → prefix)
 *   - docs/PLAN_A_3_QUICK_QUIZ_DRAFT.md (= 設計 doc)
 */

import type { LineClient, FlexContainer, Message } from '@line-crm/line-sdk';
import { auditSystem } from './audit-logger.js';

// ============================================================
// 5 質問 config (= 設計 doc 通り)
// ============================================================

export interface QuickQuizQuestion {
  readonly id: number; // 1-5
  readonly text: string;
  readonly options: ReadonlyArray<{ readonly letter: 'A' | 'B' | 'C' | 'D'; readonly label: string }>;
}

export const QUICK_QUIZ_QUESTIONS: ReadonlyArray<QuickQuizQuestion> = [
  {
    id: 1,
    text: 'Q1. 普段の食事の傾向は?',
    options: [
      { letter: 'A', label: '揚げ物・脂っこい料理が好き' },
      { letter: 'B', label: 'ご飯・パン・麺類が多い' },
      { letter: 'C', label: 'バランスを意識' },
      { letter: 'D', label: '外食やコンビニ中心' },
    ],
  },
  {
    id: 2,
    text: 'Q2. 体型管理の目標は?',
    options: [
      { letter: 'A', label: '体重を落としたい' },
      { letter: 'B', label: '体型を維持したい' },
      { letter: 'C', label: '健康のため' },
      { letter: 'D', label: '美容のため' },
    ],
  },
  {
    id: 3,
    text: 'Q3. 美容で気になることは?',
    options: [
      { letter: 'A', label: '肌のハリ・ツヤ' },
      { letter: 'B', label: '消化・胃もたれ' },
      { letter: 'C', label: '全体ケア' },
      { letter: 'D', label: '特になし' },
    ],
  },
  {
    id: 4,
    text: 'Q4. アレルギーで気になるものは?',
    options: [
      { letter: 'A', label: 'オレンジ/キウイ/バナナ/大豆 等あり' },
      { letter: 'B', label: '特にない' },
    ],
  },
  {
    id: 5,
    text: 'Q5. naturism を試すのは?',
    options: [
      { letter: 'A', label: '初めて' },
      { letter: 'B', label: '飲んだことある' },
      { letter: 'C', label: '今飲んでいて別種類を検討中' },
    ],
  },
];

const TOTAL_QUESTIONS = QUICK_QUIZ_QUESTIONS.length;

// ============================================================
// scoring rule (= 設計 doc 通り)
// ============================================================

interface Scores {
  blue: number;
  pink: number;
  premium: number;
}

const SCORING_RULES: Record<number, Record<string, Partial<Scores>>> = {
  1: {
    A: { blue: 3 },
    B: { premium: 3 },
    C: { pink: 2 },
    D: { pink: 1, premium: 2 },
  },
  2: {
    A: { premium: 3 },
    B: { blue: 2, pink: 1 },
    C: { blue: 2, pink: 1 },
    D: { pink: 3 },
  },
  3: {
    A: { pink: 3 },
    B: { pink: 3 },
    C: { premium: 2 },
    D: { blue: 2 },
  },
  4: {
    A: {}, // アレルギーありは別 logic で除外 (= force Blue)
    B: {},
  },
  5: {
    A: { blue: 3 },
    B: { pink: 1, premium: 1 },
    C: { premium: 2 },
  },
};

export type RecommendedProduct = 'Blue' | 'Pink' | 'Premium';

export interface QuickQuizResult {
  readonly recommended: RecommendedProduct;
  readonly scores: Readonly<Scores>;
  readonly excludedDueToAllergy: boolean;
}

/**
 * 5 答え (= 'ABCDA' 等の 5 char string) から推奨商品を計算。
 * 入力長が 5 以外なら throw。
 */
export function scoreQuickQuiz(answersChain: string): QuickQuizResult {
  if (answersChain.length !== TOTAL_QUESTIONS) {
    throw new Error(`expected ${TOTAL_QUESTIONS} answers, got ${answersChain.length}`);
  }
  const scores: Scores = { blue: 0, pink: 0, premium: 0 };
  let excludedDueToAllergy = false;

  for (let i = 0; i < TOTAL_QUESTIONS; i++) {
    const qId = i + 1;
    const letter = answersChain[i];
    const rule = SCORING_RULES[qId]?.[letter];
    if (rule) {
      scores.blue += rule.blue ?? 0;
      scores.pink += rule.pink ?? 0;
      scores.premium += rule.premium ?? 0;
    }
    // Q4 = アレルギー、 'A' なら Pink/Premium 除外 → force Blue
    if (qId === 4 && letter === 'A') {
      excludedDueToAllergy = true;
    }
  }

  // recommended product 判定:
  //   - アレルギーあり → Blue 強制
  //   - else: 最大 score
  //   - tie-break: Blue 優先 (= 「迷ったら Blue」 既存 rule)
  let recommended: RecommendedProduct;
  if (excludedDueToAllergy) {
    recommended = 'Blue';
  } else if (scores.premium > scores.blue && scores.premium > scores.pink) {
    recommended = 'Premium';
  } else if (scores.pink > scores.blue && scores.pink > scores.premium) {
    recommended = 'Pink';
  } else if (scores.pink === scores.premium && scores.pink > scores.blue) {
    // Pink/Premium 同点で Blue 未満なら Pink (= 美容ケア優先)
    recommended = 'Pink';
  } else {
    recommended = 'Blue';
  }

  return { recommended, scores, excludedDueToAllergy };
}

// ============================================================
// postback data parser
// ============================================================

/** postback data = `quick_quiz:start` (start trigger) */
export function isQuickQuizStartPostback(data: string): boolean {
  return data === 'quick_quiz:start';
}

/** postback data = `quick_quiz:a:XXXX` (1-5 char answers chain) → answers string or null */
export function parseQuickQuizAnswers(data: string): string | null {
  const match = /^quick_quiz:a:([A-D]{1,5})$/.exec(data);
  if (!match) return null;
  const chain = match[1];
  // 各 char が valid (= 各質問の選択肢内) かを軽く check
  for (let i = 0; i < chain.length; i++) {
    const qId = i + 1;
    const letter = chain[i];
    if (!SCORING_RULES[qId] || !(letter in SCORING_RULES[qId])) {
      return null;
    }
  }
  return chain;
}

/** dispatch helper: postback data が quick_quiz prefix で start するか */
export function isQuickQuizPostback(data: string): boolean {
  return isQuickQuizStartPostback(data) || data.startsWith('quick_quiz:a:');
}

// ============================================================
// flex builders
// ============================================================

/** invite flex (= AI が「おすすめ」 intent 検出時、 buildAiMessage が返す) */
export function buildQuickQuizInviteFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🌿 あなたにぴったり診断', size: 'md', weight: 'bold', color: '#ffffff', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '5 つの質問で 30 秒で診断できます💚', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '食生活 / 体型 / 美容 / アレルギー / 経験 から、 あなたに最適な naturism を提案します。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'postback', label: '診断スタート ▶', data: 'quick_quiz:start' }, style: 'primary', color: '#06C755', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 質問 flex (= Q1-Q5、 button は postback で次の chain を進める) */
function buildQuestionFlex(question: QuickQuizQuestion, answersSoFar: string): FlexContainer {
  const optionButton = (option: { letter: string; label: string }) => ({
    type: 'button' as const,
    action: {
      type: 'postback' as const,
      label: option.label.length > 20 ? option.label.slice(0, 19) + '…' : option.label,
      data: `quick_quiz:a:${answersSoFar}${option.letter}`,
    },
    style: 'secondary' as const,
    height: 'sm' as const,
  });

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#f0fdf4',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: `🌿 診断 ${question.id} / ${TOTAL_QUESTIONS}`, size: 'xs', weight: 'bold', color: '#15803d', align: 'center' },
        { type: 'text', text: question.text, size: 'sm', weight: 'bold', color: '#1e293b', align: 'center', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      spacing: 'sm',
      contents: question.options.map(optionButton),
    },
  } as unknown as FlexContainer;
}

/** 結果 flex (= 5 答え完了後、 推奨商品 + 公式ストア button) */
function buildResultFlex(result: QuickQuizResult): FlexContainer {
  const productInfo: Record<RecommendedProduct, { emoji: string; name: string; price: string; tagline: string; color: string }> = {
    Blue: { emoji: '🩵', name: 'naturism Blue', price: '¥64/日〜', tagline: 'まずはここから・脂っこい食事が好きな方に', color: '#0ABAB5' },
    Pink: { emoji: '💗', name: 'KOSO in naturism Pink', price: '¥75/日〜', tagline: '美容も気になる方に・活きた酵素配合', color: '#ec4899' },
    Premium: { emoji: '🩶', name: 'naturism Premium', price: '¥149/日〜', tagline: '本気の体型管理に・全 16 成分の最高峰', color: '#64748b' },
  };
  const info = productInfo[result.recommended];

  const allergyNote = result.excludedDueToAllergy
    ? [{ type: 'text' as const, text: '※ アレルギー対応で Blue を推奨しました', size: 'xxs' as const, color: '#92400e', wrap: true, margin: 'sm' as const }]
    : [];

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#06C755',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎁 あなたへのおすすめ', size: 'sm', weight: 'bold', color: '#ffffff', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: `${info.emoji} ${info.name}`, size: 'md', weight: 'bold', color: info.color, align: 'center' },
        { type: 'text', text: info.tagline, size: 'xs', color: '#475569', align: 'center', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: info.price, size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
        { type: 'text', text: '5,500 円以上で送料無料🎁', size: 'xxs', color: '#94a3b8', align: 'center', margin: 'sm' },
        ...allergyNote,
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアで見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に詳しく聞く', text: `${result.recommended} の成分` }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

// ============================================================
// handlers (= 全 replyMessage、 push 0 通)
// ============================================================

/**
 * 'quick_quiz:start' 受信時: Q1 reply。
 */
export async function handleQuickQuizStart(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  replyToken: string,
  lineAccountId: string | null,
): Promise<void> {
  const q1 = QUICK_QUIZ_QUESTIONS[0];
  await lineClient.replyMessage(replyToken, [
    { type: 'flex', altText: q1.text, contents: buildQuestionFlex(q1, '') },
  ]);
  await auditSystem(db, {
    action: 'quick_quiz.start',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { stage: 'q1', api: 'reply' },
  });
}

/**
 * 'quick_quiz:a:XXXX' 受信時:
 *   - 答え 1-4 chars → 次の質問 reply
 *   - 答え 5 chars → 結果 flex reply
 */
export async function handleQuickQuizAnswer(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  replyToken: string,
  lineAccountId: string | null,
  postbackData: string,
): Promise<{ ok: boolean; stage?: string; reason?: string }> {
  const chain = parseQuickQuizAnswers(postbackData);
  if (chain === null) {
    await auditSystem(db, {
      action: 'quick_quiz.invalid_postback',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: `invalid postback: ${postbackData.slice(0, 80)}`,
    });
    return { ok: false, reason: 'invalid_format' };
  }

  if (chain.length < TOTAL_QUESTIONS) {
    // 次の質問
    const nextQ = QUICK_QUIZ_QUESTIONS[chain.length];
    await lineClient.replyMessage(replyToken, [
      { type: 'flex', altText: nextQ.text, contents: buildQuestionFlex(nextQ, chain) },
    ]);
    await auditSystem(db, {
      action: 'quick_quiz.progress',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'success',
      metadata: { stage: `q${chain.length + 1}`, answers: chain, api: 'reply' },
    });
    return { ok: true, stage: `q${chain.length + 1}` };
  }

  // 全 5 答え揃った → 結果 reply
  const result = scoreQuickQuiz(chain);
  await lineClient.replyMessage(replyToken, [
    { type: 'flex', altText: `あなたへのおすすめは ${result.recommended}`, contents: buildResultFlex(result) },
  ]);
  await auditSystem(db, {
    action: 'quick_quiz.completed',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      stage: 'complete',
      answers: chain,
      recommended: result.recommended,
      scores: result.scores,
      excludedDueToAllergy: result.excludedDueToAllergy,
      api: 'reply',
    },
  });
  return { ok: true, stage: 'complete' };
}

// ============================================================
// integration: ai-message-builder で [FMT:quiz_invite] prefix 検出時に invite flex を返す
// (= 実装は ai-message-builder.ts 側)
// ============================================================

/** ai-message-builder.ts から呼出。 「[FMT:quiz_invite]」 prefix 検出時に invite flex Message を返す */
export function buildQuickQuizInviteMessage(): Message {
  return {
    type: 'flex',
    altText: 'naturism おすすめ診断 (30 秒)',
    contents: buildQuickQuizInviteFlex(),
  };
}

// テスト用 export
export const __test__ = {
  SCORING_RULES,
  TOTAL_QUESTIONS,
  buildQuestionFlex,
  buildResultFlex,
};
