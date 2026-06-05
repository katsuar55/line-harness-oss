/**
 * Friend ↔ Shopify Customer Linker (= 自社内製ロイヤリティ PR3, 2026-06-05)
 *
 * 役割:
 *   CRM PLUS on LINE が Shopify 顧客に保存する「LINE ID」 metafield を逆引きし、
 *   friend.line_user_id === customer.metafield(ns, key) の customer を見つけて
 *   friends.shopify_customer_id を populate する。
 *   これにより過去 paid 注文 → trailing-12mo rank 連動 (= 後続 PR3-B backfill) が可能になる。
 *
 * 設計:
 *   - Shopify Admin GraphQL `customers(query: "metafields.{ns}.{key}:\"{lineUserId}\"")` で逆引き
 *     (= Shopify dev MCP validate 済、 scope read_customers)。 取得した metafield.value を
 *     lineUserId と厳密比較して誤マッチを防止。 customer id は gid → 数値正規化 (= REST/orders と同形式)。
 *   - friend ごとに既 link なら skip (setFriendShopifyCustomerId は IS NULL 限定 UPDATE で idempotent)。
 *   - 同 customer が別 friend に既 link なら ambiguous として skip (= 事前検査 + UNIQUE 制約の二重防御)。
 *
 * ⚠️ 本番ガード: FRIEND_LINK_ENABLED='true' かつ metafield namespace/key 設定済でなければ no-op。
 *   default off = 本番未書込 (= 承認 + 実機 metafield key 確認後に有効化、 PR5 RANK_DISCOUNT_ENABLED と同方式)。
 *   有効時も JST 02:00-02:04 window のみ実行 (= Shopify 呼出を 1 日 1 回に制限、 FRIEND_LINK_CRON_FORCE で bypass)。
 *
 * セキュリティ / 既知トラップ:
 *   - access token は cron 内で getShopifyAccessToken を 1 回だけ取得し各 friend に使い回す。
 *   - fetch は fetch.bind(globalThis) (= Illegal invocation 回避、 CLAUDE.md ルール)。
 *   - lineUserId は query 注入防止に allowlist (`[A-Za-z0-9_-]+`) で検査してから query 文字列に埋め込む。
 *
 * 関連:
 *   - apps/worker/src/services/rank-discount-issuer.ts (= 同 Shopify GraphQL pattern)
 *   - apps/worker/src/services/loyalty-rank-cron.ts (= 同 gating/集計 cron pattern)
 *   - packages/db/src/friends.ts (= setFriendShopifyCustomerId / listUnlinkedFriends / getFriendByShopifyCustomerId)
 *   - 後続 PR3-B: link 成功時に過去 paid 注文を member_purchase_events へ backfill (occurred_at 補正込み)
 */
import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';
import { backfillCustomerOrders } from './member-purchase-backfill.js';
import {
  listUnlinkedFriends,
  getFriendByShopifyCustomerId,
  setFriendShopifyCustomerId,
} from '@line-crm/db';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
// reply window 外 (= cron) のため余裕を持たせる
const SHOPIFY_TIMEOUT_MS = 8_000;
const DEFAULT_BATCH_LIMIT = 25;
// LINE user id の許容文字 (= query 注入防止)。 実 LINE id は U+hex だが将来別 channel も考慮し緩めの allowlist。
const SAFE_LINE_ID = /^[A-Za-z0-9_-]+$/;
// metafield namespace/key の許容文字 (= operator config だが query 構文文字 (`.` `:` 空白等) の混入を防ぐ defense-in-depth)。
const SAFE_METAFIELD_PART = /^[A-Za-z0-9_-]+$/;

// ============================================================
// types
// ============================================================

export interface FriendLinkEnv {
  DB: D1Database;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  /** 'true' で本番リンクを有効化。 未設定/その他なら no-op (= 本番未書込)。 */
  FRIEND_LINK_ENABLED?: string;
  /** CRM PLUS「LINE ID」customer metafield の namespace (= 実機確認後に設定)。 */
  FRIEND_LINK_METAFIELD_NAMESPACE?: string;
  /** 同 metafield の key。 */
  FRIEND_LINK_METAFIELD_KEY?: string;
  /** 'true' で JST 02:00-02:04 gating window を bypass (= テスト/手動)。 */
  FRIEND_LINK_CRON_FORCE?: string;
  /**
   * 'true' で link 成立後に過去注文 backfill を実行 (= money path)。 linking (FRIEND_LINK_ENABLED) とは
   * 別 gate。 未設定なら backfill は no-op (= linking のみ実行)。 backfill 側でも判定する二重ガード。
   */
  MEMBER_BACKFILL_ENABLED?: string;
}

export interface FriendLinkResult {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly scanned: number;
  readonly linked: number;
  readonly ambiguous: number;
  readonly notFound: number;
  readonly errors: number;
  /** link 成立に伴い backfill した過去注文の合計件数 (= MEMBER_BACKFILL_ENABLED off なら常に 0)。 */
  readonly backfilled: number;
}

export interface ProcessFriendLinkOptions {
  /** test 用 clock 注入 (= window gating の決定性) */
  now?: () => number;
  /** test 用 fetch 注入 (default: fetch.bind(globalThis)) */
  fetchImpl?: typeof fetch;
  /** 1 回の scan 件数 (default 25)。 Shopify rate limit / Worker CPU 対策。 */
  limit?: number;
  /** test 用 backfill 注入 (default: backfillCustomerOrders)。 */
  backfillImpl?: typeof backfillCustomerOrders;
}

export interface FoundCustomer {
  /** 数値正規化済 customer id (= REST/orders と同形式) */
  customerId: string;
  email: string | null;
}

// ============================================================
// id 正規化
// ============================================================

/** gid://shopify/Customer/123 → "123"。 数値文字列はそのまま。 それ以外 null。 (= REST/orders 形式に統一) */
export function normalizeShopifyCustomerId(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/Customer\/(\d+)/i);
  return m ? m[1] : null;
}

// ============================================================
// Shopify GraphQL: customers by metafield (= validate 済 query)
// ============================================================

interface ShopifyCustomerSearchResponse {
  data?: {
    customers?: {
      edges?: Array<{
        node?: {
          id?: string;
          defaultEmailAddress?: { emailAddress?: string | null } | null;
          metafield?: { value?: string | null } | null;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * lineUserId に一致する Shopify customer を metafield 逆引きで探す。
 * 取得した metafield.value === lineUserId の厳密一致が **ちょうど 1 件** のときのみ採用。
 * 0 件 / 複数件 (ambiguous) / エラーは null を返す (= 誤リンク防止)。
 *
 * accessToken は呼び出し側 (cron) が 1 回取得して渡す (= per-friend の token 再取得を避ける)。
 */
export async function findShopifyCustomerByLineId(
  storeDomain: string,
  accessToken: string,
  namespace: string,
  key: string,
  lineUserId: string,
  fetchImpl: typeof fetch,
): Promise<FoundCustomer | null> {
  if (!storeDomain || !namespace || !key) return null;
  if (!SAFE_METAFIELD_PART.test(namespace) || !SAFE_METAFIELD_PART.test(key)) return null;
  if (!SAFE_LINE_ID.test(lineUserId)) return null;

  const query = `
    query findCustomerByMetafield($q: String!, $ns: String!, $key: String!) {
      customers(first: 5, query: $q) {
        edges {
          node {
            id
            defaultEmailAddress { emailAddress }
            metafield(namespace: $ns, key: $key) { value }
          }
        }
      }
    }
  `;
  const variables = {
    q: `metafields.${namespace}.${key}:"${lineUserId}"`,
    ns: namespace,
    key,
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
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  // API/transport エラー (HTTP !ok / GraphQL errors / JSON parse) は throw して caller が errors として計上。
  // 「customer が居ない」 (= notFound) と「query 失敗」 (= Shopify 障害) を区別する (= 障害を notFound に誤計上しない)。
  if (!res.ok) throw new Error(`Shopify customers query failed: HTTP ${res.status}`);

  const body = (await res.json()) as ShopifyCustomerSearchResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify customers query errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  const edges = body.data?.customers?.edges ?? [];
  // search が部分一致しても metafield.value 比較で誤マッチを排除。 厳密一致がちょうど 1 件のみ採用。
  const exact = edges.filter((e) => (e.node?.metafield?.value ?? null) === lineUserId);
  if (exact.length !== 1) return null;

  const node = exact[0].node!;
  const customerId = normalizeShopifyCustomerId(node.id);
  if (!customerId) return null;
  return { customerId, email: node.defaultEmailAddress?.emailAddress ?? null };
}

// ============================================================
// main: processFriendCustomerLink (= cron entry point)
// ============================================================

function skip(reason: string): FriendLinkResult {
  return { skipped: true, reason, scanned: 0, linked: 0, ambiguous: 0, notFound: 0, errors: 0, backfilled: 0 };
}

/**
 * 未 link friend を Shopify customer (metafield 逆引き) に紐付ける cron entry point。
 *
 * gating:
 *   - FRIEND_LINK_ENABLED='true' でなければ no-op (= 本番未書込)
 *   - metafield namespace/key 未設定なら no-op
 *   - Shopify credentials 未設定なら no-op
 *   - JST 02:00-02:04 window 外は skip (FRIEND_LINK_CRON_FORCE='true' で bypass)
 */
export async function processFriendCustomerLink(
  env: FriendLinkEnv,
  options: ProcessFriendLinkOptions = {},
): Promise<FriendLinkResult> {
  // 1. 本番ガード (= default off)
  if (env.FRIEND_LINK_ENABLED !== 'true') return skip('gated_off');
  const ns = env.FRIEND_LINK_METAFIELD_NAMESPACE;
  const key = env.FRIEND_LINK_METAFIELD_KEY;
  if (!ns || !key) return skip('metafield_not_configured');
  // namespace/key に query 構文文字が混入していたら誤マッチ/失敗の元 → skip (= operator 設定ミス検知)
  if (!SAFE_METAFIELD_PART.test(ns) || !SAFE_METAFIELD_PART.test(key)) return skip('metafield_invalid');
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    return skip('shopify_not_configured');
  }

  // 2. window gating (JST 02:00-02:04、 FORCE で bypass)
  const nowMs = (options.now ?? Date.now)();
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const inWindow = jst.getUTCHours() === 2 && jst.getUTCMinutes() < 5;
  if (!inWindow && env.FRIEND_LINK_CRON_FORCE !== 'true') return skip('outside_window');

  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const backfillImpl = options.backfillImpl ?? backfillCustomerOrders;

  // 3. access token (= 1 回だけ取得して使い回す)
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(env.DB, env);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[friend-customer-linker] access token unavailable:', errMsg);
    await auditSystem(env.DB, {
      action: 'loyalty_customer_link.scan_failed',
      result: 'failure',
      errorMessage: errMsg,
      metadata: { stage: 'access_token' },
    });
    return { skipped: false, reason: 'token_unavailable', scanned: 0, linked: 0, ambiguous: 0, notFound: 0, errors: 1, backfilled: 0 };
  }

  // 4. 未 link friend を scan して metafield 逆引き → link
  const limit = options.limit ?? DEFAULT_BATCH_LIMIT;
  const friends = await listUnlinkedFriends(env.DB, limit);
  let linked = 0;
  let ambiguous = 0;
  let notFound = 0;
  let errors = 0;
  let backfilled = 0;

  for (const f of friends) {
    try {
      const found = await findShopifyCustomerByLineId(
        env.SHOPIFY_STORE_DOMAIN,
        accessToken,
        ns,
        key,
        f.line_user_id,
        fetchImpl,
      );
      if (!found) {
        notFound += 1;
        continue;
      }
      // 同 customer が別 friend に既 link されていないか事前検査 (= UNIQUE 制約 throw を回避)
      const owner = await getFriendByShopifyCustomerId(env.DB, found.customerId);
      if (owner && owner.id !== f.id) {
        ambiguous += 1;
        await auditSystem(env.DB, {
          action: 'loyalty_customer_link.ambiguous',
          targetType: 'friend',
          targetId: f.id,
          result: 'failure',
          metadata: { shopifyCustomerId: found.customerId, conflictFriendId: owner.id },
        });
        continue;
      }
      const { linked: didLink } = await setFriendShopifyCustomerId(env.DB, f.id, found.customerId);
      if (didLink) {
        linked += 1;
        await auditSystem(env.DB, {
          action: 'loyalty_customer_link.linked',
          targetType: 'friend',
          targetId: f.id,
          result: 'success',
          // PII 最小化: 顧客 email は append-only audit に残さない (= shopifyCustomerId で識別十分)。
          metadata: { shopifyCustomerId: found.customerId, matchedBy: 'metafield' },
        });
        // link 成立 → 過去注文 backfill (= money path、 MEMBER_BACKFILL_ENABLED gate は backfill 側で判定)。
        // accessToken/fetchImpl を再利用。 backfill 失敗は link を壊さない (= try/catch、 under-count は安全方向)。
        try {
          const bf = await backfillImpl(env.DB, env, {
            customerId: found.customerId,
            friendId: f.id,
            accessToken,
            fetchImpl,
          });
          backfilled += bf.backfilled;
        } catch (err) {
          console.error(
            '[friend-customer-linker] backfill failed friend',
            f.id,
            ':',
            err instanceof Error ? err.message : 'unknown',
          );
        }
      }
      // didLink=false (= 別 worker が先に link した等の競合) は no-op
    } catch (err) {
      errors += 1;
      console.error(
        '[friend-customer-linker] friend',
        f.id,
        'failed:',
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  // summary audit (= best-effort)
  await auditSystem(env.DB, {
    action: 'loyalty_customer_link.scan_completed',
    result: 'success',
    metadata: { scanned: friends.length, linked, ambiguous, notFound, errors, backfilled, batchLimit: limit },
  });

  return { skipped: false, scanned: friends.length, linked, ambiguous, notFound, errors, backfilled };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  DEFAULT_BATCH_LIMIT,
  SAFE_LINE_ID,
};
