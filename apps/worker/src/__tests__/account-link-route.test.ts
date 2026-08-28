/**
 * Tests for routes/liff-account-link (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * route の責務 (= auth context / JSON / Zod / service 結果→HTTP マッピング) を検証。
 * service 本体は account-link.test.ts で網羅済のため vi.mock で結果を制御する
 * (= route は薄い mapper。 静的 import のみ、 dynamic import 干渉トラップなし)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services/account-link.js', () => ({
  requestAccountLinkCode: vi.fn(),
  verifyAccountLinkCode: vi.fn(),
}));

// 連携特典クーポン (Sprint A-1): verify 成功 hook の発火だけを検証する
// (issuer 本体は link-reward-coupon-issuer.test.ts で網羅済)
vi.mock('../services/link-reward-coupon-issuer.js', () => ({
  issueLinkRewardCoupon: vi.fn(async () => null),
}));

// 過去注文 backfill は 2026-08-28 に service から route へ移した (クーポン発行の後に直列化)。
// 順序が観測点なので、呼ばれたか/いつ呼ばれたかを見るために mock する。
vi.mock('../services/member-purchase-backfill.js', () => ({
  backfillCustomerOrders: vi.fn(async () => ({ backfilled: 0 })),
}));
vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'tok'),
}));

import { liffAccountLink } from '../routes/liff-account-link.js';
import { requestAccountLinkCode, verifyAccountLinkCode } from '../services/account-link.js';
import { issueLinkRewardCoupon } from '../services/link-reward-coupon-issuer.js';
import { backfillCustomerOrders } from '../services/member-purchase-backfill.js';
import { getShopifyAccessToken } from '../services/shopify-token.js';
import type { Env } from '../index.js';

const mockedRequest = vi.mocked(requestAccountLinkCode);
const mockedVerify = vi.mocked(verifyAccountLinkCode);
const mockedIssueLinkReward = vi.mocked(issueLinkRewardCoupon);
const mockedBackfill = vi.mocked(backfillCustomerOrders);
const mockedToken = vi.mocked(getShopifyAccessToken);

function makeApp(
  opts: {
    liffUser?: { lineUserId: string; friendId: string } | null;
    env?: Record<string, string>;
  } = {},
): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database, ACCOUNT_LINK_ENABLED: 'true', ...(opts.env ?? {}) } as unknown as Env['Bindings'];
    if (opts.liffUser !== null) {
      const user = opts.liffUser ?? { lineUserId: 'U-test', friendId: 'friend-1' };
      (c as { set: (k: string, v: unknown) => void }).set('liffUser', user);
    }
    return next();
  });
  app.route('/', liffAccountLink);
  return app;
}

function postJson(app: Hono<Env>, path: string, body: unknown, raw?: string) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  mockedRequest.mockReset();
  mockedVerify.mockReset();
  mockedIssueLinkReward.mockReset();
  mockedIssueLinkReward.mockResolvedValue(null);
  mockedBackfill.mockReset();
  mockedBackfill.mockResolvedValue({ backfilled: 0 } as Awaited<ReturnType<typeof backfillCustomerOrders>>);
  mockedToken.mockReset();
  mockedToken.mockResolvedValue('tok');
});

// ============================================================
// 🚨 ¥300 連携特典 と backfill の順序 (2026-08-28)
// ============================================================
// 両者は同一 invocation の subrequest 予算 (無料プラン 50) を共有する。支配項は注文ごとの
// addPurchaseEvent (~5 D1/新規適用) なので、注文の多い顧客 (= 定期便顧客はほぼ全員) では
// backfill を先に走らせるとクーポン発行が「Too many subrequests」で無言で消える。
// sub-link (App Proxy / magic-link) 経路は同じ危険を採点ループ HIGH として潰済みで、
// OTP 経路にだけ保護が無かった (= 本番の第一候補 CTA がこちら)。
describe('verify-code: 連携特典の発行を backfill より先に確定させる', () => {
  const OK = { ok: true as const, customerId: '777', backfilled: 0, metafieldWritten: true };

  it('service にインライン backfill をさせない (deferBackfillToCaller)', async () => {
    mockedVerify.mockResolvedValue(OK);
    const app = makeApp({ env: { MEMBER_BACKFILL_ENABLED: 'true' } });
    await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    expect(mockedVerify).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { deferBackfillToCaller: true },
    );
  });

  it('🚨 backfill はクーポン発行が終わるまで始まらない', async () => {
    let releaseIssue: (v: null) => void = () => {};
    mockedVerify.mockResolvedValue(OK);
    mockedIssueLinkReward.mockReturnValue(
      new Promise<null>((resolve) => {
        releaseIssue = resolve;
      }),
    );
    const app = makeApp({ env: { MEMBER_BACKFILL_ENABLED: 'true' } });
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    expect(res.status).toBe(200);
    // 応答時点で発行はまだ走っている = backfill は 1 度も呼ばれていない
    expect(mockedIssueLinkReward).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(mockedToken).not.toHaveBeenCalled();
    // 発行が終わって初めて backfill が動く
    releaseIssue(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
    expect(mockedBackfill.mock.calls[0][2]).toMatchObject({ customerId: '777', friendId: 'friend-1', maxPages: 2 });
  });

  it('発行が失敗しても backfill は走る (best-effort の連鎖を切らない)', async () => {
    mockedVerify.mockResolvedValue(OK);
    mockedIssueLinkReward.mockRejectedValue(new Error('boom'));
    const app = makeApp({ env: { MEMBER_BACKFILL_ENABLED: 'true' } });
    await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedBackfill).toHaveBeenCalledTimes(1);
  });

  it('backfill gate off では token 取得の subrequest すら使わない', async () => {
    mockedVerify.mockResolvedValue(OK);
    const app = makeApp();
    await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedBackfill).not.toHaveBeenCalled();
    expect(mockedToken).not.toHaveBeenCalled();
  });
});

// ============================================================
// POST /api/liff/link/request-code
// ============================================================

describe('POST /api/liff/link/request-code', () => {
  it('liffUser 未設定 → 401 (service 未呼出)', async () => {
    const app = makeApp({ liffUser: null });
    const res = await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' });
    expect(res.status).toBe(401);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('JSON 不正 → 400', async () => {
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/request-code', null, 'not-json');
    expect(res.status).toBe(400);
  });

  it('email 不正 → 400 (Zod)', async () => {
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/request-code', { email: 'bad' });
    expect(res.status).toBe(400);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('ok → 200 + service に friendId/lineUserId/email を渡す', async () => {
    mockedRequest.mockResolvedValue({ ok: true });
    const app = makeApp({ liffUser: { lineUserId: 'U_x', friendId: 'f_x' } });
    const res = await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { sent: boolean } }>();
    expect(json).toEqual({ success: true, data: { sent: true } });
    expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), { friendId: 'f_x', lineUserId: 'U_x', email: 'a@x.com' });
  });

  it('disabled → 404 (inert)', async () => {
    mockedRequest.mockResolvedValue({ ok: false, code: 'disabled' });
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' });
    expect(res.status).toBe(404);
  });

  it('already_linked → 409 / rate_limited → 429 / email_failed → 502', async () => {
    const app = makeApp();
    mockedRequest.mockResolvedValue({ ok: false, code: 'already_linked' });
    expect((await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' })).status).toBe(409);
    mockedRequest.mockResolvedValue({ ok: false, code: 'rate_limited' });
    expect((await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' })).status).toBe(429);
    mockedRequest.mockResolvedValue({ ok: false, code: 'email_failed' });
    expect((await postJson(app, '/api/liff/link/request-code', { email: 'a@x.com' })).status).toBe(502);
  });
});

// ============================================================
// POST /api/liff/link/verify-code
// ============================================================

describe('POST /api/liff/link/verify-code', () => {
  it('liffUser 未設定 → 401', async () => {
    const app = makeApp({ liffUser: null });
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    expect(res.status).toBe(401);
  });

  it('code 欠落 → 400 (Zod)', async () => {
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com' });
    expect(res.status).toBe(400);
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('ok → 200 + linked データ + service 引数', async () => {
    mockedVerify.mockResolvedValue({ ok: true, customerId: '777', backfilled: 2, metafieldWritten: true });
    const app = makeApp({ liffUser: { lineUserId: 'U_x', friendId: 'f_x' } });
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { linked: boolean; customerId: string; backfilled: number | null } }>();
    // backfilled は応答後に waitUntil で走る (2026-08-28 に発行の後ろへ直列化) ため常に null。
    // service の戻り (defer 時は 0) をそのまま返すと「0 件反映」の誤読を生む。
    expect(json.data).toMatchObject({ linked: true, customerId: '777', backfilled: null });
    expect(mockedVerify).toHaveBeenCalledWith(
      expect.anything(),
      { friendId: 'f_x', lineUserId: 'U_x', email: 'a@x.com', code: '123456' },
      // 🚨 backfill を service にやらせない = ¥300 発行と subrequest 予算を食い合わせない
      { deferBackfillToCaller: true },
    );
  });

  it('invalid_code → 400 + attemptsRemaining passthrough', async () => {
    mockedVerify.mockResolvedValue({ ok: false, code: 'invalid_code', attemptsRemaining: 3 });
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '000000' });
    expect(res.status).toBe(400);
    const json = await res.json<{ success: boolean; error: string; attemptsRemaining: number }>();
    expect(json.error).toBe('invalid_code');
    expect(json.attemptsRemaining).toBe(3);
  });

  it('failure マッピング: locked→429 / customer_not_found→404 / customer_conflict→409 / shopify_error→502 / disabled→404', async () => {
    const app = makeApp();
    const cases: Array<[VerifyCode, number]> = [
      ['locked', 429],
      ['customer_not_found', 404],
      ['customer_conflict', 409],
      ['shopify_error', 502],
      ['disabled', 404],
    ];
    for (const [code, status] of cases) {
      mockedVerify.mockResolvedValue({ ok: false, code });
      const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@x.com', code: '123456' });
      expect(res.status, `code=${code}`).toBe(status);
    }
  });
});

type VerifyCode = 'locked' | 'customer_not_found' | 'customer_conflict' | 'shopify_error' | 'disabled';

// ============================================================
// 連携特典クーポン hook (Sprint A-1, 2026-08-11)
//   verify 成功 (= 新規 link 成立) のときだけ発行する。
// ============================================================

describe('link reward hook (POST /api/liff/link/verify-code)', () => {
  it('🚨verify 成功 → issuer が friendId/customerId/linkPath=email_otp で 1 回呼ばれる', async () => {
    mockedVerify.mockResolvedValue({ ok: true, customerId: '777', backfilled: 0, metafieldWritten: true });
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@b.co', code: '123456' });
    expect(res.status).toBe(200);
    expect(mockedIssueLinkReward).toHaveBeenCalledTimes(1);
    const [, , opts] = mockedIssueLinkReward.mock.calls[0];
    expect(opts).toMatchObject({ friendId: 'friend-1', shopifyCustomerId: '777', linkPath: 'email_otp' });
  });

  it('verify 失敗 (already_linked 含む) → issuer を呼ばない', async () => {
    mockedVerify.mockResolvedValue({ ok: false, code: 'already_linked' });
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@b.co', code: '123456' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockedIssueLinkReward).not.toHaveBeenCalled();
  });

  it('issuer が reject しても verify 応答は成功のまま (fire-and-forget)', async () => {
    mockedVerify.mockResolvedValue({ ok: true, customerId: '777', backfilled: 0, metafieldWritten: false });
    mockedIssueLinkReward.mockRejectedValueOnce(new Error('shopify down'));
    const app = makeApp();
    const res = await postJson(app, '/api/liff/link/verify-code', { email: 'a@b.co', code: '123456' });
    expect(res.status).toBe(200);
  });
});

// 再注入ドリル (2026-08-11): waitUntil 登録そのものを検証する。
// issuer 呼び出しの assert だけでは「waitUntil 未登録 (= 本番で応答後に Promise が
// 殺され発行が不安定化)」の変異が素通りするため、executionCtx を注入して登録を固定する。
describe('link reward hook — waitUntil 登録 (fire-and-forget の生存保証)', () => {
  it('🚨verify 成功 → executionCtx.waitUntil に発行 Promise が登録される', async () => {
    mockedVerify.mockResolvedValue({ ok: true, customerId: '777', backfilled: 0, metafieldWritten: true });
    const app = makeApp();
    const waitUntil = vi.fn();
    const res = await app.request(
      '/api/liff/link/verify-code',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', code: '123456' }) },
      undefined,
      { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
});
