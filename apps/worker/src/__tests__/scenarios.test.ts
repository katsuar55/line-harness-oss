/**
 * API tests for the scenarios (step delivery) routes.
 *
 * Covers:
 *   1. GET /api/scenarios — list all scenarios
 *   2. POST /api/scenarios — create scenario (success + validation error)
 *   3. GET /api/scenarios/:id — get single scenario with steps
 *   4. PUT /api/scenarios/:id — update scenario
 *   5. DELETE /api/scenarios/:id — delete scenario
 *   6. POST /api/scenarios/:id/steps — add step (success + validation error)
 *   7. Authentication — 401 when no Bearer token
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Scenario,
  ScenarioWithStepCount,
  ScenarioWithSteps,
  ScenarioStep,
  FriendScenario,
} from '@line-crm/db';

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'scenario-1',
    name: 'Welcome Flow',
    description: 'Onboarding scenario',
    trigger_type: 'friend_add',
    trigger_tag_id: null,
    line_account_id: null,
    is_active: 1,
    created_at: '2025-01-01T00:00:00+09:00',
    updated_at: '2025-01-01T00:00:00+09:00',
    ...overrides,
  };
}

function makeScenarioWithStepCount(
  overrides: Partial<ScenarioWithStepCount> = {},
): ScenarioWithStepCount {
  return {
    ...makeScenario(),
    step_count: 3,
    ...overrides,
  };
}

function makeStep(overrides: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    id: 'step-1',
    scenario_id: 'scenario-1',
    step_order: 1,
    delay_minutes: 0,
    message_type: 'text',
    message_content: 'Hello!',
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    created_at: '2025-01-01T00:00:00+09:00',
    ...overrides,
  };
}

function makeEnrollment(overrides: Partial<FriendScenario> = {}): FriendScenario {
  return {
    id: 'enroll-1',
    friend_id: 'friend-1',
    scenario_id: 'scenario-1',
    current_step_order: 0,
    status: 'active',
    started_at: '2025-01-01T00:00:00+09:00',
    next_delivery_at: '2025-01-01T01:00:00+09:00',
    updated_at: '2025-01-01T00:00:00+09:00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock @line-crm/db
// ---------------------------------------------------------------------------

const mockGetScenarios = vi.fn<() => Promise<ScenarioWithStepCount[]>>();
const mockGetScenarioById = vi.fn<(db: D1Database, id: string) => Promise<ScenarioWithSteps | null>>();
const mockCreateScenario = vi.fn<(db: D1Database, input: unknown) => Promise<Scenario>>();
const mockUpdateScenario = vi.fn<(db: D1Database, id: string, updates: unknown) => Promise<Scenario | null>>();
const mockDeleteScenario = vi.fn<(db: D1Database, id: string) => Promise<void>>();
const mockCreateScenarioStep = vi.fn<(db: D1Database, input: unknown) => Promise<ScenarioStep>>();
const mockUpdateScenarioStep = vi.fn<(db: D1Database, id: string, updates: unknown) => Promise<ScenarioStep | null>>();
const mockDeleteScenarioStep = vi.fn<(db: D1Database, id: string) => Promise<void>>();
const mockEnrollFriendInScenario = vi.fn<(db: D1Database, friendId: string, scenarioId: string) => Promise<FriendScenario>>();
const mockGetFriendById = vi.fn();
const mockGetStaffByApiKey = vi.fn();

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getScenarios: () => mockGetScenarios(),
    getScenarioById: (...args: unknown[]) => mockGetScenarioById(...(args as [never, never])),
    createScenario: (...args: unknown[]) => mockCreateScenario(...(args as [never, never])),
    updateScenario: (...args: unknown[]) => mockUpdateScenario(...(args as [never, never, never])),
    deleteScenario: (...args: unknown[]) => mockDeleteScenario(...(args as [never, never])),
    createScenarioStep: (...args: unknown[]) => mockCreateScenarioStep(...(args as [never, never])),
    updateScenarioStep: (...args: unknown[]) => mockUpdateScenarioStep(...(args as [never, never, never])),
    deleteScenarioStep: (...args: unknown[]) => mockDeleteScenarioStep(...(args as [never, never])),
    enrollFriendInScenario: (...args: unknown[]) => mockEnrollFriendInScenario(...(args as [never, never, never])),
    getFriendById: (...args: unknown[]) => mockGetFriendById(...(args as [never, never])),
    getStaffByApiKey: (...args: unknown[]) => mockGetStaffByApiKey(...(args as [never, never])),
  };
});

// ---------------------------------------------------------------------------
// Import app after mocks are set up
// ---------------------------------------------------------------------------

import app from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = 'test-api-key-12345';

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Build a mock D1 prepare chain for simple queries (used for lineAccountId filter) */
function mockD1Prepare(results: unknown[] = []) {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results }),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
      }),
    }),
  };
}

const mockEnv = {
  DB: mockD1Prepare() as unknown as D1Database,
  AI: {} as Ai,
  LINE_CHANNEL_SECRET: 'test-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
  API_KEY: TEST_API_KEY,
  LIFF_URL: 'https://liff.line.me/test',
  LINE_CHANNEL_ID: 'test-channel-id',
  LINE_LOGIN_CHANNEL_ID: 'test-login-channel-id',
  LINE_LOGIN_CHANNEL_SECRET: 'test-login-secret',
  WORKER_URL: 'https://worker.example.com',
};

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: headers ?? authHeaders(),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const req = new Request(`http://localhost${path}`, init);

  return app.fetch(req, mockEnv, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scenarios API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: auth passes via env API_KEY
    mockGetStaffByApiKey.mockResolvedValue(null);
  });

  // ========================================================================
  // Authentication
  // ========================================================================

  describe('Authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request('GET', '/api/scenarios', undefined, {});
      expect(res.status).toBe(401);
      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 401 when Bearer token is invalid', async () => {
      const res = await request('GET', '/api/scenarios', undefined, {
        Authorization: 'Bearer wrong-key',
      });
      expect(res.status).toBe(401);
    });
  });

  // ========================================================================
  // GET /api/scenarios
  // ========================================================================

  describe('GET /api/scenarios', () => {
    it('returns a list of scenarios', async () => {
      const items = [
        makeScenarioWithStepCount({ id: 's1', name: 'Flow A' }),
        makeScenarioWithStepCount({ id: 's2', name: 'Flow B', step_count: 0 }),
      ];
      mockGetScenarios.mockResolvedValue(items);

      const res = await request('GET', '/api/scenarios');
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: unknown[] };
      expect(json.success).toBe(true);
      expect(json.data).toHaveLength(2);
      expect((json.data[0] as Record<string, unknown>).name).toBe('Flow A');
      expect((json.data[0] as Record<string, unknown>).stepCount).toBe(3);
    });

    it('returns empty array when no scenarios exist', async () => {
      mockGetScenarios.mockResolvedValue([]);

      const res = await request('GET', '/api/scenarios');
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: unknown[] };
      expect(json.data).toHaveLength(0);
    });

    it('filters by lineAccountId when query param is provided', async () => {
      const filtered = [makeScenarioWithStepCount({ id: 's1', line_account_id: 'acc-1' })];
      // The route directly queries DB when lineAccountId is set, not via getScenarios
      (mockEnv.DB as unknown as ReturnType<typeof mockD1Prepare>).prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: filtered }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      });

      const res = await request('GET', '/api/scenarios?lineAccountId=acc-1');
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: unknown[] };
      expect(json.data).toHaveLength(1);
    });

    it('returns 500 on internal error', async () => {
      mockGetScenarios.mockRejectedValue(new Error('DB failure'));

      const res = await request('GET', '/api/scenarios');
      expect(res.status).toBe(500);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toBe('Internal server error');
    });
  });

  // ========================================================================
  // GET /api/scenarios/:id
  // ========================================================================

  describe('GET /api/scenarios/:id', () => {
    it('returns a scenario with its steps', async () => {
      const scenario: ScenarioWithSteps = {
        ...makeScenario({ id: 's1' }),
        steps: [
          makeStep({ id: 'st1', step_order: 1 }),
          makeStep({ id: 'st2', step_order: 2, delay_minutes: 60 }),
        ],
      };
      mockGetScenarioById.mockResolvedValue(scenario);

      const res = await request('GET', '/api/scenarios/s1');
      expect(res.status).toBe(200);

      const json = await res.json() as {
        success: boolean;
        data: { id: string; steps: Array<{ id: string; stepOrder: number }> };
      };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('s1');
      expect(json.data.steps).toHaveLength(2);
      // Verify camelCase serialization
      expect(json.data.steps[0].stepOrder).toBe(1);
    });

    it('returns 404 when scenario is not found', async () => {
      mockGetScenarioById.mockResolvedValue(null);

      const res = await request('GET', '/api/scenarios/nonexistent');
      expect(res.status).toBe(404);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toBe('Scenario not found');
    });
  });

  // ========================================================================
  // POST /api/scenarios
  // ========================================================================

  describe('POST /api/scenarios', () => {
    it('creates a new scenario with required fields', async () => {
      const created = makeScenario({ id: 'new-1', name: 'New Flow' });
      mockCreateScenario.mockResolvedValue(created);

      const res = await request('POST', '/api/scenarios', {
        name: 'New Flow',
        triggerType: 'friend_add',
      });
      expect(res.status).toBe(201);

      const json = await res.json() as { success: boolean; data: { id: string; triggerType: string } };
      expect(json.success).toBe(true);
      expect(json.data.id).toBe('new-1');
      expect(json.data.triggerType).toBe('friend_add');
    });

    it('creates inactive scenario when isActive=false', async () => {
      const created = makeScenario({ id: 'new-2', is_active: 1 });
      const updated = makeScenario({ id: 'new-2', is_active: 0 });
      mockCreateScenario.mockResolvedValue(created);
      mockUpdateScenario.mockResolvedValue(updated);

      const res = await request('POST', '/api/scenarios', {
        name: 'Inactive Flow',
        triggerType: 'manual',
        isActive: false,
      });
      expect(res.status).toBe(201);

      const json = await res.json() as { success: boolean; data: { isActive: boolean } };
      expect(json.data.isActive).toBe(false);
      expect(mockUpdateScenario).toHaveBeenCalled();
    });

    it('returns 400 when name is missing', async () => {
      const res = await request('POST', '/api/scenarios', {
        triggerType: 'friend_add',
      });
      expect(res.status).toBe(400);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('name');
    });

    it('returns 400 when triggerType is missing', async () => {
      const res = await request('POST', '/api/scenarios', {
        name: 'Flow without trigger',
      });
      expect(res.status).toBe(400);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.success).toBe(false);
      expect(json.error).toContain('triggerType');
    });
  });

  // ========================================================================
  // PUT /api/scenarios/:id
  // ========================================================================

  describe('PUT /api/scenarios/:id', () => {
    it('updates a scenario', async () => {
      const updated = makeScenario({ id: 's1', name: 'Updated Flow' });
      mockUpdateScenario.mockResolvedValue(updated);

      const res = await request('PUT', '/api/scenarios/s1', {
        name: 'Updated Flow',
      });
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: { name: string } };
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('Updated Flow');
    });

    it('returns 404 when scenario does not exist', async () => {
      mockUpdateScenario.mockResolvedValue(null);

      const res = await request('PUT', '/api/scenarios/nonexistent', {
        name: 'Does not exist',
      });
      expect(res.status).toBe(404);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toBe('Scenario not found');
    });

    it('passes isActive as 1/0 integer to the DB layer', async () => {
      const updated = makeScenario({ id: 's1', is_active: 0 });
      mockUpdateScenario.mockResolvedValue(updated);

      await request('PUT', '/api/scenarios/s1', { isActive: false });

      const callArgs = mockUpdateScenario.mock.calls[0];
      expect((callArgs[2] as Record<string, unknown>).is_active).toBe(0);
    });
  });

  // ========================================================================
  // DELETE /api/scenarios/:id
  // ========================================================================

  describe('DELETE /api/scenarios/:id', () => {
    it('deletes a scenario and returns success', async () => {
      mockDeleteScenario.mockResolvedValue(undefined);

      const res = await request('DELETE', '/api/scenarios/s1');
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
      expect(mockDeleteScenario).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // POST /api/scenarios/:id/steps
  // ========================================================================

  describe('POST /api/scenarios/:id/steps', () => {
    it('adds a step to a scenario', async () => {
      const step = makeStep({
        id: 'st-new',
        scenario_id: 's1',
        step_order: 2,
        message_type: 'text',
        message_content: 'Step 2 message',
      });
      mockCreateScenarioStep.mockResolvedValue(step);

      const res = await request('POST', '/api/scenarios/s1/steps', {
        stepOrder: 2,
        messageType: 'text',
        messageContent: 'Step 2 message',
      });
      expect(res.status).toBe(201);

      const json = await res.json() as {
        success: boolean;
        data: { id: string; scenarioId: string; stepOrder: number; messageContent: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.scenarioId).toBe('s1');
      expect(json.data.stepOrder).toBe(2);
      expect(json.data.messageContent).toBe('Step 2 message');
    });

    it('returns 400 when stepOrder is missing', async () => {
      const res = await request('POST', '/api/scenarios/s1/steps', {
        messageType: 'text',
        messageContent: 'Missing stepOrder',
      });
      expect(res.status).toBe(400);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toContain('stepOrder');
    });

    it('returns 400 when messageType is missing', async () => {
      const res = await request('POST', '/api/scenarios/s1/steps', {
        stepOrder: 1,
        messageContent: 'Missing type',
      });
      expect(res.status).toBe(400);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toContain('messageType');
    });

    it('returns 400 when messageContent is missing', async () => {
      const res = await request('POST', '/api/scenarios/s1/steps', {
        stepOrder: 1,
        messageType: 'text',
      });
      expect(res.status).toBe(400);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toContain('messageContent');
    });
  });

  // ========================================================================
  // PUT /api/scenarios/:id/steps/:stepId
  // ========================================================================

  describe('PUT /api/scenarios/:id/steps/:stepId', () => {
    it('updates a step', async () => {
      const updated = makeStep({ id: 'st1', delay_minutes: 120 });
      mockUpdateScenarioStep.mockResolvedValue(updated);

      const res = await request('PUT', '/api/scenarios/s1/steps/st1', {
        delayMinutes: 120,
      });
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: { delayMinutes: number } };
      expect(json.data.delayMinutes).toBe(120);
    });

    it('returns 404 when step does not exist', async () => {
      mockUpdateScenarioStep.mockResolvedValue(null);

      const res = await request('PUT', '/api/scenarios/s1/steps/nonexistent', {
        delayMinutes: 30,
      });
      expect(res.status).toBe(404);

      const json = await res.json() as { success: boolean; error: string };
      expect(json.error).toBe('Step not found');
    });
  });

  // ========================================================================
  // DELETE /api/scenarios/:id/steps/:stepId
  // ========================================================================

  describe('DELETE /api/scenarios/:id/steps/:stepId', () => {
    it('deletes a step and returns success', async () => {
      mockDeleteScenarioStep.mockResolvedValue(undefined);

      const res = await request('DELETE', '/api/scenarios/s1/steps/st1');
      expect(res.status).toBe(200);

      const json = await res.json() as { success: boolean; data: null };
      expect(json.success).toBe(true);
      expect(json.data).toBeNull();
    });
  });

  // ========================================================================
  // POST /api/scenarios/:id/enroll/:friendId
  // ========================================================================

  describe('POST /api/scenarios/:id/enroll/:friendId', () => {
    it('enrolls a friend in a scenario', async () => {
      const scenario: ScenarioWithSteps = {
        ...makeScenario({ id: 's1' }),
        steps: [makeStep()],
      };
      mockGetScenarioById.mockResolvedValue(scenario);
      mockGetFriendById.mockResolvedValue({ id: 'friend-1', display_name: 'Taro' });
      mockEnrollFriendInScenario.mockResolvedValue(makeEnrollment());

      const res = await request('POST', '/api/scenarios/s1/enroll/friend-1');
      expect(res.status).toBe(201);

      const json = await res.json() as {
        success: boolean;
        data: { friendId: string; scenarioId: string; status: string };
      };
      expect(json.success).toBe(true);
      expect(json.data.friendId).toBe('friend-1');
      expect(json.data.scenarioId).toBe('scenario-1');
      expect(json.data.status).toBe('active');
    });

    it('returns 404 when scenario does not exist', async () => {
      mockGetScenarioById.mockResolvedValue(null);
      mockGetFriendById.mockResolvedValue({ id: 'friend-1' });

      const res = await request('POST', '/api/scenarios/bad-id/enroll/friend-1');
      expect(res.status).toBe(404);

      const json = await res.json() as { error: string };
      expect(json.error).toBe('Scenario not found');
    });

    it('returns 404 when friend does not exist', async () => {
      const scenario: ScenarioWithSteps = {
        ...makeScenario({ id: 's1' }),
        steps: [],
      };
      mockGetScenarioById.mockResolvedValue(scenario);
      mockGetFriendById.mockResolvedValue(null);

      const res = await request('POST', '/api/scenarios/s1/enroll/bad-friend');
      expect(res.status).toBe(404);

      const json = await res.json() as { error: string };
      expect(json.error).toBe('Friend not found');
    });
  });
});
