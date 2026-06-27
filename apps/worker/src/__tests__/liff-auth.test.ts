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
    });
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
