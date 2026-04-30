/**
 * Tests for ResendClient (Round 4 PR-1).
 */

import { describe, it, expect, vi } from 'vitest';
import { ResendClient } from '../src/resend-client.js';
import type { EmailMessage } from '../src/types.js';

const SAMPLE_MESSAGE: EmailMessage = {
  to: 'user@example.com',
  from: 'noreply@mail.naturism.example',
  subject: 'テスト件名',
  html: '<p>Hello</p>',
  text: 'Hello',
  category: 'transactional',
  sourceKind: 'transactional',
};

describe('ResendClient', () => {
  it('apiKey が空なら throw', () => {
    expect(() => new ResendClient({ apiKey: '' })).toThrow('apiKey is required');
  });

  it('正常レスポンス時、providerMessageId / provider / sentAt を返す', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.resend.com/emails');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init?.body as string);
      expect(body.from).toBe('noreply@mail.naturism.example');
      expect(body.to).toEqual(['user@example.com']);
      expect(body.subject).toBe('テスト件名');
      return new Response(JSON.stringify({ id: 'resend-msg-abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new ResendClient({ apiKey: 'test-key', fetchImpl });
    const result = await client.send(SAMPLE_MESSAGE);

    expect(result.providerMessageId).toBe('resend-msg-abc');
    expect(result.provider).toBe('resend');
    expect(result.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('replyTo / headers / tags が正しくペイロードに乗る', async () => {
    let captured: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url, init?: RequestInit) => {
      captured = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: 'r-1' }), { status: 200 });
    });
    const client = new ResendClient({ apiKey: 'k', fetchImpl });
    await client.send({
      ...SAMPLE_MESSAGE,
      replyTo: 'support@naturism.example',
      headers: { 'List-Unsubscribe': '<https://example.com/u>' },
      tags: [{ name: 'campaign', value: 'spring' }],
    });
    expect(captured.reply_to).toBe('support@naturism.example');
    expect(captured.headers).toEqual({ 'List-Unsubscribe': '<https://example.com/u>' });
    expect(captured.tags).toEqual([{ name: 'campaign', value: 'spring' }]);
  });

  it('HTTP 4xx/5xx 時は send 失敗を throw', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":"invalid"}', { status: 422 }),
    );
    const client = new ResendClient({ apiKey: 'k', fetchImpl });
    await expect(client.send(SAMPLE_MESSAGE)).rejects.toThrow('Resend send failed: HTTP 422');
  });

  it('レスポンスに id がない場合 throw', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const client = new ResendClient({ apiKey: 'k', fetchImpl });
    await expect(client.send(SAMPLE_MESSAGE)).rejects.toThrow('response missing id');
  });
});
