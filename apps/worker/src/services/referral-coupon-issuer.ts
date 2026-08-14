/**
 * Referral Coupon Issuer Service (= 友だち紹介の実クーポン発行 + 順次活性化 queue, 2026-08-13 改訂)
 *
 * 役割: 紹介者 (referrer) への ¥500 OFF Shopify 実クーポンを「**同時に使えるのは常に 1 枚**」の
 *   不変条件つきで発行する (Katsu 確定 R1: 複数保有可・1 注文 1 枚・¥1,000 への合算 NG)。
 *   - referred (紹介された側) の ¥500 は welcome クーポンの格上げが担う (本 service の対象外)。
 *
 * 順次活性化 (queue) の設計:
 *   Shopify の combinesWith はクラス単位の双方向握手のみで「紹介×紹介だけ禁止」は原理的に不可能。
 *   よって **Shopify 上に生きた NREF- コードを friend につき最大 1 枚**にすることで R1 を物理的に
 *   保証する。2 枚目以降の紹介成立は line_referral_coupon_queue (migration 079) に waiting で積み、
 *   T1 (使用検知 webhook) / T2 (期限 sweep) / T3 (ポータル閲覧 pull) を契機に 1 枚ずつ活性化する。
 *   - 有効期限 60 日は**活性化時点から起算** (待機中は減らない = 顧客に不利にならない)。
 *   - 二重活性化は DB 層の単文 UPDATE claim (packages/db/src/referral-coupon-queue.ts) で防ぐ。
 *   - activating で落ちた行の再駆動は planned_code の再 create で行い、Shopify の code 重複エラーを
 *     「前回 create 成功済み」のシグナルとして codeDiscountNodeByCode で回収する (二重発行なし)。
 *
 * 設計 (welcome coupon + rank discount の合成):
 *   - discountCodeBasicCreate (固定額 ¥500、 usageLimit=1、 appliesOncePerCustomer=true = 単回)。
 *   - combinesWith product+order 両 true (= ランク割引 NLR- / 連携特典 NLINK- と併用可)。
 *
 * ⚠️ 本番ガード: REFERRAL_REWARD_ENABLED='true' でなければ no-op (= 承認前は本番 Shopify に書き込まない)。
 *
 * セキュリティ / 既知トラップ (CLAUDE.md):
 *   - access token は getShopifyAccessToken (D1 cache + Client Credentials)。
 *   - fetch は fetch.bind(globalThis) で渡す (= Illegal invocation 回避)。
 *   - 例外/token は console.error にとどめ caller には null (情報漏洩防止)。
 *
 * 関連: services/shopify-coupon-issuer.ts (welcome)、 services/rank-discount-issuer.ts (rank)、
 *       packages/db/src/referral-coupon-queue.ts (queue DB 層)、 migration 068 / 079。
 */

import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';
import {
  enqueueReferralCoupon,
  findQueueRowByRewardId,
  claimNextReferralCouponForActivation,
  markQueueRowActivated,
  revertQueueRowToWaiting,
  countWaitingReferralCoupons,
} from '@line-crm/db';

// ============================================================
// 定数
// ============================================================

const DEFAULT_DISCOUNT_VALUE_JPY = 500;
// 2026-08-13 Katsu 確定: 7 日 → 60 日。紹介は「貯めて別々の注文で使う」設計 (順次活性化) になった
// ため、B2C 短期限の希少性より「待機分も含めて確実に使い切れる」ことを優先する。
// 起点は**活性化時点** (待機中は 60 日が走らない)。
const DEFAULT_VALID_DAYS = 60;
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

/**
 * issueOrEnqueueReferralCoupon の結果。
 * - issued: この呼び出しで Shopify に発行された (= 生きた 1 枚が居なかった)
 * - existing: 既に同 reward の台帳行がある (冪等再呼び出し)
 * - queued: 生きた 1 枚が居るため queue に積んだ (waitingCount = 本人の待機枚数)
 * - failed: gate off / 前提不足 / 予期しない失敗 (reward flip すべきでない)
 */
export type IssueOrEnqueueResult =
  | { kind: 'issued'; coupon: IssuedReferralCoupon }
  | { kind: 'existing'; coupon: IssuedReferralCoupon }
  | { kind: 'queued'; waitingCount: number }
  | { kind: 'failed' };

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
  | { ok: false; error: string; codeTaken?: boolean };

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
        // 定期便チェックアウトでも使える (単発は従来どおり)。
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: true,
      },
      // 🚨 appliesOnSubscription とセットで**必須** (1 = 初回サイクルのみ)。外すと ¥500 が
      //   毎サイクル永久に引かれ、契約からは我々の app では外せない (owner=Huckleberry のみ)。
      recurringCycleLimit: 1,
      // 4 系統は全て ORDER クラス (2026-08-13 本番実測) — welcome/連携/ランクと実際に重なる。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      // 全券共通の最低購入 ¥2,000 (Katsu 確定 — 過剰値引きの唯一のガード)
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: '2000' } },
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
    const joined = result.userErrors.map((e) => `${e.code ?? 'ERR'}: ${e.message}`).join('; ');
    // stuck 再駆動 (planned_code 再 create) で「前回は成功していた」ケース。
    // Shopify の userError 文言/コードは版で揺れるため taken/duplicate/exists を広めに拾う。
    const codeTaken = /taken|duplicate|already|exists|使用され/i.test(joined);
    return { ok: false, error: joined, codeTaken };
  }
  const discountCodeId = result.codeDiscountNode?.id;
  const actualCode = result.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code;
  if (!discountCodeId || !actualCode) {
    return { ok: false, error: 'incomplete response (no id or code)' };
  }
  return { ok: true, discountCodeId, actualCode };
}

/**
 * code から既存 discount を回収する (= stuck 再駆動で create が「code 重複」を返したとき用)。
 * 見つかれば discountCodeId を返す。
 */
async function callDiscountLookupByCode(
  storeDomain: string,
  accessToken: string,
  code: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; discountCodeId: string } | { ok: false; error: string }> {
  const query = `
    query referralDiscountLookup($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        id
      }
    }
  `;
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
      body: JSON.stringify({ query, variables: { code } }),
      signal: controller.signal,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  try {
    const body = (await res.json()) as {
      data?: { codeDiscountNodeByCode?: { id?: string } | null };
      errors?: Array<{ message: string }>;
    };
    if (body.errors && body.errors.length > 0) {
      return { ok: false, error: body.errors.map((e) => e.message).join('; ') };
    }
    const id = body.data?.codeDiscountNodeByCode?.id;
    if (!id) return { ok: false, error: 'code not found' };
    return { ok: true, discountCodeId: id };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ============================================================
// core: Shopify 発行 + 台帳 INSERT (issueReferralCoupon / 活性化の共通部)
// ============================================================

interface CreateCoreOptions {
  friendId: string;
  role: ReferralRole;
  rewardId: string;
  lineAccountId: string | null;
  discountValue: number;
  validDays: number;
  /** 使用する code (queue 経路は planned_code 固定 / 直接発行は random 生成) */
  code: string;
  fetchImpl: typeof fetch;
  nowMs: number;
}

async function createAndRecordReferralCoupon(
  db: D1Database,
  env: ReferralCouponEnv,
  o: CreateCoreOptions,
): Promise<IssuedReferralCoupon | null> {
  // Shopify config 確認
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.error('[referral-coupon-issuer] Shopify credentials not configured');
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: o.friendId,
      lineAccountId: o.lineAccountId,
      result: 'failure',
      errorMessage: 'Shopify credentials not configured',
      metadata: { stage: 'config_check', role: o.role },
    });
    return null;
  }

  // access token
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
      targetId: o.friendId,
      lineAccountId: o.lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token', role: o.role },
    });
    return null;
  }

  const startsAt = new Date(o.nowMs).toISOString();
  const endsAt = new Date(o.nowMs + o.validDays * 86_400_000).toISOString();

  let discountCodeId: string;
  let actualCode: string;
  const result = await callReferralDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    o.code,
    o.discountValue,
    o.role,
    startsAt,
    endsAt,
    o.fetchImpl,
  );
  if (result.ok) {
    discountCodeId = result.discountCodeId;
    actualCode = result.actualCode;
  } else if (result.codeTaken) {
    // stuck 再駆動: 前回の create が成功していた → 既存 discount を code から回収
    const lookup = await callDiscountLookupByCode(
      env.SHOPIFY_STORE_DOMAIN,
      accessToken,
      o.code,
      o.fetchImpl,
    );
    if (!lookup.ok) {
      console.error('[referral-coupon-issuer] code taken だが lookup も失敗:', lookup.error);
      await auditSystem(db, {
        action: 'referral_coupon.issue_failed',
        actorType: 'system',
        targetType: 'friend',
        targetId: o.friendId,
        lineAccountId: o.lineAccountId,
        result: 'failure',
        errorMessage: `taken+lookup failed: ${lookup.error}`,
        metadata: { stage: 'discount_lookup', role: o.role },
      });
      return null;
    }
    discountCodeId = lookup.discountCodeId;
    actualCode = o.code;
  } else {
    console.error('[referral-coupon-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: o.friendId,
      lineAccountId: o.lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', role: o.role, apiVersion: SHOPIFY_API_VERSION },
    });
    return null;
  }

  // DB 記録 (reward_id UNIQUE — 並行呼び出しの重複は INSERT 失敗、 そのときは既発行を再取得)
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
        o.friendId,
        o.rewardId,
        o.role,
        actualCode,
        discountCodeId,
        o.discountValue,
        'JPY',
        startsAt,
        endsAt,
        o.lineAccountId,
      )
      .run();
  } catch (err) {
    // UNIQUE(reward_id) 違反 → 同 reward が並行発行された → re-fetch
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      '[referral-coupon-issuer] INSERT failed (likely UNIQUE conflict), re-fetching existing:',
      errMsg,
    );
    const refetch = await findReferralCoupon(db, o.rewardId);
    if (refetch) {
      return toIssued(refetch, o.role);
    }
    // Shopify には発行されたが DB 未記録 (orphan)。 caller は null。
    await auditSystem(db, {
      action: 'referral_coupon.issue_failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: o.friendId,
      lineAccountId: o.lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', role: o.role, shopifyDiscountCodeId: discountCodeId },
    });
    return null;
  }

  await auditSystem(db, {
    action: 'referral_coupon.issued',
    actorType: 'system',
    targetType: 'friend',
    targetId: o.friendId,
    lineAccountId: o.lineAccountId,
    result: 'success',
    metadata: {
      code: actualCode,
      shopifyDiscountCodeId: discountCodeId,
      role: o.role,
      discountValue: o.discountValue,
      validDays: o.validDays,
      rewardId: o.rewardId,
    },
  });

  return {
    code: actualCode,
    discountValue: o.discountValue,
    discountCurrency: 'JPY',
    role: o.role,
    expiresAt: endsAt,
    isExisting: false,
    shopifyDiscountCodeId: discountCodeId,
  };
}

// ============================================================
// main: issueReferralCoupon (直接発行 — queue を経由しない従来経路)
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

  return createAndRecordReferralCoupon(db, env, {
    friendId,
    role,
    rewardId,
    lineAccountId,
    discountValue: options.discountValueJpy ?? DEFAULT_DISCOUNT_VALUE_JPY,
    validDays: options.validDays ?? DEFAULT_VALID_DAYS,
    code: generateReferralCode(role),
    fetchImpl,
    nowMs: nowFn(),
  });
}

// ============================================================
// issueOrEnqueueReferralCoupon (= R1 順次活性化の入口 T0)
// ============================================================

/**
 * 紹介成立 1 件に対し「生きた 1 枚が居なければ即発行 / 居れば queue に積む」。
 * referral-reward.ts から呼ばれる。issued / queued いずれも reward flip してよい
 * (queued は T1/T2/T3 が後で活性化する = 顧客のクーポンは失われない)。
 */
export async function issueOrEnqueueReferralCoupon(
  db: D1Database,
  env: ReferralCouponEnv,
  options: IssueReferralCouponOptions,
): Promise<IssueOrEnqueueResult> {
  const { friendId, role } = options;
  const lineAccountId = options.lineAccountId ?? null;
  const rewardId = options.rewardId ?? null;
  const nowFn = options.now ?? Date.now;

  if (env.REFERRAL_REWARD_ENABLED !== 'true') {
    console.info('[referral-coupon-issuer] gated off (issueOrEnqueue) friend=', friendId);
    return { kind: 'failed' };
  }
  if (!rewardId) {
    console.error('[referral-coupon-issuer] rewardId required (issueOrEnqueue) friend=', friendId);
    return { kind: 'failed' };
  }

  // 冪等: 台帳に既にあればそれが正
  const existing = await findReferralCoupon(db, rewardId);
  if (existing) {
    return { kind: 'existing', coupon: toIssued(existing, role) };
  }

  // 冪等: queue に既にあれば積み直さない (activated なのに台帳が無い場合は上の existing で拾えないが、
  //   markQueueRowActivated は台帳 INSERT 成功後にしか呼ばれないため、この状態は通常発生しない)
  const nowMs = nowFn();
  const nowIso = new Date(nowMs).toISOString();
  const queued = await findQueueRowByRewardId(db, rewardId);
  if (!queued) {
    try {
      await enqueueReferralCoupon(db, {
        id: crypto.randomUUID(),
        friendId,
        rewardId,
        lineAccountId,
        plannedCode: generateReferralCode(role),
        discountValue: options.discountValueJpy ?? DEFAULT_DISCOUNT_VALUE_JPY,
        createdAt: nowIso,
      });
    } catch (err) {
      // queue テーブル未作成 (migration 079 未適用) 等 → 従来の直接発行に退行 (安全側:
      //   クーポンを失わせない。R1 の 1 枚保証は migration 適用後から効く)
      console.error(
        '[referral-coupon-issuer] enqueue failed, falling back to direct issue:',
        err instanceof Error ? err.name : 'unknown',
      );
      const direct = await issueReferralCoupon(db, env, options);
      return direct ? { kind: direct.isExisting ? 'existing' : 'issued', coupon: direct } : { kind: 'failed' };
    }
  }

  // 活性化を試みる (生きた 1 枚が居なければ、いま積んだ行 (最古 waiting) が活性化される)
  const activated = await activateNextQueuedReferralCoupon(db, env, {
    friendId,
    lineAccountId,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  if (activated) {
    // 活性化されたのが**この reward** なら issued として返す (別の古い waiting が先に開いた場合は queued)
    const mine = await findReferralCoupon(db, rewardId);
    if (mine) return { kind: 'issued', coupon: toIssued(mine, role) };
  }

  const waitingCount = await countWaitingReferralCoupons(db, friendId);
  return { kind: 'queued', waitingCount };
}

// ============================================================
// activateNextQueuedReferralCoupon (= T1/T2/T3 共通の活性化本体)
// ============================================================

export interface ActivateNextOptions {
  friendId: string;
  lineAccountId?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * friend の最古 waiting を 1 枚だけ活性化する (生きた 1 枚が居れば no-op)。
 * 二重活性化は DB 層の単文 UPDATE claim が防ぐ。Shopify 失敗時は waiting へ戻す (補償)。
 * @returns 活性化された coupon (LINE push は caller が行う)。活性化しなかったら null。
 */
export async function activateNextQueuedReferralCoupon(
  db: D1Database,
  env: ReferralCouponEnv,
  options: ActivateNextOptions,
): Promise<IssuedReferralCoupon | null> {
  if (env.REFERRAL_REWARD_ENABLED !== 'true') return null;

  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;
  const nowMs = nowFn();
  const nowIso = new Date(nowMs).toISOString();

  let claimed;
  try {
    claimed = await claimNextReferralCouponForActivation(db, options.friendId, nowIso);
  } catch (err) {
    // queue テーブル未作成 (migration 079 未適用) → 何もしない
    console.error(
      '[referral-coupon-issuer] claim failed (pre-migration?):',
      err instanceof Error ? err.name : 'unknown',
    );
    return null;
  }
  if (!claimed) return null;

  // 台帳に既にある reward (通常発生しないが冪等の網) → queue を activated で閉じて終わり
  const preExisting = await findReferralCoupon(db, claimed.reward_id);
  if (preExisting) {
    await markQueueRowActivated(db, claimed.id, nowIso, 'pre-existing');
    return null;
  }

  const coupon = await createAndRecordReferralCoupon(db, env, {
    friendId: claimed.friend_id,
    role: 'referrer',
    rewardId: claimed.reward_id,
    lineAccountId: claimed.line_account_id ?? options.lineAccountId ?? null,
    discountValue: claimed.discount_value,
    validDays: DEFAULT_VALID_DAYS, // 起点 = 活性化時点 (待機中は減らない)
    code: claimed.planned_code,
    fetchImpl,
    nowMs,
  });

  if (!coupon) {
    // 補償: waiting へ戻す (次の T1/T2/T3 が planned_code で再駆動 → code 重複は lookup で回収)
    await revertQueueRowToWaiting(db, claimed.id, 'shopify create/insert failed');
    return null;
  }

  // 台帳 INSERT 成功後にのみ activated (= 「activated なのに台帳なし」の窓を作らない)
  const ledgerRow = await findReferralCoupon(db, claimed.reward_id);
  await markQueueRowActivated(db, claimed.id, nowIso, ledgerRow ? claimed.reward_id : 'unknown');

  await auditSystem(db, {
    action: 'referral_coupon.activated_from_queue',
    actorType: 'system',
    targetType: 'friend',
    targetId: claimed.friend_id,
    lineAccountId: claimed.line_account_id,
    result: 'success',
    metadata: { rewardId: claimed.reward_id, code: coupon.code, queueId: claimed.id },
  });

  return coupon;
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
 * 順次活性化の定常状態では高々 1 枚 (移行期の旧複数枚は失効までの経過措置として複数返りうる)。
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
            AND redeemed_at IS NULL
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
  callDiscountLookupByCode,
  createAndRecordReferralCoupon,
  DEFAULT_DISCOUNT_VALUE_JPY,
  DEFAULT_VALID_DAYS,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
  CODE_NAMESPACE,
};
