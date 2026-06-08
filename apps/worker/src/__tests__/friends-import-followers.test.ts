/**
 * Tests for POST /api/friends/import-followers
 * (bulk-populate friends directly from the LINE OA via getFollowerIds + getProfile).
 *
 * Covers: auth, single-page import w/ profiles, pagination cap (nextCursor/hasMore),
 * dryRun (no writes, no profile fetch), fetchProfiles=false, existing-friend skip,
 * and 403 (unverified OA) handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { mockGetFollowerIds, mockGetProfile } = vi.hoisted(() => ({
  mockGetFollowerIds: vi.fn(),
  mockGetProfile: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    upsertFriend: vi.fn(async (_db: unknown, input: { lineUserId: string }) => ({
      id: `f-${input.lineUserId}`,
      line_user_id: input.lineUserId,
    })),
    getFriendByLineUserId: vi.fn(async () => null),
    getStaffByApiKey: vi.fn(async () => null),
    getLineAccounts: vi.fn(async () => []),
    getLineAccountById: vi.fn(async () => null),
    jstNow: vi.fn(() => '2025-06-01T12:00:00+09:00'),
  };
});

vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn(async () => {}) }));
vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((_t: string, content: string) => ({ type: 'text', text: content })),
  processStepDeliveries: vi.fn(async () => {}),
}));
vi.mock('../services/auto-track.js', () => ({
  autoTrackContent: vi.fn(async (_db: unknown, messageType: string, content: string) => ({
    messageType,
    content,
  })),
}));

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    getFollowerIds = mockGetFollowerIds;
    getProfile = mockGetProfile;
  },
}));

import { authMiddleware } from '../middleware/auth.js';
import { friends } from '../routes/friends.js';
import type { Env } from '../index.js';
import { upsertFriend, getFriendByLineUserId } from '@line-crm/db';

const mockUpsert = upsertFriend as ReturnType<typeof vi.fn>;
const mockGetByLineUserId = getFriendByLineUserId as ReturnType<typeof vi.fn>;

const TEST_API_KEY = 'test-api-key-secret-12345';
const U1 = 'U' + '1'.repeat(32);
const U2 = 'U' + '2'.repeat(32);

function createTestApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', friends);
  return app;
}

function createMockDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ success: true })),
      })),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ success: true })),
    })),
    dump: vi.fn(),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: createMockDb(),
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  } as unknown as Env['Bindings'];
}

function postBody(body: unknown) {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

describe('POST /api/friends/import-followers', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
    mockGetByLineUserId.mockResolvedValue(null);
    mockGetProfile.mockResolvedValue({
      displayName: 'Taro',
      pictureUrl: 'https://example.com/p.jpg',
      statusMessage: 'hi',
    });
  });

  it('returns 401 without a valid token', async () => {
    const res = await app.request(
      '/api/friends/import-followers',
      { method: 'POST', body: '{}' },
      env,
    );
    expect(res.status).toBe(401);
    expect(mockGetFollowerIds).not.toHaveBeenCalled();
  });

  it('imports a single page with profiles', async () => {
    mockGetFollowerIds.mockResolvedValueOnce({ userIds: [U1, U2] });

    const res = await app.request('/api/friends/import-followers', postBody({}), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };

    expect(body.success).toBe(true);
    expect(body.data.scanned).toBe(2);
    expect(body.data.matched).toBe(2);
    expect(body.data.upserted).toBe(2);
    expect(body.data.profilesFetched).toBe(2);
    expect(body.data.hasMore).toBe(false);
    expect(body.data.nextCursor).toBeNull();
    expect(mockGetProfile).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineUserId: U1, displayName: 'Taro' }),
    );
  });

  it('respects maxPages and returns nextCursor + hasMore', async () => {
    mockGetFollowerIds.mockResolvedValueOnce({ userIds: [U1], next: 'cursor-2' });

    const res = await app.request(
      '/api/friends/import-followers',
      postBody({ maxPages: 1, fetchProfiles: false }),
      env,
    );
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(mockGetFollowerIds).toHaveBeenCalledTimes(1);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.nextCursor).toBe('cursor-2');
    expect(body.data.upserted).toBe(1);
  });

  it('dryRun does not write or fetch profiles', async () => {
    mockGetFollowerIds.mockResolvedValueOnce({ userIds: [U1, U2] });

    const res = await app.request(
      '/api/friends/import-followers',
      postBody({ dryRun: true }),
      env,
    );
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data.scanned).toBe(2);
    expect(body.data.matched).toBe(2);
    expect(body.data.upserted).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('fetchProfiles=false upserts ids without calling getProfile', async () => {
    mockGetFollowerIds.mockResolvedValueOnce({ userIds: [U1] });

    const res = await app.request(
      '/api/friends/import-followers',
      postBody({ fetchProfiles: false }),
      env,
    );
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineUserId: U1, displayName: null }),
    );
    expect(body.data.profilesFetched).toBe(0);
  });

  it('skips profile fetch for already-existing friends', async () => {
    mockGetFollowerIds.mockResolvedValueOnce({ userIds: [U1] });
    mockGetByLineUserId.mockResolvedValueOnce({ id: 'existing', line_user_id: U1 });

    const res = await app.request('/api/friends/import-followers', postBody({}), env);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(body.data.profilesFetched).toBe(0);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('returns 422 with a clear message when the OA is unverified (403)', async () => {
    mockGetFollowerIds.mockRejectedValueOnce(
      new Error('LINE API error: 403 Forbidden — forbidden'),
    );

    const res = await app.request('/api/friends/import-followers', postBody({}), env);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('認証済');
  });
});
