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
 * scope (2026-08-26 更新): `read_all_orders` は 2026-07-03 に本番付与済み (shopify_tokens.scope 実測) →
 *   trailing-12mo 窓の注文は全件取得できる。scope が失われた場合は Shopify 側が直近 60 日へ縮小するが、
 *   その場合も取得できた分のみ backfill する (= graceful、under-count は安全方向)。
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
import { getShopifyAccessToken } from './shopify-token.js';

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

  // 完了 audit (= best-effort、 PII なし)。
  // 🚨 capped (= ページ上限到達で一部未取得) は success にしない (Codex P2 2026-08-26):
  // sweep / admin op の pending 述語は success audit を「完遂」とみなして対象から外すため、
  // capped を success で記録すると「不完全なのに完遂扱い」の嘘になる。
  // ⚠️ ただし retry は cursor を先頭から辿り直すため、**ページ上限そのものを超える顧客**
  // (sweep 既定 6 ページ = 12 ヶ月に 300+ 注文。naturism の生涯最大 59 注文の 5 倍) は
  // retry でも回収できず、SWEEP_FAILURE_CAP 到達後に capped:true の failure audit 5 行を
  // 残して停止する — これは設計上の受容限界 (Codex 追撃 P2 を認識のうえ、cursor 永続化は
  // この規模には作らない。仮に到達しても D1 予算 ~50/run が先に律速する)。
  // retry が実際に回収するのは**subrequest 予算切れの部分反映** (= 現実に起きる方) で、
  // そちらは適用済み注文が duplicate-skip (~1 D1) になるため run を重ねると前進して収束する。
  await auditSystem(db, {
    action: 'loyalty_purchase_backfill.completed',
    targetType: 'friend',
    targetId: options.friendId,
    result: errors > 0 || capped ? 'failure' : 'success',
    metadata: { shopifyCustomerId: customerId, scanned, backfilled, alreadyApplied, errors, totalJpy, capped },
  });

  return { skipped: false, scanned, backfilled, alreadyApplied, errors, totalJpy, capped };
}

// ============================================================
// sweep: 未完了 backfill の自己収束 cron (2026-08-26 採点ループ HIGH の恒久対策)
// ============================================================

/**
 * 「連携済みだが backfill が完遂していない friend」を 5 分毎に 1 人ずつ処理する sweep。
 *
 * なぜ要るか (採点ループ HIGH):
 *   redeem / OTP verify のインライン backfill は同一 invocation の subrequest 予算
 *   (無料プラン 50、D1 も 1 query = 1 subrequest) を認証・redeem 本体・クーポン発行と
 *   分け合う。支配項はページ取得でなく **注文ごとの addPurchaseEvent (~5 D1/新規適用)** で、
 *   直近 12 ヶ月に 7 注文以上ある顧客 (= 定期便顧客はほぼ全員) では途中で予算が尽き、
 *   「これまでのお買い物が反映」の約束に反する部分反映のまま残る。
 *
 * 収束の仕組み:
 *   - 対象 = 連携済み ∧ 成功 audit (loyalty_purchase_backfill.completed/success) 無し
 *     ∧ 失敗 audit < SWEEP_FAILURE_CAP。1 run 1 friend (= 専用 invocation の予算をフルに使う)。
 *   - backfill は冪等 (shopify_order_id UNIQUE + CAS)。途中死しても適用済み分は残り、
 *     次の run では適用済み注文が ~1 D1 の duplicate skip になるため、run を重ねるたびに
 *     前進して収束する。完遂すると成功 audit が付き対象から外れる。
 *   - 予算切れは addPurchaseEvent 単位の catch で errors に計上され、その run の完了 audit
 *     自体が書けなくても pending に残る = 取りこぼさない。
 *   - 恒常エラーの friend (例: Shopify 側の顧客消滅) は失敗 audit が CAP に達した時点で
 *     retry を止める (= 5 分毎の無限 retry を作らない)。audit_logs に痕跡が残る。
 *
 * 保証の範囲 (= 嘘をつかないための明記):
 *   収束が保証されるのは「subrequest 予算切れで途中死した部分反映」(= 現実に起きる方)。
 *   **ページ上限 (既定 6 = 12 ヶ月に 300+ 注文) を超える顧客**は retry が cursor を先頭から
 *   辿り直すため回収できず、capped:true の failure audit を CAP 件残して停止する。
 *   naturism の生涯最大 59 注文の 5 倍なので設計上の受容限界とする (Codex 追撃 P2 認識済み。
 *   cursor 永続化はこの規模には作らない — 仮に到達しても D1 予算が先に律速する)。
 */
const SWEEP_FAILURE_CAP = 5;

export interface BackfillSweepEnv extends BackfillEnv {
  DB: D1Database;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
}

export interface BackfillSweepResult {
  readonly skippedGating: boolean;
  /** sweep 対象として残っている friend 数 (処理前) */
  readonly pending: number;
  /** この run で処理した friend 数 (0 or 1) */
  readonly processed: number;
  readonly friendId: string | null;
  readonly backfilled: number;
  readonly alreadyApplied: number;
  readonly errors: number;
}

const SWEEP_PENDING_PREDICATE = `
  FROM friends f
 WHERE f.shopify_customer_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM audit_logs a
      WHERE a.action = 'loyalty_purchase_backfill.completed'
        AND a.target_type = 'friend' AND a.target_id = f.id AND a.result = 'success'
   )
   AND (
     SELECT COUNT(*) FROM audit_logs a2
      WHERE a2.action = 'loyalty_purchase_backfill.completed'
        AND a2.target_type = 'friend' AND a2.target_id = f.id AND a2.result = 'failure'
   ) < ${SWEEP_FAILURE_CAP}`;

export async function processMemberBackfillSweep(
  env: BackfillSweepEnv,
  deps: {
    /** test 用注入 (default: getShopifyAccessToken)。 */
    getTokenImpl?: (db: D1Database, env: Record<string, string | undefined>) => Promise<string>;
    /** test 用注入 (default: backfillCustomerOrders)。 */
    backfillImpl?: typeof backfillCustomerOrders;
  } = {},
): Promise<BackfillSweepResult> {
  const empty = (skippedGating: boolean, pending = 0): BackfillSweepResult => ({
    skippedGating, pending, processed: 0, friendId: null, backfilled: 0, alreadyApplied: 0, errors: 0,
  });
  if (env.MEMBER_BACKFILL_ENABLED !== 'true') return empty(true);

  const db = env.DB;
  const pendingRow = await db
    .prepare(`SELECT COUNT(*) AS n ${SWEEP_PENDING_PREDICATE}`)
    .first<{ n: number }>();
  const pending = pendingRow?.n ?? 0;
  if (pending === 0) return empty(false, 0);

  const target = await db
    .prepare(`SELECT f.id, f.shopify_customer_id ${SWEEP_PENDING_PREDICATE} ORDER BY f.updated_at DESC LIMIT 1`)
    .first<{ id: string; shopify_customer_id: string }>();
  if (!target) return empty(false, pending);

  let accessToken: string;
  try {
    // static import (= CLAUDE.md テストルール: vi.mock 対象 module 内の dynamic import は禁止)
    const getToken = deps.getTokenImpl ?? getShopifyAccessToken;
    accessToken = await getToken(db, env as unknown as Record<string, string | undefined>);
  } catch (err) {
    console.error('[member-backfill-sweep] shopify token unavailable:', err instanceof Error ? err.message : 'unknown');
    return { ...empty(false, pending), errors: 1 };
  }

  const backfill = deps.backfillImpl ?? backfillCustomerOrders;
  const r = await backfill(
    db,
    { SHOPIFY_STORE_DOMAIN: env.SHOPIFY_STORE_DOMAIN, MEMBER_BACKFILL_ENABLED: env.MEMBER_BACKFILL_ENABLED },
    { customerId: String(target.shopify_customer_id), friendId: target.id, accessToken },
  );
  return {
    skippedGating: false,
    pending,
    processed: 1,
    friendId: target.id,
    backfilled: r.backfilled,
    alreadyApplied: r.alreadyApplied,
    errors: r.errors,
  };
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
  SWEEP_FAILURE_CAP,
  SWEEP_PENDING_PREDICATE,
};
