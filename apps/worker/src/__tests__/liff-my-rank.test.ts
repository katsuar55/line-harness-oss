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
  shopifyCustomerId: string | null = null,
  // 連携特典 ¥300 (別台帳 line_link_coupons)。prepared には実行された SQL を記録し、
  // gate off で **台帳に触れていないこと** を観測点にできるようにする。
  linkOpts: {
    linkCoupon?: { coupon_code: string; discount_value: number; expires_at: string | null } | null;
    prepared?: string[];
  } = {},
): D1Database {
  return {
    prepare(sql: string) {
      if (linkOpts.prepared) linkOpts.prepared.push(sql);
      const stmt = {
        bind() {
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          // getFriendById (= Phase 2 linked フラグ用)
          if (sql.includes('FROM friends')) {
            return { id: 'f1', line_user_id: 'U1', shopify_customer_id: shopifyCustomerId } as unknown as T;
          }
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: trailingTotal } as unknown as T;
          }
          if (sql.includes('loyalty_rank_snapshots')) {
            return (snapshot ?? null) as unknown as T | null;
          }
          if (sql.includes('loyalty_rank_discounts') && sql.includes("status = 'active'")) {
            return (rankDiscount ?? null) as unknown as T | null;
          }
          if (sql.includes('line_link_coupons')) {
            return (linkOpts.linkCoupon ?? null) as unknown as T | null;
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

async function callApi(
  app: ReturnType<typeof makeApp>,
  db: D1Database,
  envExtra: Partial<Env['Bindings']> = {},
) {
  const res = await app.request('/api/liff/my-rank', undefined, { DB: db, ...envExtra } as unknown as Env['Bindings']);
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
      kind: null,
      code: 'LINE-ABC123', title: '友だちクーポン', discountType: 'fixed_amount', discountValue: 500, expiresAt: '2026-06-30T14:59:59Z',
    });
  });

  // ─── 連携特典 ¥300 (2026-08-28) ───
  // 🚨 ホームの第一候補 CTA はこの会員証へフルページ遷移する。ここに合流させないと
  //    OTP で連携した本人が特典を一度も見ないまま「保有クーポン 0枚」を見る。
  it('連携特典: gate on + 台帳あり → 先頭に合流する', async () => {
    const link = { coupon_code: 'NLINK-ABCD1234', discount_value: 300, expires_at: '2026-09-27T00:00:00.000Z' };
    const others = [
      { code: 'LINE-ABC123', title: '友だちクーポン', discount_type: 'fixed_amount', discount_value: 500, expires_at: null },
    ];
    const { body } = await callApi(
      makeApp(USER),
      makeDb(15000, null, others, null, [], null, { linkCoupon: link }),
      { LINK_REWARD_ENABLED: 'true' } as Partial<Env['Bindings']>,
    );
    expect(body.data.coupons).toHaveLength(2);
    expect(body.data.coupons[0]).toEqual({
      kind: 'link_reward',
      code: 'NLINK-ABCD1234',
      // 逐語照合: 最低購入金額を落とすと有利誤認になる (ランク割引で実際にやらかした型)
      title: '🔗 連携特典（¥2,000以上のご注文で）',
      discountType: 'fixed_amount',
      discountValue: 300,
      expiresAt: '2026-09-27T00:00:00.000Z',
    });
    expect(body.data.coupons[1].code).toBe('LINE-ABC123');
  });

  it('連携特典: 金額・期限は台帳の実値 (既定額にフォールバックしない)', async () => {
    const link = { coupon_code: 'NLINK-OLD', discount_value: 500, expires_at: null };
    const { body } = await callApi(
      makeApp(USER),
      makeDb(15000, null, [], null, [], null, { linkCoupon: link }),
      { LINK_REWARD_ENABLED: 'true' } as Partial<Env['Bindings']>,
    );
    expect(body.data.coupons[0].discountValue).toBe(500);
    expect(body.data.coupons[0].expiresAt).toBeNull();
  });

  it('🚨 連携特典: gate off では台帳に一度も触れない (kill switch)', async () => {
    const prepared: string[] = [];
    const link = { coupon_code: 'NLINK-ABCD1234', discount_value: 300, expires_at: null };
    const { body } = await callApi(
      makeApp(USER),
      makeDb(15000, null, [], null, [], null, { linkCoupon: link, prepared }),
    );
    expect(body.data.coupons).toEqual([]);
    // ステータスや配列長だけを見ると「読んでから捨てる」実装でも緑になる。
    // 観測点は **台帳を引いていないこと**。
    expect(prepared.some((q) => q.includes('line_link_coupons'))).toBe(false);
  });

  it('連携特典: gate on でも台帳が空なら何も足さない', async () => {
    const { body } = await callApi(
      makeApp(USER),
      makeDb(15000, null, [], null, [], null, { linkCoupon: null }),
      { LINK_REWARD_ENABLED: 'true' } as Partial<Env['Bindings']>,
    );
    expect(body.data.coupons).toEqual([]);
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

  // ─── 自前アカウント連携フラグ (Phase 2) ───
  it('linked: shopify_customer_id があれば true', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000, null, [], null, [], '6458785661181'));
    expect(body.data.linked).toBe(true);
  });

  it('linked: 未連携なら false', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000));
    expect(body.data.linked).toBe(false);
  });

  it('accountLinkEnabled: ACCOUNT_LINK_ENABLED=true で true', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000), { ACCOUNT_LINK_ENABLED: 'true' });
    expect(body.data.accountLinkEnabled).toBe(true);
  });

  it('accountLinkEnabled: 未設定なら false (= 本番 inert)', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000));
    expect(body.data.accountLinkEnabled).toBe(false);
  });

  // ─── backfill gate フラグ (2026-08-26): 「これまでの購入履歴を反映」と書けるか ───
  it('memberBackfillOn: MEMBER_BACKFILL_ENABLED=true で true', async () => {
    const { body } = await callApi(makeApp(USER), makeDb(15000), { MEMBER_BACKFILL_ENABLED: 'true' });
    expect(body.data.memberBackfillOn).toBe(true);
  });

  it.each([[undefined], ['false'], ['TRUE'], ['true\r']])(
    'memberBackfillOn: MEMBER_BACKFILL_ENABLED=%j なら false (過去反映を約束しない)',
    async (v) => {
      const { body } = await callApi(makeApp(USER), makeDb(15000), v === undefined ? {} : { MEMBER_BACKFILL_ENABLED: v });
      expect(body.data.memberBackfillOn).toBe(false);
    },
  );
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

  it('アカウント連携 UI (gated 2段フォーム) を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('id="link-card"');
    expect(r.body).toContain('function renderLink');
    expect(r.body).toContain('これまでのお買い物をランクに反映'); // 2026-07-07 顧客利益ベースの文言へ (採点R3 myrank_link)
    expect(r.body).toContain('/api/liff/link/request-code');
    expect(r.body).toContain('/api/liff/link/verify-code');
    // gated (2026-08-28 改訂): 3 分岐になった。
    //   linked=true            → 解除カード (受付 gate に依存しない = 受付停止中でも解除できる)
    //   !linked && gate on     → 連携フォーム
    //   !linked && gate off    → 非表示
    // 🚨 引用符のネストを書かない (CLAUDE.md: 単一バックスラッシュ+クォートは
    //    emit 時に潰れて文字列が途中終端する)。regex か二重引用符で受ける。
    expect(r.body).toContain('if(d.linked){ renderUnlink(card); return; }');
    expect(r.body).toMatch(/if\(!d\.accountLinkEnabled\)\{ card\.style\.display='none'; return; \}/);
    // 解除経路が顧客可視面に存在すること
    expect(r.body).toContain('function renderUnlink');
    expect(r.body).toContain('/api/liff/link/unlink');
  });

  it('アカウント連携 UI の a11y 対応 (aria-label / aria-live / enterkeyhint) を含む', async () => {
    const r = await fetchPage();
    expect(r.body).toContain('aria-label="ご注文時のメールアドレス"');
    expect(r.body).toContain('aria-label="6桁の確認コード"');
    expect(r.body).toContain('role="status" aria-live="polite"'); // #link-msg を SR に通知
    expect(r.body).toContain('enterkeyhint="send"');
    expect(r.body).toContain('enterkeyhint="done"');
    // refresh 失敗を無害化する hasRendered ガード
    expect(r.body).toContain('if (hasRendered) return;');
  });

  it('テンプレートリテラル汚染なし (未展開の ${ が body に残らない)', async () => {
    const r = await fetchPage();
    expect(r.body).not.toContain('${');
  });
});
