/**
 * In-house loyalty rank engine (= 自社内製ロイヤリティ, 2026-06-01)
 *
 * 背景: cb-admin (ハッシャダイ製 LINE LIFF) を実機確認した結果、rank を tag/metafield/API で
 *   読む手段が無く、割引も「感謝クーポン= コード型 / 1回限り購入 / 併用不可」と判明。
 *   → rank 算出を自社内製化し、cb-admin の rank モデルを互換再現する (既存客の rank を温存)。
 *
 * モデル (cb-admin 互換):
 *   regular 0% / bronze 2% / silver 4% / gold 6% / platinum 8%
 *   閾値 (trailing-12ヶ月 購入額 JPY): ¥0 / ¥1 / ¥12,000 / ¥24,000 / ¥45,000
 *   過去12ヶ月 rolling・月次再判定・降格あり。
 *
 * 設計:
 *   - 純関数中心 (determineRank / computeRankProgress / compareRanks) = test 容易・brand 非依存。
 *   - defs を引数化して multi-brand 対応 (= 汎用性大方針)。NATURISM_RANK_DEFS が default。
 *   - 集計は member_purchase_events (= Phase 4-γ で既に記録) の trailing-12mo SUM。
 *   - lifetime 累計の members.total_purchase_jpy とは別指標 (rank 判定は trailing-12mo)。
 *
 * 関連 (後続 PR): loyalty rank cron (月次再判定/降格)、マイランク LIFF (会員証)、自社割引発行。
 */
import { isoMonthsAgo, jstNow } from './utils.js';

// ============================================================
// 型 + brand config
// ============================================================

export interface LoyaltyRankDef {
  /** 安定 id (regular/bronze/silver/gold/platinum)。snapshot / 割引コードの基準。 */
  id: string;
  /** 表示名。 */
  name: string;
  /** 並び順。0 = 最下位 (regular)。昇格/降格判定の基準。 */
  order: number;
  /** この trailing-12ヶ月 購入額 (JPY) 以上で該当 rank。 */
  minTrailing12moJpy: number;
  /** rank 割引率 (%)。 */
  discountPercent: number;
  badgeEmoji?: string;
  badgeColor?: string;
  /** 高級ランクバッジ画像 (R2: /images/rank-{id}.png)。 未設定/読込失敗時は badgeEmoji が fallback。 */
  badgeImageUrl?: string;
}

/**
 * naturism default (cb-admin 互換)。multi-brand では brand_config で上書き。
 * 閾値は「以上」判定 (例: ¥12,000 ちょうどで silver)。
 */
export const NATURISM_RANK_DEFS: readonly LoyaltyRankDef[] = [
  { id: 'regular', name: 'レギュラー', order: 0, minTrailing12moJpy: 0, discountPercent: 0, badgeEmoji: '🌱', badgeColor: '#9CA3AF', badgeImageUrl: '/images/rank-regular.png' },
  { id: 'bronze', name: 'ブロンズ', order: 1, minTrailing12moJpy: 1, discountPercent: 2, badgeEmoji: '🥉', badgeColor: '#CD7F32', badgeImageUrl: '/images/rank-bronze.png' },
  { id: 'silver', name: 'シルバー', order: 2, minTrailing12moJpy: 12000, discountPercent: 4, badgeEmoji: '🥈', badgeColor: '#C0C0C0', badgeImageUrl: '/images/rank-silver.png' },
  { id: 'gold', name: 'ゴールド', order: 3, minTrailing12moJpy: 24000, discountPercent: 6, badgeEmoji: '🥇', badgeColor: '#FFD700', badgeImageUrl: '/images/rank-gold.png' },
  { id: 'platinum', name: 'プラチナ', order: 4, minTrailing12moJpy: 45000, discountPercent: 8, badgeEmoji: '💎', badgeColor: '#0ABAB5', badgeImageUrl: '/images/rank-platinum.png' },
];

// ============================================================
// 純関数: rank 判定 + 進捗 + 比較
// ============================================================

function normalizeAmount(jpy: number): number {
  return Number.isFinite(jpy) ? Math.max(0, Math.floor(jpy)) : 0;
}

/**
 * trailing-12mo 購入額から該当 rank を決定 (= 純関数)。
 * order 降順で最初に閾値 (minTrailing12moJpy 以上) を満たすものを返す。
 * defs 空は設定不整合として throw (undefined crash 防止)。
 */
export function determineRank(
  defs: readonly LoyaltyRankDef[],
  trailing12moJpy: number,
): LoyaltyRankDef {
  if (defs.length === 0) {
    throw new Error('determineRank: no rank definitions configured');
  }
  const amount = normalizeAmount(trailing12moJpy);
  const sortedDesc = [...defs].sort((a, b) => b.order - a.order);
  for (const d of sortedDesc) {
    if (amount >= d.minTrailing12moJpy) return d;
  }
  // どの閾値も満たさない (= 全 def の min が amount 超) → 最下位を返す。
  return sortedDesc[sortedDesc.length - 1]!;
}

export function getRankById(
  defs: readonly LoyaltyRankDef[],
  rankId: string,
): LoyaltyRankDef | null {
  return defs.find((d) => d.id === rankId) ?? null;
}

export function rankDiscountPercent(
  defs: readonly LoyaltyRankDef[],
  rankId: string,
): number {
  return getRankById(defs, rankId)?.discountPercent ?? 0;
}

/**
 * 2 つの rank の昇降を比較 (= snapshot 比較で降格/昇格検知)。
 * 戻り値: 1 = 昇格 (to が上)、-1 = 降格、0 = 同位。未知 id は order 0 扱い。
 */
export function compareRanks(
  defs: readonly LoyaltyRankDef[],
  fromRankId: string,
  toRankId: string,
): -1 | 0 | 1 {
  const from = getRankById(defs, fromRankId)?.order ?? 0;
  const to = getRankById(defs, toRankId)?.order ?? 0;
  if (to > from) return 1;
  if (to < from) return -1;
  return 0;
}

export interface RankProgress {
  current: LoyaltyRankDef;
  /** 次 rank。null = 最高 rank 到達。 */
  next: LoyaltyRankDef | null;
  trailing12moJpy: number;
  /** 次 rank 閾値までの残額 (JPY)。最高 rank は 0。 */
  remainingToNextJpy: number;
  /** current 閾値 → next 閾値 の進捗 (0..1)。最高 rank は 1。 */
  progressRatio: number;
}

/**
 * 会員証の進捗バー用 (= 純関数)。current rank + 次 rank までの残額/割合。
 */
export function computeRankProgress(
  defs: readonly LoyaltyRankDef[],
  trailing12moJpy: number,
): RankProgress {
  const amount = normalizeAmount(trailing12moJpy);
  const current = determineRank(defs, amount);
  const sortedAsc = [...defs].sort((a, b) => a.order - b.order);
  const next = sortedAsc.find((d) => d.order > current.order) ?? null;
  if (!next) {
    return {
      current,
      next: null,
      trailing12moJpy: amount,
      remainingToNextJpy: 0,
      progressRatio: 1,
    };
  }
  const span = next.minTrailing12moJpy - current.minTrailing12moJpy;
  const into = amount - current.minTrailing12moJpy;
  const progressRatio = span > 0 ? Math.min(1, Math.max(0, into / span)) : 1;
  return {
    current,
    next,
    trailing12moJpy: amount,
    remainingToNextJpy: Math.max(0, next.minTrailing12moJpy - amount),
    progressRatio,
  };
}

// ============================================================
// 集計: trailing-12mo from member_purchase_events
// ============================================================

/**
 * friend の trailing-12ヶ月 購入額を member_purchase_events から集計 (= applied のみ)。
 * 窓は asOf - 12ヶ月。asOf 省略時は現在 (JST)。
 *
 * NOTE: created_at を時間基準とする (= live webhook では注文時刻 ≈ 記録時刻)。
 *   backfill した過去 order の正確な注文日付対応は PR3 (link + occurred_at) で精緻化。
 */
export async function computeTrailing12moJpyForFriend(
  db: D1Database,
  friendId: string,
  asOfIso?: string,
): Promise<number> {
  const asOf = asOfIso ?? jstNow();
  const since = isoMonthsAgo(12, asOf);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_jpy), 0) AS total
         FROM member_purchase_events
        WHERE friend_id = ?
          AND applied_at IS NOT NULL
          AND created_at >= ?`,
    )
    .bind(friendId, since)
    .first<{ total: number }>();
  return normalizeAmount(Number(row?.total ?? 0));
}

export interface ResolvedRank {
  rankId: string;
  rank: LoyaltyRankDef;
  trailing12moJpy: number;
  progress: RankProgress;
}

/**
 * friend の現 rank を解決 (= 集計 + 判定 + 進捗)。マイランク LIFF / cron が使う entry。
 */
export async function resolveFriendRank(
  db: D1Database,
  friendId: string,
  defs: readonly LoyaltyRankDef[] = NATURISM_RANK_DEFS,
  asOfIso?: string,
): Promise<ResolvedRank> {
  const trailing12moJpy = await computeTrailing12moJpyForFriend(db, friendId, asOfIso);
  const progress = computeRankProgress(defs, trailing12moJpy);
  return {
    rankId: progress.current.id,
    rank: progress.current,
    trailing12moJpy,
    progress,
  };
}
