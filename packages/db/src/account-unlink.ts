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
 * | members                            | 累計 0 / last_purchase_at NULL / tier は**再計算** | applied_at を戻すので二重加算を避けるには累計もゼロに戻す必要がある。紹介カウントは購入と無関係なので温存。tier は bronze 決め打ちにせず、購入額 0 の状態でまだ満たす最上位を選び直す — 昇格は `purchaseOk \|\| (minReferralCount > 0 && referralOk)` の選択的経路なので、**紹介だけで得た tier を奪ってはいけない** (Codex P1) |
 * | loyalty_rank_discounts             | status='superseded'              | ランクが 0 に戻る以上、会員証に出し続けない (Shopify 側のコード無効化は別 op — 顧客限定なので放置しても他人は使えない) |
 * | **line_link_coupons**              | **残す**                          | 🚨 消すと連携特典 ¥300 の「生涯 1 枚」保証が壊れ、解除→再連携で 2 枚目が出る = 実費。冪等キーそのものなので絶対に消さない |
 * | subscription_reminders             | is_active=0                       | 🚨 連携由来の自動生成。残すと /liff/reorder に他人の商品名が出続けるうえ、稼働定期便への再注文 push の抑止が **反転して発火する** (抑止は friends.shopify_customer_id 経由の JOIN なので解除で空になる) |
 * | audit_logs                         | 残す                              | 誰がいつ解除したかの記録 |
 *
 * ## 冪等性
 * 未連携の friend に対しては `linked:false` を返して 1 行も書かない。
 * 二重実行しても同じ結果になる (すべて対象を限定した UPDATE)。
 */
import { jstNow } from './utils';

/**
 * 逆方向リンクの取りこぼしを自己修復する (2026-08-28, Codex P1)。
 *
 * ## なぜ要るか
 * 連携の書込は 2 段構えになっている:
 *   ① friends.shopify_customer_id を set-once CAS で立てる (= 連携の真実源)
 *   ② shopify_customers.friend_id / shopify_orders.friend_id を埋める (= 注文一覧の唯一のキー)
 * ②が transient な D1 エラーで落ちても、①は既に立っていて **set-once なので二度と書けない**。
 * OTP をやり直しても `already_linked` で弾かれるだけなので、顧客は
 * 「連携済みなのに注文が 1 件も出ない」状態から自力で抜け出せない。
 *
 * ## なぜ sweep で直せるか
 * 修復に必要な情報は friends.shopify_customer_id に**既に永続化されている**。
 * ②は純粋な導出なので、後からいくらでも冪等に再実行できる。
 * したがって「連携済みなのに backlink が無い」行を拾って埋め直すだけでよい。
 *
 * ## 安全性
 * - 更新は `friend_id IS NULL` 限定 = 他人に紐付いた行を奪わない。
 * - 対象は「friends が指している customer」だけ = 誤った紐付けを新たに作らない。
 * - 冪等。修復対象が無ければ 0 行更新で終わる。
 */
export interface BacklinkRepairResult {
  /** 修復対象として残っていた friend 数 (処理前)。 */
  readonly pending: number;
  /** この run で修復した friend 数 (0 or 1)。 */
  readonly repaired: number;
  readonly friendId: string | null;
  readonly customers: number;
  readonly orders: number;
  /** 配送追跡の復元件数 (shopify_order_id 経由で結び直す)。 */
  readonly fulfillments: number;
}

/** 連携済みなのに逆リンク (customers / orders / fulfillments) が欠けている friend を 1 件修復する。 */
export async function repairMissingBacklink(db: D1Database): Promise<BacklinkRepairResult> {
  // 🚨 検知は shopify_customers だけでは足りない (採点ループ HIGH)。
  //    customers 側が埋まっていても **orders 側が NULL のまま**なら注文一覧は 0 件で、
  //    顧客から見た症状 (「連携済みなのに注文が出ない」) はまったく同じ。
  //    両方を OR で拾う。EXISTS は index (shopify_customer_id) が効く形にしてある。
  const PENDING = `
    FROM friends f
   WHERE f.shopify_customer_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM shopify_customers sc
          WHERE sc.shopify_customer_id = f.shopify_customer_id
            AND (sc.friend_id IS NULL OR sc.friend_id != f.id)
       )
       OR EXISTS (
         SELECT 1 FROM shopify_orders so
          WHERE so.shopify_customer_id = f.shopify_customer_id
            AND so.friend_id IS NULL
       )
       OR EXISTS (
         SELECT 1 FROM shopify_fulfillments sf
           JOIN shopify_orders so2 ON so2.shopify_order_id = sf.shopify_order_id
          WHERE so2.shopify_customer_id = f.shopify_customer_id
            AND sf.friend_id IS NULL
       )
     )`;

  const row = await db.prepare(`SELECT COUNT(*) AS n ${PENDING}`).first<{ n: number }>();
  const pending = row?.n ?? 0;
  if (pending === 0) return { pending: 0, repaired: 0, friendId: null, customers: 0, orders: 0, fulfillments: 0 };

  const target = await db
    .prepare(`SELECT f.id, f.shopify_customer_id ${PENDING} ORDER BY f.updated_at DESC LIMIT 1`)
    .first<{ id: string; shopify_customer_id: string }>();
  if (!target) return { pending, repaired: 0, friendId: null, customers: 0, orders: 0, fulfillments: 0 };

  const now = jstNow();
  const cid = String(target.shopify_customer_id);
  const res = await db.batch([
    // friend_id IS NULL 限定 = 別 friend に紐付いた行は奪わない (奪うと他人のデータが見える)
    db.prepare(`UPDATE shopify_customers SET friend_id = ?, updated_at = ? WHERE shopify_customer_id = ? AND friend_id IS NULL`)
      .bind(target.id, now, cid),
    db.prepare(`UPDATE shopify_orders SET friend_id = ? WHERE shopify_customer_id = ? AND friend_id IS NULL`)
      .bind(target.id, cid),
    // 🚨 配送追跡も戻す (採点ループ HIGH)。shopify_fulfillments には customer 列が無いが
    //    shopify_order_id で shopify_orders に結べるので復元できる。これが無いと
    //    「もう一度連携すれば元に戻ります」という顧客への約束が配送追跡だけ守れない。
    db.prepare(
      `UPDATE shopify_fulfillments SET friend_id = ?, updated_at = ?
        WHERE friend_id IS NULL
          AND shopify_order_id IN (SELECT shopify_order_id FROM shopify_orders WHERE shopify_customer_id = ?)`,
    ).bind(target.id, now, cid),
  ]);

  return {
    pending,
    repaired: 1,
    friendId: target.id,
    customers: res[0]?.meta?.changes ?? 0,
    orders: res[1]?.meta?.changes ?? 0,
    fulfillments: res[2]?.meta?.changes ?? 0,
  };
}

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
    /** 停止した再注文リマインダー件数 (連携由来の自動生成分)。 */
    readonly reorderReminders: number;
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
    cleared: { customers: 0, orders: 0, fulfillments: 0, purchaseEvents: 0, members: 0, rankDiscounts: 0, reorderReminders: 0 },
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
    // 🚨 「連携先 1 行」に絞らない (採点ループ MED)。過去の連携や webhook の取りこぼしで
    //    別の customer 行が同じ friend_id を持っていることがあり、絞ると購入額が漏れ続ける。
    //    その friend を指す行は**全部**外す。
    db.prepare(`UPDATE shopify_customers SET friend_id = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    db.prepare(`UPDATE shopify_orders SET friend_id = NULL WHERE friend_id = ?`)
      .bind(friendId),
    db.prepare(`UPDATE shopify_fulfillments SET friend_id = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    // ランクの原資を外す。行は消さない (監査保全) が applied_at も戻して再連携で復元できるようにする
    db.prepare(`UPDATE member_purchase_events SET friend_id = NULL, applied_at = NULL, updated_at = ? WHERE friend_id = ?`)
      .bind(now, friendId),
    // applied_at を戻した以上、累計も戻さないと再連携時に二重加算になる。
    //
    // 🚨 tier は **再計算** する。bronze 決め打ちにしない (Codex P1 2026-08-28)。
    //   membership の昇格条件は `purchaseOk || (minReferralCount > 0 && referralOk)` の
    //   **選択的経路** (packages/db/src/membership.ts determineEligibleTier) で、
    //   購入ゼロでも紹介人数だけで上位 tier に到達できる。紹介実績は連携と無関係なので
    //   total_referral_count は温存しているのに、それで得た tier を潰すのは矛盾している。
    //   逆に tier を触らないと「¥0 なのに上位 tier」で凍結する (採点ループ MED)。
    //   → 購入額 0 の状態で **まだ満たしている最上位 tier** を選び直すのが唯一正しい。
    //   determineEligibleTier と同じ判定を SQL で写す:
    //     purchaseOk (= 0 >= min_total_purchase_jpy) または
    //     min_referral_count > 0 かつ total_referral_count >= min_referral_count
    //   該当が無ければ最低 tier (display_order 最小) に落とす。
    db.prepare(
      `UPDATE members
          SET total_purchase_jpy = 0,
              last_purchase_at = NULL,
              current_tier_id = COALESCE(
                (SELECT t.id FROM membership_tiers t
                  WHERE t.is_active = 1
                    AND (
                      t.min_total_purchase_jpy <= 0
                      OR (t.min_referral_count > 0 AND t.min_referral_count <= members.total_referral_count)
                    )
                  ORDER BY t.display_order DESC LIMIT 1),
                (SELECT t2.id FROM membership_tiers t2 WHERE t2.is_active = 1 ORDER BY t2.display_order ASC LIMIT 1),
                current_tier_id
              ),
              updated_at = ?
        WHERE friend_id = ?`,
    ).bind(now, friendId),
    db.prepare(`UPDATE loyalty_rank_discounts SET status = 'superseded', superseded_at = ? WHERE friend_id = ? AND status = 'active'`)
      .bind(now, friendId),
    // 🚨 再注文リマインダーを止める (採点ループ HIGH)。
    //    これらは連携由来で自動生成される (routes/shopify.ts → enrollSubscriptionsFromOrder)。
    //    行を残すと二重の害がある:
    //      ① /liff/reorder が解除後も連携先の購入商品名を出し続ける (誤連携の是正にならない)
    //      ② services/subscription-reminder.ts の「稼働定期便には送らない」抑止は
    //         `JOIN subscription_contracts ON c.shopify_customer_id = f.shopify_customer_id`
    //         を通るため、解除で NULL になると NOT EXISTS が **TRUE に反転**し、
    //         稼働中の定期便顧客へ「再購入時期になりました」を送り始める (= 二重注文の促し)。
    //         2026-08-18 / 08-23 に 2 度入れたガードを、解除が無言で外してしまう。
    //    行は消さず is_active=0 にする (顧客が再設定すれば戻る・監査も残る)。
    db.prepare(`UPDATE subscription_reminders SET is_active = 0, updated_at = ? WHERE friend_id = ? AND is_active = 1`)
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
      reorderReminders: changes(7),
    },
  };
}
