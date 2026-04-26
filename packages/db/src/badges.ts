import { jstNow } from './utils.js';

export interface Badge {
  code: string;
  category: string;
  name: string;
  description: string | null;
  icon: string | null;
  threshold: number | null;
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  is_active: number;
  sort_order: number;
  created_at: string;
}

export interface FriendBadge {
  id: string;
  friend_id: string;
  badge_code: string;
  earned_at: string;
}

/** 全 badges (アクティブなもの) を取得 */
export async function getAllBadges(db: D1Database): Promise<Badge[]> {
  const { results } = await db
    .prepare(`SELECT * FROM badges WHERE is_active = 1 ORDER BY sort_order ASC`)
    .all<Badge>();
  return results;
}

/** 指定 friend が獲得済みのバッジ一覧 */
export async function getFriendBadges(
  db: D1Database,
  friendId: string,
): Promise<FriendBadge[]> {
  const { results } = await db
    .prepare(
      `SELECT id, friend_id, badge_code, earned_at FROM friend_badges
       WHERE friend_id = ? ORDER BY earned_at DESC`,
    )
    .bind(friendId)
    .all<FriendBadge>();
  return results;
}

/**
 * バッジ獲得 (UNIQUE 制約により重複は無視)
 * 既獲得時は false、新規獲得時は true を返す
 */
export async function awardBadge(
  db: D1Database,
  friendId: string,
  badgeCode: string,
): Promise<boolean> {
  // INSERT OR IGNORE で UNIQUE 違反時は no-op、changes() で判定
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO friend_badges (id, friend_id, badge_code, earned_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, badgeCode, jstNow())
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

/** 友だちの服用記録の累計回数 */
export async function getIntakeTotalCount(
  db: D1Database,
  friendId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as cnt FROM intake_logs WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/** 友だちの最大ストリーク (累計) */
export async function getMaxStreak(
  db: D1Database,
  friendId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT MAX(streak_count) as max_s FROM intake_logs WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ max_s: number | null }>();
  return row?.max_s ?? 0;
}

/** 友だちの購入回数 (Shopify orders) */
export async function getFriendPurchaseCount(
  db: D1Database,
  friendId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as cnt FROM shopify_orders WHERE friend_id = ?`)
    .bind(friendId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/** 友だちの紹介成立件数 */
export async function getFriendReferralCount(
  db: D1Database,
  friendId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM referral_rewards
       WHERE referrer_friend_id = ? AND status = 'completed'`,
    )
    .bind(friendId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * 友だちのレベル計算 (DB 不要、表示時計算)
 * level 1: score 0-99
 * level 2: score 100-199
 * level N: score (N-1)*100 〜 N*100-1
 */
export function calculateLevel(score: number): number {
  return Math.floor(Math.max(0, score) / 100) + 1;
}

/** 次のレベルまでのポイント */
export function pointsToNextLevel(score: number): number {
  const currentLevel = calculateLevel(score);
  const nextLevelThreshold = currentLevel * 100;
  return nextLevelThreshold - score;
}
