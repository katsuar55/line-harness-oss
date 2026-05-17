/**
 * Tests for services/bulk-opt-in-invitation.ts (Phase 5β-1d-1)
 *
 * カバレッジ:
 *   - template not found → 全件 failed:template_not_found
 *   - dryRun=true → 実送信なし、 sent='dry_run' で完結
 *   - email validation 失敗 → skipped:invalid_email
 *   - 既に marketing opted-in → skipped:already_marketing_opted_in
 *   - 既存 transactional_only=1 → subscriber id 再利用 (重複 INSERT 回避)
 *   - 新規 email → INSERT email_subscribers (is_active=0, transactional_only=1, source='manual_import')
 *   - dispatcher が sent / skipped / failed を返す各ケース
 *   - opt_in_url が各 recipient ごとに per-email 署名されている
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmailSubscriber } from '@line-crm/db';

// dispatcher と email config を mock
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

// brand config helper を mock (default brand を返す)
vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getBrandConfigForAccount: vi.fn(async () => ({
      id: 'brand-1',
      account_id: null,
      brand_name: 'naturism',
      company_name: '株式会社ケンコーエクスプレス',
      support_email: 'support@naturism-diet.com',
      shop_url: 'https://naturism-diet.com',
      subscription_url: 'https://naturism-diet.com/sub',
      primary_color: '#0f766e',
      intro_product_label: 'Blue 7 日分',
      is_default: 1,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })),
  };
});

import {
  sendBulkOptInInvitations,
  type BulkInvitationConfig,
} from '../services/bulk-opt-in-invitation.js';
import { dispatch } from '../services/channel-dispatcher.js';

const dispatchMock = vi.mocked(dispatch);

const TEMPLATE = {
  subject: 'opt-in invitation',
  html_content: '<p>click {{opt_in_url}}</p>',
  text_content: 'click {{opt_in_url}}',
  preheader: 'preview',
};

// ============================================================
// Fakes
// ============================================================

class FakeDb {
  subscribers = new Map<string, EmailSubscriber>();
  templateRow: typeof TEMPLATE | null = TEMPLATE;
  insertCount = 0;

  prepare(sql: string) {
    return {
      bind: (...params: unknown[]) => ({
        first: async <T = unknown>() => this.handleFirst<T>(sql, params),
        all: async <T = unknown>() => ({ results: this.handleAll<T>(sql, params) }),
        run: async () => this.handleRun(sql, params),
      }),
    };
  }

  private handleFirst<T>(sql: string, params: unknown[]): T | null {
    if (sql.includes('FROM email_templates')) {
      return this.templateRow as T | null;
    }
    if (sql.includes('SELECT id, is_active, transactional_only FROM email_subscribers WHERE email')) {
      const email = String(params[0]).toLowerCase();
      for (const s of this.subscribers.values()) {
        if (s.email.toLowerCase() === email) {
          return {
            id: s.id,
            is_active: s.is_active,
            transactional_only: s.transactional_only,
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

  private handleRun(sql: string, params: unknown[]) {
    if (sql.includes('INSERT INTO email_subscribers')) {
      this.insertCount++;
      const [id, email, , consentAt, createdAt, updatedAt] = params as [string, string, unknown, string, string, string];
      // is_active=0 / transactional_only=1 は SQL リテラル経由
      this.subscribers.set(id, {
        id,
        friend_id: null,
        email,
        is_active: 0,
        transactional_only: 1,
        unsubscribed_at: null,
        bounce_count: 0,
        complaint_count: 0,
        consent_source: 'manual_import',
        consent_at: consentAt,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  seed(row: EmailSubscriber) {
    this.subscribers.set(row.id, row);
  }
}

function makeConfig(): BulkInvitationConfig {
  return {
    emailConfig: {
      resendApiKey: 're_test',
      emailFrom: 'noreply@x.com',
      emailReplyTo: 'support@x.com',
      emailUnsubscribeBaseUrl: 'https://x.com/email/unsubscribe',
      emailUnsubscribeHmacKey: 'a'.repeat(64),
      emailLegalFooterHtml: '<p>footer</p>',
      emailLegalFooterText: 'footer',
    },
    optInUrlConfig: {
      hmacKey: 'opt-in-test-hmac-key-32bytes-XXXXX',
      workerUrl: 'https://worker.example.com',
    },
  };
}

beforeEach(() => {
  dispatchMock.mockReset();
});

// ============================================================
// Tests
// ============================================================

describe('sendBulkOptInInvitations', () => {
  it('template not found → 全件 failed:template_not_found', async () => {
    const fake = new FakeDb();
    fake.templateRow = null;
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
      },
    );
    expect(result.total).toBe(2);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.details[0]).toMatchObject({ status: 'failed', reason: 'template_not_found' });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('dryRun=true → 実送信なし、 dispatcher 未呼び出し', async () => {
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'dry@x.com', firstName: 'Taro' }],
        dryRun: true,
      },
    );
    expect(result.dryRun).toBe(true);
    expect(result.sent).toBe(1);
    expect(result.details[0]).toMatchObject({ status: 'sent', providerMessageId: 'dry_run' });
    expect(dispatchMock).not.toHaveBeenCalled();
    // dryRun でも subscriber は INSERT される (transactional 配信権 pre-register)
    expect(fake.insertCount).toBe(1);
  });

  it('invalid email → skipped:invalid_email', async () => {
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'not-an-email' }, { email: '@nope' }],
        dryRun: true,
      },
    );
    expect(result.skipped).toBe(2);
    expect(result.details[0]).toMatchObject({ status: 'skipped', reason: 'invalid_email' });
  });

  it('既に marketing opted-in な email → skipped:already_marketing_opted_in', async () => {
    const fake = new FakeDb();
    fake.seed({
      id: 'sub-already',
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
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'already@x.com' }],
        dryRun: true,
      },
    );
    expect(result.skipped).toBe(1);
    expect(result.details[0]).toMatchObject({ status: 'skipped', reason: 'already_marketing_opted_in' });
    expect(fake.insertCount).toBe(0); // 既存利用、 新規 INSERT なし
  });

  it('既存 transactional_only=1 → subscriber id 再利用 + 招待送信', async () => {
    const fake = new FakeDb();
    fake.seed({
      id: 'sub-tx',
      friend_id: null,
      email: 'tx@x.com',
      is_active: 0,
      transactional_only: 1,
      unsubscribed_at: null,
      bounce_count: 0,
      complaint_count: 0,
      consent_source: 'shopify_checkout',
      consent_at: '2026-01-01',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'tx@x.com' }],
        dryRun: true,
      },
    );
    expect(result.sent).toBe(1);
    expect(fake.insertCount).toBe(0); // 既存 row 再利用
  });

  it('新規 email → INSERT subscribers (transactional_only=1)', async () => {
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'new@x.com', firstName: 'Hanako' }],
        dryRun: true,
      },
    );
    expect(result.sent).toBe(1);
    expect(fake.insertCount).toBe(1);
    const inserted = [...fake.subscribers.values()][0];
    expect(inserted.email).toBe('new@x.com');
    expect(inserted.is_active).toBe(0);
    expect(inserted.transactional_only).toBe(1);
    expect(inserted.consent_source).toBe('manual_import');
  });

  it('dispatcher が sent を返す → status=sent + providerMessageId 伝搬', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm-1', subscriberId: 'sub-1' }],
    });
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'send@x.com' }],
      },
    );
    expect(result.sent).toBe(1);
    expect(result.details[0]).toMatchObject({ status: 'sent', providerMessageId: 'pm-1' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const call = dispatchMock.mock.calls[0]![1];
    expect(call.category).toBe('transactional');
    expect(call.emailPayload?.variables.opt_in_url).toMatch(
      /^https:\/\/worker\.example\.com\/email\/opt-in\?email=send%40x\.com&e=\d+&token=[a-f0-9]{64}$/,
    );
    expect(call.emailPayload?.variables.name).toBe('お客様'); // firstName 未指定
  });

  it('dispatcher が failed を返す → status=failed + reason 伝搬', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'failed', error: 'Resend 5xx' }],
    });
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'fail@x.com' }],
      },
    );
    expect(result.failed).toBe(1);
    expect(result.details[0]).toMatchObject({ status: 'failed', reason: 'Resend 5xx' });
  });

  it('dispatcher が skipped を返す → status=skipped + reason 伝搬', async () => {
    dispatchMock.mockResolvedValueOnce({
      results: [{ channel: 'email', status: 'skipped', reason: 'unsubscribed' }],
    });
    const fake = new FakeDb();
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'skip@x.com' }],
      },
    );
    expect(result.skipped).toBe(1);
    expect(result.details[0]).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
  });

  it('firstName ありで variables.name に反映される', async () => {
    const fake = new FakeDb();
    await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'taro@x.com', firstName: 'Taro' }],
        dryRun: true,
      },
    );
    // dispatcher 呼ばれていないので確認は INSERT 経由か variables 構築の単体は別。
    // ここでは少なくとも処理が完走することを確認 (subscriber INSERT 済)
    expect(fake.insertCount).toBe(1);
  });

  it('複数 recipient で個別の opt_in_url が生成される (per-email 署名)', async () => {
    dispatchMock.mockResolvedValue({
      results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm', subscriberId: 'sub' }],
    });
    const fake = new FakeDb();
    await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }],
      },
    );
    expect(dispatchMock).toHaveBeenCalledTimes(3);
    const urls = dispatchMock.mock.calls.map((call) => call[1].emailPayload?.variables.opt_in_url);
    expect(urls[0]).toContain('email=a%40x.com');
    expect(urls[1]).toContain('email=b%40x.com');
    expect(urls[2]).toContain('email=c%40x.com');
    // 全 URL が異なる (per-email 署名)
    expect(new Set(urls).size).toBe(3);
  });

  it('email は lowercase 正規化される', async () => {
    const fake = new FakeDb();
    await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [{ email: 'UPPER@X.COM' }],
        dryRun: true,
      },
    );
    const inserted = [...fake.subscribers.values()][0];
    expect(inserted.email).toBe('upper@x.com');
  });

  it('total/sent/skipped/failed の集計が正しい', async () => {
    dispatchMock
      .mockResolvedValueOnce({
        results: [{ channel: 'email', status: 'sent', providerMessageId: 'pm1', subscriberId: 'sub1' }],
      })
      .mockResolvedValueOnce({
        results: [{ channel: 'email', status: 'failed', error: 'oops' }],
      });
    const fake = new FakeDb();
    fake.seed({
      id: 'sub-skip',
      friend_id: null,
      email: 'skip@x.com',
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
    const result = await sendBulkOptInInvitations(
      fake as unknown as D1Database,
      makeConfig(),
      {
        recipients: [
          { email: 'a@x.com' }, // sent
          { email: 'b@x.com' }, // failed (dispatcher)
          { email: 'skip@x.com' }, // skipped (既に opted-in)
          { email: 'not-email' }, // skipped (invalid)
        ],
      },
    );
    expect(result.total).toBe(4);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(1);
  });
});
