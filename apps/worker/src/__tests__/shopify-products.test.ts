import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async () => null),
    getShopifyProducts: vi.fn(async () => []),
    getShopifyProductById: vi.fn(async () => null),
    getShopifyProductByShopifyId: vi.fn(async () => null),
    upsertShopifyProduct: vi.fn(async () => null),
    deleteShopifyProduct: vi.fn(async () => undefined),
    getProductsNotRecommendedTo: vi.fn(async () => []),
    recordProductRecommendation: vi.fn(async () => undefined),
    getLatestRiskLevel: vi.fn(async () => 'safe'),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async pushMessage() {}
    async multicast() {}
    async broadcast() {}
    pushTextMessage = vi.fn(async () => {});
  },
  flexMessage: vi.fn((altText: string, contents: unknown) => ({
    type: 'flex',
    altText,
    contents,
  })),
  flexCarousel: vi.fn((bubbles: unknown[]) => ({
    type: 'carousel',
    contents: bubbles,
  })),
  productCard: vi.fn((opts: unknown) => ({
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: [] },
    ...opts,
  })),
}));

vi.mock('../services/product-display.js', () => ({
  syncProductFromWebhook: vi.fn(async () => ({ id: 'p-1', shopify_product_id: '123' })),
  buildProductCarousel: vi.fn(() => ({
    type: 'flex',
    altText: '商品のご案内',
    contents: { type: 'carousel', contents: [] },
  })),
  sendProductRecommendations: vi.fn(async () => ({ sent: 3 })),
}));

import {
  getShopifyProducts,
  getShopifyProductById,
  getShopifyProductByShopifyId,
  upsertShopifyProduct,
  deleteShopifyProduct,
} from '@line-crm/db';
import { syncProductFromWebhook, buildProductCarousel, sendProductRecommendations } from '../services/product-display.js';
import { authMiddleware } from '../middleware/auth.js';
import { shopifyProducts } from '../routes/shopify-products.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-products-12345';

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(function (this: unknown) { return this; }),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: createMockDb(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
    SHOPIFY_STORE_DOMAIN: 'test-store.myshopify.com',
  };
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', shopifyProducts);
  return app;
}

function makeSampleProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    shopify_product_id: '12345',
    title: 'naturism サプリ',
    description: '体内から美しく',
    vendor: 'naturism',
    product_type: 'supplement',
    handle: 'naturism-supplement',
    status: 'active',
    image_url: 'https://cdn.shopify.com/image.jpg',
    price: '3980',
    compare_at_price: '4980',
    tags: 'beauty,health',
    variants_json: null,
    store_url: 'https://test-store.myshopify.com/products/naturism-supplement',
    created_at: '2026-04-05T10:00:00.000',
    updated_at: '2026-04-05T10:00:00.000',
    ...overrides,
  };
}

describe('Shopify Products Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  const mockedGetProducts = getShopifyProducts as ReturnType<typeof vi.fn>;
  const mockedGetProductById = getShopifyProductById as ReturnType<typeof vi.fn>;
  const mockedUpsertProduct = upsertShopifyProduct as ReturnType<typeof vi.fn>;
  const mockedDeleteProduct = deleteShopifyProduct as ReturnType<typeof vi.fn>;
  const mockedBuildCarousel = buildProductCarousel as ReturnType<typeof vi.fn>;
  const mockedSendRecommendations = sendProductRecommendations as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // ---------- Auth ----------

  describe('Authentication', () => {
    it('should return 401 without auth header', async () => {
      const res = await app.request('/api/shopify/products', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // ---------- GET /api/shopify/products ----------

  describe('GET /api/shopify/products', () => {
    it('should return empty list', async () => {
      mockedGetProducts.mockResolvedValueOnce([]);
      const res = await app.request('/api/shopify/products', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('should return products', async () => {
      mockedGetProducts.mockResolvedValueOnce([makeSampleProduct()]);
      const res = await app.request('/api/shopify/products', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ title: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].title).toBe('naturism サプリ');
    });
  });

  // ---------- GET /api/shopify/products/:id ----------

  describe('GET /api/shopify/products/:id', () => {
    it('should return 404 if not found', async () => {
      mockedGetProductById.mockResolvedValueOnce(null);
      const res = await app.request('/api/shopify/products/nonexistent', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);
    });

    it('should return product', async () => {
      mockedGetProductById.mockResolvedValueOnce(makeSampleProduct());
      const res = await app.request('/api/shopify/products/p-1', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { shopifyProductId: string; price: string } };
      expect(body.data.shopifyProductId).toBe('12345');
      expect(body.data.price).toBe('3980');
    });
  });

  // ---------- POST /api/shopify/products ----------

  describe('POST /api/shopify/products', () => {
    it('should create product', async () => {
      mockedUpsertProduct.mockResolvedValueOnce(makeSampleProduct());
      const res = await app.request('/api/shopify/products', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shopifyProductId: '12345',
          title: 'naturism サプリ',
          price: '3980',
        }),
      }, env);
      expect(res.status).toBe(201);
    });

    it('should return 400 if missing required fields', async () => {
      const res = await app.request('/api/shopify/products', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test' }),
      }, env);
      expect(res.status).toBe(400);
    });
  });

  // ---------- DELETE /api/shopify/products/:id ----------

  describe('DELETE /api/shopify/products/:id', () => {
    it('should delete product', async () => {
      mockedDeleteProduct.mockResolvedValueOnce(undefined);
      const res = await app.request('/api/shopify/products/p-1', {
        method: 'DELETE',
        headers: authHeaders(),
      }, env);
      expect(res.status).toBe(200);
    });
  });

  // ---------- POST /api/shopify/products/preview-carousel ----------

  describe('POST /api/shopify/products/preview-carousel', () => {
    it('should return carousel preview', async () => {
      mockedGetProducts.mockResolvedValueOnce([makeSampleProduct()]);
      const res = await app.request('/api/shopify/products/preview-carousel', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(200);
    });

    it('should return 404 when no products', async () => {
      mockedGetProducts.mockResolvedValueOnce([]);
      mockedBuildCarousel.mockReturnValueOnce(null);
      const res = await app.request('/api/shopify/products/preview-carousel', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, env);
      expect(res.status).toBe(404);
    });
  });

  // ---------- POST /api/shopify/products/send ----------

  describe('POST /api/shopify/products/send', () => {
    it('should send recommendations', async () => {
      mockedSendRecommendations.mockResolvedValueOnce({ sent: 3 });
      const res = await app.request('/api/shopify/products/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friendId: 'f-1',
          friendLineUserId: 'U1234',
        }),
      }, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { sent: number } };
      expect(body.data.sent).toBe(3);
    });

    it('should return 400 if missing friendId', async () => {
      const res = await app.request('/api/shopify/products/send', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ friendLineUserId: 'U1234' }),
      }, env);
      expect(res.status).toBe(400);
    });
  });

  // ---------- Serialization ----------

  describe('Serialization', () => {
    it('should use camelCase keys', async () => {
      mockedGetProductById.mockResolvedValueOnce(makeSampleProduct());
      const res = await app.request('/api/shopify/products/p-1', { headers: authHeaders() }, env);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('shopifyProductId');
      expect(body.data).toHaveProperty('imageUrl');
      expect(body.data).toHaveProperty('compareAtPrice');
      expect(body.data).not.toHaveProperty('shopify_product_id');
      expect(body.data).not.toHaveProperty('image_url');
    });
  });
});
