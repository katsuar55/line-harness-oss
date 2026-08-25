/**
 * 🚨 会員ランクの原資 (member_purchase_events) を **実際に届く webhook** で取り込む (2026-08-26)
 *
 * ## 何が壊れていたか (本番実測 2026-08-26)
 * - `member_purchase_events` は 21 行、**すべて `source='backfill'`** (2026-07-02/03 の 1 回きり)。
 *   webhook 由来は**開設以来 0 行**。
 * - 理由: 加算処理 `syncOrderToMember` は `orders/paid` の handler にしか繋がっておらず、
 *   その `orders/paid` は **webhookTopics に無い = 購読されていない**。
 *   一方 `orders/create` / `orders/updated` は購読済で、`shopify_orders` は 521 行・前日まで生きていた。
 * - つまり「購入してもランクが上がらない」状態が構造的に続いていた。
 *
 * ## 直し方
 * 実際に届く webhook (`orders/create` / `orders/updated`) の friend 解決済み地点で
 * `addPurchaseEvent` を直接呼ぶ。`coupon-redemption.ts` が同じ理由で orders/create を
 * 使っているのと同じ判断。
 *
 * ## ここで固定すること
 * 手 mock ではなく **実 SQLite + packages/db/schema.sql** で本物のコードを走らせる
 * (列名・UNIQUE・CAS が本番と一致していることを含めて測る)。
 *   ① 支払い済みの注文だけを記録する (未払いでランクを上げない)
 *   ② occurred_at は **Shopify の注文作成時刻** (now にすると古い注文が直近12ヶ月に誤計上される)
 *   ③ 同じ注文を何度受けても二重計上しない (create → updated の再配信が実際に起きる)
 *   ④ friend が解決できない注文でもランクは動かない
 *   ⑤ kill switch (MEMBER_INGEST_ENABLED='false') で完全に止まる
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));

import { shopify } from '../routes/shopify.js';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';
import type { Env } from '../index.js';

const FRIEND = 'F_BUYER';
const CUSTOMER = '9001';
const SECRET = 'test_hmac_secret';

async function hmac(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function app(): InstanceType<typeof Hono<Env>> {
  const a = new Hono<Env>();
  a.route('/', shopify);
  return a;
}

interface Ctx {
  db: SqliteDatabase;
  env: Record<string, unknown>;
}

function setup(extraEnv: Record<string, string> = {}): Ctx {
  const db = createSchemaDb();
  insertFriend(db, FRIEND);
  // 連携済み (= 注文から friend を確定できる唯一の経路。本番では 6,618 人中 10 人)
  db.exec(`UPDATE friends SET shopify_customer_id = '${CUSTOMER}' WHERE id = '${FRIEND}'`);
  return {
    db,
    env: {
      DB: asD1(db),
      SHOPIFY_WEBHOOK_SECRET: SECRET,
      LINE_CHANNEL_ACCESS_TOKEN: 'tok',
      ...extraEnv,
    },
  };
}

function orderBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 55501,
    order_number: 1001,
    total_price: '4800',
    currency: 'JPY',
    financial_status: 'paid',
    created_at: '2026-08-20T10:00:00+09:00',
    customer: { id: Number(CUSTOMER), email: 'buyer@example.com' },
    line_items: [],
    ...over,
  };
}

async function post(ctx: Ctx, topic: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  return app().request(
    '/api/integrations/shopify/webhook',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Hmac-Sha256': await hmac(SECRET, raw),
      },
      body: raw,
    },
    ctx.env as never,
  );
}

function events(db: SqliteDatabase): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM member_purchase_events ORDER BY created_at').all() as Array<
    Record<string, unknown>
  >;
}

/**
 * friend マッチングと取り込みは handler 内の **detached な async IIFE** (waitUntil 用) で走る。
 * テストには実行コンテキストが無いので `app.request` は完了を待たない。
 * 決着するまで tick を回す — 固定回数の sleep にすると遅い環境で落ちる。
 */
async function settle(db: SqliteDatabase, expected: number, tries = 60): Promise<Array<Record<string, unknown>>> {
  for (let i = 0; i < tries; i++) {
    const rows = events(db);
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 5));
  }
  return events(db);
}

describe('会員ランクの原資 — 実際に届く webhook から取り込む', () => {
  beforeEach(() => vi.clearAllMocks());

  it('🚨 支払い済みの注文を記録し、friend に applied する (これが 0 行のままだった)', async () => {
    const ctx = setup();
    const res = await post(ctx, 'orders/updated', orderBody());
    expect(res.status).toBe(200);

    const rows = await settle(ctx.db, 1);
    expect(rows.length, 'member_purchase_events に 1 行入ること').toBe(1);
    expect(rows[0].friend_id).toBe(FRIEND);
    expect(rows[0].amount_jpy).toBe(4800);
    expect(rows[0].source).toBe('webhook');
    expect(rows[0].applied_at, 'applied されないと trailing-12mo に算入されない').not.toBeNull();
  });

  it('🚨 occurred_at は Shopify の注文作成時刻 (now にすると古い注文がランクを膨張させる)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody({ created_at: '2025-01-15T09:00:00+09:00' }));
    const rows = await settle(ctx.db, 1);
    expect(rows[0].occurred_at).toBe('2025-01-15T09:00:00+09:00');
  });

  it('🚨 未払いの注文は記録しない (作成時点ではまだ入金していない)', async () => {
    for (const status of ['pending', 'authorized', 'refunded', 'voided', '']) {
      const ctx = setup();
      await post(ctx, 'orders/updated', orderBody({ financial_status: status }));
      await settle(ctx.db, 1, 8); // 入らないことの確認なので短く回して 0 を確かめる
      expect(events(ctx.db).length, 'financial_status=' + JSON.stringify(status)).toBe(0);
    }
  });

  it('未払い → 支払い済み の遷移で拾う (orders/updated が後から届く実運用の形)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody({ financial_status: 'pending' }));
    await settle(ctx.db, 1, 8);
    expect(events(ctx.db).length).toBe(0);
    await post(ctx, 'orders/updated', orderBody({ financial_status: 'paid' }));
    expect((await settle(ctx.db, 1)).length).toBe(1);
  });

  it('🚨 同じ注文を何度受けても二重計上しない (create → updated の再配信は実際に起きる)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody());
    await settle(ctx.db, 1);
    await post(ctx, 'orders/updated', orderBody());
    await settle(ctx.db, 2, 8);
    await post(ctx, 'orders/updated', orderBody({ total_price: '99999' }));
    await settle(ctx.db, 2, 8);
    const rows = events(ctx.db);
    expect(rows.length).toBe(1);
    expect(rows[0].amount_jpy, '後から届いた別金額で上書きしない').toBe(4800);

    const member = ctx.db
      .prepare(`SELECT total_purchase_jpy FROM members WHERE friend_id = '${FRIEND}'`)
      .get() as { total_purchase_jpy: number } | undefined;
    expect(member?.total_purchase_jpy, '累計も 1 回ぶんだけ').toBe(4800);
  });

  it('連携していない顧客の注文ではランクを動かさない (friend が引けない)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody({ customer: { id: 777777, email: 'x@example.com' } }));
    await settle(ctx.db, 1, 8);
    const rows = events(ctx.db);
    // friend が引けないので applied されない (行が残っても算入されない / 行自体できない)
    for (const r of rows) expect(r.applied_at).toBeNull();
  });

  it('🚨 kill switch — MEMBER_INGEST_ENABLED=false で 1 行も書かない', async () => {
    const ctx = setup({ MEMBER_INGEST_ENABLED: 'false' });
    await post(ctx, 'orders/updated', orderBody());
    await settle(ctx.db, 1, 8);
    expect(events(ctx.db).length).toBe(0);
  });

  it('既定は ON (未設定でも取り込む — off 既定だと壊れたまま出荷することになる)', async () => {
    const ctx = setup();
    delete (ctx.env as Record<string, unknown>).MEMBER_INGEST_ENABLED;
    await post(ctx, 'orders/updated', orderBody());
    expect((await settle(ctx.db, 1)).length).toBe(1);
  });
});

describe('会員ランクの原資 — 昇格 push を撃たない', () => {
  it('🚨 取り込みは LINE push を 1 通も送らない (別制度のランク名を顧客に送らない)', async () => {
    // members/membership_tiers (0/3/5/8% ・ ¥0/1万/3万/10万) は
    // ミニアプリが見せる NATURISM_RANK_DEFS (0/2/4/6/8% ・ ¥0/1/1.2万/2.4万/4.5万) とは別制度。
    // syncOrderToMember 経由だと checkAndNotifyForFriend が「◯◯会員ランクへ昇格しました」を撃つ。
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody({ total_price: '150000' }));
    expect((await settle(ctx.db, 1)).length).toBe(1);
    const lineCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes('api.line.me'));
    expect(lineCalls.length, 'LINE API を呼んではいけない').toBe(0);
    fetchSpy.mockRestore();
  });
});

describe('会員ランクの原資 — 返金・取消の反映 (Codex P1)', () => {
  it('🚨 全額返金でランクから外れる (返金済みの売上で 8% OFF が出続けない)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody());
    expect((await settle(ctx.db, 1)).length).toBe(1);

    await post(ctx, 'orders/updated', orderBody({ financial_status: 'refunded', current_total_price: '0' }));
    for (let i = 0; i < 40; i++) {
      const r = events(ctx.db)[0];
      if (r && r.applied_at === null) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const row = events(ctx.db)[0];
    // applied_at が NULL = trailing-12mo の集計 (applied_at IS NOT NULL) から外れる
    expect(row.applied_at, '返金後も applied のままだとランクが下がらない').toBeNull();
    expect(row.amount_jpy).toBe(0);

    const member = ctx.db
      .prepare(`SELECT total_purchase_jpy FROM members WHERE friend_id = '${FRIEND}'`)
      .get() as { total_purchase_jpy: number } | undefined;
    expect(member?.total_purchase_jpy, '累計からも引く').toBe(0);
  });

  it('一部返金は返金後の実額へ付け替える (current_total_price)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody());
    await settle(ctx.db, 1);

    await post(ctx, 'orders/updated', orderBody({ financial_status: 'partially_refunded', current_total_price: '1800' }));
    for (let i = 0; i < 40; i++) {
      if (events(ctx.db)[0].amount_jpy === 1800) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const row = events(ctx.db)[0];
    expect(row.amount_jpy).toBe(1800);
    expect(row.applied_at, '一部返金なら算入は続ける').not.toBeNull();

    const member = ctx.db
      .prepare(`SELECT total_purchase_jpy FROM members WHERE friend_id = '${FRIEND}'`)
      .get() as { total_purchase_jpy: number } | undefined;
    expect(member?.total_purchase_jpy).toBe(1800);
  });

  it('🚨 返金の再配信で二度引かない (webhook は実際に複数回届く)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody());
    await settle(ctx.db, 1);
    for (let i = 0; i < 3; i++) {
      await post(ctx, 'orders/updated', orderBody({ financial_status: 'partially_refunded', current_total_price: '1800' }));
      await new Promise((res) => setTimeout(res, 20));
    }
    const member = ctx.db
      .prepare(`SELECT total_purchase_jpy FROM members WHERE friend_id = '${FRIEND}'`)
      .get() as { total_purchase_jpy: number } | undefined;
    expect(member?.total_purchase_jpy, '3 回受けても 1 回ぶんだけ引く').toBe(1800);
    expect(events(ctx.db).length).toBe(1);
  });

  it('記録していない注文の返金では何も起きない (無関係な行を触らない)', async () => {
    const ctx = setup();
    await post(ctx, 'orders/updated', orderBody({ id: 88888, financial_status: 'refunded', current_total_price: '0' }));
    await settle(ctx.db, 1, 8);
    expect(events(ctx.db).length).toBe(0);
  });
});
