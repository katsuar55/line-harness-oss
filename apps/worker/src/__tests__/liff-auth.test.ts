/**
 * Tests for middleware/liff-auth (採点Round1 D3: verifyLineIdToken の検証経路/error handling が未テストの解消)
 *
 * verifyLineIdToken は global fetch を mock。 liffAuthMiddleware は @line-crm/db を mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const mockGetFriendByLineUserId = vi.fn();
vi.mock('@line-crm/db', () => ({
  getFriendByLineUserId: (...a: unknown[]) => mockGetFriendByLineUserId(...a),
}));

import { verifyLineIdToken, liffAuthMiddleware } from '../middleware/liff-auth.js';

beforeEach(() => {
  vi.restoreAllMocks();
  mockGetFriendByLineUserId.mockReset();
});

describe('verifyLineIdToken', () => {
  it('resp.ok + sub → sub を返し、 LINE verify に POST する', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ sub: 'U123' }), { status: 200 }));
    expect(await verifyLineIdToken('tok', 'chan-1')).toBe('U123');
    expect(spy).toHaveBeenCalledWith(
      'https://api.line.me/oauth2/v2.1/verify',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('resp not ok (401) → null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 401 }));
    expect(await verifyLineIdToken('tok', 'c')).toBeNull();
  });

  it('sub 欠落 → null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    );
    expect(await verifyLineIdToken('tok', 'c')).toBeNull();
  });

  it('fetch throw (network) → null (fail-safe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await verifyLineIdToken('tok', 'c')).toBeNull();
  });

  it('JSON parse 失敗 → null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not-json', { status: 200 }));
    expect(await verifyLineIdToken('tok', 'c')).toBeNull();
  });
});

describe('liffAuthMiddleware', () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.use('*', liffAuthMiddleware as never);
    app.all('*', (c) => c.json({ ok: true, liffUser: (c as unknown as { get: (k: string) => unknown }).get('liffUser') ?? null }));
    return app;
  }
  const ENV = { LINE_LOGIN_CHANNEL_ID: 'chan-1', DB: {} } as never;

  it('/api/liff/tips/today は public → 通過', async () => {
    const res = await makeApp().fetch(new Request('http://localhost/api/liff/tips/today'), ENV);
    expect(res.status).toBe(200);
  });

  it('非 LIFF path は通過', async () => {
    const res = await makeApp().fetch(new Request('http://localhost/api/friends'), ENV);
    expect(res.status).toBe(200);
  });

  it('LIFF path で token なし → 401 (lineUserId fallback なし)', async () => {
    const res = await makeApp().fetch(new Request('http://localhost/api/liff/me'), ENV);
    expect(res.status).toBe(401);
  });

  it('LINE_LOGIN_CHANNEL_ID 未設定 → 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      { DB: {} } as never,
    );
    expect(res.status).toBe(500);
  });

  it('有効 idToken + friend あり → 通過 + liffUser を set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    mockGetFriendByLineUserId.mockResolvedValue({ id: 'friend-1', line_user_id: 'U1' });
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liffUser: unknown }).liffUser).toEqual({
      lineUserId: 'U1',
      friendId: 'friend-1',
      shopifyCustomerId: null, // 未連携 friend
      followedAt: null, // friend 行に時刻が無ければ null
    });
  });

  it('連携済み friend では shopifyCustomerId も liffUser に載る (下流の再読込を不要にする)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    mockGetFriendByLineUserId.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U1',
      shopify_customer_id: '6458785661181',
    });
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liffUser: unknown }).liffUser).toEqual({
      lineUserId: 'U1',
      friendId: 'friend-1',
      shopifyCustomerId: '6458785661181',
      followedAt: null,
    });
  });

  it('followedAt に created_at が載る (紹介 claim の救済の窓判定に使われる)', async () => {
    // 下流 (routes/liff-portal.ts の紹介 claim) は「最後に友だちになってから 7 日以内か」でしか
    // 実クーポンの救済を許さない。その判定材料をここで載せておく (friend 行の再読込を避ける)。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    mockGetFriendByLineUserId.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U1',
      created_at: '2026-08-24T11:23:09.745',
    });
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liffUser: { followedAt: string | null } }).liffUser.followedAt).toBe(
      '2026-08-24T11:23:09.745',
    );
  });

  it('🚨 再フォローは last_refollowed_at を優先する (Codex P2)', async () => {
    // upsertFriend はブロック復活のとき created_at を**保持**して last_refollowed_at だけ now にする。
    // created_at を見ると、再フォローで発行が失敗した人の正当な救済を「古い友だち」として落とす。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    mockGetFriendByLineUserId.mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U1',
      created_at: '2026-01-15T10:00:00.000',
      last_refollowed_at: '2026-08-24T11:23:09.745',
    });
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liffUser: { followedAt: string | null } }).liffUser.followedAt).toBe(
      '2026-08-24T11:23:09.745',
    );
  });

  it('idToken 無効 → 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 401 }));
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(401);
  });

  it('friend なし → 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ sub: 'U1' }), { status: 200 }));
    mockGetFriendByLineUserId.mockResolvedValue(null);
    const res = await makeApp().fetch(
      new Request('http://localhost/api/liff/me', { headers: { Authorization: 'Bearer tok' } }),
      ENV,
    );
    expect(res.status).toBe(404);
  });
});
