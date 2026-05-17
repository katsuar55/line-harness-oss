/**
 * Tests for services/email-opt-in.ts (Phase 5β-1)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  signEmailOptInToken,
  verifyEmailOptInToken,
  performEmailOptIn,
  isValidEmail,
  __test__,
} from '../services/email-opt-in.js';
import type { EmailSubscriber } from '@line-crm/db';

const TEST_KEY = 'test-opt-in-hmac-key-32-bytes-XXXX';

// ============================================================
// in-memory fake D1 (email_subscribers のみ emulation)
// reuse strategy: 既存 email-subscribers-db.test.ts と同じ pattern
// ============================================================

interface FakeRunResult {
  success: boolean;
  meta: { changes: number };
}

class FakeDb {
  rows = new Map<string, EmailSubscriber>();

  prepare(sql: string) {
    const trimmed = sql.trim().toUpperCase();
    return {
      bind: (...params: unknown[]) => ({
        first: async <T = unknown>() => this.handleFirst<T>(trimmed, sql, params),
        all: async <T = unknown>() => ({ results: this.handleAll<T>(trimmed, sql, params) }),
        run: async (): Promise<FakeRunResult> => this.handleRun(trimmed, sql, params),
      }),
    };
  }

  private handleFirst<T>(upper: string, _sql: string, params: unknown[]): T | null {
    if (upper.startsWith('SELECT * FROM EMAIL_SUBSCRIBERS WHERE ID')) {
      return (this.rows.get(String(params[0])) as T) ?? null;
    }
    if (upper.startsWith('SELECT * FROM EMAIL_SUBSCRIBERS WHERE EMAIL')) {
      const email = String(params[0]);
      for (const r of this.rows.values()) {
        if (r.email === email) return r as T;
      }
      return null;
    }
    // performEmailOptIn の before SELECT (列 subset)
    if (upper.startsWith('SELECT ID, IS_ACTIVE, TRANSACTIONAL_ONLY, UNSUBSCRIBED_AT, BOUNCE_COUNT, COMPLAINT_COUNT')) {
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
    return null;
  }

  private handleAll<T>(_upper: string, _sql: string, _params: unknown[]): T[] {
    return [];
  }

  private handleRun(_upper: string, sql: string, params: unknown[]): FakeRunResult {
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
        // recordMarketingOptIn path
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

  /** test helper: 既存 row を seed する */
  seed(row: EmailSubscriber): void {
    this.rows.set(row.id, row);
  }
}

const makeDb = () => new FakeDb();

// ============================================================
// signEmailOptInToken / verifyEmailOptInToken
// ============================================================

describe('signEmailOptInToken', () => {
  it('email + expiresAt から 64 文字 hex token を生成する', async () => {
    const result = await signEmailOptInToken(TEST_KEY, 'user@example.com', {
      expiresAt: 1900000000,
    });
    expect(result.email).toBe('user@example.com');
    expect(result.expiresAt).toBe(1900000000);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('同じ email + expiresAt は同じ token を返す (deterministic)', async () => {
    const a = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1900000000 });
    const b = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1900000000 });
    expect(a.token).toBe(b.token);
  });

  it('email が違えば token が違う', async () => {
    const a = await signEmailOptInToken(TEST_KEY, 'a@x.com', { expiresAt: 1900000000 });
    const b = await signEmailOptInToken(TEST_KEY, 'b@x.com', { expiresAt: 1900000000 });
    expect(a.token).not.toBe(b.token);
  });

  it('expiresAt が違えば token が違う', async () => {
    const a = await signEmailOptInToken(TEST_KEY, 'a@x.com', { expiresAt: 1900000000 });
    const b = await signEmailOptInToken(TEST_KEY, 'a@x.com', { expiresAt: 1900000001 });
    expect(a.token).not.toBe(b.token);
  });

  it('email 大文字小文字違いでも同じ token (lowercase normalize)', async () => {
    const a = await signEmailOptInToken(TEST_KEY, 'User@Example.COM', { expiresAt: 1900000000 });
    const b = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1900000000 });
    expect(a.token).toBe(b.token);
  });

  it('expiresAt 省略時は ttlSeconds (default 30 日) を加算', async () => {
    const now = 1700000000;
    const result = await signEmailOptInToken(TEST_KEY, 'a@x.com', {
      now: () => now,
    });
    expect(result.expiresAt).toBe(now + __test__.DEFAULT_TOKEN_TTL_SECONDS);
  });

  it('ttlSeconds で expiry を指定できる', async () => {
    const now = 1700000000;
    const result = await signEmailOptInToken(TEST_KEY, 'a@x.com', {
      now: () => now,
      ttlSeconds: 60 * 60, // 1 時間
    });
    expect(result.expiresAt).toBe(now + 3600);
  });

  it('Invalid email で reject', async () => {
    await expect(signEmailOptInToken(TEST_KEY, 'not-an-email')).rejects.toThrow();
    await expect(signEmailOptInToken(TEST_KEY, '')).rejects.toThrow();
  });

  it('hmacKey 空文字で reject', async () => {
    await expect(signEmailOptInToken('', 'a@x.com')).rejects.toThrow();
  });
});

describe('verifyEmailOptInToken', () => {
  it('sign で生成した token は verify で valid', async () => {
    const signed = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1900000000 });
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: signed.email,
      expiresAt: signed.expiresAt,
      token: signed.token,
      now: () => 1899999999, // before expiry
    });
    expect(result.valid).toBe(true);
  });

  it('expiresAt が現在時刻より過去なら expired', async () => {
    const signed = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1800000000 });
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: signed.email,
      expiresAt: signed.expiresAt,
      token: signed.token,
      now: () => 1900000000, // way after expiry
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('expired');
  });

  it('token を 1 文字書き換えると signature_mismatch', async () => {
    const signed = await signEmailOptInToken(TEST_KEY, 'user@example.com', { expiresAt: 1900000000 });
    // 末尾を flip (a→b, 0→1)
    const tampered = signed.token.slice(0, -1) + (signed.token.slice(-1) === 'a' ? 'b' : 'a');
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: signed.email,
      expiresAt: signed.expiresAt,
      token: tampered,
      now: () => 1899999999,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('signature_mismatch');
  });

  it('別の hmacKey で signed token は signature_mismatch', async () => {
    const signed = await signEmailOptInToken('key-a', 'user@example.com', { expiresAt: 1900000000 });
    const result = await verifyEmailOptInToken('key-b', {
      email: signed.email,
      expiresAt: signed.expiresAt,
      token: signed.token,
      now: () => 1899999999,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('signature_mismatch');
  });

  it('hex 形式違反 token は invalid_format', async () => {
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: 'a@x.com',
      expiresAt: 1900000000,
      token: 'NOT-HEX',
      now: () => 1700000000,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_format');
  });

  it('email 形式違反は invalid_format', async () => {
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: 'not-an-email',
      expiresAt: 1900000000,
      token: 'a'.repeat(64),
      now: () => 1700000000,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_format');
  });

  it('hmacKey 空文字は invalid_format', async () => {
    const result = await verifyEmailOptInToken('', {
      email: 'a@x.com',
      expiresAt: 1900000000,
      token: 'a'.repeat(64),
      now: () => 1700000000,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_format');
  });

  it('expiresAt が 0 以下は invalid_format', async () => {
    const result = await verifyEmailOptInToken(TEST_KEY, {
      email: 'a@x.com',
      expiresAt: 0,
      token: 'a'.repeat(64),
      now: () => 1700000000,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe('invalid_format');
  });
});

describe('isValidEmail', () => {
  it('有効な email を true で返す', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('user+tag@sub.example.co.jp')).toBe(true);
  });
  it('@ なしは false', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
  });
  it('TLD なしは false', () => {
    expect(isValidEmail('user@example')).toBe(false);
  });
  it('254 字超過は false (RFC 5321)', () => {
    const longLocal = 'a'.repeat(255);
    expect(isValidEmail(`${longLocal}@x.com`)).toBe(false);
  });
  it('null / undefined / 空文字は false', () => {
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});

// ============================================================
// performEmailOptIn (outcome 判定 + 復活ロジック)
// ============================================================

describe('performEmailOptIn', () => {
  let fake: FakeDb;
  let db: D1Database;
  beforeEach(() => {
    fake = makeDb();
    db = fake as unknown as D1Database;
  });

  it('新規 email → outcome=new / hadComplaint=false', async () => {
    const result = await performEmailOptIn(db, {
      email: 'new@x.com',
      channel: 'liff',
      friendId: 'friend-1',
    });
    expect(result.outcome).toBe('new');
    expect(result.hadComplaint).toBe(false);
    expect(result.email).toBe('new@x.com');
    expect(result.subscriberId).toBeDefined();
  });

  it('既存 (transactional_only=1, is_active=1) → outcome=re_consent', async () => {
    // Shopify sync で transactional_only=1 で登録された状態を seed
    fake.seed({
      id: 'sub-1',
      friend_id: null,
      email: 'tx@x.com',
      is_active: 1,
      transactional_only: 1,
      unsubscribed_at: null,
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'shopify_checkout',
      consent_at: '2026-01-01T00:00:00.000',
      created_at: '2026-01-01T00:00:00.000',
      updated_at: '2026-01-01T00:00:00.000',
    });
    const result = await performEmailOptIn(db, {
      email: 'tx@x.com',
      channel: 'web',
    });
    expect(result.outcome).toBe('re_consent');
    expect(result.hadComplaint).toBe(false);
  });

  it('既存 unsubscribed → outcome=reactivated', async () => {
    fake.seed({
      id: 'sub-2',
      friend_id: null,
      email: 'un@x.com',
      is_active: 0,
      transactional_only: 0,
      unsubscribed_at: '2026-04-01T00:00:00.000',
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'opt_in_form',
      consent_at: '2026-01-01T00:00:00.000',
      created_at: '2026-01-01T00:00:00.000',
      updated_at: '2026-04-01T00:00:00.000',
    });
    const result = await performEmailOptIn(db, {
      email: 'un@x.com',
      channel: 'web',
    });
    expect(result.outcome).toBe('reactivated');
    expect(result.hadComplaint).toBe(false);
  });

  it('既存 bounce-suppressed (is_active=0, bounce_count=3) → outcome=reactivated', async () => {
    fake.seed({
      id: 'sub-3',
      friend_id: null,
      email: 'bounce@x.com',
      is_active: 0,
      transactional_only: 0,
      unsubscribed_at: null,
      bounce_count: 3,
      complaint_count: 0,
      consent_source: 'shopify_checkout',
      consent_at: '2026-01-01T00:00:00.000',
      created_at: '2026-01-01T00:00:00.000',
      updated_at: '2026-04-01T00:00:00.000',
    });
    const result = await performEmailOptIn(db, {
      email: 'bounce@x.com',
      channel: 'web',
    });
    expect(result.outcome).toBe('reactivated');
    expect(result.hadComplaint).toBe(false);
  });

  it('既存 complaint 履歴あり → hadComplaint=true (caller 側で警告判断)', async () => {
    fake.seed({
      id: 'sub-4',
      friend_id: null,
      email: 'complaint@x.com',
      is_active: 0,
      transactional_only: 0,
      unsubscribed_at: null,
      bounce_count: 0,
      complaint_count: 1,
      consent_source: 'shopify_checkout',
      consent_at: '2026-01-01T00:00:00.000',
      created_at: '2026-01-01T00:00:00.000',
      updated_at: '2026-04-01T00:00:00.000',
    });
    const result = await performEmailOptIn(db, {
      email: 'complaint@x.com',
      channel: 'web',
    });
    expect(result.outcome).toBe('reactivated');
    expect(result.hadComplaint).toBe(true);
  });

  it('consentSource 上書き', async () => {
    const result = await performEmailOptIn(db, {
      email: 'src@x.com',
      channel: 'liff',
      consentSource: 'liff_signup',
    });
    expect(result.outcome).toBe('new');
    expect(fake.rows.get(result.subscriberId)?.consent_source).toBe('liff_signup');
  });

  it('Invalid email で throw', async () => {
    await expect(
      performEmailOptIn(db, {
        email: 'not-an-email',
        channel: 'liff',
      }),
    ).rejects.toThrow();
  });
});
