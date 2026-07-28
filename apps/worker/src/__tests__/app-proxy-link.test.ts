/**
 * Shopify App Proxy 連携 (services/app-proxy-link + routes/app-proxy) のテスト (2026-07-29)
 *
 * 検証対象:
 *   - gate: APP_PROXY_LINK_ENABLED != 'true' で 404 dormant (存在を露出しない)
 *   - 署名/shop/timestamp 検証 → 401 (route)
 *   - login_required / already_linked / ready の分岐と HTML 応答
 *   - token 発行: batch_id='app-proxy'・短命 TTL・再訪問で自分の旧 app-proxy トークンのみ掃除
 *     (= magic-link キャンペーンの 30日 link を巻き添えにしない)
 *
 * 署名はテスト側で node:crypto (= 実装と別系統) を使って生成する。
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  handleAppProxyLinkEntry,
  APP_PROXY_BATCH_ID,
  APP_PROXY_TOKEN_TTL_MIN,
} from '../services/app-proxy-link.js';
import { appProxy } from '../routes/app-proxy.js';

const SECRET = 'test-client-secret';
const SHOP = 'example.myshopify.com';
const LIFF_URL = 'https://liff.line.me/123-abc';

// ============================================================
// 最小 in-memory D1 fake (sub_link_tokens + friends)
// ============================================================

interface TokenRow {
  token: string;
  shopify_customer_id: string;
  batch_id: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}
interface Store {
  tokens: Map<string, TokenRow>;
  /** shopify_customer_id → friend 行 (存在すれば連携済み) */
  linkedCustomers: Set<string>;
}

function createDb(seed: Partial<Store> = {}): { db: D1Database; store: Store } {
  const store: Store = {
    tokens: seed.tokens ?? new Map(),
    linkedCustomers: seed.linkedCustomers ?? new Set(),
  };
  function exec(sqlRaw: string, args: unknown[], mode: 'first' | 'all' | 'run'): unknown {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('INSERT INTO sub_link_tokens')) {
      const [token, cid, batch, exp, created] = args as string[];
      store.tokens.set(token, {
        token,
        shopify_customer_id: cid,
        batch_id: batch,
        expires_at: exp,
        consumed_at: null,
        created_at: created,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM sub_link_tokens WHERE shopify_customer_id')) {
      const batchScoped = sql.includes('AND batch_id');
      const cid = args[0] as string;
      const batchId = batchScoped ? (args[1] as string) : null;
      let n = 0;
      for (const [k, v] of store.tokens) {
        if (v.shopify_customer_id === cid && v.consumed_at === null && (!batchScoped || v.batch_id === batchId)) {
          store.tokens.delete(k);
          n++;
        }
      }
      return { meta: { changes: n } };
    }
    if (sql.startsWith('SELECT * FROM friends WHERE shopify_customer_id')) {
      const cid = args[0] as string;
      return store.linkedCustomers.has(cid) ? { id: `f-${cid}`, shopify_customer_id: cid } : null;
    }
    return mode === 'all' ? { results: [] } : mode === 'first' ? null : { meta: { changes: 0 } };
  }
  const db = {
    prepare(sql: string) {
      const make = (args: unknown[]) => ({
        async first() {
          return exec(sql, args, 'first');
        },
        async all() {
          return exec(sql, args, 'all');
        },
        async run() {
          return exec(sql, args, 'run');
        },
      });
      return {
        bind(...args: unknown[]) {
          return make(args);
        },
        ...make([]),
      };
    },
  } as unknown as D1Database;
  return { db, store };
}

// ============================================================
// 署名付き query の生成 (node:crypto = 実装とは別系統)
// ============================================================

function signedQuery(params: Record<string, string>, secret = SECRET): string {
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('');
  const signature = createHmac('sha256', secret).update(message).digest('hex');
  const qs = new URLSearchParams(params);
  qs.set('signature', signature);
  return qs.toString();
}

function baseParams(over: Record<string, string> = {}): Record<string, string> {
  return {
    shop: SHOP,
    path_prefix: '/apps/line-link',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '',
    ...over,
  };
}

function envWith(db: D1Database, over: Record<string, string | undefined> = {}) {
  return {
    DB: db,
    LIFF_URL,
    APP_PROXY_LINK_ENABLED: 'true',
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_STORE_DOMAIN: SHOP,
    ...over,
  };
}

// ============================================================
// service
// ============================================================

describe('handleAppProxyLinkEntry', () => {
  it('gate off は disabled (署名検証すら行わない dormant)', async () => {
    const { db } = createDb();
    const r = await handleAppProxyLinkEntry(
      envWith(db, { APP_PROXY_LINK_ENABLED: undefined }),
      new URLSearchParams(signedQuery(baseParams())),
    );
    expect(r).toEqual({ ok: false, code: 'disabled' });
  });

  it('SHOPIFY_CLIENT_SECRET / LIFF_URL 欠落は misconfigured', async () => {
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams()));
    expect(await handleAppProxyLinkEntry(envWith(db, { SHOPIFY_CLIENT_SECRET: undefined }), q)).toEqual({
      ok: false,
      code: 'misconfigured',
    });
    expect(await handleAppProxyLinkEntry(envWith(db, { LIFF_URL: undefined }), q)).toEqual({
      ok: false,
      code: 'misconfigured',
    });
  });

  it('署名不正は unauthorized', async () => {
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams(), 'wrong-secret'));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: false, code: 'unauthorized', reason: 'bad_signature' });
  });

  it('shop 不一致は unauthorized (別ストアからの正規署名を拒否)', async () => {
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams({ shop: 'evil.myshopify.com' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: false, code: 'unauthorized', reason: 'shop_mismatch' });
  });

  it('未ログイン (logged_in_customer_id 空) は login_required', async () => {
    const { db, store } = createDb();
    const r = await handleAppProxyLinkEntry(envWith(db), new URLSearchParams(signedQuery(baseParams())));
    expect(r).toEqual({ ok: true, state: 'login_required' });
    expect(store.tokens.size).toBe(0); // token は発行しない
  });

  it('customer id が数値形式でない場合は unauthorized (深層防御)', async () => {
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: 'abc' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: false, code: 'unauthorized', reason: 'bad_customer_id' });
  });

  it('既連携 customer は already_linked (token 発行なし)', async () => {
    const { db, store } = createDb({ linkedCustomers: new Set(['777']) });
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: true, state: 'already_linked' });
    expect(store.tokens.size).toBe(0);
  });

  it('ready: 短命 token を batch_id=app-proxy で発行し LIFF_URL?slk= を返す', async () => {
    const { db, store } = createDb();
    const nowMs = Date.now();
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q, nowMs);
    expect(r.ok).toBe(true);
    if (!r.ok || r.state !== 'ready') throw new Error('expected ready');
    expect(r.redirectUrl.startsWith(`${LIFF_URL}?slk=`)).toBe(true);
    const token = r.redirectUrl.split('slk=')[1];
    const row = store.tokens.get(token);
    expect(row).toBeTruthy();
    expect(row?.batch_id).toBe(APP_PROXY_BATCH_ID);
    expect(row?.shopify_customer_id).toBe('777');
    // TTL: expires_at は +09:00 JST 固定幅 → Date parse できる。 10分 ±5秒
    const expMs = new Date(row!.expires_at).getTime();
    expect(Math.abs(expMs - (nowMs + APP_PROXY_TOKEN_TTL_MIN * 60_000))).toBeLessThan(5_000);
  });

  it('再訪問は自分の旧 app-proxy トークンのみ掃除し、 magic-link キャンペーンの token は残す', async () => {
    const { db, store } = createDb();
    const jstFuture = '2099-01-01T00:00:00.000+09:00';
    store.tokens.set('old-proxy', {
      token: 'old-proxy',
      shopify_customer_id: '777',
      batch_id: APP_PROXY_BATCH_ID,
      expires_at: jstFuture,
      consumed_at: null,
      created_at: jstFuture,
    });
    store.tokens.set('campaign', {
      token: 'campaign',
      shopify_customer_id: '777',
      batch_id: 'batch-2026-07',
      expires_at: jstFuture,
      consumed_at: null,
      created_at: jstFuture,
    });
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r.ok).toBe(true);
    expect(store.tokens.has('old-proxy')).toBe(false); // 旧 app-proxy token は無効化
    expect(store.tokens.has('campaign')).toBe(true); // キャンペーン token は無傷
    expect(store.tokens.size).toBe(2); // campaign + 新規発行分
  });
});

// ============================================================
// route (HTML 応答)
// ============================================================

async function routeGet(query: string, env: Record<string, unknown>) {
  return appProxy.request(`/proxy/line-link?${query}`, {}, env);
}

describe('GET /proxy/line-link', () => {
  it('gate off は 404 (dormant・本番既定)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db, { APP_PROXY_LINK_ENABLED: undefined }));
    expect(res.status).toBe(404);
  });

  it('署名不正は 401', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams(), 'wrong'), envWith(db));
    expect(res.status).toBe(401);
  });

  it('misconfigured は 503', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db, { SHOPIFY_CLIENT_SECRET: undefined }));
    expect(res.status).toBe(503);
  });

  it('未ログインはログイン誘導ページ (相対 /account/login + return_url)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/account/login?return_url=%2Fapps%2Fline-link');
    expect(html).toContain('ログイン');
  });

  it('既連携は連携済みページ', async () => {
    const { db } = createDb({ linkedCustomers: new Set(['777']) });
    const res = await routeGet(
      signedQuery(baseParams({ logged_in_customer_id: '777' })),
      envWith(db),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('すでに連携済み');
  });

  it('ready は meta refresh + ボタンで LIFF へ送り返す (inline JS なし)', async () => {
    const { db, store } = createDb();
    const res = await routeGet(
      signedQuery(baseParams({ logged_in_customer_id: '777' })),
      envWith(db),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = [...store.tokens.keys()][0];
    expect(html).toContain(`http-equiv="refresh"`);
    expect(html).toContain(`${LIFF_URL}?slk=${token}`);
    expect(html).not.toContain('<script'); // 静的 HTML のみ (#193 クラス回避)
  });
});
