/**
 * Tests for forms routes.
 *
 * Covers:
 *   1. GET /api/forms — list all forms
 *   2. GET /api/forms/:id — get form by id
 *   3. GET /api/forms/:id — form not found
 *   4. POST /api/forms — create form
 *   5. POST /api/forms — missing name returns 400
 *   6. PUT /api/forms/:id — update form
 *   7. PUT /api/forms/:id — form not found returns 404
 *   8. DELETE /api/forms/:id — delete form
 *   9. DELETE /api/forms/:id — form not found returns 404
 *  10. GET /api/forms/:id/submissions — list submissions
 *  11. GET /api/forms/:id/submissions — form not found returns 404
 *  12. POST /api/forms/:id/submit — submit form (public)
 *  13. POST /api/forms/:id/submit — form not found returns 404
 *  14. POST /api/forms/:id/submit — inactive form returns 400
 *  15. POST /api/forms/:id/submit — required field missing returns 400
 *  16. POST /api/forms/:id/submit — resolves friend by lineUserId
 *  17. POST /api/forms/:id/submit — side effects (tag, scenario, metadata)
 *  18. GET /api/forms error returns 500
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Form, FormSubmission } from '@line-crm/db';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const NOW = '2026-04-02T12:00:00+09:00';

const MOCK_FORM: Form = {
  id: 'form-1',
  name: 'Test Form',
  description: 'A test form',
  fields: JSON.stringify([
    { name: 'email', label: 'メール', type: 'text', required: true },
    { name: 'age', label: '年齢', type: 'number', required: false },
  ]),
  on_submit_tag_id: null,
  on_submit_scenario_id: null,
  save_to_metadata: 0,
  is_active: 1,
  submit_count: 0,
  created_at: NOW,
  updated_at: NOW,
};

const MOCK_FORM_INACTIVE: Form = {
  ...MOCK_FORM,
  id: 'form-inactive',
  is_active: 0,
};

const MOCK_FORM_WITH_EFFECTS: Form = {
  ...MOCK_FORM,
  id: 'form-effects',
  on_submit_tag_id: 'tag-1',
  on_submit_scenario_id: 'scenario-1',
  save_to_metadata: 1,
};

const MOCK_SUBMISSION: FormSubmission & { friend_name?: string | null } = {
  id: 'sub-1',
  form_id: 'form-1',
  friend_id: 'friend-1',
  data: JSON.stringify({ email: 'test@example.com' }),
  created_at: NOW,
  friend_name: 'Test User',
};

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

const mockGetForms = vi.fn();
const mockGetFormById = vi.fn();
const mockCreateForm = vi.fn();
const mockUpdateForm = vi.fn();
const mockDeleteForm = vi.fn();
const mockGetFormSubmissions = vi.fn();
const mockCreateFormSubmission = vi.fn();
const mockGetFriendByLineUserId = vi.fn();
const mockGetFriendById = vi.fn();
const mockAddTagToFriend = vi.fn();
const mockEnrollFriendInScenario = vi.fn();
const mockGetLineAccountById = vi.fn();

vi.mock('@line-crm/db', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...orig,
    getForms: (...args: unknown[]) => mockGetForms(...args),
    getFormById: (...args: unknown[]) => mockGetFormById(...args),
    createForm: (...args: unknown[]) => mockCreateForm(...args),
    updateForm: (...args: unknown[]) => mockUpdateForm(...args),
    deleteForm: (...args: unknown[]) => mockDeleteForm(...args),
    getFormSubmissions: (...args: unknown[]) => mockGetFormSubmissions(...args),
    createFormSubmission: (...args: unknown[]) => mockCreateFormSubmission(...args),
    getFriendByLineUserId: (...args: unknown[]) => mockGetFriendByLineUserId(...args),
    getFriendById: (...args: unknown[]) => mockGetFriendById(...args),
    addTagToFriend: (...args: unknown[]) => mockAddTagToFriend(...args),
    enrollFriendInScenario: (...args: unknown[]) => mockEnrollFriendInScenario(...args),
    getLineAccountById: (...args: unknown[]) => mockGetLineAccountById(...args),
    getStaffByApiKey: vi.fn(async () => null),
    jstNow: () => NOW,
  };
});

// Mock line-sdk to prevent import failures
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

// Mock step-delivery to avoid deep import chain
vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn((_type: string, content: string) => ({
    type: 'flex',
    altText: 'Form result',
    contents: JSON.parse(content),
  })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { forms } from '../routes/forms.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Env } from '../index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-secret-12345';

function createTestApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', forms);
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
  };
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_API_KEY}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Forms routes', () => {
  let app: ReturnType<typeof createTestApp>;
  let env: Env['Bindings'];

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createMockEnv();
  });

  // ─── GET /api/forms ─────────────────────────────────────────────────────

  describe('GET /api/forms', () => {
    it('returns list of forms', async () => {
      mockGetForms.mockResolvedValue([MOCK_FORM]);

      const res = await app.request('/api/forms', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toMatchObject({
        id: 'form-1',
        name: 'Test Form',
        description: 'A test form',
        isActive: true,
        submitCount: 0,
      });
    });

    it('returns empty array when no forms exist', async () => {
      mockGetForms.mockResolvedValue([]);

      const res = await app.request('/api/forms', { headers: authHeaders() }, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });

    it('returns 500 on DB error', async () => {
      mockGetForms.mockRejectedValue(new Error('DB connection failed'));

      const res = await app.request('/api/forms', { headers: authHeaders() }, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });

    it('requires authentication', async () => {
      const res = await app.request('/api/forms', {}, env);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/forms/:id ─────────────────────────────────────────────────

  describe('GET /api/forms/:id', () => {
    it('returns form by id (public — no auth required)', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);

      const res = await app.request('/api/forms/form-1', {}, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('form-1');
      expect(json.data.name).toBe('Test Form');
      // fields should be parsed from JSON string
      expect(Array.isArray(json.data.fields)).toBe(true);
    });

    it('returns 404 when form not found', async () => {
      mockGetFormById.mockResolvedValue(null);

      const res = await app.request('/api/forms/nonexistent', {}, env);
      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Form not found');
    });

    it('returns 500 on DB error', async () => {
      mockGetFormById.mockRejectedValue(new Error('DB error'));

      const res = await app.request('/api/forms/form-1', {}, env);
      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });
  });

  // ─── POST /api/forms ────────────────────────────────────────────────────

  describe('POST /api/forms', () => {
    it('creates a new form', async () => {
      mockCreateForm.mockResolvedValue(MOCK_FORM);

      const res = await app.request(
        '/api/forms',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Test Form',
            description: 'A test form',
            fields: [{ name: 'email', label: 'メール', type: 'text', required: true }],
          }),
        },
        env,
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Test Form');
    });

    it('returns 400 when name is missing', async () => {
      const res = await app.request(
        '/api/forms',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'No name' }),
        },
        env,
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('name is required');
    });

    it('passes optional fields to createForm', async () => {
      mockCreateForm.mockResolvedValue({
        ...MOCK_FORM,
        on_submit_tag_id: 'tag-1',
        on_submit_scenario_id: 'scenario-1',
        save_to_metadata: 1,
      });

      const res = await app.request(
        '/api/forms',
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Form With Options',
            onSubmitTagId: 'tag-1',
            onSubmitScenarioId: 'scenario-1',
            saveToMetadata: true,
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      expect(mockCreateForm).toHaveBeenCalledWith(env.DB, {
        name: 'Form With Options',
        description: null,
        fields: '[]',
        onSubmitTagId: 'tag-1',
        onSubmitScenarioId: 'scenario-1',
        saveToMetadata: true,
      });
    });

    it('requires authentication', async () => {
      const res = await app.request(
        '/api/forms',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Test' }),
        },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── PUT /api/forms/:id ─────────────────────────────────────────────────

  describe('PUT /api/forms/:id', () => {
    it('updates a form', async () => {
      const updatedForm = { ...MOCK_FORM, name: 'Updated Form' };
      mockUpdateForm.mockResolvedValue(updatedForm);

      const res = await app.request(
        '/api/forms/form-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated Form' }),
        },
        env,
      );

      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated Form');
    });

    it('returns 404 when form not found', async () => {
      mockUpdateForm.mockResolvedValue(null);

      const res = await app.request(
        '/api/forms/nonexistent',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Updated' }),
        },
        env,
      );

      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Form not found');
    });

    it('handles fields serialization', async () => {
      const updatedForm = {
        ...MOCK_FORM,
        fields: JSON.stringify([{ name: 'new_field', label: 'New', type: 'text' }]),
      };
      mockUpdateForm.mockResolvedValue(updatedForm);

      const res = await app.request(
        '/api/forms/form-1',
        {
          method: 'PUT',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: [{ name: 'new_field', label: 'New', type: 'text' }],
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      expect(mockUpdateForm).toHaveBeenCalledWith(env.DB, 'form-1', expect.objectContaining({
        fields: JSON.stringify([{ name: 'new_field', label: 'New', type: 'text' }]),
      }));
    });
  });

  // ─── DELETE /api/forms/:id ──────────────────────────────────────────────

  describe('DELETE /api/forms/:id', () => {
    it('deletes a form', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);
      mockDeleteForm.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/forms/form-1',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockDeleteForm).toHaveBeenCalledWith(env.DB, 'form-1');
    });

    it('returns 404 when form not found', async () => {
      mockGetFormById.mockResolvedValue(null);

      const res = await app.request(
        '/api/forms/nonexistent',
        { method: 'DELETE', headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Form not found');
    });
  });

  // ─── GET /api/forms/:id/submissions ─────────────────────────────────────

  describe('GET /api/forms/:id/submissions', () => {
    it('returns submissions for a form', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);
      mockGetFormSubmissions.mockResolvedValue([MOCK_SUBMISSION]);

      const res = await app.request(
        '/api/forms/form-1/submissions',
        { headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(1);
      expect(json.data[0]).toMatchObject({
        id: 'sub-1',
        formId: 'form-1',
        friendId: 'friend-1',
        friendName: 'Test User',
      });
    });

    it('returns 404 when form not found', async () => {
      mockGetFormById.mockResolvedValue(null);

      const res = await app.request(
        '/api/forms/nonexistent/submissions',
        { headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Form not found');
    });

    it('returns empty array when no submissions', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);
      mockGetFormSubmissions.mockResolvedValue([]);

      const res = await app.request(
        '/api/forms/form-1/submissions',
        { headers: authHeaders() },
        env,
      );

      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(0);
    });
  });

  // ─── POST /api/forms/:id/submit ─────────────────────────────────────────

  describe('POST /api/forms/:id/submit', () => {
    it('submits form data successfully (public — no auth required)', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);
      mockCreateFormSubmission.mockResolvedValue({
        id: 'sub-new',
        form_id: 'form-1',
        friend_id: null,
        data: JSON.stringify({ email: 'user@example.com' }),
        created_at: NOW,
      });

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { email: 'user@example.com' } }),
        },
        env,
      );

      expect(res.status).toBe(201);

      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(json.success).toBe(true);
      expect(json.data.formId).toBe('form-1');
    });

    it('returns 404 when form not found', async () => {
      mockGetFormById.mockResolvedValue(null);

      const res = await app.request(
        '/api/forms/nonexistent/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        },
        env,
      );

      expect(res.status).toBe(404);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Form not found');
    });

    it('returns 400 when form is inactive', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM_INACTIVE);

      const res = await app.request(
        '/api/forms/form-inactive/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { email: 'test@test.com' } }),
        },
        env,
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('This form is no longer accepting responses');
    });

    it('returns 400 when required field is missing', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { age: 25 } }), // missing required 'email'
        },
        env,
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('メール');
      expect(json.error).toContain('必須');
    });

    it('returns 400 when required field is empty string', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { email: '' } }),
        },
        env,
      );

      expect(res.status).toBe(400);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
    });

    it('resolves friend by lineUserId', async () => {
      mockGetFormById.mockResolvedValue({
        ...MOCK_FORM,
        fields: '[]', // no required fields
      });
      mockGetFriendByLineUserId.mockResolvedValue({ id: 'friend-resolved', line_user_id: 'U12345' });
      mockGetFriendById.mockResolvedValue({
        id: 'friend-resolved',
        line_user_id: 'U12345',
        display_name: 'Resolved User',
        metadata: '{}',
      });
      mockCreateFormSubmission.mockResolvedValue({
        id: 'sub-resolved',
        form_id: 'form-1',
        friend_id: 'friend-resolved',
        data: '{}',
        created_at: NOW,
      });

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineUserId: 'U12345', data: {} }),
        },
        env,
      );

      expect(res.status).toBe(201);
      expect(mockGetFriendByLineUserId).toHaveBeenCalledWith(env.DB, 'U12345');
      expect(mockCreateFormSubmission).toHaveBeenCalledWith(env.DB, expect.objectContaining({
        friendId: 'friend-resolved',
      }));
    });

    it('uses friendId directly when provided', async () => {
      mockGetFormById.mockResolvedValue({
        ...MOCK_FORM,
        fields: '[]',
      });
      mockGetFriendById.mockResolvedValue({
        id: 'friend-direct',
        line_user_id: 'U99999',
        display_name: 'Direct Friend',
        metadata: '{}',
      });
      mockCreateFormSubmission.mockResolvedValue({
        id: 'sub-direct',
        form_id: 'form-1',
        friend_id: 'friend-direct',
        data: '{}',
        created_at: NOW,
      });

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendId: 'friend-direct', data: {} }),
        },
        env,
      );

      expect(res.status).toBe(201);
      // Should NOT call getFriendByLineUserId when friendId is provided
      expect(mockGetFriendByLineUserId).not.toHaveBeenCalled();
    });

    it('triggers side effects when form has tag, scenario, and metadata', async () => {
      mockGetFormById.mockResolvedValue({
        ...MOCK_FORM_WITH_EFFECTS,
        fields: '[]',
      });
      mockGetFriendById.mockResolvedValue({
        id: 'friend-1',
        line_user_id: 'U11111',
        display_name: 'Effect User',
        metadata: '{}',
      });
      mockCreateFormSubmission.mockResolvedValue({
        id: 'sub-effects',
        form_id: 'form-effects',
        friend_id: 'friend-1',
        data: JSON.stringify({ name: 'Test' }),
        created_at: NOW,
      });
      mockAddTagToFriend.mockResolvedValue(undefined);
      mockEnrollFriendInScenario.mockResolvedValue(undefined);

      const res = await app.request(
        '/api/forms/form-effects/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendId: 'friend-1', data: { name: 'Test' } }),
        },
        env,
      );

      expect(res.status).toBe(201);

      // Wait for side effects to complete (they use Promise.allSettled)
      await new Promise((r) => setTimeout(r, 50));

      expect(mockAddTagToFriend).toHaveBeenCalledWith(env.DB, 'friend-1', 'tag-1');
      expect(mockEnrollFriendInScenario).toHaveBeenCalledWith(env.DB, 'friend-1', 'scenario-1');
    });

    it('submits with no data defaults to empty object', async () => {
      mockGetFormById.mockResolvedValue({
        ...MOCK_FORM,
        fields: '[]', // no required fields
      });
      mockCreateFormSubmission.mockResolvedValue({
        id: 'sub-empty',
        form_id: 'form-1',
        friend_id: null,
        data: '{}',
        created_at: NOW,
      });

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );

      expect(res.status).toBe(201);
      expect(mockCreateFormSubmission).toHaveBeenCalledWith(env.DB, expect.objectContaining({
        data: '{}',
      }));
    });

    it('returns 500 on internal error', async () => {
      mockGetFormById.mockRejectedValue(new Error('DB crash'));

      const res = await app.request(
        '/api/forms/form-1/submit',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        },
        env,
      );

      expect(res.status).toBe(500);

      const json = (await res.json()) as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // ─── Serialization ──────────────────────────────────────────────────────

  describe('Serialization', () => {
    it('serializeForm converts DB row to API format', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);

      const res = await app.request('/api/forms/form-1', {}, env);
      const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };

      expect(json.data).toMatchObject({
        id: 'form-1',
        name: 'Test Form',
        description: 'A test form',
        onSubmitTagId: null,
        onSubmitScenarioId: null,
        saveToMetadata: false,
        isActive: true,
        submitCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(Array.isArray(json.data.fields)).toBe(true);
    });

    it('serializeSubmission converts DB row to API format', async () => {
      mockGetFormById.mockResolvedValue(MOCK_FORM);
      mockGetFormSubmissions.mockResolvedValue([MOCK_SUBMISSION]);

      const res = await app.request(
        '/api/forms/form-1/submissions',
        { headers: authHeaders() },
        env,
      );
      const json = (await res.json()) as { success: boolean; data: Array<Record<string, unknown>> };

      expect(json.data[0]).toMatchObject({
        id: 'sub-1',
        formId: 'form-1',
        friendId: 'friend-1',
        friendName: 'Test User',
      });
      // data should be parsed from JSON string
      expect(typeof json.data[0].data).toBe('object');
    });
  });
});
