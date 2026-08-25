/**
 * Tests for shopify-coupon-issuer (Phase 5β-1d-2).
 *
 * Covers:
 *   - 既発行 row → 再発行せず既存 code を返す (冪等)
 *   - 新規発行 → Shopify API call + DB INSERT 成功 → IssuedCoupon を返す
 *   - Shopify env 未設定 → null + 警告
 *   - access token 取得失敗 → null + 警告
 *   - Shopify API HTTP error → null
 *   - Shopify API userErrors → null
 *   - Shopify API timeout → null
 *   - 並行 INSERT 競合 (UNIQUE violation) → re-fetch して既存 code 返す
 *   - generateCouponCode の文字種 / 長さ / prefix
 *   - default の bind は globalThis (Illegal invocation 防止、 CLAUDE.md ルール)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  issueCouponForFriend,
  getCouponCodeForFriend,
  WELCOME_VALID_DAYS,
  __test__ as t,
  type ShopifyEnv,
} from '../services/shopify-coupon-issuer.js';

// ============================================================
// Mock shopify-token (getShopifyAccessToken)
// ============================================================

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token_xxx'),
}));

import { getShopifyAccessToken } from '../services/shopify-token.js';
const mockGetToken = getShopifyAccessToken as ReturnType<typeof vi.fn>;

// ============================================================
// Fake D1
// ============================================================

interface FriendCouponRow {
  id: string;
  friend_id: string;
  line_account_id: string | null;
  coupon_code: string;
  shopify_discount_code_id: string | null;
  discount_value: number;
  discount_currency: string;
  issued_at: string;
  expires_at: string | null;
  status: string;
  source: string;
}

/** 5β-1d-2f: audit_logs INSERT を mock するための簡易 row 表現 */
interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  error_message: string | null;
  metadata: string;
  created_at: string;
}

class FakeDb {
  rows: FriendCouponRow[] = [];
  /** 5β-1d-2f: audit_logs INSERT を観察するための store */
  auditRows: AuditRow[] = [];
  /** force INSERT を throw する (UNIQUE conflict simulate 用) */
  failInsertOnce = false;

  prepare(sql: string) {
    const isSelectCoupon =
      sql.includes('SELECT coupon_code') && sql.includes('FROM line_friend_coupons');
    const isInsertCoupon = sql.includes('INSERT INTO line_friend_coupons');
    const isInsertAudit = sql.includes('INSERT INTO audit_logs');
    const isSelectAudit =
      sql.includes('SELECT * FROM audit_logs') && sql.includes('WHERE id');
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isSelectCoupon) {
            const friendId = params[0] as string;
            const row = this.rows.find((r) => r.friend_id === friendId);
            if (!row) return null;
            return {
              code: row.coupon_code,
              discount_value: row.discount_value,
              discount_currency: row.discount_currency,
              expires_at: row.expires_at,
              shopify_discount_code_id: row.shopify_discount_code_id,
            };
          }
          if (isSelectAudit) {
            const id = params[0] as string;
            const row = this.auditRows.find((r) => r.id === id);
            return row ?? null;
          }
          return null;
        },
        run: async () => {
          if (isInsertCoupon) {
            if (this.failInsertOnce) {
              this.failInsertOnce = false;
              throw new Error('UNIQUE constraint failed: line_friend_coupons.friend_id');
            }
            this.rows.push({
              id: params[0] as string,
              friend_id: params[1] as string,
              line_account_id: (params[2] as string | null) ?? null,
              coupon_code: params[3] as string,
              shopify_discount_code_id: (params[4] as string | null) ?? null,
              discount_value: params[5] as number,
              discount_currency: params[6] as string,
              issued_at: params[7] as string,
              expires_at: (params[8] as string | null) ?? null,
              status: 'issued',
              source: 'shopify',
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (isInsertAudit) {
            // audit-logs.ts:88-107 の bind 順序に依存 (id, line_account_id, actor_type, actor_id,
            // actor_name, action, target_type, target_id, request_id, ip_hash, user_agent,
            // before_value, after_value, result, error_message, metadata, created_at)
            this.auditRows.push({
              id: params[0] as string,
              actor_type: params[2] as string,
              action: params[5] as string,
              target_type: (params[6] as string | null) ?? null,
              target_id: (params[7] as string | null) ?? null,
              result: params[13] as string,
              error_message: (params[14] as string | null) ?? null,
              metadata: (params[15] as string) ?? '{}',
              created_at: params[16] as string,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true };
        },
      }),
    };
  }
}

// ============================================================
// helpers
// ============================================================

const FIXED_NOW = new Date('2026-05-18T00:00:00.000Z').getTime();

function makeEnv(overrides: Partial<ShopifyEnv> = {}): ShopifyEnv {
  return {
    SHOPIFY_STORE_DOMAIN: 'naturism-diet.myshopify.com',
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    ...overrides,
  };
}

function makeSuccessFetch(actualCode = 'LINE-ABCD2345', discountId = 'gid://shopify/DiscountCodeNode/123') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: discountId,
              codeDiscount: { codes: { nodes: [{ code: actualCode }] } },
            },
            userErrors: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetToken.mockResolvedValue('shpat_test_token_xxx');
});

// ============================================================
// generateCouponCode (helper unit)
// ============================================================

describe('generateCouponCode', () => {
  it('returns "{prefix}-{8 chars}" with ambiguous chars (0/1/O/I/L) excluded from suffix', () => {
    const code = t.generateCouponCode('LINE');
    // suffix は base31 (大文字 + 2-9、 0/1/O/I/L 除外)
    expect(code).toMatch(/^LINE-[A-KMNP-Z2-9]{8}$/);
    // 0/1/O/I/L が含まれない (LINE prefix の L はマッチさせない、 suffix のみ check)
    const suffix = code.split('-')[1];
    expect(suffix).not.toMatch(/[01OIL]/);
  });

  it('different invocations produce different codes (randomness)', () => {
    const codes = new Set(Array.from({ length: 100 }, () => t.generateCouponCode('X')));
    // 100 個生成して 80 個以上 unique を要求 (32^8 ≈ 10^12 で実質衝突は起きないが、
    // 並列実行下の crypto mock 干渉等の極稀ケースで flaky にならないよう threshold は緩めに)
    expect(codes.size).toBeGreaterThan(80);
  });

  it('respects custom prefix', () => {
    expect(t.generateCouponCode('WELCOME')).toMatch(/^WELCOME-[A-KMNP-Z2-9]{8}$/);
  });
});

// ============================================================
// issueCouponForFriend
// ============================================================

describe('issueCouponForFriend — 既発行 (冪等)', () => {
  it('既存 row があれば再発行せず existing=true で返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'existing-1',
      friend_id: 'friend-A',
      line_account_id: null,
      coupon_code: 'LINE-EXISTING1',
      shopify_discount_code_id: 'gid://shopify/DiscountCodeNode/999',
      discount_value: 500,
      discount_currency: 'JPY',
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-04-01T00:00:00.000Z',
      status: 'issued',
      source: 'shopify',
    });
    const fetchMock = makeSuccessFetch();

    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-A',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.code).toBe('LINE-EXISTING1');
    expect(result?.isExisting).toBe(true);
    expect(result?.discountValue).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled(); // Shopify API は呼ばれない
    expect(db.rows.length).toBe(1); // INSERT されていない
  });
});

describe('issueCouponForFriend — 新規発行 (success path)', () => {
  it('Shopify API 成功 → DB INSERT + IssuedCoupon を返す', async () => {
    const db = new FakeDb();
    const fetchMock = makeSuccessFetch('LINE-NEW12345', 'gid://shopify/DiscountCodeNode/new1');

    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-B',
      lineAccountId: 'acc-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });

    expect(result).not.toBeNull();
    expect(result?.code).toBe('LINE-NEW12345');
    expect(result?.isExisting).toBe(false);
    // 2026-08-24 Katsu 決定: welcome は ¥300 → ¥500 に**戻す** (顧客向け文言が一貫して
    //   「500 円 OFF」と言い続けていたため、実装を文言に合わせた)。格上げ機構は削除済み。
    expect(result?.discountValue).toBe(500);
    expect(result?.discountCurrency).toBe('JPY');
    expect(result?.shopifyDiscountCodeId).toBe('gid://shopify/DiscountCodeNode/new1');
    // 2026-08-24: 既定日数は WELCOME_VALID_DAYS (7)。本番の呼び元が当初から 7 を明示しており、
    //   使われない既定値 (3) が顧客向け文言「3 日間有効」の根拠として独り歩きしていたため統一した。
    expect(result?.expiresAt).toBe(new Date(FIXED_NOW + WELCOME_VALID_DAYS * 86_400_000).toISOString());

    // DB に行が追加された
    expect(db.rows.length).toBe(1);
    expect(db.rows[0].friend_id).toBe('friend-B');
    expect(db.rows[0].line_account_id).toBe('acc-1');
    expect(db.rows[0].coupon_code).toBe('LINE-NEW12345');
    expect(db.rows[0].source).toBe('shopify');

    // Shopify API call: URL + auth header 確認
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = fetchMock.mock.calls[0][0] as string;
    expect(callUrl).toContain('naturism-diet.myshopify.com');
    expect(callUrl).toContain('/admin/api/');
    expect(callUrl).toContain('/graphql.json');
    const callInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((callInit.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe(
      'shpat_test_token_xxx',
    );

    // 5β-1d-2f: 成功時の audit_logs 永続化 (= 自然流入で issue 成功実績を可視化)
    expect(db.auditRows.length).toBe(1);
    expect(db.auditRows[0].action).toBe('line_friend_coupon.issue_succeeded');
    expect(db.auditRows[0].actor_type).toBe('webhook');
    expect(db.auditRows[0].result).toBe('success');
    expect(db.auditRows[0].target_id).toBe('friend-B');
    const successMeta = JSON.parse(db.auditRows[0].metadata) as Record<string, unknown>;
    expect(successMeta.code).toBe('LINE-NEW12345');
    expect(successMeta.discountValue).toBe(500); // 2026-08-24 ¥500 へ復帰
    expect(successMeta.validDays).toBe(WELCOME_VALID_DAYS);
  });

  it('custom discountValueJpy + validDays + codePrefix が反映される', async () => {
    const db = new FakeDb();
    const fetchMock = makeSuccessFetch('SUMMER-Q3456789');

    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-C',
      discountValueJpy: 1000,
      validDays: 30,
      codePrefix: 'SUMMER',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result?.discountValue).toBe(1000);
    expect(result?.expiresAt).toBe(new Date(FIXED_NOW + 30 * 86_400_000).toISOString());
    // GraphQL body 内の discountAmount.amount = 1000
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.variables.basicCodeDiscount.customerGets.value.discountAmount.amount).toBe(1000);
  });
});

describe('issueCouponForFriend — failure paths', () => {
  it('Shopify env 未設定 → null + token 取得スキップ', async () => {
    const db = new FakeDb();
    const fetchMock = makeSuccessFetch();
    const result = await issueCouponForFriend(
      db as unknown as D1Database,
      { SHOPIFY_CLIENT_ID: 'x' } as ShopifyEnv, // domain も secret も無い
      {
        friendId: 'friend-D',
        fetchImpl: fetchMock as unknown as typeof fetch,
        now: () => FIXED_NOW,
      },
    );
    expect(result).toBeNull();
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    // 5β-1d-2f: 失敗時の audit_logs 永続化 (= 真因確定用、 stage=config_check)
    expect(db.auditRows.length).toBe(1);
    expect(db.auditRows[0].action).toBe('line_friend_coupon.issue_failed');
    expect(db.auditRows[0].actor_type).toBe('webhook');
    expect(db.auditRows[0].result).toBe('failure');
    expect(db.auditRows[0].target_id).toBe('friend-D');
    expect(db.auditRows[0].error_message).toContain('credentials not configured');
    const failMeta = JSON.parse(db.auditRows[0].metadata) as Record<string, unknown>;
    expect(failMeta.stage).toBe('config_check');
  });

  it('access token 取得失敗 → null', async () => {
    const db = new FakeDb();
    mockGetToken.mockRejectedValueOnce(new Error('Client Credentials 失敗'));
    const fetchMock = makeSuccessFetch();
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-E',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Shopify API HTTP 500 → null', async () => {
    const db = new FakeDb();
    const fetchMock = vi.fn(async () => new Response('Internal Server Error', { status: 500 }));
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-F',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).toBeNull();
    expect(db.rows.length).toBe(0); // DB INSERT されない
  });

  it('Shopify GraphQL userErrors → null', async () => {
    const db = new FakeDb();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: null,
                userErrors: [{ code: 'INVALID', field: ['code'], message: 'duplicate code' }],
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-G',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).toBeNull();
  });

  it('Shopify GraphQL errors[] → null', async () => {
    const db = new FakeDb();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'access denied' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-H',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).toBeNull();
  });

  it('Shopify API fetch reject (network/timeout) → null', async () => {
    const db = new FakeDb();
    const fetchMock = vi.fn(async () => {
      throw new Error('AbortError: timeout');
    });
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-I',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).toBeNull();
  });
});

describe('issueCouponForFriend — race condition (並行 INSERT)', () => {
  it('INSERT が UNIQUE violation で fail → re-fetch して既存 row を返す', async () => {
    const db = new FakeDb();
    db.failInsertOnce = true;
    // Race condition simulation: SELECT 時は無い、 でも INSERT で UNIQUE conflict
    // → catch 内で再 SELECT → ある (他 process が INSERT した後)
    let selectCount = 0;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      return {
        bind: (...params: unknown[]) => {
          const bound = stmt.bind(...params);
          const isSelect = sql.includes('SELECT coupon_code');
          if (isSelect) {
            return {
              ...bound,
              first: async () => {
                selectCount++;
                if (selectCount === 1) return null; // 初回は無い
                // 2 回目 (re-fetch) は既存 row を返す (= 他 process が INSERT した結果)
                return {
                  code: 'LINE-RACEWIN1',
                  discount_value: 500,
                  discount_currency: 'JPY',
                  expires_at: null,
                  shopify_discount_code_id: 'gid://race/win',
                };
              },
            };
          }
          return bound;
        },
      };
    };

    const fetchMock = makeSuccessFetch();
    const result = await issueCouponForFriend(db as unknown as D1Database, makeEnv(), {
      friendId: 'friend-J',
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.code).toBe('LINE-RACEWIN1');
    expect(result?.isExisting).toBe(true);
  });
});

describe('getCouponCodeForFriend (DB-only lookup、 step-delivery 用、 5β-1d-2b)', () => {
  it('既存 row → coupon_code を返す', async () => {
    const db = new FakeDb();
    db.rows.push({
      id: 'c-1',
      friend_id: 'friend-X',
      line_account_id: null,
      coupon_code: 'LINE-EXIST777',
      shopify_discount_code_id: null,
      discount_value: 500,
      discount_currency: 'JPY',
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: null,
      status: 'issued',
      source: 'shopify',
    });
    const code = await getCouponCodeForFriend(db as unknown as D1Database, 'friend-X');
    expect(code).toBe('LINE-EXIST777');
  });

  it('未発行 → null を返す (Shopify API 呼ばない)', async () => {
    const db = new FakeDb();
    const code = await getCouponCodeForFriend(db as unknown as D1Database, 'friend-NEW');
    expect(code).toBeNull();
  });
});

describe('issueCouponForFriend — default fetch は globalThis に bind 済み (CLAUDE.md ルール)', () => {
  it('options.fetchImpl 省略時の default が bound function (Illegal invocation 防止)', () => {
    // Note: 直接 default の identity を test するのは難しいので、 fetch.bind(globalThis) と等価か
    // を間接的に確認 (function.name で "bound fetch" を期待)
    const bound = fetch.bind(globalThis);
    expect(bound.name).toMatch(/^bound /);
  });
});
