/**
 * Tests for routes/email-unsubscribe (Round 4 PR-5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { emailUnsubscribe, __test__ } from '../routes/email-unsubscribe.js';
import type { Env } from '../index.js';
import type { EmailSubscriber } from '@line-crm/db';

const HMAC_KEY = 'a'.repeat(64); // テスト用固定キー

// ============================================================
// Fakes
// ============================================================

interface FakeDbState {
  byId: Record<string, EmailSubscriber>;
  /** UPDATE 実行ログ (debug 用) */
  updates: { sql: string; params: unknown[] }[];
}

function makeFakeDb(state: FakeDbState): D1Database {
  return {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      return {
        bind(...params: unknown[]) {
          call.params = params;
          return {
            async first<T>() {
              if (sql.includes('SELECT * FROM email_subscribers WHERE id = ?')) {
                const id = params[0] as string;
                return (state.byId[id] as T | undefined) ?? null;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (sql.startsWith('UPDATE email_subscribers')) {
                state.updates.push(call);
                const id = params[params.length - 1] as string;
                const sub = state.byId[id];
                if (!sub) return { success: true, meta: { changes: 0 } };
                if (sql.includes('SET is_active = 0')) {
                  if (sub.is_active === 1) {
                    state.byId[id] = {
                      ...sub,
                      is_active: 0,
                      unsubscribed_at: new Date().toISOString(),
                    };
                    return { success: true, meta: { changes: 1 } };
                  }
                  // is_active が既に 0 なら updateById は no-op
                  return { success: true, meta: { changes: 0 } };
                }
                if (sql.includes('SET is_active = 1')) {
                  state.byId[id] = { ...sub, is_active: 1, unsubscribed_at: null };
                  return { success: true, meta: { changes: 1 } };
                }
                if (sql.includes('SET unsubscribed_at = ?')) {
                  if (!sub.unsubscribed_at) {
                    state.byId[id] = {
                      ...sub,
                      unsubscribed_at: new Date().toISOString(),
                    };
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true, meta: { changes: 0 } };
                }
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function buildEnv(state: FakeDbState): Env['Bindings'] {
  return {
    DB: makeFakeDb(state),
    AI: {} as unknown as Ai,
    LINE_CHANNEL_SECRET: 'x',
    LINE_CHANNEL_ACCESS_TOKEN: 'x',
    API_KEY: 'x',
    LIFF_URL: 'x',
    LINE_CHANNEL_ID: 'x',
    LINE_LOGIN_CHANNEL_ID: 'x',
    LINE_LOGIN_CHANNEL_SECRET: 'x',
    WORKER_URL: 'x',
    EMAIL_UNSUBSCRIBE_HMAC_KEY: HMAC_KEY,
  };
}

function makeApp(state: FakeDbState) {
  const app = new Hono<Env>();
  app.route('/', emailUnsubscribe);
  // Hono `request` の第 3 引数で env を渡せる。helper を返してテスト側で使う。
  return {
    request: (path: string, init?: RequestInit) =>
      app.request(path, init, buildEnv(state)),
  };
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

async function validToken(subscriberId: string): Promise<string> {
  return await __test__.hmacSha256Hex(HMAC_KEY, subscriberId);
}

// ============================================================
// helpers (純関数)
// ============================================================

describe('verifyUnsubscribeToken', () => {
  it('正しい token なら true', async () => {
    const token = await __test__.hmacSha256Hex(HMAC_KEY, 'sub-1');
    expect(await __test__.verifyUnsubscribeToken(HMAC_KEY, 'sub-1', token)).toBe(
      true,
    );
  });

  it('別 subscriber の token は false', async () => {
    const token = await __test__.hmacSha256Hex(HMAC_KEY, 'sub-other');
    expect(await __test__.verifyUnsubscribeToken(HMAC_KEY, 'sub-1', token)).toBe(
      false,
    );
  });

  it('token 形式不正 (hex 以外) は false', async () => {
    expect(await __test__.verifyUnsubscribeToken(HMAC_KEY, 'sub-1', 'not-hex')).toBe(
      false,
    );
  });

  it('id or token が空なら false', async () => {
    expect(await __test__.verifyUnsubscribeToken(HMAC_KEY, '', 'a'.repeat(64))).toBe(
      false,
    );
    expect(await __test__.verifyUnsubscribeToken(HMAC_KEY, 'sub-1', '')).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('HTML エスケープが効く', () => {
    expect(__test__.escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it("シングルクォートも escape", () => {
    expect(__test__.escapeHtml("it's & me")).toBe('it&#39;s &amp; me');
  });
});

describe('constantTimeEqual', () => {
  it('長さが異なれば false', () => {
    expect(__test__.constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('内容一致で true', () => {
    expect(__test__.constantTimeEqual('abc', 'abc')).toBe(true);
  });

  it('内容違いで false', () => {
    expect(__test__.constantTimeEqual('abc', 'abd')).toBe(false);
  });
});

// ============================================================
// GET /email/unsubscribe
// ============================================================

describe('GET /email/unsubscribe', () => {
  let state: FakeDbState;
  beforeEach(() => {
    state = { byId: { 'sub-1': makeSubscriber() }, updates: [] };
  });

  it('正常: 確認ページ HTML を返す (200, "配信を停止する" ボタンあり)', async () => {
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(`/email/unsubscribe?id=sub-1&token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('配信停止の確認');
    expect(html).toContain('配信を停止する');
    expect(html).toContain('tester@example.com');
  });

  it('id 欠落で 400', async () => {
    const app = makeApp(state);
    const res = await app.request(`/email/unsubscribe?token=abc`);
    expect(res.status).toBe(400);
  });

  it('token 不正で 400', async () => {
    const app = makeApp(state);
    const res = await app.request(`/email/unsubscribe?id=sub-1&token=${'x'.repeat(64)}`);
    expect(res.status).toBe(400);
  });

  it('subscriber 未登録で 404', async () => {
    const app = makeApp(state);
    const token = await validToken('sub-missing');
    const res = await app.request(
      `/email/unsubscribe?id=sub-missing&token=${token}`,
    );
    expect(res.status).toBe(404);
  });

  it('既に unsubscribed_at セット済 → 200 + "既に配信停止" 文言', async () => {
    state.byId['sub-1'] = makeSubscriber({
      unsubscribed_at: '2026-04-01T00:00:00+09:00',
      is_active: 0,
    });
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(`/email/unsubscribe?id=sub-1&token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('既に配信停止');
  });
});

// ============================================================
// POST /email/unsubscribe
// ============================================================

describe('POST /email/unsubscribe', () => {
  let state: FakeDbState;
  beforeEach(() => {
    state = { byId: { 'sub-1': makeSubscriber() }, updates: [] };
  });

  it('正常: form body 経由で is_active=0 + unsubscribed_at セット', async () => {
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const body = new URLSearchParams({
      id: 'sub-1',
      token,
      'List-Unsubscribe': 'One-Click',
    });
    const res = await app.request('/email/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('配信停止が完了しました');
    expect(state.byId['sub-1']!.is_active).toBe(0);
    expect(state.byId['sub-1']!.unsubscribed_at).not.toBeNull();
  });

  it('RFC 8058 One-Click: query string 経由でも処理可', async () => {
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(
      `/email/unsubscribe?id=sub-1&token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      },
    );
    expect(res.status).toBe(200);
    expect(state.byId['sub-1']!.is_active).toBe(0);
  });

  it('既に解除済なら idempotent (200, "配信停止済み" 表示、状態変更なし)', async () => {
    state.byId['sub-1'] = makeSubscriber({
      unsubscribed_at: '2026-04-01T00:00:00+09:00',
      is_active: 0,
    });
    const before = { ...state.byId['sub-1'] };
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(
      `/email/unsubscribe?id=sub-1&token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('配信停止済み');
    expect(state.byId['sub-1']!.unsubscribed_at).toBe(before.unsubscribed_at);
  });

  it('bounce 抑制 (is_active=0, unsubscribed_at IS NULL) でも unsubscribed_at がセットされる', async () => {
    state.byId['sub-1'] = makeSubscriber({
      is_active: 0,
      unsubscribed_at: null, // bounce で is_active=0 にされたが、ユーザー解除はまだ
    });
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(
      `/email/unsubscribe?id=sub-1&token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      },
    );
    expect(res.status).toBe(200);
    expect(state.byId['sub-1']!.unsubscribed_at).not.toBeNull();
  });

  it('token 不正で 400 + 状態変更なし', async () => {
    const app = makeApp(state);
    const res = await app.request(
      `/email/unsubscribe?id=sub-1&token=${'b'.repeat(64)}`,
      { method: 'POST', body: '' },
    );
    expect(res.status).toBe(400);
    expect(state.byId['sub-1']!.is_active).toBe(1);
    expect(state.byId['sub-1']!.unsubscribed_at).toBeNull();
  });

  it('id 欠落で 400 (form / query 両方欠落)', async () => {
    const app = makeApp(state);
    const res = await app.request('/email/unsubscribe', { method: 'POST', body: '' });
    expect(res.status).toBe(400);
  });

  it('subscriber 未登録で 404', async () => {
    const app = makeApp(state);
    const token = await validToken('sub-missing');
    const res = await app.request(
      `/email/unsubscribe?id=sub-missing&token=${token}`,
      { method: 'POST', body: '' },
    );
    expect(res.status).toBe(404);
  });

  it('EMAIL_UNSUBSCRIBE_HMAC_KEY 未設定で 503', async () => {
    const noKeyState: FakeDbState = { byId: {}, updates: [] };
    const app = new Hono<Env>();
    app.route('/', emailUnsubscribe);
    // env から HMAC key を抜く
    const envNoKey = { DB: makeFakeDb(noKeyState) };
    const res = await app.request('/email/unsubscribe', { method: 'POST', body: '' }, envNoKey);
    expect(res.status).toBe(503);
  });
});

// ============================================================
// POST /email/resubscribe
// ============================================================

describe('POST /email/resubscribe', () => {
  it('正常: is_active=1 に戻る + unsubscribed_at=null', async () => {
    const state: FakeDbState = {
      byId: {
        'sub-1': makeSubscriber({
          is_active: 0,
          unsubscribed_at: '2026-04-01T00:00:00+09:00',
        }),
      },
      updates: [],
    };
    const app = makeApp(state);
    const token = await validToken('sub-1');
    const res = await app.request(
      `/email/resubscribe?id=sub-1&token=${token}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const json: unknown = await res.json();
    expect(json).toEqual({ success: true });
    expect(state.byId['sub-1']!.is_active).toBe(1);
    expect(state.byId['sub-1']!.unsubscribed_at).toBeNull();
  });

  it('token 不正で 400', async () => {
    const state: FakeDbState = { byId: {}, updates: [] };
    const app = makeApp(state);
    const res = await app.request(
      `/email/resubscribe?id=sub-1&token=${'c'.repeat(64)}`,
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
  });
});
