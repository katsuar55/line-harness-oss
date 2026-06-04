/**
 * Tests for マイランク LIFF API (= 自社内製ロイヤリティ, 2026-06-01, PR4)
 *
 * `/api/liff/my-rank` の rank 解決 + レスポンス整形 + 認証を検証。
 * liffUser は middleware で注入 (= liffAuthMiddleware 相当)、 DB は trailing SUM + snapshot を mock。
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { liffMyRank } from '../routes/liff-my-rank.js';

interface SnapshotRowLike {
  id: string;
  friend_id: string;
  period: string;
  rank_id: string;
  trailing_12mo_jpy: number;
  prev_rank_id: string | null;
  direction: string;
  brand_id: string | null;
  evaluated_at: string;
  created_at: string;
}

interface CouponRowLike {
  code: string;
  title: string;
  discount_type: string;
  discount_value: number;
  expires_at: string | null;
}

interface RankDiscountRowLike {
  id: string;
  friend_id: string;
  rank_id: string;
  code: string;
  shopify_discount_node_id: string | null;
  discount_percent: number;
  status: string;
  brand_id: string | null;
  issued_at: string;
  expires_at: string | null;
}

interface ProductRowLike {
  title: string;
  price: string | null;
  image_url: string | null;
  variants_json: string | null;
}

function makeDb(
  trailingTotal: number,
  snapshot: SnapshotRowLike | null = null,
  coupons: CouponRowLike[] = [],
  rankDiscount: RankDiscountRowLike | null = null,
  products: ProductRowLike[] = [],
): D1Database {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: trailingTotal } as unknown as T;
          }
          if (sql.includes('loyalty_rank_snapshots')) {
            return (snapshot ?? null) as unknown as T | null;
          }
          if (sql.includes('loyalty_rank_discounts') && sql.includes("status = 'active'")) {
            return (rankDiscount ?? null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          // getCouponAssignmentsByFriend は shopify_coupon_assignments を all() で読む
          if (sql.includes('shopify_coupon_assignments')) {
            return { results: coupons as unknown as T[], success: true };
          }
          // getShopifyProducts は shopify_products を all() で読む
          if (sql.includes('shopify_products')) {
            return { results: products as unknown as T[], success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeApp(liffUser: { lineUserId: string; friendId: string } | null) {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    if (liffUser !== null) {
      (c as { set: (k: string, v: unknown) => void }).set('liffUser', liffUser);
    }
    await next();
  });
  app.route('/', liffMyRank);
  return app;
}

const USER = { lineUserId: 'U1', friendId: 'f1' };

async function callApi(app: ReturnType<typeof makeApp>, db: D1Database) {
  const res = await app.request('/api/liff/my-rank', undefined, { DB: db } as unknown as Env['Bindings']);
  return { status: res.status, body: (await res.json()) as { success: boolean; error?: string; data?: any } };
}

describe('GET /api/liff/my-rank', () => {
  it('silver (¥15,000): rank + 次ランク進捗を返す', async () => {
    const { status, body } = await callApi(makeApp(USER), makeDb(15000));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.rank.id).toBe('silver');
    expect(body.data.rank.discountPercent).toBe(4);
    expect(body.data.rank.badgeEmoji).toBe('🥈');
    expect(body.data.trailing12moJpy).toBe(15000);
    expect(body.data.next.id).toBe('gold');
    expect(body.data.next.remainingJpy).toBe(9000);
    expect(body.data.official).toBeNull();
  });

  it('regular (¥0): 0% + 次=bronze + progressRatio 0', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(0));
    expect(body.data.rank.id).toBe('regular');
    expect(body.data.rank.discountPercent).toBe(0);
    expect(body.data.next.id).toBe('bronze');
    expect(body.data.next.remainingJpy).toBe(1);
    expect(body.data.progressRatio).toBe(0);
  });

  it('¥1 境界: bronze (2%)', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(1));
    expect(body.data.rank.id).toBe('bronze');
    expect(body.data.rank.discountPercent).toBe(2);
  });

  it('platinum (¥50,000): 8% + next=null (最高ランク)', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(50000));
    expect(body.data.rank.id).toBe('platinum');
    expect(body.data.rank.discountPercent).toBe(8);
    expect(body.data.next).toBeNull();
    expect(body.data.progressRatio).toBe(1);
  });

  it('snapshot あり → official に rank/period/direction を返す', async () => {
    const snap: SnapshotRowLike = {
      id: 's1', friend_id: 'f1', period: '2026-06', rank_id: 'gold', trailing_12mo_jpy: 30000,
      prev_rank_id: 'silver', direction: 'up', brand_id: null,
      evaluated_at: '2026-06-01T09:05:00.000+09:00', created_at: '2026-06-01T09:05:00.000+09:00',
    };
    const { body } = await callApi(makeApp(USER), makeDb(30000, snap));
    expect(body.data.official).toEqual({ rankId: 'gold', period: '2026-06', direction: 'up' });
  });

  it('ladder: 全ランク (regular〜platinum) を defs 由来で返す', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000));
    expect(Array.isArray(body.data.ladder)).toBe(true);
    expect(body.data.ladder.map((r: any) => r.id)).toEqual(['regular', 'bronze', 'silver', 'gold', 'platinum']);
    const platinum = body.data.ladder.find((r: any) => r.id === 'platinum');
    expect(platinum.discountPercent).toBe(8);
    expect(platinum.minTrailing12moJpy).toBe(45000);
  });

  it('coupons: 未使用クーポンを code/title/割引/期限にマップ', async () => {
    const coupons = [
      { code: 'LINE-ABC123', title: '友だちクーポン', discount_type: 'fixed_amount', discount_value: 500, expires_at: '2026-06-30T14:59:59Z' },
    ];
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, coupons));
    expect(body.data.coupons).toHaveLength(1);
    expect(body.data.coupons[0]).toEqual({
      code: 'LINE-ABC123', title: '友だちクーポン', discountType: 'fixed_amount', discountValue: 500, expiresAt: '2026-06-30T14:59:59Z',
    });
  });

  it('coupons: 無い場合は空配列', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000));
    expect(body.data.coupons).toEqual([]);
  });

  const RANK_DISCOUNT: RankDiscountRowLike = {
    id: 'rd1',
    friend_id: 'f1',
    rank_id: 'silver',
    code: 'NLR-SILVER-ABCD2345',
    shopify_discount_node_id: 'gid://x/1',
    discount_percent: 4,
    status: 'active',
    brand_id: null,
    issued_at: '2026-06-04T00:00:00Z',
    expires_at: null,
  };

  it('rankDiscount: 発行済みなら discountPercent + discountApplyUrl', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, [], RANK_DISCOUNT));
    expect(body.data.rankDiscount).toEqual({ discountPercent: 4 });
    expect(body.data.discountApplyUrl).toBe('https://naturism-diet.com/discount/NLR-SILVER-ABCD2345');
    // code 自体は JSON に直接露出しない (= URL 経由のみ)
    expect(JSON.stringify(body.data.rankDiscount)).not.toContain('NLR-SILVER-ABCD2345');
  });

  it('rankDiscount: 未発行なら null + discountApplyUrl null', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000));
    expect(body.data.rankDiscount).toBeNull();
    expect(body.data.discountApplyUrl).toBeNull();
  });

  it('quickBuy: active 商品の先頭 variant で cart permalink (割引コード付与)', async () => {
    const products: ProductRowLike[] = [
      {
        title: 'KOSO 30日分',
        price: '2830',
        image_url: null,
        variants_json:
          '[{"id":42884926636285,"admin_graphql_api_id":"gid://shopify/ProductVariant/42884926636285"}]',
      },
    ];
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, [], RANK_DISCOUNT, products));
    expect(body.data.quickBuy).toHaveLength(1);
    expect(body.data.quickBuy[0].title).toBe('KOSO 30日分');
    expect(body.data.quickBuy[0].url).toBe(
      'https://naturism-diet.com/cart/42884926636285:1?discount=NLR-SILVER-ABCD2345',
    );
  });

  it('quickBuy: コード未発行でも cart permalink (割引なし) を返す', async () => {
    const products: ProductRowLike[] = [
      { title: 'KOSO 3日分', price: '430', image_url: null, variants_json: '[{"id":42885035819261}]' },
    ];
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, [], null, products));
    expect(body.data.quickBuy).toHaveLength(1);
    expect(body.data.quickBuy[0].url).toBe('https://naturism-diet.com/cart/42885035819261:1');
  });

  it('quickBuy: variants_json 不正/欠損の商品はスキップ', async () => {
    const products: ProductRowLike[] = [
      { title: 'no-variant', price: '100', image_url: null, variants_json: null },
      { title: 'bad-json', price: '100', image_url: null, variants_json: 'not-json' },
    ];
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, [], null, products));
    expect(body.data.quickBuy).toEqual([]);
  });

  it('liffUser 未設定 → 401', async () => {
    const { status, body } = await callApi(makeApp(null), makeDb(15000));
    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });
});

describe('GET /liff/my-rank (会員証ページ HTML)', () => {
  const env = {
    LIFF_URL: 'https://liff.line.me/2000000000-abcd1234',
    WORKER_URL: 'https://example.workers.dev',
    // Admin/API 用の myshopify ドメイン。CTA はこれを使わず公式ストアフロントを指すべき。
    SHOPIFY_STORE_DOMAIN: 'xn-0ckn0a9fxa4a.myshopify.com',
  };
  async function fetchPage(path = '/liff/my-rank'): Promise<{ status: number; body: string }> {
    const res = await liffMyRank.request(path, {}, env as unknown as Record<string, unknown>);
    return { status: res.status, body: await res.text() };
  }

  it('200 + LIFF SDK + LIFF_ID 注入', async () => {
    const r = await fetchPage();
    expect(r.status).toBe(200);
    expect(r.body).toContain("const LIFF_ID = '2000000000-abcd1234'");
    expect(r.body).toMatch(/static\.line-scdn\.net\/liff\/edge\/2\/sdk\.js/);
  });

  it('末尾スラッシュも 200', async () => {
    expect((await fetchPage('/liff/my-rank/')).status).toBe(200);
  });

  it('英語ランク名マップ (SILVER / PLATINUM 等) を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain("silver:'SILVER'");
    expect(r.body).toContain("platinum:'PLATINUM'");
  });

  it('メダル背景を radial mask で透明化する CSS を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('-webkit-mask-image:radial-gradient');
    expect(r.body).toContain('mask-image:radial-gradient');
  });

  it('新要素 (次回判定日 / 保有クーポン / 会員ランクについて) を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('次回の会員ランク判定日');
    expect(r.body).toContain('保有クーポン');
    expect(r.body).toContain('会員ランクについて');
  });

  it('おトクにお買い物セクション (3タップ購入) を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('おトクにお買い物');
    expect(r.body).toContain('function renderShop');
    expect(r.body).toContain('id="shop-card"');
    // DEMO の quickBuy / discountApplyUrl
    expect(r.body).toContain('KOSO in naturism');
    expect(r.body).toContain('/discount/NLR-SILVER-DEMO2345');
    expect(r.body).toContain('/cart/42884926636285:1');
  });

  it('店舗 CTA は公式ストアフロント naturism-diet.com を指す (Admin ドメインを使わない)', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('https://naturism-diet.com');
    expect(r.body).not.toContain('myshopify.com');
  });

  it('テンプレートリテラル汚染なし (未展開の ${ が body に残らない)', async () => {
    const r = await fetchPage();
    expect(r.body).not.toContain('${');
  });
});
