/**
 * Phase 2: バッジ判定サービス
 *
 * event_bus から fireEvent 経由で呼び出される。
 * 各イベント種別に対し「現在の累計が閾値を超えているか」を判定し、
 * 該当するバッジを awardBadge で付与する。
 *
 * 設計:
 * - INSERT OR IGNORE で重複付与は自動的に no-op
 * - 失敗してもイベント本流を止めない (try/catch で握りつぶす)
 * - cron 一括判定はやらない (イベント駆動 = 即時付与)
 *
 * 「集めたい人だけ集める」プレッシャーゼロ設計。
 */

import {
  awardBadge,
  getIntakeTotalCount,
  getMaxStreak,
  getFriendPurchaseCount,
  getFriendReferralCount,
} from '@line-crm/db';

export interface BadgeAwardResult {
  badgeCode: string;
  newlyAwarded: boolean;
}

/**
 * intake_log イベント時のバッジ判定
 * - 現在のストリークが閾値超え → ストリーク系バッジ
 * - 累計記録が閾値超え → 累計系バッジ
 */
async function evaluateIntakeBadges(
  db: D1Database,
  friendId: string,
  streakCount: number,
): Promise<BadgeAwardResult[]> {
  const results: BadgeAwardResult[] = [];

  // ストリーク系
  const streakThresholds: Array<{ threshold: number; code: string }> = [
    { threshold: 7, code: 'intake_streak_7' },
    { threshold: 30, code: 'intake_streak_30' },
    { threshold: 100, code: 'intake_streak_100' },
  ];
  for (const { threshold, code } of streakThresholds) {
    if (streakCount >= threshold) {
      const newlyAwarded = await awardBadge(db, friendId, code);
      results.push({ badgeCode: code, newlyAwarded });
    }
  }

  // 累計系 (ストリーク閾値達成時のみ DB クエリして節約)
  const totalCount = await getIntakeTotalCount(db, friendId);
  const totalThresholds: Array<{ threshold: number; code: string }> = [
    { threshold: 30, code: 'intake_total_30' },
    { threshold: 100, code: 'intake_total_100' },
    { threshold: 365, code: 'intake_total_365' },
  ];
  for (const { threshold, code } of totalThresholds) {
    if (totalCount >= threshold) {
      const newlyAwarded = await awardBadge(db, friendId, code);
      results.push({ badgeCode: code, newlyAwarded });
    }
  }

  return results;
}

/**
 * cv_fire (購入) イベント時のバッジ判定
 */
async function evaluatePurchaseBadges(
  db: D1Database,
  friendId: string,
): Promise<BadgeAwardResult[]> {
  const results: BadgeAwardResult[] = [];
  const count = await getFriendPurchaseCount(db, friendId);

  const thresholds: Array<{ threshold: number; code: string }> = [
    { threshold: 1, code: 'purchase_first' },
    { threshold: 5, code: 'purchase_5' },
    { threshold: 10, code: 'purchase_10' },
  ];
  for (const { threshold, code } of thresholds) {
    if (count >= threshold) {
      const newlyAwarded = await awardBadge(db, friendId, code);
      results.push({ badgeCode: code, newlyAwarded });
    }
  }
  return results;
}

/**
 * referral_completed イベント時のバッジ判定
 */
async function evaluateReferralBadges(
  db: D1Database,
  friendId: string,
): Promise<BadgeAwardResult[]> {
  const results: BadgeAwardResult[] = [];
  const count = await getFriendReferralCount(db, friendId);

  const thresholds: Array<{ threshold: number; code: string }> = [
    { threshold: 1, code: 'referral_first' },
    { threshold: 5, code: 'referral_5' },
  ];
  for (const { threshold, code } of thresholds) {
    if (count >= threshold) {
      const newlyAwarded = await awardBadge(db, friendId, code);
      results.push({ badgeCode: code, newlyAwarded });
    }
  }
  return results;
}

/**
 * イベント種別に応じてバッジ判定を振り分け
 *
 * @returns 新規獲得 (newlyAwarded=true) のバッジ一覧。空配列なら新規獲得なし。
 */
export async function evaluateBadgesForEvent(
  db: D1Database,
  eventType: string,
  payload: {
    friendId?: string;
    eventData?: Record<string, unknown>;
  },
): Promise<BadgeAwardResult[]> {
  if (!payload.friendId) return [];

  try {
    switch (eventType) {
      case 'intake_log': {
        const streakCount =
          typeof payload.eventData?.streakCount === 'number'
            ? payload.eventData.streakCount
            : await getMaxStreak(db, payload.friendId);
        return await evaluateIntakeBadges(db, payload.friendId, streakCount);
      }
      case 'cv_fire':
      case 'purchase': {
        return await evaluatePurchaseBadges(db, payload.friendId);
      }
      case 'referral_completed': {
        return await evaluateReferralBadges(db, payload.friendId);
      }
      default:
        return [];
    }
  } catch (err) {
    console.error('evaluateBadgesForEvent error:', err);
    return [];
  }
}
