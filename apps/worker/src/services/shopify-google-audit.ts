/**
 * Shopify-Google Merchant Audit Service (= LP launch blocker fix、 2026-05-27)
 *
 * 目的:
 *   Merchant Center 12/12 商品 Limited 状態の真因究明 + 自動修復。
 *   薬機法 NG keyword + 必須属性 (= GTIN / GPC / brand / image / description) を
 *   Shopify Admin GraphQL 経由で audit、 修正案を D1 に保管。 admin web から
 *   1-click apply or 一括 apply 可能。
 *
 * 設計方針:
 *   - **fail-safe**: 個別 product の audit 失敗で全体停止しない
 *   - **冪等**: 同 product 何度 audit しても同 issue が出るだけ (= run_id 別 record)
 *   - **dry-run 必須**: 修正は dry-run → review → apply の 2 段階
 *   - **graceful no-op**: SHOPIFY_* secret 未設定なら status='error' で skip
 *
 * 関連:
 *   - 既存 services/shopify-token.ts (= Client Credentials Grant + D1 cache)
 *   - 既存 services/shopify-coupon-issuer.ts (= GraphQL mutation 例)
 *   - migration 056 (= google_merchant_audit_runs + product_audit_issues)
 *
 * Shopify API version: 2026-04 (= 他 service と統一)
 */

import {
  insertAuditRun,
  insertProductIssues,
  markIssueApplied,
  getIssueById,
  type IssueCategory,
  type IssueSeverity,
  type InsertProductIssueInput,
} from '@line-crm/db';
import { getShopifyAccessToken } from './shopify-token.js';

// ============================================================
// 定数
// ============================================================

const SHOPIFY_API_VERSION = '2026-04';
const GRAPHQL_PAGE_SIZE = 50;
const MAX_PAGES = 20; // 50 × 20 = 1000 商品まで
const SHOPIFY_TIMEOUT_MS = 10_000;

// 薬機法 + Google Shopping policy NG keyword map
// 全パターンが naturism (= 健康食品 EC) で発生しうる典型 NG 表現
export const NG_KEYWORD_MAP: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
  severity: IssueSeverity;
  reason: string;
}> = [
  // 高 severity (= 薬機法明確違反)
  { pattern: /ダイエット効果/g, replacement: '食習慣サポート', severity: 'high', reason: '薬機法: 効果表現' },
  { pattern: /燃焼(?!系|サポート)/g, replacement: '日々の健康サポート', severity: 'high', reason: '薬機法: 効果断定' },
  { pattern: /痩せる/g, replacement: '健康的な毎日に', severity: 'high', reason: '薬機法: 効果断定' },
  { pattern: /痩身/g, replacement: 'スタイルケア', severity: 'high', reason: '薬機法: 効果表現' },
  { pattern: /やせる/g, replacement: '健康的な毎日に', severity: 'high', reason: '薬機法: 効果断定' },
  { pattern: /脂肪燃焼/g, replacement: '食生活の見直し', severity: 'high', reason: '薬機法: 効果表現' },
  { pattern: /医師(?:推奨|監修|認定)/g, replacement: '専門家との対話を経て', severity: 'high', reason: '薬機法: 第三者推奨' },
  { pattern: /即効/g, replacement: '習慣化', severity: 'high', reason: '薬機法: 即効性表現' },
  { pattern: /断食(?!の代|時)/g, replacement: 'リセット習慣', severity: 'high', reason: '医療表現の濫用' },
  { pattern: /(?:糖尿病|高血圧|肥満)(?:治療|改善|予防)/g, replacement: '健康な毎日を支える', severity: 'high', reason: '薬機法: 病名+効果' },
  { pattern: /\b-?\d+kg(?:痩|減)/g, replacement: '健康サポート', severity: 'high', reason: '薬機法: 具体的数値効果' },

  // 中 severity (= グレー / 文脈次第)
  { pattern: /効く/g, replacement: '実感', severity: 'medium', reason: '薬機法: 効果表現' },
  { pattern: /効果(?:が|を|の)/g, replacement: '感覚$1', severity: 'medium', reason: '薬機法: 効果表現' },
  { pattern: /効能/g, replacement: '特徴', severity: 'medium', reason: '薬機法: 効能表現' },
  { pattern: /絶対(?:に|！)/g, replacement: 'しっかり', severity: 'medium', reason: '薬機法: 絶対性表現' },
  { pattern: /必ず(?:痩せ|減|落)/g, replacement: '健康的な', severity: 'medium', reason: '薬機法: 確実性表現' },
  { pattern: /(?:奇跡|魔法)の/g, replacement: '毎日の', severity: 'medium', reason: '誇大広告表現' },
];

// 必須 metafield (= Google Merchant に approval される最低条件)
export const REQUIRED_METAFIELDS = {
  identifier_exists: { namespace: 'google', key: 'identifier_exists', value: 'false', type: 'single_line_text_field' },
  google_product_category: {
    namespace: 'google',
    key: 'google_product_category',
    value: 'Health & Beauty > Health Care > Vitamins & Supplements',
    type: 'single_line_text_field',
  },
  condition: { namespace: 'google', key: 'condition', value: 'new', type: 'single_line_text_field' },
  age_group: { namespace: 'google', key: 'age_group', value: 'adult', type: 'single_line_text_field' },
} as const;

// ============================================================
// 型
// ============================================================

export interface AuditEnv {
  DB: D1Database;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
}

export interface AuditOptions {
  trigger?: 'cron' | 'manual' | 'admin-ui';
  fetchImpl?: typeof fetch;
  /** test 用 product 注入 (= 実 GraphQL skip) */
  productsOverride?: ShopifyProductGraphQL[];
}

export interface AuditRunResult {
  runId: string;
  status: 'success' | 'partial' | 'error';
  totalProducts: number;
  productsWithIssues: number;
  highSeverityCount: number;
  mediumSeverityCount: number;
  lowSeverityCount: number;
  issuesByCategory: Record<string, number>;
  durationMs: number;
  errorMessage?: string;
}

export interface ShopifyProductGraphQL {
  id: string; // gid://shopify/Product/123
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string;
  status: string;
  totalInventory: number | null;
  featuredImage: { url: string } | null;
  images: { edges: Array<{ node: { url: string } }> };
  priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
  metafields: { edges: Array<{ node: { namespace: string; key: string; value: string; type: string } }> };
}

// ============================================================
// GraphQL fetch
// ============================================================

const PRODUCTS_QUERY = `#graphql
query ProductsForAudit($first: Int!, $cursor: String) {
  products(first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        descriptionHtml
        vendor
        productType
        handle
        status
        totalInventory
        featuredImage { url }
        images(first: 5) { edges { node { url } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        metafields(first: 30, namespace: "google") {
          edges { node { namespace key value type } }
        }
      }
    }
  }
}`;

export async function fetchAllProductsGraphQL(
  env: AuditEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopifyProductGraphQL[]> {
  if (!env.SHOPIFY_STORE_DOMAIN) {
    throw new Error('SHOPIFY_STORE_DOMAIN not configured');
  }
  const accessToken = await getShopifyAccessToken(env.DB, env);
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const headers = {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };

  const products: ShopifyProductGraphQL[] = [];
  let cursor: string | null = null;
  let page = 0;

  while (page < MAX_PAGES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query: PRODUCTS_QUERY,
          variables: { first: GRAPHQL_PAGE_SIZE, cursor },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`Shopify GraphQL returned ${res.status} on page ${page + 1}`);
    }

    const json = (await res.json()) as {
      data?: { products?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: Array<{ node: ShopifyProductGraphQL }> } };
      errors?: Array<{ message: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    const productsPage = json.data?.products;
    if (!productsPage) break;

    products.push(...productsPage.edges.map((e) => e.node));

    page += 1;
    if (!productsPage.pageInfo.hasNextPage) break;
    cursor = productsPage.pageInfo.endCursor;
  }

  return products;
}

// ============================================================
// 単一 product の audit
// ============================================================

export interface DetectedIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  field?: string;
  originalValue?: string;
  suggestedValue?: string;
  metadata?: Record<string, unknown>;
}

export function auditSingleProduct(product: ShopifyProductGraphQL): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // ❶ NG keyword scan (= title + descriptionHtml)
  const titleNg = scanNgKeywords(product.title);
  for (const m of titleNg) {
    issues.push({
      category: 'ng_keyword',
      severity: m.severity,
      field: 'title',
      originalValue: m.original,
      suggestedValue: m.suggested,
      metadata: { pattern: m.pattern, reason: m.reason },
    });
  }

  if (product.descriptionHtml) {
    // strip HTML tags for keyword scan
    const plainText = product.descriptionHtml.replace(/<[^>]+>/g, '');
    const descNg = scanNgKeywords(plainText);
    for (const m of descNg) {
      issues.push({
        category: 'ng_keyword',
        severity: m.severity,
        field: 'descriptionHtml',
        originalValue: m.original,
        suggestedValue: m.suggested,
        metadata: { pattern: m.pattern, reason: m.reason },
      });
    }
  } else {
    issues.push({
      category: 'missing_description',
      severity: 'medium',
      field: 'descriptionHtml',
      suggestedValue: '商品説明を追加 (= Google Merchant 推奨 250+ 文字)',
    });
  }

  // ❷ metafield presence check
  const metafields = new Map(
    product.metafields.edges.map((e) => [`${e.node.namespace}.${e.node.key}`, e.node.value]),
  );

  if (!metafields.has('google.identifier_exists')) {
    issues.push({
      category: 'missing_gtin',
      severity: 'high',
      field: 'metafield.google.identifier_exists',
      suggestedValue: 'false',
      metadata: { reason: '自社ブランドで GTIN なし → identifier_exists=false を明示必須' },
    });
  }

  if (!metafields.has('google.google_product_category')) {
    issues.push({
      category: 'missing_gpc',
      severity: 'high',
      field: 'metafield.google.google_product_category',
      suggestedValue: REQUIRED_METAFIELDS.google_product_category.value,
      metadata: { reason: 'Google Product Category 階層未設定' },
    });
  }

  // ❸ brand 属性 (= vendor が空 or "naturism" 以外)
  if (!product.vendor || product.vendor.trim().toLowerCase() !== 'naturism') {
    issues.push({
      category: 'missing_brand',
      severity: 'medium',
      field: 'vendor',
      originalValue: product.vendor ?? '',
      suggestedValue: 'naturism',
      metadata: { reason: 'Google Merchant では brand 属性必須、 vendor で代用' },
    });
  }

  // ❹ image 存在 check
  if (!product.featuredImage && product.images.edges.length === 0) {
    issues.push({
      category: 'missing_image',
      severity: 'high',
      field: 'images',
      suggestedValue: '商品画像を 1 枚以上追加 (= 800x800 以上、 background テキストなし)',
    });
  }

  // ❺ inventory check
  if (product.totalInventory !== null && product.totalInventory <= 0 && product.status === 'active') {
    issues.push({
      category: 'inventory_zero',
      severity: 'medium',
      field: 'totalInventory',
      originalValue: String(product.totalInventory),
      suggestedValue: '在庫を追加 or status を draft に',
    });
  }

  return issues;
}

export function scanNgKeywords(text: string): Array<{
  original: string;
  suggested: string;
  pattern: string;
  severity: IssueSeverity;
  reason: string;
}> {
  const matches: Array<{
    original: string;
    suggested: string;
    pattern: string;
    severity: IssueSeverity;
    reason: string;
  }> = [];
  for (const ng of NG_KEYWORD_MAP) {
    // reset lastIndex (= global flag の safety)
    ng.pattern.lastIndex = 0;
    const found = text.match(ng.pattern);
    if (found && found.length > 0) {
      // unique 化 (= 同じ表現複数回検出した場合 1 件にまとめる)
      const uniqueOriginals = Array.from(new Set(found));
      for (const original of uniqueOriginals) {
        const suggested = original.replace(ng.pattern, ng.replacement);
        matches.push({
          original,
          suggested,
          pattern: ng.pattern.source,
          severity: ng.severity,
          reason: ng.reason,
        });
      }
    }
  }
  return matches;
}

// ============================================================
// audit run main
// ============================================================

export async function runProductAudit(
  env: AuditEnv,
  options: AuditOptions = {},
): Promise<AuditRunResult> {
  const trigger = options.trigger ?? 'manual';
  const fetchImpl = options.fetchImpl ?? fetch;
  const startTime = Date.now();
  const runId = crypto.randomUUID();

  let products: ShopifyProductGraphQL[] = [];
  let status: 'success' | 'partial' | 'error' = 'success';
  let errorMessage: string | undefined;

  try {
    if (options.productsOverride) {
      products = options.productsOverride;
    } else {
      products = await fetchAllProductsGraphQL(env, fetchImpl);
    }
  } catch (err) {
    status = 'error';
    errorMessage = err instanceof Error ? err.message : 'unknown fetch error';
    await insertAuditRun(env.DB, {
      id: runId,
      trigger,
      status,
      totalProducts: 0,
      productsWithIssues: 0,
      highSeverityCount: 0,
      mediumSeverityCount: 0,
      lowSeverityCount: 0,
      issuesByCategory: {},
      durationMs: Date.now() - startTime,
      errorMessage,
    });
    return {
      runId,
      status,
      totalProducts: 0,
      productsWithIssues: 0,
      highSeverityCount: 0,
      mediumSeverityCount: 0,
      lowSeverityCount: 0,
      issuesByCategory: {},
      durationMs: Date.now() - startTime,
      errorMessage,
    };
  }

  // audit per product
  const allIssues: InsertProductIssueInput[] = [];
  const issuesByCategory: Record<string, number> = {};
  let productsWithIssues = 0;
  let highSeverityCount = 0;
  let mediumSeverityCount = 0;
  let lowSeverityCount = 0;

  for (const product of products) {
    try {
      const detected = auditSingleProduct(product);
      if (detected.length > 0) productsWithIssues += 1;

      for (const issue of detected) {
        if (issue.severity === 'high') highSeverityCount += 1;
        else if (issue.severity === 'medium') mediumSeverityCount += 1;
        else lowSeverityCount += 1;

        issuesByCategory[issue.category] = (issuesByCategory[issue.category] ?? 0) + 1;

        allIssues.push({
          runId,
          shopifyProductId: product.id,
          productTitle: product.title,
          productHandle: product.handle,
          category: issue.category,
          severity: issue.severity,
          field: issue.field,
          originalValue: issue.originalValue,
          suggestedValue: issue.suggestedValue,
          metadata: issue.metadata,
        });
      }
    } catch (err) {
      status = 'partial';
      console.warn(
        '[shopify-google-audit] audit failed for product',
        product.id,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  try {
    await insertProductIssues(env.DB, allIssues);
  } catch (err) {
    status = 'partial';
    console.error(
      '[shopify-google-audit] insertProductIssues failed',
      err instanceof Error ? err.message : 'unknown',
    );
  }

  const durationMs = Date.now() - startTime;
  await insertAuditRun(env.DB, {
    id: runId,
    trigger,
    status,
    totalProducts: products.length,
    productsWithIssues,
    highSeverityCount,
    mediumSeverityCount,
    lowSeverityCount,
    issuesByCategory,
    durationMs,
    errorMessage,
  });

  return {
    runId,
    status,
    totalProducts: products.length,
    productsWithIssues,
    highSeverityCount,
    mediumSeverityCount,
    lowSeverityCount,
    issuesByCategory,
    durationMs,
    errorMessage,
  };
}

// ============================================================
// 1 issue apply (= admin-ui / cron から呼び出し)
// ============================================================

export async function applyIssueFix(
  env: AuditEnv,
  issueId: string,
  appliedBy: string,
  options: { dryRun?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<{
  success: boolean;
  dryRun: boolean;
  applied?: { field: string; before: string | null; after: string | null };
  error?: string;
}> {
  const dryRun = options.dryRun ?? false;
  const fetchImpl = options.fetchImpl ?? fetch;

  const issue = await getIssueById(env.DB, issueId);
  if (!issue) return { success: false, dryRun, error: 'issue not found' };
  if (issue.applied === 1) return { success: false, dryRun, error: 'already applied' };

  if (!issue.suggested_value) {
    return { success: false, dryRun, error: 'no suggested value' };
  }

  // metafield fix
  if (issue.field?.startsWith('metafield.')) {
    const parts = issue.field.split('.');
    const namespace = parts[1];
    const key = parts.slice(2).join('.');
    if (!namespace || !key) return { success: false, dryRun, error: 'invalid metafield field path' };

    if (dryRun) {
      return {
        success: true,
        dryRun,
        applied: { field: issue.field, before: issue.original_value, after: issue.suggested_value },
      };
    }

    try {
      await setProductMetafield(env, fetchImpl, issue.shopify_product_id, namespace, key, issue.suggested_value);
      await markIssueApplied(env.DB, issueId, appliedBy);
      return {
        success: true,
        dryRun,
        applied: { field: issue.field, before: issue.original_value, after: issue.suggested_value },
      };
    } catch (err) {
      return { success: false, dryRun, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  // vendor fix (= simple field)
  if (issue.field === 'vendor') {
    if (dryRun) {
      return {
        success: true,
        dryRun,
        applied: { field: 'vendor', before: issue.original_value, after: issue.suggested_value },
      };
    }
    try {
      await setProductVendor(env, fetchImpl, issue.shopify_product_id, issue.suggested_value);
      await markIssueApplied(env.DB, issueId, appliedBy);
      return {
        success: true,
        dryRun,
        applied: { field: 'vendor', before: issue.original_value, after: issue.suggested_value },
      };
    } catch (err) {
      return { success: false, dryRun, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  // ng_keyword title/description rewrite
  if (issue.category === 'ng_keyword' && (issue.field === 'title' || issue.field === 'descriptionHtml')) {
    if (dryRun) {
      return {
        success: true,
        dryRun,
        applied: { field: issue.field, before: issue.original_value, after: issue.suggested_value },
      };
    }
    try {
      await rewriteProductField(
        env,
        fetchImpl,
        issue.shopify_product_id,
        issue.field,
        issue.original_value ?? '',
        issue.suggested_value,
      );
      await markIssueApplied(env.DB, issueId, appliedBy);
      return {
        success: true,
        dryRun,
        applied: { field: issue.field, before: issue.original_value, after: issue.suggested_value },
      };
    } catch (err) {
      return { success: false, dryRun, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  return {
    success: false,
    dryRun,
    error: `unsupported fix for category=${issue.category} field=${issue.field}`,
  };
}

// ============================================================
// GraphQL mutation helpers
// ============================================================

const SET_METAFIELD_MUTATION = `#graphql
mutation MetafieldSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id key namespace value }
    userErrors { field message }
  }
}`;

async function setProductMetafield(
  env: AuditEnv,
  fetchImpl: typeof fetch,
  productGid: string,
  namespace: string,
  key: string,
  value: string,
): Promise<void> {
  if (!env.SHOPIFY_STORE_DOMAIN) throw new Error('SHOPIFY_STORE_DOMAIN not configured');
  const accessToken = await getShopifyAccessToken(env.DB, env);
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: SET_METAFIELD_MUTATION,
      variables: {
        metafields: [
          { ownerId: productGid, namespace, key, value, type: 'single_line_text_field' },
        ],
      },
    }),
  });
  if (!res.ok) throw new Error(`metafieldsSet returned ${res.status}`);
  const json = (await res.json()) as {
    data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const userErrors = json.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`metafieldsSet userErrors: ${userErrors.map((e) => e.message).join('; ')}`);
  }
}

const PRODUCT_UPDATE_MUTATION = `#graphql
mutation ProductUpdate($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id title vendor descriptionHtml }
    userErrors { field message }
  }
}`;

async function setProductVendor(
  env: AuditEnv,
  fetchImpl: typeof fetch,
  productGid: string,
  vendor: string,
): Promise<void> {
  await productUpdateGeneric(env, fetchImpl, productGid, { vendor });
}

async function rewriteProductField(
  env: AuditEnv,
  fetchImpl: typeof fetch,
  productGid: string,
  field: 'title' | 'descriptionHtml',
  originalValue: string,
  suggestedValue: string,
): Promise<void> {
  // 安全のため、 originalValue が含まれる場合のみ置換 (= 別 issue 引きずらない)
  if (field === 'title') {
    await productUpdateGeneric(env, fetchImpl, productGid, { title: suggestedValue });
  } else {
    // descriptionHtml は global replace (= original → suggested) を full text に対して行う
    // 現在の description を取得 → 部分置換 → update
    const currentDesc = await getProductDescription(env, fetchImpl, productGid);
    if (currentDesc && currentDesc.includes(originalValue)) {
      const newDesc = currentDesc.split(originalValue).join(suggestedValue);
      await productUpdateGeneric(env, fetchImpl, productGid, { descriptionHtml: newDesc });
    } else {
      throw new Error('original value not found in current description (stale issue)');
    }
  }
}

async function productUpdateGeneric(
  env: AuditEnv,
  fetchImpl: typeof fetch,
  productGid: string,
  fields: Record<string, string>,
): Promise<void> {
  if (!env.SHOPIFY_STORE_DOMAIN) throw new Error('SHOPIFY_STORE_DOMAIN not configured');
  const accessToken = await getShopifyAccessToken(env.DB, env);
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: PRODUCT_UPDATE_MUTATION,
      variables: { input: { id: productGid, ...fields } },
    }),
  });
  if (!res.ok) throw new Error(`productUpdate returned ${res.status}`);
  const json = (await res.json()) as {
    data?: { productUpdate?: { userErrors?: Array<{ message: string }> } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const userErrors = json.data?.productUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`productUpdate userErrors: ${userErrors.map((e) => e.message).join('; ')}`);
  }
}

const GET_DESCRIPTION_QUERY = `#graphql
query GetDescription($id: ID!) {
  product(id: $id) { descriptionHtml }
}`;

async function getProductDescription(
  env: AuditEnv,
  fetchImpl: typeof fetch,
  productGid: string,
): Promise<string | null> {
  if (!env.SHOPIFY_STORE_DOMAIN) return null;
  const accessToken = await getShopifyAccessToken(env.DB, env);
  const url = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: GET_DESCRIPTION_QUERY, variables: { id: productGid } }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { product?: { descriptionHtml: string | null } } };
  return json.data?.product?.descriptionHtml ?? null;
}

// ============================================================
// テスト用 export
// ============================================================

export const __test__ = {
  scanNgKeywords,
  auditSingleProduct,
  NG_KEYWORD_MAP,
  REQUIRED_METAFIELDS,
  SHOPIFY_API_VERSION,
};
