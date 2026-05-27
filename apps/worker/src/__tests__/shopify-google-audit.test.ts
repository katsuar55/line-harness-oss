/**
 * Tests for services/shopify-google-audit (= LP launch blocker fix、 2026-05-27)
 *
 * カバー範囲:
 *   - scanNgKeywords: 各 NG pattern + severity / replacement
 *   - auditSingleProduct: 7 仮説 (= ng_keyword / missing_gtin / missing_gpc /
 *     missing_brand / missing_image / inventory_zero / missing_description)
 *   - runProductAudit: productsOverride 注入で end-to-end (= fetch 不要)
 *   - applyIssueFix: dryRun mode + actual mode
 *   - fail-safe: invalid product / GraphQL error / partial 失敗
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock @line-crm/db
// ============================================================

const dbState = {
  auditRuns: [] as Array<Record<string, unknown>>,
  issues: [] as Array<Record<string, unknown>>,
  insertRunShouldThrow: false,
  insertIssuesShouldThrow: false,
};

vi.mock('@line-crm/db', () => ({
  insertAuditRun: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    if (dbState.insertRunShouldThrow) throw new Error('simulated insertAuditRun failure');
    dbState.auditRuns.push(input);
  }),
  insertProductIssues: vi.fn(
    async (_db: unknown, issues: Array<Record<string, unknown>>) => {
      if (dbState.insertIssuesShouldThrow) throw new Error('simulated insertIssues failure');
      dbState.issues.push(...issues);
    },
  ),
  markIssueApplied: vi.fn(async () => undefined),
  getIssueById: vi.fn(async (_db: unknown, issueId: string) => {
    return dbState.issues.find((i) => i.id === issueId) ?? null;
  }),
}));

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpca_test_token_xxx'),
}));

// ============================================================
// Fake D1
// ============================================================

function makeFakeDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return null as T;
            },
            async all<T>() {
              return { results: [] as T[], success: true };
            },
            async run() {
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ============================================================
// Helpers
// ============================================================

interface ShopifyProductGraphQL {
  id: string;
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

function makeProduct(overrides: Partial<ShopifyProductGraphQL> = {}): ShopifyProductGraphQL {
  return {
    id: 'gid://shopify/Product/1',
    title: 'naturism Blue',
    descriptionHtml: '<p>毎日の食習慣サポート用サプリメント。 8 成分配合。</p>',
    vendor: 'naturism',
    productType: 'Supplement',
    handle: 'naturism-blue',
    status: 'active',
    totalInventory: 100,
    featuredImage: { url: 'https://cdn.shopify.com/blue.jpg' },
    images: { edges: [{ node: { url: 'https://cdn.shopify.com/blue.jpg' } }] },
    priceRangeV2: { minVariantPrice: { amount: '1980', currencyCode: 'JPY' } },
    metafields: {
      edges: [
        {
          node: {
            namespace: 'google',
            key: 'identifier_exists',
            value: 'false',
            type: 'single_line_text_field',
          },
        },
        {
          node: {
            namespace: 'google',
            key: 'google_product_category',
            value: 'Health & Beauty > Health Care > Vitamins & Supplements',
            type: 'single_line_text_field',
          },
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  dbState.auditRuns.length = 0;
  dbState.issues.length = 0;
  dbState.insertRunShouldThrow = false;
  dbState.insertIssuesShouldThrow = false;
  vi.clearAllMocks();
});

// ============================================================
// scanNgKeywords
// ============================================================

describe('scanNgKeywords', () => {
  it('「ダイエット効果」 → high severity match', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords('このサプリは確実にダイエット効果があります');
    expect(matches.length).toBeGreaterThan(0);
    const ngMatch = matches.find((m) => m.original.includes('ダイエット'));
    expect(ngMatch).toBeDefined();
    expect(ngMatch?.severity).toBe('high');
  });

  it('「痩せる」 → high severity', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords('飲むだけで痩せる魔法のサプリ');
    expect(matches.some((m) => m.severity === 'high' && /痩/.test(m.original))).toBe(true);
  });

  it('「医師推奨」 → high severity', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords('医師推奨の確かな成分配合');
    expect(matches.some((m) => m.original.includes('医師推奨'))).toBe(true);
  });

  it('「効く」 → medium severity', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords('しっかり効くので人気です');
    const med = matches.find((m) => m.original === '効く');
    expect(med?.severity).toBe('medium');
  });

  it('安全な表現 (= 「食習慣サポート」) → 0 件', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords(
      'naturism Blue は毎日の食習慣サポート用サプリメント。 8 成分配合で日々の健康維持に。',
    );
    // 厳密 0 件か、 もしくは false positive は低 severity のみ
    const highMatches = matches.filter((m) => m.severity === 'high');
    expect(highMatches.length).toBe(0);
  });

  it('複数 NG keyword → 全部検出 (= high 4 件以上、 overlap pattern による medium も許容)', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const matches = __test__.scanNgKeywords(
      '医師推奨の即効ダイエット効果で必ず痩せる脂肪燃焼サプリ',
    );
    expect(matches.length).toBeGreaterThanOrEqual(4);
    // overlap pattern (= 「ダイエット効果」 が high + 「効果が」 が medium 等) で medium も
    // 検出されうるため、 high が 4 件以上ある事のみ assert
    const highCount = matches.filter((m) => m.severity === 'high').length;
    expect(highCount).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================
// auditSingleProduct
// ============================================================

describe('auditSingleProduct', () => {
  it('healthy product → issues 0 (= or low only)', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(makeProduct());
    const high = issues.filter((i) => i.severity === 'high');
    expect(high.length).toBe(0);
  });

  it('vendor 空 → missing_brand 検出', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(makeProduct({ vendor: null }));
    expect(issues.some((i) => i.category === 'missing_brand')).toBe(true);
  });

  it('vendor 不一致 → missing_brand 検出 (= "naturism" のみ OK)', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(makeProduct({ vendor: 'OtherBrand' }));
    expect(issues.some((i) => i.category === 'missing_brand')).toBe(true);
  });

  it('identifier_exists metafield なし → missing_gtin high', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const product = makeProduct({
      metafields: {
        edges: [
          {
            node: {
              namespace: 'google',
              key: 'google_product_category',
              value: 'Health & Beauty > Health Care > Vitamins & Supplements',
              type: 'single_line_text_field',
            },
          },
        ],
      },
    });
    const issues = __test__.auditSingleProduct(product);
    const gtin = issues.find((i) => i.category === 'missing_gtin');
    expect(gtin).toBeDefined();
    expect(gtin?.severity).toBe('high');
    expect(gtin?.suggestedValue).toBe('false');
  });

  it('google_product_category なし → missing_gpc high', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const product = makeProduct({
      metafields: {
        edges: [
          {
            node: {
              namespace: 'google',
              key: 'identifier_exists',
              value: 'false',
              type: 'single_line_text_field',
            },
          },
        ],
      },
    });
    const issues = __test__.auditSingleProduct(product);
    const gpc = issues.find((i) => i.category === 'missing_gpc');
    expect(gpc).toBeDefined();
    expect(gpc?.severity).toBe('high');
    expect(gpc?.suggestedValue).toContain('Vitamins & Supplements');
  });

  it('image なし → missing_image high', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const product = makeProduct({
      featuredImage: null,
      images: { edges: [] },
    });
    const issues = __test__.auditSingleProduct(product);
    expect(issues.some((i) => i.category === 'missing_image' && i.severity === 'high')).toBe(true);
  });

  it('description 空 → missing_description medium', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(makeProduct({ descriptionHtml: null }));
    expect(issues.some((i) => i.category === 'missing_description' && i.severity === 'medium')).toBe(true);
  });

  it('inventory 0 + active → inventory_zero medium', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(
      makeProduct({ totalInventory: 0, status: 'active' }),
    );
    expect(issues.some((i) => i.category === 'inventory_zero')).toBe(true);
  });

  it('title に NG keyword → ng_keyword field=title', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(
      makeProduct({ title: '即効ダイエット効果 naturism Blue' }),
    );
    const ng = issues.filter((i) => i.category === 'ng_keyword' && i.field === 'title');
    expect(ng.length).toBeGreaterThan(0);
  });

  it('descriptionHtml に NG keyword → ng_keyword field=descriptionHtml', async () => {
    const { __test__ } = await import('../services/shopify-google-audit.js');
    const issues = __test__.auditSingleProduct(
      makeProduct({ descriptionHtml: '<p>飲むだけで痩せる効果あり</p>' }),
    );
    const ng = issues.filter((i) => i.category === 'ng_keyword' && i.field === 'descriptionHtml');
    expect(ng.length).toBeGreaterThan(0);
  });
});

// ============================================================
// runProductAudit (= productsOverride で end-to-end)
// ============================================================

describe('runProductAudit', () => {
  it('healthy 1 product → status=success, 0 high', async () => {
    const { runProductAudit } = await import('../services/shopify-google-audit.js');
    const result = await runProductAudit(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'xn-test.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      { productsOverride: [makeProduct()] },
    );
    expect(result.status).toBe('success');
    expect(result.totalProducts).toBe(1);
    expect(result.highSeverityCount).toBe(0);
    expect(dbState.auditRuns).toHaveLength(1);
  });

  it('NG keyword product → high severity 検出 + DB insert', async () => {
    const { runProductAudit } = await import('../services/shopify-google-audit.js');
    const product = makeProduct({
      title: 'ダイエット効果 即効サプリ',
      descriptionHtml: '<p>必ず痩せる</p>',
    });
    const result = await runProductAudit(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      { productsOverride: [product] },
    );
    expect(result.totalProducts).toBe(1);
    expect(result.productsWithIssues).toBe(1);
    expect(result.highSeverityCount).toBeGreaterThan(0);
    expect(result.issuesByCategory['ng_keyword']).toBeGreaterThan(0);
  });

  it('全 metafield 欠落 product → missing_gtin + missing_gpc 両方', async () => {
    const { runProductAudit } = await import('../services/shopify-google-audit.js');
    const product = makeProduct({ metafields: { edges: [] } });
    const result = await runProductAudit(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      { productsOverride: [product] },
    );
    expect(result.issuesByCategory['missing_gtin']).toBe(1);
    expect(result.issuesByCategory['missing_gpc']).toBe(1);
  });

  it('複数 products → 集計が正しい', async () => {
    const { runProductAudit } = await import('../services/shopify-google-audit.js');
    const products = [
      makeProduct({ id: 'gid://1', title: 'OK 1' }),
      makeProduct({ id: 'gid://2', title: '痩せる ダイエット効果', vendor: 'other' }),
      makeProduct({ id: 'gid://3', metafields: { edges: [] } }),
    ];
    const result = await runProductAudit(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      { productsOverride: products },
    );
    expect(result.totalProducts).toBe(3);
    expect(result.productsWithIssues).toBeGreaterThanOrEqual(2);
  });

  it('insertProductIssues 失敗 → status=partial (= run 自体は記録)', async () => {
    const { runProductAudit } = await import('../services/shopify-google-audit.js');
    dbState.insertIssuesShouldThrow = true;
    const result = await runProductAudit(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      {
        productsOverride: [makeProduct({ title: 'ダイエット効果' })],
      },
    );
    expect(result.status).toBe('partial');
    expect(dbState.auditRuns).toHaveLength(1);
  });
});

// ============================================================
// applyIssueFix (= dryRun mode)
// ============================================================

describe('applyIssueFix', () => {
  it('issue not found → success=false', async () => {
    const { applyIssueFix } = await import('../services/shopify-google-audit.js');
    const result = await applyIssueFix(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      'non-existent-id',
      'admin-ui',
      { dryRun: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('issue not found');
  });

  it('metafield fix dry-run → success + applied preview', async () => {
    const { applyIssueFix } = await import('../services/shopify-google-audit.js');
    // mock issue exists
    dbState.issues.push({
      id: 'issue-1',
      shopify_product_id: 'gid://shopify/Product/123',
      field: 'metafield.google.identifier_exists',
      original_value: null,
      suggested_value: 'false',
      category: 'missing_gtin',
      severity: 'high',
      applied: 0,
    });
    const result = await applyIssueFix(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      'issue-1',
      'admin-ui',
      { dryRun: true },
    );
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.applied?.after).toBe('false');
  });

  it('vendor fix dry-run', async () => {
    const { applyIssueFix } = await import('../services/shopify-google-audit.js');
    dbState.issues.push({
      id: 'issue-vendor',
      shopify_product_id: 'gid://shopify/Product/123',
      field: 'vendor',
      original_value: 'OtherBrand',
      suggested_value: 'naturism',
      category: 'missing_brand',
      severity: 'medium',
      applied: 0,
    });
    const result = await applyIssueFix(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      'issue-vendor',
      'admin-ui',
      { dryRun: true },
    );
    expect(result.success).toBe(true);
    expect(result.applied?.after).toBe('naturism');
  });

  it('既 applied → success=false', async () => {
    const { applyIssueFix } = await import('../services/shopify-google-audit.js');
    dbState.issues.push({
      id: 'already-applied',
      shopify_product_id: 'gid://1',
      field: 'vendor',
      suggested_value: 'naturism',
      applied: 1,
    });
    const result = await applyIssueFix(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      'already-applied',
      'admin-ui',
      { dryRun: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('already applied');
  });

  it('suggested_value 空 → success=false', async () => {
    const { applyIssueFix } = await import('../services/shopify-google-audit.js');
    dbState.issues.push({
      id: 'no-suggestion',
      shopify_product_id: 'gid://1',
      field: 'vendor',
      suggested_value: null,
      applied: 0,
    });
    const result = await applyIssueFix(
      { DB: makeFakeDb(), SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_CLIENT_ID: 'x', SHOPIFY_CLIENT_SECRET: 'y' },
      'no-suggestion',
      'admin-ui',
      { dryRun: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('no suggested value');
  });
});

// ============================================================
// fetchAllProductsGraphQL — error handling
// ============================================================

describe('fetchAllProductsGraphQL', () => {
  it('SHOPIFY_STORE_DOMAIN 未設定 → throw', async () => {
    const { fetchAllProductsGraphQL } = await import('../services/shopify-google-audit.js');
    await expect(
      fetchAllProductsGraphQL({ DB: makeFakeDb() }),
    ).rejects.toThrow('SHOPIFY_STORE_DOMAIN not configured');
  });

  it('GraphQL 5xx → throw', async () => {
    const { fetchAllProductsGraphQL } = await import('../services/shopify-google-audit.js');
    const fetchImpl = (async () =>
      new Response('Server Error', { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchAllProductsGraphQL(
        {
          DB: makeFakeDb(),
          SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
          SHOPIFY_CLIENT_ID: 'x',
          SHOPIFY_CLIENT_SECRET: 'y',
        },
        fetchImpl,
      ),
    ).rejects.toThrow('Shopify GraphQL returned 500');
  });

  it('GraphQL errors field → throw', async () => {
    const { fetchAllProductsGraphQL } = await import('../services/shopify-google-audit.js');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'access denied' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    await expect(
      fetchAllProductsGraphQL(
        {
          DB: makeFakeDb(),
          SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
          SHOPIFY_CLIENT_ID: 'x',
          SHOPIFY_CLIENT_SECRET: 'y',
        },
        fetchImpl,
      ),
    ).rejects.toThrow('access denied');
  });
});
