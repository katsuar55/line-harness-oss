/**
 * Tests for staff management routes.
 *
 * Covers:
 *   1. GET /api/staff/me — env-owner returns minimal info
 *   2. GET /api/staff/me — DB staff returns profile
 *   3. GET /api/staff/me — not found returns 404
 *   4. GET /api/staff/me — error returns 500
 *   5. GET /api/staff — owner lists all staff with masked keys
 *   6. GET /api/staff — non-owner returns 403
 *   7. GET /api/staff — error returns 500
 *   8. GET /api/staff/:id — owner gets staff detail
 *   9. GET /api/staff/:id — not found returns 404
 *  10. GET /api/staff/:id — error returns 500
 *  11. POST /api/staff — creates staff with unmasked key
 *  12. POST /api/staff — missing name returns 400
 *  13. POST /api/staff — invalid role returns 400
 *  14. POST /api/staff — non-owner returns 403
 *  15. POST /api/staff — error returns 500
 *  16. PATCH /api/staff/:id — updates staff
 *  17. PATCH /api/staff/:id — invalid role returns 400
 *  18. PATCH /api/staff/:id — not found returns 404
 *  19. PATCH /api/staff/:id — prevents removing last owner (role change)
 *  20. PATCH /api/staff/:id — prevents removing last owner (deactivate)
 *  21. PATCH /api/staff/:id — update returns 404 when updateStaffMember returns null
 *  22. PATCH /api/staff/:id — error returns 500
 *  23. DELETE /api/staff/:id — deletes staff
 *  24. DELETE /api/staff/:id — cannot delete self
 *  25. DELETE /api/staff/:id — not found returns 404
 *  26. DELETE /api/staff/:id — prevents deleting last owner
 *  27. DELETE /api/staff/:id — error returns 500
 *  28. POST /api/staff/:id/regenerate-key — regenerates key
 *  29. POST /api/staff/:id/regenerate-key — not found returns 404
 *  30. POST /api/staff/:id/regenerate-key — error returns 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getStaffByApiKey: vi.fn(),
    getStaffMembers: vi.fn(),
    getStaffById: vi.fn(),
    createStaffMember: vi.fn(),
    updateStaffMember: vi.fn(),
    deleteStaffMember: vi.fn(),
    regenerateStaffApiKey: vi.fn(),
    countActiveStaffByRole: vi.fn(),
    // Stubs for other imports that routes may pull in
    getLineAccounts: vi.fn(async () => []),
    getAutoReplies: vi.fn(async () => []),
    getScenarios: vi.fn(async () => []),
    getTags: vi.fn(async () => []),
    getBroadcasts: vi.fn(async () => []),
    getFriendsCount: vi.fn(async () => 0),
    getFriends: vi.fn(async () => []),
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
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  getStaffByApiKey,
  getStaffMembers,
  getStaffById,
  createStaffMember,
  updateStaffMember,
  deleteStaffMember,
  regenerateStaffApiKey,
  countActiveStaffByRole,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { staff } from '../routes/staff.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-owner';
const OWNER_STAFF_KEY = 'owner-staff-key';
const ADMIN_STAFF_KEY = 'admin-staff-key';
const STAFF_STAFF_KEY = 'staff-staff-key';

const OWNER_STAFF: StaffMember = {
  id: 'staff-owner-1',
  name: 'Owner User',
  email: 'owner@example.com',
  role: 'owner',
  api_key: OWNER_STAFF_KEY,
  is_active: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const ADMIN_STAFF: StaffMember = {
  id: 'staff-admin-1',
  name: 'Admin User',
  email: 'admin@example.com',
  role: 'admin',
  api_key: ADMIN_STAFF_KEY,
  is_active: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const REGULAR_STAFF: StaffMember = {
  id: 'staff-regular-1',
  name: 'Staff User',
  email: 'staff@example.com',
  role: 'staff',
  api_key: STAFF_STAFF_KEY,
  is_active: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

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
    LINE_CHANNEL_SECRET: 'test-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    API_KEY: TEST_API_KEY,
    LIFF_URL: 'https://liff.line.me/test',
    LINE_CHANNEL_ID: 'test-channel-id',
    LINE_LOGIN_CHANNEL_ID: 'test-login-id',
    LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
    WORKER_URL: 'https://worker.example.com',
  };
}

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', staff);
  return app;
}

function ownerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${OWNER_STAFF_KEY}` };
}

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_STAFF_KEY}` };
}

function envOwnerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof createTestApp>;
let env: Env['Bindings'];

beforeEach(() => {
  vi.resetAllMocks();
  app = createTestApp();
  env = createMockEnv();

  // Default: owner staff key resolves to OWNER_STAFF, admin key to ADMIN_STAFF
  (getStaffByApiKey as ReturnType<typeof vi.fn>).mockImplementation(
    async (_db: unknown, apiKey: string) => {
      if (apiKey === OWNER_STAFF_KEY) return OWNER_STAFF;
      if (apiKey === ADMIN_STAFF_KEY) return ADMIN_STAFF;
      if (apiKey === STAFF_STAFF_KEY) return REGULAR_STAFF;
      return null;
    },
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/staff/me', () => {
  it('returns minimal info for env-owner', async () => {
    const res = await app.request('/api/staff/me', { headers: envOwnerHeaders() }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { id: string; role: string } };
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('env-owner');
    expect(json.data.role).toBe('owner');
  });

  it('returns profile for DB staff member', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OWNER_STAFF);
    const res = await app.request('/api/staff/me', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { id: string; name: string } };
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(OWNER_STAFF.id);
    expect(json.data.name).toBe(OWNER_STAFF.name);
  });

  it('returns 404 when staff not found in DB', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await app.request('/api/staff/me', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request('/api/staff/me', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toBe('Internal server error');
  });
});

describe('GET /api/staff', () => {
  it('returns all staff with masked keys for owner', async () => {
    (getStaffMembers as ReturnType<typeof vi.fn>).mockResolvedValueOnce([OWNER_STAFF, ADMIN_STAFF]);
    const res = await app.request('/api/staff', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { apiKey: string }[] };
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(2);
    // API keys should be masked
    for (const item of json.data) {
      expect(item.apiKey).toMatch(/^lh_\*\*\*\*/);
    }
  });

  it('returns 403 for non-owner (admin)', async () => {
    const res = await app.request('/api/staff', { headers: adminHeaders() }, env);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    (getStaffMembers as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request('/api/staff', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });
});

describe('GET /api/staff/:id', () => {
  it('returns staff detail with masked key for owner', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    const res = await app.request(`/api/staff/${ADMIN_STAFF.id}`, { headers: ownerHeaders() }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { id: string; apiKey: string } };
    expect(json.success).toBe(true);
    expect(json.data.id).toBe(ADMIN_STAFF.id);
    expect(json.data.apiKey).toMatch(/^lh_\*\*\*\*/);
  });

  it('returns 404 when staff not found', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await app.request('/api/staff/nonexistent', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request('/api/staff/some-id', { headers: ownerHeaders() }, env);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });
});

describe('POST /api/staff', () => {
  it('creates staff and returns unmasked API key', async () => {
    const created: StaffMember = {
      id: 'new-staff-id',
      name: 'New Staff',
      email: 'new@example.com',
      role: 'admin',
      api_key: 'lh_abcdef1234567890abcdef1234567890',
      is_active: 1,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    (createStaffMember as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Staff', email: 'new@example.com', role: 'admin' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { apiKey: string; name: string } };
    expect(json.success).toBe(true);
    // API key should be unmasked (full key visible)
    expect(json.data.apiKey).toBe(created.api_key);
    expect(json.data.name).toBe('New Staff');
  });

  it('returns 400 when name is missing', async () => {
    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('name is required');
  });

  it('returns 400 for invalid role', async () => {
    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', role: 'superadmin' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('role must be owner, admin, or staff');
  });

  it('returns 400 when role is missing', async () => {
    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('role must be owner, admin, or staff');
  });

  it('returns 403 for non-owner', async () => {
    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', role: 'staff' }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('returns 500 on internal error', async () => {
    (createStaffMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request(
      '/api/staff',
      {
        method: 'POST',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test', role: 'staff' }),
      },
      env,
    );
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/staff/:id', () => {
  it('updates staff member', async () => {
    const updated: StaffMember = { ...ADMIN_STAFF, name: 'Updated Admin' };
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    (updateStaffMember as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);

    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Admin' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { name: string; apiKey: string } };
    expect(json.success).toBe(true);
    expect(json.data.name).toBe('Updated Admin');
    // Key should be masked
    expect(json.data.apiKey).toMatch(/^lh_\*\*\*\*/);
  });

  it('returns 400 for invalid role', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'superadmin' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('role must be owner, admin, or staff');
  });

  it('returns 404 when target staff not found', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await app.request(
      '/api/staff/nonexistent',
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('prevents removing the last owner by role change', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OWNER_STAFF);
    (countActiveStaffByRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.request(
      `/api/staff/${OWNER_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('オーナーは最低1人必要です');
  });

  it('prevents deactivating the last owner', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(OWNER_STAFF);
    (countActiveStaffByRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.request(
      `/api/staff/${OWNER_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('オーナーは最低1人必要です');
  });

  it('returns 404 when updateStaffMember returns null', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    (updateStaffMember as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 500 on internal error', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}`,
      {
        method: 'PATCH',
        headers: { ...ownerHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      },
      env,
    );
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/staff/:id', () => {
  it('deletes staff member', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    (deleteStaffMember as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}`,
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: null };
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it('returns 400 when trying to delete self', async () => {
    const res = await app.request(
      `/api/staff/${OWNER_STAFF.id}`,
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('自分自身は削除できません');
  });

  it('returns 404 when target not found', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await app.request(
      '/api/staff/nonexistent',
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('prevents deleting the last active owner', async () => {
    const anotherOwner: StaffMember = {
      ...OWNER_STAFF,
      id: 'another-owner',
      role: 'owner',
      is_active: 1,
    };
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(anotherOwner);
    (countActiveStaffByRole as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);

    const res = await app.request(
      '/api/staff/another-owner',
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.error).toBe('オーナーは最低1人必要です');
  });

  it('returns 500 on internal error', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request(
      '/api/staff/other-id',
      { method: 'DELETE', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/staff/:id/regenerate-key', () => {
  it('regenerates API key', async () => {
    const newKey = 'lh_newkey1234567890abcdef';
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ADMIN_STAFF);
    (regenerateStaffApiKey as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newKey);

    const res = await app.request(
      `/api/staff/${ADMIN_STAFF.id}/regenerate-key`,
      { method: 'POST', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { apiKey: string } };
    expect(json.success).toBe(true);
    expect(json.data.apiKey).toBe(newKey);
  });

  it('returns 404 when staff not found', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await app.request(
      '/api/staff/nonexistent/regenerate-key',
      { method: 'POST', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
  });

  it('returns 500 on internal error', async () => {
    (getStaffById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));
    const res = await app.request(
      '/api/staff/some-id/regenerate-key',
      { method: 'POST', headers: ownerHeaders() },
      env,
    );
    expect(res.status).toBe(500);
  });
});
