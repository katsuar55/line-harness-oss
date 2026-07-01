/**
 * Tests for DMM ランク保持者 一括連携インポート — 第2波-③ 支援 (2026-07-02)
 *
 * Covers:
 *   service (processDmmRankImport):
 *     - dryRun (mutation なし) / 実行 (link + audit・email 非記録)
 *     - 照合: email 大小無視 / 表示名 完全一致 / 空白正規化一致 / lineUserId 最優先
 *     - 保守的 skip: no_customer / multiple_customers / no_friend / ambiguous_friend /
 *       friend_linked_other / customer_linked_other / already_linked (冪等)
 *     - payload 内重複 email / 不正 rank の無害化 / 1 entry 失敗の隔離
 *   route (POST /api/admin/account-link/import-dmm):
 *     - 401 / 400 (entries 不備・上限超過) / dryRun 既定 true / 実行モード
 *   route (POST /api/admin/account-link/backfill-linked):
 *     - MEMBER_BACKFILL_ENABLED 未設定 → gated no-op
 *     - happy path (0 注文でも skipped=false で完走し pending から抜ける)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { processDmmRankImport } from '../services/dmm-rank-import.js';
import { accountLinkAdmin } from '../routes/account-link-admin.js';

const API_KEY = 'test-api-key';

// ============================================================
// Programmable Fake D1 (SQL substring routing)
// ============================================================

interface CustomerRow {
  email: string;
  shopify_customer_id: string;
}
interface FriendRow {
  id: string;
  display_name: string;
  line_user_id?: string;
  shopify_customer_id: string | null;
}

function normalizeName(s: string): string {
  return s.replace(/[\s　]+/g, '');
}

class FakeDb {
  customers: CustomerRow[];
  friends: FriendRow[];
  auditInserts: unknown[][] = [];
  /** email をこの値にした entry の customer 検索で throw (隔離テスト用) */
  throwOnCustomerEmail: string | null = null;
  /** backfill-linked 用: shopify_tokens の応答 */
  tokenRow: { access_token: string; scope: string | null; expires_at: string } | null = null;

  constructor(opts: { customers?: CustomerRow[]; friends?: FriendRow[] } = {}) {
    this.customers = opts.customers ?? [];
    this.friends = opts.friends ?? [];
  }

  prepare(sql: string) {
    const self = this;
    return {
      bind(...params: unknown[]) {
        return {
          async all() {
            return { results: self.route(sql, params) };
          },
          async first() {
            const rows = self.route(sql, params);
            return rows.length > 0 ? rows[0] : null;
          },
          async run() {
            return self.runSql(sql, params);
          },
        };
      },
      // bind なしの first (無いはずだが安全側)
      async first() {
        const rows = self.route(sql, []);
        return rows.length > 0 ? rows[0] : null;
      },
    };
  }

  route(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    if (sql.includes('FROM shopify_customers')) {
      const email = String(params[0] ?? '').toLowerCase();
      if (this.throwOnCustomerEmail !== null && email === this.throwOnCustomerEmail) {
        throw new Error('transient D1 error');
      }
      const ids = [
        ...new Set(
          this.customers
            .filter((c) => c.email.toLowerCase() === email)
            .map((c) => c.shopify_customer_id),
        ),
      ];
      return ids.map((id) => ({ shopify_customer_id: id }));
    }
    if (sql.includes('WHERE line_user_id = ?')) {
      const uid = String(params[0] ?? '');
      return this.friends
        .filter((f) => f.line_user_id === uid)
        .map((f) => ({ id: f.id, shopify_customer_id: f.shopify_customer_id }));
    }
    if (sql.includes('WHERE display_name = ?')) {
      const name = String(params[0] ?? '');
      return this.friends
        .filter((f) => f.display_name === name)
        .map((f) => ({ id: f.id, shopify_customer_id: f.shopify_customer_id }));
    }
    if (sql.includes("REPLACE(REPLACE(display_name")) {
      const normalized = String(params[0] ?? '');
      return this.friends
        .filter((f) => normalizeName(f.display_name) === normalized)
        .map((f) => ({ id: f.id, shopify_customer_id: f.shopify_customer_id }));
    }
    if (sql.includes('SELECT * FROM friends WHERE shopify_customer_id = ?')) {
      const cid = String(params[0] ?? '');
      return this.friends.filter((f) => f.shopify_customer_id === cid) as unknown as Array<
        Record<string, unknown>
      >;
    }
    if (sql.includes('FROM shopify_tokens')) {
      return this.tokenRow ? [this.tokenRow] : [];
    }
    if (sql.includes('COUNT(*) AS n') && sql.includes('NOT EXISTS')) {
      return [{ n: this.pendingFriends().length }];
    }
    if (sql.includes('NOT EXISTS') && sql.includes('SELECT f.id')) {
      const limit = Number(params[0] ?? 10);
      return this.pendingFriends()
        .slice(0, limit)
        .map((f) => ({ id: f.id, shopify_customer_id: f.shopify_customer_id }));
    }
    if (sql.includes('WHERE id IN (')) {
      const ids = params.map(String);
      return this.friends
        .filter((f) => ids.includes(f.id) && f.shopify_customer_id !== null)
        .map((f) => ({ id: f.id, shopify_customer_id: f.shopify_customer_id }));
    }
    if (sql.includes('FROM audit_logs') && sql.includes('WHERE id')) {
      // insertAuditLog の readback
      return [{ id: String(params[0] ?? 'audit') }];
    }
    return [];
  }

  pendingFriends(): FriendRow[] {
    // 簡略化: 連携済 friend 全員を pending とみなす (purchase events / 成功 audit なし想定)
    return this.friends.filter((f) => f.shopify_customer_id !== null);
  }

  runSql(sql: string, params: unknown[]): { success: boolean; meta: { changes: number } } {
    if (sql.includes('UPDATE friends SET shopify_customer_id')) {
      const [customerId, , friendId] = params;
      const f = this.friends.find((x) => x.id === friendId);
      if (f && f.shopify_customer_id === null) {
        f.shopify_customer_id = String(customerId);
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes('INSERT INTO audit_logs')) {
      this.auditInserts.push(params);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

function baseFixture(): { customers: CustomerRow[]; friends: FriendRow[] } {
  return {
    customers: [
      { email: 'tanaka@example.com', shopify_customer_id: '1001' },
      { email: 'aco@example.com', shopify_customer_id: '1002' },
      { email: 'dup@example.com', shopify_customer_id: '2001' },
      { email: 'dup@example.com', shopify_customer_id: '2002' },
      { email: 'hirayama@example.com', shopify_customer_id: '1003' },
    ],
    friends: [
      { id: 'f-tanaka', display_name: '田中照美', shopify_customer_id: null },
      { id: 'f-aco-1', display_name: 'aco', shopify_customer_id: null },
      { id: 'f-aco-2', display_name: 'aco', shopify_customer_id: null },
      { id: 'f-hirayama', display_name: 'Yuka Hirayama', shopify_customer_id: null },
      { id: 'f-linked', display_name: '連携済', line_user_id: 'U-linked', shopify_customer_id: '9999' },
    ],
  };
}

// ============================================================
// service: processDmmRankImport
// ============================================================

describe('processDmmRankImport', () => {
  it('dryRun: linkable を返し、 mutation も audit も発生しない', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美', legacyRank: 'gold' }],
      { dryRun: true },
    );
    expect(out.dryRun).toBe(true);
    expect(out.results[0].status).toBe('linkable');
    expect(out.results[0].friendId).toBe('f-tanaka');
    expect(out.results[0].customerId).toBe('1001');
    expect(out.summary.linkable).toBe(1);
    // mutation なし
    expect(db.friends.find((f) => f.id === 'f-tanaka')?.shopify_customer_id).toBeNull();
    expect(db.auditInserts.length).toBe(0);
  });

  it('実行: link + audit (metadata に legacyRank あり・email なし)', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美', legacyRank: 'gold' }],
      { dryRun: false },
    );
    expect(out.results[0].status).toBe('linked');
    expect(db.friends.find((f) => f.id === 'f-tanaka')?.shopify_customer_id).toBe('1001');
    expect(db.auditInserts.length).toBe(1);
    // insertAuditLog bind 順: [..., action(5), target_type(6), target_id(7), ..., metadata(15), ...]
    expect(db.auditInserts[0][5]).toBe('account_link.dmm_import');
    const metadata = String(db.auditInserts[0][15]);
    expect(metadata).toContain('"legacyRank":"gold"');
    expect(metadata).toContain('"shopifyCustomerId":"1001"');
    expect(metadata).not.toContain('example.com'); // PII 最小化: email を audit に残さない
  });

  it('email は大文字小文字を無視して customer に一致する', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'Tanaka@Example.COM', displayName: '田中照美' }],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('linkable');
  });

  it('空白ゆれは正規化一致で救う (matchedBy=display_name_normalized)', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      // CSV 側は二重スペース、 friend 側は単一スペース
      [{ email: 'hirayama@example.com', displayName: 'Yuka  Hirayama' }],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('linkable');
    expect(out.results[0].matchedBy).toBe('display_name_normalized');
    expect(out.results[0].friendId).toBe('f-hirayama');
  });

  it('lineUserId があれば表示名より優先して一意に解決する', async () => {
    const fx = baseFixture();
    fx.friends.push({ id: 'f-uid', display_name: 'aco', line_user_id: 'U-aco-1', shopify_customer_id: null });
    const db = new FakeDb(fx);
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      // displayName 'aco' は 3 人いるが lineUserId で一意
      [{ email: 'aco@example.com', displayName: 'aco', lineUserId: 'U-aco-1' }],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('linkable');
    expect(out.results[0].friendId).toBe('f-uid');
    expect(out.results[0].matchedBy).toBe('line_user_id');
  });

  it('ambiguous_friend: 同名 friend が複数なら自動連携しない (誤連携防止)', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'aco@example.com', displayName: 'aco' }],
      { dryRun: false },
    );
    expect(out.results[0].status).toBe('ambiguous_friend');
    expect(db.friends.every((f) => f.id.startsWith('f-aco') ? f.shopify_customer_id === null : true)).toBe(true);
    expect(db.auditInserts.length).toBe(0);
  });

  it('no_customer / no_friend / multiple_customers を正しく分類する', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [
        { email: 'unknown@example.com', displayName: '田中照美' },
        { email: 'tanaka@example.com', displayName: '存在しない名前' },
        { email: 'dup@example.com', displayName: '田中照美' },
      ],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('no_customer');
    expect(out.results[1].status).toBe('no_friend');
    expect(out.results[2].status).toBe('multiple_customers');
  });

  it('already_linked: 同一 customer に連携済なら冪等 no-op', async () => {
    const fx = baseFixture();
    fx.friends[0].shopify_customer_id = '1001';
    const db = new FakeDb(fx);
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美' }],
      { dryRun: false },
    );
    expect(out.results[0].status).toBe('already_linked');
    expect(db.auditInserts.length).toBe(0);
  });

  it('friend_linked_other: friend が別 customer に連携済なら上書きしない', async () => {
    const fx = baseFixture();
    fx.friends[0].shopify_customer_id = '8888';
    const db = new FakeDb(fx);
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美' }],
      { dryRun: false },
    );
    expect(out.results[0].status).toBe('friend_linked_other');
    expect(db.friends[0].shopify_customer_id).toBe('8888');
  });

  it('customer_linked_other: customer が別 friend に連携済なら link しない (UNIQUE 事前回避)', async () => {
    const fx = baseFixture();
    fx.friends.push({ id: 'f-owner', display_name: '別人', shopify_customer_id: '1001' });
    const db = new FakeDb(fx);
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美' }],
      { dryRun: false },
    );
    expect(out.results[0].status).toBe('customer_linked_other');
    expect(db.friends.find((f) => f.id === 'f-tanaka')?.shopify_customer_id).toBeNull();
  });

  it('payload 内の重複 email は 2 件目以降 invalid', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [
        { email: 'tanaka@example.com', displayName: '田中照美' },
        { email: 'TANAKA@example.com', displayName: '田中照美' },
      ],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('linkable');
    expect(out.results[1].status).toBe('invalid');
  });

  it('不正な legacyRank は null に落として処理は続行する', async () => {
    const db = new FakeDb(baseFixture());
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [{ email: 'tanaka@example.com', displayName: '田中照美', legacyRank: 'ダイヤモンド' }],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('linkable');
    expect(out.results[0].legacyRank).toBeNull();
  });

  it('1 entry の D1 失敗は error として隔離し他 entry を処理する', async () => {
    const db = new FakeDb(baseFixture());
    db.throwOnCustomerEmail = 'boom@example.com';
    const out = await processDmmRankImport(
      db as unknown as D1Database,
      [
        { email: 'boom@example.com', displayName: 'X' },
        { email: 'tanaka@example.com', displayName: '田中照美' },
      ],
      { dryRun: true },
    );
    expect(out.results[0].status).toBe('error');
    expect(out.results[1].status).toBe('linkable');
  });
});

// ============================================================
// routes
// ============================================================

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', accountLinkAdmin);
  return app;
}

function postJson(app: Hono, path: string, body: unknown, env: Record<string, unknown>, withAuth = true) {
  return app.request(
    `http://localhost${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(withAuth ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('POST /api/admin/account-link/import-dmm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requires auth (401)', async () => {
    const app = createApp();
    const res = await postJson(app, '/api/admin/account-link/import-dmm', { entries: [] }, { DB: new FakeDb() }, false);
    expect(res.status).toBe(401);
  });

  it('rejects missing/oversized entries (400)', async () => {
    const app = createApp();
    const res1 = await postJson(app, '/api/admin/account-link/import-dmm', {}, { DB: new FakeDb() });
    expect(res1.status).toBe(400);
    const res2 = await postJson(
      app,
      '/api/admin/account-link/import-dmm',
      { entries: Array.from({ length: 51 }, () => ({ email: 'a@b.c' })) },
      { DB: new FakeDb() },
    );
    expect(res2.status).toBe(400);
  });

  it('dryRun 既定 true (dryRun 未指定なら書込しない)', async () => {
    const app = createApp();
    const db = new FakeDb(baseFixture());
    const res = await postJson(
      app,
      '/api/admin/account-link/import-dmm',
      { entries: [{ email: 'tanaka@example.com', displayName: '田中照美' }] },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { dryRun: boolean; results: Array<{ status: string }> } };
    expect(json.data.dryRun).toBe(true);
    expect(json.data.results[0].status).toBe('linkable');
    expect(db.friends.find((f) => f.id === 'f-tanaka')?.shopify_customer_id).toBeNull();
  });

  it('dryRun:false で実際に link する', async () => {
    const app = createApp();
    const db = new FakeDb(baseFixture());
    const res = await postJson(
      app,
      '/api/admin/account-link/import-dmm',
      { dryRun: false, entries: [{ email: 'tanaka@example.com', displayName: '田中照美', legacyRank: 'gold' }] },
      { DB: db },
    );
    const json = (await res.json()) as { data: { dryRun: boolean; results: Array<{ status: string }> } };
    expect(json.data.dryRun).toBe(false);
    expect(json.data.results[0].status).toBe('linked');
    expect(db.friends.find((f) => f.id === 'f-tanaka')?.shopify_customer_id).toBe('1001');
  });
});

describe('POST /api/admin/account-link/backfill-linked', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('MEMBER_BACKFILL_ENABLED 未設定なら gated no-op', async () => {
    const app = createApp();
    const res = await postJson(app, '/api/admin/account-link/backfill-linked', {}, { DB: new FakeDb() });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { gated?: boolean } };
    expect(json.data.gated).toBe(true);
  });

  it('happy path: 0 注文でも skipped=false で完走し remaining が減る', async () => {
    const app = createApp();
    const fx = baseFixture();
    const db = new FakeDb(fx);
    db.tokenRow = {
      access_token: 'shpat_test',
      scope: 'read_orders',
      expires_at: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const res = await postJson(
      app,
      '/api/admin/account-link/backfill-linked',
      { limit: 1 },
      {
        DB: db,
        MEMBER_BACKFILL_ENABLED: 'true',
        SHOPIFY_STORE_DOMAIN: 'test.myshopify.com',
        SHOPIFY_CLIENT_ID: 'cid',
        SHOPIFY_CLIENT_SECRET: 'csec',
      },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: {
        processed: Array<{ skipped: boolean; backfilled: number; friendId: string }>;
        pendingBefore: number;
        remaining: number;
      };
    };
    expect(json.data.processed.length).toBe(1);
    expect(json.data.processed[0].skipped).toBe(false);
    expect(json.data.processed[0].backfilled).toBe(0);
    expect(json.data.remaining).toBe(json.data.pendingBefore - 1);
  });
});
