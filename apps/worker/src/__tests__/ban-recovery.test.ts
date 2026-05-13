/**
 * Tests for ban-recovery route (Phase 5α-7).
 *
 * Covers:
 *   1. GET /api/ban-recovery — success path with stats + lists
 *   2. lineAccountId filter is forwarded to DB layer
 *   3. days / limit params are clamped to safe bounds
 *   4. 500 on unexpected DB errors
 *   5. 401 without auth header
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(async () => null),
    getBanRecoveryStats: vi.fn(async () => ({
      totalFollowers: 100,
      totalBlocked: 5,
      recoveredLastNDays: 2,
      repeatBlockers: 1,
    })),
    getRecentlyRecoveredFriends: vi.fn(async () => [
      {
        id: 'friend-1',
        line_user_id: 'U001',
        display_name: 'Alice',
        picture_url: 'https://example.com/a.png',
        last_unfollowed_at: '2026-04-10T10:00:00.000+09:00',
        last_refollowed_at: '2026-05-01T11:00:00.000+09:00',
        unfollow_count: 1,
      },
    ]),
    getCurrentlyBlockedFriends: vi.fn(async () => [
      {
        id: 'friend-2',
        line_user_id: 'U002',
        display_name: 'Bob',
        picture_url: null,
        last_unfollowed_at: '2026-05-09T20:00:00.000+09:00',
        unfollow_count: 2,
      },
    ]),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {},
}));

import { authMiddleware } from '../middleware/auth.js';
import { banRecovery } from '../routes/ban-recovery.js';
import type { Env } from '../index.js';
import {
  getBanRecoveryStats,
  getRecentlyRecoveredFriends,
  getCurrentlyBlockedFriends,
} from '@line-crm/db';

const TEST_API_KEY = 'test-api-key-banrec-12345';

const mockedStats = getBanRecoveryStats as ReturnType<typeof vi.fn>;
const mockedRecovered = getRecentlyRecoveredFriends as ReturnType<typeof vi.fn>;
const mockedBlocked = getCurrentlyBlockedFriends as ReturnType<typeof vi.fn>;

function createMockEnv(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'cid',
    LINE_LOGIN_CHANNEL_ID: 'lcid',
    LINE_LOGIN_CHANNEL_SECRET: 'lsec',
    WORKER_URL: 'https://worker.example.com',
  } as unknown as Env['Bindings'];
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', banRecovery);
  return app;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

describe('GET /api/ban-recovery', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockedStats.mockResolvedValue({
      totalFollowers: 100,
      totalBlocked: 5,
      recoveredLastNDays: 2,
      repeatBlockers: 1,
    });
    mockedRecovered.mockResolvedValue([
      {
        id: 'friend-1',
        line_user_id: 'U001',
        display_name: 'Alice',
        picture_url: 'https://example.com/a.png',
        last_unfollowed_at: '2026-04-10T10:00:00.000+09:00',
        last_refollowed_at: '2026-05-01T11:00:00.000+09:00',
        unfollow_count: 1,
      },
    ]);
    mockedBlocked.mockResolvedValue([
      {
        id: 'friend-2',
        line_user_id: 'U002',
        display_name: 'Bob',
        picture_url: null,
        last_unfollowed_at: '2026-05-09T20:00:00.000+09:00',
        unfollow_count: 2,
      },
    ]);
    app = createTestApp();
    env = createMockEnv();
  });

  it('200 + 正規化された stats / recoveredFriends / blockedFriends を返す', async () => {
    const res = await app.request('/api/ban-recovery', { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        stats: { totalFollowers: number; totalBlocked: number; recoveredLastNDays: number; repeatBlockers: number };
        params: { lineAccountId: string | null; days: number; limit: number };
        recentlyRecovered: { friendId: string; lineUserId: string; displayName: string | null; unfollowCount: number }[];
        currentlyBlocked: { friendId: string; lineUserId: string; unfollowCount: number }[];
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.stats).toEqual({
      totalFollowers: 100,
      totalBlocked: 5,
      recoveredLastNDays: 2,
      repeatBlockers: 1,
    });
    expect(body.data.params).toEqual({ lineAccountId: null, days: 30, limit: 50 });
    expect(body.data.recentlyRecovered).toHaveLength(1);
    expect(body.data.recentlyRecovered[0]).toMatchObject({
      friendId: 'friend-1',
      lineUserId: 'U001',
      displayName: 'Alice',
      unfollowCount: 1,
    });
    expect(body.data.currentlyBlocked).toHaveLength(1);
    expect(body.data.currentlyBlocked[0]).toMatchObject({
      friendId: 'friend-2',
      unfollowCount: 2,
    });
  });

  it('lineAccountId クエリは DB 関数に forward される', async () => {
    await app.request('/api/ban-recovery?lineAccountId=acc-123', { headers: authHeaders() }, env);
    expect(mockedStats).toHaveBeenCalledWith(expect.anything(), 'acc-123', 30);
    expect(mockedRecovered).toHaveBeenCalledWith(expect.anything(), 'acc-123', 50);
    expect(mockedBlocked).toHaveBeenCalledWith(expect.anything(), 'acc-123', 50);
  });

  it('days / limit クエリは正値で範囲内ならそのまま通る', async () => {
    await app.request('/api/ban-recovery?days=7&limit=10', { headers: authHeaders() }, env);
    expect(mockedStats).toHaveBeenCalledWith(expect.anything(), undefined, 7);
    expect(mockedRecovered).toHaveBeenCalledWith(expect.anything(), undefined, 10);
    expect(mockedBlocked).toHaveBeenCalledWith(expect.anything(), undefined, 10);
  });

  it('days / limit が非数 or 0 / 負値ならデフォルトにフォールバック', async () => {
    await app.request('/api/ban-recovery?days=abc&limit=-5', { headers: authHeaders() }, env);
    expect(mockedStats).toHaveBeenCalledWith(expect.anything(), undefined, 30);
    expect(mockedRecovered).toHaveBeenCalledWith(expect.anything(), undefined, 50);
  });

  it('days / limit が上限を超えたらクランプされる', async () => {
    await app.request('/api/ban-recovery?days=9999&limit=9999', { headers: authHeaders() }, env);
    expect(mockedStats).toHaveBeenCalledWith(expect.anything(), undefined, 365);
    expect(mockedRecovered).toHaveBeenCalledWith(expect.anything(), undefined, 200);
    expect(mockedBlocked).toHaveBeenCalledWith(expect.anything(), undefined, 200);
  });

  it('DB エラー発生時は 500 を返し payload を漏らさない', async () => {
    mockedStats.mockRejectedValueOnce(new Error('boom'));
    const res = await app.request('/api/ban-recovery', { headers: authHeaders() }, env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Internal server error');
  });

  it('認証ヘッダ無しなら 401', async () => {
    const res = await app.request('/api/ban-recovery', {}, env);
    expect(res.status).toBe(401);
  });
});
