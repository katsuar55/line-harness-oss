/**
 * Account Link — Shopify forward-link (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 役割:
 *   email OTP で本人確認した後に、 その email の Shopify customer を email 照合で引き当て (= forward lookup)、
 *   自前メタフィールド `{ns}.{key} = lineUserId` を customer に書き込む (= Social PLUS 非依存の自己所有マッピング)。
 *   PR3-A (friend-customer-linker.ts) は metafield 逆引き (= reverse) だが、 本ファイルは email→customer の forward。
 *
 * 設計 (= friend-customer-linker.ts と同 GraphQL/timeout/allowlist パターン):
 *   - findShopifyCustomerByEmail: customers(query: "email:\"...\"") で検索 → defaultEmailAddress を
 *     入力 email と **厳密 (case-insensitive) 一致**させ、 ちょうど 1 件のときのみ採用 (= 部分一致/複数件 排除)。
 *   - setCustomerLineUserIdMetafield: metafieldsSet mutation で single_line_text_field を書込。
 *     userErrors を返し、 transport/GraphQL エラーは throw (= caller が best-effort で握る)。
 *   - email / namespace / key / lineUserId は query/mutation 構文文字の注入を防ぐ allowlist で検査。
 *   - customer id は gid → 数値正規化 (= normalizeShopifyCustomerId 再利用、 webhook/orders と同形式)。
 *
 * セキュリティ:
 *   - SAFE_EMAIL は `"` `\` 等を排除する厳格 allowlist (= `email:"..."` query への注入防止)。
 *   - fetch は呼び出し側が fetchImpl を渡す (default は service 側で fetch.bind(globalThis))。
 *
 * 関連:
 *   - apps/worker/src/services/account-link.ts (= 呼び出し元、 OTP 検証後に本関数で link)
 *   - apps/worker/src/services/friend-customer-linker.ts (= reverse link、 normalizeShopifyCustomerId 提供)
 */
import { normalizeShopifyCustomerId } from './friend-customer-linker.js';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
const SHOPIFY_TIMEOUT_MS = 8_000;
// metafield namespace/key の許容文字 (= query/mutation 構文文字の混入を防ぐ defense-in-depth)。
const SAFE_METAFIELD_PART = /^[A-Za-z0-9_-]+$/;
// LINE user id の許容文字 (= metafield value 注入防止)。 実 LINE id は U+hex。
const SAFE_LINE_ID = /^[A-Za-z0-9_-]+$/;
// Shopify email search query に埋め込む email の厳格 allowlist (= `"` `\` 等の注入防止)。
// 実顧客 email は全てこの範囲。 範囲外は照合不能として null (= 安全方向)。
const SAFE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ============================================================
// types
// ============================================================

export interface FoundCustomerByEmail {
  /** 数値正規化済 customer id (= REST/orders と同形式) */
  customerId: string;
}

export interface MetafieldWriteResult {
  readonly ok: boolean;
  /** userErrors の message 配列 (= ok=false 時の理由)。 */
  readonly userErrors: string[];
}

interface CustomersByEmailResponse {
  data?: {
    customers?: {
      edges?: Array<{
        node?: {
          id?: string;
          defaultEmailAddress?: { emailAddress?: string | null } | null;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface MetafieldsSetResponse {
  data?: {
    metafieldsSet?: {
      metafields?: Array<{ id?: string }> | null;
      userErrors?: Array<{ field?: string[] | null; message?: string }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface MetafieldsDeleteResponse {
  data?: {
    metafieldsDelete?: {
      deletedMetafields?: Array<{ key?: string; namespace?: string; ownerId?: string }> | null;
      userErrors?: Array<{ field?: string[] | null; message?: string }> | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

// ============================================================
// shared fetch helper
// ============================================================

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const url = `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// findShopifyCustomerByEmail (= forward lookup)
// ============================================================

/**
 * email に一致する Shopify customer を検索する。
 * Shopify の email 検索は部分一致しうるため、 defaultEmailAddress を入力 email と
 * **厳密 (case-insensitive) 一致**させ、 ちょうど 1 件のときのみ採用 (= 0/複数件は null)。
 * transport/GraphQL エラーは throw (= caller が区別して扱う)。
 */
export async function findShopifyCustomerByEmail(
  storeDomain: string,
  accessToken: string,
  email: string,
  fetchImpl: typeof fetch,
): Promise<FoundCustomerByEmail | null> {
  if (!storeDomain) return null;
  const emailLower = email.trim().toLowerCase();
  if (!SAFE_EMAIL.test(emailLower)) return null;

  const query = `
    query findCustomerByEmail($q: String!) {
      customers(first: 5, query: $q) {
        edges {
          node {
            id
            defaultEmailAddress { emailAddress }
          }
        }
      }
    }
  `;
  const variables = { q: `email:"${emailLower}"` };

  const res = await shopifyGraphql(storeDomain, accessToken, { query, variables }, fetchImpl);
  if (!res.ok) throw new Error(`Shopify customers(email) query failed: HTTP ${res.status}`);

  const body = (await res.json()) as CustomersByEmailResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify customers(email) query errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  const edges = body.data?.customers?.edges ?? [];
  const exact = edges.filter(
    (e) => (e.node?.defaultEmailAddress?.emailAddress ?? '').trim().toLowerCase() === emailLower,
  );
  if (exact.length !== 1) return null;

  const customerId = normalizeShopifyCustomerId(exact[0].node!.id);
  if (!customerId) return null;
  return { customerId };
}

// ============================================================
// setCustomerLineUserIdMetafield (= 自己所有マッピング書込)
// ============================================================

/**
 * customer に `{namespace}.{key} = lineUserId` の single_line_text_field metafield を書き込む。
 * metafieldsSet は upsert (= 既存値は上書き)。 transport/GraphQL エラーは throw、
 * business エラー (= userErrors) は ok=false + message で返す (= caller が best-effort で握る)。
 *
 * @param customerId 数値正規化済 customer id (= normalizeShopifyCustomerId 出力)。 gid に再構成して ownerId にする。
 */
export async function setCustomerLineUserIdMetafield(
  storeDomain: string,
  accessToken: string,
  customerId: string,
  namespace: string,
  key: string,
  lineUserId: string,
  fetchImpl: typeof fetch,
): Promise<MetafieldWriteResult> {
  if (!storeDomain) return { ok: false, userErrors: ['store_not_configured'] };
  if (!/^\d+$/.test(customerId)) return { ok: false, userErrors: ['invalid_customer_id'] };
  if (!SAFE_METAFIELD_PART.test(namespace) || !SAFE_METAFIELD_PART.test(key)) {
    return { ok: false, userErrors: ['invalid_metafield'] };
  }
  if (!SAFE_LINE_ID.test(lineUserId)) return { ok: false, userErrors: ['invalid_line_id'] };

  const mutation = `
    mutation setCustomerLineId($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      {
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace,
        key,
        type: 'single_line_text_field',
        value: lineUserId,
      },
    ],
  };

  const res = await shopifyGraphql(storeDomain, accessToken, { query: mutation, variables }, fetchImpl);
  if (!res.ok) throw new Error(`Shopify metafieldsSet failed: HTTP ${res.status}`);

  const body = (await res.json()) as MetafieldsSetResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify metafieldsSet errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  const userErrors = (body.data?.metafieldsSet?.userErrors ?? [])
    .map((e) => e.message ?? 'unknown')
    .filter((m): m is string => typeof m === 'string');
  return { ok: userErrors.length === 0, userErrors };
}

/**
 * customer の LINE ID metafield を削除する (= 連携解除の後始末、 2026-08-28)。
 *
 * これを消さないと、metafield 逆引き cron (services/friend-customer-linker.ts) が
 * 「解除したはずの連携」を翌 02:00 に復活させうる。現状は cron と OTP で namespace が
 * 別なので即座には起きないが、統合 op を実行した後は同一になるため先に塞いでおく。
 *
 * metafieldsDelete は「存在しない metafield」に対しても userErrors 無しで成功する
 * (= 冪等)。transport/GraphQL エラーは throw、 userErrors は ok:false で返す (書込と同じ流儀)。
 */
export async function deleteCustomerLineUserIdMetafield(
  storeDomain: string,
  accessToken: string,
  customerId: string,
  namespace: string,
  key: string,
  fetchImpl: typeof fetch,
): Promise<MetafieldWriteResult> {
  if (!storeDomain) return { ok: false, userErrors: ['store_not_configured'] };
  if (!/^\d+$/.test(customerId)) return { ok: false, userErrors: ['invalid_customer_id'] };
  if (!SAFE_METAFIELD_PART.test(namespace) || !SAFE_METAFIELD_PART.test(key)) {
    return { ok: false, userErrors: ['invalid_metafield'] };
  }

  const mutation = `
    mutation deleteCustomerLineId($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields { key namespace ownerId }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: [
      { ownerId: `gid://shopify/Customer/${customerId}`, namespace, key },
    ],
  };

  const res = await shopifyGraphql(storeDomain, accessToken, { query: mutation, variables }, fetchImpl);
  if (!res.ok) throw new Error(`Shopify metafieldsDelete failed: HTTP ${res.status}`);

  const body = (await res.json()) as MetafieldsDeleteResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Shopify metafieldsDelete errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }

  const userErrors = (body.data?.metafieldsDelete?.userErrors ?? [])
    .map((e) => e.message ?? 'unknown')
    .filter((m): m is string => typeof m === 'string');
  return { ok: userErrors.length === 0, userErrors };
}

// ============================================================
// test 用 export
// ============================================================

export const __test__ = {
  SHOPIFY_API_VERSION,
  SHOPIFY_TIMEOUT_MS,
  SAFE_EMAIL,
};
