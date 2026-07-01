/**
 * アカウント連携 (LINE friend ↔ Shopify customer) の現況サマリ — 第2波-③ 支援 (2026-07-01)
 *
 * 目的: 「移行前の 6,583 友だちのうち、 何人が既に連携済 / メール判明済 / いま一括連携で救えるか」を
 * 1 回の read-only 集計で可視化する。 連携施策 (セルフ連携 broadcast + 一括 email-match) の規模を
 * 数字で確定し、 会員ランクの復元カバレッジを測るための計測 API。
 *
 * 純粋な read-only (mutation なし)。 admin API_KEY 保護の GET から呼ぶ。
 *
 * 関連:
 *   - apps/worker/src/routes/account-link-admin.ts (= この集計を返す GET endpoint)
 *   - apps/worker/src/services/account-link.ts (= セルフ連携 OTP、 連携の本経路)
 *   - apps/worker/src/services/member-purchase-backfill.ts (= 連携後の過去注文 backfill)
 *   - docs/ACCOUNT_LINK_DESIGN.md
 */

export interface AccountLinkStats {
  friends: {
    /** friends 総数 */
    total: number;
    /** is_following=1 (現在フォロー中) */
    following: number;
    /** shopify_customer_id 設定済 (= 既に連携済) */
    linked: number;
    /** 未連携 (shopify_customer_id IS NULL) */
    unlinked: number;
    /** メール判明済 (friends.email もしくは users.email が非空) */
    withEmail: number;
  };
  bulkEmailMatch: {
    /** 未連携かつメールが Shopify 顧客 ちょうど1件 に一致 = 一括連携で即救える人数 */
    candidates: number;
    /** 未連携だがメールが Shopify 顧客 複数 に一致 = 曖昧なので自動連携しない人数 */
    ambiguous: number;
  };
  members: {
    /** members テーブル行数 (= ランク評価対象) */
    count: number;
    /** 実際に purchase event が適用済の friend 数 (= 履歴が反映されている人) */
    withPurchaseEvents: number;
  };
  shopify: {
    /** shopify_customers 行数 */
    customers: number;
    /** 現在の Shopify token scope (read_all_orders 有無の確認用。 env token 運用で不明なら null) */
    scope: string | null;
  };
}

async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * アカウント連携の現況を 1 回の呼び出しで集計して返す (read-only)。
 */
export async function getAccountLinkStats(db: D1Database): Promise<AccountLinkStats> {
  const total = await count(db, `SELECT COUNT(*) AS n FROM friends`);
  const following = await count(db, `SELECT COUNT(*) AS n FROM friends WHERE is_following = 1`);
  const linked = await count(
    db,
    `SELECT COUNT(*) AS n FROM friends WHERE shopify_customer_id IS NOT NULL`,
  );
  const withEmail = await count(
    db,
    `SELECT COUNT(*) AS n
       FROM friends f
       LEFT JOIN users u ON f.user_id = u.id
      WHERE (f.email IS NOT NULL AND f.email != '')
         OR (u.email IS NOT NULL AND u.email != '')`,
  );

  // 未連携友だちのメール (friends.email 優先、 無ければ users.email) を Shopify 顧客メールと突合。
  // 顧客ちょうど1件一致 = 一括連携候補、 複数一致 = 曖昧 (自動連携しない)。
  const matchRow = await db
    .prepare(
      `WITH friend_email AS (
         SELECT f.id AS friend_id,
                LOWER(COALESCE(NULLIF(f.email, ''), u.email)) AS email
           FROM friends f
           LEFT JOIN users u ON f.user_id = u.id
          WHERE f.shopify_customer_id IS NULL
       ),
       matches AS (
         SELECT fe.friend_id,
                COUNT(DISTINCT sc.shopify_customer_id) AS cust_count
           FROM friend_email fe
           JOIN shopify_customers sc ON LOWER(sc.email) = fe.email
          WHERE fe.email IS NOT NULL AND fe.email != ''
          GROUP BY fe.friend_id
       )
       SELECT
         COALESCE(SUM(CASE WHEN cust_count = 1 THEN 1 ELSE 0 END), 0) AS candidates,
         COALESCE(SUM(CASE WHEN cust_count > 1 THEN 1 ELSE 0 END), 0) AS ambiguous
       FROM matches`,
    )
    .first<{ candidates: number; ambiguous: number }>();

  const membersCount = await count(db, `SELECT COUNT(*) AS n FROM members`);
  const withPurchaseEvents = await count(
    db,
    `SELECT COUNT(DISTINCT friend_id) AS n FROM member_purchase_events WHERE applied_at IS NOT NULL`,
  );
  const shopifyCustomers = await count(db, `SELECT COUNT(*) AS n FROM shopify_customers`);

  const scopeRow = await db
    .prepare(`SELECT scope FROM shopify_tokens ORDER BY created_at DESC LIMIT 1`)
    .first<{ scope: string | null }>()
    .catch(() => null);

  return {
    friends: {
      total,
      following,
      linked,
      unlinked: Math.max(total - linked, 0),
      withEmail,
    },
    bulkEmailMatch: {
      candidates: matchRow?.candidates ?? 0,
      ambiguous: matchRow?.ambiguous ?? 0,
    },
    members: {
      count: membersCount,
      withPurchaseEvents,
    },
    shopify: {
      customers: shopifyCustomers,
      scope: scopeRow?.scope ?? null,
    },
  };
}
