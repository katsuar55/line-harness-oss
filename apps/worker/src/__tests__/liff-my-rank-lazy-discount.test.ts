/**
 * Tests for lazy rank-discount issuance in the my-rank LIFF (Task#2).
 *
 * Verifies the wiring: when a member views their card and is eligible (non-regular rank)
 * but has no active discount, the issuer is invoked; it is skipped for regular (0%) ranks
 * and when an active discount already exists. The issuer is mocked (no Shopify/gate logic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';

const { mockIssue } = vi.hoisted(() => ({ mockIssue: vi.fn() }));

vi.mock('../services/rank-discount-issuer.js', () => ({
  issueRankDiscountForFriend: mockIssue,
}));

import { liffMyRank } from '../routes/liff-my-rank.js';

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
  variants_json: string;
}

function makeDb(
  trailingTotal: number,
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
          if (sql.includes('FROM friends')) {
            return { id: 'f1', line_user_id: 'U1', shopify_customer_id: '123', line_account_id: null } as unknown as T;
          }
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: trailingTotal } as unknown as T;
          }
          if (sql.includes('loyalty_rank_discounts') && sql.includes("status = 'active'")) {
            return (rankDiscount ?? null) as unknown as T | null;
          }
          if (sql.includes('loyalty_rank_snapshots')) {
            return null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes('FROM shopify_products')) {
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

function makeApp() {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    (c as { set: (k: string, v: unknown) => void }).set('liffUser', { lineUserId: 'U1', friendId: 'f1' });
    await next();
  });
  app.route('/', liffMyRank);
  return app;
}

async function callApi(db: D1Database, envOverrides: Record<string, string> = {}) {
  const res = await makeApp().request(
    '/api/liff/my-rank',
    undefined,
    { DB: db, RANK_DISCOUNT_ENABLED: 'true', ...envOverrides } as unknown as Env['Bindings'],
  );
  return { status: res.status, body: (await res.json()) as { success: boolean; data?: any } };
}

describe('my-rank LIFF — lazy rank discount issuance', () => {
  beforeEach(() => {
    mockIssue.mockReset();
    mockIssue.mockResolvedValue(null); // simulate gated-off / no-op by default
  });

  it('issues lazily for an eligible (silver) member with no active discount', async () => {
    const { status } = await callApi(makeDb(15000, null));
    expect(status).toBe(200);
    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(mockIssue.mock.calls[0][2]).toMatchObject({
      friendId: 'f1',
      rankId: 'silver',
      discountPercent: 4,
    });
  });

  it('does NOT issue for a regular (¥0) member', async () => {
    await callApi(makeDb(0, null));
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it('does NOT issue when an active discount already exists', async () => {
    const existing: RankDiscountRowLike = {
      id: 'd1', friend_id: 'f1', rank_id: 'silver', code: 'NLR-SILVER-OLD',
      shopify_discount_node_id: 'gid', discount_percent: 4, status: 'active',
      brand_id: null, issued_at: '2026-06-01T00:00:00+09:00', expires_at: null,
    };
    const { body } = await callApi(makeDb(15000, existing));
    expect(mockIssue).not.toHaveBeenCalled();
    expect(body.data.rankDiscount).toEqual({ discountPercent: 4 });
  });

  it('期限切れ active は「無い」扱い → lazy 再発行が発火 + rankDiscount null (PR-D 自己修復)', async () => {
    const expired: RankDiscountRowLike = {
      id: 'd2', friend_id: 'f1', rank_id: 'silver', code: 'NLR-SILVER-DEAD',
      shopify_discount_node_id: 'gid', discount_percent: 4, status: 'active',
      brand_id: null, issued_at: '2026-06-01T00:00:00+09:00',
      expires_at: '2026-07-16T00:00:00.000Z', // 過去 (Shopify 側は endsAt で自然死済み)
    };
    const { body } = await callApi(makeDb(15000, expired));
    expect(mockIssue).toHaveBeenCalledTimes(1); // 死んだコードを再発行する唯一の閲覧起点
    expect(body.data.rankDiscount).toBeNull(); // 死んだコードを permalink に出さない
    expect(body.data.discountApplyUrl).toBeNull();
  });
});

describe('my-rank LIFF — quickBuy の min¥2,000 誠実化 (PR-D)', () => {
  // B案 検証ゲート通過 (2026-08-16) で subscriptionRank は API から返す (出し分けの検証は
  //   liff-my-rank-subscription-rank.test.ts)。ランクコード (NLR-) は単発専用のまま・
  //   quickBuy は ¥2,000 以上の商品にだけコードを付ける。
  const active: RankDiscountRowLike = {
    id: 'd1', friend_id: 'f1', rank_id: 'silver', code: 'NLR-SILVER-QB1',
    shopify_discount_node_id: 'gid', discount_percent: 4, status: 'active',
    brand_id: null, issued_at: '2026-06-01T00:00:00+09:00', expires_at: null,
  };
  const products: ProductRowLike[] = [
    { title: '30日分', price: '2830', image_url: null, variants_json: '[{"id":111}]' },
    { title: '3日分', price: '430', image_url: null, variants_json: '[{"id":222}]' },
    // price null は Number(null)=0 で「¥2,000 未満」経路に落ちる。非数値文字列 (NaN) は
    // Number.isFinite ガードだけが守る別経路 — mutation M17 で SURVIVED した死角を固定する
    { title: '価格不明(null)', price: null, image_url: null, variants_json: '[{"id":333}]' },
    { title: '価格不明(非数値)', price: 'N/A', image_url: null, variants_json: '[{"id":444}]' },
  ];

  beforeEach(() => {
    mockIssue.mockReset();
    mockIssue.mockResolvedValue(null);
  });

  it('¥2,000 以上の商品だけ discounted=true + URL にコード付与', async () => {
    const { body } = await callApi(makeDb(15000, active, products));
    const qb = body.data.quickBuy as Array<{ title: string; url: string; discounted: boolean }>;
    expect(qb).toHaveLength(3); // QUICK_BUY_LIMIT=3 で 4 件目は切られる
    expect(qb[0].discounted).toBe(true);
    expect(qb[0].url).toContain('discount=NLR-SILVER-QB1');
    // ¥430: コードを付けても checkout で無言で外れる → 付けない + ラベルも出さない (景表法)
    expect(qb[1].discounted).toBe(false);
    expect(qb[1].url).not.toContain('discount=');
    // 価格不明 (null) は Number(null)=0 → ¥2,000 未満扱いで安全側 (コード無し)
    expect(qb[2].discounted).toBe(false);
    expect(qb[2].url).not.toContain('discount=');
  });

  it('非数値 price (NaN) も安全側 = コード無し (Number.isFinite ガードの専用検証)', async () => {
    // NaN 商品を先頭に置き、LIMIT に切られず必ず評価される並びで検証する
    const nanFirst: ProductRowLike[] = [products[3], products[0]];
    const { body } = await callApi(makeDb(15000, active, nanFirst));
    const qb = body.data.quickBuy as Array<{ title: string; url: string; discounted: boolean }>;
    expect(qb[0].discounted).toBe(false);
    expect(qb[0].url).not.toContain('discount=');
    expect(qb[1].discounted).toBe(true); // 同一応答内の対照 (コード自体は生きている)
  });

  it('コード未発行なら全行 discounted=false (従来どおり素の permalink)', async () => {
    const { body } = await callApi(makeDb(15000, null, products));
    const qb = body.data.quickBuy as Array<{ url: string; discounted: boolean }>;
    expect(qb.every((q) => !q.discounted)).toBe(true);
    expect(qb.every((q) => !q.url.includes('discount='))).toBe(true);
  });

  it('API 応答に subscriptionRank フィールドがある (B案 検証ゲート通過 2026-08-16 で解禁)', async () => {
    // 旧ガード「含めない」はゲート通過前の凍結。通過 + HB ランク公開済みで反転した。
    // 値の出し分けの検証は liff-my-rank-subscription-rank.test.ts が担う。
    const { body } = await callApi(makeDb(15000, active, products));
    expect('subscriptionRank' in body.data).toBe(true);
  });
});
