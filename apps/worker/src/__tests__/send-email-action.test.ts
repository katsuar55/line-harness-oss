/**
 * Tests for send-email-action (Round 4 PR-6)
 *
 * カバレッジ:
 * - subscriber 未登録 → skipped:no_subscriber_for_friend
 * - templateId 指定で template 取得 → 送信
 * - templateId 不在で 404 → skipped:template_not_found
 * - 直接 content 指定 (subject/htmlContent/textContent) → 送信
 * - subject/htmlContent/textContent 欠落 → skipped:missing_subject_or_content
 * - friend.display_name が variables に展開される
 * - category デフォルトは marketing
 * - category='transactional' を渡すと transactional ゲートが効く
 * - dispatcher の sent → status=sent
 * - dispatcher の skipped → status=skipped (consent gate 等)
 * - dispatcher の failed → status=failed
 */

import { describe, it, expect, vi } from 'vitest';
import {
  executeSendEmailAction,
  type SendEmailActionContext,
  type SendEmailActionParams,
} from '../services/send-email-action.js';
import type { EmailDispatchConfig } from '../services/email-dispatch-config.js';

// ChannelDispatcher と email-dispatch-config を mock
vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: vi.fn(),
}));
vi.mock('../services/email-dispatch-config.js', () => ({
  buildEmailDispatcherDeps: vi.fn(() => ({
    emailProvider: {} as unknown,
    emailRenderer: {} as unknown,
    emailFrom: 'noreply@x.com',
    emailReplyTo: 'support@x.com',
  })),
}));

import { dispatch } from '../services/channel-dispatcher.js';
const dispatchMock = vi.mocked(dispatch);

// ============================================================
// Fakes
// ============================================================

interface FakeRow {
  /** 1 回目 first() で返す: subscriber 行 */
  subscriber?: { id: string; email: string } | null;
  /** 2 回目 first() で返す: template 行 (templateId 指定時のみ) */
  template?: {
    subject: string;
    html_content: string;
    text_content: string;
    preheader: string | null;
  } | null;
  /** 3 回目 first() で返す: friend display_name */
  friend?: { display_name: string | null } | null;
}

function makeFakeDb(rows: FakeRow): D1Database {
  const sequence: { sql: string; result: unknown }[] = [];
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>() {
              if (sql.includes('FROM email_subscribers')) {
                return (rows.subscriber ?? null) as T | null;
              }
              if (sql.includes('FROM email_templates')) {
                return (rows.template ?? null) as T | null;
              }
              if (sql.includes('FROM friends')) {
                return (rows.friend ?? null) as T | null;
              }
              return null;
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
    // for type completeness — we only use prepare
  } as unknown as D1Database;
}

function makeConfig(): EmailDispatchConfig {
  return {
    resendApiKey: 're_test',
    emailFrom: 'noreply@x.com',
    emailReplyTo: 'support@x.com',
    emailUnsubscribeBaseUrl: 'https://x.com/email/unsubscribe',
    emailUnsubscribeHmacKey: 'a'.repeat(64),
    emailLegalFooterHtml: '<p>footer</p>',
    emailLegalFooterText: 'footer',
  };
}

function makeCtx(rows: FakeRow): SendEmailActionContext {
  return {
    db: makeFakeDb(rows),
    friendId: 'f-1',
    emailConfig: makeConfig(),
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
});

import { beforeEach } from 'vitest';

// ============================================================
// Tests
// ============================================================

describe('executeSendEmailAction', () => {
  it('subscriber 未登録なら skipped:no_subscriber_for_friend', async () => {
    const ctx = makeCtx({ subscriber: null });
    const r = await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'no_subscriber_for_friend' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('templateId 指定で template 取得 → dispatch される', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [
        { channel: 'email', status: 'sent', providerMessageId: 'pm-1', subscriberId: 'sub-1' },
      ],
    });
    const ctx = makeCtx({
      subscriber: { id: 'sub-1', email: 'tester@example.com' },
      template: {
        subject: 'tpl-subj',
        html_content: '<p>tpl-html</p>',
        text_content: 'tpl-text',
        preheader: 'preview',
      },
      friend: { display_name: 'Taro' },
    });
    const r = await executeSendEmailAction(ctx, { templateId: 'tpl-1' });
    expect(r.status).toBe('sent');
    expect(r.providerMessageId).toBe('pm-1');
    const call = dispatchMock.mock.calls[0]![1];
    expect(call.emailPayload?.subjectTemplate).toBe('tpl-subj');
    expect(call.emailPayload?.preheader).toBe('preview');
    expect(call.emailPayload?.templateId).toBe('tpl-1');
    expect(call.emailPayload?.variables.name).toBe('Taro');
  });

  it('templateId 不在 → skipped:template_not_found', async () => {
    const ctx = makeCtx({
      subscriber: { id: 'sub-1', email: 't@x.com' },
      template: null,
    });
    const r = await executeSendEmailAction(ctx, { templateId: 'missing' });
    expect(r).toEqual({ status: 'skipped', reason: 'template_not_found' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('直接 content 指定で dispatch される', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [
        { channel: 'email', status: 'sent', providerMessageId: 'pm-2', subscriberId: 'sub-2' },
      ],
    });
    const ctx = makeCtx({
      subscriber: { id: 'sub-2', email: 't@x.com' },
      friend: { display_name: 'Hanako' },
    });
    const r = await executeSendEmailAction(ctx, {
      subject: 'direct-subj',
      htmlContent: '<p>direct</p>',
      textContent: 'direct',
    });
    expect(r.status).toBe('sent');
    const call = dispatchMock.mock.calls[0]![1];
    expect(call.emailPayload?.subjectTemplate).toBe('direct-subj');
    expect(call.emailPayload?.htmlTemplate).toBe('<p>direct</p>');
  });

  it('subject 欠落で skipped:missing_subject_or_content', async () => {
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    const r = await executeSendEmailAction(ctx, {
      htmlContent: 'h',
      textContent: 't',
    });
    expect(r.reason).toBe('missing_subject_or_content');
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('htmlContent 欠落で skipped:missing_subject_or_content', async () => {
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    const r = await executeSendEmailAction(ctx, { subject: 's', textContent: 't' });
    expect(r.reason).toBe('missing_subject_or_content');
  });

  it('friend.display_name が無い時は "お客様" に fallback', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const ctx = makeCtx({
      subscriber: { id: 'sub', email: 't@x.com' },
      friend: null,
    });
    await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    const call = dispatchMock.mock.calls[0]![1];
    expect(call.emailPayload?.variables.name).toBe('お客様');
  });

  it('category 未指定はデフォルト marketing', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(dispatchMock.mock.calls[0]![1].category).toBe('marketing');
  });

  it('category=transactional を渡すと dispatcher にそのまま伝わる', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
      category: 'transactional',
    });
    expect(dispatchMock.mock.calls[0]![1].category).toBe('transactional');
  });

  it('dispatcher が skipped を返したら status=skipped + reason 引き継ぎ', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'skipped', reason: 'unsubscribed' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    const r = await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('unsubscribed');
  });

  it('dispatcher が failed を返したら status=failed + reason 引き継ぎ', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'failed', error: 'Resend 5xx' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    const r = await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('Resend 5xx');
  });

  it('sourceKind は manual で渡される (automations 起点の集計用)', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub', email: 't@x.com' } });
    await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(dispatchMock.mock.calls[0]![1].sourceKind).toBe('manual');
  });

  it('recipient.subscriberId が dispatcher に渡される (DB 再 lookup 回避)', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const ctx = makeCtx({ subscriber: { id: 'sub-x', email: 't@x.com' } });
    await executeSendEmailAction(ctx, {
      subject: 's',
      htmlContent: 'h',
      textContent: 't',
    });
    expect(dispatchMock.mock.calls[0]![1].recipient).toEqual({
      email: 't@x.com',
      subscriberId: 'sub-x',
    });
  });
});

// buildEmailDispatchConfig のテストは別ファイル (mock 干渉回避):
// see __tests__/email-dispatch-config.test.ts
