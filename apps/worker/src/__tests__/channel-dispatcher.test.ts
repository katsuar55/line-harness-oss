/**
 * Tests for ChannelDispatcher (Round 4 PR-3)
 */

import { describe, it, expect, vi } from 'vitest';
import { dispatch, consentGate } from '../services/channel-dispatcher.js';
import type {
  ChannelDispatcherDeps,
  DispatchInput,
} from '../services/channel-dispatcher.js';
import type { LineClient } from '@line-crm/line-sdk';
import type {
  EmailProvider,
  EmailRenderer,
  EmailMessage,
  EmailResult as ProviderResult,
  RenderInput,
  RenderedEmail,
} from '@line-crm/email-sdk';
import type { EmailSubscriber } from '@line-crm/db';

// ============================================================
// Fakes
// ============================================================

interface FakeDbOpts {
  /** SELECT first 結果を順に返す */
  firstResults?: unknown[];
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const captured: { sql: string; params: unknown[] }[] = [];
  let firstIdx = 0;
  const db: unknown = {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      captured.push(call);
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async first<T>() {
              const result = opts.firstResults?.[firstIdx++] ?? null;
              return (result as T) ?? null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as D1Database, captured };
}

function makeFakeLineClient(opts: { fail?: boolean } = {}): LineClient {
  return {
    pushMessage: vi.fn(async () => {
      if (opts.fail) throw new Error('LINE API down');
    }),
  } as unknown as LineClient;
}

function makeFakeEmailProvider(opts: { fail?: boolean } = {}): EmailProvider {
  return {
    send: vi.fn(
      async (msg: EmailMessage): Promise<ProviderResult> => {
        if (opts.fail) throw new Error('Resend 5xx');
        return {
          provider: 'resend',
          providerMessageId: `pm-${msg.to}-${Date.now()}`,
          sentAt: '2026-04-30T10:00:00.000+09:00',
        };
      },
    ),
  };
}

function makeFakeRenderer(): EmailRenderer {
  return {
    render: vi.fn(
      async (input: RenderInput): Promise<RenderedEmail> => ({
        subject: `RENDERED:${input.subjectTemplate}`,
        html: `<html>${input.htmlTemplate}</html>`,
        text: input.textTemplate,
        unsubscribeUrl: `https://example/unsub?id=${input.subscriberId}&token=fake`,
      }),
    ),
  } as unknown as EmailRenderer;
}

function makeSubscriber(over: Partial<EmailSubscriber> = {}): EmailSubscriber {
  return {
    id: 'sub-1',
    friend_id: null,
    email: 'tester@example.com',
    is_active: 1,
    transactional_only: 0,
    unsubscribed_at: null,
    bounce_count: 0,
    complaint_count: 0,
    consent_source: 'shopify_checkout',
    consent_at: '2026-01-01T00:00:00.000+09:00',
    created_at: '2026-01-01T00:00:00.000+09:00',
    updated_at: '2026-01-01T00:00:00.000+09:00',
    ...over,
  };
}

// ============================================================
// consentGate (純関数)
// ============================================================

describe('consentGate', () => {
  it('marketing: is_active=1 + unsubscribed_at=null は allowed', () => {
    expect(consentGate(makeSubscriber(), 'marketing').allowed).toBe(true);
  });

  it('marketing: unsubscribed_at がある場合は unsubscribed', () => {
    const r = consentGate(
      makeSubscriber({ unsubscribed_at: '2026-04-01T00:00:00+09:00' }),
      'marketing',
    );
    if (r.allowed) throw new Error('expected disallowed');
    expect(r.reason).toBe('unsubscribed');
  });

  it('marketing: is_active=0 は inactive_marketing', () => {
    const r = consentGate(makeSubscriber({ is_active: 0 }), 'marketing');
    if (r.allowed) throw new Error('expected disallowed');
    expect(r.reason).toBe('inactive_marketing');
  });

  it('transactional: is_active=1 のみで allowed', () => {
    expect(
      consentGate(makeSubscriber({ transactional_only: 0 }), 'transactional').allowed,
    ).toBe(true);
  });

  it('transactional: transactional_only=1 のみで allowed (is_active=0 でも)', () => {
    expect(
      consentGate(
        makeSubscriber({ is_active: 0, transactional_only: 1 }),
        'transactional',
      ).allowed,
    ).toBe(true);
  });

  it('transactional: 完全 opt-out (is_active=0 AND transactional_only=0) は inactive_transactional', () => {
    const r = consentGate(
      makeSubscriber({ is_active: 0, transactional_only: 0 }),
      'transactional',
    );
    if (r.allowed) throw new Error('expected disallowed');
    expect(r.reason).toBe('inactive_transactional');
  });
});

// ============================================================
// dispatch — LINE only
// ============================================================

describe('dispatch (LINE)', () => {
  it('channel=line + following friend で sent を返す', async () => {
    const { db } = makeFakeDb({
      firstResults: [{ is_following: 1, is_blacklisted: 0 }],
    });
    const lineClient = makeFakeLineClient();
    const deps: ChannelDispatcherDeps = { db, lineClient };
    const input: DispatchInput = {
      recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
      channel: 'line',
      category: 'transactional',
      sourceKind: 'reorder',
      linePayload: { messages: [{ type: 'text', text: 'hi' }] },
    };

    const r = await dispatch(deps, input);

    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toEqual({ channel: 'line', status: 'sent' });
    // 第3引数 = retryKey (WI-2: X-Line-Retry-Key 冪等キー。未指定は undefined)
    expect(lineClient.pushMessage).toHaveBeenCalledWith(
      'U123',
      [{ type: 'text', text: 'hi' }],
      undefined,
    );
  });

  it('channel=line + is_following=0 で skipped:not_following', async () => {
    const { db } = makeFakeDb({
      firstResults: [{ is_following: 0, is_blacklisted: 0 }],
    });
    const lineClient = makeFakeLineClient();
    const r = await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
      },
    );
    expect(r.results[0]).toMatchObject({ channel: 'line', status: 'skipped', reason: 'not_following' });
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
  });

  it('channel=line + is_blacklisted で skipped:blacklisted (is_following 関係なく優先)', async () => {
    const { db } = makeFakeDb({
      firstResults: [{ is_following: 1, is_blacklisted: 1 }],
    });
    const r = await dispatch(
      { db, lineClient: makeFakeLineClient() },
      {
        recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
      },
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'blacklisted' });
  });

  it('channel=line + lineClient なし で skipped:no_client', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch(
      { db },
      {
        recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
      },
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_client' });
  });

  it('channel=line + linePayload なしで skipped:no_payload', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch(
      { db, lineClient: makeFakeLineClient() },
      {
        recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
      },
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_payload' });
  });

  it('channel=line + friend なしで skipped:no_friend', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch(
      { db, lineClient: makeFakeLineClient() },
      {
        recipient: {},
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
      },
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_friend' });
  });

  it('channel=line + LINE API 失敗で failed (例外を抑制)', async () => {
    const { db } = makeFakeDb({
      firstResults: [{ is_following: 1, is_blacklisted: 0 }],
    });
    const lineClient = makeFakeLineClient({ fail: true });
    const r = await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: 'f-1', lineUserId: 'U123' } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'reorder',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
      },
    );
    expect(r.results[0]).toMatchObject({ status: 'failed', error: 'LINE API down' });
  });
});

// ============================================================
// dispatch — Email only
// ============================================================

describe('dispatch (Email)', () => {
  function buildEmailDeps(opts: { providerFail?: boolean } = {}) {
    const sub = makeSubscriber();
    const { db, captured } = makeFakeDb({
      firstResults: [
        // first lookup by email (subscriberId 未指定の path)
        sub,
        // insertEmailLog の getEmailLogById (内部)
        {
          id: 'log-1',
          subscriber_id: sub.id,
          status: 'sent',
        },
      ],
    });
    return {
      db,
      captured,
      sub,
      provider: makeFakeEmailProvider({ fail: opts.providerFail }),
      renderer: makeFakeRenderer(),
    };
  }

  function buildEmailInput(over: Partial<DispatchInput> = {}): DispatchInput {
    return {
      recipient: { email: 'tester@example.com' },
      channel: 'email',
      category: 'marketing',
      sourceKind: 'reorder',
      emailPayload: {
        subjectTemplate: 'subj',
        htmlTemplate: '<p>hello</p>',
        textTemplate: 'hello',
        variables: {},
      },
      ...over,
    };
  }

  it('marketing OK な subscriber へ sent を返す + provider.send 呼ばれる', async () => {
    const { db, provider, renderer } = buildEmailDeps();
    const r = await dispatch(
      {
        db,
        emailProvider: provider,
        emailRenderer: renderer,
        emailFrom: 'naturism <noreply@x.com>',
        emailReplyTo: 'support@x.com',
      },
      buildEmailInput(),
    );

    expect(r.results[0]).toMatchObject({ channel: 'email', status: 'sent' });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const sentMsg = (provider.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sentMsg.from).toBe('naturism <noreply@x.com>');
    expect(sentMsg.replyTo).toBe('support@x.com');
    expect(sentMsg.subject).toBe('RENDERED:subj');
    expect(sentMsg.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/example\/unsub/);
    expect(sentMsg.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('subscriber 未登録なら skipped:no_subscriber', async () => {
    const { db } = makeFakeDb({ firstResults: [null] });
    const r = await dispatch(
      {
        db,
        emailProvider: makeFakeEmailProvider(),
        emailRenderer: makeFakeRenderer(),
      },
      buildEmailInput(),
    );
    expect(r.results[0]).toMatchObject({
      channel: 'email',
      status: 'skipped',
      reason: 'no_subscriber',
    });
  });

  it('marketing で unsubscribed_at セット済なら skipped:unsubscribed', async () => {
    const { db } = makeFakeDb({
      firstResults: [
        makeSubscriber({ unsubscribed_at: '2026-04-01T00:00:00+09:00' }),
      ],
    });
    const provider = makeFakeEmailProvider();
    const r = await dispatch(
      { db, emailProvider: provider, emailRenderer: makeFakeRenderer() },
      buildEmailInput(),
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('transactional は unsubscribed_at あっても is_active=1 なら sent', async () => {
    const { db } = makeFakeDb({
      firstResults: [
        // marketing 解除されたが transactional は届けたい人
        makeSubscriber({ unsubscribed_at: '2026-04-01T00:00:00+09:00', is_active: 0, transactional_only: 1 }),
        { id: 'log-1' }, // log getById
      ],
    });
    const provider = makeFakeEmailProvider();
    const r = await dispatch(
      { db, emailProvider: provider, emailRenderer: makeFakeRenderer(), emailFrom: 'x@y.com' },
      buildEmailInput({ category: 'transactional' }),
    );
    expect(r.results[0]).toMatchObject({ channel: 'email', status: 'sent' });
    expect(provider.send).toHaveBeenCalled();
  });

  it('provider 例外でも failed を返し log は残す (KPI 用)', async () => {
    const { db, captured } = buildEmailDeps({ providerFail: true });
    const r = await dispatch(
      { db, emailProvider: makeFakeEmailProvider({ fail: true }), emailRenderer: makeFakeRenderer(), emailFrom: 'x@y.com' },
      buildEmailInput(),
    );
    expect(r.results[0]).toMatchObject({ channel: 'email', status: 'failed' });
    // INSERT INTO email_messages_log が status='failed' で呼ばれた
    const insertCall = captured.find((c) => c.sql.includes('INSERT INTO email_messages_log'));
    expect(insertCall?.params).toContain('failed');
  });

  it('emailProvider が無いなら skipped:no_provider', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch({ db }, buildEmailInput());
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_provider' });
  });

  it('emailRenderer が無いなら skipped:no_renderer', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch(
      { db, emailProvider: makeFakeEmailProvider() },
      buildEmailInput(),
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_renderer' });
  });

  it('email アドレスが無いなら skipped:no_email', async () => {
    const { db } = makeFakeDb();
    const r = await dispatch(
      { db, emailProvider: makeFakeEmailProvider(), emailRenderer: makeFakeRenderer() },
      { ...buildEmailInput(), recipient: {} },
    );
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'no_email' });
  });
});

// ============================================================
// dispatch — both
// ============================================================

describe('dispatch (both)', () => {
  it("channel='both' は LINE と email 両方を試行 + 各結果を返す", async () => {
    const sub = makeSubscriber();
    // first lookup 順:
    // 1. LINE friends row
    // 2. email_subscribers by email
    // 3. email log getById (内部)
    const { db } = makeFakeDb({
      firstResults: [
        { is_following: 1, is_blacklisted: 0 },
        sub,
        { id: 'log-1' },
      ],
    });
    const provider = makeFakeEmailProvider();
    const r = await dispatch(
      {
        db,
        lineClient: makeFakeLineClient(),
        emailProvider: provider,
        emailRenderer: makeFakeRenderer(),
        emailFrom: 'x@y.com',
      },
      {
        recipient: {
          friend: { id: 'f-1', lineUserId: 'U123' },
          email: 'tester@example.com',
        },
        channel: 'both',
        category: 'marketing',
        sourceKind: 'broadcast',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
        emailPayload: {
          subjectTemplate: 'subj',
          htmlTemplate: '<p>hello</p>',
          textTemplate: 'hello',
          variables: {},
        },
      },
    );

    expect(r.results).toHaveLength(2);
    expect(r.results[0].channel).toBe('line');
    expect(r.results[0].status).toBe('sent');
    expect(r.results[1].channel).toBe('email');
    expect(r.results[1].status).toBe('sent');
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("channel='both' は片側 fail でももう片側を試行 (独立性)", async () => {
    const sub = makeSubscriber();
    const { db } = makeFakeDb({
      firstResults: [{ is_following: 1, is_blacklisted: 0 }, sub, { id: 'log-1' }],
    });
    const r = await dispatch(
      {
        db,
        lineClient: makeFakeLineClient({ fail: true }),
        emailProvider: makeFakeEmailProvider(),
        emailRenderer: makeFakeRenderer(),
        emailFrom: 'x@y.com',
      },
      {
        recipient: {
          friend: { id: 'f-1', lineUserId: 'U123' },
          email: 'tester@example.com',
        },
        channel: 'both',
        category: 'marketing',
        sourceKind: 'broadcast',
        linePayload: { messages: [{ type: 'text', text: 'hi' }] },
        emailPayload: {
          subjectTemplate: 'subj',
          htmlTemplate: '<p>hello</p>',
          textTemplate: 'hello',
          variables: {},
        },
      },
    );
    expect(r.results[0]).toMatchObject({ channel: 'line', status: 'failed' });
    expect(r.results[1]).toMatchObject({ channel: 'email', status: 'sent' });
  });
});
