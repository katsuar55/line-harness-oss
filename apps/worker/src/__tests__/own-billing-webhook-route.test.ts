/**
 * own-billing webhook route (WI-4 step 3) の統合テスト。
 *
 * 対象:
 *   - **実 authMiddleware を通す** (fake middleware だと skip-list 未登録の本番 401 を
 *     偽陰性で見逃す — 2026-07-23 /admin ダッシュボードで実際に起きた事故の再発防止)
 *   - skip は **POST 限定** ([[feedback_auth_skiplist_method_independent]]:
 *     path-only skip は GET/PUT/DELETE まで無認証で素通しさせる)
 *   - HMAC 不正 / secret 未設定は 401、正当な署名は 200
 *   - 未知 topic・壊れた body は 200 で飲む (Shopify の再送ストームを誘発しない)
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { ownBillingWebhook, OWN_BILLING_WEBHOOK_PATH } from '../routes/own-billing-webhook.js';
import { authMiddleware } from '../middleware/auth.js';

const SECRET = 'shpss_test_secret';

const executed: string[] = [];

function fakeDb() {
  executed.length = 0;
  return {
    prepare(sql: string) {
      executed.push(sql);
      const stmt = {
        // bind なしで first()/all() を呼ぶ経路にも応える。
        // all() が無いと readD1Gates が常に例外に落ち、gate 評価が一度も実行されない
        // (= gate 経路が無検証のまま green になる — 採点 R4/R6 test-integrity)。
        async first() {
          return null;
        },
        async all() {
          executed.push(sql);
          if (sql.includes('own_billing_quarantine')) return { results: [] };
          return { results: [] };
        },
        bind: () => ({
          async first() {
            // gate: own_billing_state (breaker) / own_sub_contracts (契約不在)
            if (sql.includes('own_billing_state')) return null;
            if (sql.includes('own_sub_contracts')) return null;
            return null;
          },
          async all() {
            if (sql.includes('own_billing_quarantine')) return { results: [] };
            return { results: [] };
          },
          async run() {
            return { meta: { changes: 0 } };
          },
        }),
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/', ownBillingWebhook as never);
  return app;
}

async function sign(secret: string, body: string): Promise<string> {
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

const baseEnv = () => ({ DB: fakeDb(), SHOPIFY_WEBHOOK_SECRET: SECRET, API_KEY: 'k' });

async function post(
  body: string,
  opts: { topic?: string; hmac?: string; env?: Record<string, unknown> } = {},
) {
  const app = makeApp();
  return app.request(
    OWN_BILLING_WEBHOOK_PATH,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': opts.topic ?? 'subscription_billing_attempts/success',
        ...(opts.hmac !== undefined ? { 'X-Shopify-Hmac-Sha256': opts.hmac } : {}),
      },
      body,
    },
    opts.env ?? baseEnv(),
  );
}

describe('認証 (authMiddleware skip-list)', () => {
  it('POST は Bearer 無しでも authMiddleware を素通りする (HMAC が代替認証)', async () => {
    const body = JSON.stringify({ admin_graphql_api_subscription_contract_id: 'gid://x' });
    const res = await post(body, { hmac: await sign(SECRET, body) });
    // 401 (= skip-list 未登録) ではないことが本質。処理結果は 200
    expect(res.status).toBe(200);
  });

  it('GET は skip されない (method 非依存 skip の穴を作らない)', async () => {
    const app = makeApp();
    const res = await app.request(OWN_BILLING_WEBHOOK_PATH, { method: 'GET' }, baseEnv());
    // authMiddleware が Bearer を要求 → 401 (route 自体は POST のみ定義)
    expect(res.status).toBe(401);
  });

  it('DELETE も skip されない', async () => {
    const app = makeApp();
    const res = await app.request(OWN_BILLING_WEBHOOK_PATH, { method: 'DELETE' }, baseEnv());
    expect(res.status).toBe(401);
  });
});

describe('HMAC 検証', () => {
  it('署名が不正なら 401', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post(body, { hmac: 'bm90LWEtc2lnbmF0dXJl' });
    expect(res.status).toBe(401);
  });

  it('署名ヘッダ欠落は 401', async () => {
    const res = await post(JSON.stringify({ id: 1 }));
    expect(res.status).toBe(401);
  });

  it('signing secret 未設定は 401 (誰でも課金状態を書ける穴を作らない)', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post(body, {
      hmac: await sign(SECRET, body),
      env: { DB: fakeDb(), API_KEY: 'k' },
    });
    expect(res.status).toBe(401);
  });

  it('body を 1 バイト改竄しただけで 401', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post(`${body} `, { hmac: await sign(SECRET, body) });
    expect(res.status).toBe(401);
  });

  it('SHOPIFY_CLIENT_SECRET だけでも検証できる', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post(body, {
      hmac: await sign('client-secret', body),
      env: { DB: fakeDb(), SHOPIFY_CLIENT_SECRET: 'client-secret', API_KEY: 'k' },
    });
    expect(res.status).toBe(200);
  });
});

describe('topic / body の扱い', () => {
  it('未知 topic は処理せず 200', async () => {
    const body = JSON.stringify({ id: 1 });
    const res = await post(body, { topic: 'orders/create', hmac: await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { outcome: 'unhandled_topic' } });
  });

  it('壊れた JSON は 200 で飲む (再送されても直らないため)', async () => {
    const body = '{not json';
    const res = await post(body, { hmac: await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { outcome: 'invalid_body' } });
  });

  it('gate 評価 (readD1Gates) が実際に実行される', async () => {
    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/1',
      admin_graphql_api_subscription_contract_id: 'gid://shopify/SubscriptionContract/1',
    });
    await post(body, { hmac: await sign(SECRET, body) });
    // §8 gate の 2 テーブルを両方読んでいること (fake が例外に落ちていない証拠)
    expect(executed.some((s) => s.includes('own_billing_state'))).toBe(true);
    expect(executed.some((s) => s.includes('own_billing_quarantine'))).toBe(true);
  });

  it('own 契約 0 件のときは Shopify adapter を組み立てない (無駄な往復をしない)', async () => {
    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/1',
      admin_graphql_api_subscription_contract_id: 'gid://shopify/SubscriptionContract/1',
    });
    await post(body, { hmac: await sign(SECRET, body) });
    // adapter を作るなら shopify_tokens を読む
    expect(executed.some((s) => s.includes('shopify_tokens'))).toBe(false);
  });

  it('own 契約が存在しない間は unknown_contract で無害に帰る', async () => {
    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/SubscriptionBillingAttempt/1',
      admin_graphql_api_subscription_contract_id: 'gid://shopify/SubscriptionContract/1',
    });
    const res = await post(body, { hmac: await sign(SECRET, body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { outcome: 'unknown_contract' } });
  });
});
