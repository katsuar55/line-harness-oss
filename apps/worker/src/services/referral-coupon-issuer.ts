/**
 * Referral Coupon Issuer Service (= 友だち紹介の両側実クーポン発行, 2026-07-10)
 *
 * 役割: 友だち紹介の referred / referrer それぞれに ¥500 OFF の Shopify 実クーポンを発行する。
 *   - referred = claim (友だち追加→ポータル ?ref) 時に即時発行
 *   - referrer = referred が購入して初めて発行 (呼び出しは referral-reward.ts)
 *
 * 設計 (welcome coupon + rank discount の合成):
 *   - discountCodeBasicCreate (固定額 ¥500、 usageLimit=1、 appliesOncePerCustomer=true = 単回)。
 *     ← welcome coupon (shopify-coupon-issuer.ts) と同じ「1 回限り固定額」。
 *   - combinesWith product+order 両 true (= ランク割引 NLR- と併用可、 Plus 不要のクロスクラス)。
 *     ← rank-discount-issuer.ts と同じ stacking 設定。
 *   - friend × role ごとに active は 1 枚 (line_referral_coupons UNIQUE(friend_id, role) で冪等)。
 *   - 有効期限 7 日 (Katsu 確定、 B2C マーケ best practice 3-7 日)。
 *
 * ⚠️ 本番ガード: REFERRAL_REWARD_ENABLED='true' でなければ no-op (= 承認前は本番 Shopify に書き込まない)。
 *   default off。 migration 068 適用 + Katsu 承認後に env を設定して有効化。
 *
 * セキュリティ / 既知トラップ (CLAUDE.md):
 *   - access token は getShopifyAccessToken (D1 cache + Client Credentials)。
 *   - fetch は fetch.bind(globalThis) で渡す (= Illegal invocation 回避)。
 *   - 例外/token は console.error にとどめ caller には null (情報漏洩防止)。
 *
 * 関連: services/shopify-coupon-issuer.ts (welcome)、 services/rank-discount-issuer.ts (rank)、 migration 068。
 */

import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';

// ============================================================
// 定数
// ============================================================

const DEFAULT_DISCOUNT_VALUE_JPY = 500;
// Katsu 確定: 7 日 (B2C は希少性 + 損失回避で短期限が conversion ↑、 業界 best practice 3-7 日)
const DEFAULT_VALID_DAYS = 7;
const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= claim HTTP / 購入 webhook waitUntil) のため coupon-issuer の 3s より長め
const SHOPIFY_TIMEOUT_MS = 8_000;
// ambiguous な 0/1/O/I/L を除外した base31 alphabet (= 人間が読み書きしやすい)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SUFFIX_LENGTH = 8;
const CODE_NAMESPACE = 'NREF'; // naturism referral (= welcome LINE- / rank NLR- と衝突回避)

export type ReferralRole = 'referrer' | 'referred';

// ============================================================
// types
// ============================================================

export interface ReferralCouponEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で本番発行を有効化。 未設定/その他なら no-op (= 承認前は本番未書込)。 */
  REFERRAL_REWARD_ENABLED?: string;
}

export interface IssueReferralCouponOptions {
  friendId: string;
  role: ReferralRole;
  /** referral_rewards.id (= 冪等キー・必須。 未指定なら発行しない。 成立1件につき1枚)。 */
  rewardId?: string | null;
  lineAccountId?: string | null;
  discountValueJpy?: number;
  validDays?: number;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis)) */
  fetchImpl?: typeof fetch;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface IssuedReferralCoupon {
  code: string;
  discountValue: number;
  discountCurrency: string;
  role: ReferralRole;
  expiresAt: string | null;
  /** true if returned from DB (already issued earlier for this friend+role) */
  isExisting: boolean;
  shopifyDiscountCodeId: string | null;
}

interface ExistingReferralCouponRow {
  coupon_code: string;
  discount_value: number;
  discount_currency: string;
  expires_at: string | null;
  shopify_discount_code_id: string | null;
}

// ============================================================
// 既発行チェック (reward_id で冪等 = 紹介成立1件につき1枚)
// ============================================================

export async function findReferralCoupon(
  db: D1Database,
  rewardId: string,
): Promise<ExistingReferralCouponRow | null> {
  const row = await db
    .prepare(
      `SELECT coupon_code, discount_value, discount_currency, expires_at, shopify_discount_code_id
         FROM line_referral_coupons
        WHERE reward_id = ?
        LIMIT 1`,
    )
    .bind(rewardId)
    .first<ExistingReferralCouponRow>();
  return row ?? null;
}

function toIssued(row: ExistingReferralCouponRow, role: ReferralRole): IssuedReferralCoupon {
  return {
    code: row.coupon_code,
    discountValue: row.discount_value,
    discountCurrency: row.discount_currency,
    role,
    expiresAt: row.expires_at,
    isExisting: true,
    shopifyDiscountCodeId: row.shopify_discount_code_id,
  };
}

// ============================================================
// コード生成 (namespace + role 頭文字 + random suffix)
// ============================================================

function generateReferralCode(role: ReferralRole): string {
  const bytes = new Uint8Array(CODE_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  // role 頭文字 (R=referrer / D=referred) を挟み、 監査で役割が読める
  const roleTag = role === 'referrer' ? 'R' : 'D';
  return `${CODE_NAMESPACE}-${roleTag}-${suffix}`;
}

// ============================================================
// Shopify GraphQL discountCodeBasicCreate (= 固定額 + combinesWith)
// ============================================================

interface ShopifyReferralDiscountResponse {
  data?: {
    discountCodeBasicCreate?: {
      codeDiscountNode?: {
        id: string;
        codeDiscount?: { codes?: { nodes?: Array<{ code: string }> } };
      };
      userErrors?: Array<{ code?: string; field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

type ShopifyReferralCreateResult =
  | { ok: true; discountCodeId: string; actualCode: string }
  | { ok: false; error: string };

async function callReferralDiscountCreate(
  storeDomain: string,
  accessToken: string,
  code: string,
  discountAmount: number,
  role: ReferralRole,
  startsAt: string,
  endsAt: string,
  fetchImpl: typeof fetch,
): Promise<ShopifyReferralCreateResult> {
  const mutation = `
    mutation referralDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { code field message }
      }
    }
  `;
  const variables = {
    basicCodeDiscount: {
      title: `naturism 紹介特典 ${discountAmount} OFF (${role})`,
      code,
      startsAt,
      endsAt,
      customerSelection: { all: true },
      customerGets: {
        value: { discountAmount: { amount: discountAmount, appliesOnEachItem: false } },
        items: { all: true },
      },
      // ランク割引 (order-class) と併用可にする (= クロスクラス、 Plus 不要)。
      // welcome は combinesWith 未指定 (= 併用不可) だが、 紹介はランク併用を明示要件とする。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      appliesOncePerCustomer: true, // 単回
      usageLimit: 1, // 単回
      tags: ['referral', `referral-${role}`],
    },
  };

  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: mutation, variables }),
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }

  let body: ShopifyReferralDiscountResponse;
  try {
    body = (await res.json()) as ShopifyReferralDiscountResponse;
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (body.errors && body.errors.length > 0) {
    return { ok: false, error: body.errors.map((e) => e.message).join('; ') };
  }
  const result = body.data?.discountCodeBasicCreate;
  if (!result) {
    return { ok: false, error: 'no discountCodeBasicCreate in response' };
  }
  if (result.userErrors && result.userErrors.length > 0) {
    return {
      ok: false,
      error: result.userErrors.map((e) => `${e.code ?? 'ERR'}: ${e.message}`).join('; '),
    };
  }
  const discountCodeId = result.codeDiscountNode?.id;
  const actualCode = result.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code;
  if (!discountCodeId || !actualCode) {
    return { ok: false, error: 'incomplete response (no id or code)' };
  }
  return { ok: true, discountCodeId, actualCode };
}

// ============================================================
// main: issueReferralCoupon
// ============================================================

export async function issueReferralCoupon(
  db: D1Database,
  env: ReferralCouponEnv,
  options: IssueReferralCouponOptions,
): Promise<IssuedReferralCoupon | null> {
  const { friendId, role } = options;
  const lineAccountId = options.lineAccountId ?? null;
  const rewardId = options.rewardId ?? null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 1. 本番ガード: 承認前は no-op (= 本番 Shopify に書き込まない)
  if (env.REFERRAL_REWARD_ENABLED !== 'true') {
    console.info('[referral-coupon-issuer] gated off (REFERRAL_REWARD_ENABLED!=true) friend=', friendId, 'role=', role);
    return null;
  }

  // 2. 既発行確認 (reward_id で冪等 = 紹介成立1件につき1枚。 同 referrer でも別 reward なら別途発行)
  if (!rewardId) {
    console.error('[referral-coupon-issuer] rewardId required (= 冪等キー・NOT NULL) friend=', friendId);
    return null;
  }
  const existing = await findReferralCoupon(db, rewardId);
  if (existing) {
    return toIssued(existing, role);
  }

  // 3. Shopify config 確認
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.error('[referral-coupon-issuer] Shopify credentials not configured');
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: 'Shopify credentials not configured',
      metadata: { stage: 'config_check', role },
    });
    return null;
  }

  // 4. access token
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[referral-coupon-issuer] access token unavailable:', errMsg);
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token', role },
    });
    return null;
  }

  // 5. 生成 + Shopify 発行
  const discountValue = options.discountValueJpy ?? DEFAULT_DISCOUNT_VALUE_JPY;
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  const now = nowFn();
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + validDays * 86_400_000).toISOString();
  const code = generateReferralCode(role);

  const result = await callReferralDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    code,
    discountValue,
    role,
    startsAt,
    endsAt,
    fetchImpl,
  );
  if (!result.ok) {
    console.error('[referral-coupon-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', role, apiVersion: SHOPIFY_API_VERSION },
    });
    return null;
  }

  // 6. DB 記録 (reward_id UNIQUE — 並行呼び出しの重複は INSERT 失敗、 そのときは既発行を再取得)
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO line_referral_coupons (
           id, friend_id, reward_id, role, coupon_code, shopify_discount_code_id,
           discount_value, discount_currency, issued_at, expires_at, status, line_account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
      )
      .bind(
        id,
        friendId,
        rewardId,
        role,
        result.actualCode,
        result.discountCodeId,
        discountValue,
        'JPY',
        startsAt,
        endsAt,
        lineAccountId,
      )
      .run();
  } catch (err) {
    // UNIQUE(reward_id) 違反 → 同 reward が並行発行された → re-fetch
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      '[referral-coupon-issuer] INSERT failed (likely UNIQUE conflict), re-fetching existing:',
      errMsg,
    );
    const refetch = await findReferralCoupon(db, rewardId);
    if (refetch) {
      return toIssued(refetch, role);
    }
    // Shopify には発行されたが DB 未記録 (orphan)。 caller は null。
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', role, shopifyDiscountCodeId: result.discountCodeId },
    });
    return null;
  }

  await auditSystem(db, {
    action: 'referral_coupon.issued',
    actorType: 'system',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      code: result.actualCode,
      shopifyDiscountCodeId: result.discountCodeId,
      role,
      discountValue,
      validDays,
      rewardId,
    },
  });

  return {
    code: result.actualCode,
    discountValue,
    discountCurrency: 'JPY',
    role,
    expiresAt: endsAt,
    isExisting: false,
    shopifyDiscountCodeId: result.discountCodeId,
  };
}

// ============================================================
// DB-only lookup (表示用: friend の active な紹介クーポン群)
// ============================================================

export interface ActiveReferralCoupon {
  code: string;
  discountValue: number;
  role: ReferralRole;
  expiresAt: string | null;
}

/**
 * friend (= referrer) の「まだ使える」紹介クーポンを全件返す (表示用、 env/Shopify API 不要)。
 * referrer は紹介成立ごとに 1 枚 = 複数持ちうるため配列で返す (最新発行順、 最大 limit 枚)。
 * status='issued' かつ未失効 (expires_at が未来 or NULL)。
 * fail-safe: エラー時は [] (= テーブル未存在の pre-migration でも安全)。
 */
export async function getActiveReferralCoupons(
  db: D1Database,
  friendId: string,
  nowIso?: string,
  limit = 20,
): Promise<ActiveReferralCoupon[]> {
  const iso = nowIso ?? new Date().toISOString();
  try {
    const { results } = await db
      .prepare(
        `SELECT coupon_code, discount_value, role, expires_at
           FROM line_referral_coupons
          WHERE friend_id = ?
            AND status = 'issued'
            AND (expires_at IS NULL OR expires_at >= ?)
          ORDER BY issued_at DESC
          LIMIT ?`,
      )
      .bind(friendId, iso, limit)
      .all<{ coupon_code: string; discount_value: number; role: ReferralRole; expires_at: string | null }>();
    return (results ?? []).map((row) => ({
      code: row.coupon_code,
      discountValue: row.discount_value,
      role: row.role,
      expiresAt: row.expires_at,
    }));
  } catch (err) {
    console.error(
      '[referral-coupon-issuer] getActiveReferralCoupons failed (fail-safe []):',
      err instanceof Error ? err.name : 'unknown',
    );
    return [];
  }
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  generateReferralCode,
  callReferralDiscountCreate,
  DEFAULT_DISCOUNT_VALUE_JPY,
  DEFAULT_VALID_DAYS,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
  CODE_NAMESPACE,
};
