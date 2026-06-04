/**
 * Tests for friend-customer-linker (= 自社内製ロイヤリティ PR3, 2026-06-05)
 *
 * friend↔Shopify customer の metafield 逆引きリンクを検証:
 *   - findShopifyCustomerByLineId: 厳密一致 1 件のみ採用 / value 不一致・複数件・エラー → null / gid 正規化 / query body
 *   - processFriendCustomerLink: 本番ガード (FRIEND_LINK_ENABLED) / metafield 未設定 / window gating /
 *     link 成功 / ambiguous (別 friend に既 link) / notFound
 * getShopifyAccessToken は vi.mock (= linker は static import のみで dynamic import 干渉トラップなし)。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token_xxx'),
}));

import {
  findShopifyCustomerByLineId,
  processFriendCustomerLink,
  normalizeShopifyCustomerId,
} from '../services/friend-customer-linker.js';

// ─── stateful fake D1 (friends のみ。 audit_logs INSERT は best-effort で no-op) ───
interface FFriend {
  id: string;
  line_user_id: string;
  shopify_customer_id: string | null;
  created_at: string;
}

function makeDb(seed: FFriend[] = []): D1Database & { friends: FFriend[] } {
  const friends = seed.map((f) => ({ ...f }));
  const db = {
    friends,
    prepare(sql: string) {
      const stmt = {
        _b: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._b = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends') && sql.includes('shopify_customer_id = ?')) {
            const cid = stmt._b[0];
            const f = friends.find((x) => x.shopify_customer_id === cid);
            return (f ? { ...f } : null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes('FROM friends') && sql.includes('shopify_customer_id IS NULL')) {
            const limit = (stmt._b[0] as number) ?? 25;
            const rows = friends
              .filter((x) => x.shopify_customer_id === null && x.line_user_id)
              .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
              .slice(0, limit)
              .map((x) => ({ id: x.id, line_user_id: x.line_user_id }));
            return { results: rows as unknown as T[], success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          if (sql.includes('UPDATE friends') && sql.includes('shopify_customer_id IS NULL')) {
            // binds: shopify_customer_id, updated_at, id
            const cid = stmt._b[0] as string;
            const id = stmt._b[2] as string;
            const f = friends.find((x) => x.id === id && x.shopify_customer_id === null);
            if (f) {
              f.shopify_customer_id = cid;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } }; // audit_logs INSERT 等は no-op
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { friends: FFriend[] };
}

const ENV_ON = {
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'sec',
  FRIEND_LINK_ENABLED: 'true',
  FRIEND_LINK_METAFIELD_NAMESPACE: 'crmplus',
  FRIEND_LINK_METAFIELD_KEY: 'line_id',
  FRIEND_LINK_CRON_FORCE: 'true',
};

/** customers GraphQL レスポンスを 1 件 (= lineId 一致) で返す fetch mock */
function mockCustomerFound(lineUserId: string, gid = 'gid://shopify/Customer/777', email = 'a@b.com') {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            customers: {
              edges: [
                {
                  node: {
                    id: gid,
                    defaultEmailAddress: { emailAddress: email },
                    metafield: { value: lineUserId },
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
  );
}

const TOKEN = 'shpat_test_token_xxx';

describe('normalizeShopifyCustomerId', () => {
  it('gid → 数値 / 数値はそのまま / 不正は null', () => {
    expect(normalizeShopifyCustomerId('gid://shopify/Customer/777')).toBe('777');
    expect(normalizeShopifyCustomerId('123456')).toBe('123456');
    expect(normalizeShopifyCustomerId('gid://shopify/Order/1')).toBeNull();
    expect(normalizeShopifyCustomerId(null)).toBeNull();
    expect(normalizeShopifyCustomerId('')).toBeNull();
  });
});

describe('findShopifyCustomerByLineId', () => {
  it('厳密一致 1 件 → customerId(正規化) + email', async () => {
    const fetchImpl = mockCustomerFound('U_alice', 'gid://shopify/Customer/777', 'alice@x.com');
    const r = await findShopifyCustomerByLineId(
      'shop.myshopify.com',
      TOKEN,
      'crmplus',
      'line_id',
      'U_alice',
      fetchImpl as unknown as typeof fetch,
    );
    expect(r).toEqual({ customerId: '777', email: 'alice@x.com' });
  });

  it('query body: metafields.{ns}.{key}:"{lineId}" + variables', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      captured = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/5', defaultEmailAddress: null, metafield: { value: 'U_x' } } }] } },
        }),
        { status: 200 },
      );
    });
    await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_x', fetchImpl as unknown as typeof fetch);
    expect(captured!.variables).toEqual({ q: 'metafields.crmplus.line_id:"U_x"', ns: 'crmplus', key: 'line_id' });
    expect(captured!.query).toContain('metafield(namespace: $ns, key: $key)');
  });

  it('metafield.value 不一致 → null (= 誤マッチ排除)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/9', defaultEmailAddress: null, metafield: { value: 'U_OTHER' } } }] } },
          }),
          { status: 200 },
        ),
    );
    const r = await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_alice', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('厳密一致が複数件 (ambiguous) → null', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              customers: {
                edges: [
                  { node: { id: 'gid://shopify/Customer/1', defaultEmailAddress: null, metafield: { value: 'U_dup' } } },
                  { node: { id: 'gid://shopify/Customer/2', defaultEmailAddress: null, metafield: { value: 'U_dup' } } },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    const r = await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_dup', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('0 件 → null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { customers: { edges: [] } } }), { status: 200 }));
    const r = await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_none', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
  });

  it('不正な lineUserId (= 注入リスク) → fetch せず null', async () => {
    const fetchImpl = vi.fn();
    const r = await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U" OR 1', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP error → throw (= caller が errors として計上、 notFound と区別)', async () => {
    const fetchImpl = vi.fn(async () => new Response('error', { status: 500 }));
    await expect(
      findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_alice', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('GraphQL errors → throw (= Shopify 障害を notFound に誤計上しない)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'throttled' }] }), { status: 200 }));
    await expect(
      findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crmplus', 'line_id', 'U_alice', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/throttled/);
  });

  it('namespace/key に不正文字 → fetch せず null (= 注入防御)', async () => {
    const fetchImpl = vi.fn();
    const r = await findShopifyCustomerByLineId('shop.myshopify.com', TOKEN, 'crm:plus', 'line_id', 'U_alice', fetchImpl as unknown as typeof fetch);
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('processFriendCustomerLink — gating', () => {
  it('本番ガード off (FRIEND_LINK_ENABLED!=true) → skipped・fetch せず', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_a', shopify_customer_id: null, created_at: '2026-01-01' }]);
    const fetchImpl = mockCustomerFound('U_a');
    const r = await processFriendCustomerLink(
      { ...ENV_ON, FRIEND_LINK_ENABLED: undefined, DB: db },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('gated_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('metafield 未設定 → skipped (metafield_not_configured)', async () => {
    const db = makeDb();
    const r = await processFriendCustomerLink({ ...ENV_ON, FRIEND_LINK_METAFIELD_KEY: undefined, DB: db }, {});
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('metafield_not_configured');
  });

  it('metafield ns/key に不正文字 → skipped (metafield_invalid)', async () => {
    const db = makeDb();
    const r = await processFriendCustomerLink({ ...ENV_ON, FRIEND_LINK_METAFIELD_KEY: 'bad:key', DB: db }, {});
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('metafield_invalid');
  });

  it('Shopify credentials 未設定 → skipped (shopify_not_configured)', async () => {
    const db = makeDb();
    const r = await processFriendCustomerLink({ ...ENV_ON, SHOPIFY_CLIENT_SECRET: undefined, DB: db }, {});
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('shopify_not_configured');
  });

  it('window 外 (FORCE なし) → skipped (outside_window)', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_a', shopify_customer_id: null, created_at: '2026-01-01' }]);
    const fetchImpl = mockCustomerFound('U_a');
    // 2026-06-05T12:00:00Z = JST 21:00 (= window 02:00-02:04 外)
    const r = await processFriendCustomerLink(
      { ...ENV_ON, FRIEND_LINK_CRON_FORCE: undefined, DB: db },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => Date.parse('2026-06-05T12:00:00Z') },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('outside_window');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('window 内 (JST 02:00) なら FORCE なしでも実行', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_a', shopify_customer_id: null, created_at: '2026-01-01' }]);
    const fetchImpl = mockCustomerFound('U_a', 'gid://shopify/Customer/100');
    // 2026-06-04T17:02:00Z = JST 02:02 (= window 内)
    const r = await processFriendCustomerLink(
      { ...ENV_ON, FRIEND_LINK_CRON_FORCE: undefined, DB: db },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => Date.parse('2026-06-04T17:02:00Z') },
    );
    expect(r.skipped).toBe(false);
    expect(r.linked).toBe(1);
    expect(db.friends[0].shopify_customer_id).toBe('100');
  });
});

describe('processFriendCustomerLink — linking', () => {
  it('found → friend に shopify_customer_id を set + linked=1', async () => {
    const db = makeDb([
      { id: 'f1', line_user_id: 'U_alice', shopify_customer_id: null, created_at: '2026-01-01' },
    ]);
    const fetchImpl = mockCustomerFound('U_alice', 'gid://shopify/Customer/777');
    const r = await processFriendCustomerLink(
      { ...ENV_ON, DB: db },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.skipped).toBe(false);
    expect(r.scanned).toBe(1);
    expect(r.linked).toBe(1);
    expect(r.ambiguous).toBe(0);
    expect(db.friends[0].shopify_customer_id).toBe('777');
  });

  it('同 customer が別 friend に既 link → ambiguous・上書きしない', async () => {
    const db = makeDb([
      { id: 'fA', line_user_id: 'U_alice', shopify_customer_id: null, created_at: '2026-01-02' },
      { id: 'fB', line_user_id: 'U_bob', shopify_customer_id: '999', created_at: '2026-01-01' },
    ]);
    // fA の metafield 逆引きが fB の customer 999 を返す (= 衝突)
    const fetchImpl = mockCustomerFound('U_alice', 'gid://shopify/Customer/999');
    const r = await processFriendCustomerLink({ ...ENV_ON, DB: db }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.linked).toBe(0);
    expect(r.ambiguous).toBe(1);
    expect(db.friends.find((f) => f.id === 'fA')?.shopify_customer_id).toBeNull();
  });

  it('customer 見つからない → notFound、 link せず', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_ghost', shopify_customer_id: null, created_at: '2026-01-01' }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { customers: { edges: [] } } }), { status: 200 }));
    const r = await processFriendCustomerLink({ ...ENV_ON, DB: db }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.linked).toBe(0);
    expect(r.notFound).toBe(1);
    expect(db.friends[0].shopify_customer_id).toBeNull();
  });

  it('既 link 済 friend は scan 対象外 (= idempotent)', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_a', shopify_customer_id: '555', created_at: '2026-01-01' }]);
    const fetchImpl = mockCustomerFound('U_a');
    const r = await processFriendCustomerLink({ ...ENV_ON, DB: db }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.scanned).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('Shopify 障害 (fetch throw) → errors++ で継続・link せず (notFound に誤計上しない)', async () => {
    const db = makeDb([{ id: 'f1', line_user_id: 'U_a', shopify_customer_id: null, created_at: '2026-01-01' }]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await processFriendCustomerLink({ ...ENV_ON, DB: db }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.errors).toBe(1);
    expect(r.linked).toBe(0);
    expect(r.notFound).toBe(0);
    expect(db.friends[0].shopify_customer_id).toBeNull();
  });
});
