/**
 * Shopify Coupon Issuer Service (Phase 5β-1d-2)
 *
 * 役割: LINE 友だち追加時に、 1 friend 1 回限り Shopify 連動の動的クーポンを発行する。
 *
 * 動作:
 *   1. line_friend_coupons に既発行 row があればその code を返す (冪等)
 *   2. なければ Shopify Admin GraphQL の `discountCodeBasicCreate` で新クーポン発行
 *   3. 発行成功なら DB に row 追加して return
 *   4. 失敗 (Shopify API timeout / error / scope 不足等) なら null return
 *      → caller は coupon なしで message を送る (safe fallback、 業務阻害なし)
 *
 * セキュリティ:
 *   - Shopify access token は getShopifyAccessToken (D1 cache + Client Credentials Grant)
 *   - clientCredentials は env から
 *   - tokens / API 例外は console.warn にとどめ、 caller には null を返す (情報漏洩防止)
 *
 * 冪等性: friend_id UNIQUE 制約 + 取得 first を try する
 *
 * timeout: Shopify API 3 秒 (LINE follow event 内で synchronous 呼び出し、 reply window 短い)
 *
 * 関連: services/shopify-token.ts (access token cache)、 migration 050
 */

import { getShopifyAccessToken } from './shopify-token.js';

// ============================================================
// 定数
// ============================================================

const DEFAULT_DISCOUNT_VALUE_JPY = 500;
const DEFAULT_VALID_DAYS = 90;
const DEFAULT_CODE_PREFIX = 'LINE';
const SHOPIFY_API_VERSION = '2024-04';
const SHOPIFY_TIMEOUT_MS = 3_000;

// ambiguous な 0/1/O/I/L を除外した base31 alphabet (人間が読み書きしやすい、 OCR ミス防止)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SUFFIX_LENGTH = 8;

// ============================================================
// types
// ============================================================

export interface IssuedCoupon {
  code: string;
  discountValue: number;
  discountCurrency: string;
  expiresAt: string | null;
  /** true if returned from DB (already issued earlier) */
  isExisting: boolean;
  shopifyDiscountCodeId: string | null;
}

export interface IssueCouponOptions {
  friendId: string;
  lineAccountId?: string | null;
  discountValueJpy?: number;
  validDays?: number;
  codePrefix?: string;
  /** test 用 fetch 注入 (default: global fetch、 globalThis に bind 済み — CLAUDE.md ルール) */
  fetchImpl?: typeof fetch;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface ShopifyEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
}

interface ExistingCouponRow {
  code: string;
  discount_value: number;
  discount_currency: string;
  expires_at: string | null;
  shopify_discount_code_id: string | null;
}

// ============================================================
// 既発行チェック
// ============================================================

async function findExistingCoupon(
  db: D1Database,
  friendId: string,
): Promise<ExistingCouponRow | null> {
  const row = await db
    .prepare(
      `SELECT coupon_code AS code, discount_value, discount_currency, expires_at, shopify_discount_code_id
         FROM line_friend_coupons
        WHERE friend_id = ?
        LIMIT 1`,
    )
    .bind(friendId)
    .first<ExistingCouponRow>();
  return row ?? null;
}

// ============================================================
// クーポンコード生成 (random、 friend_id とは独立、 推測困難)
// ============================================================

function generateCouponCode(prefix: string): string {
  const bytes = new Uint8Array(CODE_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${prefix}-${suffix}`;
}

// ============================================================
// Shopify GraphQL discountCodeBasicCreate
// ============================================================

interface ShopifyDiscountResponse {
  data?: {
    discountCodeBasicCreate?: {
      codeDiscountNode?: {
        id: string;
        codeDiscount?: {
          codes?: { nodes?: Array<{ code: string }> };
        };
      };
      userErrors?: Array<{ code?: string; field?: string[]; message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

type ShopifyCreateResult =
  | { ok: true; discountCodeId: string; actualCode: string }
  | { ok: false; error: string };

async function callShopifyDiscountCreate(
  storeDomain: string,
  accessToken: string,
  code: string,
  discountAmount: number,
  validDays: number,
  now: number,
  fetchImpl: typeof fetch,
): Promise<ShopifyCreateResult> {
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + validDays * 86_400_000).toISOString();
  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
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
      title: `LINE Welcome ${discountAmount} OFF`,
      code,
      startsAt,
      endsAt,
      customerSelection: { all: true },
      customerGets: {
        value: { discountAmount: { amount: discountAmount, appliesOnEachItem: false } },
        items: { all: true },
      },
      appliesOncePerCustomer: true,
      usageLimit: 1,
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

  let body: ShopifyDiscountResponse;
  try {
    body = (await res.json()) as ShopifyDiscountResponse;
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
// main: issueCouponForFriend
// ============================================================

export async function issueCouponForFriend(
  db: D1Database,
  env: ShopifyEnv,
  options: IssueCouponOptions,
): Promise<IssuedCoupon | null> {
  const friendId = options.friendId;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 1. 既発行確認 (冪等性、 重複発行防止)
  const existing = await findExistingCoupon(db, friendId);
  if (existing) {
    return {
      code: existing.code,
      discountValue: existing.discount_value,
      discountCurrency: existing.discount_currency,
      expiresAt: existing.expires_at,
      isExisting: true,
      shopifyDiscountCodeId: existing.shopify_discount_code_id,
    };
  }

  // 2. Shopify config 確認
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.warn('[shopify-coupon-issuer] Shopify credentials not configured');
    return null;
  }

  // 3. access token 取得 (失敗時は null return)
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    console.warn(
      '[shopify-coupon-issuer] access token unavailable:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // 4. 新コード生成 + Shopify 発行
  const discountValue = options.discountValueJpy ?? DEFAULT_DISCOUNT_VALUE_JPY;
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  const codePrefix = options.codePrefix ?? DEFAULT_CODE_PREFIX;
  const now = nowFn();
  const code = generateCouponCode(codePrefix);

  const result = await callShopifyDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    code,
    discountValue,
    validDays,
    now,
    fetchImpl,
  );
  if (!result.ok) {
    console.warn('[shopify-coupon-issuer] discountCodeBasicCreate failed:', result.error);
    return null;
  }

  // 5. DB 記録 (友だち 1 回限り — UNIQUE 制約で重複は INSERT 失敗、 そのときは既発行 row を再取得)
  const id = crypto.randomUUID();
  const expiresAt = new Date(now + validDays * 86_400_000).toISOString();
  const issuedAt = new Date(now).toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO line_friend_coupons (
           id, friend_id, line_account_id, coupon_code, shopify_discount_code_id,
           discount_value, discount_currency, issued_at, expires_at, status, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', 'shopify')`,
      )
      .bind(
        id,
        friendId,
        options.lineAccountId ?? null,
        result.actualCode,
        result.discountCodeId,
        discountValue,
        'JPY',
        issuedAt,
        expiresAt,
      )
      .run();
  } catch (err) {
    // friend_id UNIQUE 違反 → 並行 follow event 等で既発行された → re-fetch
    console.warn(
      '[shopify-coupon-issuer] INSERT failed (likely UNIQUE conflict), re-fetching existing:',
      err instanceof Error ? err.message : String(err),
    );
    const refetch = await findExistingCoupon(db, friendId);
    if (refetch) {
      return {
        code: refetch.code,
        discountValue: refetch.discount_value,
        discountCurrency: refetch.discount_currency,
        expiresAt: refetch.expires_at,
        isExisting: true,
        shopifyDiscountCodeId: refetch.shopify_discount_code_id,
      };
    }
    // Shopify 側には発行されたが DB には記録できなかった (orphan)。 caller は null を受け取る。
    // 別 cron で「Shopify にあるが DB にない」 を見つけて補正する余地 (将来課題)。
    return null;
  }

  return {
    code: result.actualCode,
    discountValue,
    discountCurrency: 'JPY',
    expiresAt,
    isExisting: false,
    shopifyDiscountCodeId: result.discountCodeId,
  };
}

// ============================================================
// DB-only lookup (caller chain で env を持たない場面用)
//
// step-delivery.ts (cron 配信) は env / Shopify API なしで coupon code を取得する必要がある。
// friend_add 時に発行済なら DB に row があるので、 そこから取得する純粋 read-only 関数。
// ============================================================

export async function getCouponCodeForFriend(
  db: D1Database,
  friendId: string,
): Promise<string | null> {
  const row = await findExistingCoupon(db, friendId);
  return row?.code ?? null;
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  generateCouponCode,
  findExistingCoupon,
  callShopifyDiscountCreate,
  DEFAULT_DISCOUNT_VALUE_JPY,
  DEFAULT_VALID_DAYS,
  DEFAULT_CODE_PREFIX,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
};
