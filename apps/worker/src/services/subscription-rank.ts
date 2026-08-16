/**
 * 定期便ランク (= Huckleberry ネイティブ会員ランク) のタグ連動 (B案, 2026-08-16)
 *
 * HB はランク付与時に Shopify 顧客タグ `subscription-rank:ランク名` を書く (HB 公式ヘルプで確認済み)。
 * customers/update webhook が shopify_customers.tags へ取り込み済みなので、ここではその文字列を
 * パースするだけで追加の外部 fetch はない。
 *
 * 名前→% の対応表をコードに固定してよい根拠: HB の会員ランクは「公開」済みで、公開後は
 * 昇格条件も割引率も再編集不可 (HB 公式仕様・2026-08-15 精読)。脱出は「ランクをリセット」のみで、
 * 公式ヘルプはリセット時「全顧客のランク/タグが消滅」と記載 (= タグが消えればカード自体が消える)。
 * ただしタグ消滅は実測未確認のため、万一 HB 側に未知のランク名が現れた場合は
 * % を断定せず名前だけ返す (fail-honest) — 対応表が実態とズレても嘘の % は出さない。
 *
 * LINE ランク (NATURISM_RANK_DEFS) と同じ % 表だが判定母数が異なる:
 *   HB = 定期便注文のみの累計 (公開以後)・月次判定なし / LINE = 全購入 trailing 12ヶ月・毎月判定。
 */

export interface SubscriptionRank {
  name: string;
  /** 既知ランクなら 2/4/6/8。未知のランク名は null (= UI は % を表示しない) */
  discountPercent: number | null;
}

/** HB 会員ランク表 (公開済み = 凍結)。ブロンズ ¥1〜 / シルバー ¥12,000〜 / ゴールド ¥24,000〜 / プラチナ ¥45,000〜 */
export const HB_SUBSCRIPTION_RANKS: ReadonlyArray<{ name: string; discountPercent: number }> = [
  { name: 'ブロンズ', discountPercent: 2 },
  { name: 'シルバー', discountPercent: 4 },
  { name: 'ゴールド', discountPercent: 6 },
  { name: 'プラチナ', discountPercent: 8 },
];

const TAG_PREFIX = 'subscription-rank:';

/**
 * Shopify 顧客タグ文字列 (カンマ区切り) から定期便ランクを取り出す。
 * - タグ無し / tags 非文字列 → null (UI はカード自体を出さない)
 * - 既知ランクが複数残っている場合 (タグ入替の過渡状態や旧タグ残留) は**最低ランク**を採用。
 *   実測でキャンセル減算による降格が起こり得るため、旧・高ランクの残留タグを信じると
 *   実際より高い % を顧客に約束してしまう (有利誤認)。低く見せる誤りは実割引が上回るだけで
 *   顧客不利益にならない (採点ループ data-correctness MEDIUM の反映)。
 * - 未知ランク名のみの場合は名前だけ返し % は断定しない
 */
export function parseSubscriptionRankFromTags(tags: unknown): SubscriptionRank | null {
  if (typeof tags !== 'string' || tags.length === 0) return null;
  const names: string[] = [];
  for (const raw of tags.split(',')) {
    const t = raw.trim();
    if (t.startsWith(TAG_PREFIX)) {
      const name = t.slice(TAG_PREFIX.length).trim();
      if (name) names.push(name);
    }
  }
  if (names.length === 0) return null;
  let best: SubscriptionRank | null = null;
  for (const name of names) {
    const def = HB_SUBSCRIPTION_RANKS.find((r) => r.name === name);
    if (def) {
      if (best === null || best.discountPercent === null || def.discountPercent < best.discountPercent) {
        best = { name: def.name, discountPercent: def.discountPercent };
      }
    } else if (best === null) {
      best = { name, discountPercent: null };
    }
  }
  return best;
}
