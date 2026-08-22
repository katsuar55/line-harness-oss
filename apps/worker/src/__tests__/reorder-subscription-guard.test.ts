/**
 * ポータル再注文の二重購入ガード (採点②-1 HIGH, 2026-08-22)。
 *
 * 背景: 「🔄 この注文を再注文」が**定期便のお届け分の注文**でも無警告で単発 Draft Order を
 *   作っていた (再注文経路に契約チェック 0 行)。トーク側 (subscription-reminder) は
 *   2026-08-18 に NOT EXISTS で塞いだが、ポータルは別経路で素通しだった。
 *
 * Katsu 決定 = 「確認ステップを挟む」方式:
 *   - 一覧 (POST /api/liff/reorder) は各注文に isSubscriptionOrder を付け、拒否はしない
 *   - 実行 (POST /api/liff/reorder/create) は 定期便注文 × 稼働契約者 × ack 無し を
 *     **409 で fail-closed** (UI を迂回した直 POST でも 1 回は止まる)
 *   - ack (acknowledgeSubscriptionDuplicate === true) 付きは通す = 意図的な追加購入は残す
 *
 * 述語は fake で再実装せず実 SQLite (schema.sql) で観測する。
 * 観測点は「Draft Order API (draftOrderCreate) を**呼んでいないこと**」— ステータスだけ見ない。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — 注文アクセサだけ差し替え、D1 (rate limit / 契約 EXISTS / draft INSERT)
// は実 SQLite に通す
// ---------------------------------------------------------------------------
const SUB_TAGS = 'Subscription, subscription-id:12345, subscription-count:3';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getFriendByLineUserId: vi.fn(async (_db: unknown, lineUserId: string) => {
      if (lineUserId === 'U_EXISTING') {
        return { id: 'friend-1', line_user_id: 'U_EXISTING', display_name: 'Test User', is_following: 1 };
      }
      return null;
    }),
    getShopifyOrders: vi.fn(async () => [
      {
        id: 'o-sub', order_number: 3001, total_price: 5980, email: 'test@example.com',
        line_items: '[{"name":"naturism Blue VP","variant_id":"44000001","quantity":1}]',
        tags: SUB_TAGS, created_at: '2026-08-01', fulfillment_status: 'fulfilled',
      },
      {
        id: 'o-normal', order_number: 3002, total_price: 2830, email: 'test@example.com',
        line_items: '[{"name":"naturism Pink","variant_id":"44000002","quantity":1}]',
        tags: 'liff-reorder', created_at: '2026-07-01', fulfillment_status: 'fulfilled',
      },
    ]),
    getShopifyOrderById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'o-sub') {
        return {
          id: 'o-sub', friend_id: 'friend-1', order_number: 3001, total_price: 5980,
          email: 'test@example.com', tags: SUB_TAGS,
          line_items: '[{"name":"naturism Blue VP","variant_id":"44000001","quantity":1,"price":"5980"}]',
          created_at: '2026-08-01', fulfillment_status: 'fulfilled',
        };
      }
      if (id === 'o-normal') {
        return {
          id: 'o-normal', friend_id: 'friend-1', order_number: 3002, total_price: 2830,
          email: 'test@example.com', tags: 'liff-reorder',
          line_items: '[{"name":"naturism Pink","variant_id":"44000002","quantity":1,"price":"2830"}]',
          created_at: '2026-07-01', fulfillment_status: 'fulfilled',
        };
      }
      return null;
    }),
    getShopifyProducts: vi.fn(async () => []),
  };
});

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'test-shopify-token'),
}));

// Shopify GraphQL (draftOrderCreate) の記録付き stub。
// 「呼んでいないこと」を観測点にするため、呼び出しは必ずここを通る。
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (typeof url === 'string' && url.includes('graphql.json')) {
    const reqBody = init?.body ? String(init.body) : '';
    if (reqBody.includes('draftOrderCreate')) {
      return new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/98765',
              invoiceUrl: 'https://naturism-diet.com/checkout/draft/98765',
              status: 'OPEN',
              totalPriceSet: { shopMoney: { amount: '5980.00', currencyCode: 'JPY' } },
              lineItems: { nodes: [{ name: 'naturism Blue VP', quantity: 1 }] },
            },
            userErrors: [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
});
vi.stubGlobal('fetch', fetchMock);

function draftOrderCreateCalls(): number {
  return fetchMock.mock.calls.filter(
    ([url, init]) =>
      typeof url === 'string' && url.includes('graphql.json') &&
      init?.body != null && String(init.body).includes('draftOrderCreate'),
  ).length;
}

const { liffPortal } = await import('../routes/liff-portal.js');
const { getFriendByLineUserId } = await import('@line-crm/db');

// ---------------------------------------------------------------------------
// App + 実 SQLite env
// ---------------------------------------------------------------------------
function createApp() {
  const app = new Hono();
  app.use('/api/liff/*', async (c, next) => {
    const body = await c.req.json<{ lineUserId?: string }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const env = (c as unknown as { env: { DB: D1Database } }).env;
    const friend = await (getFriendByLineUserId as ReturnType<typeof vi.fn>)(env.DB, body.lineUserId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', {
      lineUserId: body.lineUserId,
      friendId: friend.id,
      shopifyCustomerId: null,
    });
    return next();
  });
  app.route('/', liffPortal);
  return app;
}

const PAST = '2026-08-01T00:00:00.000Z';

function seed(
  raw: SqliteDatabase,
  contractState: 'active' | 'cancelled' | 'paused' | 'none',
): void {
  raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
            VALUES ('friend-1', 'U_EXISTING', 'Test User', 1, '${PAST}', '${PAST}')`);
  raw.exec(`UPDATE friends SET shopify_customer_id='SC1' WHERE id='friend-1'`);
  if (contractState !== 'none') {
    const cancelled = contractState === 'cancelled' ? `'${PAST}'` : 'NULL';
    const paused = contractState === 'paused' ? `'${PAST}'` : 'NULL';
    raw.exec(`INSERT INTO subscription_contracts (contract_id, shopify_customer_id, cancelled_at, paused_at, created_at, updated_at)
              VALUES ('C1', 'SC1', ${cancelled}, ${paused}, '${PAST}', '${PAST}')`);
  }
}

function mkEnv(raw: SqliteDatabase) {
  return {
    DB: asD1(raw),
    WORKER_URL: 'https://test.workers.dev',
    SHOPIFY_STORE_DOMAIN: 'naturism-diet.com',
  };
}

function post(app: ReturnType<typeof createApp>, env: ReturnType<typeof mkEnv>, path: string, body: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env as unknown as Record<string, unknown>);
}

function draftRowCount(raw: SqliteDatabase): number {
  const row = raw.prepare('SELECT COUNT(*) AS n FROM shopify_draft_orders').get() as { n: number };
  return Number(row.n);
}

// ---------------------------------------------------------------------------
// 述語 (service 単体)
// ---------------------------------------------------------------------------
describe('reorder-guard service — 述語', () => {
  it('isSubscriptionDeliveryOrder: subscription-id: タグを持つ注文だけ true', async () => {
    const { isSubscriptionDeliveryOrder } = await import('../services/reorder-guard.js');
    expect(isSubscriptionDeliveryOrder(SUB_TAGS)).toBe(true);
    expect(isSubscriptionDeliveryOrder('liff-reorder, Subscription')).toBe(false);
    expect(isSubscriptionDeliveryOrder(null)).toBe(false);
    expect(isSubscriptionDeliveryOrder(undefined)).toBe(false);
    expect(isSubscriptionDeliveryOrder('')).toBe(false);
  });

  it('hasActiveSubscriptionContract: cancelled_at IS NULL を「稼働」と定義する (reminder 側と同一述語 = paused も稼働)', async () => {
    const { hasActiveSubscriptionContract } = await import('../services/reorder-guard.js');

    for (const [state, expected] of [
      ['active', true],
      ['paused', true],      // 一時停止 (決済失敗含む) は二重購入リスクが最も高い層 — 稼働扱い
      ['cancelled', false],  // 解約済みは単発購入者に戻った = 正当な再注文を殺さない
      ['none', false],
    ] as const) {
      const raw = createSchemaDb();
      seed(raw, state);
      expect(await hasActiveSubscriptionContract(asD1(raw), 'friend-1'), `contractState=${state}`).toBe(expected);
    }
  });

  it('hasActiveSubscriptionContract: shopify_customer_id 未連携の friend は false (JOIN 不成立)', async () => {
    const { hasActiveSubscriptionContract } = await import('../services/reorder-guard.js');
    const raw = createSchemaDb();
    raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
              VALUES ('friend-2', 'U_UNLINKED', 'Unlinked', 1, '${PAST}', '${PAST}')`);
    raw.exec(`INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
              VALUES ('C9', 'SC-OTHER', '${PAST}', '${PAST}')`);
    expect(await hasActiveSubscriptionContract(asD1(raw), 'friend-2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/liff/reorder/create — fail-closed 409
// ---------------------------------------------------------------------------
describe('POST /api/liff/reorder/create — 定期便注文の二重購入ガード', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    fetchMock.mockClear();
  });

  it('🚨 定期便注文 × 稼働契約 × ack なし → 409 + Draft Order API を一切呼ばない + 台帳にも書かない', async () => {
    const raw = createSchemaDb();
    seed(raw, 'active');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-sub',
    });
    expect(res.status).toBe(409);
    const json = await res.json() as { success: boolean; code?: string; error?: string };
    expect(json.success).toBe(false);
    expect(json.code).toBe('subscription_duplicate');
    expect(typeof json.error).toBe('string'); // 旧 bundle のトースト表示にも耐える日本語文
    expect(json.error).toMatch(/定期便/);
    // 観測点はステータスだけでなく「外部 API を呼んでいないこと」
    expect(draftOrderCreateCalls()).toBe(0);
    expect(draftRowCount(raw)).toBe(0);
  });

  it('ack (acknowledgeSubscriptionDuplicate === true) 付きは作成される = 意図的な追加購入は通す', async () => {
    const raw = createSchemaDb();
    seed(raw, 'active');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-sub', acknowledgeSubscriptionDuplicate: true,
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data?: { invoiceUrl?: string } };
    expect(json.success).toBe(true);
    expect(json.data?.invoiceUrl).toContain('checkout/draft');
    expect(draftOrderCreateCalls()).toBe(1);
    expect(draftRowCount(raw)).toBe(1);
  });

  it('ack は boolean true のみ受理 (文字列 "true" / 1 / truthy は fail-closed で 409)', async () => {
    for (const bad of ['true', 1, 'yes', {}] as const) {
      const raw = createSchemaDb();
      seed(raw, 'active');
      const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
        lineUserId: 'U_EXISTING', orderId: 'o-sub', acknowledgeSubscriptionDuplicate: bad,
      });
      expect(res.status, `ack=${JSON.stringify(bad)}`).toBe(409);
    }
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('一時停止中 (paused) の契約者も止める — 決済失敗 pause は二重購入リスクが最も高い', async () => {
    const raw = createSchemaDb();
    seed(raw, 'paused');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-sub',
    });
    expect(res.status).toBe(409);
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('通常注文 (subscription-id タグなし) は稼働契約者でも従来どおり作成される', async () => {
    const raw = createSchemaDb();
    seed(raw, 'active');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-normal',
    });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
  });

  it('解約済み契約者の定期便注文は ack 不要で作成される (正当な再注文を殺さない)', async () => {
    const raw = createSchemaDb();
    seed(raw, 'cancelled');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-sub',
    });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
  });

  it('items[] 直指定 (orderId なし) はガード対象外 = 稼働契約者でも作成される (意図的なスコープ境界の固定)', async () => {
    // source 注文が無く「定期便のお届け分の再注文」と判定できないため、ガードは orderId 経路のみ。
    // この境界を暗黙にせずテストで固定する (広げるならこのテストを意図的に書き換えること)
    const raw = createSchemaDb();
    seed(raw, 'active');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING',
      items: [{ variantId: '44000009', quantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
  });

  it('契約なしの friend も従来どおり作成される (退行なし)', async () => {
    const raw = createSchemaDb();
    seed(raw, 'none');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder/create', {
      lineUserId: 'U_EXISTING', orderId: 'o-sub',
    });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/liff/reorder — 一覧はフラグを付けるだけで拒否しない
// ---------------------------------------------------------------------------
describe('POST /api/liff/reorder — isSubscriptionOrder フラグ', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    fetchMock.mockClear();
  });

  it('各注文行に isSubscriptionOrder を付与し、稼働契約の有無も返す (拒否はしない)', async () => {
    const raw = createSchemaDb();
    seed(raw, 'active');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder', { lineUserId: 'U_EXISTING' });
    expect(res.status).toBe(200);
    const json = await res.json() as {
      success: boolean;
      data: {
        hasActiveSubscriptionContract: boolean;
        recentOrders: Array<{ id: string; isSubscriptionOrder: boolean }>;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.hasActiveSubscriptionContract).toBe(true);
    const byId = new Map(json.data.recentOrders.map((o) => [o.id, o.isSubscriptionOrder]));
    expect(byId.get('o-sub')).toBe(true);
    expect(byId.get('o-normal')).toBe(false);
  });

  it('契約なしなら hasActiveSubscriptionContract=false (UI は確認ステップを出さない判断材料)', async () => {
    const raw = createSchemaDb();
    seed(raw, 'cancelled');
    const res = await post(app, mkEnv(raw), '/api/liff/reorder', { lineUserId: 'U_EXISTING' });
    const json = await res.json() as { data: { hasActiveSubscriptionContract: boolean } };
    expect(json.data.hasActiveSubscriptionContract).toBe(false);
  });
});
