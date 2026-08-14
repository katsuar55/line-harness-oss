/**
 * line_referral_coupon_queue — 紹介クーポン順次活性化 (queue) の DB 層 (migration 079)
 *
 * 不変条件: **friend (referrer) につき Shopify 上の生きた NREF- コードは常に最大 1 枚**。
 *   「生きた」= line_referral_coupons に status='issued' かつ未使用かつ未失効の行がある。
 *   2 枚目以降の紹介成立は本 queue に waiting で積まれ、使用/失効/閲覧を契機に 1 枚ずつ活性化する。
 *
 * 並行性の設計 (検証員 CONFIRMED の反映):
 *   - orders webhook は at-least-once (orders/create + orders/updated の重複配信が公式想定)。
 *     活性化の入口が T1 (webhook) / T2 (sweep) / T3 (portal 閲覧) の 3 系統あるため、
 *     「二重活性化 = 生きたコード 2 枚」を**アプリの逐次実行に頼らず単文 UPDATE の WHERE で強制**する。
 *     D1 は write を直列化するので、単文の条件付き UPDATE は atomic に評価される:
 *       ① 対象は最古の waiting 1 行 (FIFO)
 *       ② 生きた issued 台帳行が存在しない (redeemed / 失効済みは塞がない = read 時判定)
 *       ③ fresh な activating が他に存在しない (stale >60min は再駆動対象として無視)
 *     負けた実行は changes=0 で静かに撤退する。
 *   - activating で落ちた行 (Shopify create 中の crash 等) は activation_started_at が古いまま残る。
 *     再駆動は planned_code で同じ code を再作成し、Shopify の code 重複エラーを
 *     「前回 create は成功していた」のシグナルとして扱う (issuer 層で処理)。
 *
 * 関連: packages/db/migrations/079_line_referral_coupon_queue.sql、
 *       apps/worker/src/services/referral-coupon-issuer.ts (活性化の Shopify 側)、
 *       apps/worker/src/services/coupon-expiry-sweep.ts (T2)
 */

export interface ReferralQueueRow {
  id: string;
  friend_id: string;
  reward_id: string;
  line_account_id: string | null;
  planned_code: string;
  discount_value: number;
  status: 'waiting' | 'activating' | 'activated' | 'cancelled';
  created_at: string;
  activation_started_at: string | null;
  activated_at: string | null;
  activated_coupon_id: string | null;
}

export interface EnqueueReferralCouponInput {
  id: string;
  friendId: string;
  rewardId: string;
  lineAccountId?: string | null;
  plannedCode: string;
  discountValue: number;
  /** 獲得 (紹介成立) 時刻 UTC ISO — FIFO の順序 */
  createdAt: string;
}

/** stale activating とみなす閾値 (これより古い activating は claim をブロックしない = 再駆動対象) */
export const ACTIVATING_STALE_MINUTES = 60;

/**
 * queue へ waiting 行を積む (reward_id UNIQUE で冪等)。
 * @returns 'inserted' | 'duplicate' (= 既に同 reward の行がある)
 */
export async function enqueueReferralCoupon(
  db: D1Database,
  input: EnqueueReferralCouponInput,
): Promise<'inserted' | 'duplicate'> {
  try {
    await db
      .prepare(
        `INSERT INTO line_referral_coupon_queue (
           id, friend_id, reward_id, line_account_id, planned_code, discount_value, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)`,
      )
      .bind(
        input.id,
        input.friendId,
        input.rewardId,
        input.lineAccountId ?? null,
        input.plannedCode,
        input.discountValue,
        input.createdAt,
      )
      .run();
    return 'inserted';
  } catch (err) {
    // UNIQUE(reward_id) 違反 = 並行 enqueue → 冪等 (既存行が正)
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) return 'duplicate';
    throw err;
  }
}

export async function findQueueRowByRewardId(
  db: D1Database,
  rewardId: string,
): Promise<ReferralQueueRow | null> {
  const row = await db
    .prepare(`SELECT * FROM line_referral_coupon_queue WHERE reward_id = ? LIMIT 1`)
    .bind(rewardId)
    .first<ReferralQueueRow>();
  return row ?? null;
}

/**
 * 次の 1 枚の活性化権を atomic に claim する。
 *
 * 単文 UPDATE の WHERE で以下を同時に強制 (D1 の write 直列化により race は changes=0 に潰れる):
 *   - 対象 = この friend の最古 waiting 1 行
 *   - この friend に「生きた」issued 台帳行 (未使用 + 未失効) が無い
 *   - この friend に fresh な activating 行 (staleThreshold 以降に開始) が他に無い
 *
 * @returns claim に勝ったら該当 queue 行 (status は activating に遷移済み)、負け/対象なしなら null
 */
export async function claimNextReferralCouponForActivation(
  db: D1Database,
  friendId: string,
  nowIso: string,
): Promise<ReferralQueueRow | null> {
  const staleThresholdIso = new Date(
    new Date(nowIso).getTime() - ACTIVATING_STALE_MINUTES * 60_000,
  ).toISOString();

  const res = await db
    .prepare(
      `UPDATE line_referral_coupon_queue
          SET status = 'activating', activation_started_at = ?1
        WHERE id = (
                SELECT id FROM line_referral_coupon_queue
                 WHERE friend_id = ?2 AND status = 'waiting'
                 ORDER BY created_at ASC, id ASC
                 LIMIT 1
              )
          AND status = 'waiting'
          AND NOT EXISTS (
                SELECT 1 FROM line_referral_coupons
                 WHERE friend_id = ?2
                   AND status = 'issued'
                   AND redeemed_at IS NULL
                   AND (expires_at IS NULL OR expires_at >= ?1)
              )
          AND NOT EXISTS (
                SELECT 1 FROM line_referral_coupon_queue
                 WHERE friend_id = ?2
                   AND status = 'activating'
                   AND activation_started_at >= ?3
              )`,
    )
    .bind(nowIso, friendId, staleThresholdIso)
    .run();

  if ((res.meta?.changes ?? 0) !== 1) return null;

  // 勝者はこの実行だけ (activating fresh は同時 1 行) なので、直近の activating 行 = 今 claim した行
  const row = await db
    .prepare(
      `SELECT * FROM line_referral_coupon_queue
        WHERE friend_id = ? AND status = 'activating'
        ORDER BY activation_started_at DESC
        LIMIT 1`,
    )
    .bind(friendId)
    .first<ReferralQueueRow>();
  return row ?? null;
}

/** 活性化成功: activating → activated (+ 発行された台帳行 id を記録)。 */
export async function markQueueRowActivated(
  db: D1Database,
  queueId: string,
  activatedAtIso: string,
  activatedCouponId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE line_referral_coupon_queue
          SET status = 'activated', activated_at = ?, activated_coupon_id = ?
        WHERE id = ? AND status = 'activating'`,
    )
    .bind(activatedAtIso, activatedCouponId, queueId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/**
 * 活性化失敗の補償: activating → waiting へ戻す (次の T1/T2/T3 が再試行する)。
 * activation_started_at は消す (= fresh activating として他 friend の claim をブロックし続けない)。
 */
export async function revertQueueRowToWaiting(
  db: D1Database,
  queueId: string,
  reason: string,
): Promise<boolean> {
  const patch = JSON.stringify({ lastActivationError: reason.slice(0, 200) });
  const res = await db
    .prepare(
      `UPDATE line_referral_coupon_queue
          SET status = 'waiting', activation_started_at = NULL,
              metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE id = ? AND status = 'activating'`,
    )
    .bind(patch, queueId)
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

/** friend の待機枚数 (waiting のみ)。fail-safe: テーブル未作成 (pre-migration) は 0。 */
export async function countWaitingReferralCoupons(
  db: D1Database,
  friendId: string,
): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM line_referral_coupon_queue
          WHERE friend_id = ? AND status = 'waiting'`,
      )
      .bind(friendId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * T2 (sweep) 用: waiting を持ち、かつ「生きた」issued 台帳行が無い friend を列挙する。
 * 各 friend につき claim → 活性化を 1 枚ずつ行う候補リスト。
 */
export async function listFriendsWithActivatableQueue(
  db: D1Database,
  nowIso: string,
  limit = 20,
): Promise<Array<{ friend_id: string; waiting: number }>> {
  const { results } = await db
    .prepare(
      `SELECT q.friend_id AS friend_id, COUNT(*) AS waiting
         FROM line_referral_coupon_queue q
        WHERE q.status = 'waiting'
          AND NOT EXISTS (
                SELECT 1 FROM line_referral_coupons c
                 WHERE c.friend_id = q.friend_id
                   AND c.status = 'issued'
                   AND c.redeemed_at IS NULL
                   AND (c.expires_at IS NULL OR c.expires_at >= ?1)
              )
        GROUP BY q.friend_id
        ORDER BY MIN(q.created_at) ASC
        LIMIT ?2`,
    )
    .bind(nowIso, limit)
    .all<{ friend_id: string; waiting: number }>();
  return results ?? [];
}

/**
 * stale な activating 行 (再駆動対象) を列挙する。
 * planned_code での再 create は Shopify 側 code 重複エラーが「前回成功済み」のシグナルになる。
 */
export async function listStuckActivatingRows(
  db: D1Database,
  nowIso: string,
  limit = 10,
): Promise<ReferralQueueRow[]> {
  const staleThresholdIso = new Date(
    new Date(nowIso).getTime() - ACTIVATING_STALE_MINUTES * 60_000,
  ).toISOString();
  const { results } = await db
    .prepare(
      `SELECT * FROM line_referral_coupon_queue
        WHERE status = 'activating' AND activation_started_at < ?
        ORDER BY activation_started_at ASC
        LIMIT ?`,
    )
    .bind(staleThresholdIso, limit)
    .all<ReferralQueueRow>();
  return results ?? [];
}
