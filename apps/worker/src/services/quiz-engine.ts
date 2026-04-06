/**
 * 診断クイズエンジン — naturism商品特性ベース
 *
 * ナレッジベース（ai-response.ts）の商品おすすめロジックに完全準拠:
 * - Blue = 脂質カット特化・入門（8成分、¥64/日）
 * - Pink = Blue + 活きた酵素・美容バランス（10成分、¥75/日）
 * - Premium = 全16成分・糖質カット・機能性表示食品（¥149/日）
 *
 * 薬機法準拠: 効能効果の断定表現なし
 */

export interface QuizQuestion {
  readonly id: string;
  readonly text: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly scores: Readonly<Record<string, number>>;
    readonly excludes?: ReadonlyArray<string>; // アレルギー等で除外
  }>;
}

export interface QuizConfig {
  readonly questions: ReadonlyArray<QuizQuestion>;
  readonly products: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly emoji: string;
    readonly price: string;
    readonly components: number;
    readonly reason: string;
    readonly imageUrl?: string;
    readonly storeUrl?: string;
  }>;
}

export interface QuizResult {
  readonly recommendedProduct: string;
  readonly reason: string;
  readonly scores: Record<string, number>;
  readonly productInfo: {
    readonly name: string;
    readonly emoji: string;
    readonly price: string;
    readonly components: number;
    readonly reason: string;
    readonly storeUrl?: string;
  };
  readonly excluded: ReadonlyArray<string>;
}

/**
 * naturism 診断クイズ設定（8問）
 */
export const NATURISM_QUIZ_CONFIG: QuizConfig = {
  products: [
    {
      id: 'blue',
      name: 'naturism Blue',
      emoji: '💙',
      price: '¥64/日〜',
      components: 8,
      reason: '脂質カットに特化したエントリーモデル。11年以上のロングセラーで、シンプルに始めたい方に最適です。アレルギー成分を含まないので安心してお飲みいただけます。',
      storeUrl: 'https://naturism-diet.com',
    },
    {
      id: 'pink',
      name: 'KOSO in naturism Pink',
      emoji: '💗',
      price: '¥75/日〜',
      components: 10,
      reason: 'Blueの8成分に加え、穀物麹由来の活きた酵素360mgを配合。食事ケアと美容を両立したい方のためにデザインされています。',
      storeUrl: 'https://naturism-diet.com',
    },
    {
      id: 'premium',
      name: 'naturism Premium',
      emoji: '🩶',
      price: '¥149/日〜',
      components: 16,
      reason: '全16成分配合のフラッグシップ。白インゲン豆324mg・サラシア・ブラックジンジャーなど糖質対応成分を含む機能性表示食品（届出番号H975）です。',
      storeUrl: 'https://naturism-diet.com',
    },
  ],
  questions: [
    {
      id: 'q1',
      text: 'naturismを試すのは初めてですか？',
      options: [
        { label: '初めてです', scores: { blue: 3, pink: 0, premium: 0 } },
        { label: '飲んだことがあります', scores: { blue: 0, pink: 1, premium: 1 } },
        { label: '今飲んでいて、別の種類を検討中', scores: { blue: 0, pink: 0, premium: 2 } },
      ],
    },
    {
      id: 'q2',
      text: '普段の食事で一番多いのは？',
      options: [
        { label: '揚げ物・脂っこい料理が多い', scores: { blue: 3, pink: 0, premium: 0 } },
        { label: 'ご飯・パン・麺類など炭水化物が中心', scores: { blue: 0, pink: 0, premium: 3 } },
        { label: 'バランスよく食べている', scores: { blue: 0, pink: 2, premium: 0 } },
        { label: '外食やコンビニが中心で偏りがち', scores: { blue: 0, pink: 1, premium: 2 } },
      ],
    },
    {
      id: 'q3',
      text: '一週間でスイーツやお菓子を食べる頻度は？',
      options: [
        { label: 'ほぼ毎日', scores: { blue: 0, pink: 0, premium: 3 } },
        { label: '週3〜4回', scores: { blue: 0, pink: 0, premium: 2 } },
        { label: '週1〜2回', scores: { blue: 1, pink: 1, premium: 0 } },
        { label: 'ほとんど食べない', scores: { blue: 2, pink: 0, premium: 0 } },
      ],
    },
    {
      id: 'q4',
      text: '美容面で気になることはありますか？',
      options: [
        { label: '肌のハリやツヤが気になる', scores: { blue: 0, pink: 3, premium: 0 } },
        { label: '消化が重い・胃もたれしやすい', scores: { blue: 0, pink: 3, premium: 0 } },
        { label: '特に気にならない', scores: { blue: 2, pink: 0, premium: 0 } },
        { label: '全体的にケアしたい', scores: { blue: 0, pink: 0, premium: 2 } },
      ],
    },
    {
      id: 'q5',
      text: '体型管理への本気度は？',
      options: [
        { label: '本格的に取り組みたい', scores: { blue: 0, pink: 0, premium: 3 } },
        { label: '少し意識している程度', scores: { blue: 0, pink: 2, premium: 0 } },
        { label: 'まずは気軽に始めたい', scores: { blue: 3, pink: 0, premium: 0 } },
        { label: '食事制限なしで何かしたい', scores: { blue: 2, pink: 1, premium: 0 } },
      ],
    },
    {
      id: 'q6',
      text: 'アレルギーで気になるものはありますか？',
      options: [
        {
          label: 'オレンジ・キウイ・バナナ・大豆・ゴマ等にアレルギーがある',
          scores: { blue: 5, pink: 0, premium: 0 },
          excludes: ['pink', 'premium'],
        },
        { label: '特にない', scores: { blue: 0, pink: 0, premium: 0 } },
        { label: 'よくわからない', scores: { blue: 1, pink: 0, premium: 0 } },
      ],
    },
    {
      id: 'q7',
      text: '1日あたりの予算はどのくらいをイメージしていますか？',
      options: [
        { label: '¥60〜70くらい（コーヒー1杯分）', scores: { blue: 3, pink: 0, premium: 0 } },
        { label: '¥70〜100くらい', scores: { blue: 0, pink: 3, premium: 0 } },
        { label: '¥100〜150くらい、しっかり投資したい', scores: { blue: 0, pink: 0, premium: 3 } },
        { label: '良いものなら価格は気にしない', scores: { blue: 0, pink: 0, premium: 2 } },
      ],
    },
    {
      id: 'q8',
      text: 'naturismに一番期待することは？',
      options: [
        { label: '毎日の食事のお供としてシンプルに始めたい', scores: { blue: 3, pink: 0, premium: 0 } },
        { label: '美容と食事ケアを両立したい', scores: { blue: 0, pink: 3, premium: 0 } },
        { label: '炭水化物や糖質が気になる食生活を本格サポートしてほしい', scores: { blue: 0, pink: 0, premium: 3 } },
        { label: '食べることを我慢せず、できることから始めたい', scores: { blue: 2, pink: 1, premium: 0 } },
      ],
    },
  ],
};

/**
 * クイズのスコアリング
 * - 各回答で Blue/Pink/Premium にポイント加算
 * - アレルギー該当 → Pink/Premium を除外
 * - 同点の場合: Blue > Pink > Premium（「迷ったらBlue」ルール）
 */
export function scoreQuiz(
  config: QuizConfig,
  answers: Record<string, string>,
): QuizResult {
  const scores: Record<string, number> = {};
  const excluded: string[] = [];

  // Initialize scores
  for (const product of config.products) {
    scores[product.id] = 0;
  }

  // Accumulate scores
  for (const question of config.questions) {
    const answerLabel = answers[question.id];
    if (!answerLabel) continue;

    const option = question.options.find((o) => o.label === answerLabel);
    if (!option) continue;

    for (const [productId, points] of Object.entries(option.scores)) {
      scores[productId] = (scores[productId] ?? 0) + points;
    }

    // Handle excludes (allergens)
    if (option.excludes) {
      for (const excl of option.excludes) {
        if (!excluded.includes(excl)) {
          excluded.push(excl);
        }
      }
    }
  }

  // Zero out excluded products
  for (const excl of excluded) {
    scores[excl] = 0;
  }

  // Find winner (tie-break: Blue > Pink > Premium = order in config)
  let winnerId = config.products[0].id;
  let winnerScore = scores[winnerId] ?? 0;

  for (const product of config.products) {
    const s = scores[product.id] ?? 0;
    if (s > winnerScore) {
      winnerId = product.id;
      winnerScore = s;
    }
  }

  const winner = config.products.find((p) => p.id === winnerId)!;

  return {
    recommendedProduct: winner.name,
    reason: winner.reason,
    scores,
    productInfo: {
      name: winner.name,
      emoji: winner.emoji,
      price: winner.price,
      components: winner.components,
      reason: winner.reason,
      storeUrl: winner.storeUrl,
    },
    excluded,
  };
}
