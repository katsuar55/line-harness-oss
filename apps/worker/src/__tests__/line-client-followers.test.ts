/**
 * Tests for the REAL LineClient.getFollowerIds (no SDK mock).
 *
 * Verifies the actual request path (URL construction, pagination cursor,
 * auth header, error surfacing) by mocking only global fetch — so the test
 * exercises the genuine SDK code rather than a stand-in mock.
 * (Guards against the "mock bypasses real code" trap in CLAUDE.md.)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LineClient } from '@line-crm/line-sdk';

const VALID_ID = 'U' + '0'.repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LineClient.getFollowerIds', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('builds /followers/ids with default limit and returns userIds + next', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) =>
      jsonResponse({ userIds: [VALID_ID], next: 'cursor123' }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await new LineClient('tok').getFollowerIds();

    expect(res.userIds).toEqual([VALID_ID]);
    expect(res.next).toBe('cursor123');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/v2/bot/followers/ids');
    expect(url).toContain('limit=1000');
    expect(url).not.toContain('start=');

    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(opts.method).toBe('GET');
  });

  it('passes the start cursor and custom limit for pagination', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts?: RequestInit) =>
      jsonResponse({ userIds: [] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await new LineClient('tok').getFollowerIds('CURSOR', 500);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('start=CURSOR');
    expect(url).toContain('limit=500');
    expect(res.next).toBeUndefined();
  });

  it('throws on HTTP 403 (unverified Official Account)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as unknown as typeof fetch;

    await expect(new LineClient('tok').getFollowerIds()).rejects.toThrow(/403/);
  });
});
