/**
 * Rank Discount Issuer Service (= 自社内製ロイヤリティ PR5-5a, 2026-06-04)
 *
 * 役割: 会員ランクに応じた常時%OFF 割引を、 顧客別 Shopify コード (NLR-{rank}-{suffix}) で発行する。
 *   3タップ単発購入 (cart permalink ?discount={code}) で利用。
 *
 * 設計 (A2 クロスクラス前提):
 *   - discountCodeBasicCreate (percentage, items.all, customerSelection.all)。
 *   - combinesWith product+order 両 true (= 将来のサブスク併用 13% スタッキングに備える)。
 *   - 再利用可 (usageLimit=null, appliesOncePerCustomer=false)。 cb-admin 感謝クーポンとは別 namespace。
 *   - friend ごとに active は1つ。 ランク変更時は旧を superseded 化 + 新規 issue。
 *   - GraphQL は Shopify dev MCP validate_graphql_codeblocks で検証済 (write_discounts scope)。
 *
 * ⚠️ 本番ガード: RANK_DISCOUNT_ENABLED='true' でなければ no-op (= 承認前は本番 Shopify に書き込まない)。
 *   default off。 Katsu 承認後に env を設定して有効化 (= 5c)。
 *
 * セキュリティ / 既知トラップ:
 *   - access token は getShopifyAccessToken (D1 cache + Client Credentials)。
 *   - fetch は fetch.bind(globalThis) で渡す (= Illegal invocation 回避、 CLAUDE.md ルール)。
 *   - 例外/token は console.error にとどめ caller には null (情報漏洩防止)。
 *
 * 関連: services/shopify-coupon-issuer.ts (= 同パターンの welcome クーポン)、 migration 062。
 */

import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';
import {
  getActiveRankDiscount,
  insertRankDiscount,
  supersedeActiveRankDiscounts,
} from '@line-crm/db';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= admin/cron trigger) のため coupon-issuer の 3s より長め
const SHOPIFY_TIMEOUT_MS = 8_000;
// ambiguous な 0/1/O/I/L を除外した base31 alphabet (= 人間が読み書きしやすい)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_SUFFIX_LENGTH = 8;
// 月次再判定 + buffer。 superseded した旧コードも自動失効させる
const DEFAULT_VALID_DAYS = 45;
const CODE_NAMESPACE = 'NLR'; // naturism loyalty rank (= cb-admin 感謝クーポンと衝突回避)

// ============================================================
// types
// ============================================================

export interface RankDiscountEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で本番発行を有効化。 未設定/その他なら no-op (= 承認前は本番未書込)。 */
  RANK_DISCOUNT_ENABLED?: string;
}

export interface IssueRankDiscountOptions {
  friendId: string;
  rankId: string;
  /** 2/4/6/8 (= rank の discountPercent)。 0 以下なら発行しない。 */
  discountPercent: number;
  lineAccountId?: string | null;
  brandId?: string | null;
  validDays?: number;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis)) */
  fetchImpl?: typeof fetch;
  /** test 用 clock 注入 */
  now?: () => number;
}

export interface IssuedRankDiscount {
  code: string;
  discountPercent: number;
  rankId: string;
  expiresAt: string | null;
  /** true if returned from DB (already issued for this rank) */
  isExisting: boolean;
  shopifyDiscountNodeId: string | null;
}

// ============================================================
// コード生成 (rank label + random suffix)
// ============================================================

/** rank id を code 用ラベルに正規化 (英数大文字のみ)。 */
function rankLabel(rankId: string): string {
  return String(rankId)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function generateRankCode(rankId: string): string {
  const bytes = new Uint8Array(CODE_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) {
    suffix += CODE_CHARS[b % CODE_CHARS.length];
  }
  return `${CODE_NAMESPACE}-${rankLabel(rankId)}-${suffix}`;
}

// ============================================================
// Shopify GraphQL discountCodeBasicCreate (= validate 済 mutation)
// ============================================================

interface ShopifyRankDiscountResponse {
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

type ShopifyRankCreateResult =
  | { ok: true; discountNodeId: string; actualCode: string }
  | { ok: false; error: string };

async function callRankDiscountCreate(
  storeDomain: string,
  accessToken: string,
  code: string,
  discountPercent: number,
  rankId: string,
  startsAt: string,
  endsAt: string,
  fetchImpl: typeof fetch,
): Promise<ShopifyRankCreateResult> {
  const mutation = `
    mutation rankDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
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
      title: `naturism ランク特典 ${discountPercent}% (${rankId})`,
      code,
      startsAt,
      endsAt,
      // PR3 (friend↔customer link) 完成後に context + 特定顧客へ絞る。 現状は friend 別シークレットコードで配布。
      customerSelection: { all: true },
      customerGets: {
        // percentage は 0.00-1.00 の小数 (= Shopify schema)。 4% → 0.04
        value: { percentage: discountPercent / 100 },
        items: { all: true },
      },
      // A2: order/product 両クラスと併用許可 (= 将来サブスク併用 13%)。 same-line product 重ねは Plus 必要だが
      //     cross-class (rank=order × sub=product) なら Plus 不要。
      combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: false },
      appliesOncePerCustomer: false, // ランク割引は再利用可
      usageLimit: null, // 無制限 (= 常時割引)
      tags: ['loyalty', `rank-${rankId}`],
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

  let body: ShopifyRankDiscountResponse;
  try {
    body = (await res.json()) as ShopifyRankDiscountResponse;
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
  const discountNodeId = result.codeDiscountNode?.id;
  const actualCode = result.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code;
  if (!discountNodeId || !actualCode) {
    return { ok: false, error: 'incomplete response (no id or code)' };
  }
  return { ok: true, discountNodeId, actualCode };
}

// ============================================================
// main: issueRankDiscountForFriend
// ============================================================

export async function issueRankDiscountForFriend(
  db: D1Database,
  env: RankDiscountEnv,
  options: IssueRankDiscountOptions,
): Promise<IssuedRankDiscount | null> {
  const { friendId, rankId } = options;
  const discountPercent = options.discountPercent;
  const lineAccountId = options.lineAccountId ?? null;
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const nowFn = options.now ?? Date.now;

  // 0. regular (= 0%) / 不正値 は割引コード不要 (= Number.isFinite で NaN も明示除外)
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return null;
  }

  // 1. 本番ガード: 承認前は no-op (= 本番 Shopify に書き込まない)
  if (env.RANK_DISCOUNT_ENABLED !== 'true') {
    console.info('[rank-discount-issuer] gated off (RANK_DISCOUNT_ENABLED!=true) friend=', friendId);
    return null;
  }

  // 2. 既存 active 確認 (冪等 = 同 rank/percent なら再利用)
  const existing = await getActiveRankDiscount(db, friendId);
  if (existing && existing.rankId === rankId && existing.discountPercent === discountPercent) {
    return {
      code: existing.code,
      discountPercent: existing.discountPercent,
      rankId: existing.rankId,
      expiresAt: existing.expiresAt,
      isExisting: true,
      shopifyDiscountNodeId: existing.shopifyDiscountNodeId,
    };
  }

  // 3. Shopify config
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    console.error('[rank-discount-issuer] Shopify credentials not configured');
    return null;
  }

  // 4. access token
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[rank-discount-issuer] access token unavailable:', errMsg);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token', rankId },
    });
    return null;
  }

  // 5. 生成 + Shopify 発行
  const now = nowFn();
  const validDays = options.validDays ?? DEFAULT_VALID_DAYS;
  const startsAt = new Date(now).toISOString();
  const endsAt = new Date(now + validDays * 86_400_000).toISOString();
  const code = generateRankCode(rankId);

  const result = await callRankDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    code,
    discountPercent,
    rankId,
    startsAt,
    endsAt,
    fetchImpl,
  );
  if (!result.ok) {
    console.error('[rank-discount-issuer] discountCodeBasicCreate failed:', result.error);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: result.error,
      metadata: { stage: 'discount_create', rankId, apiVersion: SHOPIFY_API_VERSION },
    });
    return null;
  }

  // 6. 新規 insert を先行 (= 失敗時は旧 active を温存し no-active 窓を作らない)。 成功後に旧 active を supersede。
  const isoNow = new Date(now).toISOString();
  const id = crypto.randomUUID();
  try {
    await insertRankDiscount(db, {
      id,
      friendId,
      rankId,
      code: result.actualCode,
      shopifyDiscountNodeId: result.discountNodeId,
      discountPercent,
      issuedAt: isoNow,
      expiresAt: endsAt,
      brandId: options.brandId ?? null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // insert 失敗 → 旧 active は無傷 (= 安全な失敗、 no-active 窓なし)。 Shopify には orphan が残る (将来 cron 補正余地)。
    console.error('[rank-discount-issuer] insert failed:', errMsg);
    await auditSystem(db, {
      action: 'loyalty_rank_discount.issue_failed',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'db_insert', rankId, shopifyDiscountNodeId: result.discountNodeId },
    });
    return null;
  }
  // insert 成功後に旧 active を supersede (= 新 id は除外し新行を消さない)。
  // best-effort: 失敗しても reads は issued_at DESC で新を返すため安全 (旧が残存するだけ)。
  if (existing) {
    try {
      await supersedeActiveRankDiscounts(db, friendId, isoNow, id);
    } catch (err) {
      console.error(
        '[rank-discount-issuer] supersede failed (旧 active 残存するが reads は新を返す):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  await auditSystem(db, {
    action: 'loyalty_rank_discount.issued',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: {
      code: result.actualCode,
      shopifyDiscountNodeId: result.discountNodeId,
      rankId,
      discountPercent,
      validDays,
    },
  });

  return {
    code: result.actualCode,
    discountPercent,
    rankId,
    expiresAt: endsAt,
    isExisting: false,
    shopifyDiscountNodeId: result.discountNodeId,
  };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  generateRankCode,
  rankLabel,
  callRankDiscountCreate,
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  DEFAULT_VALID_DAYS,
  CODE_CHARS,
  CODE_SUFFIX_LENGTH,
  CODE_NAMESPACE,
};
