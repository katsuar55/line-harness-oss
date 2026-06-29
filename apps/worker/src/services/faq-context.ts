/**
 * AI system prompt の「よくある質問（FAQ）」 セクションを D1 (faq_items) から動的生成する。
 *
 * 設計 (2026-06-30 FAQ動的化 PR1):
 *   - 旧実装は ai-response.ts の buildSystemPrompt に 21 件の FAQ をハードコードしていた
 *     (= 追加・修正に deploy が必須、 AI が知らない質問は「サポートへ」 で離脱)。
 *   - faq_items (migration 029 で本番に既存・管理画面から編集可) を AI prompt に注入し、
 *     運用者が deploy なしに FAQ を増やせるようにする。
 *   - **fail-safe**: faq_items が空 (= 未 seed) / 読込エラー (= テーブル欠落含む) の場合は
 *     DEFAULT_FAQ_ENTRIES (旧ハードコードと同一内容) を使う。 これにより本番が未 seed でも
 *     従来挙動を完全に保つ (= live-safe、 seed 投入で初めて動的化)。
 *
 * 薬機法: DEFAULT_FAQ_ENTRIES は現行 prompt の FAQ をそのまま移植したもの (文言変更なし)。
 */

import { listActiveFaqItems } from '@line-crm/db';

export interface FaqEntry {
  /** 「Q.」 と 「→」 を除いた質問本文 (末尾の「？」 は含む)。 */
  question: string;
  answer: string;
  /** 管理画面のグルーピング用。 prompt 出力には影響しない。 */
  category: string;
}

/**
 * 現行 (2026-06-30 まで) の AI prompt にハードコードされていた FAQ 21 件。
 * faq_items の seed ソース兼、 動的読込に失敗したときの fallback として使う。
 * 文言は薬機法配慮済の既存内容をそのまま維持する (本 PR では変更しない)。
 */
export const DEFAULT_FAQ_ENTRIES: ReadonlyArray<FaqEntry> = [
  { category: 'usage', question: '飲み方は？', answer: 'Blue/Pinkは食事中〜食直後に2〜3粒を水で。Premiumは食直前に3〜4粒を水で。噛まずにお飲みください' },
  { category: 'usage', question: 'いつ飲むのが良い？', answer: '毎食時がおすすめ。特にカロリーが気になるお食事の際に' },
  { category: 'usage', question: '飲み忘れたら？', answer: '次の食事時に通常量をお飲みください。まとめ飲みはお控えください' },
  { category: 'usage', question: '保存方法は？', answer: '高温多湿・直射日光を避け涼しい場所で保管。開封後はチャックをしっかり閉じてください。賞味期限は製造から約30ヶ月' },
  { category: 'usage', question: '粒の色が違う？', answer: '天然由来素材のため収穫時期により色味が異なることがあります。品質に問題はありません' },
  { category: 'allergy', question: 'アレルギーは？', answer: 'Pink/Premiumにオレンジ、キウイ、バナナ、リンゴ、大豆、ゴマ、カシューナッツ含有。Blueは上記アレルゲンを含みません' },
  { category: 'allergy', question: '妊娠中・授乳中は？', answer: 'かかりつけの医師にご相談のうえご判断ください' },
  { category: 'allergy', question: '薬と併用できる？', answer: 'お薬を服用中の方は、かかりつけの医師・薬剤師にご相談ください' },
  { category: 'allergy', question: '子どもが飲んでも良い？', answer: '大人向けに設計された商品です。お子様への使用は医師にご相談ください' },
  { category: 'usage', question: 'お腹がゆるくなった', answer: '天然成分の作用で一時的にゆるくなる場合があります。粒数を減らしてお試しください。続く場合は使用を中止し医師へ' },
  { category: 'product', question: 'ヴィーガン対応？', answer: 'はい。天然由来成分のみ使用、動物性原料不使用です' },
  { category: 'product', question: '国産？', answer: 'はい。すべて日本国内のGMP対応工場で製造しています' },
  { category: 'shipping', question: 'ドンキで買える？', answer: 'はい。全国のドン・キホーテで販売中です' },
  { category: 'subscription', question: '定期便の解約は？', answer: '回数縛りなし。マイページから24時間いつでも解約・スキップ・変更できます（出荷準備完了後は次回お届け分から適用）' },
  { category: 'shipping', question: '送料は？', answer: '5,500円(税込)以上で送料無料。メール便ゆうパケット220円、宅配便ヤマト運輸550円。7日分〜100日分は送料無料' },
  { category: 'return', question: '返品できる？', answer: '食品のため原則お客様都合の返品はお受けできません。ただし対象3商品の初回購入は14日以内のご連絡で全額返金保証、不良品・配送破損は10日以内のご連絡で対応します' },
  { category: 'shipping', question: 'いつ届く？', answer: '平日12時までのご注文は原則当日発送（在庫がある場合）。12時以降・土日祝・年末年始は翌営業日発送' },
  { category: 'support', question: '営業時間は？', answer: 'お問い合わせ受付は平日10:00〜17:00（土日祝・年末年始を除く）。電話 03-6411-5513' },
  { category: 'product', question: '1日いくら？', answer: 'Blue約¥64/日、Pink約¥75/日、Premium約¥149/日' },
  { category: 'usage', question: 'どのくらい続ければ？', answer: '個人差がありますが、毎日の習慣として3ヶ月程度の継続をおすすめしています' },
  { category: 'product', question: '芸能人は？', answer: 'Kep1er（公式ミューズ）、ウィニー・ハーロウ、藤井夏恋、明日花キララ、田中里奈ほか' },
];

const FAQ_HEADER = '## よくある質問（FAQ）';

/**
 * FAQ エントリ配列を prompt セクション文字列に整形する。
 * 形式は現行ハードコードと同一: 「Q.{question}→ {answer}」 を改行区切り。
 */
export function buildFaqSection(entries: ReadonlyArray<FaqEntry>): string {
  if (entries.length === 0) return buildFaqSection(DEFAULT_FAQ_ENTRIES);
  const lines = entries.map((e) => `Q.${e.question}→ ${e.answer}`);
  return `${FAQ_HEADER}\n${lines.join('\n')}`;
}

/** DEFAULT_FAQ_ENTRIES から生成した固定セクション (= fallback / buildSystemPrompt の既定値)。 */
export function getDefaultFaqSection(): string {
  return buildFaqSection(DEFAULT_FAQ_ENTRIES);
}

/**
 * D1 の faq_items (is_active=1) から FAQ セクションを生成する。
 * 空 (未 seed) / 読込エラー (テーブル欠落含む) のときは DEFAULT_FAQ_ENTRIES を使い、
 * 常に有効なセクション文字列を返す (= AI 応答を壊さない fail-safe)。
 */
export async function getFaqSection(db: D1Database): Promise<string> {
  try {
    const items = await listActiveFaqItems(db);
    if (items.length === 0) return getDefaultFaqSection();
    return buildFaqSection(items.map((i) => ({ question: i.question, answer: i.answer, category: i.category })));
  } catch (err) {
    console.error('[faq-context] listActiveFaqItems failed, falling back to defaults:', err instanceof Error ? err.message : String(err));
    return getDefaultFaqSection();
  }
}
