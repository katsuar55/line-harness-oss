/**
 * Welcome クーポン redemption 追跡サービス — 第2波-⑤ (2026-07-01)
 *
 * Shopify の注文 webhook (orders/create / orders/updated) を受けた際、 注文に適用された
 * discount_codes を line_friend_coupons.coupon_code と照合し、 初回のみ redeemed_at を立てる。
 *
 * hook 元: apps/worker/src/routes/shopify.ts の orders/create|orders/updated handler。
 *   - orders/paid は本番で未購読 (= 受信ゼロ) のため、 購読済の orders/create を使う。
 *   - redemption は friend マッチと独立 (coupon_code → friend_id の対応で誰の coupon か判る)。
 *
 * 安全性:
 *   - 全 DB 操作は冪等 (redeemFriendCouponByCode の条件付き UPDATE)。
 *   - caller は waitUntil の best-effort で呼ぶ前提。 本 service 内でも各 code を try/catch で
 *     隔離し、 1 code の失敗が他 code や注文処理を巻き込まないようにする。
 *   - redeemed_at は issuer (shopify-coupon-issuer.ts) の issued_at と同形式 (UTC ISO 'Z') で揃える。
 */

import { redeemCouponByCode, COUPON_LEDGERS, type CouponLedger } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

interface ShopifyDiscountCodeEntry {
  code?: unknown;
  amount?: unknown;
  type?: unknown;
}

/**
 * Shopify 注文 webhook body から、 重複排除した非空の discount code 文字列配列を取り出す純関数。
 * - body.discount_codes は `[{ code, amount, type }, ...]` (REST Order JSON)。
 * - code が空 / 非文字列の entry は除外。 大文字小文字無視で重複排除 (同一 coupon の二重計上防止)。
 */
export function extractDiscountCodes(body: Record<string, unknown>): string[] {
  const raw = (body as { discount_codes?: unknown })?.discount_codes;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const code =
      entry !== null && typeof entry === 'object'
        ? (entry as ShopifyDiscountCodeEntry).code
        : undefined;
    const trimmed = typeof code === 'string' ? code.trim() : '';
    if (!trimmed) continue;
    const key = trimmed.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface ProcessRedemptionResult {
  /** 注文に乗っていた (重複排除後の) discount code 数 */
  codesChecked: number;
  /** いずれかの台帳に一致した code 数 (全台帳の合計) */
  matched: number;
  /** この呼び出しで実際に redeemed へ遷移させた code 数 (全台帳の合計) */
  redeemed: number;
  /**
   * 🚨 この呼び出しで「初回 redemption」を確定した **welcome クーポン**の所有 friend_id 群。
   *
   * **welcome 由来のみ**であることが契約。caller (routes/shopify.ts) はこれを
   * `processReferralRewardOnPurchase` = 「紹介された人が welcome クーポンを使ったので
   * 紹介者に ¥500 実クーポンを発行する」の起点に使うため、他台帳を混ぜてはいけない:
   *   - 連携特典 ¥300 を使った人が紹介報酬を発火させてしまう
   *   - 紹介報酬 ¥500 を使った人が、さらに別の紹介報酬を発火させてしまう
   * どちらも**実クーポンの誤発行 (= 実費)** になる。
   */
  redeemedFriendIds: string[];
  /**
   * この呼び出しで「初回 redemption」を確定した**紹介クーポン (referral 台帳)** の所有 friend_id 群。
   * 順次活性化 (R1) の T1 トリガー: この friend の queue から次の 1 枚を活性化する起点。
   * welcome の redeemedFriendIds とは意味が異なる (こちらは紹介報酬を発火**させない**)。
   */
  redeemedReferralFriendIds: string[];
  /** 台帳別の内訳 (可観測性用。どのクーポンが使われているかを cron ログで追える) */
  byLedger: Record<CouponLedger, { matched: number; redeemed: number }>;
}

/** 台帳ごとの audit action 名 (既存の welcome 分は名前を変えない) */
const AUDIT_ACTION: Record<CouponLedger, string> = {
  friend: 'line_friend_coupon.redeemed',
  referral: 'line_referral_coupon.redeemed',
  link: 'line_link_coupon.redeemed',
};

export interface ProcessRedemptionParams {
  body: Record<string, unknown>;
  shopifyOrderId: string;
  topic: string;
  lineAccountId?: string | null;
  /** test 用 clock 注入 */
  now?: () => number;
}

/**
 * 注文 body の discount_codes を走査して welcome クーポンの redemption を確定する。
 * 戻り値は集計サマリ (ログ / テスト用)。 例外は内部で握りつぶす (best-effort)。
 */
export async function processOrderCouponRedemption(
  db: D1Database,
  params: ProcessRedemptionParams,
): Promise<ProcessRedemptionResult> {
  const emptyByLedger = (): Record<CouponLedger, { matched: number; redeemed: number }> =>
    COUPON_LEDGERS.reduce(
      (acc, l) => { acc[l] = { matched: 0, redeemed: 0 }; return acc; },
      {} as Record<CouponLedger, { matched: number; redeemed: number }>,
    );

  const codes = extractDiscountCodes(params.body);
  if (codes.length === 0) {
    return {
      codesChecked: 0,
      matched: 0,
      redeemed: 0,
      redeemedFriendIds: [],
      redeemedReferralFriendIds: [],
      byLedger: emptyByLedger(),
    };
  }

  const nowMs = (params.now ?? Date.now)();
  const redeemedAtIso = new Date(nowMs).toISOString();
  const orderNumber = (params.body as { order_number?: unknown }).order_number;
  const financialStatus = (params.body as { financial_status?: unknown }).financial_status;

  let matched = 0;
  let redeemed = 0;
  const redeemedFriendIds = new Set<string>();
  const redeemedReferralFriendIds = new Set<string>();
  const byLedger = emptyByLedger();

  for (const code of codes) {
    // 全台帳を引く (どこで一致したかで打ち切らない)。code は shop 内で一意なので実際には
    // 高々 1 台帳しか当たらないが、**台帳の並び順に結果が依存しない**方が推論しやすく、
    // 「順番を入れ替えたら壊れる」種類のバグを作らない。1 注文の code は通常 0〜2 個。
    for (const ledger of COUPON_LEDGERS) {
      try {
        const result = await redeemCouponByCode(db, ledger, code, redeemedAtIso, {
          shopifyOrderId: params.shopifyOrderId,
          topic: params.topic,
          orderNumber: typeof orderNumber === 'number' || typeof orderNumber === 'string' ? orderNumber : null,
          financialStatus: typeof financialStatus === 'string' ? financialStatus : null,
        });

        if (result.matched) { matched += 1; byLedger[ledger].matched += 1; }
        if (result.redeemed) {
          redeemed += 1;
          byLedger[ledger].redeemed += 1;
          // 🚨 紹介報酬の起点になるので **welcome 由来だけ**を積む (他台帳を混ぜると実費の誤発行)
          if (ledger === 'friend' && result.friendId) redeemedFriendIds.add(result.friendId);
          // 順次活性化 (R1) の T1 起点: 紹介クーポンの初回 redemption 勝者イベントのみ。
          //   matched や alreadyRedeemed では積まない (= orders/updated 連投で二重活性化しない。
          //   実際の活性化側も DB 層 claim で守るが、起点自体を勝者イベントに絞るのが第一防壁)。
          if (ledger === 'referral' && result.friendId) redeemedReferralFriendIds.add(result.friendId);
          // 初回 redemption のみ audit に残す (= 転換の監査証跡、 admin /audit-logs で観察)。
          await auditSystem(db, {
            action: AUDIT_ACTION[ledger],
            actorType: 'webhook',
            targetType: 'friend',
            targetId: result.friendId ?? undefined,
            lineAccountId: result.lineAccountId,
            result: 'success',
            metadata: {
              code,
              ledger,
              shopifyOrderId: params.shopifyOrderId,
              topic: params.topic,
            },
          });
        }
      } catch (err) {
        console.error(
          `[coupon-redemption] redeem failed for code ${code} (ledger ${ledger}, order ${params.shopifyOrderId}):`,
          err,
        );
        // 1 台帳の失敗は他台帳・他 code を止めない (テーブル未作成の環境も想定)
      }
    }
  }

  return {
    codesChecked: codes.length,
    matched,
    redeemed,
    redeemedFriendIds: [...redeemedFriendIds],
    redeemedReferralFriendIds: [...redeemedReferralFriendIds],
    byLedger,
  };
}
