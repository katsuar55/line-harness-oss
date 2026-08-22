/**
 * ポータル再注文の二重購入ガード (採点②-1 HIGH, 2026-08-22)。
 *
 * 「🔄 この注文を再注文」の source 注文が**定期便のお届け分** (Huckleberry が
 * subscription-id: タグを付ける) で、かつ friend が**稼働中の定期契約**を持つ場合、
 * 無警告の単発 Draft Order 作成は二重購入の事故になる。
 * Katsu 決定 (2026-08-22) = 拒否ではなく「確認ステップを挟む」:
 * ack (acknowledgeSubscriptionDuplicate === true) が無い作成要求はサーバ側で 409 に倒す
 * (fail-closed — UI を迂回した直 POST でも 1 回は止まる)。
 *
 * 述語はトーク側ガード (services/subscription-reminder.ts, 2026-08-18) と**同一定義**:
 *   稼働 = subscription_contracts.cancelled_at IS NULL (paused も稼働扱い —
 *   決済失敗 pause は二重購入が最も起きやすい層。復活は解約のみ)。
 *   own-billing (own_sub_contracts) を実顧客に開くときは reminder 側と同時に
 *   この EXISTS にも足すこと。
 */
import { parseOrderSubscriptionTags } from './subscription-contracts.js';

/** source 注文が定期便のお届け分か (shopify_orders.tags の subscription-id: で判定)。 */
export function isSubscriptionDeliveryOrder(tags: string | null | undefined): boolean {
  return parseOrderSubscriptionTags(tags) !== null;
}

/** friend が稼働中 (非解約) の定期契約を持つか。未連携 (shopify_customer_id NULL) は false。 */
export async function hasActiveSubscriptionContract(
  db: D1Database,
  friendId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM friends f
         JOIN subscription_contracts c ON c.shopify_customer_id = f.shopify_customer_id
        WHERE f.id = ?
          AND c.cancelled_at IS NULL
        LIMIT 1`,
    )
    .bind(friendId)
    .first<{ hit: number }>();
  return row != null;
}
