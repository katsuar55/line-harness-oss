/**
 * 🚨 紹介者報酬 (⑤) を **実スキーマ** で通す統合テスト (2026-08-25)
 *
 * なぜ必要か:
 *   `processReferralRewardOnPurchase` は「被紹介者が welcome クーポンを使って購入した」ときに
 *   紹介者へ ¥500 を発行する経路で、**本番で 1 度も実行されたことがない**
 *   (gate 未投入 + migration 068 未適用が 2026-08-25 まで続いたため。
 *    referral_rewards 0 行 / line_referral_coupons 0 行を実測)。
 *
 *   既存テスト (referral-reward.test.ts / coupon-redemption-ledgers.test.ts) は D1 を
 *   **手 mock** しており、SQL の列名・CHECK 制約・UNIQUE・FK を 1 つも検証していない。
 *   これは `GET /api/line-friend-coupons` が存在しない列 `c.created_at` を SELECT していて
 *   **本番で 3 ヶ月間ずっと 500 を返していた**のと同じ穴 (手 mock は架空の行を返すので
 *   スキーマの誤りが原理的に現れない)。
 *
 *   Katsu は LINE アカウントを 1 つしか持たないため、③〜⑤ の実機テストができない。
 *   ID トークン検証と実注文が要るこの経路の代わりに、**実 SQLite に packages/db/schema.sql を
 *   流して本物のコードを走らせる**ことで、本番初実行で落ちる型のバグを潰しておく。
 *
 * 本番スキーマとの一致は 2026-08-25 に実測で確認済み:
 *   line_referral_coupons の DDL / UNIQUE(reward_id) / CHECK(role,status) が
 *   issuer の INSERT と完全一致していること。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));

import { processReferralRewardOnPurchase } from '../services/referral-reward.js';
import { activateNextQueuedReferralCoupon } from '../services/referral-coupon-issuer.js';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import type { LineClient } from '@line-crm/line-sdk';

const REFERRER = 'F_REFERRER';
const REFERRED = 'F_REFERRED';
const REWARD_ID = 'rr-1';
const FIXED_NOW = Date.parse('2026-08-25T12:00:00.000Z');

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
  SHOPIFY_CLIENT_ID: 'i',
  SHOPIFY_CLIENT_SECRET: 's',
  REFERRAL_REWARD_ENABLED: 'true',
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

/** Shopify の discountCodeBasicCreate を成功で返す fetch (発行された code をそのまま返す) */
function okFetch() {
  return vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      variables?: { basicCodeDiscount?: { code?: string } };
    };
    const code = body.variables?.basicCodeDiscount?.code ?? 'NREF-R-XXXXXXXX';
    return new Response(
      JSON.stringify({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1', codeDiscount: { codes: { nodes: [{ code }] } } },
            userErrors: [],
          },
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

function fakeLineClient() {
  return {
    pushMessage: vi.fn(async () => ({ ok: true })),
    replyMessage: vi.fn(async () => ({ ok: true })),
  } as unknown as LineClient;
}

/** 紹介成立済み (pending) の状態を実スキーマに組み立てる */
function seed() {
  const raw = createSchemaDb();
  insertFriend(raw, REFERRER);
  insertFriend(raw, REFERRED);
  raw
    .prepare(
      `INSERT INTO referral_rewards (id, referrer_friend_id, referred_friend_id, status, created_at)
       VALUES (?, ?, ?, 'pending', '2026-08-20T00:00:00.000+09:00')`,
    )
    .run(REWARD_ID, REFERRER, REFERRED);
  return raw;
}

function rows<T = Record<string, unknown>>(raw: ReturnType<typeof createSchemaDb>, sql: string): T[] {
  return raw.prepare(sql).all() as T[];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', okFetch());
});

describe('紹介者報酬 (⑤) — 実スキーマで通す', () => {
  it('🚨 被紹介者の購入で、紹介者に実クーポンが 1 枚 INSERT される', async () => {
    const raw = seed();
    const line = fakeLineClient();

    const res = await processReferralRewardOnPurchase(asD1(raw), ENV, line, {
      referredFriendId: REFERRED,
      now: () => FIXED_NOW,
    });

    expect(res.pendingFound, 'pending の紹介成立を拾えている').toBe(1);
    expect(res.rewarded, '報酬が発行された').toBe(1);

    // 台帳に実際に行が入ること (列名・CHECK・FK が 1 つでも違えば実 SQLite が落ちる)
    const coupons = rows<{
      friend_id: string; reward_id: string; role: string; status: string;
      discount_value: number; discount_currency: string; coupon_code: string;
      shopify_discount_code_id: string | null; expires_at: string | null;
    }>(raw, 'SELECT * FROM line_referral_coupons');
    expect(coupons.length, '紹介者に 1 枚').toBe(1);
    expect(coupons[0].friend_id, '所有者は**紹介した側**').toBe(REFERRER);
    expect(coupons[0].reward_id).toBe(REWARD_ID);
    expect(coupons[0].role).toBe('referrer');
    expect(coupons[0].status).toBe('issued');
    expect(coupons[0].discount_value).toBe(500);
    expect(coupons[0].discount_currency).toBe('JPY');
    expect(coupons[0].coupon_code).toMatch(/^NREF-R-/);
    expect(coupons[0].shopify_discount_code_id).toBe('gid://shopify/DiscountCodeNode/1');
    expect(coupons[0].expires_at, '有効期限が入る').toBeTruthy();

    // 台帳が pending → rewarded へ遷移すること
    const rewards = rows<{ status: string; rewarded_at: string | null }>(
      raw,
      'SELECT status, rewarded_at FROM referral_rewards',
    );
    expect(rewards[0].status).toBe('rewarded');
    expect(rewards[0].rewarded_at).toBe(new Date(FIXED_NOW).toISOString());

    // 紹介者へ push が飛ぶこと
    expect((line.pushMessage as ReturnType<typeof vi.fn>).mock.calls.length, '紹介者への通知').toBe(1);
  });

  it('同じ購入が 2 回届いても 2 枚目は出ない (UNIQUE(reward_id) の冪等)', async () => {
    const raw = seed();
    const db = asD1(raw);
    const line = fakeLineClient();

    await processReferralRewardOnPurchase(db, ENV, line, { referredFriendId: REFERRED, now: () => FIXED_NOW });
    const second = await processReferralRewardOnPurchase(db, ENV, line, { referredFriendId: REFERRED, now: () => FIXED_NOW });

    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length, 'クーポンは 1 枚のまま').toBe(1);
    // 2 回目は pending が無いので何も起きない (flip 済み = terminal)
    expect(second.rewarded).toBe(0);
    expect((line.pushMessage as ReturnType<typeof vi.fn>).mock.calls.length, 'push も 1 回だけ').toBe(1);
  });

  it('gate off では台帳を 1 行も触らない (実費が出ない)', async () => {
    const raw = seed();
    const line = fakeLineClient();

    const res = await processReferralRewardOnPurchase(
      asD1(raw),
      { ...ENV, REFERRAL_REWARD_ENABLED: undefined },
      line,
      { referredFriendId: REFERRED, now: () => FIXED_NOW },
    );

    expect(res.rewarded).toBe(0);
    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length).toBe(0);
    expect(rows<{ status: string }>(raw, 'SELECT status FROM referral_rewards')[0].status).toBe('pending');
    expect((line.pushMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('紹介経由でない購入者 (pending 無し) では何も起きない', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, 'F_ORGANIC');
    const line = fakeLineClient();

    const res = await processReferralRewardOnPurchase(asD1(raw), ENV, line, {
      referredFriendId: 'F_ORGANIC',
      now: () => FIXED_NOW,
    });

    expect(res.pendingFound).toBe(0);
    expect(res.rewarded).toBe(0);
    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length).toBe(0);
  });

  it('🚨 Shopify 発行に失敗してもクーポンは失われない — queue に waiting で残る', async () => {
    // 設計 (順次活性化 R1): 発行はまず queue へ積み、その場で活性化を試みる。
    //   Shopify が落ちていて活性化できなくても **waiting のまま残る** ので義務は消えない。
    //   台帳には行を作らない (= 顧客に出せない幽霊コードを作らない)。
    const raw = seed();
    const line = fakeLineClient();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ code: 'X', message: 'boom' }] } } }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch,
    );

    await processReferralRewardOnPurchase(asD1(raw), ENV, line, {
      referredFriendId: REFERRED,
      now: () => FIXED_NOW,
    });

    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length, '台帳に幽霊行を作らない').toBe(0);
    const q = rows<{ status: string; friend_id: string; reward_id: string }>(
      raw,
      'SELECT status, friend_id, reward_id FROM line_referral_coupon_queue',
    );
    expect(q.length, 'queue に義務が残る').toBe(1);
    expect(q[0].status).toBe('waiting');
    expect(q[0].friend_id).toBe(REFERRER);
    expect(q[0].reward_id).toBe(REWARD_ID);
  });

  it('🚨 その waiting は Shopify 復旧後の活性化で実クーポンになる (義務が回収される)', async () => {
    // 活性化の起点は T1 (紹介クーポンの使用) / T2 (cron sweep) / T3 (紹介者がポータルを開く)。
    // ここでは活性化本体を直接呼び、waiting → 実クーポンへ変わることを実スキーマで確認する。
    const raw = seed();
    const db = asD1(raw);
    const line = fakeLineClient();

    // 1) Shopify 障害中に報酬が発生 → waiting
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ code: 'X', message: 'boom' }] } } }),
          { status: 200 },
        ),
      ) as unknown as typeof fetch,
    );
    await processReferralRewardOnPurchase(db, ENV, line, { referredFriendId: REFERRED, now: () => FIXED_NOW });
    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length).toBe(0);

    // 2) Shopify 復旧後に活性化 (= 紹介者がポータルを開いた等)
    vi.stubGlobal('fetch', okFetch());
    const activated = await activateNextQueuedReferralCoupon(db, ENV, { friendId: REFERRER });
    expect(activated, '活性化された').toBeTruthy();

    const coupons = rows<{ friend_id: string; reward_id: string; status: string; discount_value: number }>(
      raw,
      'SELECT friend_id, reward_id, status, discount_value FROM line_referral_coupons',
    );
    expect(coupons.length, '実クーポンが 1 枚できる').toBe(1);
    expect(coupons[0].friend_id).toBe(REFERRER);
    expect(coupons[0].reward_id).toBe(REWARD_ID);
    expect(coupons[0].discount_value).toBe(500);

    const q = rows<{ status: string }>(raw, 'SELECT status FROM line_referral_coupon_queue');
    expect(q[0].status, 'queue 行は活性化済みになる').not.toBe('waiting');
  });

  it('自己紹介のデータ不整合があっても発行しない (二重ガード)', async () => {
    const raw = createSchemaDb();
    insertFriend(raw, REFERRED);
    raw
      .prepare(
        `INSERT INTO referral_rewards (id, referrer_friend_id, referred_friend_id, status, created_at)
         VALUES (?, ?, ?, 'pending', '2026-08-20T00:00:00.000+09:00')`,
      )
      .run('rr-self', REFERRED, REFERRED);
    const line = fakeLineClient();

    const res = await processReferralRewardOnPurchase(asD1(raw), ENV, line, {
      referredFriendId: REFERRED,
      now: () => FIXED_NOW,
    });

    expect(res.rewarded).toBe(0);
    expect(rows(raw, 'SELECT id FROM line_referral_coupons').length).toBe(0);
  });
});
