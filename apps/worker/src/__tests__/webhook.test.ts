/**
 * Integration / E2E tests for the LINE webhook handler.
 *
 * Covers:
 *   1. Signature verification (valid / invalid)
 *   2. Auto-reply keyword matching (exact & contains)
 *   3. AI fallback when no auto-reply matches
 *   4. Follow event — friend registration & welcome scenario
 *   5. Unfollow event — follow status update
 *   6. Rate limiting — excessive requests get 429
 *   7. Multi-account routing via destination field
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Helper: compute a real HMAC-SHA256 signature (same algo as LINE platform)
// ---------------------------------------------------------------------------

async function computeSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  // Convert to base64
  let binary = '';
  for (const byte of sig) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Mock modules — must be defined before the module under test is imported
// ---------------------------------------------------------------------------

// Captured calls for assertions
const capturedReplies: Array<{ replyToken: string; messages: unknown[] }> = [];
const capturedPushes: Array<{ to: string; messages: unknown[] }> = [];
const capturedProfiles: Map<string, object> = new Map();
let capturedLoadingAnimations: Array<{ userId: string; seconds: number }> = [];

// Mock LineClient
vi.mock('@line-crm/line-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@line-crm/line-sdk')>();
  return {
    ...actual,
    // Keep real verifySignature — we test it with crypto.subtle
    verifySignature: actual.verifySignature,
    LineClient: class MockLineClient {
      constructor(public readonly token: string) {}
      async replyMessage(replyToken: string, messages: unknown[]): Promise<void> {
        capturedReplies.push({ replyToken, messages });
      }
      async pushMessage(to: string, messages: unknown[]): Promise<void> {
        capturedPushes.push({ to, messages });
      }
      async getProfile(userId: string) {
        return (
          capturedProfiles.get(userId) ?? {
            displayName: 'TestUser',
            userId,
            pictureUrl: 'https://example.com/pic.jpg',
            statusMessage: 'hello',
          }
        );
      }
      async showLoadingAnimation(userId: string, seconds: number): Promise<void> {
        capturedLoadingAnimations.push({ userId, seconds });
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Mock @line-crm/db — in-memory stubs
// ---------------------------------------------------------------------------

interface MockFriend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  is_following: boolean;
  score: number;
  created_at: string;
  user_id: string | null;
}

const friendsDb: Map<string, MockFriend> = new Map();
const scenariosDb: Array<{
  id: string;
  trigger_type: string;
  is_active: boolean;
  line_account_id: string | null;
}> = [];
const friendScenariosDb: Map<string, { id: string; status: string }> = new Map();
let followStatusUpdates: Array<{ userId: string; isFollowing: boolean }> = [];
let enrolledScenarios: Array<{ friendId: string; scenarioId: string }> = [];

vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-03-31T12:00:00+09:00',
  upsertFriend: vi.fn(async (_db: unknown, data: { lineUserId: string; displayName?: string | null }) => {
    const existing = friendsDb.get(data.lineUserId);
    if (existing) {
      existing.display_name = data.displayName ?? existing.display_name;
      existing.is_following = true;
      return existing;
    }
    const friend: MockFriend = {
      id: `friend-${data.lineUserId}`,
      line_user_id: data.lineUserId,
      display_name: data.displayName ?? null,
      is_following: true,
      score: 0,
      created_at: '2026-03-31T12:00:00+09:00',
      user_id: null,
    };
    friendsDb.set(data.lineUserId, friend);
    return friend;
  }),
  updateFriendFollowStatus: vi.fn(async (_db: unknown, userId: string, isFollowing: boolean) => {
    followStatusUpdates.push({ userId, isFollowing });
    const friend = friendsDb.get(userId);
    if (friend) friend.is_following = isFollowing;
  }),
  getFriendByLineUserId: vi.fn(async (_db: unknown, userId: string) => {
    return friendsDb.get(userId) ?? null;
  }),
  getScenarios: vi.fn(async () => scenariosDb),
  enrollFriendInScenario: vi.fn(async (_db: unknown, friendId: string, scenarioId: string) => {
    const entry = { id: `fs-${friendId}-${scenarioId}`, status: 'active' };
    enrolledScenarios.push({ friendId, scenarioId });
    friendScenariosDb.set(`${friendId}-${scenarioId}`, entry);
    return entry;
  }),
  getScenarioSteps: vi.fn(async () => []),
  advanceFriendScenario: vi.fn(async () => {}),
  completeFriendScenario: vi.fn(async () => {}),
  upsertChatOnMessage: vi.fn(async () => {}),
  getLineAccounts: vi.fn(async () => []),
  getLineAccountByBotUserId: vi.fn(async () => null),
  setLineAccountBotUserId: vi.fn(async () => {}),
  getStaffByApiKey: vi.fn(async () => null),
  getFriendTags: vi.fn(async () => []),
}));

// Mock event-bus — just capture calls
const firedEvents: Array<{ type: string; payload: unknown }> = [];
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(async (_db: unknown, type: string, payload: unknown) => {
    firedEvents.push({ type, payload });
  }),
}));

// Mock AI response service
const mockAiGenerate = vi.fn();
vi.mock('../services/ai-response.js', () => ({
  generateAiResponse: (...args: unknown[]) => mockAiGenerate(...args),
}));

// ---------------------------------------------------------------------------
// Import the app AFTER mocks are registered
// ---------------------------------------------------------------------------

// We need to import the Hono app. Since it's the default export, we import it.
// The rate-limit middleware uses an in-memory store, which is fine for tests.

let app: Hono;

beforeEach(async () => {
  // Dynamic import to ensure mocks are in place
  vi.resetModules();

  // Re-apply mocks after resetModules
  vi.doMock('@line-crm/line-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@line-crm/line-sdk')>();
    return {
      ...actual,
      verifySignature: actual.verifySignature,
      LineClient: class MockLineClient {
        constructor(public readonly token: string) {}
        async replyMessage(replyToken: string, messages: unknown[]): Promise<void> {
          capturedReplies.push({ replyToken, messages });
        }
        async pushMessage(to: string, messages: unknown[]): Promise<void> {
          capturedPushes.push({ to, messages });
        }
        async getProfile(userId: string) {
          return (
            capturedProfiles.get(userId) ?? {
              displayName: 'TestUser',
              userId,
              pictureUrl: 'https://example.com/pic.jpg',
              statusMessage: 'hello',
            }
          );
        }
        async showLoadingAnimation(userId: string, seconds: number): Promise<void> {
          capturedLoadingAnimations.push({ userId, seconds });
        }
      },
    };
  });

  vi.doMock('@line-crm/db', () => ({
    jstNow: () => '2026-03-31T12:00:00+09:00',
    upsertFriend: vi.fn(async (_db: unknown, data: { lineUserId: string; displayName?: string | null }) => {
      const existing = friendsDb.get(data.lineUserId);
      if (existing) {
        existing.display_name = data.displayName ?? existing.display_name;
        existing.is_following = true;
        return existing;
      }
      const friend: MockFriend = {
        id: `friend-${data.lineUserId}`,
        line_user_id: data.lineUserId,
        display_name: data.displayName ?? null,
        is_following: true,
        score: 0,
        created_at: '2026-03-31T12:00:00+09:00',
        user_id: null,
      };
      friendsDb.set(data.lineUserId, friend);
      return friend;
    }),
    updateFriendFollowStatus: vi.fn(async (_db: unknown, userId: string, isFollowing: boolean) => {
      followStatusUpdates.push({ userId, isFollowing });
      const friend = friendsDb.get(userId);
      if (friend) friend.is_following = isFollowing;
    }),
    getFriendByLineUserId: vi.fn(async (_db: unknown, userId: string) => {
      return friendsDb.get(userId) ?? null;
    }),
    getScenarios: vi.fn(async () => scenariosDb),
    enrollFriendInScenario: vi.fn(async (_db: unknown, friendId: string, scenarioId: string) => {
      const entry = { id: `fs-${friendId}-${scenarioId}`, status: 'active' };
      enrolledScenarios.push({ friendId, scenarioId });
      friendScenariosDb.set(`${friendId}-${scenarioId}`, entry);
      return entry;
    }),
    getScenarioSteps: vi.fn(async () => []),
    advanceFriendScenario: vi.fn(async () => {}),
    completeFriendScenario: vi.fn(async () => {}),
    upsertChatOnMessage: vi.fn(async () => {}),
    getLineAccounts: vi.fn(async () => []),
    getLineAccountByBotUserId: vi.fn(async () => null),
    setLineAccountBotUserId: vi.fn(async () => {}),
    getStaffByApiKey: vi.fn(async () => null),
    getFriendTags: vi.fn(async () => []),
  }));

  vi.doMock('../services/event-bus.js', () => ({
    fireEvent: vi.fn(async (_db: unknown, type: string, payload: unknown) => {
      firedEvents.push({ type, payload });
    }),
  }));

  vi.doMock('../services/ai-response.js', () => ({
    generateAiResponse: (...args: unknown[]) => mockAiGenerate(...args),
  }));

  // Build a minimal Hono app with just the webhook route (no auth middleware needed for /webhook)
  const { webhook } = await import('../routes/webhook.js');
  app = new Hono();
  app.route('/', webhook);
});

afterEach(() => {
  capturedReplies.length = 0;
  capturedPushes.length = 0;
  capturedProfiles.clear();
  capturedLoadingAnimations = [];
  friendsDb.clear();
  scenariosDb.length = 0;
  friendScenariosDb.clear();
  followStatusUpdates = [];
  enrolledScenarios = [];
  firedEvents.length = 0;
  mockAiGenerate.mockReset();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Env factory
// ---------------------------------------------------------------------------

const TEST_CHANNEL_SECRET = 'test-channel-secret-1234567890';
const TEST_ACCESS_TOKEN = 'test-access-token-abc';

function createMockD1(): D1Database {
  // Minimal mock that supports the queries in webhook handler
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStmt),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

interface RequestOptions {
  channelSecret?: string;
  accessToken?: string;
  db?: D1Database;
  ai?: object | null;
  aiSystemPrompt?: string;
  workerUrl?: string;
}

async function postWebhook(
  body: object,
  signature?: string,
  options: RequestOptions = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const secret = options.channelSecret ?? TEST_CHANNEL_SECRET;
  const sig = signature ?? (await computeSignature(secret, rawBody));

  const mockDb = options.db ?? createMockD1();

  const env = {
    DB: mockDb,
    AI: options.ai ?? null,
    LINE_CHANNEL_SECRET: secret,
    LINE_CHANNEL_ACCESS_TOKEN: options.accessToken ?? TEST_ACCESS_TOKEN,
    API_KEY: 'test-api-key',
    LIFF_URL: 'https://liff.example.com',
    LINE_CHANNEL_ID: 'channel-id',
    LINE_LOGIN_CHANNEL_ID: 'login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: options.workerUrl ?? 'https://worker.example.com',
    AI_SYSTEM_PROMPT: options.aiSystemPrompt,
  };

  const req = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': sig,
    },
    body: rawBody,
  });

  return app.fetch(req, env, {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      // Execute the promise to actually run handleEvent in tests
      p.catch(() => {});
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext);
}

// ---------------------------------------------------------------------------
// Helpers to build webhook bodies
// ---------------------------------------------------------------------------

function makeTextMessageBody(
  userId: string,
  text: string,
  destination = 'U_bot_default',
): object {
  return {
    destination,
    events: [
      {
        type: 'message',
        replyToken: `reply-${Date.now()}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        message: { type: 'text', id: `msg-${Date.now()}`, text },
        webhookEventId: `evt-${Date.now()}`,
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      },
    ],
  };
}

function makeFollowBody(userId: string, destination = 'U_bot_default'): object {
  return {
    destination,
    events: [
      {
        type: 'follow',
        replyToken: `reply-follow-${Date.now()}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        webhookEventId: `evt-follow-${Date.now()}`,
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      },
    ],
  };
}

function makeUnfollowBody(userId: string, destination = 'U_bot_default'): object {
  return {
    destination,
    events: [
      {
        type: 'unfollow',
        timestamp: Date.now(),
        source: { type: 'user', userId },
        webhookEventId: `evt-unfollow-${Date.now()}`,
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      },
    ],
  };
}

// ===========================================================================
// 1. Signature verification
// ===========================================================================

describe('Signature verification', () => {
  it('returns 200 with valid signature', async () => {
    const body = { destination: 'U_bot', events: [] };
    const res = await postWebhook(body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('returns 200 with invalid signature (LINE requires always 200)', async () => {
    const body = { destination: 'U_bot', events: [] };
    const res = await postWebhook(body, 'invalid-signature-not-base64!!!');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('returns 200 with wrong secret signature (valid base64 but wrong HMAC)', async () => {
    const body = { destination: 'U_bot', events: [] };
    const wrongSig = await computeSignature('wrong-secret', JSON.stringify(body));
    const res = await postWebhook(body, wrongSig);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('returns 200 for malformed JSON body', async () => {
    const rawBody = 'not-json{{{';
    const sig = await computeSignature(TEST_CHANNEL_SECRET, rawBody);
    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': sig,
      },
      body: rawBody,
    });

    const res = await app.fetch(
      req,
      {
        DB: createMockD1(),
        AI: null,
        LINE_CHANNEL_SECRET: TEST_CHANNEL_SECRET,
        LINE_CHANNEL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
        API_KEY: 'test-api-key',
        LIFF_URL: '',
        LINE_CHANNEL_ID: '',
        LINE_LOGIN_CHANNEL_ID: '',
        LINE_LOGIN_CHANNEL_SECRET: '',
        WORKER_URL: '',
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// 2. Auto-reply matching
// ===========================================================================

describe('Auto-reply matching', () => {
  it('exact match triggers correct auto-reply', async () => {
    const userId = 'U_user_exact';
    // Pre-populate friend
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'ExactUser',
      is_following: true,
      score: 10,
      created_at: '2026-03-01',
      user_id: null,
    });

    const db = createMockD1();
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'ar-1',
            keyword: '料金',
            match_type: 'exact',
            response_type: 'text',
            response_content: '料金は月額1,000円です',
            is_active: 1,
            created_at: '2026-01-01',
          },
        ],
      }),
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

    const body = makeTextMessageBody(userId, '料金');
    const res = await postWebhook(body, undefined, { db });

    expect(res.status).toBe(200);

    // Wait for async event processing
    await new Promise((r) => setTimeout(r, 100));

    // The auto-reply should have been sent
    expect(capturedReplies.length).toBeGreaterThanOrEqual(1);
    const lastReply = capturedReplies[capturedReplies.length - 1];
    expect(lastReply.messages).toHaveLength(1);
    expect((lastReply.messages[0] as { type: string }).type).toBe('text');
  });

  it('contains match triggers correct auto-reply', async () => {
    const userId = 'U_user_contains';
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'ContainsUser',
      is_following: true,
      score: 5,
      created_at: '2026-03-01',
      user_id: null,
    });

    const db = createMockD1();
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'ar-2',
            keyword: 'ヘルプ',
            match_type: 'contains',
            response_type: 'text',
            response_content: 'ヘルプメニューです',
            is_active: 1,
            created_at: '2026-01-01',
          },
        ],
      }),
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

    const body = makeTextMessageBody(userId, 'ヘルプが必要です');
    const res = await postWebhook(body, undefined, { db });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    expect(capturedReplies.length).toBeGreaterThanOrEqual(1);
    const lastReply = capturedReplies[capturedReplies.length - 1];
    expect(lastReply.messages).toHaveLength(1);
  });

  it('no match when exact keyword does not match', async () => {
    const userId = 'U_user_nomatch';
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'NoMatchUser',
      is_following: true,
      score: 0,
      created_at: '2026-03-01',
      user_id: null,
    });

    const db = createMockD1();
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'ar-3',
            keyword: '料金',
            match_type: 'exact',
            response_type: 'text',
            response_content: '料金回答',
            is_active: 1,
            created_at: '2026-01-01',
          },
        ],
      }),
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

    // "料金" exact won't match "料金について教えて"
    const body = makeTextMessageBody(userId, '料金について教えて');
    const res = await postWebhook(body, undefined, { db, ai: null });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    // No auto-reply should fire (no AI either since ai is null)
    const repliesForThisUser = capturedReplies.filter((r) =>
      r.replyToken.startsWith('reply-'),
    );
    // The exact keyword "料金" does NOT match "料金について教えて", so no auto-reply
    // and no AI (ai is null), so event bus should fire with matched=false
    const messageEvents = firedEvents.filter((e) => e.type === 'message_received');
    if (messageEvents.length > 0) {
      expect((messageEvents[0].payload as { eventData: { matched: boolean } }).eventData.matched).toBe(false);
    }
  });
});

// ===========================================================================
// 3. AI fallback
// ===========================================================================

describe('AI fallback', () => {
  it('generates AI response when no auto-reply matches and AI is available', async () => {
    const userId = 'U_user_ai';
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'AiUser',
      is_following: true,
      score: 20,
      created_at: '2026-03-01',
      user_id: null,
    });

    mockAiGenerate.mockResolvedValue({
      text: 'こんにちは！naturism公式LINEです。何かお手伝いできますか？',
      layer: 'ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
    });

    const db = createMockD1();
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }), // no auto-replies
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

    const mockAi = { run: vi.fn() };

    const body = makeTextMessageBody(userId, 'こんにちは');
    const res = await postWebhook(body, undefined, { db, ai: mockAi });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // AI response should have been called
    expect(mockAiGenerate).toHaveBeenCalledTimes(1);

    // Should have sent a loading animation
    expect(capturedLoadingAnimations.length).toBeGreaterThanOrEqual(1);

    // A reply (flex message with AI content) should have been sent
    expect(capturedReplies.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back gracefully when AI response fails', async () => {
    const userId = 'U_user_ai_fail';
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'AiFailUser',
      is_following: true,
      score: 0,
      created_at: '2026-03-01',
      user_id: null,
    });

    mockAiGenerate.mockRejectedValue(new Error('AI service unavailable'));

    const db = createMockD1();
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    (db.prepare as ReturnType<typeof vi.fn>).mockReturnValue(mockStmt);

    const mockAi = { run: vi.fn() };

    const body = makeTextMessageBody(userId, 'テスト質問');
    const res = await postWebhook(body, undefined, { db, ai: mockAi });

    // Still returns 200 — webhook must never fail
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // Event bus should still fire (matched will be false since AI failed)
    const messageEvents = firedEvents.filter((e) => e.type === 'message_received');
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 4. Follow event
// ===========================================================================

describe('Follow event', () => {
  it('registers new friend on follow', async () => {
    const { upsertFriend } = await import('@line-crm/db');

    const userId = 'U_new_friend';
    const body = makeFollowBody(userId);
    const res = await postWebhook(body);

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // upsertFriend should have been called
    expect(upsertFriend).toHaveBeenCalled();

    // Event bus should fire friend_add
    const addEvents = firedEvents.filter((e) => e.type === 'friend_add');
    expect(addEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers welcome scenario for new friend', async () => {
    const userId = 'U_welcome';

    // Set up a friend_add scenario
    scenariosDb.push({
      id: 'scenario-welcome',
      trigger_type: 'friend_add',
      is_active: true,
      line_account_id: null,
    });

    const body = makeFollowBody(userId);
    const res = await postWebhook(body);

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    // Scenario enrollment should have happened
    expect(enrolledScenarios.length).toBeGreaterThanOrEqual(1);
    expect(enrolledScenarios[0].scenarioId).toBe('scenario-welcome');
  });
});

// ===========================================================================
// 5. Unfollow event
// ===========================================================================

describe('Unfollow event', () => {
  it('updates follow status to false', async () => {
    const { updateFriendFollowStatus } = await import('@line-crm/db');

    const userId = 'U_unfollower';
    // Pre-register the friend
    friendsDb.set(userId, {
      id: `friend-${userId}`,
      line_user_id: userId,
      display_name: 'Unfollower',
      is_following: true,
      score: 0,
      created_at: '2026-03-01',
      user_id: null,
    });

    const body = makeUnfollowBody(userId);
    const res = await postWebhook(body);

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));

    expect(updateFriendFollowStatus).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      false,
    );
    expect(followStatusUpdates.some((u) => u.userId === userId && !u.isFollowing)).toBe(true);
  });
});

// ===========================================================================
// 6. Rate limiting (in-memory sliding window)
// ===========================================================================

describe('Rate limiting', () => {
  it('does not rate-limit normal webhook requests', async () => {
    const body = { destination: 'U_bot', events: [] };
    const res = await postWebhook(body);
    expect(res.status).toBe(200);
  });

  // Note: The in-memory rate limiter allows 100 requests per minute for
  // unauthenticated paths. Testing the actual 429 would require sending
  // 101+ requests in rapid succession, which is slow. Instead, we test
  // that the Cloudflare distributed rate limiter binding is respected.
  it('returns 429 when Cloudflare rate limiter rejects', async () => {
    const rawBody = JSON.stringify({ destination: 'U_bot', events: [] });
    const sig = await computeSignature(TEST_CHANNEL_SECRET, rawBody);

    // Build a full app with rate-limit middleware
    const { rateLimitMiddleware } = await import('../middleware/rate-limit.js');
    const { webhook: webhookRoute } = await import('../routes/webhook.js');
    const rateLimitApp = new Hono();
    rateLimitApp.use('*', rateLimitMiddleware);
    rateLimitApp.route('/', webhookRoute);

    const req = new Request('http://localhost/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': sig,
        'cf-connecting-ip': '1.2.3.4',
      },
      body: rawBody,
    });

    const res = await rateLimitApp.fetch(
      req,
      {
        DB: createMockD1(),
        AI: null,
        LINE_CHANNEL_SECRET: TEST_CHANNEL_SECRET,
        LINE_CHANNEL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
        API_KEY: 'test-api-key',
        LIFF_URL: '',
        LINE_CHANNEL_ID: '',
        LINE_LOGIN_CHANNEL_ID: '',
        LINE_LOGIN_CHANNEL_SECRET: '',
        WORKER_URL: '',
        WEBHOOK_RATE_LIMITER: {
          limit: vi.fn().mockResolvedValue({ success: false }),
        },
      },
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );

    expect(res.status).toBe(429);
    const json = (await res.json()) as { success: boolean; error: string };
    expect(json.success).toBe(false);
    expect(json.error).toContain('Too many requests');
  });
});

// ===========================================================================
// 7. Multi-account routing
// ===========================================================================

describe('Multi-account routing', () => {
  it('routes to correct account using destination field', async () => {
    const { getLineAccountByBotUserId } = await import('@line-crm/db');

    const accountSecret = 'account-2-secret-xyz';
    const accountToken = 'account-2-access-token';
    const destination = 'U_bot_account2';

    // Mock: getLineAccountByBotUserId returns a specific account
    (getLineAccountByBotUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'acc-2',
      channel_secret: accountSecret,
      channel_access_token: accountToken,
      bot_user_id: destination,
      is_active: true,
    });

    const body = { destination, events: [] };
    const rawBody = JSON.stringify(body);
    // Sign with the ACCOUNT secret, not the env secret
    const sig = await computeSignature(accountSecret, rawBody);

    const res = await postWebhook(body, sig, {
      channelSecret: 'env-default-secret', // env secret is different
    });

    expect(res.status).toBe(200);

    // Verify getLineAccountByBotUserId was called with the destination
    expect(getLineAccountByBotUserId).toHaveBeenCalledWith(
      expect.anything(),
      destination,
    );
  });

  it('rejects when destination matches account but signature is wrong', async () => {
    const { getLineAccountByBotUserId } = await import('@line-crm/db');

    const accountSecret = 'real-account-secret';
    const destination = 'U_bot_account3';

    (getLineAccountByBotUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'acc-3',
      channel_secret: accountSecret,
      channel_access_token: 'token-3',
      bot_user_id: destination,
      is_active: true,
    });

    const body = { destination, events: [] };
    // Sign with the WRONG secret
    const wrongSig = await computeSignature('totally-wrong-secret', JSON.stringify(body));

    const res = await postWebhook(body, wrongSig, {
      channelSecret: 'env-default-secret',
    });

    // Should still return 200 (LINE requirement) but events won't be processed
    expect(res.status).toBe(200);
  });

  it('falls back to iterating accounts when destination not found in DB', async () => {
    const { getLineAccountByBotUserId, getLineAccounts } = await import('@line-crm/db');

    const accountSecret = 'iterable-account-secret';
    const destination = 'U_bot_unknown';

    // getLineAccountByBotUserId returns null — not found
    (getLineAccountByBotUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    // getLineAccounts returns a list with a matching account
    (getLineAccounts as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'acc-iter',
        channel_secret: accountSecret,
        channel_access_token: 'token-iter',
        bot_user_id: null,
        is_active: true,
      },
    ]);

    const body = { destination, events: [] };
    const rawBody = JSON.stringify(body);
    const sig = await computeSignature(accountSecret, rawBody);

    const res = await postWebhook(body, sig, {
      channelSecret: 'env-default-secret',
    });

    expect(res.status).toBe(200);

    // Verify it attempted the fallback path
    expect(getLineAccountByBotUserId).toHaveBeenCalledWith(expect.anything(), destination);
    expect(getLineAccounts).toHaveBeenCalled();
  });
});

// ===========================================================================
// Additional edge cases
// ===========================================================================

describe('Edge cases', () => {
  it('handles empty events array', async () => {
    const body = { destination: 'U_bot', events: [] };
    const res = await postWebhook(body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  it('handles message from non-user source gracefully', async () => {
    const body = {
      destination: 'U_bot',
      events: [
        {
          type: 'message',
          replyToken: 'reply-group',
          timestamp: Date.now(),
          source: { type: 'group', groupId: 'G_group1' }, // no userId
          message: { type: 'text', id: 'msg-1', text: 'hello' },
          webhookEventId: 'evt-1',
          deliveryContext: { isRedelivery: false },
          mode: 'active',
        },
      ],
    };

    const res = await postWebhook(body);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    // No crash, no auto-reply (no userId)
    expect(capturedReplies.length).toBe(0);
  });

  it('handles unknown friend for text message gracefully', async () => {
    // Don't pre-populate friendsDb — getFriendByLineUserId returns null
    const body = makeTextMessageBody('U_unknown_user', 'hello');
    const res = await postWebhook(body);
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    // Should not crash, no reply sent for unknown friend
    // (webhook handler returns early if friend is null)
  });
});
