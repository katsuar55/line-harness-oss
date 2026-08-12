/**
 * line_friend_coupons の redemption (使用) 追跡 — 第2波-⑤ (2026-07-01)
 *
 * 役割:
 *   発行側 (services/shopify-coupon-issuer.ts) は完成済で、 redeemed_at / status='redeemed' の
 *   「使用」更新だけが未実装だった。 Shopify の注文 webhook (orders/create / orders/updated) に
 *   乗る discount_codes を line_friend_coupons.coupon_code と照合して、 初回のみ atomic に
 *   redeemed_at + status='redeemed' を立てる。 これで「友だち追加 → welcome クーポン → 実購入」の
 *   転換率を初めて数値化できる (= お得施策全体の ROI 判断材料 + 景表法/原価の運用安全)。
 *
 * 設計原則:
 *   - 冪等: `WHERE redeemed_at IS NULL` の条件付き UPDATE で「初回だけ勝つ」。 Shopify webhook の
 *     再送 / orders/updated の連投 / 並行受信でも二重計上しない (D1 が write を直列化、
 *     2 回目の UPDATE は changes=0)。
 *   - friend マッチ非依存: coupon_code 自体が line_friend_coupons.friend_id に 1:1 で紐づくため、
 *     注文の email/phone が LINE 友だちに一致しなくても「誰の coupon が使われたか」 が判る。
 *   - 大文字小文字非依存照合: 発行 code は uppercase、 Shopify も canonical code を返すが、
 *     casing drift に備えて COLLATE NOCASE (テーブルは friend 数規模で小さく full-scan 許容)。
 *   - metadata は json_patch で append (既存値を破壊しない)。
 *
 * 関連:
 *   - apps/worker/src/services/coupon-redemption.ts (= 注文 body から code 抽出 + audit)
 *   - apps/worker/src/routes/shopify.ts (= orders/create|orders/updated handler から hook)
 *   - packages/db/migrations/050_line_friend_coupons.sql (= schema、 redeemed_at/status 列)
 */

/**
 * redemption を追跡するクーポン台帳。**テーブル名は SQL に bind できない**ので、
 * 呼び出し側の文字列をそのまま埋めず、この閉じた対応表からのみ解決する。
 *
 * 3 台帳は redemption に必要な列 (id / friend_id / coupon_code / redeemed_at / status /
 * line_account_id / metadata) が同形で、status の CHECK も同一 (issued|redeemed|expired|revoked)。
 * 表示側 (getActive*) はいずれも `status='issued'` で絞るので、ここで redeemed に落とせば
 * カードは自然に消える。
 */
export const COUPON_LEDGER_TABLES = Object.freeze({
  /** 友だち追加 welcome クーポン (migration 050) */
  friend: 'line_friend_coupons',
  /** 友達紹介の報酬クーポン (migration 068) */
  referral: 'line_referral_coupons',
  /** LINE⇔Shopify 連携特典クーポン (migration 078) */
  link: 'line_link_coupons',
} as const);

export type CouponLedger = keyof typeof COUPON_LEDGER_TABLES;

export const COUPON_LEDGERS = Object.freeze(
  Object.keys(COUPON_LEDGER_TABLES) as CouponLedger[],
);

export interface RedeemCouponResult {
  /** couponCode が台帳の row に一致したか */
  matched: boolean;
  /** 一致した coupon の friend_id (未一致なら null) */
  friendId: string | null;
  /** 一致した coupon の line_account_id (未一致 / NULL なら null) */
  lineAccountId: string | null;
  /** この呼び出しが redeemed への遷移を実際に確定したか (= atomic UPDATE に勝った) */
  redeemed: boolean;
  /** 呼び出し時点で既に redeemed 済 (= 冪等な再受信 / 並行で負けた) だったか */
  alreadyRedeemed: boolean;
}

interface CouponLookupRow {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  redeemed_at: string | null;
  status: string;
}

/**
 * coupon_code に一致する line_friend_coupons の row を redeemed に遷移させる (初回のみ)。
 *
 * - 一致 row なし → { matched: false }
 * - 既に redeemed_at が立っている → { matched: true, alreadyRedeemed: true } (冪等 skip)
 * - それ以外 → 条件付き UPDATE。 changes===1 (= 勝者) なら redeemed=true、 並行で負けたら
 *   alreadyRedeemed=true。
 *
 * 例外は throw せず caller (= webhook async 経路) が握りつぶす前提だが、 本関数自体は
 * D1 例外をそのまま伝播する (caller が best-effort で囲む)。
 */
export async function redeemFriendCouponByCode(
  db: D1Database,
  couponCode: string,
  redeemedAtIso: string,
  metadata?: Record<string, unknown>,
): Promise<RedeemCouponResult> {
  return redeemCouponByCode(db, 'friend', couponCode, redeemedAtIso, metadata);
}

/**
 * 台帳を指定して redemption を確定する (`redeemFriendCouponByCode` の一般形)。
 *
 * テーブル名は `COUPON_LEDGER_TABLES` からのみ解決する。型でも閉じているが、
 * **JS から任意文字列を渡された場合に SQL へ流れないよう実行時にも検証する** (多層防御)。
 */
export async function redeemCouponByCode(
  db: D1Database,
  ledger: CouponLedger,
  couponCode: string,
  redeemedAtIso: string,
  metadata?: Record<string, unknown>,
): Promise<RedeemCouponResult> {
  const table = Object.prototype.hasOwnProperty.call(COUPON_LEDGER_TABLES, ledger)
    ? COUPON_LEDGER_TABLES[ledger]
    : undefined;
  if (!table) {
    throw new Error(`redeemCouponByCode: unknown ledger ${String(ledger)}`);
  }

  const trimmed = (couponCode ?? '').trim();
  if (!trimmed) {
    return { matched: false, friendId: null, lineAccountId: null, redeemed: false, alreadyRedeemed: false };
  }

  const row = await db
    .prepare(
      `SELECT id, friend_id, line_account_id, redeemed_at, status
         FROM ${table}
        WHERE coupon_code = ? COLLATE NOCASE
        LIMIT 1`,
    )
    .bind(trimmed)
    .first<CouponLookupRow>();

  if (!row) {
    return { matched: false, friendId: null, lineAccountId: null, redeemed: false, alreadyRedeemed: false };
  }

  if (row.redeemed_at !== null && row.redeemed_at !== undefined && row.redeemed_at !== '') {
    return {
      matched: true,
      friendId: row.friend_id,
      lineAccountId: row.line_account_id ?? null,
      redeemed: false,
      alreadyRedeemed: true,
    };
  }

  const patch = JSON.stringify({ redemption: { ...(metadata ?? {}), redeemedAt: redeemedAtIso } });
  const res = await db
    .prepare(
      `UPDATE ${table}
          SET redeemed_at = ?,
              status = 'redeemed',
              metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE id = ? AND redeemed_at IS NULL`,
    )
    .bind(redeemedAtIso, patch, row.id)
    .run();

  const won = (res.meta?.changes ?? 0) === 1;
  return {
    matched: true,
    friendId: row.friend_id,
    lineAccountId: row.line_account_id ?? null,
    redeemed: won,
    alreadyRedeemed: !won,
  };
}

export interface CouponRedemptionStats {
  /** 発行総数 (filter 適用後) */
  issued: number;
  /** 使用数 (status='redeemed' もしくは redeemed_at 有り) */
  redeemed: number;
  /** 期限切れ数 */
  expired: number;
  /** 失効数 */
  revoked: number;
  /** 未使用で生きている数 (issued - redeemed - expired - revoked、 下限 0) */
  outstanding: number;
  /** 転換率 redeemed/issued (issued=0 なら 0、 小数第 4 位丸め) */
  conversionRate: number;
  /** 使用済 coupon の値引き総額 (discount_value 合計) */
  redeemedDiscountValue: number;
}

interface StatsRow {
  issued: number;
  redeemed: number;
  expired: number;
  revoked: number;
  redeemed_value: number;
}

/**
 * line_friend_coupons の発行 → 使用 転換サマリを 1 query で集計する。
 * 任意で line_account / 期間 (issued_at) で絞り込み可能。
 */
export async function getCouponRedemptionStats(
  db: D1Database,
  opts?: { lineAccountId?: string | null; since?: string; until?: string },
): Promise<CouponRedemptionStats> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (opts?.lineAccountId) {
    conditions.push('line_account_id = ?');
    values.push(opts.lineAccountId);
  }
  if (opts?.since) {
    conditions.push('issued_at >= ?');
    values.push(opts.since);
  }
  if (opts?.until) {
    conditions.push('issued_at < ?');
    values.push(opts.until);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS issued,
         SUM(CASE WHEN status = 'redeemed' OR redeemed_at IS NOT NULL THEN 1 ELSE 0 END) AS redeemed,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
         SUM(CASE WHEN status = 'redeemed' OR redeemed_at IS NOT NULL THEN discount_value ELSE 0 END) AS redeemed_value
       FROM line_friend_coupons
       ${where}`,
    )
    .bind(...values)
    .first<StatsRow>();

  const issued = row?.issued ?? 0;
  const redeemed = row?.redeemed ?? 0;
  const expired = row?.expired ?? 0;
  const revoked = row?.revoked ?? 0;
  const outstanding = Math.max(issued - redeemed - expired - revoked, 0);
  const conversionRate = issued > 0 ? Math.round((redeemed / issued) * 10000) / 10000 : 0;

  return {
    issued,
    redeemed,
    expired,
    revoked,
    outstanding,
    conversionRate,
    redeemedDiscountValue: row?.redeemed_value ?? 0,
  };
}
