/**
 * Tests for scenarios route channel field validation (Round 4 PR-6.2).
 *
 * Covers:
 *   - POST /api/scenarios/:id/steps with `channel='email'` requires `emailTemplateId` (400)
 *   - POST /api/scenarios/:id/steps with `channel='both'` requires `emailTemplateId` (400)
 *   - POST /api/scenarios/:id/steps with invalid channel value returns 400
 *   - POST /api/scenarios/:id/steps with channel='email' + emailTemplateId succeeds
 *   - PUT  /api/scenarios/:id/steps/:stepId rejects invalid channel value
 *   - PUT  /api/scenarios/:id/steps/:stepId passes channel + emailTemplateId through
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScenarioStep } from '@line-crm/db';

const mockCreateScenarioStep = vi.fn<(db: unknown, input: unknown) => Promise<ScenarioStep>>();
const mockUpdateScenarioStep = vi.fn<(db: unknown, id: string, input: unknown) => Promise<ScenarioStep | null>>();
const mockGetStaffByApiKey = vi.fn();

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    createScenarioStep: (...args: unknown[]) => mockCreateScenarioStep(...(args as [never, never])),
    updateScenarioStep: (...args: unknown[]) => mockUpdateScenarioStep(...(args as [never, never, never])),
    getStaffByApiKey: () => mockGetStaffByApiKey(),
  };
});

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async multicast() {}
  },
}));

import app from '../index.js';

const TEST_API_KEY = 'test-api-key-12345';

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function makeMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
      }),
    }),
  } as unknown as D1Database;
}

const mockEnv = {
  DB: makeMockDb(),
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
  return app.fetch(
    req,
    mockEnv,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
  );
}

function makeStepRow(over: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    id: 'step-new',
    scenario_id: 'sc-1',
    step_order: 1,
    delay_minutes: 0,
    message_type: 'text',
    message_content: 'hi',
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    channel: 'line',
    email_template_id: null,
    created_at: '2026-01-01T00:00:00+09:00',
    ...over,
  };
}

describe('POST /api/scenarios/:id/steps — channel field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStaffByApiKey.mockResolvedValue(null);
  });

  it('returns 400 when channel=email but emailTemplateId is missing', async () => {
    const res = await request('POST', '/api/scenarios/sc-1/steps', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hi',
      channel: 'email',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('emailTemplateId');
    expect(mockCreateScenarioStep).not.toHaveBeenCalled();
  });

  it('returns 400 when channel=both but emailTemplateId is missing', async () => {
    const res = await request('POST', '/api/scenarios/sc-1/steps', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hi',
      channel: 'both',
    });
    expect(res.status).toBe(400);
    expect(mockCreateScenarioStep).not.toHaveBeenCalled();
  });

  it('returns 400 when channel value is invalid', async () => {
    const res = await request('POST', '/api/scenarios/sc-1/steps', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hi',
      channel: 'sms',
    });
    expect(res.status).toBe(400);
    expect(mockCreateScenarioStep).not.toHaveBeenCalled();
  });

  it('succeeds when channel=email AND emailTemplateId provided, passing both to createScenarioStep', async () => {
    mockCreateScenarioStep.mockResolvedValue(
      makeStepRow({ channel: 'email', email_template_id: 'tpl-1' }),
    );

    const res = await request('POST', '/api/scenarios/sc-1/steps', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hi',
      channel: 'email',
      emailTemplateId: 'tpl-1',
    });

    expect(res.status).toBe(201);
    expect(mockCreateScenarioStep).toHaveBeenCalledTimes(1);
    const callInput = mockCreateScenarioStep.mock.calls[0][1] as Record<string, unknown>;
    expect(callInput.channel).toBe('email');
    expect(callInput.emailTemplateId).toBe('tpl-1');

    const body = (await res.json()) as { success: boolean; data: { channel: string; emailTemplateId: string } };
    expect(body.data.channel).toBe('email');
    expect(body.data.emailTemplateId).toBe('tpl-1');
  });

  it('defaults channel to "line" when omitted', async () => {
    mockCreateScenarioStep.mockResolvedValue(makeStepRow());

    const res = await request('POST', '/api/scenarios/sc-1/steps', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hi',
    });

    expect(res.status).toBe(201);
    const callInput = mockCreateScenarioStep.mock.calls[0][1] as Record<string, unknown>;
    expect(callInput.channel).toBe('line');
    expect(callInput.emailTemplateId).toBeNull();
  });
});

describe('PUT /api/scenarios/:id/steps/:stepId — channel field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStaffByApiKey.mockResolvedValue(null);
  });

  it('returns 400 when channel value is invalid', async () => {
    const res = await request('PUT', '/api/scenarios/sc-1/steps/step-1', {
      channel: 'fax',
    });
    expect(res.status).toBe(400);
    expect(mockUpdateScenarioStep).not.toHaveBeenCalled();
  });

  it('passes channel + emailTemplateId through to updateScenarioStep', async () => {
    mockUpdateScenarioStep.mockResolvedValue(
      makeStepRow({ id: 'step-1', channel: 'both', email_template_id: 'tpl-2' }),
    );

    const res = await request('PUT', '/api/scenarios/sc-1/steps/step-1', {
      channel: 'both',
      emailTemplateId: 'tpl-2',
    });

    expect(res.status).toBe(200);
    expect(mockUpdateScenarioStep).toHaveBeenCalledTimes(1);
    const updates = mockUpdateScenarioStep.mock.calls[0][2] as Record<string, unknown>;
    expect(updates.channel).toBe('both');
    expect(updates.email_template_id).toBe('tpl-2');
  });
});
