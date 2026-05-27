/**
 * Membership DB queries (= Phase 4 scaffolding、 2026-05-27)
 *
 * 目的:
 *   membership_tiers + members table の CRUD + tier 計算 utility。
 *   migration 058 で table 追加。
 *
 * 関連 service (= 後続 PR):
 *   - apps/worker/src/services/membership.ts (= 自動 promote + perks 配布)
 *   - apps/worker/src/services/membership-cron.ts (= 月次 promotion check)
 *
 * tier promotion 仕様:
 *   - min_total_purchase_jpy OR min_referral_count どちらかを満たせば促進対象
 *   - display_order が高い tier から順に check (= 上位 tier に届けば即適用)
 *   - 降格なし (= 一度上がった tier は永続、 retention 重視)
 */
import { jstNow } from './utils.js';

// ============================================================
// 型
// ============================================================

export interface MembershipTierRow {
  id: string;
  name: string;
  display_order: number;
  min_total_purchase_jpy: number;
  min_referral_count: number;
  perks: string | null;
  badge_emoji: string | null;
  badge_color: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MembershipTierPerks {
  discountPercent?: number;
  prioritySupport?: boolean;
  exclusiveProducts?: string[];
  affiliateCode?: boolean;
}

export interface MembershipTier {
  id: string;
  name: string;
  displayOrder: number;
  minTotalPurchaseJpy: number;
  minReferralCount: number;
  perks: MembershipTierPerks;
  badgeEmoji: string | null;
  badgeColor: string | null;
  isActive: boolean;
}

export interface MemberRow {
  id: string;
  friend_id: string;
  current_tier_id: string;
  total_purchase_jpy: number;
  total_referral_count: number;
  last_purchase_at: string | null;
  last_promotion_at: string | null;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

export interface Member {
  id: string;
  friendId: string;
  currentTierId: string;
  totalPurchaseJpy: number;
  totalReferralCount: number;
  lastPurchaseAt: string | null;
  lastPromotionAt: string | null;
  joinedAt: string;
}

export interface UpsertMemberInput {
  friendId: string;
  currentTierId?: string;
  totalPurchaseJpy?: number;
  totalReferralCount?: number;
  lastPurchaseAt?: string | null;
}

// ============================================================
// 変換 helper
// ============================================================

function parsePerks(value: string | null): MembershipTierPerks {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      discountPercent:
        typeof parsed.discount_percent === 'number' ? parsed.discount_percent : undefined,
      prioritySupport:
        typeof parsed.priority_support === 'boolean' ? parsed.priority_support : undefined,
      exclusiveProducts: Array.isArray(parsed.exclusive_products)
        ? parsed.exclusive_products.filter((v): v is string => typeof v === 'string')
        : undefined,
      affiliateCode:
        typeof parsed.affiliate_code === 'boolean' ? parsed.affiliate_code : undefined,
    };
  } catch {
    return {};
  }
}

export function rowToTier(row: MembershipTierRow): MembershipTier {
  return {
    id: row.id,
    name: row.name,
    displayOrder: row.display_order,
    minTotalPurchaseJpy: row.min_total_purchase_jpy,
    minReferralCount: row.min_referral_count,
    perks: parsePerks(row.perks),
    badgeEmoji: row.badge_emoji,
    badgeColor: row.badge_color,
    isActive: row.is_active === 1,
  };
}

export function rowToMember(row: MemberRow): Member {
  return {
    id: row.id,
    friendId: row.friend_id,
    currentTierId: row.current_tier_id,
    totalPurchaseJpy: row.total_purchase_jpy,
    totalReferralCount: row.total_referral_count,
    lastPurchaseAt: row.last_purchase_at,
    lastPromotionAt: row.last_promotion_at,
    joinedAt: row.joined_at,
  };
}

// ============================================================
// tier 操作
// ============================================================

export async function listMembershipTiers(
  db: D1Database,
  includeInactive = false,
): Promise<MembershipTier[]> {
  const sql = includeInactive
    ? `SELECT * FROM membership_tiers ORDER BY display_order ASC`
    : `SELECT * FROM membership_tiers WHERE is_active = 1 ORDER BY display_order ASC`;
  const result = await db.prepare(sql).all<MembershipTierRow>();
  return (result.results ?? []).map(rowToTier);
}

export async function getMembershipTierById(
  db: D1Database,
  tierId: string,
): Promise<MembershipTier | null> {
  const row = await db
    .prepare(`SELECT * FROM membership_tiers WHERE id = ?`)
    .bind(tierId)
    .first<MembershipTierRow>();
  return row ? rowToTier(row) : null;
}

/**
 * 与えられた purchase + referral 数値で適格な最高 tier を計算 (= 純関数)
 */
export function determineEligibleTier(
  tiers: MembershipTier[],
  totalPurchaseJpy: number,
  totalReferralCount: number,
): MembershipTier {
  // display_order 降順で check、 first match が最高 tier
  const sorted = [...tiers].filter((t) => t.isActive).sort((a, b) => b.displayOrder - a.displayOrder);
  for (const t of sorted) {
    const purchaseOk = totalPurchaseJpy >= t.minTotalPurchaseJpy;
    const referralOk = totalReferralCount >= t.minReferralCount;
    // どちらかを満たせば OK (= alternative path) — 但し min_referral_count=0 なら purchase only
    if (purchaseOk || (t.minReferralCount > 0 && referralOk)) {
      return t;
    }
  }
  // fallback: 最低 tier (= bronze)
  return sorted[sorted.length - 1] ?? sorted[0]!;
}

// ============================================================
// member 操作
// ============================================================

export async function getMemberByFriendId(
  db: D1Database,
  friendId: string,
): Promise<Member | null> {
  const row = await db
    .prepare(`SELECT * FROM members WHERE friend_id = ?`)
    .bind(friendId)
    .first<MemberRow>();
  return row ? rowToMember(row) : null;
}

export async function upsertMember(
  db: D1Database,
  input: UpsertMemberInput,
): Promise<{ inserted: boolean }> {
  const now = jstNow();
  const existing = await getMemberByFriendId(db, input.friendId);

  if (existing) {
    const updates: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];
    if (input.currentTierId !== undefined) {
      updates.push('current_tier_id = ?');
      params.push(input.currentTierId);
    }
    if (input.totalPurchaseJpy !== undefined) {
      updates.push('total_purchase_jpy = ?');
      params.push(input.totalPurchaseJpy);
    }
    if (input.totalReferralCount !== undefined) {
      updates.push('total_referral_count = ?');
      params.push(input.totalReferralCount);
    }
    if (input.lastPurchaseAt !== undefined) {
      updates.push('last_purchase_at = ?');
      params.push(input.lastPurchaseAt);
    }
    params.push(input.friendId);

    await db
      .prepare(`UPDATE members SET ${updates.join(', ')} WHERE friend_id = ?`)
      .bind(...params)
      .run();
    return { inserted: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO members (
        id, friend_id, current_tier_id, total_purchase_jpy, total_referral_count,
        last_purchase_at, joined_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.friendId,
      input.currentTierId ?? 'bronze',
      input.totalPurchaseJpy ?? 0,
      input.totalReferralCount ?? 0,
      input.lastPurchaseAt ?? null,
      now,
      now,
      now,
    )
    .run();
  return { inserted: true };
}

/**
 * member の current tier と eligible tier を比較し、 promote 必要なら update。
 * 降格なし (= 既 tier より下なら no-op)。
 */
export async function promoteMemberIfEligible(
  db: D1Database,
  friendId: string,
): Promise<{ promoted: boolean; fromTier: string; toTier: string }> {
  const member = await getMemberByFriendId(db, friendId);
  if (!member) {
    return { promoted: false, fromTier: '', toTier: '' };
  }
  const tiers = await listMembershipTiers(db, false);
  if (tiers.length === 0) {
    return { promoted: false, fromTier: member.currentTierId, toTier: member.currentTierId };
  }

  const eligible = determineEligibleTier(
    tiers,
    member.totalPurchaseJpy,
    member.totalReferralCount,
  );
  const currentTier = tiers.find((t) => t.id === member.currentTierId);
  const currentOrder = currentTier?.displayOrder ?? 0;

  if (eligible.displayOrder > currentOrder) {
    const now = jstNow();
    await db
      .prepare(
        `UPDATE members
           SET current_tier_id = ?, last_promotion_at = ?, updated_at = ?
         WHERE friend_id = ?`,
      )
      .bind(eligible.id, now, now, friendId)
      .run();
    return { promoted: true, fromTier: member.currentTierId, toTier: eligible.id };
  }
  return { promoted: false, fromTier: member.currentTierId, toTier: member.currentTierId };
}

export async function getMembersByTier(
  db: D1Database,
  tierId: string,
  limit = 100,
): Promise<Member[]> {
  const result = await db
    .prepare(
      `SELECT * FROM members WHERE current_tier_id = ?
        ORDER BY total_purchase_jpy DESC LIMIT ?`,
    )
    .bind(tierId, limit)
    .all<MemberRow>();
  return (result.results ?? []).map(rowToMember);
}

export interface MembershipStats {
  totalMembers: number;
  byTier: Record<string, { count: number; totalPurchaseJpy: number }>;
}

export async function getMembershipStats(db: D1Database): Promise<MembershipStats> {
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM members`)
    .first<{ n: number }>();

  const byTierRows = await db
    .prepare(
      `SELECT current_tier_id, COUNT(*) AS cnt, SUM(total_purchase_jpy) AS sum_jpy
         FROM members GROUP BY current_tier_id`,
    )
    .all<{ current_tier_id: string; cnt: number; sum_jpy: number | null }>();

  const byTier: Record<string, { count: number; totalPurchaseJpy: number }> = {};
  for (const row of byTierRows.results ?? []) {
    byTier[row.current_tier_id] = {
      count: row.cnt,
      totalPurchaseJpy: row.sum_jpy ?? 0,
    };
  }

  return {
    totalMembers: totalRow?.n ?? 0,
    byTier,
  };
}
