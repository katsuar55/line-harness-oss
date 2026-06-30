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

import { redeemFriendCouponByCode } from '@line-crm/db';
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
  /** line_friend_coupons に一致した code 数 */
  matched: number;
  /** この呼び出しで実際に redeemed へ遷移させた code 数 */
  redeemed: number;
}

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
  const codes = extractDiscountCodes(params.body);
  if (codes.length === 0) {
    return { codesChecked: 0, matched: 0, redeemed: 0 };
  }

  const nowMs = (params.now ?? Date.now)();
  const redeemedAtIso = new Date(nowMs).toISOString();
  const orderNumber = (params.body as { order_number?: unknown }).order_number;
  const financialStatus = (params.body as { financial_status?: unknown }).financial_status;

  let matched = 0;
  let redeemed = 0;

  for (const code of codes) {
    try {
      const result = await redeemFriendCouponByCode(db, code, redeemedAtIso, {
        shopifyOrderId: params.shopifyOrderId,
        topic: params.topic,
        orderNumber: typeof orderNumber === 'number' || typeof orderNumber === 'string' ? orderNumber : null,
        financialStatus: typeof financialStatus === 'string' ? financialStatus : null,
      });

      if (result.matched) matched += 1;
      if (result.redeemed) {
        redeemed += 1;
        // 初回 redemption のみ audit に残す (= 転換の監査証跡、 admin /audit-logs で観察)。
        await auditSystem(db, {
          action: 'line_friend_coupon.redeemed',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: result.friendId ?? undefined,
          lineAccountId: result.lineAccountId,
          result: 'success',
          metadata: {
            code,
            shopifyOrderId: params.shopifyOrderId,
            topic: params.topic,
          },
        });
      }
    } catch (err) {
      console.error(
        `[coupon-redemption] redeem failed for code ${code} (order ${params.shopifyOrderId}):`,
        err,
      );
      // 1 code の失敗は他 code を止めない
    }
  }

  return { codesChecked: codes.length, matched, redeemed };
}
