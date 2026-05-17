/**
 * Tests for routes/email-opt-in (Phase 5β-1)
 *
 * 範囲: GET /email/opt-in / POST /email/opt-in / POST /api/liff/opt-in
 *
 * セキュリティ critical paths:
 *   - HMAC mismatch → 400
 *   - expired token → 400
 *   - missing params → 400
 *   - marketing_consent 未 check → 400
 *   - missing EMAIL_OPTIN_HMAC_KEY → 503
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { emailOptIn } from '../routes/email-opt-in.js';
import { liffOptIn } from '../routes/liff-opt-in.js';
import { signEmailOptInToken } from '../services/email-opt-in.js';
import type { Env } from '../index.js';
import type { EmailSubscriber } from '@line-crm/db';

const HMAC_KEY = 'opt-in-test-key-1234567890abcdefXX';

// ============================================================
// Fake D1 (email_subscribers + audit_logs)
// ============================================================

interface FakeRunResult {
  success: boolean;
  meta: { changes: number };
}

class FakeDb {
  rows = new Map<string, EmailSubscriber>();
  auditCalls: { sql: string; params: unknown[] }[] = [];

  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async <T = unknown>() => this.handleFirst<T>(sql, params),
        all: async <T = unknown>() => ({ results: this.handleAll<T>(sql, params) }),
        run: async (): Promise<FakeRunResult> => this.handleRun(sql, params),
      }),
    };
  }

  private handleFirst<T>(sql: string, params: unknown[]): T | null {
    if (sql.includes('SELECT * FROM audit_logs WHERE id')) {
      // best-effort fake (return minimal stub matching AuditLog shape so audit-logger doesn't throw)
      return { id: String(params[0]) } as T;
    }
    if (sql.includes('SELECT * FROM email_subscribers WHERE id')) {
      return (this.rows.get(String(params[0])) as T) ?? null;
    }
    if (sql.includes('SELECT * FROM email_subscribers WHERE email')) {
      const email = String(params[0]);
      for (const r of this.rows.values()) if (r.email === email) return r as T;
      return null;
    }
    if (sql.includes('SELECT id, is_active, transactional_only, unsubscribed_at, bounce_count, complaint_count')) {
      const email = String(params[0]);
      for (const r of this.rows.values()) {
        if (r.email === email) {
          return {
            id: r.id,
            is_active: r.is_active,
            transactional_only: r.transactional_only,
            unsubscribed_at: r.unsubscribed_at,
            bounce_count: r.bounce_count,
            complaint_count: r.complaint_count,
          } as T;
        }
      }
      return null;
    }
    if (sql.includes('SELECT is_active, transactional_only, unsubscribed_at FROM email_subscribers WHERE email')) {
      const email = String(params[0]);
      for (const r of this.rows.values()) {
        if (r.email === email) {
          return {
            is_active: r.is_active,
            transactional_only: r.transactional_only,
            unsubscribed_at: r.unsubscribed_at,
          } as T;
        }
      }
      return null;
    }
    return null;
  }

  private handleAll<T>(_sql: string, _params: unknown[]): T[] {
    return [];
  }

  private handleRun(sql: string, params: unknown[]): FakeRunResult {
    if (sql.includes('INSERT INTO audit_logs')) {
      this.auditCalls.push({ sql, params });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO email_subscribers')) {
      const [id, friendId, email, isActive, transactionalOnly, consentSource, consentAt, createdAt, updatedAt] =
        params as [string, string | null, string, number, number, string | null, string, string, string];
      this.rows.set(id, {
        id,
        friend_id: friendId,
        email,
        is_active: isActive,
        transactional_only: transactionalOnly,
        unsubscribed_at: null,
        bounce_count: 0,
        complaint_count: 0,
        consent_source: consentSource,
        consent_at: consentAt,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE email_subscribers')) {
      const id = String(params[params.length - 1]);
      const existing = this.rows.get(id);
      if (!existing) return { success: true, meta: { changes: 0 } };
      const cloned: EmailSubscriber = { ...existing };
      if (
        sql.includes('friend_id = COALESCE') &&
        sql.includes('is_active = 1') &&
        sql.includes('transactional_only = 0') &&
        sql.includes('unsubscribed_at = NULL') &&
        sql.includes('consent_at = ?')
      ) {
        cloned.friend_id = (params[0] as string | null) ?? cloned.friend_id;
        cloned.consent_source = (params[1] as string | null) ?? cloned.consent_source;
        cloned.is_active = 1;
        cloned.transactional_only = 0;
        cloned.unsubscribed_at = null;
        cloned.consent_at = String(params[2]);
        cloned.updated_at = String(params[3]);
      }
      this.rows.set(id, cloned);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  seed(row: EmailSubscriber): void {
    this.rows.set(row.id, row);
  }
}

function makeApp(opts: { hmacKey?: string; coupon?: string } = {}): { app: Hono<Env>; db: FakeDb } {
  const app = new Hono<Env>();
  const db = new FakeDb();
  // Provide env via middleware
  app.use('*', async (c, next) => {
    c.env = {
      DB: db as unknown as D1Database,
      EMAIL_OPTIN_HMAC_KEY: opts.hmacKey,
      EMAIL_OPTIN_DEFAULT_COUPON: opts.coupon,
    } as unknown as Env['Bindings'];
    return next();
  });
  app.route('/', emailOptIn);
  return { app, db };
}

function makeLiffApp(opts: { coupon?: string; liffUser?: { lineUserId: string; friendId: string } | null } = {}): { app: Hono<Env>; db: FakeDb } {
  const app = new Hono<Env>();
  const db = new FakeDb();
  app.use('*', async (c, next) => {
    c.env = {
      DB: db as unknown as D1Database,
      EMAIL_OPTIN_DEFAULT_COUPON: opts.coupon,
    } as unknown as Env['Bindings'];
    if (opts.liffUser !== null) {
      const user = opts.liffUser ?? { lineUserId: 'U-test', friendId: 'friend-1' };
      (c as { set: (k: string, v: unknown) => void }).set('liffUser', user);
    }
    return next();
  });
  app.route('/', liffOptIn);
  return { app, db };
}

// ============================================================
// GET /email/opt-in
// ============================================================

describe('GET /email/opt-in', () => {
  it('EMAIL_OPTIN_HMAC_KEY 未設定 → 503', async () => {
    const { app } = makeApp({}); // no hmacKey
    const res = await app.request('/email/opt-in?email=a@x.com&e=1900000000&token=' + 'a'.repeat(64));
    expect(res.status).toBe(503);
  });

  it('params 不足 → 400', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const res = await app.request('/email/opt-in');
    expect(res.status).toBe(400);
  });

  it('expiresAt が数値でない → 400', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const res = await app.request('/email/opt-in?email=a@x.com&e=NaN&token=' + 'a'.repeat(64));
    expect(res.status).toBe(400);
  });

  it('token 不正 → 400 + 「リンクが無効」 文言', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const res = await app.request(`/email/opt-in?email=a@x.com&e=${future}&token=${'b'.repeat(64)}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('リンクが無効');
  });

  it('expired token → 400 + 「有効期限が切れて」 文言', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const past = Math.floor(Date.now() / 1000) - 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'a@x.com', { expiresAt: past });
    const res = await app.request(`/email/opt-in?email=a@x.com&e=${past}&token=${signed.token}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('有効期限');
  });

  it('valid token → 200 + 確認ページ HTML', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'a@x.com', { expiresAt: future });
    const res = await app.request(`/email/opt-in?email=a@x.com&e=${future}&token=${signed.token}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('メールマガジン登録の確認');
    expect(body).toContain('a@x.com');
    expect(body).toContain('marketing_consent');
    expect(body).toContain('noindex'); // robots tag
  });

  it('既に opt-in 済 → 200 + 既登録 banner', async () => {
    const { app, db } = makeApp({ hmacKey: HMAC_KEY });
    db.seed({
      id: 'sub-1',
      friend_id: null,
      email: 'already@x.com',
      is_active: 1,
      transactional_only: 0,
      unsubscribed_at: null,
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'opt_in_form',
      consent_at: '2026-01-01',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'already@x.com', { expiresAt: future });
    const res = await app.request(`/email/opt-in?email=already@x.com&e=${future}&token=${signed.token}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('既にメール配信に同意');
  });
});

// ============================================================
// POST /email/opt-in
// ============================================================

describe('POST /email/opt-in', () => {
  it('EMAIL_OPTIN_HMAC_KEY 未設定 → 503', async () => {
    const { app } = makeApp({});
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(503);
  });

  it('params 不足 → 400', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(400);
  });

  it('token 不正 → 400', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const body = `email=a@x.com&e=${future}&token=${'b'.repeat(64)}&marketing_consent=1`;
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('marketing_consent=1 無しは 400', async () => {
    const { app } = makeApp({ hmacKey: HMAC_KEY });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'a@x.com', { expiresAt: future });
    const body = `email=a@x.com&e=${future}&token=${signed.token}`; // marketing_consent 無し
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('checkbox');
  });

  it('valid + consent → 200 + DB 登録 + audit + クーポン表示', async () => {
    const { app, db } = makeApp({ hmacKey: HMAC_KEY, coupon: 'LINE-WELCOME-500' });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'new@x.com', { expiresAt: future });
    const body = `email=new@x.com&e=${future}&token=${signed.token}&marketing_consent=1`;
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ご登録ありがとうございます');
    expect(html).toContain('LINE-WELCOME-500'); // coupon shown
    expect(html).toContain('new@x.com');

    // DB: 1 件追加
    expect(db.rows.size).toBe(1);
    const row = [...db.rows.values()][0];
    expect(row.is_active).toBe(1);
    expect(row.transactional_only).toBe(0);

    // audit_logs: 1 件
    expect(db.auditCalls.length).toBe(1);
  });

  it('既存 unsubscribed → 復活 + outcome=reactivated を audit metadata に含む', async () => {
    const { app, db } = makeApp({ hmacKey: HMAC_KEY });
    db.seed({
      id: 'sub-react',
      friend_id: null,
      email: 'react@x.com',
      is_active: 0,
      transactional_only: 0,
      unsubscribed_at: '2026-01-01',
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'opt_in_form',
      consent_at: '2026-01-01',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const future = Math.floor(Date.now() / 1000) + 86400;
    const signed = await signEmailOptInToken(HMAC_KEY, 'react@x.com', { expiresAt: future });
    const body = `email=react@x.com&e=${future}&token=${signed.token}&marketing_consent=1`;
    const res = await app.request('/email/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(200);
    const updated = db.rows.get('sub-react');
    expect(updated?.is_active).toBe(1);
    expect(updated?.unsubscribed_at).toBeNull();

    const auditMetadata = String(db.auditCalls[0]?.params.find((p) => typeof p === 'string' && String(p).includes('reactivated')));
    expect(auditMetadata).toContain('reactivated');
  });
});

// ============================================================
// POST /api/liff/opt-in
// ============================================================

describe('POST /api/liff/opt-in', () => {
  it('liffUser 未設定 → 401', async () => {
    const { app } = makeLiffApp({ liffUser: null });
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.com', marketingConsent: true }),
    });
    expect(res.status).toBe(401);
  });

  it('JSON 不正 → 400', async () => {
    const { app } = makeLiffApp();
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('email 不正 → 400', async () => {
    const { app } = makeLiffApp();
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-email', marketingConsent: true }),
    });
    expect(res.status).toBe(400);
  });

  it('marketingConsent=false → 400', async () => {
    const { app } = makeLiffApp();
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@x.com', marketingConsent: false }),
    });
    expect(res.status).toBe(400);
  });

  it('valid → 200 + friendId 紐付き + audit', async () => {
    const { app, db } = makeLiffApp({ coupon: 'LIFF-100' });
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'liff@x.com', marketingConsent: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { subscriberId: string; email: string; outcome: string; couponCode: string | null } }>();
    expect(json.success).toBe(true);
    expect(json.data.email).toBe('liff@x.com');
    expect(json.data.outcome).toBe('new');
    expect(json.data.couponCode).toBe('LIFF-100');
    expect(json.data.subscriberId).toBeDefined();

    const row = [...db.rows.values()][0];
    expect(row.friend_id).toBe('friend-1');
    expect(db.auditCalls.length).toBe(1);
  });

  it('coupon 未設定 → couponCode=null', async () => {
    const { app } = makeLiffApp({}); // coupon 無し
    const res = await app.request('/api/liff/opt-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nc@x.com', marketingConsent: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { couponCode: string | null } }>();
    expect(json.data.couponCode).toBeNull();
  });
});
