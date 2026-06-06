/**
 * Account Link Codes DB layer (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 役割:
 *   account_link_codes テーブル (= migration 064) の純 D1 クエリ。
 *   email OTP 本人確認フロー (LIFF) の発行 / レート制限 / 逆引き / 試行回数 / single-use 消費。
 *
 * セキュリティ不変条件 (= service 層 account-link.ts と協調):
 *   - code_hash は HMAC-SHA256(pepper, "friend:email:code")。 平文 OTP は保存しない (service 側で hash 化)。
 *   - attempts はインクリメントのみ (= verify ミスごとに +1)。 MAX 到達で service が consume して lock。
 *   - consumeAccountLinkCode は CAS (consumed_at IS NULL → now) で single-use を保証 (= 二重消費防止)。
 *   - 新規発行時に invalidatePriorAccountLinkCodes で同 (friend,email) の旧 active を無効化 (= 最新のみ有効)。
 *
 * 関連:
 *   - apps/worker/src/services/account-link.ts (= 呼び出し元、 OTP 生成/検証/Shopify 連携)
 *   - packages/db/migrations/064_account_link_codes.sql
 */

export interface AccountLinkCodeRow {
  id: string;
  friend_id: string;
  email: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
  created_at: string;
}

export interface InsertAccountLinkCodeInput {
  id: string;
  friendId: string;
  /** lowercased email */
  email: string;
  codeHash: string;
  /** ISO8601 */
  expiresAt: string;
  /** ISO8601 */
  createdAt: string;
}

/** 新規 OTP code を発行 (= attempts=0 / consumed_at=NULL)。 */
export async function insertAccountLinkCode(
  db: D1Database,
  input: InsertAccountLinkCodeInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_link_codes (id, friend_id, email, code_hash, expires_at, attempts, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
    )
    .bind(input.id, input.friendId, input.email, input.codeHash, input.expiresAt, input.createdAt)
    .run();
}

/**
 * 同 (friend, email) の未消費 code を全て無効化 (= 新規発行前に呼び、 最新 code のみ有効にする)。
 * 旧 code が active のまま残ると attempts カウントが曖昧になり総当たり耐性が落ちるため。
 */
export async function invalidatePriorAccountLinkCodes(
  db: D1Database,
  friendId: string,
  email: string,
  consumedAtIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE account_link_codes SET consumed_at = ?
        WHERE friend_id = ? AND email = ? AND consumed_at IS NULL`,
    )
    .bind(consumedAtIso, friendId, email)
    .run();
}

/**
 * friend に対して sinceIso 以降に発行された code 件数 (= request レート制限の窓)。
 * email 爆撃 (= 大量送信) を 1 friend あたりで制限するため。
 */
export async function countRecentAccountLinkCodes(
  db: D1Database,
  friendId: string,
  sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM account_link_codes WHERE friend_id = ? AND created_at >= ?`)
    .bind(friendId, sinceIso)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * (friend, email) の最新 active code (= 未消費 かつ 未失効) を 1 件取得 (= verify 用)。
 * 旧 code は発行時に無効化されるため通常 1 件だが、 念のため created_at DESC で最新を採る。
 */
export async function getActiveAccountLinkCode(
  db: D1Database,
  friendId: string,
  email: string,
  nowIso: string,
): Promise<AccountLinkCodeRow | null> {
  return db
    .prepare(
      `SELECT * FROM account_link_codes
        WHERE friend_id = ? AND email = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId, email, nowIso)
    .first<AccountLinkCodeRow>();
}

/**
 * attempts を atomic にインクリメントし、 インクリメント後の値を返す (= verify ミス時)。
 * 単一 `UPDATE ... RETURNING` で increment と読み戻しを 1 statement に畳み、
 * 並行 verify での読み戻し race (= UPDATE と SELECT の間の割り込み) を排除する。
 */
export async function incrementAccountLinkAttempts(
  db: D1Database,
  id: string,
): Promise<number> {
  const row = await db
    .prepare(`UPDATE account_link_codes SET attempts = attempts + 1 WHERE id = ? RETURNING attempts`)
    .bind(id)
    .first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

/**
 * code を single-use 消費 (= CAS: consumed_at IS NULL のときのみ now を書き、 changes===1 で勝者)。
 * 成功 verify / lock (試行超過) の双方で使う。
 * @returns consumed=true なら今回消費した (= 検証続行可)、 false なら既に消費済 (= 競合/二重)。
 */
export async function consumeAccountLinkCode(
  db: D1Database,
  id: string,
  consumedAtIso: string,
): Promise<{ consumed: boolean }> {
  const res = await db
    .prepare(`UPDATE account_link_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(consumedAtIso, id)
    .run();
  return { consumed: (res.meta?.changes ?? 0) > 0 };
}
