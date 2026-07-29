/**
 * 診断クイズエンジン — 本サイト9問版 (2026-07-20オーナー仕様) と完全同一ロジック
 *
 * ⚠️ 設問・選択肢・採点は naturism-shopify-site 側の
 *    theme-dawn/assets/nx-lineup-v2.js / naturism-category.js (9問・同一config) のミラー。
 *    本サイト側を変える時はここ (+ liff-pages.ts のクライアント側ミラー) も同時更新すること。
 *
 * 構成:
 *   Q1, Q3〜Q8 = 単一選択の加点 (blue/pink/premium)
 *   Q2        = 好きな料理ランキング (1位+2, 2位+1, 3位+1 を料理→タイプ対応で加点)
 *   Q9        = 加点なし。同点処理のみ (初めて → blue>pink>premium / それ以外 → premium>blue>pink)
 *
 * 商品情報 (Blue=8成分¥64/日, Pink=10成分¥75/日, Premium=16成分¥149/日) は
 * ナレッジベース (ai-response.ts) と同期。薬機法準拠: 効能効果の断定表現なし。
 */

export type ProductId = 'blue' | 'pink' | 'premium';

export interface QuizSingleOption {
  readonly label: string;
  /** null = 加点なし (Q9) */
  readonly pts: Readonly<Record<ProductId, number>> | null;
}

export interface QuizQuestion {
  readonly id: string; // 'q1'..'q9'
  readonly text: string;
  readonly kind: 'single' | 'rank';
  /** kind='single' → 選択肢オブジェクト / kind='rank' → 料理ラベル */
  readonly options: ReadonlyArray<QuizSingleOption> | ReadonlyArray<string>;
}

export interface QuizConfig {
  readonly questions: ReadonlyArray<QuizQuestion>;
  readonly products: ReadonlyArray<{
    readonly id: ProductId;
    readonly name: string;
    readonly emoji: string;
    readonly price: string;
    readonly components: number;
    readonly reason: string;
    readonly storeUrl?: string;
    readonly compareUrl?: string;
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
    readonly compareUrl?: string;
  };
}

/** Q2: 料理→タイプ対応 (本サイトと同一) */
export const Q2_CUISINE_TYPE: Readonly<Record<string, ProductId>> = {
  和食: 'pink',
  イタリアン: 'pink',
  中華: 'blue',
  焼肉: 'blue',
  'ラーメン／麺類': 'premium',
};

/** Q2: 1位, 2位, 3位 の加点 (本サイトと同一) */
export const Q2_RANK_POINTS: ReadonlyArray<number> = [2, 1, 1];

/**
 * naturism 診断クイズ設定 (9問・本サイト同一)
 */
export const NATURISM_QUIZ_CONFIG: QuizConfig = {
  products: [
    {
      id: 'blue',
      name: 'naturism Blue',
      emoji: '🩵',
      price: '¥64/日〜',
      components: 8,
      reason:
        '脂っこい食事やお通じの悩みが気になるあなたには、黒烏龍茶で「食べたあと」をケアするブルーがぴったり。',
      storeUrl: 'https://naturism-diet.com/products/naturism-blue-180-30days',
      compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-blue',
    },
    {
      id: 'pink',
      name: 'KOSO in naturism Pink',
      emoji: '💗',
      price: '¥75/日〜',
      components: 10,
      reason:
        '美容やバランスを大切にするあなたには、酵素で内側からととのえるピンクがぴったり。',
      storeUrl: 'https://naturism-diet.com/products/koso-in-naturism-pink-180-30days',
      compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-pink',
    },
    {
      id: 'premium',
      name: 'naturism Premium',
      emoji: '🩶',
      price: '¥149/日〜',
      components: 16,
      reason:
        '糖質も脂質もしっかりケアして結果を出したいあなたには、トータルケアのプレミアムがぴったり。',
      storeUrl: 'https://naturism-diet.com/products/naturism-premium-180-20days',
      compareUrl: 'https://naturism-diet.com/pages/compare#nxcp-premium',
    },
  ],
  questions: [
    {
      id: 'q1',
      text: 'Q1. 普段の食事の傾向は?',
      kind: 'single',
      options: [
        { label: '揚げ物・脂っこい料理が好き', pts: { pink: 0, blue: 2, premium: 2 } },
        { label: 'ご飯・パン・麺類が多い', pts: { pink: 1, blue: 0, premium: 2 } },
        { label: 'バランスを意識', pts: { pink: 2, blue: 1, premium: 0 } },
        { label: '外食やコンビニ中心', pts: { pink: 0, blue: 1, premium: 2 } },
      ],
    },
    {
      id: 'q2',
      text: 'Q2. 好きな料理は? 1位〜3位の順にタップしてください',
      kind: 'rank',
      options: ['和食', '中華', '焼肉', 'イタリアン', 'ラーメン／麺類'],
    },
    {
      id: 'q3',
      text: 'Q3. 体型管理の目標は?',
      kind: 'single',
      options: [
        { label: '体重を落としたい', pts: { pink: 0, blue: 1, premium: 2 } },
        { label: '体型を維持したい', pts: { pink: 1, blue: 2, premium: 0 } },
        { label: '健康のため', pts: { pink: 1, blue: 0, premium: 2 } },
        { label: '美容のため', pts: { pink: 1, blue: 0, premium: 2 } },
      ],
    },
    {
      id: 'q4',
      text: 'Q4. お通じ・お腹の悩みは?',
      kind: 'single',
      options: [
        { label: 'よく便秘する・お腹が張る', pts: { pink: 1, blue: 3, premium: 2 } },
        { label: 'たまに便秘・不規則', pts: { pink: 0, blue: 2, premium: 1 } },
        { label: '快調だけど維持したい', pts: { pink: 1, blue: 1, premium: 0 } },
        { label: '特に悩みはない', pts: { pink: 1, blue: 0, premium: 0 } },
      ],
    },
    {
      id: 'q5',
      text: 'Q5. 美容・体で一番気になるのは?',
      kind: 'single',
      options: [
        { label: '肌のハリ・ツヤ', pts: { pink: 3, blue: 0, premium: 0 } },
        { label: '消化・胃もたれ・お腹周り', pts: { pink: 0, blue: 2, premium: 1 } },
        { label: '全体的にケアしたい', pts: { pink: 0, blue: 0, premium: 3 } },
        { label: '特になし', pts: { pink: 1, blue: 0, premium: 0 } },
      ],
    },
    {
      id: 'q6',
      text: 'Q6. 甘いもの・間食の頻度は?',
      kind: 'single',
      options: [
        { label: 'ほぼ毎日食べる', pts: { pink: 0, blue: 1, premium: 3 } },
        { label: '週に数回', pts: { pink: 0, blue: 0, premium: 2 } },
        { label: 'たまに', pts: { pink: 1, blue: 1, premium: 0 } },
        { label: 'ほとんど食べない', pts: { pink: 2, blue: 0, premium: 0 } },
      ],
    },
    {
      id: 'q7',
      text: 'Q7. 運動の習慣は?',
      kind: 'single',
      options: [
        { label: 'ほとんど運動しない', pts: { pink: 0, blue: 1, premium: 2 } },
        { label: '軽く歩く程度', pts: { pink: 1, blue: 1, premium: 0 } },
        { label: '週1〜2回運動する', pts: { pink: 1, blue: 1, premium: 0 } },
        { label: 'しっかり運動している', pts: { pink: 2, blue: 0, premium: 0 } },
      ],
    },
    {
      id: 'q8',
      text: 'Q8. 続けやすさ・価格の考え方は?',
      kind: 'single',
      options: [
        { label: 'まずは手軽に・コスパ重視', pts: { pink: 1, blue: 2, premium: 0 } },
        { label: '効果重視でしっかり投資したい', pts: { pink: 0, blue: 0, premium: 3 } },
        { label: '1日55円〜150円くらいなら特に気にならない', pts: { pink: 1, blue: 0, premium: 2 } },
        { label: '根拠(機能性表示食品など)があるものがいい', pts: { pink: 0, blue: 0, premium: 2 } },
      ],
    },
    {
      id: 'q9',
      text: 'Q9. naturism を試すのは?',
      kind: 'single',
      options: [
        { label: '初めて', pts: null },
        { label: '飲んだことある', pts: null },
        { label: '今飲んでいて別種類を検討中', pts: null },
      ],
    },
  ],
};

/**
 * クイズのスコアリング (本サイト scoreQuiz と同一の決定的ロジック)
 *
 * answers: { q1: '選択肢ラベル', ..., q2: ['和食','中華','焼肉'] (1位→3位), ..., q9: '初めて' }
 * - 未回答の質問はスキップ (partial answers 許容)
 * - 同点処理: q9='初めて' → blue>pink>premium / それ以外 → premium>blue>pink
 */
export function scoreQuiz(
  config: QuizConfig,
  answers: Record<string, string | ReadonlyArray<string>>,
): QuizResult {
  const scores: Record<ProductId, number> = { blue: 0, pink: 0, premium: 0 };

  for (const question of config.questions) {
    const answer = answers[question.id];
    if (answer == null) continue;

    if (question.kind === 'rank') {
      if (!Array.isArray(answer)) continue;
      answer.slice(0, Q2_RANK_POINTS.length).forEach((label, rank) => {
        const type = typeof label === 'string' ? Q2_CUISINE_TYPE[label] : undefined;
        if (type) scores[type] += Q2_RANK_POINTS[rank] ?? 0;
      });
      continue;
    }

    if (typeof answer !== 'string') continue;
    const option = (question.options as ReadonlyArray<QuizSingleOption>).find(
      (o) => o.label === answer,
    );
    if (!option || !option.pts) continue;
    scores.blue += option.pts.blue ?? 0;
    scores.pink += option.pts.pink ?? 0;
    scores.premium += option.pts.premium ?? 0;
  }

  // 同点処理 (決定的): Q9=初めて → blue>pink>premium / それ以外 → premium>blue>pink
  const isFirstTime = answers['q9'] === '初めて';
  const priority: ReadonlyArray<ProductId> = isFirstTime
    ? ['blue', 'pink', 'premium']
    : ['premium', 'blue', 'pink'];
  const max = Math.max(scores.blue, scores.pink, scores.premium);
  const winnerId = priority.find((t) => scores[t] === max) ?? 'blue';

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
      compareUrl: winner.compareUrl,
    },
  };
}
