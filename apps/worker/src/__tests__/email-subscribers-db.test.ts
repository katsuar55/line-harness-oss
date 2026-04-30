/**
 * Tests for `@line-crm/db` email-subscribers helpers (Round 4 PR-2).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  upsertEmailSubscriber,
  getEmailSubscriberByEmail,
  getEmailSubscriberById,
  recordBounce,
  recordComplaint,
  unsubscribeById,
  resubscribeById,
  type EmailSubscriber,
} from '@line-crm/db';

// ============================================================
// in-memory fake D1 (簡易テーブル emulation)
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
    return null;
  }

  private handleAll<T>(_upper: string, _sql: string, _params: unknown[]): T[] {
    return [];
  }

  private handleRun(upper: string, sql: string, params: unknown[]): FakeRunResult {
    if (sql.includes('INSERT INTO email_subscribers')) {
      const [
        id,
        friendId,
        email,
        isActive,
        transactionalOnly,
        consentSource,
        consentAt,
        createdAt,
        updatedAt,
      ] = params as [string, string | null, string, number, number, string | null, string, string, string];
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
      // 簡易: 末尾 param が id 想定
      const id = String(params[params.length - 1]);
      const existing = this.rows.get(id);
      if (!existing) return { success: true, meta: { changes: 0 } };

      // SET 句から差分を吸収する簡易パーサ (テスト目的)
      const cloned: EmailSubscriber = { ...existing };
      // upsert path: friend_id / consent_source / updated_at
      if (sql.includes('friend_id = COALESCE')) {
        cloned.friend_id = (params[0] as string | null) ?? cloned.friend_id;
        cloned.consent_source = (params[1] as string | null) ?? cloned.consent_source;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('bounce_count')) {
        cloned.bounce_count = params[0] as number;
        if ((params[1] as number) === 1) cloned.is_active = 0;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('complaint_count')) {
        cloned.complaint_count = params[0] as number;
        if ((params[1] as number) === 1) cloned.is_active = 0;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('unsubscribed_at = ?') && sql.includes('is_active = 0') && upper.includes('AND IS_ACTIVE = 1')) {
        if (existing.is_active !== 1) return { success: true, meta: { changes: 0 } };
        cloned.is_active = 0;
        cloned.unsubscribed_at = String(params[0]);
        cloned.updated_at = String(params[1]);
      } else if (sql.includes('is_active = 1') && sql.includes('unsubscribed_at = NULL')) {
        cloned.is_active = 1;
        cloned.unsubscribed_at = null;
        cloned.updated_at = String(params[0]);
      }
      this.rows.set(id, cloned);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

const makeDb = () => new FakeDb() as unknown as D1Database;

// ============================================================
// Tests
// ============================================================

describe('upsertEmailSubscriber', () => {
  let db: D1Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('新規 marketingOptIn=true → is_active=1, transactional_only=0', async () => {
    const sub = await upsertEmailSubscriber(db, {
      email: 'a@x.com',
      marketingOptIn: true,
      consentSource: 'shopify_checkout',
    });
    expect(sub.is_active).toBe(1);
    expect(sub.transactional_only).toBe(0);
    expect(sub.consent_source).toBe('shopify_checkout');
  });

  it('新規 marketingOptIn=false → is_active=0, transactional_only=1', async () => {
    const sub = await upsertEmailSubscriber(db, {
      email: 'b@x.com',
      marketingOptIn: false,
    });
    expect(sub.is_active).toBe(0);
    expect(sub.transactional_only).toBe(1);
  });

  it('既存 email に再 upsert しても is_active は維持される', async () => {
    const first = await upsertEmailSubscriber(db, {
      email: 'c@x.com',
      marketingOptIn: true,
    });
    expect(first.is_active).toBe(1);

    // bounce で is_active=0 にした後 upsert しても再 active 化しない
    await recordBounce(db, 'c@x.com');
    await recordBounce(db, 'c@x.com');
    await recordBounce(db, 'c@x.com'); // 3 回で deactivate

    const after = await upsertEmailSubscriber(db, {
      email: 'c@x.com',
      friendId: 'friend-1',
      marketingOptIn: true,
    });
    expect(after.is_active).toBe(0); // 維持
    expect(after.friend_id).toBe('friend-1'); // friend_id は patch される
  });
});

describe('recordBounce', () => {
  let db: D1Database;
  beforeEach(() => { db = makeDb(); });

  it('1 回目はカウントだけ増えて is_active 維持', async () => {
    await upsertEmailSubscriber(db, { email: 'd@x.com', marketingOptIn: true });
    const r = await recordBounce(db, 'd@x.com');
    expect(r.bounceCount).toBe(1);
    expect(r.deactivated).toBe(false);
    const sub = await getEmailSubscriberByEmail(db, 'd@x.com');
    expect(sub?.is_active).toBe(1);
  });

  it('3 回目で is_active=0 に自動抑制', async () => {
    await upsertEmailSubscriber(db, { email: 'e@x.com', marketingOptIn: true });
    await recordBounce(db, 'e@x.com');
    await recordBounce(db, 'e@x.com');
    const r = await recordBounce(db, 'e@x.com');
    expect(r.bounceCount).toBe(3);
    expect(r.deactivated).toBe(true);
    const sub = await getEmailSubscriberByEmail(db, 'e@x.com');
    expect(sub?.is_active).toBe(0);
  });

  it('未登録 email は no-op', async () => {
    const r = await recordBounce(db, 'unknown@x.com');
    expect(r.bounceCount).toBe(0);
    expect(r.deactivated).toBe(false);
  });
});

describe('recordComplaint', () => {
  let db: D1Database;
  beforeEach(() => { db = makeDb(); });

  it('1 回で即 is_active=0 (法令上の苦情応答)', async () => {
    await upsertEmailSubscriber(db, { email: 'f@x.com', marketingOptIn: true });
    const r = await recordComplaint(db, 'f@x.com');
    expect(r.complaintCount).toBe(1);
    expect(r.deactivated).toBe(true);
  });
});

describe('unsubscribeById / resubscribeById', () => {
  let db: D1Database;
  beforeEach(() => { db = makeDb(); });

  it('unsubscribe で is_active=0, unsubscribed_at セット', async () => {
    const sub = await upsertEmailSubscriber(db, { email: 'g@x.com', marketingOptIn: true });
    const ok = await unsubscribeById(db, sub.id);
    expect(ok).toBe(true);
    const after = await getEmailSubscriberById(db, sub.id);
    expect(after?.is_active).toBe(0);
    expect(after?.unsubscribed_at).not.toBeNull();
  });

  it('既に解除済みなら unsubscribe は changes=0 (false 返却)', async () => {
    const sub = await upsertEmailSubscriber(db, { email: 'h@x.com', marketingOptIn: true });
    await unsubscribeById(db, sub.id);
    const second = await unsubscribeById(db, sub.id);
    expect(second).toBe(false);
  });

  it('resubscribe で is_active=1 に復活', async () => {
    const sub = await upsertEmailSubscriber(db, { email: 'i@x.com', marketingOptIn: true });
    await unsubscribeById(db, sub.id);
    const ok = await resubscribeById(db, sub.id);
    expect(ok).toBe(true);
    const after = await getEmailSubscriberById(db, sub.id);
    expect(after?.is_active).toBe(1);
    expect(after?.unsubscribed_at).toBeNull();
  });
});
