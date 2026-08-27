/**
 * アカウント連携の解除 (LINE friend ⇔ Shopify customer) — 2026-08-28
 *
 * ## なぜ要るか
 * 連携は 2026-08-27 まで **一方向** だった。書込は setFriendShopifyCustomerId の
 * `WHERE ... AND shopify_customer_id IS NULL` (= set-once CAS) だけで、NULL へ戻す経路が
 * リポジトリのどこにも存在しなかった。その結果:
 *   - 家族共有のメールや旧メールに誤って連携した顧客は **自力で直せない**
 *   - 機種変更で LINE を作り直した人は、`friends.shopify_customer_id` の UNIQUE partial index に
 *     阻まれて同じ顧客へ二度と連携できない (redeem は 'taken' / OTP は 'customer_conflict')
 *   - プライバシーポリシー第12項が「利用の停止又は消去の請求」に応じると明記しているのに、
 *     受けた側に押せるボタンが無い
 * 本番の連携 9 件は DMM CSV の **LINE 表示名** 照合で作られており (audit metadata
 * matchedBy='display_name')、誤連携は理論上のリスクではなく最初から混入しうる状態だった。
 *
 * ## 🚨 friends だけ NULL にしても露出は止まらない
 * 注文履歴と配送追跡は `friends` を一切参照せず、**denormalized な friend_id 列を直接読む**:
 *   - 注文一覧      routes/liff-portal.ts  `FROM shopify_orders WHERE friend_id = ?`
 *   - 配送追跡      routes/liff-portal.ts  `FROM shopify_fulfillments sf ... WHERE sf.friend_id = ?`
 * したがって「露出を止める」には 4 列を **1 回の batch で** 消す必要がある。
 *
 * ## 巻き戻す / 残す の判断
 * | 対象 | 扱い | 理由 |
 * |---|---|---|
 * | friends.shopify_customer_id        | NULL  | 連携の真実源 |
 * | shopify_customers.friend_id        | NULL  | 逆方向リンク |
 * | shopify_orders.friend_id           | NULL  | 注文一覧の唯一のキー |
 * | shopify_fulfillments.friend_id     | NULL  | 配送追跡の唯一のキー |
 * | member_purchase_events             | friend_id=NULL / applied_at=NULL | ランクの原資。行は消さず外すだけ (監査保全)。applied_at も戻すのは、再連携時に addPurchaseEvent の CAS (`WHERE applied_at IS NULL`) が再 claim してランクを復元できるようにするため |
 * | members                            | 累計 0 / last_purchase_at NULL   | member_purchase_events の applied_at を戻すので、二重加算を避けるには累計もゼロに戻す必要がある。紹介カウントは購入と無関係なので温存 |
 * | loyalty_rank_discounts             | status='superseded'              | ランクが 0 に戻る以上、会員証に出し続けない (Shopify 側のコード無効化は別 op — 顧客限定なので放置しても他人は使えない) |
 * | **line_link_coupons**              | **残す**                          | 🚨 消すと連携特典 ¥300 の「生涯 1 枚」保証が壊れ、解除→再連携で 2 枚目が出る = 実費。冪等キーそのものなので絶対に消さない |
 * | audit_logs                         | 残す                              | 誰がいつ解除したかの記録 |
 *
 * ## 冪等性
 * 未連携の friend に対しては `linked:false` を返して 1 行も書かない。
 * 二重実行しても同じ結果になる (すべて対象を限定した UPDATE)。
 */
import { jstNow } from './utils';

export interface UnlinkResult {
  /** 解除を実行したか (false = もともと未連携)。 */
  readonly unlinked: boolean;
  /** 解除前に紐付いていた Shopify customer id (未連携なら null)。 */
  readonly shopifyCustomerId: string | null;
  /** 各テーブルで friend_id を外した行数。 */
  readonly cleared: {
    readonly customers: number;
    readonly orders: number;
    readonly fulfillments: number;
    readonly purchaseEvents: number;
    readonly members: number;
    readonly rankDiscounts: number;
  };
}

/**
 * friend の Shopify 連携を解除し、連携由来の denormalized 列とランク原資を巻き戻す。
 *
 * 連携特典クーポン台帳 (line_link_coupons) は **意図的に残す** (二重発行防止の冪等キー)。
 */
export async function unlinkFriendFromShopifyCustomer(
  db: D1Database,
  friendId: string,
): Promise<UnlinkResult> {
  const empty: UnlinkResult = {
    unlinked: false,
    shopifyCustomerId: null,
    cleared: { customers: 0, orders: 0, fulfillments: 0, purchaseEvents: 0, members: 0, rankDiscounts: 0 },
  };

  const friend = await db
    .prepare(`SELECT shopify_customer_id FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ shopify_customer_id: string | null }>();
  if (!friend || !friend.shopify_customer_id) return empty;
  const customerId = String(friend.shopify_customer_id);
  const now = jstNow();

  // 🚨 真実源を先に外す。batch は D1 が 1 トランザクションで実行するので、
  //    「friends だけ消えて注文が残る」中途半端な状態が観測されない。
  const results = await db.batch([
    db.prepare(`UPDATE friends SET shopify_customer_id = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, friendId),
    db.prepare(`UPDATE shopify_customers SET friend_id = NULL, updated_at = ? WHERE shopify_customer_id = ? AND friend_id = ?`)
      .bind(now, customerId, friendId),
    db.prepare(`UPDATE shopify_orders SET friend_id = NULL WHERE friend_id = ?`)
      .bind(friendId),
    db.prepare(`UPDATE shopify_fulfillments SET friend_id = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    // ランクの原資を外す。行は消さない (監査保全) が applied_at も戻して再連携で復元できるようにする
    db.prepare(`UPDATE member_purchase_events SET friend_id = NULL, applied_at = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    // applied_at を戻した以上、累計も戻さないと再連携時に二重加算になる
    db.prepare(`UPDATE members SET total_purchase_jpy = 0, last_purchase_at = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    db.prepare(`UPDATE loyalty_rank_discounts SET status = 'superseded', superseded_at = ? WHERE friend_id = ? AND status = 'active'`)
      .bind(now, friendId),
  ]);

  const changes = (i: number): number => results[i]?.meta?.changes ?? 0;
  return {
    unlinked: true,
    shopifyCustomerId: customerId,
    cleared: {
      customers: changes(1),
      orders: changes(2),
      fulfillments: changes(3),
      purchaseEvents: changes(4),
      members: changes(5),
      rankDiscounts: changes(6),
    },
  };
}
