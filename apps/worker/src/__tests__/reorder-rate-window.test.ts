/**
 * 再注文レート制限の A案 (2026-08-22 Katsu 承認) + 窓判定バグの回帰テスト。
 *
 * A案: 5 分以内の再タップが**同一注文**なら、429 の行き止まりにせず
 *   「さきほど作成したご注文ページ」(既存 draft の invoice_url) を開き直す (reused: true)。
 *   別注文・items[] 直指定は従来どおり 429 (文言は改善)。新しい draft は作らない。
 *
 * 窓判定バグ (実装と同時に修正): created_at は jstNow() = 'YYYY-MM-DDTHH:mm:ss.sss+09:00'、
 *   旧実装は `created_at > datetime('now','-5 minutes')` (UTC・スペース区切り) の**文字列比較**で、
 *   区切り文字 'T' > ' ' により同日中の draft が常に「recent」= 実質「翌朝 9:05 まで 1 回」だった。
 *   時刻は JS (Date.parse) で比較する。
 *
 * 観測点は「Shopify draftOrderCreate を呼んでいないこと」+ 台帳の行数 (ステータスだけ見ない)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';

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
    getShopifyOrderById: vi.fn(async (_db: unknown, id: string) => {
      if (id === 'o1' || id === 'o2') {
        return {
          id, friend_id: 'friend-1', order_number: id === 'o1' ? 1001 : 1002, total_price: 6415,
          email: 'test@example.com', tags: 'liff-reorder',
          line_items: '[{"name":"naturism Blue VP","variant_id":"44000001","quantity":1,"price":"6415"}]',
          created_at: '2026-08-01', fulfillment_status: 'fulfilled',
        };
      }
      if (id === 'o-sub') {
        return {
          id, friend_id: 'friend-1', order_number: 1003, total_price: 5980,
          email: 'test@example.com', tags: SUB_TAGS,
          line_items: '[{"name":"naturism Blue VP","variant_id":"44000001","quantity":1,"price":"5980"}]',
          created_at: '2026-08-01', fulfillment_status: 'fulfilled',
        };
      }
      return null;
    }),
    getShopifyOrders: vi.fn(async () => []),
    getShopifyProducts: vi.fn(async () => []),
  };
});

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'test-shopify-token'),
}));

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (typeof url === 'string' && url.includes('graphql.json')) {
    const reqBody = init?.body ? String(init.body) : '';
    if (reqBody.includes('draftOrderCreate')) {
      return new Response(JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: 'gid://shopify/DraftOrder/555',
              invoiceUrl: 'https://naturism-diet.com/checkout/draft/555',
              status: 'OPEN',
              totalPriceSet: { shopMoney: { amount: '6415.00', currencyCode: 'JPY' } },
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

function createApp() {
  const app = new Hono();
  app.use('/api/liff/*', async (c, next) => {
    const body = await c.req.json<{ lineUserId?: string }>();
    if (!body.lineUserId) return c.json({ success: false, error: 'Unauthorized' }, 401);
    const env = (c as unknown as { env: { DB: D1Database } }).env;
    const friend = await (getFriendByLineUserId as ReturnType<typeof vi.fn>)(env.DB, body.lineUserId);
    if (!friend) return c.json({ success: false, error: 'Friend not found' }, 404);
    (c as unknown as { set: (key: string, value: unknown) => void }).set('liffUser', {
      lineUserId: body.lineUserId, friendId: friend.id, shopifyCustomerId: null,
    });
    return next();
  });
  app.route('/', liffPortal);
  return app;
}

const PAST = '2026-08-01T00:00:00.000Z';

/** 本番 jstNow() と同形式 'YYYY-MM-DDTHH:mm:ss.sss+09:00' を任意時刻で作る */
function jstIso(msAgo: number): string {
  const t = new Date(Date.now() - msAgo + 9 * 3600_000);
  return t.toISOString().replace('Z', '+09:00');
}

function seedFriend(raw: SqliteDatabase, opts?: { activeContract?: boolean }): void {
  raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
            VALUES ('friend-1', 'U_EXISTING', 'Test User', 1, '${PAST}', '${PAST}')`);
  if (opts?.activeContract) {
    raw.exec(`UPDATE friends SET shopify_customer_id='SC1' WHERE id='friend-1'`);
    raw.exec(`INSERT INTO subscription_contracts (contract_id, shopify_customer_id, created_at, updated_at)
              VALUES ('C1', 'SC1', '${PAST}', '${PAST}')`);
  }
}

function seedDraft(
  raw: SqliteDatabase,
  opts: { msAgo: number; sourceOrderId: string | null; invoiceUrl?: string | null; status?: string },
): void {
  const inv = opts.invoiceUrl === null ? 'NULL' : `'${opts.invoiceUrl ?? 'https://naturism-diet.com/checkout/draft/prev'}'`;
  const src = opts.sourceOrderId === null ? 'NULL' : `'${opts.sourceOrderId}'`;
  const ts = jstIso(opts.msAgo);
  raw.exec(`INSERT INTO shopify_draft_orders
              (id, friend_id, shopify_draft_order_id, invoice_url, status, total_price, currency, line_items, source_order_id, created_at, updated_at)
            VALUES ('d-prev', 'friend-1', '999', ${inv}, '${opts.status ?? 'open'}', 6415, 'JPY', '[]', ${src}, '${ts}', '${ts}')`);
}

function mkEnv(raw: SqliteDatabase) {
  return { DB: asD1(raw), WORKER_URL: 'https://test.workers.dev', SHOPIFY_STORE_DOMAIN: 'naturism-diet.com' };
}

function post(app: ReturnType<typeof createApp>, env: ReturnType<typeof mkEnv>, body: Record<string, unknown>) {
  return app.request('/api/liff/reorder/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, env as unknown as Record<string, unknown>);
}

function draftRowCount(raw: SqliteDatabase): number {
  return Number((raw.prepare('SELECT COUNT(*) AS n FROM shopify_draft_orders').get() as { n: number }).n);
}

describe('再注文レート制限 A案 — 同一注文はさきほどのご注文ページを開き直す', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    fetchMock.mockClear();
  });

  it('同一注文 × 5分以内 → 200 reused:true で既存 invoice_url を返し、新しい draft は作らない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: 'o1' });
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o1' });
    expect(res.status).toBe(200);
    const json = await res.json() as { success: boolean; data?: { invoiceUrl?: string; reused?: boolean } };
    expect(json.success).toBe(true);
    expect(json.data?.reused).toBe(true);
    expect(json.data?.invoiceUrl).toBe('https://naturism-diet.com/checkout/draft/prev');
    expect(draftOrderCreateCalls()).toBe(0);
    expect(draftRowCount(raw)).toBe(1);
  });

  it('別注文 × 5分以内 → 429 (別内容のページを開かせない) + Shopify API を呼ばない', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: 'o1' });
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o2' });
    expect(res.status).toBe(429);
    const json = await res.json() as { error?: string };
    expect(json.error).toMatch(/5分に1回/);
    expect(draftOrderCreateCalls()).toBe(0);
    expect(draftRowCount(raw)).toBe(1);
  });

  it('items[] 直指定 × 5分以内 → 429 (source 注文が無いので reuse 対象外)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: null });
    const res = await post(app, mkEnv(raw), {
      lineUserId: 'U_EXISTING', items: [{ variantId: '44000001', quantity: 1 }],
    });
    expect(res.status).toBe(429);
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('🚨 窓判定の回帰: 6分前の draft (本番 jstNow 形式) は「recent」でない = 新規作成が通る', async () => {
    // 旧実装は UTC datetime('now') との文字列比較で、同日中ずっと 429 だった (T > 空白)。
    const raw = createSchemaDb();
    seedFriend(raw);
    seedDraft(raw, { msAgo: 6 * 60_000, sourceOrderId: 'o1' });
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o2' });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
    expect(draftRowCount(raw)).toBe(2);
  });

  it('二重購入ガードは reuse より先: 定期便注文 × 稼働契約 × ack なし → 同一注文の recent draft があっても 409', async () => {
    const raw = createSchemaDb();
    seedFriend(raw, { activeContract: true });
    seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: 'o-sub' });
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o-sub' });
    expect(res.status).toBe(409);
    const json = await res.json() as { code?: string };
    expect(json.code).toBe('subscription_duplicate');
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('同一注文でも invoice_url が無い draft は reuse できない → 429 に倒す (開けないページを返さない)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: 'o1', invoiceUrl: null });
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o1' });
    expect(res.status).toBe(429);
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('完了/キャンセル済み draft は reuse しない → 429 (Codex P2: 死んだ invoice URL を開かせない)', async () => {
    for (const status of ['completed', 'cancelled']) {
      const raw = createSchemaDb();
      seedFriend(raw);
      seedDraft(raw, { msAgo: 2 * 60_000, sourceOrderId: 'o1', status });
      const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o1' });
      expect(res.status, `status=${status}`).toBe(429);
    }
    expect(draftOrderCreateCalls()).toBe(0);
  });

  it('draft が 1 行も無ければ従来どおり作成される (退行なし)', async () => {
    const raw = createSchemaDb();
    seedFriend(raw);
    const res = await post(app, mkEnv(raw), { lineUserId: 'U_EXISTING', orderId: 'o1' });
    expect(res.status).toBe(200);
    expect(draftOrderCreateCalls()).toBe(1);
  });
});
