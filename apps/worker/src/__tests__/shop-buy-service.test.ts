/**
 * Shop タブ v2 のサービス層 (2026-08-23)。
 *
 * 設計の要は「一覧のラベル」と「購入 URL に載るコード」が**同じ 1 回の導出**から出ること。
 * したがって観測点は **URL の中身**にする — ラベル (discounted) だけを見ると
 * 「URL は素なのにラベルだけ出る」変異を素通りする。
 *
 * 述語は fake で再実装せず、実 SQLite (schema.sql) に対して実コードを走らせる。
 */
import { describe, it, expect } from 'vitest';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';
import {
  buildShopContext,
  buildShopGrid,
  resolveShopBuyPlan,
  needsSubscriptionAck,
  safeYen,
} from '../services/shop-buy.js';
import { activeSubscriptionProductIds } from '../services/reorder-guard.js';

const NOW = '2026-08-01T00:00:00.000Z';

function variants(id: string, price: string): string {
  return JSON.stringify([{ id: Number(id), admin_graphql_api_id: `gid://shopify/ProductVariant/${id}`, price }]);
}

function seedFriend(raw: SqliteDatabase, opts?: { customerId?: string | null }): void {
  raw.exec(
    `INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
     VALUES ('F1', 'U1', 'T', 1, '${NOW}', '${NOW}')`,
  );
  if (opts?.customerId) {
    raw.exec(`UPDATE friends SET shopify_customer_id='${opts.customerId}' WHERE id='F1'`);
  }
}

function seedProduct(
  raw: SqliteDatabase,
  o: {
    pid: string;
    title: string;
    price: string | null;
    variantId?: string | null;
    status?: string;
    handle?: string | null;
    image?: string | null;
  },
): void {
  const vj = o.variantId === null ? 'NULL' : `'${variants(o.variantId ?? o.pid + '01', o.price ?? '0')}'`;
  raw.exec(
    `INSERT INTO shopify_products (id, shopify_product_id, title, status, image_url, price, handle, variants_json, created_at, updated_at)
     VALUES ('p-${o.pid}', '${o.pid}', '${o.title}', '${o.status ?? 'active'}',
             ${o.image === null ? 'NULL' : `'${o.image ?? 'https://img/x.jpg'}'`},
             ${o.price === null ? 'NULL' : `'${o.price}'`},
             ${o.handle === null ? 'NULL' : `'${o.handle ?? o.title}'`}, ${vj}, '${NOW}', '${NOW}')`,
  );
}

function seedOrder(
  raw: SqliteDatabase,
  o: { id: string; lineItems: unknown; tags?: string | null; friendId?: string | null; customerId?: string | null; createdAt?: string },
): void {
  raw.exec(
    `INSERT INTO shopify_orders (id, shopify_order_id, friend_id, shopify_customer_id, tags, line_items, created_at, updated_at)
     VALUES ('${o.id}', '${o.id}', ${o.friendId === null ? 'NULL' : `'${o.friendId ?? 'F1'}'`},
             ${o.customerId === null ? 'NULL' : `'${o.customerId ?? 'SC1'}'`},
             ${o.tags === null || o.tags === undefined ? 'NULL' : `'${o.tags}'`},
             '${JSON.stringify(o.lineItems).replace(/'/g, "''")}', '${o.createdAt ?? NOW}', '${NOW}')`,
  );
}

function seedRankDiscount(raw: SqliteDatabase, code: string, percent: number): void {
  raw.exec(
    `INSERT INTO loyalty_rank_discounts (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at, created_at)
     VALUES ('rd1', 'F1', 'gold', '${code}', NULL, ${percent}, 'active', '${NOW}', NULL, '${NOW}')`,
  );
}

describe('safeYen — 「¥0」「NaN」を構造的に出さない', () => {
  it('出してよい値だけ通す', () => {
    expect(safeYen('2830')).toBe(2830);
    expect(safeYen(2830)).toBe(2830);
    for (const bad of [null, undefined, '', 'abc', '0', 0, '-1', -1, NaN, Infinity]) {
      expect(safeYen(bad), String(bad)).toBeNull();
    }
  });
});

describe('resolveShopBuyPlan — ラベルと URL は同じ導出から出る', () => {
  it('🚨 割引が乗る行は URL に ?discount= が入り、乗らない行には入らない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'Blue', price: '2830', variantId: '9001' }); // >= 2000
    seedProduct(raw, { pid: '200', title: 'Can', price: '430', variantId: '9002' });   // < 2000
    seedRankDiscount(raw, 'NLR-TEST', 6);

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const big = resolveShopBuyPlan(ctx, ctx.productIndex.get('100')!);
    const small = resolveShopBuyPlan(ctx, ctx.productIndex.get('200')!);

    // 観測点は URL の中身 (ラベルだけ見ると乖離を見逃す)
    expect(big.url).toContain('?discount=NLR-TEST');
    expect(big.discounted).toBe(true);
    expect(big.discountPercent).toBe(6);

    expect(small.url).not.toContain('discount');
    expect(small.discounted).toBe(false);
    expect(small.discountPercent).toBe(0);
  });

  it('割引コードが無ければ (未発行 / 0%) どの行にもラベルを出さない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'Blue', price: '2830', variantId: '9001' });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const plan = resolveShopBuyPlan(ctx, ctx.productIndex.get('100')!);

    expect(plan.url).not.toContain('discount');
    expect(plan.discounted).toBe(false);
    expect(plan.discountPercent).toBe(0);
  });

  it('0% の発行済みレコードはコード扱いしない (「0%OFF」を出さない)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'Blue', price: '2830', variantId: '9001' });
    seedRankDiscount(raw, 'NLR-ZERO', 0);

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.rankDiscountCode).toBeNull();
    expect(resolveShopBuyPlan(ctx, ctx.productIndex.get('100')!).discounted).toBe(false);
  });

  it('variants_json が無い商品は URL を作らず、ラベルも出さない (縮退)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '300', title: 'NoVariant', price: '2830', variantId: null });
    seedRankDiscount(raw, 'NLR-TEST', 6);

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const plan = resolveShopBuyPlan(ctx, ctx.productIndex.get('300')!);

    expect(plan.url).toBeNull();
    expect(plan.discounted).toBe(false);
  });

  it('価格が壊れている商品は金額を出さず、割引も乗せない', async () => {
    for (const price of [null, '0', 'abc']) {
      const raw = createSchemaDb();
      seedFriend(raw);
      seedProduct(raw, { pid: '400', title: 'Broken', price, variantId: '9004' });
      seedRankDiscount(raw, 'NLR-TEST', 6);

      const ctx = await buildShopContext(asD1(raw), 'F1');
      const plan = resolveShopBuyPlan(ctx, ctx.productIndex.get('400')!);
      expect(plan.priceJpy, String(price)).toBeNull();
      expect(plan.discounted, String(price)).toBe(false);
    }
  });

  it('顧客向けドメインを使う (Admin 用 myshopify を顧客に出さない)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'Blue', price: '2830', variantId: '9001' });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const plan = resolveShopBuyPlan(ctx, ctx.productIndex.get('100')!);
    expect(plan.url).toContain('naturism-diet.com');
    expect(plan.url).not.toContain('myshopify');
  });
});

describe('buildShopGrid — 過去購入を先頭に、足りない分は取扱商品で埋める', () => {
  it('🚨 過去購入がゼロでもグリッドは空にならない (本番の大多数がこの状態)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const grid = buildShopGrid(ctx);

    expect(grid.length).toBe(2);
    expect(grid.every((g) => g.purchased === false)).toBe(true);
  });

  it('過去購入商品が先頭に来て purchased=true が付く', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });
    // B だけ過去に購入
    seedOrder(raw, { id: 'o1', lineItems: [{ product_id: 200, variant_id: 9002, name: 'B' }] });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const grid = buildShopGrid(ctx);

    expect(grid[0].productId).toBe('200');
    expect(grid[0].purchased).toBe(true);
    expect(grid[1].productId).toBe('100');
    expect(grid[1].purchased).toBe(false);
  });

  it('product_id が無い明細でも variant_id から解決する', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });
    seedOrder(raw, { id: 'o1', lineItems: [{ variant_id: 9002, name: 'B' }] });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.purchasedOrder).toEqual(['200']);
  });

  it('どちらでも解決できない明細は捨てる (名前一致のあいまいマッチをしない)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });
    seedOrder(raw, { id: 'o1', lineItems: [{ name: 'B' }] });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.purchasedOrder).toEqual([]);
  });

  it('archived / draft の商品は「取扱中」枠に出さないが、過去購入なら出す', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedProduct(raw, { pid: '900', title: 'Old', price: '2830', variantId: '9009', status: 'archived' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });

    // 過去購入なし → archived は出ない
    const ctx1 = await buildShopContext(asD1(raw), 'F1');
    expect(buildShopGrid(ctx1).map((g) => g.productId)).toEqual(['100']);

    // 過去購入あり → archived でも出る (画像と価格が引ける)
    seedOrder(raw, { id: 'o1', lineItems: [{ product_id: 900, variant_id: 9009 }] });
    const ctx2 = await buildShopContext(asD1(raw), 'F1');
    const grid2 = buildShopGrid(ctx2);
    expect(grid2[0].productId).toBe('900');
    expect(grid2[0].purchased).toBe(true);
  });
});

describe('定期便バッジと ack — 「分からない」は安全側に倒す', () => {
  it('稼働契約の定期便注文に含まれる商品に active が付く', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}')`,
    );
    seedOrder(raw, {
      id: 'o1',
      tags: 'Subscription, subscription-id:C1',
      lineItems: [{ product_id: 100, variant_id: 9001, selling_plan_allocation: { selling_plan: { name: '30日' } } }],
    });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    const grid = buildShopGrid(ctx);
    expect(grid.find((g) => g.productId === '100')!.subscriptionState).toBe('active');
    expect(needsSubscriptionAck(ctx, '100')).toBe(true);
  });

  it('🚨 契約 ID は厳密照合 — subscription-id:C12 は C1 の契約に当たらない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}')`,
    );
    // 別契約 (C12) のタグ — LIKE '%subscription-id:%' には当たるが厳密照合では外れる
    seedOrder(raw, {
      id: 'o1',
      tags: 'subscription-id:C12',
      lineItems: [{ product_id: 100, variant_id: 9001, selling_plan_allocation: {} }],
    });

    const res = await activeSubscriptionProductIds(asD1(raw), 'F1');
    expect(res.hasActiveContract).toBe(true);
    expect([...res.productIds]).toEqual([]);
  });

  it('解約済み契約の注文はバッジにも ack にも効かない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, cancelled_at, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}', '${NOW}')`,
    );
    seedOrder(raw, { id: 'o1', tags: 'subscription-id:C1', lineItems: [{ product_id: 100 }] });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.subs.hasActiveContract).toBe(false);
    expect(buildShopGrid(ctx)[0].subscriptionState).toBeNull();
    expect(needsSubscriptionAck(ctx, '100')).toBe(false);
  });

  it('一時停止中は paused (「お休み中」表示の根拠)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, paused_at, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}', '${NOW}')`,
    );
    seedOrder(raw, { id: 'o1', tags: 'subscription-id:C1', lineItems: [{ product_id: 100 }] });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(buildShopGrid(ctx)[0].subscriptionState).toBe('paused');
  });

  it('🚨 稼働契約はあるが商品を特定できない (注文がローカルに無い) → 全商品で ack を要求する', async () => {
    // 本番では契約の約半数がこの状態 (last_order_at 欠落)。
    // 空集合を「定期便で何も買っていない」と解釈すると二重購入を素通しする
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}')`,
    );

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.subs.productIds.size).toBe(0);
    expect(ctx.subs.hasActiveContract).toBe(true);
    // バッジは出さない (嘘にならない) が、ack は要求する (安全側)
    expect(buildShopGrid(ctx)[0].subscriptionState).toBeNull();
    expect(needsSubscriptionAck(ctx, '100')).toBe(true);
  });

  it('🚨 契約が 2 本あり片方しか注文を辿れないとき、辿れた側の商品でも ack を要求する', async () => {
    // 採点ループ HIGH: 当初は productIds.size === 0 だけを「分からない」としていたため、
    // C1 (注文あり) + C2 (お届けが 60 日窓の外で注文が無い) を持つ顧客では
    // size > 0 になり **C2 の商品を無確認で単発購入できてしまった**。
    // 「size > 0 なら全部わかった」は不明の代理指標で、本命の不明分布がその窓の内側にある
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });
    for (const cid of ['C1', 'C2']) {
      raw.exec(
        `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
         VALUES ('${cid}', 'SC1', '${NOW}', '${NOW}')`,
      );
    }
    // C1 のお届け注文だけがローカルにある (C2 の注文は無い)
    seedOrder(raw, {
      id: 'o1',
      tags: 'subscription-id:C1',
      lineItems: [{ product_id: 100, variant_id: 9001, selling_plan_allocation: {} }],
    });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.subs.productIds.size).toBeGreaterThan(0);
    expect(ctx.subs.allContractsResolved, 'C2 を辿れていない').toBe(false);

    // 辿れた商品も、辿れていない商品も、どちらも確認を要求する
    expect(needsSubscriptionAck(ctx, '100')).toBe(true);
    expect(needsSubscriptionAck(ctx, '200'), 'C2 の商品を無確認で買わせない').toBe(true);
  });

  it('稼働契約を全部辿れたら、集合外の商品には ack を求めない (過剰に止めない)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });
    seedProduct(raw, { pid: '200', title: 'B', price: '2376', variantId: '9002' });
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
       VALUES ('C1', 'SC1', '${NOW}', '${NOW}')`,
    );
    seedOrder(raw, {
      id: 'o1',
      tags: 'subscription-id:C1',
      lineItems: [{ product_id: 100, variant_id: 9001, selling_plan_allocation: {} }],
    });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(ctx.subs.allContractsResolved).toBe(true);
    expect(needsSubscriptionAck(ctx, '100')).toBe(true);
    expect(needsSubscriptionAck(ctx, '200')).toBe(false);
  });

  it('契約が無い友だちには ack を求めない (退行なし)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: 'SC1' });
    seedProduct(raw, { pid: '100', title: 'A', price: '2830', variantId: '9001' });

    const ctx = await buildShopContext(asD1(raw), 'F1');
    expect(needsSubscriptionAck(ctx, '100')).toBe(false);
  });

  it('未連携 (shopify_customer_id なし) は契約判定に入らない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { customerId: null });
    const res = await activeSubscriptionProductIds(asD1(raw), 'F1');
    expect(res.hasActiveContract).toBe(false);
    expect(res.productIds.size).toBe(0);
  });
});
