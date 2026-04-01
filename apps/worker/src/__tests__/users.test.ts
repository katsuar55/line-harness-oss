/**
 * Tests for users routes.
 *
 * Covers:
 *   1. GET /api/users — list all users
 *   2. GET /api/users/:id — get single user
 *   3. POST /api/users — create user
 *   4. PUT /api/users/:id — update user
 *   5. DELETE /api/users/:id — delete user
 *   6. POST /api/users/:id/link — link friend to user
 *   7. GET /api/users/:id/accounts — get linked friends
 *   8. POST /api/users/match — find user by email or phone
 *   9. Error handling for all endpoints
 *  10. Authentication required
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@line-crm/db';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getUsers: vi.fn(),
    getUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    linkFriendToUser: vi.fn(),
    getUserFriends: vi.fn(),
    getUserByEmail: vi.fn(),
    getUserByPhone: vi.fn(),
    getStaffByApiKey: vi.fn(async () => null),
    // Stubs for other routes to prevent import errors
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriendById: vi.fn(async () => null),
    getLatestRiskLevel: vi.fn(async () => 'safe'),
    getAccountHealthLogs: vi.fn(async () => []),
    getAccountMigrations: vi.fn(async () => []),
    getAccountMigrationById: vi.fn(async () => null),
    createAccountMigration: vi.fn(async () => ({})),
    updateAccountMigration: vi.fn(async () => ({})),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async getProfile(userId: string) {
      return { displayName: 'Test', userId, pictureUrl: '', statusMessage: '' };
    }
    async showLoadingAnimation() {}
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  linkFriendToUser,
  getUserFriends,
  getUserByEmail,
  getUserByPhone,
} from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { users } from '../routes/users.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

const MOCK_USER: User = {
  id: 'usr-001',
  email: 'test@example.com',
  phone: '09012345678',
  external_id: 'ext-001',
  display_name: 'Test User',
  created_at: '2025-01-01T00:00:00+09:00',
  updated_at: '2025-01-01T00:00:00+09:00',
};

const MOCK_USER_2: User = {
  id: 'usr-002',
  email: 'user2@example.com',
  phone: '09087654321',
  external_id: null,
  display_name: 'User Two',
  created_at: '2025-01-02T00:00:00+09:00',
  updated_at: '2025-01-02T00:00:00+09:00',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', users);
  return app;
}

function createMockEnv(): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    AI: {} as Ai,
    LINE_CHANNEL_SECRET: 'test-channel-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

function jsonHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function serialized(user: User) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    externalId: user.external_id,
    displayName: user.display_name,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Users Routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    app = createTestApp();
    env = createMockEnv();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Authentication
  // =========================================================================

  describe('Authentication', () => {
    it('returns 401 without Authorization header', async () => {
      const res = await app.request('/api/users', {}, env);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
    });

    it('returns 401 with invalid token', async () => {
      const res = await app.request(
        '/api/users',
        { headers: { Authorization: 'Bearer wrong-key' } },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // GET /api/users
  // =========================================================================

  describe('GET /api/users', () => {
    it('returns list of serialized users', async () => {
      vi.mocked(getUsers).mockResolvedValue([MOCK_USER, MOCK_USER_2]);

      const res = await app.request('/api/users', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual(serialized(MOCK_USER));
      expect(body.data[1]).toEqual(serialized(MOCK_USER_2));
    });

    it('returns empty array when no users exist', async () => {
      vi.mocked(getUsers).mockResolvedValue([]);

      const res = await app.request('/api/users', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns 500 when getUsers throws', async () => {
      vi.mocked(getUsers).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/users', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // GET /api/users/:id
  // =========================================================================

  describe('GET /api/users/:id', () => {
    it('returns serialized user when found', async () => {
      vi.mocked(getUserById).mockResolvedValue(MOCK_USER);

      const res = await app.request('/api/users/usr-001', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data).toEqual(serialized(MOCK_USER));
    });

    it('returns 404 when user not found', async () => {
      vi.mocked(getUserById).mockResolvedValue(null);

      const res = await app.request('/api/users/nonexistent', { headers: authHeaders() }, env);
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('User not found');
    });

    it('returns 500 when getUserById throws', async () => {
      vi.mocked(getUserById).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/users/usr-001', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/users
  // =========================================================================

  describe('POST /api/users', () => {
    it('creates user and returns 201', async () => {
      vi.mocked(createUser).mockResolvedValue(MOCK_USER);

      const res = await app.request(
        '/api/users',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            email: 'test@example.com',
            phone: '09012345678',
            externalId: 'ext-001',
            displayName: 'Test User',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data).toEqual(serialized(MOCK_USER));
    });

    it('creates user with minimal fields', async () => {
      const minimalUser: User = {
        id: 'usr-003',
        email: null,
        phone: null,
        external_id: null,
        display_name: null,
        created_at: '2025-01-03T00:00:00+09:00',
        updated_at: '2025-01-03T00:00:00+09:00',
      };
      vi.mocked(createUser).mockResolvedValue(minimalUser);

      const res = await app.request(
        '/api/users',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data.email).toBeNull();
      expect(body.data.phone).toBeNull();
    });

    it('returns 500 when createUser throws', async () => {
      vi.mocked(createUser).mockRejectedValue(new Error('DB failure'));

      const res = await app.request(
        '/api/users',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'test@example.com' }),
        },
        env,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // PUT /api/users/:id
  // =========================================================================

  describe('PUT /api/users/:id', () => {
    it('updates user and returns serialized result', async () => {
      const updatedUser: User = { ...MOCK_USER, display_name: 'Updated Name' };
      vi.mocked(updateUser).mockResolvedValue(updatedUser);

      const res = await app.request(
        '/api/users/usr-001',
        {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ displayName: 'Updated Name' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data.displayName).toBe('Updated Name');
    });

    it('passes correct field mapping to updateUser', async () => {
      vi.mocked(updateUser).mockResolvedValue(MOCK_USER);

      await app.request(
        '/api/users/usr-001',
        {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({
            email: 'new@example.com',
            phone: '09099999999',
            externalId: 'ext-new',
            displayName: 'New Name',
          }),
        },
        env,
      );

      expect(updateUser).toHaveBeenCalledWith(env.DB, 'usr-001', {
        email: 'new@example.com',
        phone: '09099999999',
        external_id: 'ext-new',
        display_name: 'New Name',
      });
    });

    it('returns 404 when user not found', async () => {
      vi.mocked(updateUser).mockResolvedValue(null);

      const res = await app.request(
        '/api/users/nonexistent',
        {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ displayName: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('User not found');
    });

    it('returns 500 when updateUser throws', async () => {
      vi.mocked(updateUser).mockRejectedValue(new Error('DB failure'));

      const res = await app.request(
        '/api/users/usr-001',
        {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ displayName: 'X' }),
        },
        env,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // DELETE /api/users/:id
  // =========================================================================

  describe('DELETE /api/users/:id', () => {
    it('deletes user and returns success', async () => {
      vi.mocked(deleteUser).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/users/usr-001',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });

    it('calls deleteUser with correct args', async () => {
      vi.mocked(deleteUser).mockResolvedValue(undefined);

      await app.request(
        '/api/users/usr-001',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(deleteUser).toHaveBeenCalledWith(env.DB, 'usr-001');
    });

    it('returns 500 when deleteUser throws', async () => {
      vi.mocked(deleteUser).mockRejectedValue(new Error('DB failure'));

      const res = await app.request(
        '/api/users/usr-001',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/users/:id/link
  // =========================================================================

  describe('POST /api/users/:id/link', () => {
    it('links friend to user and returns success', async () => {
      vi.mocked(linkFriendToUser).mockResolvedValue(undefined);

      const res = await app.request(
        '/api/users/usr-001/link',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ friendId: 'friend-001' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: null };
      expect(body.success).toBe(true);
      expect(body.data).toBeNull();
    });

    it('calls linkFriendToUser with correct args (friendId, userId)', async () => {
      vi.mocked(linkFriendToUser).mockResolvedValue(undefined);

      await app.request(
        '/api/users/usr-001/link',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ friendId: 'friend-001' }),
        },
        env,
      );

      expect(linkFriendToUser).toHaveBeenCalledWith(env.DB, 'friend-001', 'usr-001');
    });

    it('returns 400 when friendId is missing', async () => {
      const res = await app.request(
        '/api/users/usr-001/link',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('friendId is required');
    });

    it('returns 500 when linkFriendToUser throws', async () => {
      vi.mocked(linkFriendToUser).mockRejectedValue(new Error('DB failure'));

      const res = await app.request(
        '/api/users/usr-001/link',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ friendId: 'friend-001' }),
        },
        env,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // GET /api/users/:id/accounts
  // =========================================================================

  describe('GET /api/users/:id/accounts', () => {
    it('returns linked friends with serialized fields', async () => {
      vi.mocked(getUserFriends).mockResolvedValue([
        {
          id: 'friend-001',
          line_user_id: 'U1234567890',
          display_name: 'LINE Friend',
          is_following: 1,
        },
        {
          id: 'friend-002',
          line_user_id: 'U0987654321',
          display_name: null,
          is_following: 0,
        },
      ]);

      const res = await app.request('/api/users/usr-001/accounts', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; lineUserId: string; displayName: string | null; isFollowing: boolean }[];
      };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0]).toEqual({
        id: 'friend-001',
        lineUserId: 'U1234567890',
        displayName: 'LINE Friend',
        isFollowing: true,
      });
      expect(body.data[1]).toEqual({
        id: 'friend-002',
        lineUserId: 'U0987654321',
        displayName: null,
        isFollowing: false,
      });
    });

    it('returns empty array when no friends linked', async () => {
      vi.mocked(getUserFriends).mockResolvedValue([]);

      const res = await app.request('/api/users/usr-001/accounts', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns 500 when getUserFriends throws', async () => {
      vi.mocked(getUserFriends).mockRejectedValue(new Error('DB failure'));

      const res = await app.request('/api/users/usr-001/accounts', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });

  // =========================================================================
  // POST /api/users/match
  // =========================================================================

  describe('POST /api/users/match', () => {
    it('finds user by email', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(MOCK_USER);

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'test@example.com' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data).toEqual(serialized(MOCK_USER));
      expect(getUserByEmail).toHaveBeenCalledWith(env.DB, 'test@example.com');
    });

    it('finds user by phone when email not found', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(null);
      vi.mocked(getUserByPhone).mockResolvedValue(MOCK_USER_2);

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'notfound@example.com', phone: '09087654321' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(body.data).toEqual(serialized(MOCK_USER_2));
      expect(getUserByPhone).toHaveBeenCalledWith(env.DB, '09087654321');
    });

    it('finds user by phone only (no email provided)', async () => {
      vi.mocked(getUserByPhone).mockResolvedValue(MOCK_USER);

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ phone: '09012345678' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.success).toBe(true);
      expect(getUserByEmail).not.toHaveBeenCalled();
      expect(getUserByPhone).toHaveBeenCalledWith(env.DB, '09012345678');
    });

    it('prefers email match over phone', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(MOCK_USER);

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'test@example.com', phone: '09087654321' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { success: boolean; data: ReturnType<typeof serialized> };
      expect(body.data).toEqual(serialized(MOCK_USER));
      // phone lookup should not be called when email match succeeds
      expect(getUserByPhone).not.toHaveBeenCalled();
    });

    it('returns 404 when no match found', async () => {
      vi.mocked(getUserByEmail).mockResolvedValue(null);
      vi.mocked(getUserByPhone).mockResolvedValue(null);

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'missing@example.com', phone: '00000000000' }),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('User not found');
    });

    it('returns 404 when neither email nor phone provided', async () => {
      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(404);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('User not found');
    });

    it('returns 500 when getUserByEmail throws', async () => {
      vi.mocked(getUserByEmail).mockRejectedValue(new Error('DB failure'));

      const res = await app.request(
        '/api/users/match',
        {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: 'test@example.com' }),
        },
        env,
      );
      expect(res.status).toBe(500);

      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toBe('Internal server error');
    });
  });
});
