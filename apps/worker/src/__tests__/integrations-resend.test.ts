/**
 * Tests for routes/integrations-resend (Round 4 PR-4)
 *
 * 主に processResendEvent (純関数: D1 を fake で置き換え) を verify する。
 * route 全体の HTTP 検証はサンプル 2 件 (署名 OK / NG) のみ。
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  integrationsResend,
  __test__,
  type ResendWebhookPayload,
} from '../routes/integrations-resend.js';
import type { Env } from '../index.js';
import type { EmailMessageLog, EmailSubscriber } from '@line-crm/db';

const { processResendEvent, formatBounceError } = __test__;

// ============================================================
// Fake D1 (state machine)
// ============================================================

interface FakeState {
  logs: Record<string, EmailMessageLog>;
  subscribers: Record<string, EmailSubscriber>;
  /** UPDATE / INSERT 履歴 */
  ops: { sql: string; params: unknown[] }[];
}

function makeFakeDb(state: FakeState): D1Database {
  return {
    prepare(sql: string) {
      const op = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          op.params = params;
          return {
            async first<T>() {
              // SELECT * FROM email_messages_log WHERE provider = ? AND provider_message_id = ?
              if (
                sql.includes('FROM email_messages_log') &&
                sql.includes('provider_message_id = ?')
              ) {
                const provider = params[0] as string;
                const pmid = params[1] as string;
                const log = Object.values(state.logs).find(
                  (l) => l.provider === provider && l.provider_message_id === pmid,
                );
                return (log as T | undefined) ?? null;
              }
              // SELECT * FROM email_messages_log WHERE id = ?
              if (sql.includes('FROM email_messages_log') && sql.includes('id = ?')) {
                const id = params[0] as string;
                return (state.logs[id] as T | undefined) ?? null;
              }
              // SELECT * FROM email_subscribers WHERE id = ?
              if (sql.includes('FROM email_subscribers') && sql.includes('id = ?')) {
                const id = params[0] as string;
                return (state.subscribers[id] as T | undefined) ?? null;
              }
              // SELECT * FROM email_subscribers WHERE email = ?
              if (sql.includes('FROM email_subscribers') && sql.includes('email = ?')) {
                const email = params[0] as string;
                const sub = Object.values(state.subscribers).find((s) => s.email === email);
                return (sub as T | undefined) ?? null;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              state.ops.push(op);
              // UPDATE email_messages_log SET status = ? ... WHERE id = ?
              if (sql.startsWith('UPDATE email_messages_log')) {
                const id = params[params.length - 1] as string;
                const log = state.logs[id];
                if (!log) return { success: true, meta: { changes: 0 } };
                // 簡易: status の値だけ反映 (params[0] が新 status のはず)
                state.logs[id] = { ...log, status: params[0] as string };
                if (sql.includes('open_count = open_count + 1')) {
                  state.logs[id]!.open_count = log.open_count + 1;
                }
                if (sql.includes('click_count = click_count + 1')) {
                  state.logs[id]!.click_count = log.click_count + 1;
                }
                return { success: true, meta: { changes: 1 } };
              }
              // UPDATE email_subscribers SET bounce_count = ? ...
              if (sql.startsWith('UPDATE email_subscribers') && sql.includes('bounce_count = ?')) {
                const subId = params[params.length - 1] as string;
                const sub = state.subscribers[subId];
                if (!sub) return { success: true, meta: { changes: 0 } };
                const newCount = params[0] as number;
                const shouldDeact = params[1] === 1;
                state.subscribers[subId] = {
                  ...sub,
                  bounce_count: newCount,
                  is_active: shouldDeact ? 0 : sub.is_active,
                };
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.startsWith('UPDATE email_subscribers') && sql.includes('complaint_count = ?')) {
                const subId = params[params.length - 1] as string;
                const sub = state.subscribers[subId];
                if (!sub) return { success: true, meta: { changes: 0 } };
                const newCount = params[0] as number;
                const shouldDeact = params[1] === 1;
                state.subscribers[subId] = {
                  ...sub,
                  complaint_count: newCount,
                  is_active: shouldDeact ? 0 : sub.is_active,
                };
                return { success: true, meta: { changes: 1 } };
              }
              // INSERT INTO email_link_clicks
              if (sql.startsWith('INSERT INTO email_link_clicks')) {
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function makeLog(over: Partial<EmailMessageLog> = {}): EmailMessageLog {
  return {
    id: 'log-1',
    subscriber_id: 'sub-1',
    template_id: null,
    broadcast_id: null,
    scenario_step_id: null,
    source_order_id: null,
    source_kind: 'reorder',
    category: 'marketing',
    subject: 'Test',
    from_address: 'noreply@x.com',
    reply_to: null,
    provider: 'resend',
    provider_message_id: 'pm-1',
    status: 'sent',
    error_summary: null,
    sent_at: '2026-05-01T10:00:00+09:00',
    delivered_at: null,
    first_opened_at: null,
    last_event_at: null,
    open_count: 0,
    click_count: 0,
    created_at: '2026-05-01T10:00:00+09:00',
    ...over,
  };
}

function makeSub(over: Partial<EmailSubscriber> = {}): EmailSubscriber {
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
    consent_at: '2026-01-01T00:00:00+09:00',
    created_at: '2026-01-01T00:00:00+09:00',
    updated_at: '2026-01-01T00:00:00+09:00',
    ...over,
  };
}

function buildState(over: Partial<FakeState> = {}): FakeState {
  return {
    logs: { 'log-1': makeLog() },
    subscribers: { 'sub-1': makeSub() },
    ops: [],
    ...over,
  };
}

// ============================================================
// processResendEvent (純ロジック)
// ============================================================

describe('processResendEvent', () => {
  it('email.delivered: log.status を delivered に更新', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.delivered',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('updated');
    expect(state.logs['log-1']!.status).toBe('delivered');
  });

  it('email.opened: status=opened + open_count++', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.opened',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('updated');
    expect(state.logs['log-1']!.status).toBe('opened');
    expect(state.logs['log-1']!.open_count).toBe(1);
  });

  it('email.opened を 2 回受けたら open_count=2', async () => {
    const state = buildState();
    await processResendEvent(makeFakeDb(state), {
      type: 'email.opened',
      data: { email_id: 'pm-1' },
    });
    await processResendEvent(makeFakeDb(state), {
      type: 'email.opened',
      data: { email_id: 'pm-1' },
    });
    expect(state.logs['log-1']!.open_count).toBe(2);
  });

  it('email.clicked: status=clicked + click_count++ + email_link_clicks INSERT', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.clicked',
      data: {
        email_id: 'pm-1',
        click: {
          link: 'https://naturism-diet.com/product/1',
          ipAddress: '203.0.113.1',
          userAgent: 'Mozilla/5.0',
        },
      },
    });
    expect(r.action).toBe('updated');
    expect(state.logs['log-1']!.status).toBe('clicked');
    expect(state.logs['log-1']!.click_count).toBe(1);
    const insertOp = state.ops.find((o) =>
      o.sql.startsWith('INSERT INTO email_link_clicks'),
    );
    expect(insertOp).toBeDefined();
    // params: [id, email_log_id, url, user_agent, ip_hash]
    expect(insertOp!.params[2]).toBe('https://naturism-diet.com/product/1');
    expect(insertOp!.params[3]).toBe('Mozilla/5.0');
    expect(insertOp!.params[4]).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('email.clicked: click 詳細欠落でもエラーにしない (status だけ更新)', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.clicked',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('updated');
    const insertOp = state.ops.find((o) =>
      o.sql.startsWith('INSERT INTO email_link_clicks'),
    );
    expect(insertOp).toBeUndefined();
  });

  it('email.bounced: log status=bounced + subscriber.bounce_count=1', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.bounced',
      data: { email_id: 'pm-1', bounce_type: 'Permanent' },
    });
    expect(r.action).toBe('updated');
    expect(state.logs['log-1']!.status).toBe('bounced');
    expect(state.subscribers['sub-1']!.bounce_count).toBe(1);
    expect(state.subscribers['sub-1']!.is_active).toBe(1); // まだ閾値未満
  });

  it('email.bounced 3 回連続で is_active=0 (auto-suppress)', async () => {
    const state = buildState();
    for (let i = 0; i < 3; i++) {
      await processResendEvent(makeFakeDb(state), {
        type: 'email.bounced',
        data: { email_id: 'pm-1', bounce_type: 'Permanent' },
      });
    }
    expect(state.subscribers['sub-1']!.bounce_count).toBe(3);
    expect(state.subscribers['sub-1']!.is_active).toBe(0);
  });

  it('email.complained 1 回で即 is_active=0', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.complained',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('updated');
    expect(state.logs['log-1']!.status).toBe('complained');
    expect(state.subscribers['sub-1']!.complaint_count).toBe(1);
    expect(state.subscribers['sub-1']!.is_active).toBe(0);
  });

  it('email.sent は no-op (status を sent → sent で再上書きしない)', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.sent',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('skipped');
    expect(state.ops).toHaveLength(0);
  });

  it('email.delivery_delayed は no-op', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.delivery_delayed',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('skipped');
    expect(state.ops).toHaveLength(0);
  });

  it('未知の type は unknown_event で skip (Resend が将来 event 追加しても落ちない)', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.something_new',
      data: { email_id: 'pm-1' },
    });
    expect(r.action).toBe('unknown_event');
    expect(r.detail).toBe('email.something_new');
  });

  it('log が見つからない (email_id=不明) は log_not_found', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.delivered',
      data: { email_id: 'pm-UNKNOWN' },
    });
    expect(r.action).toBe('log_not_found');
  });

  it('email_id 欠落の payload は skipped (Resend のバグ吸収)', async () => {
    const state = buildState();
    const r = await processResendEvent(makeFakeDb(state), {
      type: 'email.delivered',
      data: {},
    });
    expect(r.action).toBe('skipped');
  });
});

// ============================================================
// formatBounceError
// ============================================================

describe('formatBounceError', () => {
  it('bounce_type + bounceSubType + message を / で結合', () => {
    const s = formatBounceError({
      type: 'email.bounced',
      data: {
        bounce_type: 'Permanent',
        bounce: { bounceSubType: 'NoEmail', message: 'User does not exist' },
      },
    });
    expect(s).toBe('Permanent / NoEmail / User does not exist');
  });

  it('一部欠落でも空文字を含めず連結', () => {
    const s = formatBounceError({
      type: 'email.bounced',
      data: { bounce_type: 'Permanent' },
    });
    expect(s).toBe('Permanent');
  });

  it('500 文字を超えるメッセージは切り詰め', () => {
    const s = formatBounceError({
      type: 'email.bounced',
      data: { bounce: { message: 'x'.repeat(1000) } },
    });
    expect(s.length).toBeLessThanOrEqual(500);
  });
});

// ============================================================
// Route HTTP-level (smoke)
// ============================================================

describe('POST /api/integrations/resend/webhook', () => {
  // テスト用の whsec_ secret + 署名生成 helper
  const SECRET = 'whsec_dGVzdC1zZWNyZXQtMTIzNDU2'; // base64('test-secret-123456')

  async function buildSig(opts: {
    svixId: string;
    timestamp: string;
    body: string;
  }): Promise<string> {
    const b64 = SECRET.slice('whsec_'.length);
    const keyBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const enc = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const message = `${opts.svixId}.${opts.timestamp}.${opts.body}`;
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
    return `v1,${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
  }

  function makeApp(state: FakeState) {
    const app = new Hono<Env>();
    app.route('/', integrationsResend);
    return {
      request: (path: string, init?: RequestInit) =>
        app.request(path, init, {
          DB: makeFakeDb(state),
          RESEND_WEBHOOK_SECRET: SECRET,
        } as unknown as Env['Bindings']),
    };
  }

  it('正規署名 → 200 + log 状態が更新される', async () => {
    const state = buildState();
    const app = makeApp(state);
    const body = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'pm-1' },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await buildSig({ svixId: 'msg_001', timestamp: ts, body });
    const res = await app.request('/api/integrations/resend/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': 'msg_001',
        'svix-timestamp': ts,
        'svix-signature': sig,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(state.logs['log-1']!.status).toBe('delivered');
  });

  it('署名不一致 → 401 + 状態変更なし', async () => {
    const state = buildState();
    const app = makeApp(state);
    const body = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'pm-1' },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    // body と署名の中身が違う = mismatch
    const sig = await buildSig({ svixId: 'msg_001', timestamp: ts, body: 'OTHER' });
    const res = await app.request('/api/integrations/resend/webhook', {
      method: 'POST',
      headers: {
        'svix-id': 'msg_001',
        'svix-timestamp': ts,
        'svix-signature': sig,
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(state.logs['log-1']!.status).toBe('sent'); // 元のまま
  });

  it('RESEND_WEBHOOK_SECRET 未設定 → 503', async () => {
    const state = buildState();
    const app = new Hono<Env>();
    app.route('/', integrationsResend);
    const res = await app.request(
      '/api/integrations/resend/webhook',
      {
        method: 'POST',
        body: '{}',
      },
      { DB: makeFakeDb(state) } as unknown as Env['Bindings'],
    );
    expect(res.status).toBe(503);
  });
});
