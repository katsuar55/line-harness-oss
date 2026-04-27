/**
 * Tests for webhook image message handling (Phase 3 PR-3).
 *
 * Covers:
 *   1. Pending food_log row inserted on image arrival
 *   2. ANTHROPIC_API_KEY 未設定時 → markFoodLogFailed
 *   3. analyzer 成功 → updateFoodLogAnalysis 呼び出し + push
 *   4. analyzer 失敗 → markFoodLogFailed
 *   5. reply (即応) 1 回 + push (結果) 1 回
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Helpers
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
  let binary = '';
  for (const byte of sig) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Captured I/O
// ---------------------------------------------------------------------------

const capturedReplies: Array<{ replyToken: string; messages: unknown[] }> = [];
const capturedPushes: Array<{ to: string; messages: unknown[] }> = [];

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

const insertFoodLogMock = vi.fn();
const updateFoodLogAnalysisMock = vi.fn();
const markFoodLogFailedMock = vi.fn();
const setFoodLogImageUrlMock = vi.fn();

const downloadLineContentMock = vi.fn();
const analyzeFoodImageMock = vi.fn();

// LineContentError / FoodAnalyzerError need the real classes so `instanceof` checks work
class FakeLineContentError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = 'LineContentError';
  }
}
class FakeFoodAnalyzerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'FoodAnalyzerError';
  }
}

// ---------------------------------------------------------------------------
// Mocks (top-level)
// ---------------------------------------------------------------------------

vi.mock('@line-crm/line-sdk', async (importOriginal) => {
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
      async getProfile() {
        return { displayName: 'Test', userId: 'U_x' };
      }
      async showLoadingAnimation(): Promise<void> {}
    },
  };
});

vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-04-27T12:00:00+09:00',
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(async (_db: unknown, userId: string) => {
    return friendsDb.get(userId) ?? null;
  }),
  getScenarios: vi.fn(async () => []),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(async () => []),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn(async () => []),
  getLineAccountByBotUserId: vi.fn(async () => null),
  setLineAccountBotUserId: vi.fn(),
  setFriendMetadataField: vi.fn(),
  insertFoodLog: (...args: unknown[]) => insertFoodLogMock(...args),
  setFoodLogImageUrl: (...args: unknown[]) => setFoodLogImageUrlMock(...args),
  updateFoodLogAnalysis: (...args: unknown[]) => updateFoodLogAnalysisMock(...args),
  markFoodLogFailed: (...args: unknown[]) => markFoodLogFailedMock(...args),
}));

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn(async () => {}),
}));

vi.mock('../services/food-analyzer.js', () => ({
  analyzeFoodImage: (...args: unknown[]) => analyzeFoodImageMock(...args),
  FoodAnalyzerError: FakeFoodAnalyzerError,
}));

vi.mock('../services/line-content.js', () => ({
  downloadLineContent: (...args: unknown[]) => downloadLineContentMock(...args),
  LineContentError: FakeLineContentError,
}));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let app: Hono;

beforeEach(async () => {
  capturedReplies.length = 0;
  capturedPushes.length = 0;
  friendsDb.clear();
  insertFoodLogMock.mockReset();
  updateFoodLogAnalysisMock.mockReset();
  markFoodLogFailedMock.mockReset();
  setFoodLogImageUrlMock.mockReset();
  downloadLineContentMock.mockReset();
  analyzeFoodImageMock.mockReset();

  // Default success behaviors
  insertFoodLogMock.mockResolvedValue({});
  setFoodLogImageUrlMock.mockResolvedValue(undefined);
  updateFoodLogAnalysisMock.mockResolvedValue(undefined);
  markFoodLogFailedMock.mockResolvedValue(undefined);

  const { webhook } = await import('../routes/webhook.js');
  app = new Hono();
  app.route('/', webhook);
});

afterEach(() => {
  vi.clearAllMocks();
});

const TEST_SECRET = 'test-channel-secret';
const TEST_TOKEN = 'test-access-token';

function createMockD1(): D1Database {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true }),
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function makeImageMessageBody(userId: string, messageId: string): object {
  return {
    destination: 'U_bot_default',
    events: [
      {
        type: 'message',
        replyToken: `reply-${messageId}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        message: {
          type: 'image',
          id: messageId,
          contentProvider: { type: 'line' },
        },
        webhookEventId: `evt-${messageId}`,
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      },
    ],
  };
}

interface PostOpts {
  anthropicKey?: string | undefined;
  db?: D1Database;
}

async function postImageWebhook(body: object, opts: PostOpts = {}): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const sig = await computeSignature(TEST_SECRET, rawBody);
  const env = {
    DB: opts.db ?? createMockD1(),
    AI: null,
    LINE_CHANNEL_SECRET: TEST_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN,
    API_KEY: 'test-api',
    LIFF_URL: '',
    LINE_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_ID: '',
    LINE_LOGIN_CHANNEL_SECRET: '',
    WORKER_URL: 'https://worker.example.com',
    ANTHROPIC_API_KEY: opts.anthropicKey,
    IMAGES: undefined, // skip R2 path in tests
  };
  const req = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig },
    body: rawBody,
  });
  const pending: Array<Promise<unknown>> = [];
  const res = await app.fetch(req, env, {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p.catch(() => {}));
    },
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext);
  // Drain background work so assertions can observe its effects
  await Promise.all(pending);
  return res;
}

function seedFriend(userId: string): MockFriend {
  const f: MockFriend = {
    id: `friend-${userId}`,
    line_user_id: userId,
    display_name: 'TestUser',
    is_following: true,
    score: 0,
    created_at: '2026-04-01',
    user_id: null,
  };
  friendsDb.set(userId, f);
  return f;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook image message — pending food_log row', () => {
  it('inserts a pending food_log when image arrives', async () => {
    const userId = 'U_food_pending';
    seedFriend(userId);

    // analyzer returns success so flow completes cleanly
    downloadLineContentMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
      size: 3,
    });
    analyzeFoodImageMock.mockResolvedValue({
      calories: 600, protein_g: 20, fat_g: 25, carbs_g: 80,
      items: [{ name: 'カレー', qty: '1皿' }],
    });

    const res = await postImageWebhook(makeImageMessageBody(userId, 'msg_1'), {
      anthropicKey: 'sk-test',
    });
    expect(res.status).toBe(200);

    expect(insertFoodLogMock).toHaveBeenCalledTimes(1);
    const [, input, foodLogId] = insertFoodLogMock.mock.calls[0];
    expect(input).toMatchObject({ friendId: `friend-${userId}` });
    expect(typeof foodLogId).toBe('string');
    expect(foodLogId.length).toBeGreaterThan(0);
  });

  it('skips entirely when friend is unknown', async () => {
    const res = await postImageWebhook(makeImageMessageBody('U_unknown', 'msg_x'), {
      anthropicKey: 'sk-test',
    });
    expect(res.status).toBe(200);
    expect(insertFoodLogMock).not.toHaveBeenCalled();
    expect(downloadLineContentMock).not.toHaveBeenCalled();
  });
});

describe('webhook image message — ANTHROPIC_API_KEY missing', () => {
  it('marks the food_log as failed with disabled message when key is absent', async () => {
    const userId = 'U_no_key';
    seedFriend(userId);

    const res = await postImageWebhook(makeImageMessageBody(userId, 'msg_no_key'), {
      anthropicKey: undefined,
    });
    expect(res.status).toBe(200);

    expect(insertFoodLogMock).toHaveBeenCalledTimes(1);
    expect(markFoodLogFailedMock).toHaveBeenCalledTimes(1);
    const [, , errMsg] = markFoodLogFailedMock.mock.calls[0];
    expect(errMsg).toMatch(/AI解析|無効/);

    // Should NOT have called analyzer or downloader
    expect(downloadLineContentMock).not.toHaveBeenCalled();
    expect(analyzeFoodImageMock).not.toHaveBeenCalled();
  });
});

describe('webhook image message — analyzer success', () => {
  it('calls updateFoodLogAnalysis with the analysis payload', async () => {
    const userId = 'U_ok';
    seedFriend(userId);

    downloadLineContentMock.mockResolvedValue({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
      size: 3,
    });
    const analysis = {
      calories: 650,
      protein_g: 22,
      fat_g: 28,
      carbs_g: 90,
      items: [{ name: 'ラーメン', qty: '1杯' }],
    };
    analyzeFoodImageMock.mockResolvedValue(analysis);

    const res = await postImageWebhook(makeImageMessageBody(userId, 'msg_ok'), {
      anthropicKey: 'sk-test',
    });
    expect(res.status).toBe(200);

    expect(analyzeFoodImageMock).toHaveBeenCalledTimes(1);
    expect(updateFoodLogAnalysisMock).toHaveBeenCalledTimes(1);
    const [, foodLogId, savedAnalysis] = updateFoodLogAnalysisMock.mock.calls[0];
    expect(typeof foodLogId).toBe('string');
    expect(savedAnalysis).toEqual(analysis);
    expect(savedAnalysis.calories).toBe(650);

    expect(markFoodLogFailedMock).not.toHaveBeenCalled();
  });
});

describe('webhook image message — analyzer failure', () => {
  it('calls markFoodLogFailed when analyzer throws timeout', async () => {
    const userId = 'U_timeout';
    seedFriend(userId);

    downloadLineContentMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      size: 3,
    });
    analyzeFoodImageMock.mockRejectedValue(new FakeFoodAnalyzerError('timed out', 'timeout'));

    const res = await postImageWebhook(makeImageMessageBody(userId, 'msg_timeout'), {
      anthropicKey: 'sk-test',
    });
    expect(res.status).toBe(200);

    expect(markFoodLogFailedMock).toHaveBeenCalledTimes(1);
    const [, , errMsg] = markFoodLogFailedMock.mock.calls[0];
    expect(errMsg).toMatch(/タイムアウト/);
    expect(updateFoodLogAnalysisMock).not.toHaveBeenCalled();
  });

  it('calls markFoodLogFailed when LINE Content size exceeded', async () => {
    const userId = 'U_too_big';
    seedFriend(userId);

    downloadLineContentMock.mockRejectedValue(
      new FakeLineContentError('too big', 'size_exceeded'),
    );

    const res = await postImageWebhook(makeImageMessageBody(userId, 'msg_big'), {
      anthropicKey: 'sk-test',
    });
    expect(res.status).toBe(200);

    expect(markFoodLogFailedMock).toHaveBeenCalledTimes(1);
    const [, , errMsg] = markFoodLogFailedMock.mock.calls[0];
    expect(errMsg).toMatch(/5MB|サイズ/);
    expect(analyzeFoodImageMock).not.toHaveBeenCalled();
  });
});

describe('webhook image message — reply + push counts', () => {
  it('sends exactly one reply (analyzing) and one push (result) on success', async () => {
    const userId = 'U_count';
    seedFriend(userId);

    downloadLineContentMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2]),
      contentType: 'image/jpeg',
      size: 2,
    });
    analyzeFoodImageMock.mockResolvedValue({
      calories: 500,
      protein_g: 18,
      fat_g: 20,
      carbs_g: 60,
      items: [{ name: '定食' }],
    });

    await postImageWebhook(makeImageMessageBody(userId, 'msg_count'), {
      anthropicKey: 'sk-test',
    });

    expect(capturedReplies).toHaveLength(1);
    expect(capturedPushes).toHaveLength(1);
    expect(capturedPushes[0].to).toBe(userId);

    // Push should be a flex message with the calorie info
    const pushMessage = capturedPushes[0].messages[0] as { type: string; contents?: unknown };
    expect(pushMessage.type).toBe('flex');
    // buildMessage('flex', ...) JSON.parses the string into an object
    expect(JSON.stringify(pushMessage.contents)).toContain('500');
  });

  it('sends one reply + one error push when analyzer fails', async () => {
    const userId = 'U_count_fail';
    seedFriend(userId);

    downloadLineContentMock.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'image/jpeg',
      size: 1,
    });
    analyzeFoodImageMock.mockRejectedValue(new FakeFoodAnalyzerError('bad', 'invalid_response'));

    await postImageWebhook(makeImageMessageBody(userId, 'msg_count_fail'), {
      anthropicKey: 'sk-test',
    });

    expect(capturedReplies).toHaveLength(1);
    expect(capturedPushes).toHaveLength(1);
    const pushed = capturedPushes[0].messages[0] as { type: string; text?: string };
    expect(pushed.type).toBe('text');
    expect(pushed.text).toMatch(/解析できません|もう一度/);
  });
});
