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
  recordMarketingOptIn,
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
      // recordMarketingOptIn は upsert より具体的なので先にマッチさせる
      if (sql.includes('friend_id = COALESCE') && sql.includes('is_active = 1') && sql.includes('transactional_only = 0') && sql.includes('unsubscribed_at = NULL') && sql.includes('consent_at = ?')) {
        cloned.friend_id = (params[0] as string | null) ?? cloned.friend_id;
        cloned.consent_source = (params[1] as string | null) ?? cloned.consent_source;
        cloned.is_active = 1;
        cloned.transactional_only = 0;
        cloned.unsubscribed_at = null;
        cloned.consent_at = String(params[2]);
        cloned.updated_at = String(params[3]);
      } else if (sql.includes('friend_id = COALESCE')) {
        // upsertEmailSubscriber path: friend_id / consent_source / updated_at のみ
        cloned.friend_id = (params[0] as string | null) ?? cloned.friend_id;
        cloned.consent_source = (params[1] as string | null) ?? cloned.consent_source;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('bounce_count')) {
        cloned.bounce_count = params[0] as number;
        if ((params[1] as number) === 1) cloned.is_active = 0;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('complaint_count = ?')) {
        cloned.complaint_count = params[0] as number;
        if ((params[1] as number) === 1) cloned.is_active = 0;
        cloned.updated_at = String(params[2]);
      } else if (sql.includes('unsubscribed_at = ?') && sql.includes('is_active = 0') && upper.includes('AND IS_ACTIVE = 1')) {
        if (existing.is_active !== 1) return { success: true, meta: { changes: 0 } };
        cloned.is_active = 0;
        cloned.unsubscribed_at = String(params[0]);
        cloned.updated_at = String(params[1]);
      } else if (sql.includes('is_active = 1') && sql.includes('unsubscribed_at = NULL')) {
        // resubscribeById: WHERE COALESCE(complaint_count,0)=0 — 苦情者は復活させない
        if (sql.includes('complaint_count') && (existing.complaint_count ?? 0) > 0) {
          return { success: true, meta: { changes: 0 } };
        }
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

  it('resubscribe は苦情履歴ありの subscriber を復活させない (changes=0)', async () => {
    // spam complaint を出した subscriber は再有効化不可 (= 特定電子メール法 / reputation 保護)
    const sub = await upsertEmailSubscriber(db, { email: 'j@x.com', marketingOptIn: true });
    await recordComplaint(db, 'j@x.com'); // complaint_count=1, is_active=0
    const ok = await resubscribeById(db, sub.id);
    expect(ok).toBe(false);
    const after = await getEmailSubscriberById(db, sub.id);
    expect(after?.is_active).toBe(0);
  });
});

// ============================================================
// recordMarketingOptIn (Phase 5β-1: opt-in 再取得施策)
// ============================================================

describe('recordMarketingOptIn', () => {
  let db: D1Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('新規 → is_active=1 / transactional_only=0 / consent_source 記録', async () => {
    const sub = await recordMarketingOptIn(db, {
      email: 'opt1@x.com',
      consentSource: 'opt_in_form',
      friendId: 'friend-1',
    });
    expect(sub.is_active).toBe(1);
    expect(sub.transactional_only).toBe(0);
    expect(sub.consent_source).toBe('opt_in_form');
    expect(sub.friend_id).toBe('friend-1');
    expect(sub.unsubscribed_at).toBeNull();
  });

  it('既存 transactional_only=1 (Shopify sync 由来) → is_active=1 に昇格', async () => {
    await upsertEmailSubscriber(db, {
      email: 'opt2@x.com',
      marketingOptIn: false,
      consentSource: 'shopify_checkout',
    });

    const sub = await recordMarketingOptIn(db, {
      email: 'opt2@x.com',
      consentSource: 'opt_in_form',
    });
    expect(sub.is_active).toBe(1);
    expect(sub.transactional_only).toBe(0);
    expect(sub.consent_source).toBe('opt_in_form'); // 上書き
  });

  it('既存 unsubscribed (is_active=0 + unsubscribed_at セット済) → 復活 + consent_at 更新', async () => {
    const sub0 = await upsertEmailSubscriber(db, {
      email: 'opt3@x.com',
      marketingOptIn: true,
    });
    await unsubscribeById(db, sub0.id);

    // unsubscribed 状態を確認
    const beforeOptIn = await getEmailSubscriberByEmail(db, 'opt3@x.com');
    expect(beforeOptIn?.is_active).toBe(0);
    expect(beforeOptIn?.unsubscribed_at).not.toBeNull();

    const sub = await recordMarketingOptIn(db, {
      email: 'opt3@x.com',
      consentSource: 'opt_in_form',
    });
    expect(sub.is_active).toBe(1);
    expect(sub.unsubscribed_at).toBeNull();
  });

  it('bounce 抑制済 (is_active=0) でも明示的 opt-in で復活 (bounce_count は保持)', async () => {
    await upsertEmailSubscriber(db, { email: 'opt4@x.com', marketingOptIn: true });
    await recordBounce(db, 'opt4@x.com');
    await recordBounce(db, 'opt4@x.com');
    await recordBounce(db, 'opt4@x.com'); // 3 回で deactivate

    const beforeOptIn = await getEmailSubscriberByEmail(db, 'opt4@x.com');
    expect(beforeOptIn?.is_active).toBe(0);
    expect(beforeOptIn?.bounce_count).toBe(3);

    const sub = await recordMarketingOptIn(db, {
      email: 'opt4@x.com',
      consentSource: 'opt_in_form',
    });
    expect(sub.is_active).toBe(1);
    expect(sub.bounce_count).toBe(3); // 履歴保持 (再 bounce で再追跡可能)
  });

  it('friend_id を後付で patch できる', async () => {
    await recordMarketingOptIn(db, { email: 'opt5@x.com', consentSource: 'opt_in_form' });
    const updated = await recordMarketingOptIn(db, {
      email: 'opt5@x.com',
      friendId: 'friend-new',
      consentSource: 'opt_in_form',
    });
    expect(updated.friend_id).toBe('friend-new');
  });

  it('friendId 省略時は既存値を保持 (COALESCE)', async () => {
    await recordMarketingOptIn(db, {
      email: 'opt6@x.com',
      friendId: 'friend-existing',
      consentSource: 'opt_in_form',
    });
    const updated = await recordMarketingOptIn(db, {
      email: 'opt6@x.com',
      // friendId 省略
      consentSource: 'opt_in_form',
    });
    expect(updated.friend_id).toBe('friend-existing'); // 維持
  });
});
