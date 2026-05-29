/**
 * Shopify order → membership sync (= Phase 4-γ、 2026-05-28)
 *
 * 役割:
 *   Shopify orders/paid webhook から friend を解決して、
 *   members.total_purchase_jpy を加算 + tier promote check + 昇格時 LINE push。
 *
 * 設計:
 *   - 純関数: resolveFriendForOrder (= email / phone → friend lookup)
 *   - entry: syncOrderToMember (= addPurchaseEvent + promoteAndNotify を chain)
 *   - cost zero: 既 applied event は skip、 friend マッチしない order も event 記録のみで member 加算なし
 *   - 既存 shopify-phase2a.ts の payment webhook handler から waitUntil 経由で呼ばれる想定
 *
 * 関連:
 *   - packages/db/src/membership.ts addPurchaseEvent (= migration 059 への INSERT + members 加算)
 *   - apps/worker/src/services/membership.ts checkAndNotifyForFriend (= tier promote check + push)
 *   - apps/worker/src/routes/shopify-phase2a.ts (= 既存 payment endpoint、 本 PR で本 service を統合)
 */
import {
  addPurchaseEvent,
  type AddPurchaseEventResult,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import {
  checkAndNotifyForFriend,
  type PromoteAndNotifyEnv,
  type PromoteAndNotifyResult,
} from './membership.js';

// ============================================================
// 純関数: order body から friend を解決
// ============================================================

export interface ResolveFriendInput {
  email?: string | null;
  phone?: string | null;
  shopifyCustomerId?: string | null;
  existingFriendId?: string | null;
}

export type MatchedBy = 'existing' | 'customer_id' | 'email' | 'phone' | null;

/**
 * Shopify order の existing/customer_id/email/phone から friend を lookup (= 純関数)。
 *
 * 優先順位 (= Phase 4-ι 2026-05-28、 customer_id 追加):
 *   1. existingFriendId (= shopify_orders.friend_id が既設定なら即返す)
 *   2. **shopify_customer_id direct match** (= friends.shopify_customer_id = ?)
 *      - migration 060 で friends に column 追加
 *      - 1 Shopify customer ≦ 1 LINE friend 制約 (= UNIQUE index)
 *      - LP launch 後 friend が LIFF で Shopify customer link 完了後に効果発揮
 *   3. email match (= users.email → friends.user_id)
 *   4. phone match (= users.phone → friends.user_id、 正規化付き)
 */
export async function resolveFriendForOrder(
  db: D1Database,
  input: ResolveFriendInput,
): Promise<{ friendId: string | null; matchedBy: MatchedBy }> {
  if (input.existingFriendId) {
    return { friendId: input.existingFriendId, matchedBy: 'existing' };
  }
  if (input.shopifyCustomerId) {
    const friendByCustomer = await db
      .prepare(`SELECT id FROM friends WHERE shopify_customer_id = ?`)
      .bind(input.shopifyCustomerId)
      .first<{ id: string }>();
    if (friendByCustomer) {
      return { friendId: friendByCustomer.id, matchedBy: 'customer_id' };
    }
  }
  if (input.email) {
    // email は case-insensitive 照合 (= Shopify は小文字化するが LINE/LIFF 登録は mixed-case 可)。
    // COLLATE NOCASE で「Foo@Bar.com」 と「foo@bar.com」 の取り違えによる attribution miss を防ぐ。
    const userByEmail = await db
      .prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`)
      .bind(input.email)
      .first<{ id: string }>();
    if (userByEmail) {
      const friend = await db
        .prepare(`SELECT id FROM friends WHERE user_id = ?`)
        .bind(userByEmail.id)
        .first<{ id: string }>();
      if (friend) {
        return { friendId: friend.id, matchedBy: 'email' };
      }
    }
  }
  if (input.phone) {
    const normalized = input.phone.replace(/[^0-9+]/g, '');
    const userByPhone = await db
      .prepare(`SELECT id FROM users WHERE phone = ?`)
      .bind(normalized)
      .first<{ id: string }>();
    if (userByPhone) {
      const friend = await db
        .prepare(`SELECT id FROM friends WHERE user_id = ?`)
        .bind(userByPhone.id)
        .first<{ id: string }>();
      if (friend) {
        return { friendId: friend.id, matchedBy: 'phone' };
      }
    }
  }
  return { friendId: null, matchedBy: null };
}

// ============================================================
// entry: order → member sync (= webhook waitUntil から呼ぶ)
// ============================================================

export interface SyncOrderInput {
  shopifyOrderId: string;
  amountJpy: number;
  currency?: string;
  orderNumber?: number | null;
  email?: string | null;
  phone?: string | null;
  shopifyCustomerId?: string | null;
  existingFriendId?: string | null;
  source?: 'webhook' | 'backfill' | 'manual';
}

export interface SyncOrderResult {
  event: AddPurchaseEventResult;
  promote: PromoteAndNotifyResult | null;
  matchedBy: MatchedBy;
}

/**
 * order 1 件を members に反映 (= event 記録 + 加算 + tier promote check)。
 *
 * 動作:
 *   1. resolveFriendForOrder で friend lookup
 *   2. addPurchaseEvent で event 記録 + members.total_purchase_jpy 加算
 *   3. friend マッチして加算成功 → checkAndNotifyForFriend で tier promote
 *
 * 失敗時は throw せず result に reason を載せて返す (= cron / webhook で全体止めない)。
 */
export async function syncOrderToMember(
  env: PromoteAndNotifyEnv,
  lineClient: LineClient,
  input: SyncOrderInput,
): Promise<SyncOrderResult> {
  const { friendId, matchedBy } = await resolveFriendForOrder(env.DB, {
    email: input.email,
    phone: input.phone,
    shopifyCustomerId: input.shopifyCustomerId,
    existingFriendId: input.existingFriendId,
  });

  const event = await addPurchaseEvent(env.DB, {
    shopifyOrderId: input.shopifyOrderId,
    friendId,
    amountJpy: input.amountJpy,
    currency: input.currency,
    orderNumber: input.orderNumber ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    source: input.source ?? 'webhook',
    metadata: {
      matchedBy,
      shopifyCustomerId: input.shopifyCustomerId ?? null,
    },
  });

  if (!event.applied || !friendId) {
    return { event, promote: null, matchedBy };
  }

  const promote = await checkAndNotifyForFriend(env, lineClient, friendId);
  return { event, promote, matchedBy };
}
