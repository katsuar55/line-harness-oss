/**
 * Member Purchase Backfill Service (= 自社内製ロイヤリティ PR3-B, 2026-06-05)
 *
 * 役割:
 *   friend↔Shopify customer link 成立後、 その customer の過去 paid 注文を Shopify Admin GraphQL で取得し、
 *   member_purchase_events へ idempotent に backfill する (= occurred_at に実注文日を記録)。
 *   これにより trailing-12mo rank が「リンク前の購入履歴」 も反映する
 *   (= 本番 member_purchase_events=0 のため今まで全員 regular ¥0 だった状態を解消)。
 *
 * 設計:
 *   - orders(query: "customer_id:{id} AND financial_status:paid AND created_at:>={12mo前}") で
 *     createdAt + totalPriceSet.shopMoney.amount を取得 (= Shopify dev MCP validate 済、 scope read_orders)。
 *   - order gid (gid://shopify/Order/123) → 数値 id に正規化。 webhook の shopify_order_id (= String(order.id))
 *     と一致させ、 member_purchase_events.shopify_order_id UNIQUE による idempotency で **二重計上を防ぐ**
 *     (= backfill を gid、 webhook を数値で記録すると同一注文が 2 行になり rank 膨張するため)。
 *   - JPY zero-decimal: amount は Number() のみ (= × 100 しない。 shopMoney は shop 通貨 = JPY)。
 *     currencyCode !== 'JPY' は skip (= amount_jpy 整数前提の防御)。
 *   - addPurchaseEvent(source='backfill', occurredAt=createdAt) で記録 + members 加算
 *     (= atomic ON CONFLICT / CAS claim は addPurchaseEvent 側で担保済)。
 *   - pagination: pageInfo.hasNextPage を辿る。 MAX_PAGES で cap (= 暴走防止)。 cap 到達は log (= silent 切捨て禁止)。
 *
 * ⚠️ 本番ガード (= money path 承認ゲート): MEMBER_BACKFILL_ENABLED='true' でなければ no-op。
 *   linking (= FRIEND_LINK_ENABLED) とは **別 gate**。 Katsu が link を検証後に backfill を別途有効化する
 *   (= 非 money の linking と money の backfill を分離。 PR5 RANK_DISCOUNT_ENABLED と同方式)。
 *
 * ⚠️ scope 制約 (= 2026-06-05 本番 token 確認): read_all_orders 未付与 → orders は **直近60日のみ閲覧可**。
 *   60日より前の注文は取得できず under-count (= 安全方向の不完全さ)。 完全な trailing-12mo backfill には
 *   read_all_orders scope の追加 (= Shopify アプリ再認証) が必要。 取得できた分のみ backfill する (= graceful)。
 *
 * セキュリティ / 既知トラップ:
 *   - accessToken は呼び出し側 (= linker cron) が 1 回取得して渡す (= per-friend の token 再取得を避ける)。
 *   - fetch は fetch.bind(globalThis) (= Illegal invocation 回避、 CLAUDE.md ルール)。
 *   - customerId は query 注入防止に数値のみ allowlist (= normalizeShopifyCustomerId 出力前提)。
 *
 * 関連:
 *   - apps/worker/src/services/friend-customer-linker.ts (= 呼び出し元、 同 GraphQL/gating pattern)
 *   - apps/worker/src/services/rank-discount-issuer.ts (= 同 Shopify GraphQL service pattern)
 *   - packages/db/src/membership.ts addPurchaseEvent (= occurred_at 対応済 / idempotent)
 *   - packages/db/src/loyalty-rank.ts computeTrailing12moJpyForFriend (= COALESCE(occurred_at, created_at))
 */
import { addPurchaseEvent, isoMonthsAgo, jstNow } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= cron) のため余裕を持たせる
const SHOPIFY_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 50;
// 50 × 6 = 300 注文/customer の上限 (= 暴走防止)。 naturism 最大 59 注文/客なので実質十分。
const MAX_PAGES = 6;
// trailing-12mo rank window と一致 (= これより古い注文は窓を二度と通らないので fetch 不要)。
const BACKFILL_LOOKBACK_MONTHS = 12;
// Shopify customer id は数値 (= REST/orders 形式)。 query 注入防止の allowlist。
const SAFE_CUSTOMER_ID = /^\d+$/;

// ============================================================
// types
// ============================================================

export interface BackfillEnv {
  SHOPIFY_STORE_DOMAIN?: string;
  /**
   * 'true' で過去注文 backfill (= 本番 member_purchase_events への書込) を有効化。
   * 未設定/その他なら no-op (= money path 承認ゲート、 linking の FRIEND_LINK_ENABLED とは別)。
   */
  MEMBER_BACKFILL_ENABLED?: string;
}

export interface BackfillOptions {
  /** 数値正規化済 Shopify customer id (= normalizeShopifyCustomerId 出力)。 */
  customerId: string;
  friendId: string;
  /** linker が 1 回取得済の access token を渡す。 */
  accessToken: string;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis))。 */
  fetchImpl?: typeof fetch;
  /** test 用 window 基準 (default: jstNow)。 */
  asOfIso?: string;
  /** pagination 上限 (default MAX_PAGES)。 */
  maxPages?: number;
}

export interface BackfillResult {
  readonly skipped: boolean;
  readonly reason?: string;
  /** 取得して処理した paid/JPY 注文数 (= window 内)。 */
  readonly scanned: number;
  /** 新規に member へ加算された件数。 */
  readonly backfilled: number;
  /** 既に適用済で冪等 skip した件数。 */
  readonly alreadyApplied: number;
  /** 個別注文の処理失敗 + ページ取得失敗の件数。 */
  readonly errors: number;
  /** backfilled の合計金額 (JPY)。 */
  readonly totalJpy: number;
  /** pagination cap に達した (= 一部未取得の可能性)。 */
  readonly capped: boolean;
}

// ============================================================
// id 正規化 (= webhook の shopify_order_id = String(order.id) と一致させ idempotency 担保)
// ============================================================

/** gid://shopify/Order/123 → "123"。 数値文字列はそのまま。 それ以外 null。 */
export function normalizeShopifyOrderId(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/Order\/(\d+)/i);
  return m ? m[1] : null;
}

// ============================================================
// Shopify GraphQL: orders by customer (= validate 済 query)
// ============================================================

interface OrdersPageResponse {
  data?: {
    orders?: {
      edges?: Array<{
        cursor?: string;
        node?: {
          id?: string;
          createdAt?: string | null;
          displayFinancialStatus?: string | null;
          totalPriceSet?: {
            shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
          } | null;
        };
      }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

const ORDERS_QUERY = `
  query backfillCustomerOrders($q: String!, $cursor: String) {
    orders(first: ${PAGE_SIZE}, query: $q, after: $cursor) {
      edges {
        cursor
        node {
          id
          createdAt
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * orders の 1 ページを取得。 HTTP !ok / GraphQL errors は throw (= caller が errors 計上 + 打ち切り)。
 */
async function fetchOrdersPage(
  storeDomain: string,
  accessToken: string,
  q: string,
  cursor: string | null,
  fetchImpl: typeof fetch,
): Promise<OrdersPageResponse> {
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
      body: JSON.stringify({ query: ORDERS_QUERY, variables: { q, cursor } }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`Shopify orders query failed: HTTP ${res.status}`);
  const body = (await res.json()) as OrdersPageResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify orders query errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body;
}

// ============================================================
// main: backfillCustomerOrders
// ============================================================

function empty(skipped: boolean, reason?: string): BackfillResult {
  return { skipped, reason, scanned: 0, backfilled: 0, alreadyApplied: 0, errors: 0, totalJpy: 0, capped: false };
}

/**
 * 1 customer の過去 paid 注文を member_purchase_events へ idempotent に backfill する。
 *
 * gating:
 *   - MEMBER_BACKFILL_ENABLED='true' でなければ no-op (= 本番未書込)
 *   - SHOPIFY_STORE_DOMAIN / accessToken / 正当な customerId が無ければ no-op
 */
export async function backfillCustomerOrders(
  db: D1Database,
  env: BackfillEnv,
  options: BackfillOptions,
): Promise<BackfillResult> {
  // 1. gate (= money path 承認ゲート、 default off)
  if (env.MEMBER_BACKFILL_ENABLED !== 'true') return empty(true, 'gated_off');
  if (!env.SHOPIFY_STORE_DOMAIN) return empty(true, 'shopify_not_configured');
  if (!options.accessToken) return empty(true, 'no_access_token');
  const customerId = options.customerId;
  if (!SAFE_CUSTOMER_ID.test(customerId)) return empty(true, 'invalid_customer_id');

  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const asOf = options.asOfIso ?? jstNow();
  // fetch 窓 = rank window と同じ 12mo 前 (= これより古い注文は窓を二度と通らないので取得不要)。
  // Shopify search は date 単位で十分なので YYYY-MM-DD に切る (= やや広めに取得 → rank 計算側が occurred_at で
  // 精密に絞る)。 occurred_at は Shopify createdAt (UTC) をそのまま保存し rank window (JST) と lexicographic
  // 比較する。 12mo ちょうど境界の注文だけ UTC/JST offset (~9h) 分の揺れがあるが、 月次再判定の trailing rank
  // では無視できる (= 既存 created_at vs since の混在比較と同じ許容範囲)。
  const windowStartDate = isoMonthsAgo(BACKFILL_LOOKBACK_MONTHS, asOf).slice(0, 10);
  const maxPages = options.maxPages ?? MAX_PAGES;
  const q = `customer_id:${customerId} AND financial_status:paid AND created_at:>=${windowStartDate}`;

  let scanned = 0;
  let backfilled = 0;
  let alreadyApplied = 0;
  let errors = 0;
  let totalJpy = 0;
  let capped = false;
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let body: OrdersPageResponse;
    try {
      body = await fetchOrdersPage(env.SHOPIFY_STORE_DOMAIN, options.accessToken, q, cursor, fetchImpl);
    } catch (err) {
      // ページ取得失敗 → 部分 backfill で打ち切り (= link は壊さない、 under-count は安全方向)
      errors += 1;
      console.error(
        '[member-purchase-backfill] orders fetch failed friend',
        options.friendId,
        ':',
        err instanceof Error ? err.message : 'unknown',
      );
      break;
    }

    const conn = body.data?.orders;
    for (const edge of conn?.edges ?? []) {
      const node = edge.node;
      if (!node) continue;
      // 防御: query で financial_status:paid 済だが displayFinancialStatus を再確認 (= 過剰 credit 防止)
      if (node.displayFinancialStatus && node.displayFinancialStatus.toUpperCase() !== 'PAID') continue;
      const orderId = normalizeShopifyOrderId(node.id);
      if (!orderId) continue;
      const money = node.totalPriceSet?.shopMoney;
      const currency = money?.currencyCode ?? 'JPY';
      if (currency !== 'JPY') {
        // naturism は JPY only。 想定外通貨は amount_jpy 整数前提を壊すため skip。
        console.warn('[member-purchase-backfill] skip non-JPY order', orderId, currency);
        continue;
      }
      // zero-decimal JPY: "2830.0" → 2830。 × 100 しない (= webhook 経路と同じ変換)。
      const amountJpy = Number(money?.amount ?? 0);
      scanned += 1;
      try {
        const r = await addPurchaseEvent(db, {
          shopifyOrderId: orderId,
          friendId: options.friendId,
          amountJpy,
          currency: 'JPY',
          source: 'backfill',
          occurredAt: node.createdAt ?? null,
          metadata: { backfill: true, matchedBy: 'customer_id', shopifyCustomerId: customerId },
        });
        // newTotalPurchaseJpy != null = 今回 member へ実加算された (= 新規 or 後追い claim)。
        // null = 既適用の冪等 skip (= duplicate / concurrent)。
        if (r.applied && r.newTotalPurchaseJpy !== null) {
          backfilled += 1;
          totalJpy += r.amountJpy;
        } else {
          alreadyApplied += 1;
        }
      } catch (err) {
        errors += 1;
        console.error(
          '[member-purchase-backfill] addPurchaseEvent failed order',
          orderId,
          ':',
          err instanceof Error ? err.message : 'unknown',
        );
      }
    }

    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
    if (page === maxPages - 1) capped = true; // 次ページが必要なのに上限到達
  }

  if (capped) {
    console.warn(
      '[member-purchase-backfill] page cap reached friend',
      options.friendId,
      'customer',
      customerId,
      `(maxPages=${maxPages}) — 一部注文が未 backfill の可能性`,
    );
  }

  // 完了 audit (= best-effort、 PII なし)
  await auditSystem(db, {
    action: 'loyalty_purchase_backfill.completed',
    targetType: 'friend',
    targetId: options.friendId,
    result: errors > 0 ? 'failure' : 'success',
    metadata: { shopifyCustomerId: customerId, scanned, backfilled, alreadyApplied, errors, totalJpy, capped },
  });

  return { skipped: false, scanned, backfilled, alreadyApplied, errors, totalJpy, capped };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  PAGE_SIZE,
  MAX_PAGES,
  BACKFILL_LOOKBACK_MONTHS,
  ORDERS_QUERY,
};
