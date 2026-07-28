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
import { previewSubLinkToken, redeemSubLinkToken } from '../services/sub-link.js';
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
  /** local shopify_customers に行がある customer (無い顧客は sync_pending になる) */
  knownCustomers: Set<string>;
  /** customer ごとの email (null / 不正形式は hint を出せないので sync_pending) */
  customerEmails: Map<string, string | null>;
}

function createDb(seed: Partial<Store> = {}): { db: D1Database; store: Store } {
  const store: Store = {
    tokens: seed.tokens ?? new Map(),
    linkedCustomers: seed.linkedCustomers ?? new Set(),
    // 既定で '777' は同期済み (= テストの主対象)。 未同期経路は明示的に空集合を渡す
    knownCustomers: seed.knownCustomers ?? new Set(['777']),
    customerEmails: seed.customerEmails ?? new Map([['777', 'hanako@example.com']]),
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
    if (sql.startsWith('SELECT email FROM shopify_customers')) {
      const cid = args[0] as string;
      if (!store.knownCustomers.has(cid)) return null;
      return { email: store.customerEmails.has(cid) ? store.customerEmails.get(cid) : 'hanako@example.com' };
    }
    if (sql.startsWith('SELECT token FROM sub_link_tokens')) {
      const [cid, batch, now] = args as string[];
      for (const v of store.tokens.values()) {
        if (v.shopify_customer_id === cid && v.batch_id === batch && v.consumed_at === null && v.expires_at > now) return { token: v.token };
      }
      return null;
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

/** friends 行を持つ完全版 fake (= 発行 → redeem の跨サービス統合テスト用)。 */
function createIntegrationDb(): {
  db: D1Database;
  tokens: Map<string, TokenRow>;
  friends: Map<string, { id: string; shopify_customer_id: string | null }>;
  customers: Map<string, { shopify_customer_id: string; tags: string | null; email: string | null; friend_id: string | null }>;
} {
  const tokens = new Map<string, TokenRow>();
  const friends = new Map<string, { id: string; shopify_customer_id: string | null }>();
  const customers = new Map<
    string,
    { shopify_customer_id: string; tags: string | null; email: string | null; friend_id: string | null }
  >();

  function exec(sqlRaw: string, args: unknown[], mode: 'first' | 'all' | 'run'): unknown {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('INSERT INTO sub_link_tokens')) {
      const [token, cid, batch, exp, created] = args as string[];
      tokens.set(token, {
        token,
        shopify_customer_id: cid,
        batch_id: batch,
        expires_at: exp,
        consumed_at: null,
        created_at: created,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('SELECT * FROM sub_link_tokens WHERE token')) {
      return tokens.get(args[0] as string) ?? null;
    }
    if (sql.startsWith('UPDATE sub_link_tokens SET consumed_at = ?')) {
      const [now, , fid, token] = args as string[];
      const row = tokens.get(token);
      if (row && row.consumed_at === null) {
        row.consumed_at = now;
        (row as TokenRow & { consumed_friend_id?: string }).consumed_friend_id = fid;
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('DELETE FROM sub_link_tokens WHERE shopify_customer_id')) {
      const batchScoped = sql.includes('AND batch_id');
      const cid = args[0] as string;
      const batchId = batchScoped ? (args[1] as string) : null;
      let n = 0;
      for (const [k, v] of tokens) {
        if (v.shopify_customer_id === cid && v.consumed_at === null && (!batchScoped || v.batch_id === batchId)) {
          tokens.delete(k);
          n++;
        }
      }
      return { meta: { changes: n } };
    }
    if (sql.startsWith('SELECT email FROM shopify_customers')) {
      const c = customers.get(args[0] as string);
      return c ? { email: c.email } : null;
    }
    if (sql.startsWith('SELECT token FROM sub_link_tokens')) {
      const [cid, batch, now] = args as string[];
      for (const v of tokens.values()) {
        if (v.shopify_customer_id === cid && v.batch_id === batch && v.consumed_at === null && v.expires_at > now) return { token: v.token };
      }
      return null;
    }
    if (sql.startsWith('SELECT * FROM friends WHERE shopify_customer_id')) {
      const cid = args[0] as string;
      for (const f of friends.values()) if (f.shopify_customer_id === cid) return f;
      return null;
    }
    if (sql.startsWith('SELECT * FROM friends WHERE id = ?')) {
      return friends.get(args[0] as string) ?? null;
    }
    if (sql.startsWith('UPDATE friends SET shopify_customer_id = ?')) {
      const [cid, , fid] = args as string[];
      const f = friends.get(fid);
      if (!f || f.shopify_customer_id !== null) return { meta: { changes: 0 } };
      f.shopify_customer_id = cid;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE shopify_customers SET friend_id')) {
      const [fid, , cid] = args as string[];
      const c = customers.get(cid);
      if (c) c.friend_id = fid;
      return { meta: { changes: c ? 1 : 0 } };
    }
    if (sql.startsWith('UPDATE shopify_orders SET friend_id')) {
      return { meta: { changes: 0 } };
    }
    if (sql.startsWith('SELECT tags, email FROM shopify_customers')) {
      const c = customers.get(args[0] as string);
      return c ? { tags: c.tags, email: c.email } : null;
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
  return { db, tokens, friends, customers };
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

describe('セキュリティ定数の絶対値', () => {
  it('token TTL は 15 分 (連携 capability の寿命。相対 assert だけでは伸ばせてしまう)', () => {
    expect(APP_PROXY_TOKEN_TTL_MIN).toBe(15);
  });
});

describe('handleAppProxyLinkEntry', () => {
  it('gate off は disabled — 署名も設定も見ない (判定順序を固定)', async () => {
    // 署名不正 + secret 欠落を同時に与える。 gate 判定を後段に動かす退行が入ると
    // bad_signature か misconfigured になるので、この組合せだけが順序を識別できる。
    const { db } = createDb();
    const r = await handleAppProxyLinkEntry(
      envWith(db, { APP_PROXY_LINK_ENABLED: undefined, SHOPIFY_CLIENT_SECRET: undefined }),
      new URLSearchParams(signedQuery(baseParams(), 'wrong-secret')),
    );
    expect(r).toEqual({ ok: false, code: 'disabled' });
  });

  it.each([
    ['true', true],
    ['TRUE', false],
    ['false', false],
    ['1', false],
    ['on', false],
    ['true\r', false], // wrangler secret の CRLF 事故 (既知の罠)
    ['', false],
    [undefined, false],
  ])('gate 値 %s の有効判定は %s (=== \'true\' 厳密一致)', async (value, enabled) => {
    // `!== ''` 等に緩めると、運用者が APP_PROXY_LINK_ENABLED=false を投入したときに
    // 「無効化したつもりで全面 live 化」する (R2 採点 MED)。
    const { db } = createDb();
    const r = await handleAppProxyLinkEntry(
      envWith(db, { APP_PROXY_LINK_ENABLED: value }),
      new URLSearchParams(signedQuery(baseParams())),
    );
    if (enabled) {
      expect(r).toEqual({ ok: true, state: 'login_required' });
    } else {
      expect(r).toEqual({ ok: false, code: 'disabled' });
    }
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
    // 🚨 形式そのものを固定する: 消費側 (sub-link) の失効判定は expires_at と jstNow() の
    // **文字列辞書順比較**。 toISOString() の 'Z' 形式に退行すると +09:00 形式より約9時間
    // 過去に並び、発行直後の token が全件 expired になる (R1 採点 HIGH: epoch 比較だけだと素通り)。
    expect(row!.expires_at).toMatch(/\+09:00$/);
    const expMs = new Date(row!.expires_at).getTime();
    expect(Math.abs(expMs - (nowMs + APP_PROXY_TOKEN_TTL_MIN * 60_000))).toBeLessThan(5_000);
  });

  it('SHOPIFY_STORE_DOMAIN 未設定は misconfigured (無言 fail-open にしない)', async () => {
    // App Proxy 署名は app の client secret で計算されるので、同一 app を別ストアに入れると
    // そちらからの転送も署名を通る。未設定時に検査を skip すると、別ストアの customer id が
    // 同 id の当ストア顧客として紐付き、別人の購買履歴が LINE に開示される (R2 採点 MED)。
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams({ shop: 'whatever.myshopify.com' })));
    const r = await handleAppProxyLinkEntry(envWith(db, { SHOPIFY_STORE_DOMAIN: undefined }), q);
    expect(r).toEqual({ ok: false, code: 'misconfigured' });
  });

  it('email が無い / マスクできない顧客も sync_pending (確認材料を出せないまま同意させない)', async () => {
    // 行の存在だけを見ると、email を空にした顧客が「連携先」表示と警告文を任意に無効化できる。
    const { db, store } = createDb();
    store.customerEmails.set('777', null);
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    expect(await handleAppProxyLinkEntry(envWith(db), q)).toEqual({ ok: true, state: 'sync_pending' });

    store.customerEmails.set('777', 'not-an-email');
    expect(await handleAppProxyLinkEntry(envWith(db), q)).toEqual({ ok: true, state: 'sync_pending' });
    expect(store.tokens.size).toBe(0);
  });

  it('残り時間が僅かな token は再利用しない (戻った直後に期限切れへ落とさない)', async () => {
    const { db, store } = createDb();
    const nowMs = Date.now();
    // TTL の半分を切っている token を仕込む
    const nearlyExpired = new Date(nowMs + 2 * 60_000).toISOString().replace('Z', '+09:00');
    store.tokens.set('stale', {
      token: 'stale',
      shopify_customer_id: '777',
      batch_id: APP_PROXY_BATCH_ID,
      expires_at: nearlyExpired,
      consumed_at: null,
      created_at: nearlyExpired,
    });
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q, nowMs);
    if (!r.ok || r.state !== 'ready') throw new Error('expected ready');
    expect(r.redirectUrl).not.toContain('slk=stale');
  });

  it('local shopify_customers に行が無い顧客は sync_pending (ready にしない)', async () => {
    // ready にすると preview が hint=null を返し、確認カードから「連携先」表示と警告文が
    // 無音で消える = link fixation の唯一の人間確認点が失われる (R2 採点 MED)。
    const { db, store } = createDb({ knownCustomers: new Set() });
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: true, state: 'sync_pending' });
    expect(store.tokens.size).toBe(0);
  });

  it('未消費・未失効の自分の app-proxy token があれば再利用する (連打で write を増やさない)', async () => {
    const { db, store } = createDb();
    const q = () => new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const first = await handleAppProxyLinkEntry(envWith(db), q());
    const second = await handleAppProxyLinkEntry(envWith(db), q());
    if (!first.ok || first.state !== 'ready' || !second.ok || second.state !== 'ready') {
      throw new Error('expected ready');
    }
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(store.tokens.size).toBe(1);
  });

  it('path_prefix が別 proxy 向けなら unauthorized (署名は正当でも用途違いを弾く)', async () => {
    const { db } = createDb();
    const q = new URLSearchParams(signedQuery(baseParams({ path_prefix: '/apps/other' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: false, code: 'unauthorized', reason: 'bad_path_prefix' });
  });

  it('重複キー (logged_in_customer_id 汚染) は unauthorized で token を発行しない', async () => {
    const { db, store } = createDb();
    const q = new URLSearchParams();
    q.append('logged_in_customer_id', '6458785661181');
    q.append('logged_in_customer_id', '');
    q.append('path_prefix', '/apps/line-link');
    q.append('shop', SHOP);
    q.append('timestamp', String(Math.floor(Date.now() / 1000)));
    const message = [...new Set(q.keys())]
      .map((k) => `${k}=${q.getAll(k).join(',')}`)
      .sort()
      .join('');
    q.set('signature', createHmac('sha256', SECRET).update(message).digest('hex'));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r).toEqual({ ok: false, code: 'unauthorized', reason: 'duplicate_param' });
    expect(store.tokens.size).toBe(0);
  });

  it('失効した自分の app-proxy トークンのみ掃除し、 magic-link キャンペーンの token は残す', async () => {
    const { db, store } = createDb();
    const past = '2000-01-01T00:00:00.000+09:00';
    const future = '2099-01-01T00:00:00.000+09:00';
    store.tokens.set('expired-proxy', {
      token: 'expired-proxy',
      shopify_customer_id: '777',
      batch_id: APP_PROXY_BATCH_ID,
      expires_at: past, // 失効済 → 掃除対象
      consumed_at: null,
      created_at: past,
    });
    store.tokens.set('campaign', {
      token: 'campaign',
      shopify_customer_id: '777',
      batch_id: 'batch-2026-07',
      expires_at: future,
      consumed_at: null,
      created_at: future,
    });
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(db), q);
    expect(r.ok).toBe(true);
    expect(store.tokens.has('expired-proxy')).toBe(false); // 失効 app-proxy token は掃除
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
  // 失敗系は状態を問わず 404 に統一する。 gate off=404 / 署名なし=401 / secret 未投入=503 と
  // 打ち分けると、誰でも叩ける workers.dev から「有効化されたか」「secret が入ったか」を
  // 無認証で監視できる設定オラクルになる (R1 採点 LOW)。
  it('gate off は 404 (dormant・本番既定)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db, { APP_PROXY_LINK_ENABLED: undefined }));
    expect(res.status).toBe(404);
  });

  it('署名不正も 404 (401 と打ち分けない)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams(), 'wrong'), envWith(db));
    expect(res.status).toBe(404);
  });

  it('misconfigured も 404 (secret 投入状態を外部から観測させない)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db, { SHOPIFY_CLIENT_SECRET: undefined }));
    expect(res.status).toBe(404);
  });

  it('全応答に Cache-Control: no-store が付く (token を含む HTML の共有キャッシュ汚染防止)', async () => {
    const { db } = createDb();
    const ok = await routeGet(signedQuery(baseParams({ logged_in_customer_id: '777' })), envWith(db));
    expect(ok.headers.get('Cache-Control')).toContain('no-store');
    const notFound = await routeGet(signedQuery(baseParams(), 'wrong'), envWith(db));
    expect(notFound.headers.get('Cache-Control')).toContain('no-store');
  });

  it('末尾スラッシュ / サブパスも同じハンドラで処理する (storefront に生の 401 を出さない)', async () => {
    const { db } = createDb();
    const q = signedQuery(baseParams({ logged_in_customer_id: '777' }));
    for (const path of ['/proxy/line-link/', '/proxy/line-link/anything']) {
      const res = await appProxy.request(`${path}?${q}`, {}, envWith(db) as Record<string, unknown>);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('LINEを開いて連携する');
    }
  });

  // Sec-Fetch guard: storefront に同居する第三者 script が fetch でトークンを読む経路を塞ぐ。
  // (window.open は同一オリジン navigation なので原理的に区別できず、ここでは塞げない)
  it.each([
    ['empty', 'cors', 'fetch/XHR'],
    ['empty', 'no-cors', 'no-cors fetch'],
    ['iframe', 'navigate', 'iframe 埋め込み'],
    ['script', 'no-cors', 'script タグ'],
  ])('Sec-Fetch-Dest=%s Mode=%s (%s) は 404', async (dest, mode) => {
    const { db } = createDb();
    const res = await appProxy.request(
      `/proxy/line-link?${signedQuery(baseParams({ logged_in_customer_id: '777' }))}`,
      { headers: { 'sec-fetch-dest': dest, 'sec-fetch-mode': mode } },
      envWith(db) as Record<string, unknown>,
    );
    expect(res.status).toBe(404);
  });

  it('Sec-Fetch-Dest=document Mode=navigate (通常のページ遷移) は通す', async () => {
    const { db } = createDb();
    const res = await appProxy.request(
      `/proxy/line-link?${signedQuery(baseParams({ logged_in_customer_id: '777' }))}`,
      { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } },
      envWith(db) as Record<string, unknown>,
    );
    expect(res.status).toBe(200);
  });

  it('Sec-Fetch-* を送らない UA は通す (後方互換)', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams({ logged_in_customer_id: '777' })), envWith(db));
    expect(res.status).toBe(200);
  });

  it('service が throw したら 500 のブランドページ (生テキストを storefront に出さない)', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;
    const res = await routeGet(
      signedQuery(baseParams({ logged_in_customer_id: '777' })),
      envWith(brokenDb),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(await res.text()).toContain('ご利用いただけません');
  });

  it('token 発行を audit_logs に記録する (発行の追跡可能性)', async () => {
    // 乗っ取りの疑いが出たとき「発行が正規ログイン由来か注入由来か」を事後に切り分ける唯一の材料。
    const audits: Array<{ action: string; targetId: string }> = [];
    const { db, store } = createDb();
    const spyDb = {
      prepare(sql: string) {
        if (sql.includes('INSERT INTO audit_logs')) {
          return {
            bind(...args: unknown[]) {
              // insertAuditLog の bind 順: id, lineAccountId, actorType, actorId,
              // actorName, action, targetType, targetId, ...
              return {
                async run() {
                  audits.push({ action: String(args[5]), targetId: String(args[7]) });
                  return { meta: { changes: 1 } };
                },
                async first() {
                  return { id: 'a1' };
                },
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        }
        return (db as unknown as { prepare: (s: string) => unknown }).prepare(sql);
      },
    } as unknown as D1Database;
    const q = new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' })));
    const r = await handleAppProxyLinkEntry(envWith(spyDb), q);
    expect(r.ok).toBe(true);
    expect(store.tokens.size).toBe(1);
    expect(audits.some((a) => a.action === 'account_link.app_proxy_token_issued')).toBe(true);
  });

  it('未ログインはログイン誘導ページを返す', async () => {
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ログイン');
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

  it('ready は「タップで LINE を開く」構成 — meta refresh は使わない', async () => {
    // universal link は自動遷移では発火せず、外部ブラウザ内で LIFF が開いて
    // LINE ログインを再要求する = 60代ユーザーの最大の脱落点 (R1 採点 HIGH)。
    const { db, store } = createDb();
    const res = await routeGet(
      signedQuery(baseParams({ logged_in_customer_id: '777' })),
      envWith(db),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = [...store.tokens.keys()][0];
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).toContain(`${LIFF_URL}?slk=${token}`);
    expect(html).not.toContain('<script'); // 静的 HTML のみ (#193 クラス回避)
  });

  it('login_required は公式の /customer_authentication/login?return_to= を使う', async () => {
    // /account/login?return_url= は未文書化で、新 customer accounts では無視され
    // /account に着地する = 「戻ります」の約束が偽になる (R1 採点 HIGH)。
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db));
    const html = await res.text();
    expect(html).toContain('/customer_authentication/login?return_to=%2Fapps%2Fline-link');
    expect(html).not.toContain('/account/login?return_url=');
  });

  it('already_linked にも LINE へ戻る導線がある (外部ブラウザの行き止まりを作らない)', async () => {
    const { db } = createDb({ linkedCustomers: new Set(['777']) });
    const res = await routeGet(signedQuery(baseParams({ logged_in_customer_id: '777' })), envWith(db));
    const html = await res.text();
    expect(html).toContain('すでに連携済み');
    expect(html).toContain(`href="${LIFF_URL}"`);
  });

  it('CTA のコントラストがブランドトークン #0f766e (AA) である', async () => {
    // #0e9f97 は白文字 3.27:1 で AA 不合格だった (R1 採点 MED)
    const { db } = createDb();
    const res = await routeGet(signedQuery(baseParams()), envWith(db));
    const html = await res.text();
    expect(html).toContain('#0f766e');
    expect(html).not.toContain('#0e9f97');
  });
});

// ============================================================
// 跨サービス統合: App Proxy が発行した token が実際に redeem できる
// ============================================================

describe('App Proxy 発行 token → sub-link redeem (統合)', () => {
  const linkEnv = (db: D1Database, over: Record<string, string | undefined> = {}) => ({
    ...envWith(db),
    SUB_LINK_ENABLED: undefined,
    ...over,
  });

  it('発行 → preview(ready, kind=shop) → redeem 成功 → 逆方向リンクまで通る', async () => {
    const { db, friends, customers } = createIntegrationDb();
    friends.set('f1', { id: 'f1', shopify_customer_id: null });
    customers.set('777', { shopify_customer_id: '777', tags: '', email: 'hanako@example.com', friend_id: null });

    const entry = await handleAppProxyLinkEntry(
      linkEnv(db),
      new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' }))),
    );
    if (!entry.ok || entry.state !== 'ready') throw new Error('expected ready');
    const token = entry.redirectUrl.split('slk=')[1];

    const p = await previewSubLinkToken(linkEnv(db), { token, friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.status).toBe('ready'); // ← 形式退行 (Z 形式) ならここが 'expired' で落ちる
      expect(p.kind).toBe('shop');
      expect(p.hint).toBe('h***@e***.com'); // マスク済 = 本人には分かり第三者には特定できない
    }

    const r = await redeemSubLinkToken(linkEnv(db), { token, friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(true);
    expect(friends.get('f1')?.shopify_customer_id).toBe('777');
    expect(customers.get('777')?.friend_id).toBe('f1');
  });

  it('APP_PROXY gate を切ると App Proxy 発行 token は受理されない (invalid)', async () => {
    const { db, friends, customers } = createIntegrationDb();
    friends.set('f1', { id: 'f1', shopify_customer_id: null });
    customers.set('777', { shopify_customer_id: '777', tags: '', email: 'h@e.com', friend_id: null });
    const entry = await handleAppProxyLinkEntry(
      linkEnv(db),
      new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777' }))),
    );
    if (!entry.ok || entry.state !== 'ready') throw new Error('expected ready');
    const token = entry.redirectUrl.split('slk=')[1];

    // SUB_LINK だけ on / APP_PROXY off に切り替える = 発行経路の gate が閉じた状態
    const offEnv = { ...linkEnv(db), APP_PROXY_LINK_ENABLED: undefined, SUB_LINK_ENABLED: 'true' };
    const p = await previewSubLinkToken(offEnv, { token, friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.status).toBe('invalid');
    const r = await redeemSubLinkToken(offEnv, { token, friendId: 'f1', lineUserId: 'U1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid');
    expect(friends.get('f1')?.shopify_customer_id).toBeNull();
  });

  it('TTL 経過後の token は expired (nowMs 注入で境界を跨ぐ)', async () => {
    const { db, friends, customers } = createIntegrationDb();
    friends.set('f1', { id: 'f1', shopify_customer_id: null });
    customers.set('777', { shopify_customer_id: '777', tags: '', email: 'h@e.com', friend_id: null });
    const past = Date.now() - (APP_PROXY_TOKEN_TTL_MIN + 5) * 60_000;
    const entry = await handleAppProxyLinkEntry(
      linkEnv(db),
      new URLSearchParams(signedQuery(baseParams({ logged_in_customer_id: '777', timestamp: String(Math.floor(past / 1000)) }))),
      past,
    );
    if (!entry.ok || entry.state !== 'ready') throw new Error('expected ready');
    const token = entry.redirectUrl.split('slk=')[1];
    const p = await previewSubLinkToken(linkEnv(db), { token, friendId: 'f1' });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.status).toBe('expired');
  });
});
