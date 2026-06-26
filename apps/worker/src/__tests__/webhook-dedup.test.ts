/**
 * Integration tests for the LINE webhook event-dedup guard (= 二重 fireEvent 防止, 2026-06-26)
 *
 * handleEvent 入口の冪等 guard を検証:
 *   (A) 重複 webhookEventId (recordWebhookDelivery=false) → downstream (fireEvent/enroll) skip
 *   (B) 新規 webhookEventId (recordWebhookDelivery=true)  → downstream 実行
 *   (C) fail-open: webhookEventId 欠落 → guard を呼ばず処理続行 / insert throw → 握って処理続行
 *
 * 実 recordWebhookDelivery / pruneWebhookDeliveries の SQL は webhook-deliveries-db.test.ts でカバー。
 * 本ファイルは @line-crm/db を mock し、 dedup の戻り値で分岐挙動だけを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// 署名計算 (LINE と同 HMAC-SHA256)
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
// 捕捉用 state
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
let enrolledScenarios: Array<{ friendId: string; scenarioId: string }> = [];
const firedEvents: Array<{ type: string; payload: unknown }> = [];

// dedup 制御 (= recordWebhookDelivery の戻り値/挙動を test ごとに差し替え)
const recordCalls: string[] = [];
const dedupControl: { impl: (webhookEventId: string) => Promise<boolean> } = {
  impl: async () => true, // default: 新規 event → 処理続行
};

// ---------------------------------------------------------------------------
// LineClient mock
// ---------------------------------------------------------------------------
const capturedReplies: Array<{ replyToken: string; messages: unknown[] }> = [];
function lineSdkFactory(actual: typeof import('@line-crm/line-sdk')) {
  return {
    ...actual,
    verifySignature: actual.verifySignature,
    LineClient: class MockLineClient {
      constructor(public readonly token: string) {}
      async replyMessage(replyToken: string, messages: unknown[]): Promise<void> {
        capturedReplies.push({ replyToken, messages });
      }
      async pushMessage(): Promise<void> {}
      async getProfile(userId: string) {
        return { displayName: 'TestUser', userId, pictureUrl: 'https://e.example/p.jpg', statusMessage: 'hi' };
      }
      async showLoadingAnimation(): Promise<void> {}
    },
  };
}

// ---------------------------------------------------------------------------
// @line-crm/db mock surface (= follow / message 経路に必要な分 + recordWebhookDelivery)
// ---------------------------------------------------------------------------
function dbFactory() {
  return {
    jstNow: () => '2026-03-31T12:00:00+09:00',
    upsertFriend: vi.fn(async (_db: unknown, data: { lineUserId: string; displayName?: string | null }) => {
      const existing = friendsDb.get(data.lineUserId);
      if (existing) {
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
    updateFriendFollowStatus: vi.fn(async () => {}),
    getFriendByLineUserId: vi.fn(async (_db: unknown, userId: string) => friendsDb.get(userId) ?? null),
    getScenarios: vi.fn(async () => scenariosDb),
    enrollFriendInScenario: vi.fn(async (_db: unknown, friendId: string, scenarioId: string) => {
      enrolledScenarios.push({ friendId, scenarioId });
      return { id: `fs-${friendId}-${scenarioId}`, status: 'active' };
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
    insertAuditLog: vi.fn(async () => {}),
    recordWebhookDelivery: vi.fn(async (_db: unknown, webhookEventId: string) => {
      recordCalls.push(webhookEventId);
      return dedupControl.impl(webhookEventId);
    }),
  };
}

function eventBusFactory() {
  return {
    fireEvent: vi.fn(async (_db: unknown, type: string, payload: unknown) => {
      firedEvents.push({ type, payload });
    }),
  };
}

vi.mock('@line-crm/line-sdk', async (importOriginal) => lineSdkFactory(await importOriginal()));
vi.mock('@line-crm/db', () => dbFactory());
vi.mock('../services/event-bus.js', () => eventBusFactory());

// ---------------------------------------------------------------------------
let app: Hono;

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('@line-crm/line-sdk', async (importOriginal) => lineSdkFactory(await importOriginal()));
  vi.doMock('@line-crm/db', () => dbFactory());
  vi.doMock('../services/event-bus.js', () => eventBusFactory());

  const { webhook } = await import('../routes/webhook.js');
  app = new Hono();
  app.route('/', webhook);
});

afterEach(() => {
  friendsDb.clear();
  scenariosDb.length = 0;
  enrolledScenarios = [];
  firedEvents.length = 0;
  recordCalls.length = 0;
  capturedReplies.length = 0;
  dedupControl.impl = async () => true;
  vi.restoreAllMocks();
});

const TEST_CHANNEL_SECRET = 'test-channel-secret-1234567890';
const TEST_ACCESS_TOKEN = 'test-access-token-abc';

async function postWebhook(body: object): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const sig = await computeSignature(TEST_CHANNEL_SECRET, rawBody);
  const env = {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    },
    AI: null,
    LINE_CHANNEL_SECRET: TEST_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
    API_KEY: 'test-api-key',
    LIFF_URL: 'https://liff.example.com',
    LINE_CHANNEL_ID: 'channel-id',
    LINE_LOGIN_CHANNEL_ID: 'login-channel-id',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
  };

  const req = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Line-Signature': sig },
    body: rawBody,
  });

  let bgPromise: Promise<unknown> = Promise.resolve();
  const res = await app.fetch(req, env, {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      bgPromise = p.catch(() => {});
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext);
  await bgPromise; // handleEvent 完了を待つ (= 決定論的)
  return res;
}

function makeTextMessageBody(
  userId: string,
  text: string,
  webhookEventId: string,
): Record<string, unknown> {
  return {
    destination: 'U_bot_default',
    events: [
      {
        type: 'message',
        replyToken: `reply-${userId}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        message: { type: 'text', id: `msg-${userId}`, text },
        webhookEventId,
        deliveryContext: { isRedelivery: false },
        mode: 'active',
      },
    ],
  };
}

function makeFollowBody(userId: string, webhookEventId: string | null): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: 'follow',
    replyToken: `reply-${userId}`,
    timestamp: Date.now(),
    source: { type: 'user', userId },
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
  if (webhookEventId !== null) event.webhookEventId = webhookEventId;
  return { destination: 'U_bot_default', events: [event] };
}

describe('webhook event dedup (webhookEventId guard)', () => {
  it('(A) 重複 webhookEventId → downstream (fireEvent / enroll) を skip', async () => {
    scenariosDb.push({ id: 'scen-1', trigger_type: 'friend_add', is_active: true, line_account_id: null });
    dedupControl.impl = async () => false; // = 既に記録済 (重複)

    const res = await postWebhook(makeFollowBody('U_dup', 'evt-dup-1'));
    expect(res.status).toBe(200);
    expect(recordCalls).toEqual(['evt-dup-1']); // guard は呼ばれた
    expect(firedEvents).toHaveLength(0); // friend_add は発火しない
    expect(enrolledScenarios).toHaveLength(0); // enroll もしない
  });

  it('(B) 新規 webhookEventId → downstream 実行 (friend_add 発火 + enroll)', async () => {
    scenariosDb.push({ id: 'scen-1', trigger_type: 'friend_add', is_active: true, line_account_id: null });
    dedupControl.impl = async () => true; // = 初見

    const res = await postWebhook(makeFollowBody('U_new', 'evt-new-1'));
    expect(res.status).toBe(200);
    expect(recordCalls).toEqual(['evt-new-1']);
    expect(firedEvents.some((e) => e.type === 'friend_add')).toBe(true);
    expect(enrolledScenarios.length).toBeGreaterThan(0);
  });

  it('(C-1) fail-open: webhookEventId 欠落 → guard を呼ばず処理続行', async () => {
    scenariosDb.push({ id: 'scen-1', trigger_type: 'friend_add', is_active: true, line_account_id: null });

    const res = await postWebhook(makeFollowBody('U_noid', null));
    expect(res.status).toBe(200);
    expect(recordCalls).toHaveLength(0); // webhookEventId なし → recordWebhookDelivery 未呼出
    expect(firedEvents.some((e) => e.type === 'friend_add')).toBe(true); // 処理は続行
  });

  it('(C-2) fail-open: recordWebhookDelivery が throw → 握って処理続行', async () => {
    scenariosDb.push({ id: 'scen-1', trigger_type: 'friend_add', is_active: true, line_account_id: null });
    dedupControl.impl = async () => {
      throw new Error('D1 down (table missing?)');
    };

    const res = await postWebhook(makeFollowBody('U_err', 'evt-err-1'));
    expect(res.status).toBe(200);
    expect(recordCalls).toEqual(['evt-err-1']); // 呼ばれて throw した
    expect(firedEvents.some((e) => e.type === 'friend_add')).toBe(true); // fail-open で続行
  });

  it('(D) 重複 message event → guard が event.type 分岐前に skip (fireEvent 呼ばれない)', async () => {
    // guard は handleEvent 入口 (event.type 分岐の前) にあるため follow 以外の全 event を等しくカバー。
    dedupControl.impl = async () => false; // = 既に記録済 (重複)

    const res = await postWebhook(makeTextMessageBody('U_msg', 'こんにちは', 'evt-msg-dup'));
    expect(res.status).toBe(200);
    expect(recordCalls).toEqual(['evt-msg-dup']);
    expect(firedEvents).toHaveLength(0); // message_received も発火しない
  });
});
