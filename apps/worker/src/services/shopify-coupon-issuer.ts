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
import { auditSystem } from './audit-logger.js';

// ============================================================
// 定数
// ============================================================

// 2026-08-24 Katsu 決定: ¥300 → ¥500 に**戻す**。
//   2026-08-14 の ¥300 化 (PR-C #255) は実額だけを下げ、顧客向け文言を 1 つも追随させなかった。
//   友だち追加の挨拶・招待文・紹介カード・月次 Flex・管理画面がすべて「500 円 OFF」と言い続けて
//   いたため、実装を文言に合わせる方を選んだ (景表法の有利誤認を消すのが目的)。
//   帰結: 紹介経由の人だけ ¥500 へ格上げする機構 (welcome-upgrade.ts) は**不要になり削除**した。
//   既発行分は台帳の discount_value が正 (遡及書換なし) = ¥300 で発行済みの分はそのまま。
// 顧客向け文言 (紹介ヒーロー / 招待文 / 紹介 LP / 月次 Flex) が約束する額と**同じ値**。
// 定数だけ動かして文言が置き去りになる事故 (#255 で実際に起きた) を防ぐため export し、
// テストで「約束している額 === 発行する額」を固定する。
export const WELCOME_DISCOUNT_VALUE_JPY = 500;
const DEFAULT_DISCOUNT_VALUE_JPY = WELCOME_DISCOUNT_VALUE_JPY;
// 全券共通の最低購入金額 (Katsu 確定 ¥2,000 — 小型缶 ¥389/¥430 が ¥0 になる事故を防ぐ)
export const MIN_SUBTOTAL_JPY = 2000;
// 5β-1d-2e (2026-05-19): 90 日 → 3 日 に短縮 (= マーケ最適化、 業界 best practice 3-7 日)
// 根拠: 行動経済学的 (希少性 + 損失回避 + 後悔回避) で短期限が conversion ↑、
// HubSpot 調査で 48h 限定 coupon の redemption rate は 30 日 coupon の 3-4 倍
//
// 2026-08-24: 既定値そのものを 7 日にした。本番の呼び元 (follow webhook) は当初から
//   validDays:7 を明示しており、既定の 3 日は**どこからも使われていない値**だった。
//   にもかかわらずトークの「マイクーポン」Flex は「3 日間有効」と案内しており、
//   使われない既定値が顧客向け文言の根拠として独り歩きしていた (実際は 7 日)。
//   顧客に出す日数と 1 箇所で対応させるため、この定数を唯一の正とする。
export const WELCOME_VALID_DAYS = 7;
const DEFAULT_VALID_DAYS = WELCOME_VALID_DAYS;
const DEFAULT_CODE_PREFIX = 'LINE';
// 5β-1d-2c (2026-05-19): API version を他 service (shopify-customer-sync.ts 等) と統一 (2024-04 → 2026-04)
// 古い 2024-04 のままだと Shopify Admin GraphQL endpoint で 404 が返るため修正
const SHOPIFY_API_VERSION = '2026-04';
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
  /**
   * 新規ユーザー限定 welcome クーポン用の顧客セグメント gid
   * (例: gid://shopify/Segment/xxx = 「注文回数 0」の first-time buyers)。
   * 設定時、 welcome クーポンはこのセグメントのみ対象 (= 既存客の farming 防止)。 未設定なら全顧客。
   */
  SHOPIFY_WELCOME_CUSTOMER_SEGMENT_ID?: string;
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
  customerSegmentId?: string | null,
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
      // 新規ユーザー限定 (Katsu 確定): SHOPIFY_WELCOME_CUSTOMER_SEGMENT_ID が設定されていれば、
      //   その顧客セグメント (= 例「注文回数 0 の first-time buyers」) だけを対象にする。
      //   未設定なら従来どおり all (= 全顧客)。 usageLimit:1 + appliesOncePerCustomer で 1 回限り。
      customerSelection: customerSegmentId
        ? { customerSegments: { add: [customerSegmentId] } }
        : { all: true },
      customerGets: {
        value: { discountAmount: { amount: discountAmount, appliesOnEachItem: false } },
        items: { all: true },
        // 定期便チェックアウトでも使える (単発は従来どおり)。
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: true,
      },
      // 🚨 appliesOnSubscription とセットで**必須**: 契約に保存されたコードは条件を再評価せず
      //   recurringCycleLimit まで毎サイクル適用され続ける (0/未指定=無期限の危険側)。
      //   1 = 初回サイクルのみ。外すと ¥300 が毎回の定期便に永久に引かれ、我々からは契約から外せない。
      recurringCycleLimit: 1,
      // 併用ON (2026-08-13 Katsu 決定)。4 系統は全て ORDER クラス (本番実測) で、これで
      //   紹介・連携・ランクと実際に重なる。min¥2,000 が過剰値引きのガード。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(MIN_SUBTOTAL_JPY) } },
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
  const lineAccountId = options.lineAccountId ?? null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 5β-1d-2f: 入口 log (production 真因確定用、 wrangler tail で観察可能)
  console.info('[shopify-coupon-issuer] start friend=', friendId);

  // 1. 既発行確認 (冪等性、 重複発行防止)
  const existing = await findExistingCoupon(db, friendId);
  if (existing) {
    console.info('[shopify-coupon-issuer] already-issued friend=', friendId, 'code=', existing.code);
    // H6 (2026-05-23): silent skip path に audit_log 追加
    //   理由: LP リハーサル時に「リフォローしても何も起きない」 と運用側が困惑したため (= 課題 1 と
    //   区別がつかない)。 既発行 idempotent skip を audit に残せば admin /audit-logs で
    //   `action LIKE 'line_friend_coupon.already_issued'` で「正常 skip」 を視認できる。
    //   result='success' で記録 (= 既発行 coupon の return は本来 success path)。
    await auditSystem(db, {
      action: 'line_friend_coupon.already_issued',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'success',
      metadata: { stage: 'idempotent_skip', existingCode: existing.code },
    });
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
    // 5β-1d-2f: warn → error 昇格 + audit_logs 永続化 (真因絞り込み用)
    console.error('[shopify-coupon-issuer] Shopify credentials not configured');
    await auditSystem(db, {
      action: 'line_friend_coupon.issue_failed',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: 'Shopify credentials not configured',
      metadata: { stage: 'config_check' },
    });
    return null;
  }

  // 3. access token 取得 (失敗時は null return)
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[shopify-coupon-issuer] access token unavailable:', errMsg);
    await auditSystem(db, {
      action: 'line_friend_coupon.issue_failed',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token' },
    });
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
    env.SHOPIFY_WELCOME_CUSTOMER_SEGMENT_ID || null,
  );
  if (!result.ok) {
    console.error('[shopify-coupon-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'line_friend_coupon.issue_failed',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', apiVersion: SHOPIFY_API_VERSION },
    });
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
        lineAccountId,
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
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      '[shopify-coupon-issuer] INSERT failed (likely UNIQUE conflict), re-fetching existing:',
      errMsg,
    );
    await auditSystem(db, {
      action: 'line_friend_coupon.issue_failed',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', shopifyDiscountCodeId: result.discountCodeId },
    });
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

  // 5β-1d-2f: 成功時も audit_logs 記録 (= 自然流入で issue 成功実績を可視化)
  console.info('[shopify-coupon-issuer] success friend=', friendId, 'code=', result.actualCode);
  await auditSystem(db, {
    action: 'line_friend_coupon.issue_succeeded',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      code: result.actualCode,
      shopifyDiscountCodeId: result.discountCodeId,
      discountValue,
      validDays,
    },
  });

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
