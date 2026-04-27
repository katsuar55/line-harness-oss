/**
 * Tests for line-content downloader.
 *
 * 通信経路は fetchImpl 注入でモックして、HTTP 振る舞いの全分岐を検証する。
 */

import { describe, it, expect, vi } from 'vitest';
import { downloadLineContent, LineContentError } from '../services/line-content.js';

const TOKEN = 'test-line-token';

function jpegBlobResponse(bytes: Uint8Array, contentLength?: number): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      ...(contentLength !== undefined && { 'content-length': String(contentLength) }),
    },
  });
}

describe('downloadLineContent', () => {
  it('returns bytes + contentType + size on 200 OK', async () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetchImpl = vi.fn().mockResolvedValue(jpegBlobResponse(payload));

    const blob = await downloadLineContent('msg_123', TOKEN, { fetchImpl });

    expect(blob.bytes).toEqual(payload);
    expect(blob.contentType).toBe('image/jpeg');
    expect(blob.size).toBe(7);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/v2/bot/message/msg_123/content');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('throws size_exceeded when Content-Length header exceeds limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jpegBlobResponse(new Uint8Array(0), 10_000_000),
    );
    await expect(
      downloadLineContent('msg', TOKEN, { fetchImpl, sizeLimitBytes: 5 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'size_exceeded' });
  });

  it('throws size_exceeded when actual body exceeds limit (no content-length)', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const fetchImpl = vi.fn().mockResolvedValue(jpegBlobResponse(big));
    await expect(
      downloadLineContent('msg', TOKEN, { fetchImpl, sizeLimitBytes: 5 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'size_exceeded' });
  });

  it('throws empty for 0-byte body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jpegBlobResponse(new Uint8Array(0)));
    await expect(downloadLineContent('msg', TOKEN, { fetchImpl })).rejects.toMatchObject({
      code: 'empty',
    });
  });

  it('throws http_error on non-2xx status with status code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('not found', { status: 404 }));
    try {
      await downloadLineContent('msg', TOKEN, { fetchImpl });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LineContentError);
      expect((e as LineContentError).code).toBe('http_error');
      expect((e as LineContentError).status).toBe(404);
    }
  });

  it('throws timeout when fetch is aborted', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Simulate abort by listening to the signal and rejecting.
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    await expect(
      downloadLineContent('msg', TOKEN, { fetchImpl, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects when channelAccessToken is missing', async () => {
    await expect(
      downloadLineContent('msg', '', { fetchImpl: vi.fn() }),
    ).rejects.toBeInstanceOf(LineContentError);
  });

  it('redacts unexpected error messages (no token leak)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error(`Network failure with secret token=${TOKEN}`),
    );
    try {
      await downloadLineContent('msg', TOKEN, { fetchImpl });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as LineContentError).message).not.toContain(TOKEN);
      expect((e as LineContentError).code).toBe('http_error');
    }
  });

  it('encodes messageId in URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jpegBlobResponse(new Uint8Array([1, 2, 3])),
    );
    await downloadLineContent('msg/with/slash', TOKEN, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('msg%2Fwith%2Fslash');
  });
});
