/**
 * Link Reward Coupon Issuer Service (= 連携特典クーポン発行, Sprint A-1, 2026-08-11)
 *
 * 役割: LINE⇔Shopify アカウント連携を顧客自身が完了した瞬間に ¥300 OFF の
 *   Shopify 実クーポンを 1 枚発行する。
 *   狙い = gate 開放条件 crit1「LINE 到達可能な連携済み active 契約 >30」(現在 4) を
 *   動かす連携インセンティブ。「連携すると 1 秒でお得」を体感させる。
 *
 * 呼び出し元 (route 層の waitUntil hook・顧客対話 2 経路のみ):
 *   - routes/sub-link.ts redeem 新規成功 (= App Proxy + magic-link 両経路、alreadyLinked=false のみ)
 *   - routes/liff-account-link.ts verify-code 成功 (= email OTP)
 *   cron 逆引き (friend-customer-linker) と admin DMM import は対象外
 *   (= 顧客の能動的アクションへの報酬という設計意図)。
 *
 * 設計 (referral-coupon-issuer.ts の同型 4 本目):
 *   - discountCodeBasicCreate (固定額 ¥300、usageLimit=1、appliesOncePerCustomer=true = 単回)。
 *   - combinesWith product+order 両 true (= ランク割引 NLR- と併用可、Plus 不要のクロスクラス)。
 *     ⚠️ 「重複して使用可能」(2026-08-11 Katsu) の実装はこの combinesWith が担う
 *     (= 他の割引と**併用**できる)。同じコードを**複数回**使えるようにする指示ではないため、
 *     usageLimit=1 / appliesOncePerCustomer=true は据置 (1 人生涯 1 枚の冪等設計と対)。
 *   - **冪等キーは friend_id と shopify_customer_id の両方** (それぞれ UNIQUE):
 *     同一 friend の再連携・経路重複・並行は UNIQUE(friend_id)、「サポート手動解除 →
 *     別 LINE アカウントで再連携」(機種変更の定常運用) は UNIQUE(shopify_customer_id) で
 *     1 枚に収束 = **1 人の顧客に生涯 1 枚** (2026-08-11 採点 C1)。
 *   - 有効期限 7 日 (紹介特典と同値、B2C best practice 3-7 日)。
 *
 * ⚠️ 本番ガード: LINK_REWARD_ENABLED='true' でなければ no-op (= 承認前は本番 Shopify に書き込まない)。
 *   default off。migration 078 適用 + Katsu 承認後に env を設定して有効化。
 *
 * セキュリティ / 既知トラップ (CLAUDE.md):
 *   - access token は getShopifyAccessToken (D1 cache + Client Credentials)。
 *   - fetch は fetch.bind(globalThis) で渡す (= Illegal invocation 回避)。
 *   - 例外/token は console.error にとどめ caller には null (情報漏洩防止)。
 *
 * 関連: services/referral-coupon-issuer.ts (雛形)、migration 078。
 */

import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';

// ============================================================
// 定数
// ============================================================

// 2026-08-11 Katsu 決定: ¥500 → ¥300 (gate 開放 GO と同時。連携インセンティブとしての
// 体感は残しつつ 1 枚あたりの実費を下げる。既発行分は台帳の discount_value を正とするため
// この定数変更で遡及書換えは起きない = 過去の ¥500 券はそのまま有効)。
const DEFAULT_DISCOUNT_VALUE_JPY = 300;
// 紹介特典と同値 (B2C は希少性 + 損失回避で短期限が conversion ↑、業界 best practice 3-7 日)
const DEFAULT_VALID_DAYS = 7;
const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= 連携 HTTP 応答後の waitUntil) のため 8s
const SHOPIFY_TIMEOUT_MS = 8_000;
// ambiguous な 0/1/O/I/L を除外した base31 alphabet (= 人間が読み書きしやすい)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SUFFIX_LENGTH = 8;
const CODE_NAMESPACE = 'NLINK'; // naturism link reward (= LINE- / NREF- / NLR- と衝突回避)

export type LinkPath = 'sub_link' | 'email_otp';

// ============================================================
// types
// ============================================================

export interface LinkRewardCouponEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で本番発行を有効化。未設定/その他なら no-op (= 承認前は本番未書込)。 */
  LINK_REWARD_ENABLED?: string;
}

export interface IssueLinkRewardCouponOptions {
  friendId: string;
  /** 連携先 Shopify customer id (numeric)。監査・効果測定用に台帳へ記録する。 */
  shopifyCustomerId: string;
  /** どの経路で連携が成立したか (= 経路別効果測定用) */
  linkPath: LinkPath;
  lineAccountId?: string | null;
  discountValueJpy?: number;
  validDays?: number;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis)) */
  fetchImpl?: typeof fetch;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface IssuedLinkRewardCoupon {
  code: string;
  discountValue: number;
  discountCurrency: string;
  expiresAt: string | null;
  /** true if returned from DB (already issued earlier for this friend) */
  isExisting: boolean;
  shopifyDiscountCodeId: string | null;
}

interface ExistingLinkCouponRow {
  coupon_code: string;
  discount_value: number;
  discount_currency: string;
  expires_at: string | null;
  shopify_discount_code_id: string | null;
}

// ============================================================
// 既発行チェック (friend_id で冪等 = 1 friend 生涯 1 枚)
// ============================================================

export async function findLinkRewardCoupon(
  db: D1Database,
  friendId: string,
): Promise<ExistingLinkCouponRow | null> {
  const row = await db
    .prepare(
      `SELECT coupon_code, discount_value, discount_currency, expires_at, shopify_discount_code_id
         FROM line_link_coupons
        WHERE friend_id = ?
        LIMIT 1`,
    )
    .bind(friendId)
    .first<ExistingLinkCouponRow>();
  return row ?? null;
}

/**
 * 顧客単位の既発行チェック (= 機種変更などで friend が変わっても 2 枚目を出さない)。
 * サポートが旧 friend の連携を手動解除 → 同じ顧客が新 LINE で再連携、のサイクルは
 * friend_id だけでは検知できない (2026-08-11 採点 C1)。
 */
export async function findLinkRewardCouponByCustomer(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<ExistingLinkCouponRow | null> {
  const row = await db
    .prepare(
      `SELECT coupon_code, discount_value, discount_currency, expires_at, shopify_discount_code_id
         FROM line_link_coupons
        WHERE shopify_customer_id = ?
        LIMIT 1`,
    )
    .bind(shopifyCustomerId)
    .first<ExistingLinkCouponRow>();
  return row ?? null;
}

function toIssued(row: ExistingLinkCouponRow): IssuedLinkRewardCoupon {
  return {
    code: row.coupon_code,
    discountValue: row.discount_value,
    discountCurrency: row.discount_currency,
    expiresAt: row.expires_at,
    isExisting: true,
    shopifyDiscountCodeId: row.shopify_discount_code_id,
  };
}

// ============================================================
// コード生成
// ============================================================

function generateLinkRewardCode(): string {
  const bytes = new Uint8Array(CODE_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${CODE_NAMESPACE}-${suffix}`;
}

// ============================================================
// Shopify GraphQL discountCodeBasicCreate (= 固定額 + combinesWith)
// ============================================================

interface ShopifyLinkDiscountResponse {
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

type ShopifyLinkCreateResult =
  | { ok: true; discountCodeId: string; actualCode: string }
  | { ok: false; error: string };

async function callLinkDiscountCreate(
  storeDomain: string,
  accessToken: string,
  code: string,
  discountAmount: number,
  startsAt: string,
  endsAt: string,
  fetchImpl: typeof fetch,
): Promise<ShopifyLinkCreateResult> {
  const mutation = `
    mutation linkRewardDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
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
      title: `naturism LINE連携特典 ${discountAmount} OFF`,
      code,
      startsAt,
      endsAt,
      customerSelection: { all: true },
      customerGets: {
        value: { discountAmount: { amount: discountAmount, appliesOnEachItem: false } },
        items: { all: true },
      },
      // ランク割引 (order-class) と併用可にする (= クロスクラス、Plus 不要)。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      appliesOncePerCustomer: true, // 単回
      usageLimit: 1, // 単回
      tags: ['link-reward'],
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

  let body: ShopifyLinkDiscountResponse;
  try {
    body = (await res.json()) as ShopifyLinkDiscountResponse;
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
// main: issueLinkRewardCoupon
// ============================================================

export async function issueLinkRewardCoupon(
  db: D1Database,
  env: LinkRewardCouponEnv,
  options: IssueLinkRewardCouponOptions,
): Promise<IssuedLinkRewardCoupon | null> {
  const { friendId, shopifyCustomerId, linkPath } = options;
  const lineAccountId = options.lineAccountId ?? null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 1. 本番ガード: 承認前は no-op (= 本番 Shopify に書き込まない)
  if (env.LINK_REWARD_ENABLED !== 'true') {
    console.info('[link-reward-issuer] gated off (LINK_REWARD_ENABLED!=true) friend=', friendId);
    return null;
  }

  // 2. 既発行確認 (friend_id で冪等 = 同一 friend の再連携・経路重複でも増えない)
  const existing = await findLinkRewardCoupon(db, friendId);
  if (existing) {
    return toIssued(existing);
  }

  // 2b. 顧客単位の既発行確認 (= 1 人の顧客に生涯 1 枚)。サポートが連携を手動解除して
  //     同じ顧客が別 LINE アカウントで再連携するサイクル (機種変更の定常運用) では
  //     friend_id が変わるため 2 の チェックを素通りする — ここで抑止する (採点 C1)。
  //     表示は friend 単位 (getActiveLinkRewardCoupon) なので既存 code は返さず null。
  const existingForCustomer = await findLinkRewardCouponByCustomer(db, shopifyCustomerId);
  if (existingForCustomer) {
    await auditSystem(db, {
      action: 'link_reward.duplicate_customer_suppressed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'success',
      metadata: { shopifyCustomerId, linkPath },
    });
    return null;
  }

  // 3. Shopify config 確認
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.error('[link-reward-issuer] Shopify credentials not configured');
    await auditSystem(db, {
      action: 'link_reward.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: 'Shopify credentials not configured',
      metadata: { stage: 'config_check', linkPath },
    });
    return null;
  }

  // 4. access token
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[link-reward-issuer] access token unavailable:', errMsg);
    await auditSystem(db, {
      action: 'link_reward.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token', linkPath },
    });
    return null;
  }

  // 5. 生成 + Shopify 発行
  const discountValue = options.discountValueJpy ?? DEFAULT_DISCOUNT_VALUE_JPY;
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  const now = nowFn();
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + validDays * 86_400_000).toISOString();
  const code = generateLinkRewardCode();

  const result = await callLinkDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    code,
    discountValue,
    startsAt,
    endsAt,
    fetchImpl,
  );
  if (!result.ok) {
    console.error('[link-reward-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'link_reward.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', linkPath, apiVersion: SHOPIFY_API_VERSION },
    });
    return null;
  }

  // 6. DB 記録 (friend_id UNIQUE — 並行呼び出しの重複は INSERT 失敗、そのときは既発行を再取得)
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO line_link_coupons (
           id, friend_id, shopify_customer_id, link_path, coupon_code, shopify_discount_code_id,
           discount_value, discount_currency, issued_at, expires_at, status, line_account_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
      )
      .bind(
        id,
        friendId,
        shopifyCustomerId,
        linkPath,
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
    // UNIQUE 違反 (friend_id = 同 friend の並行発行 / shopify_customer_id = 同顧客の
    // 別 friend からの並行発行) → どちらのキーでも re-fetch して既存に収束させる
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      '[link-reward-issuer] INSERT failed (likely UNIQUE conflict), re-fetching existing:',
      errMsg,
    );
    const refetch =
      (await findLinkRewardCoupon(db, friendId)) ??
      (await findLinkRewardCouponByCustomer(db, shopifyCustomerId));
    if (refetch) {
      return toIssued(refetch);
    }
    // Shopify には発行されたが DB 未記録 (orphan)。caller は null。
    await auditSystem(db, {
      action: 'link_reward.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', linkPath, shopifyDiscountCodeId: result.discountCodeId },
    });
    return null;
  }

  await auditSystem(db, {
    action: 'link_reward.issued',
    actorType: 'system',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      code: result.actualCode,
      shopifyDiscountCodeId: result.discountCodeId,
      linkPath,
      discountValue,
      validDays,
      shopifyCustomerId,
    },
  });

  return {
    code: result.actualCode,
    discountValue,
    discountCurrency: 'JPY',
    expiresAt: endsAt,
    isExisting: false,
    shopifyDiscountCodeId: result.discountCodeId,
  };
}

// ============================================================
// DB-only lookup (表示用: friend の active な連携特典クーポン)
// ============================================================

export interface ActiveLinkRewardCoupon {
  code: string;
  discountValue: number;
  expiresAt: string | null;
}

/**
 * friend の「まだ使える」連携特典クーポンを返す (表示用、env/Shopify API 不要)。
 * 1 friend 1 枚設計なので単一 or null。status='issued' かつ未失効。
 * fail-safe: エラー時は null (= テーブル未存在の pre-migration でも安全)。
 */
export async function getActiveLinkRewardCoupon(
  db: D1Database,
  friendId: string,
  nowIso?: string,
): Promise<ActiveLinkRewardCoupon | null> {
  const iso = nowIso ?? new Date().toISOString();
  try {
    const row = await db
      .prepare(
        `SELECT coupon_code, discount_value, expires_at
           FROM line_link_coupons
          WHERE friend_id = ?
            AND status = 'issued'
            AND (expires_at IS NULL OR expires_at >= ?)
          LIMIT 1`,
      )
      .bind(friendId, iso)
      .first<{ coupon_code: string; discount_value: number; expires_at: string | null }>();
    if (!row) return null;
    return {
      code: row.coupon_code,
      discountValue: row.discount_value,
      expiresAt: row.expires_at,
    };
  } catch (err) {
    console.error(
      '[link-reward-issuer] getActiveLinkRewardCoupon failed (fail-safe null):',
      err instanceof Error ? err.name : 'unknown',
    );
    return null;
  }
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  generateLinkRewardCode,
  callLinkDiscountCreate,
  DEFAULT_DISCOUNT_VALUE_JPY,
  DEFAULT_VALID_DAYS,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
  CODE_NAMESPACE,
};
