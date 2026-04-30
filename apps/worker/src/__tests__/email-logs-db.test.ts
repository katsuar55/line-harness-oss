/**
 * Tests for `@line-crm/db` email-logs helpers (Round 4 PR-2).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  insertEmailLog,
  updateEmailLogStatus,
  getEmailLogByProviderId,
  recordEmailClick,
  type EmailMessageLog,
} from '@line-crm/db';

// Capturing fake D1
interface CapturedCall {
  sql: string;
  params: unknown[];
}

function makeFakeDb(opts: {
  firstResults?: unknown[];
  runChanges?: number;
}) {
  const captured: CapturedCall[] = [];
  let firstIdx = 0;
  const db: unknown = {
    prepare(sql: string) {
      const call: CapturedCall = { sql, params: [] };
      captured.push(call);
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async first<T>() {
              return ((opts.firstResults?.[firstIdx++] as T) ?? null);
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return { success: true, meta: { changes: opts.runChanges ?? 1 } };
            },
          };
        },
      };
    },
  };
  return { db: db as D1Database, captured };
}

describe('insertEmailLog', () => {
  it('全フィールドを bind し sent_at が status=sent 時に埋まる', async () => {
    const fakeRow: EmailMessageLog = {
      id: 'log-1',
      subscriber_id: 'sub-1',
      template_id: null,
      broadcast_id: null,
      scenario_step_id: null,
      source_order_id: 'order-9',
      source_kind: 'reorder',
      category: 'marketing',
      subject: 'X',
      from_address: 'noreply@x.com',
      reply_to: null,
      provider: 'resend',
      provider_message_id: 'pmid-1',
      status: 'sent',
      error_summary: null,
      sent_at: '2026-04-29T10:00:00+09:00',
      delivered_at: null,
      first_opened_at: null,
      last_event_at: null,
      open_count: 0,
      click_count: 0,
      created_at: '2026-04-29T10:00:00+09:00',
    };
    const { db, captured } = makeFakeDb({ firstResults: [fakeRow] });
    const result = await insertEmailLog(db, {
      subscriberId: 'sub-1',
      sourceOrderId: 'order-9',
      sourceKind: 'reorder',
      category: 'marketing',
      subject: 'X',
      fromAddress: 'noreply@x.com',
      provider: 'resend',
      providerMessageId: 'pmid-1',
      status: 'sent',
    });
    expect(result.id).toBe('log-1');
    // INSERT 文が呼ばれたことを確認
    const insertCall = captured.find((c) => c.sql.includes('INSERT INTO email_messages_log'));
    expect(insertCall).toBeDefined();
    // status=sent のとき sent_at は埋まっている (param に non-null の値が含まれる)
    expect(insertCall?.params).toContain('sub-1');
    expect(insertCall?.params).toContain('reorder');
    expect(insertCall?.params).toContain('marketing');
  });

  it('status=queued (default) なら sent_at は null', async () => {
    const fakeRow = { id: 'log-q' } as EmailMessageLog;
    const { db, captured } = makeFakeDb({ firstResults: [fakeRow] });
    await insertEmailLog(db, {
      subscriberId: 'sub-1',
      sourceKind: 'manual',
      category: 'transactional',
      subject: 'Y',
      fromAddress: 'noreply@x.com',
      provider: 'resend',
      // status 省略 = 'queued'
    });
    const insertCall = captured.find((c) => c.sql.includes('INSERT INTO email_messages_log'));
    expect(insertCall).toBeDefined();
    // sent_at param は null のはず (params 配列に null が含まれる)
    expect(insertCall?.params).toContain(null);
  });
});

describe('updateEmailLogStatus', () => {
  it('未存在 (provider_message_id 不一致) なら false', async () => {
    const { db } = makeFakeDb({ firstResults: [null as unknown as Record<string, unknown>] });
    const ok = await updateEmailLogStatus(db, {
      provider: 'resend',
      providerMessageId: 'no-such',
      newStatus: 'delivered',
    });
    expect(ok).toBe(false);
  });

  it('delivered で delivered_at が埋まる (初回のみ)', async () => {
    const log: EmailMessageLog = {
      id: 'log-d',
      subscriber_id: 'sub-1',
      template_id: null,
      broadcast_id: null,
      scenario_step_id: null,
      source_order_id: null,
      source_kind: 'manual',
      category: 'transactional',
      subject: 'X',
      from_address: 'a@x.com',
      reply_to: null,
      provider: 'resend',
      provider_message_id: 'pmid-d',
      status: 'sent',
      error_summary: null,
      sent_at: '2026-04-29T10:00:00+09:00',
      delivered_at: null, // ← まだ
      first_opened_at: null,
      last_event_at: null,
      open_count: 0,
      click_count: 0,
      created_at: '2026-04-29T10:00:00+09:00',
    };
    const { db, captured } = makeFakeDb({ firstResults: [log] });
    const ok = await updateEmailLogStatus(db, {
      provider: 'resend',
      providerMessageId: 'pmid-d',
      newStatus: 'delivered',
    });
    expect(ok).toBe(true);
    const updateCall = captured.find((c) => c.sql.includes('UPDATE email_messages_log'));
    expect(updateCall?.sql).toContain('delivered_at = ?');
  });

  it('opened で first_opened_at は初回のみ埋める (既に値あれば追加しない)', async () => {
    const log: EmailMessageLog = {
      id: 'log-o',
      subscriber_id: 'sub-1',
      template_id: null,
      broadcast_id: null,
      scenario_step_id: null,
      source_order_id: null,
      source_kind: 'broadcast',
      category: 'marketing',
      subject: 'X',
      from_address: 'a@x.com',
      reply_to: null,
      provider: 'resend',
      provider_message_id: 'pmid-o',
      status: 'delivered',
      error_summary: null,
      sent_at: '2026-04-29T10:00:00+09:00',
      delivered_at: '2026-04-29T10:01:00+09:00',
      first_opened_at: '2026-04-29T11:00:00+09:00', // ← 既に開封済
      last_event_at: '2026-04-29T11:00:00+09:00',
      open_count: 1,
      click_count: 0,
      created_at: '2026-04-29T10:00:00+09:00',
    };
    const { db, captured } = makeFakeDb({ firstResults: [log] });
    await updateEmailLogStatus(db, {
      provider: 'resend',
      providerMessageId: 'pmid-o',
      newStatus: 'opened',
      incrementOpenCount: true,
    });
    const updateCall = captured.find((c) => c.sql.includes('UPDATE email_messages_log'));
    expect(updateCall?.sql).not.toContain('first_opened_at = ?');
    expect(updateCall?.sql).toContain('open_count = open_count + 1');
  });

  it('errorSummary が指定されたら SET 句に含まれる', async () => {
    const log = {
      id: 'log-e',
      provider: 'resend',
      provider_message_id: 'pmid-e',
      status: 'sent',
      delivered_at: null,
      first_opened_at: null,
    } as EmailMessageLog;
    const { db, captured } = makeFakeDb({ firstResults: [log] });
    await updateEmailLogStatus(db, {
      provider: 'resend',
      providerMessageId: 'pmid-e',
      newStatus: 'failed',
      errorSummary: 'SMTP error 550',
    });
    const updateCall = captured.find((c) => c.sql.includes('UPDATE email_messages_log'));
    expect(updateCall?.sql).toContain('error_summary = ?');
    expect(updateCall?.params).toContain('SMTP error 550');
  });
});

describe('getEmailLogByProviderId', () => {
  it('SELECT に provider と provider_message_id を bind する', async () => {
    const { db, captured } = makeFakeDb({ firstResults: [null as unknown as Record<string, unknown>] });
    await getEmailLogByProviderId(db, 'resend', 'pmid-x');
    const selCall = captured.find((c) => c.sql.includes('SELECT * FROM email_messages_log'));
    expect(selCall?.params).toEqual(['resend', 'pmid-x']);
  });
});

describe('recordEmailClick', () => {
  it('email_link_clicks に INSERT する', async () => {
    const { db, captured } = makeFakeDb({});
    await recordEmailClick(db, 'log-1', 'https://example.com/a', {
      userAgent: 'UA-test',
      ipHash: 'hash-1',
    });
    const insertCall = captured.find((c) => c.sql.includes('INSERT INTO email_link_clicks'));
    expect(insertCall).toBeDefined();
    expect(insertCall?.params).toContain('log-1');
    expect(insertCall?.params).toContain('https://example.com/a');
    expect(insertCall?.params).toContain('UA-test');
    expect(insertCall?.params).toContain('hash-1');
  });
});
