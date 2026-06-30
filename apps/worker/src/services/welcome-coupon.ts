/**
 * 友だち追加時に発行済みの「あなた専用」welcomeクーポン (line_friend_coupons) を
 * LIFF ポータルに表示するための read + 残り時間整形。
 *
 * 背景 (2026-06-30 第1波-①):
 *   webhook follow event で issueCouponForFriend が ¥500 OFF クーポンを 1 friend 1 回発行し
 *   line_friend_coupons に保存済 (issued_at/expires_at は UTC ISO 'Z')。 しかし LIFF には一切
 *   表示されておらず (友だち専用クーポンの取りこぼし)。 本サービスでそれを LIFF に出し、
 *   「あと◯日で失効」の希少性で初回購入を後押しする。 配信不要 = opt-in 0.1% を完全に回避。
 *
 * 本ファイルは read-only + 純整形のみ (発行/更新はしない・AI 経路にも触れない)。
 */

export interface WelcomeCoupon {
  code: string;
  discountValue: number;
  discountCurrency: string;
  expiresAt: string | null;
  issuedAt: string;
}

interface WelcomeCouponRow {
  coupon_code: string;
  discount_value: number;
  discount_currency: string | null;
  expires_at: string | null;
  issued_at: string;
}

/**
 * friend の「有効な」 welcomeクーポンを 1 件返す (なければ null)。
 * active = status='issued' かつ (expires_at IS NULL もしくは未来)。
 * expires_at は issueCouponForFriend が `new Date(...).toISOString()` (UTC 'Z') で保存するため、
 * 比較値も `new Date().toISOString()` (UTC 'Z') を bind して同形式で突き合わせる。
 * 失敗時 (テーブル欠落等) は null を返す fail-safe (LIFF を壊さない)。
 */
export async function getActiveWelcomeCoupon(
  db: D1Database,
  friendId: string,
): Promise<WelcomeCoupon | null> {
  try {
    const nowIso = new Date().toISOString();
    const row = await db
      .prepare(
        `SELECT coupon_code, discount_value, discount_currency, expires_at, issued_at
           FROM line_friend_coupons
          WHERE friend_id = ? AND status = 'issued'
            AND (expires_at IS NULL OR expires_at >= ?)
          ORDER BY issued_at DESC LIMIT 1`,
      )
      .bind(friendId, nowIso)
      .first<WelcomeCouponRow>();
    if (!row) return null;
    return {
      code: row.coupon_code,
      discountValue: row.discount_value,
      discountCurrency: row.discount_currency ?? 'JPY',
      expiresAt: row.expires_at,
      issuedAt: row.issued_at,
    };
  } catch (err) {
    console.error(
      '[welcome-coupon] getActiveWelcomeCoupon failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * 失効までの残り時間を顧客向け文言にする (純関数・nowMs 引数化でテスト可能)。
 * - 1日以上: 「あと◯日」
 * - 1時間以上1日未満: 「あと◯時間」
 * - 1時間未満(失効直前): 「まもなく終了」
 * - 失効済 / 期限なし / 不正値: null (= カウントダウン非表示)
 */
export function formatCouponCountdown(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt) return null;
  const exp = Date.parse(expiresAt);
  if (Number.isNaN(exp)) return null;
  const remMs = exp - nowMs;
  if (remMs <= 0) return null;
  const remHours = Math.floor(remMs / 3_600_000);
  const days = Math.floor(remHours / 24);
  if (days >= 1) return `あと${days}日`;
  if (remHours >= 1) return `あと${remHours}時間`;
  return 'まもなく終了';
}
