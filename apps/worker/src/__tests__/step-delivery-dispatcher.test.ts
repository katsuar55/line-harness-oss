/**
 * Tests for step-delivery channel dispatcher integration (Round 4 PR-6.2).
 *
 * Covers `processStepDeliveries` channel routing:
 *   1. channel='line' (or undefined): existing pushMessage path, no dispatcher
 *   2. channel='email' happy path: dispatcher called, scenario advanced
 *   3. channel='email' + no emailConfig: warn logged, scenario STILL advanced
 *   4. channel='email' + missing email_template_id: scenario advanced (no stuck)
 *   5. channel='email' + template inactive: scenario advanced
 *   6. channel='email' + friend with no email anywhere: scenario advanced
 *   7. channel='both': pushMessage AND dispatcher both called
 *   8. last step + email: scenario completed (not advanced)
 *
 * Plus the route validation case for POST /api/scenarios/:id/steps:
 *   9. channel='email' without emailTemplateId returns 400
 *  10. channel='email' WITH emailTemplateId succeeds
 *  11. invalid channel value returns 400
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Friend, ScenarioStep, FriendScenario, EmailTemplate } from '@line-crm/db';
import type { DispatchInput, DispatchResult, ChannelDispatcherDeps } from '../services/channel-dispatcher.js';

// ---------------------------------------------------------------------------
// Mock @line-crm/db — only the helpers step-delivery actually calls
// ---------------------------------------------------------------------------

const mockGetFriendScenariosDueForDelivery = vi.fn<() => Promise<FriendScenario[]>>();
const mockGetScenarioSteps = vi.fn<() => Promise<ScenarioStep[]>>();
const mockGetFriendById = vi.fn<() => Promise<Friend | null>>();
const mockAdvanceFriendScenario = vi.fn<() => Promise<void>>();
const mockCompleteFriendScenario = vi.fn<() => Promise<void>>();
const mockClaimFriendScenarioForDelivery = vi.fn(async (..._a: unknown[]): Promise<boolean> => true);
const mockGetEmailTemplateById = vi.fn<() => Promise<EmailTemplate | null>>();

vi.mock('@line-crm/db', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...actual,
    getFriendScenariosDueForDelivery: () => mockGetFriendScenariosDueForDelivery(),
    getScenarioSteps: () => mockGetScenarioSteps(),
    getFriendById: () => mockGetFriendById(),
    advanceFriendScenario: () => mockAdvanceFriendScenario(),
    completeFriendScenario: () => mockCompleteFriendScenario(),
    claimFriendScenarioForDelivery: (...a: unknown[]) => mockClaimFriendScenarioForDelivery(...a),
    getEmailTemplateById: () => mockGetEmailTemplateById(),
  };
});

// ---------------------------------------------------------------------------
// Mock channel-dispatcher — the dispatcher is exhaustively tested elsewhere
// (channel-dispatcher.test.ts). Here we only check that step-delivery routes
// to it under the right conditions.
// ---------------------------------------------------------------------------

const mockDispatch = vi.fn<
  (deps: ChannelDispatcherDeps, input: DispatchInput) => Promise<DispatchResult>
>(async () => ({
  results: [
    {
      channel: 'email' as const,
      status: 'sent' as const,
      providerMessageId: 'pm-1',
      subscriberId: 'sub-1',
    },
  ],
}));

vi.mock('../services/channel-dispatcher.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../services/channel-dispatcher.js');
  return {
    ...actual,
    dispatch: (deps: ChannelDispatcherDeps, input: DispatchInput) =>
      mockDispatch(deps, input),
  };
});

// ---------------------------------------------------------------------------
// Mock email-dispatch-config so we don't need to instantiate Resend/Renderer
// ---------------------------------------------------------------------------

vi.mock('../services/email-dispatch-config.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../services/email-dispatch-config.js');
  return {
    ...actual,
    buildEmailDispatcherDeps: () => ({
      emailProvider: { send: vi.fn() } as never,
      emailRenderer: { render: vi.fn() } as never,
      emailFrom: 'naturism <noreply@example.com>',
      emailReplyTo: 'support@example.com',
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock LINE SDK — only used by the LINE branch
// ---------------------------------------------------------------------------

vi.mock('@line-crm/line-sdk', () => ({
  verifySignature: vi.fn(async () => true),
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async replyMessage() {}
    async pushMessage() {}
    async multicast() {}
  },
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { processStepDeliveries } from '../services/step-delivery.js';
import type { LineClient } from '@line-crm/line-sdk';
import type { EmailDispatchConfig } from '../services/email-dispatch-config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_NOW = new Date('2026-04-30T05:00:00.000Z'); // 14:00 JST — within window

function makeFriend(over: Partial<Friend & { email: string | null }> = {}): Friend {
  return {
    id: 'friend-1',
    line_user_id: 'U_TEST',
    display_name: 'たろう',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: 'uid-1',
    line_account_id: null,
    metadata: '{}',
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
    ...over,
  } as Friend;
}

function makeStep(over: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    id: 'step-1',
    scenario_id: 'sc-1',
    step_order: 1,
    delay_minutes: 0,
    message_type: 'text',
    message_content: 'hello {{name}}',
    condition_type: null,
    condition_value: null,
    next_step_on_false: null,
    channel: 'line',
    email_template_id: null,
    created_at: '2026-01-01T00:00:00+09:00',
    ...over,
  };
}

function makeEnrollment(): FriendScenario {
  return {
    id: 'fs-1',
    friend_id: 'friend-1',
    scenario_id: 'sc-1',
    current_step_order: 0,
    status: 'active',
    started_at: '2026-01-01T00:00:00+09:00',
    next_delivery_at: '2026-04-30T13:59:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
  };
}

function makeTemplate(over: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'tpl-1',
    name: 'Welcome',
    category: 'general',
    subject: 'ようこそ {{name}} さん',
    html_content: '<p>hi {{name}}</p>',
    text_content: 'hi {{name}}',
    preheader: null,
    is_active: 1,
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
    ...over,
  };
}

/**
 * Mock D1 prepare chain. Step-delivery only does raw queries for:
 *   - INSERT INTO messages_log (line branch)
 *   - SELECT email FROM email_subscribers WHERE friend_id (email branch)
 *
 * `subscriberEmail` controls what the email_subscribers SELECT returns.
 */
interface MockDbOpts {
  subscriberEmail?: string | null;
  /** true なら messages_log に当該 step が既配信として存在する想定 (二重配信ガード検証用) */
  alreadyDelivered?: boolean;
}

function makeMockDb(opts: MockDbOpts = {}): D1Database {
  const subscriberEmail = opts.subscriberEmail;
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes('FROM email_subscribers')) {
            return subscriberEmail ? { email: subscriberEmail } : null;
          }
          // 二重配信ガード: messages_log に既配信があれば送信を skip させる
          if (sql.includes('FROM messages_log')) {
            return opts.alreadyDelivered ? { 1: 1 } : null;
          }
          return null;
        }),
        all: vi.fn(async () => ({ results: [], success: true })),
        run: vi.fn(async () => ({ success: true, meta: { changes: 1 } })),
      })),
    })),
  } as unknown as D1Database;
}

function makeLineClient(): LineClient & { pushMessage: ReturnType<typeof vi.fn> } {
  return {
    pushMessage: vi.fn(async () => {}),
    replyMessage: vi.fn(async () => {}),
    multicast: vi.fn(async () => {}),
  } as unknown as LineClient & { pushMessage: ReturnType<typeof vi.fn> };
}

const fakeEmailConfig: EmailDispatchConfig = {
  resendApiKey: 're_xxx',
  emailFrom: 'naturism <noreply@example.com>',
  emailReplyTo: 'support@example.com',
  emailUnsubscribeBaseUrl: 'https://example.com/unsub',
  emailUnsubscribeHmacKey: 'k',
  emailLegalFooterHtml: '<p>footer</p>',
  emailLegalFooterText: 'footer',
};

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('processStepDeliveries — channel dispatcher routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(STUB_NOW);
    // Default: one due enrollment, friend exists & follows
    mockGetFriendScenariosDueForDelivery.mockResolvedValue([makeEnrollment()]);
    mockGetFriendById.mockResolvedValue(makeFriend());
    mockAdvanceFriendScenario.mockResolvedValue(undefined);
    mockCompleteFriendScenario.mockResolvedValue(undefined);
    mockClaimFriendScenarioForDelivery.mockResolvedValue(true); // default: claim 成功
    mockDispatch.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm-1', subscriberId: 'sub-1' }],
    } as never);
  });

  afterEach(() => {
    // Restore real timers so the route-level suite (which runs Hono and needs
    // real `setTimeout` from the rate-limit middleware) doesn't hang.
    vi.useRealTimers();
  });

  it('channel=line: pushMessage called, dispatcher NOT called', async () => {
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, 'https://worker.test', fakeEmailConfig);

    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
    // Last step → completeFriendScenario, not advance
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('二重配信ガード: 同一 step が messages_log に既配信なら送信 skip・state は前進', async () => {
    // friend_add 即時 reply 配信や advance 失敗後の cron 再処理を想定。
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    const lineClient = makeLineClient();
    const db = makeMockDb({ alreadyDelivered: true });

    await processStepDeliveries(db, lineClient, 'https://worker.test', fakeEmailConfig);

    // 送信は skip (二重メッセージ防止)
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    // state は前進する (last step → complete) ので stuck しない
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('atomic claim 成功 → 配信進行 + claim を (id, 観測 next_delivery_at) で呼ぶ', async () => {
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, null);

    expect(mockClaimFriendScenarioForDelivery).toHaveBeenCalledTimes(1);
    const args = mockClaimFriendScenarioForDelivery.mock.calls[0];
    expect(args[1]).toBe('fs-1'); // friend_scenario id
    expect(args[2]).toBe('2026-04-30T13:59:00+09:00'); // 観測した next_delivery_at で CAS
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
  });

  it('atomic claim 失敗 (= 別 worker が処理中) → 一切配信せず friend 読込にも進まない (= 二重配信防止)', async () => {
    mockClaimFriendScenarioForDelivery.mockResolvedValue(false);
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, null);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(mockGetFriendById).not.toHaveBeenCalled();
    expect(mockAdvanceFriendScenario).not.toHaveBeenCalled();
    expect(mockCompleteFriendScenario).not.toHaveBeenCalled();
  });

  it('blacklisted friend (following) → 配信せず scenario complete (consent/景表法)', async () => {
    // is_following=1 だが is_blacklisted=1 → 既存の未follow guard と同様に terminal 扱い。
    // completeFriendScenario が claim lease を最終値で上書きするため #103 不変条件を保持。
    // guard は friend 読込直後 = step 取得より前なので getScenarioSteps には到達しない。
    mockGetFriendById.mockResolvedValue(makeFriend({ is_blacklisted: 1 }));
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, null);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockGetScenarioSteps).not.toHaveBeenCalled();
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
    expect(mockAdvanceFriendScenario).not.toHaveBeenCalled();
  });

  it('is_blacklisted=0 の通常 friend は従来どおり配信される (回帰防止)', async () => {
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    mockGetFriendById.mockResolvedValue(makeFriend({ is_blacklisted: 0 }));
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, 'https://worker.test', fakeEmailConfig);

    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('channel undefined (legacy rows): treated as line, dispatcher NOT called', async () => {
    // Drop channel/email_template_id to simulate pre-migration row shape
    const legacyStep = {
      ...makeStep(),
      channel: undefined,
      email_template_id: undefined,
    } as ScenarioStep;
    mockGetScenarioSteps.mockResolvedValue([legacyStep]);
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('channel=email + emailConfig + valid template + subscriber email: dispatcher called, scenario completed', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1' }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: 'tester@example.com' });

    await processStepDeliveries(db, lineClient, 'https://worker.test', fakeEmailConfig);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0][1];
    expect(call.channel).toBe('email');
    expect(call.recipient.email).toBe('tester@example.com');
    expect(call.emailPayload?.subjectTemplate).toBe('ようこそ {{name}} さん');
    expect(call.emailPayload?.templateId).toBe('tpl-1');
    expect(call.source?.scenarioStepId).toBe('step-1');
    // No LINE push for pure email step
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    // Last step → completed
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('channel=email + no emailConfig: warn logged, scenario STILL advanced (not stuck)', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1', step_order: 1 }),
      makeStep({ id: 'step-2', channel: 'line', step_order: 2 }),
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, null);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    // Scenario must advance to step 2 — must NOT be stuck on the email step
    expect(mockAdvanceFriendScenario).toHaveBeenCalledTimes(1);
    expect(mockCompleteFriendScenario).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('channel=email + missing email_template_id: scenario advanced, no dispatcher call', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: null, step_order: 1 }),
      makeStep({ id: 'step-2', channel: 'line', step_order: 2 }),
    ]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockGetEmailTemplateById).not.toHaveBeenCalled();
    expect(mockAdvanceFriendScenario).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('channel=email + template inactive (is_active=0): scenario advanced, no dispatcher call', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1', step_order: 1 }),
      makeStep({ id: 'step-2', channel: 'line', step_order: 2 }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate({ is_active: 0 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: 'tester@example.com' });

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockAdvanceFriendScenario).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('channel=email + template not found: scenario advanced, no dispatcher call', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1', step_order: 1 }),
      makeStep({ id: 'step-2', channel: 'line', step_order: 2 }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(null);
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: 'tester@example.com' });

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockAdvanceFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('channel=email + friend has no email anywhere: scenario advanced, no dispatcher call', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1', step_order: 1 }),
      makeStep({ id: 'step-2', channel: 'line', step_order: 2 }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    // Friend with no email column AND no email_subscribers row
    mockGetFriendById.mockResolvedValue(makeFriend({ email: null }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: null });

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockAdvanceFriendScenario).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('channel=email + friend has no subscriber but friend.email exists: dispatcher called with friends.email', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'email', email_template_id: 'tpl-1' }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    mockGetFriendById.mockResolvedValue(makeFriend({ email: 'fallback@example.com' }));
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: null });

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const call = mockDispatch.mock.calls[0][1];
    expect(call.recipient.email).toBe('fallback@example.com');
  });

  it('channel=both: pushMessage AND dispatcher both called, scenario completed', async () => {
    mockGetScenarioSteps.mockResolvedValue([
      makeStep({ channel: 'both', email_template_id: 'tpl-1' }),
    ]);
    mockGetEmailTemplateById.mockResolvedValue(makeTemplate());
    const lineClient = makeLineClient();
    const db = makeMockDb({ subscriberEmail: 'tester@example.com' });

    await processStepDeliveries(db, lineClient, 'https://worker.test', fakeEmailConfig);

    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockCompleteFriendScenario).toHaveBeenCalledTimes(1);
  });

  it('skipped when JST hour outside 9-23 window', async () => {
    // 00:00 UTC → 09:00 JST is OK; 22:00 UTC → 07:00 JST is NOT
    vi.setSystemTime(new Date('2026-04-30T22:00:00.000Z')); // 07:00 JST
    mockGetScenarioSteps.mockResolvedValue([makeStep({ channel: 'line' })]);
    const lineClient = makeLineClient();
    const db = makeMockDb();

    await processStepDeliveries(db, lineClient, undefined, fakeEmailConfig);

    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockGetFriendScenariosDueForDelivery).not.toHaveBeenCalled();
  });
});

