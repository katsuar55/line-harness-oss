/**
 * Tests for account-link service (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * email OTP 本人確認フローのオーケストレーションを検証:
 *   - requestAccountLinkCode: gate / misconfig / email 形式 / 既 link / rate-limit / 発行+送信 / 送信失敗
 *   - verifyAccountLinkCode: gate / 形式 / 既 link / no_code / locked / 誤コード(試行++ )/ 一致→link /
 *     customer_not_found / customer_conflict / shopify_error / metafield・backfill best-effort / single-use
 *
 * getShopifyAccessToken は vi.mock (= 静的 import のみ、 dynamic import 干渉トラップなし)。
 * Shopify 引当 / metafield / backfill は dep 注入で isolate (= 各々 別ファイルで test 済)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test_token'),
}));

import { getShopifyAccessToken } from '../services/shopify-token.js';
import {
  requestAccountLinkCode,
  verifyAccountLinkCode,
  type AccountLinkEnv,
} from '../services/account-link.js';
import type { backfillCustomerOrders } from '../services/member-purchase-backfill.js';

const mockedGetToken = vi.mocked(getShopifyAccessToken);

// ============================================================
// combined fake D1 (friends + account_link_codes、 audit は no-op)
// ============================================================

interface FFriend {
  id: string;
  line_user_id: string;
  shopify_customer_id: string | null;
}
interface FCode {
  id: string;
  friend_id: string;
  email: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
  created_at: string;
}

function makeDb(
  friends: FFriend[] = [],
  opts: { linkBehavior?: 'ok' | 'changes0' | 'throw' } = {},
): D1Database & { friends: FFriend[]; codes: FCode[]; sqls: string[]; binds: Array<{ sql: string; args: unknown[] }> } {
  const linkBehavior = opts.linkBehavior ?? 'ok';
  const f = friends.map((x) => ({ ...x }));
  const codes: FCode[] = [];
  // 実行された SQL の記録。「呼ばれていないこと」を観測できないと、
  // 逆方向リンク (shopify_orders.friend_id) の欠落のような **無言の欠陥** が素通りする。
  const sqls: string[] = [];
  // bind 値も記録する: SQL の存在だけだと引数の入れ違い (customerId と friendId を逆に渡す)
  // を検出できず、**他人の注文を紐付ける**変異が生き残る (採点ループ HIGH)。
  const binds: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    friends: f,
    codes,
    sqls,
    binds,
    prepare(sql: string) {
      sqls.push(sql);
      const stmt = {
        _b: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._b = args;
          binds.push({ sql, args });
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          // audit_logs read-back (= insertAuditLog が INSERT 後に読み戻す。 best-effort なので stub で十分)
          if (sql.includes('FROM audit_logs')) {
            return { id: stmt._b[0] } as unknown as T;
          }
          if (sql.includes('account_link_codes') && sql.includes('COUNT(*)')) {
            const [friendId, since] = stmt._b as [string, string];
            return { count: codes.filter((c) => c.friend_id === friendId && c.created_at >= since).length } as unknown as T;
          }
          if (sql.includes('UPDATE account_link_codes') && sql.includes('RETURNING attempts')) {
            const id = stmt._b[0] as string;
            const c = codes.find((x) => x.id === id);
            if (c) { c.attempts += 1; return { attempts: c.attempts } as unknown as T; }
            return null;
          }
          if (sql.includes('SELECT * FROM account_link_codes')) {
            const [friendId, email, now] = stmt._b as [string, string, string];
            const m = codes
              .filter((c) => c.friend_id === friendId && c.email === email && c.consumed_at === null && c.expires_at > now)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            return (m[0] ? { ...m[0] } : null) as unknown as T | null;
          }
          if (sql.includes('FROM friends') && sql.includes('shopify_customer_id = ?')) {
            const cid = stmt._b[0] as string;
            const fr = f.find((x) => x.shopify_customer_id === cid);
            return (fr ? { ...fr } : null) as unknown as T | null;
          }
          if (sql.includes('FROM friends') && sql.includes('WHERE id = ?')) {
            const id = stmt._b[0] as string;
            const fr = f.find((x) => x.id === id);
            return (fr ? { ...fr } : null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          if (sql.includes('INSERT INTO account_link_codes')) {
            const [id, friendId, email, codeHash, expiresAt, createdAt] = stmt._b as [
              string, string, string, string, string, string,
            ];
            codes.push({
              id, friend_id: friendId, email, code_hash: codeHash,
              expires_at: expiresAt, attempts: 0, consumed_at: null, created_at: createdAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('account_link_codes') && sql.includes('SET consumed_at = ?') && sql.includes('WHERE id = ?')) {
            const [consumedAt, id] = stmt._b as [string, string];
            const c = codes.find((x) => x.id === id && x.consumed_at === null);
            if (c) { c.consumed_at = consumedAt; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes('account_link_codes') && sql.includes('SET consumed_at = ?') && sql.includes('friend_id = ?')) {
            const [consumedAt, friendId, email] = stmt._b as [string, string, string];
            let changes = 0;
            for (const c of codes) {
              if (c.friend_id === friendId && c.email === email && c.consumed_at === null) {
                c.consumed_at = consumedAt;
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          if (sql.includes('UPDATE friends') && sql.includes('shopify_customer_id IS NULL')) {
            // race シミュレーション: changes0 = 並行 link 済 (linked=false)、 throw = UNIQUE 違反
            if (linkBehavior === 'throw') throw new Error('UNIQUE constraint failed: friends.shopify_customer_id');
            if (linkBehavior === 'changes0') return { success: true, meta: { changes: 0 } };
            const cid = stmt._b[0] as string;
            const id = stmt._b[2] as string;
            const fr = f.find((x) => x.id === id && x.shopify_customer_id === null);
            if (fr) { fr.shopify_customer_id = cid; return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 0 } }; // audit_logs INSERT 等 no-op
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { friends: FFriend[]; codes: FCode[]; sqls: string[]; binds: Array<{ sql: string; args: unknown[] }> };
}

// ============================================================
// fixtures
// ============================================================

const FRIEND_ID = 'friend-1';
const LINE_ID = 'U_alice';
const EMAIL = 'alice@x.com';

function baseEnv(over: Partial<AccountLinkEnv> = {}): AccountLinkEnv {
  return {
    DB: undefined as unknown as D1Database, // 各 test で差し替え
    ACCOUNT_LINK_ENABLED: 'true',
    ACCOUNT_LINK_HMAC_KEY: 'pepper-secret-key-xxxxxxxxxxxxxxxx',
    SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
    SHOPIFY_CLIENT_ID: 'cid',
    SHOPIFY_CLIENT_SECRET: 'csec',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'naturism <noreply@mail.naturism-diet.com>',
    ...over,
  };
}

const NOW = Date.parse('2026-06-06T10:00:00.000Z');
const okBackfill = (backfilled: number): typeof backfillCustomerOrders =>
  vi.fn(async () => ({
    skipped: false, scanned: backfilled, backfilled, alreadyApplied: 0, errors: 0,
    totalJpy: backfilled * 1000, capped: false,
  })) as unknown as typeof backfillCustomerOrders;

beforeEach(() => {
  mockedGetToken.mockClear();
  mockedGetToken.mockResolvedValue('shpat_test_token');
});

// ============================================================
// requestAccountLinkCode
// ============================================================

describe('requestAccountLinkCode', () => {
  it('disabled (ACCOUNT_LINK_ENABLED!=true) → code 発行も送信もしない', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const send = vi.fn();
    const r = await requestAccountLinkCode(
      { ...baseEnv({ ACCOUNT_LINK_ENABLED: undefined }), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL },
      { sendEmailImpl: send },
    );
    expect(r).toEqual({ ok: false, code: 'disabled' });
    expect(db.codes).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('HMAC key 未設定 → misconfigured', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await requestAccountLinkCode(
      { ...baseEnv({ ACCOUNT_LINK_HMAC_KEY: undefined }), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL }, {},
    );
    expect(r).toEqual({ ok: false, code: 'misconfigured' });
  });

  it('RESEND/EMAIL_FROM 未設定 → misconfigured', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await requestAccountLinkCode(
      { ...baseEnv({ EMAIL_FROM: undefined }), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL }, {},
    );
    expect(r).toEqual({ ok: false, code: 'misconfigured' });
  });

  it('不正 email → invalid_email (送信なし)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const send = vi.fn();
    const r = await requestAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: 'not-an-email' },
      { sendEmailImpl: send },
    );
    expect(r).toEqual({ ok: false, code: 'invalid_email' });
    expect(send).not.toHaveBeenCalled();
  });

  it('既 link 済 friend → already_linked (送信なし)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: '999' }]);
    const send = vi.fn();
    const r = await requestAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL },
      { sendEmailImpl: send },
    );
    expect(r).toEqual({ ok: false, code: 'already_linked' });
    expect(send).not.toHaveBeenCalled();
  });

  it('rate-limit 超過 → rate_limited (送信なし)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    // 直近窓に 5 件 seed
    for (let i = 0; i < 5; i++) {
      db.codes.push({
        id: `seed${i}`, friend_id: FRIEND_ID, email: EMAIL, code_hash: 'h',
        expires_at: '2026-06-06T10:05:00.000Z', attempts: 0, consumed_at: null,
        created_at: '2026-06-06T09:50:00.000Z',
      });
    }
    const send = vi.fn();
    const r = await requestAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL },
      { now: () => NOW, sendEmailImpl: send },
    );
    expect(r).toEqual({ ok: false, code: 'rate_limited' });
    expect(send).not.toHaveBeenCalled();
  });

  it('happy: 旧 code 無効化 + hash 発行 + email 送信 (= 平文非保存)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    // 旧 active code (= 無効化対象)
    db.codes.push({
      id: 'old', friend_id: FRIEND_ID, email: EMAIL, code_hash: 'oldhash',
      expires_at: '2026-06-06T10:05:00.000Z', attempts: 0, consumed_at: null,
      created_at: '2026-06-06T09:00:00.000Z',
    });
    let sentTo = '', sentCode = '';
    const send = vi.fn(async (_env, to: string, code: string) => { sentTo = to; sentCode = code; });
    const r = await requestAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: 'Alice@X.com' },
      { now: () => NOW, sendEmailImpl: send, generateCodeImpl: () => '123456' },
    );
    expect(r).toEqual({ ok: true });
    expect(sentTo).toBe('alice@x.com'); // lowercased
    expect(sentCode).toBe('123456');
    // 旧 code は無効化済
    expect(db.codes.find((c) => c.id === 'old')?.consumed_at).not.toBeNull();
    // 新 code は平文非保存 (hash) + active
    const fresh = db.codes.find((c) => c.id !== 'old');
    expect(fresh?.consumed_at).toBeNull();
    expect(fresh?.code_hash).not.toBe('123456');
    expect(fresh?.code_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('送信失敗 → email_failed (code は発行済だが失効待ち)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const send = vi.fn(async () => { throw new Error('resend down'); });
    const r = await requestAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL },
      { now: () => NOW, sendEmailImpl: send, generateCodeImpl: () => '123456' },
    );
    expect(r).toEqual({ ok: false, code: 'email_failed' });
    expect(db.codes).toHaveLength(1); // 発行はされている
  });
});

// ============================================================
// verifyAccountLinkCode
// ============================================================

/** request → 同じ email/code で seed して verify できる状態を作る helper。 */
async function seedCode(db: D1Database, env: AccountLinkEnv, code = '123456'): Promise<void> {
  await requestAccountLinkCode(
    env,
    { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL },
    { now: () => NOW, sendEmailImpl: vi.fn(), generateCodeImpl: () => code },
  );
}

describe('verifyAccountLinkCode', () => {
  it('disabled → disabled', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await verifyAccountLinkCode(
      { ...baseEnv({ ACCOUNT_LINK_ENABLED: undefined }), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
    );
    expect(r).toEqual({ ok: false, code: 'disabled' });
  });

  it('Shopify creds 未設定 → misconfigured', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await verifyAccountLinkCode(
      { ...baseEnv({ SHOPIFY_CLIENT_SECRET: undefined }), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
    );
    expect(r).toEqual({ ok: false, code: 'misconfigured' });
  });

  it('6桁でない code → invalid_code (DB に触れない)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await verifyAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '12ab' },
    );
    expect(r).toEqual({ ok: false, code: 'invalid_code' });
  });

  it('既 link 済 → already_linked', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: '999' }]);
    const r = await verifyAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
    );
    expect(r).toEqual({ ok: false, code: 'already_linked' });
  });

  it('active code なし → no_code', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const r = await verifyAccountLinkCode(
      { ...baseEnv(), DB: db },
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW },
    );
    expect(r).toEqual({ ok: false, code: 'no_code' });
  });

  it('試行回数超過 → locked + code 消費', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    db.codes[0].attempts = 5; // MAX
    const r = await verifyAccountLinkCode(
      env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' }, { now: () => NOW },
    );
    expect(r).toEqual({ ok: false, code: 'locked' });
    expect(db.codes[0].consumed_at).not.toBeNull();
  });

  it('誤コード → invalid_code + attempts++ + attemptsRemaining', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '000000' }, { now: () => NOW },
    );
    expect(r).toEqual({ ok: false, code: 'invalid_code', attemptsRemaining: 4 });
    expect(db.codes[0].attempts).toBe(1);
    expect(db.codes[0].consumed_at).toBeNull(); // まだ lock しない
  });

  it('一致 → customer 引当 + link + metafield + backfill + 成功', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const findCustomer = vi.fn(async () => ({ customerId: '777' }));
    const setMetafield = vi.fn(async () => ({ ok: true, userErrors: [] as string[] }));
    const backfill = okBackfill(2);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: findCustomer, setMetafieldImpl: setMetafield, backfillImpl: backfill },
    );
    expect(r).toEqual({ ok: true, customerId: '777', backfilled: 2, metafieldWritten: true });
    expect(db.friends[0].shopify_customer_id).toBe('777');
    expect(db.codes[0].consumed_at).not.toBeNull(); // single-use 消費
    // metafield は friend の lineUserId で書く
    expect(setMetafield).toHaveBeenCalledWith('shop.myshopify.com', 'shpat_test_token', '777', 'naturism', 'line_user_id', LINE_ID, expect.anything());
    // backfill は customerId/friendId/token を再利用
    const bfArgs = (backfill as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { customerId: string; friendId: string; accessToken: string };
    expect(bfArgs).toMatchObject({ customerId: '777', friendId: FRIEND_ID, accessToken: 'shpat_test_token' });
  });

  it('customer 見つからない → customer_not_found (code は消費済)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => null) },
    );
    expect(r).toEqual({ ok: false, code: 'customer_not_found' });
    expect(db.friends[0].shopify_customer_id).toBeNull();
    expect(db.codes[0].consumed_at).not.toBeNull(); // 消費済 (= 再リクエスト要)
  });

  it('別 friend に既 link の customer → customer_conflict (link せず)', async () => {
    const db = makeDb([
      { id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null },
      { id: 'other', line_user_id: 'U_bob', shopify_customer_id: '777' },
    ]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => ({ customerId: '777' })) },
    );
    expect(r).toEqual({ ok: false, code: 'customer_conflict' });
    expect(db.friends[0].shopify_customer_id).toBeNull();
  });

  it('access token 取得失敗 → shopify_error (= transient: code は消費しない、 再試行可)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    mockedGetToken.mockRejectedValueOnce(new Error('no token'));
    const r = await verifyAccountLinkCode(
      env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' }, { now: () => NOW },
    );
    expect(r).toEqual({ ok: false, code: 'shopify_error' });
    expect(db.codes[0].consumed_at).toBeNull(); // 焼かない (= H1 fix)
  });

  it('customer 引当が throw (Shopify 障害) → shopify_error (= transient: code は消費しない)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => { throw new Error('throttled'); }) },
    );
    expect(r).toEqual({ ok: false, code: 'shopify_error' });
    expect(db.codes[0].consumed_at).toBeNull(); // 焼かない (= H1 fix)
  });

  it('誤コードを試行上限まで → 最終誤りで locked + 消費 (= atomic 加算)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    db.codes[0].attempts = 4; // あと 1 回で上限
    const r = await verifyAccountLinkCode(
      env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '000000' }, { now: () => NOW },
    );
    expect(r).toEqual({ ok: false, code: 'locked' });
    expect(db.codes[0].attempts).toBe(5);
    expect(db.codes[0].consumed_at).not.toBeNull();
  });

  it('link CAS 競合 (changes=0) → already_linked + 消費 (= 並行 link 済)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }], { linkBehavior: 'changes0' });
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => ({ customerId: '777' })) },
    );
    expect(r).toEqual({ ok: false, code: 'already_linked' });
    expect(db.codes[0].consumed_at).not.toBeNull();
  });

  it('UNIQUE 違反 throw (TOCTOU) → customer_conflict + 消費', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }], { linkBehavior: 'throw' });
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => ({ customerId: '777' })) },
    );
    expect(r).toEqual({ ok: false, code: 'customer_conflict' });
    expect(db.codes[0].consumed_at).not.toBeNull();
  });

  it('metafield 失敗は best-effort (= link は成功、 metafieldWritten=false)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      {
        now: () => NOW,
        findCustomerImpl: vi.fn(async () => ({ customerId: '777' })),
        setMetafieldImpl: vi.fn(async () => { throw new Error('metafield down'); }),
        backfillImpl: okBackfill(0),
      },
    );
    expect(r).toMatchObject({ ok: true, customerId: '777', metafieldWritten: false });
    expect(db.friends[0].shopify_customer_id).toBe('777'); // link は成立
  });

  it('backfill 失敗は best-effort (= link は成功、 backfilled=0)', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      {
        now: () => NOW,
        findCustomerImpl: vi.fn(async () => ({ customerId: '777' })),
        setMetafieldImpl: vi.fn(async () => ({ ok: true, userErrors: [] as string[] })),
        backfillImpl: vi.fn(async () => { throw new Error('orders down'); }) as unknown as typeof backfillCustomerOrders,
      },
    );
    expect(r).toMatchObject({ ok: true, customerId: '777', backfilled: 0 });
    expect(db.friends[0].shopify_customer_id).toBe('777');
  });

  // 🚨 2026-08-28 修正の回帰テスト。
  //    OTP 経路は friends.shopify_customer_id を埋めるだけで linkShopifyCustomerToFriend を
  //    呼んでおらず、shopify_orders.friend_id / shopify_customers.friend_id が NULL のままだった。
  //    注文一覧は `FROM shopify_orders WHERE friend_id = ?` で引く (routes/liff-portal.ts) ので、
  //    メール OTP で連携した顧客には注文が 1 件も出ない = ホーム CTA の
  //    「ご注文の状況確認や、過去のご注文からの再注文もこの画面でできるようになります」が嘘になっていた。
  it('🚨 連携成立時に逆方向リンク (shopify_customers / shopify_orders の friend_id) も埋める', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      {
        now: () => NOW,
        findCustomerImpl: vi.fn(async () => ({ customerId: '777' })),
        setMetafieldImpl: vi.fn(async () => ({ ok: true, userErrors: [] as string[] })),
        backfillImpl: okBackfill(1),
      },
    );
    expect(r.ok).toBe(true);
    // 観測点は「その SQL が実行されたこと」— 状態だけ見ると fake が飲んで素通りする
    expect(db.sqls.some((q) => q.includes('UPDATE shopify_customers SET friend_id'))).toBe(true);
    expect(db.sqls.some((q) => q.includes('UPDATE shopify_orders SET friend_id'))).toBe(true);
    // 🚨 SQL の存在だけでは引数の入れ違いを検出できない (採点ループ HIGH)。
    //    linkShopifyCustomerToFriend(db, shopifyCustomerId, friendId) の順を逆にすると
    //    **他人の注文を紐付ける**ので、bind 値まで観測する。
    const bind = db.binds.find((b) => b.sql.includes('UPDATE shopify_orders SET friend_id'));
    expect(bind, 'shopify_orders の bind が記録されていない').toBeDefined();
    expect(bind!.args[0], 'friend_id に friendId が入ること').toBe(FRIEND_ID);
    expect(bind!.args[1], 'WHERE には customerId が入ること').toBe('777');
  });

  it('連携しなかったとき (customer 不在) は逆方向リンクを呼ばない', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env);
    const r = await verifyAccountLinkCode(
      env,
      { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '123456' },
      { now: () => NOW, findCustomerImpl: vi.fn(async () => null) },
    );
    expect(r).toEqual({ ok: false, code: 'customer_not_found' });
    expect(db.sqls.some((q) => q.includes('UPDATE shopify_orders SET friend_id'))).toBe(false);
  });

  it('end-to-end: request → verify(正コード) で linked、 再 verify は already_linked', async () => {
    const db = makeDb([{ id: FRIEND_ID, line_user_id: LINE_ID, shopify_customer_id: null }]);
    const env = { ...baseEnv(), DB: db };
    await seedCode(db, env, '654321');
    const deps = {
      now: () => NOW,
      findCustomerImpl: vi.fn(async () => ({ customerId: '888' })),
      setMetafieldImpl: vi.fn(async () => ({ ok: true, userErrors: [] as string[] })),
      backfillImpl: okBackfill(1),
    };
    const r1 = await verifyAccountLinkCode(env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '654321' }, deps);
    expect(r1.ok).toBe(true);
    // 2 回目 (同じ消費済 code) → 既 link で弾く
    const r2 = await verifyAccountLinkCode(env, { friendId: FRIEND_ID, lineUserId: LINE_ID, email: EMAIL, code: '654321' }, deps);
    expect(r2).toEqual({ ok: false, code: 'already_linked' });
  });
});
