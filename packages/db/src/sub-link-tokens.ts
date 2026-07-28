/**
 * Sub-link tokens DB layer (= サブスク連携獲得キット / magic-link、 2026-07-24)
 *
 * 役割:
 *   sub_link_tokens テーブル (= migration 073) の純 D1 クエリ。
 *   店舗が顧客へ送る「1タップ連携リンク」の使い捨てトークンの発行 / 逆引き / single-use 消費 / 集計。
 *
 * セキュリティ不変条件 (= service 層 sub-link.ts と協調):
 *   - token は 160bit crypto ランダム (= 推測不能)。 平文で保存してよい (= link 自体が capability)。
 *   - consumeSubLinkTokenCas は CAS (consumed_at IS NULL → now) で single-use を保証 (= 転送 link の二重踏み防止)。
 *   - 連携先の一意性は friends.shopify_customer_id の UNIQUE partial index が別途担保する
 *     (= 本テーブルは「その link が使われたか」だけを管理し、 連携の真実源は friends 側)。
 *   - PII: token / shopify_customer_id / friend_id のみ。 email/氏名は保存しない。
 *
 * 関連:
 *   - apps/worker/src/services/sub-link.ts (= 呼び出し元、 生成/preview/redeem)
 *   - packages/db/migrations/073_sub_link_tokens.sql
 */

export interface SubLinkTokenRow {
  token: string;
  shopify_customer_id: string;
  batch_id: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_line_user_id: string | null;
  consumed_friend_id: string | null;
  created_at: string;
}

export interface InsertSubLinkTokenInput {
  token: string;
  shopifyCustomerId: string;
  batchId: string;
  /** ISO8601 */
  expiresAt: string;
  /** ISO8601 */
  createdAt: string;
}

/** 新規トークンを発行 (= consumed_at=NULL)。 */
export async function insertSubLinkToken(
  db: D1Database,
  input: InsertSubLinkTokenInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sub_link_tokens
         (token, shopify_customer_id, batch_id, expires_at, consumed_at, consumed_by_line_user_id, consumed_friend_id, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .bind(input.token, input.shopifyCustomerId, input.batchId, input.expiresAt, input.createdAt)
    .run();
}

/** token から行を逆引き (= preview/redeem の検証用)。 */
export async function getSubLinkToken(
  db: D1Database,
  token: string,
): Promise<SubLinkTokenRow | null> {
  return db
    .prepare(`SELECT * FROM sub_link_tokens WHERE token = ?`)
    .bind(token)
    .first<SubLinkTokenRow>();
}

/**
 * single-use 消費 (= CAS)。 consumed_at IS NULL の行のみ now で埋める。
 * @returns consumed=true なら本呼び出しが消費した (= redeem を続行してよい)、 false なら既消費 (= 競合敗者)。
 */
export async function consumeSubLinkTokenCas(
  db: D1Database,
  token: string,
  lineUserId: string,
  friendId: string,
  now: string,
): Promise<{ consumed: boolean }> {
  const res = await db
    .prepare(
      `UPDATE sub_link_tokens
          SET consumed_at = ?, consumed_by_line_user_id = ?, consumed_friend_id = ?
        WHERE token = ? AND consumed_at IS NULL`,
    )
    .bind(now, lineUserId, friendId, token)
    .run();
  return { consumed: (res.meta?.changes ?? 0) > 0 };
}

/**
 * 消費の巻き戻し (= 補償)。 friends への紐付けが失敗した場合に、 自分が消費した行だけを NULL に戻す。
 * consumed_friend_id で自分の消費行を限定し、 別 redeem の消費を誤って解放しない。
 */
export async function releaseSubLinkToken(
  db: D1Database,
  token: string,
  friendId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sub_link_tokens
          SET consumed_at = NULL, consumed_by_line_user_id = NULL, consumed_friend_id = NULL
        WHERE token = ? AND consumed_friend_id = ?`,
    )
    .bind(token, friendId)
    .run();
}

/**
 * 同一 customer の未消費トークンを削除 (= 再生成時に旧 link を無効化)。
 * 消費済 (連携実績) の行は監査のため残す。
 * @returns 削除件数
 */
export async function deleteUnconsumedSubLinkTokensForCustomer(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM sub_link_tokens WHERE shopify_customer_id = ? AND consumed_at IS NULL`,
    )
    .bind(shopifyCustomerId)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * 同一 customer の「特定バッチの」未消費トークンだけを削除する。
 * App Proxy 連携 (batch_id='app-proxy') の再訪問時に自分の旧トークンだけを無効化し、
 * 進行中の magic-link キャンペーン (email 掲載済みの 30日 link) を巻き添えで殺さないための限定版。
 * @returns 削除件数
 */
export async function deleteUnconsumedSubLinkTokensForCustomerBatch(
  db: D1Database,
  shopifyCustomerId: string,
  batchId: string,
  /** 指定時は「この時刻より前に失効した」行だけを消す (= まだ有効な発行済み link を殺さない)。 */
  expiredBefore?: string,
): Promise<number> {
  const sql = expiredBefore
    ? `DELETE FROM sub_link_tokens WHERE shopify_customer_id = ? AND batch_id = ? AND consumed_at IS NULL AND expires_at <= ?`
    : `DELETE FROM sub_link_tokens WHERE shopify_customer_id = ? AND batch_id = ? AND consumed_at IS NULL`;
  const stmt = expiredBefore
    ? db.prepare(sql).bind(shopifyCustomerId, batchId, expiredBefore)
    : db.prepare(sql).bind(shopifyCustomerId, batchId);
  const res = await stmt.run();
  return res.meta?.changes ?? 0;
}

/**
 * 同一 customer の未消費トークンのうち、指定バッチ **以外** を削除する。
 * magic-link のバッチ再生成が、進行中の App Proxy 連携 (顧客がストアで開いている
 * 連携ページのトークン) を巻き添えで殺さないための除外版。
 * @returns 削除件数
 */
export async function deleteUnconsumedSubLinkTokensForCustomerExceptBatch(
  db: D1Database,
  shopifyCustomerId: string,
  exceptBatchId: string,
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM sub_link_tokens WHERE shopify_customer_id = ? AND batch_id != ? AND consumed_at IS NULL`,
    )
    .bind(shopifyCustomerId, exceptBatchId)
    .run();
  return res.meta?.changes ?? 0;
}

export interface SubLinkTokenStats {
  total: number;
  consumed: number;
  pending: number;
  expired: number;
}

/**
 * 集計 (= 件数のみ・PII なし。 admin status / 定点観測用)。
 * pending = 未消費かつ未失効、 expired = 未消費だが失効済。
 */
export async function getSubLinkTokenStats(
  db: D1Database,
  now: string,
): Promise<SubLinkTokenStats> {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed,
         SUM(CASE WHEN consumed_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN consumed_at IS NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired
       FROM sub_link_tokens`,
    )
    .bind(now, now)
    .first<{ total: number; consumed: number; pending: number; expired: number }>();
  return {
    total: row?.total ?? 0,
    consumed: row?.consumed ?? 0,
    pending: row?.pending ?? 0,
    expired: row?.expired ?? 0,
  };
}
