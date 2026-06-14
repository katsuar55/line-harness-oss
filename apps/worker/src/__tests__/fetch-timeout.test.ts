/**
 * 外部 fetch の timeout 付与 regression test (Launch-readiness review B-reliability)。
 *
 * 代表として ban-monitor.checkSingleAccount の LINE API fetch が
 * AbortSignal (timeout) 付きで呼ばれることを pin する。 timeout が外れると
 * cron 全体が外部 API ハングで無期限ブロックする。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getLineAccounts, createAccountHealthLog } = vi.hoisted(() => ({
  getLineAccounts: vi.fn(),
  createAccountHealthLog: vi.fn(async () => undefined),
}));

vi.mock('@line-crm/db', () => ({ getLineAccounts, createAccountHealthLog }));

import { checkAccountHealth } from '../services/ban-monitor.js';

function mockDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => ({ count: 0 }) }),
    }),
  } as unknown as D1Database;
}

describe('ban-monitor fetch timeout', () => {
  beforeEach(() => {
    getLineAccounts.mockReset();
    createAccountHealthLog.mockClear();
  });

  it('LINE API fetch は AbortSignal (timeout) 付きで呼ばれる', async () => {
    getLineAccounts.mockResolvedValue([
      { id: 'a1', is_active: 1, channel_access_token: 'tok-1' },
    ]);
    const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ userId: 'bot' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    await checkAccountHealth(mockDb());

    expect(calls.length).toBeGreaterThan(0);
    const botInfoCall = calls.find((c) => String(c.url).includes('/v2/bot/info'));
    expect(botInfoCall).toBeTruthy();
    expect(botInfoCall!.init?.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });
});
