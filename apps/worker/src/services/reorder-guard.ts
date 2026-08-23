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

/** activeSubscriptionProductIds の戻り値。 */
export interface ActiveSubscriptionProducts {
  /** 稼働契約のお届けに含まれていた Shopify product_id 集合 */
  productIds: Set<string>;
  /** 稼働 (非解約) の契約を 1 つ以上持つか */
  hasActiveContract: boolean;
  /**
   * 🚨 稼働契約の**全部**を注文まで辿れたか。false = 一部の契約の中身が分からない。
   * productIds が空でなくても別契約の商品を取りこぼしている可能性がある
   * (採点ループ HIGH: 「size > 0 なら全部わかった」は誤りで、複数契約の顧客で素通りする)。
   */
  allContractsResolved: boolean;
  /** 稼働契約がすべて一時停止中か (バッジ文言の出し分け用) */
  allPaused: boolean;
}

/**
 * 稼働契約で「実際に届いている商品」の product_id 集合 (2026-08-23)。
 *
 * subscription_contracts には商品を特定する列が 1 つも無いため、
 * **稼働契約の定期便タグが付いた注文の明細**から導出する。
 *
 * ⚠️ 導出できない場合 (注文がローカルに無い / タグが欠ける) は **空集合**になる。
 *   空集合は「この人は定期便で何も買っていない」ではなく **「分からない」**。
 *   呼び出し側は hasActiveContract && productIds.size === 0 を
 *   「不明」として安全側 (確認を挟む) に倒すこと。バッジは助言、409 が最終防壁。
 *
 * 引くのは friend_id ではなく shopify_customer_id — 連携前に着弾した注文も拾うため。
 */
export async function activeSubscriptionProductIds(
  db: D1Database,
  friendId: string,
): Promise<ActiveSubscriptionProducts> {
  const empty: ActiveSubscriptionProducts = {
    productIds: new Set(),
    hasActiveContract: false,
    allContractsResolved: true,
    allPaused: false,
  };

  const friend = await db
    .prepare('SELECT shopify_customer_id FROM friends WHERE id = ?')
    .bind(friendId)
    .first<{ shopify_customer_id: string | null }>();
  const customerId = friend?.shopify_customer_id ?? null;
  if (!customerId) return empty;

  // 稼働の定義は hasActiveSubscriptionContract と**同一** (cancelled_at IS NULL)。
  // 3 つ目の定義を作らない
  const { results: contracts } = await db
    .prepare(
      `SELECT contract_id, paused_at FROM subscription_contracts
        WHERE shopify_customer_id = ? AND cancelled_at IS NULL`,
    )
    .bind(customerId)
    .all<{ contract_id: string; paused_at: string | null }>();
  if (!contracts || contracts.length === 0) return empty;

  const activeIds = new Set(contracts.map((c) => String(c.contract_id)));
  const allPaused = contracts.every((c) => c.paused_at != null);

  // LIKE は粗い prefilter。契約 ID の照合は parseOrderSubscriptionTags で**厳密に**行う
  // (LIKE だけだと subscription-id:123 が ...:1234 に当たる)
  const { results: orders } = await db
    .prepare(
      `SELECT tags, line_items FROM shopify_orders
        WHERE shopify_customer_id = ? AND tags LIKE '%subscription-id:%'
        ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(customerId)
    .all<{ tags: string | null; line_items: string | null }>();

  const productIds = new Set<string>();
  const resolvedContractIds = new Set<string>();
  for (const o of orders ?? []) {
    const parsed = parseOrderSubscriptionTags(o.tags);
    if (!parsed || !activeIds.has(String(parsed.contractId))) continue;
    resolvedContractIds.add(String(parsed.contractId));

    let items: Array<Record<string, unknown>> = [];
    try {
      const raw = o.line_items ? JSON.parse(o.line_items) : [];
      items = Array.isArray(raw) ? raw : [];
    } catch {
      continue;
    }
    // selling_plan_allocation を持つ行 = その明細が定期便で買われた行。
    // 1 行も持たない注文では全行にフォールバックする (集合が空になる方が危険)
    const planned = items.filter((li) => li.selling_plan_allocation != null);
    for (const li of planned.length > 0 ? planned : items) {
      const pid = li.product_id;
      if (pid != null && String(pid).length > 0) productIds.add(String(pid));
    }
  }

  // 稼働契約のうち 1 本でも注文まで辿れなければ「一部は分からない」= 安全側の判断材料にする
  const allContractsResolved = [...activeIds].every((id) => resolvedContractIds.has(id));
  return { productIds, hasActiveContract: true, allContractsResolved, allPaused };
}
