/**
 * Tests for monthly-broadcast-postback service (Phase 2.1、 2026-05-24)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseMonthlyDetailPostback,
  isMonthlyBroadcastPostback,
  getMonthlyDetailMessages,
  handleMonthlyDetail,
} from '../services/monthly-broadcast-postback.js';
import type { LineClient } from '@line-crm/line-sdk';

const FRIEND_ID = '38215b51-9c9c-4f8d-a6ae-94c9fcd071a0';

interface AuditRow {
  action: string;
  result: string;
  target_id: string;
}

class FakeDb {
  auditRows: AuditRow[] = [];
  prepare(_sql: string) {
    const isInsertAudit = /INSERT INTO audit_logs/i.test(_sql);
    return {
      bind: (...params: unknown[]) => ({
        first: async () => null,
        run: async () => {
          if (isInsertAudit) {
            this.auditRows.push({
              action: params[5] as string,
              result: params[13] as string,
              target_id: params[7] as string,
            });
          }
          return { success: true, meta: { changes: 1 } };
        },
      }),
    };
  }
}

function makeLineClient() {
  return {
    pushMessage: vi.fn().mockResolvedValue(undefined),
    replyMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as LineClient & {
    pushMessage: ReturnType<typeof vi.fn>;
    replyMessage: ReturnType<typeof vi.fn>;
  };
}

describe('parseMonthlyDetailPostback', () => {
  it.each([
    ['monthly_detail:1', 1],
    ['monthly_detail:6', 6],
    ['monthly_detail:12', 12],
  ])('valid: %s → %d', (data, expected) => {
    expect(parseMonthlyDetailPostback(data)).toBe(expected);
  });

  it.each([
    'monthly_detail:0',
    'monthly_detail:13',
    'monthly_detail:abc',
    'monthly_detail:',
    'monthly_detail',
    'detail:6',
    'monthly_detail:6;DROP',
  ])('invalid: %s → null', (data) => {
    expect(parseMonthlyDetailPostback(data)).toBeNull();
  });
});

describe('isMonthlyBroadcastPostback', () => {
  it.each([
    ['monthly_detail:6', true],
    ['monthly_detail:12', true],
    ['monthly_detail:0', true], // prefix match のみ、 validation は parse 側
    ['welcome_intro_step', false],
    ['birthday_month', false],
    ['', false],
  ])('%s → %s', (data, expected) => {
    expect(isMonthlyBroadcastPostback(data)).toBe(expected);
  });
});

describe('getMonthlyDetailMessages', () => {
  it('6 月 → 5 message (= text + 4 flex)', () => {
    const messages = getMonthlyDetailMessages(6, 'テストユーザー');
    expect(messages).toHaveLength(5);
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('テストユーザー') });
    expect(messages[1].type).toBe('flex');
    expect(messages[2].type).toBe('flex');
    expect(messages[3].type).toBe('flex');
    expect(messages[4].type).toBe('flex');
  });

  it('6 月 alt_text に「梅雨」 「Pink」 「紹介」 「お気軽」 を含む', () => {
    const messages = getMonthlyDetailMessages(6, 'X');
    const altTexts = messages
      .filter((m): m is Extract<typeof m, { type: 'flex' }> => m.type === 'flex')
      .map((m) => m.altText);
    expect(altTexts.join(' ')).toMatch(/梅雨/);
    expect(altTexts.join(' ')).toMatch(/Pink/);
    expect(altTexts.join(' ')).toMatch(/紹介/);
  });

  it('7 月 (= Phase 2.2、 夏本番 / BBQ / Blue 強化) → 5 message (= text + 4 flex)', () => {
    const messages = getMonthlyDetailMessages(7, 'テスト夏太郎');
    expect(messages).toHaveLength(5);
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('テスト夏太郎') });
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('夏本番') });
    expect(messages[1].type).toBe('flex');
    expect(messages[2].type).toBe('flex');
    expect(messages[3].type).toBe('flex');
    expect(messages[4].type).toBe('flex');
  });

  it('7 月 alt_text に「夏」 「Blue」 「キャンペーン」 を含む', () => {
    const messages = getMonthlyDetailMessages(7, 'X');
    const altTexts = messages
      .filter((m): m is Extract<typeof m, { type: 'flex' }> => m.type === 'flex')
      .map((m) => m.altText);
    expect(altTexts.join(' ')).toMatch(/夏/);
    expect(altTexts.join(' ')).toMatch(/Blue/);
    expect(altTexts.join(' ')).toMatch(/キャンペーン/);
  });

  it('8 月 (= Phase 2.2 PR #74、 お盆 / 夏バテ / Pink 強化) → 5 message', () => {
    const messages = getMonthlyDetailMessages(8, 'テスト盆太郎');
    expect(messages).toHaveLength(5);
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('テスト盆太郎') });
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('お盆') });
    expect(messages[1].type).toBe('flex');
    expect(messages[2].type).toBe('flex');
    expect(messages[3].type).toBe('flex');
    expect(messages[4].type).toBe('flex');
  });

  it('8 月 alt_text に「夏バテ」 「Pink」 「お盆」 を含む', () => {
    const messages = getMonthlyDetailMessages(8, 'X');
    const altTexts = messages
      .filter((m): m is Extract<typeof m, { type: 'flex' }> => m.type === 'flex')
      .map((m) => m.altText);
    expect(altTexts.join(' ')).toMatch(/夏バテ/);
    expect(altTexts.join(' ')).toMatch(/Pink/);
    expect(altTexts.join(' ')).toMatch(/お盆/);
  });

  it('9 月 (= Phase 2.2 PR #74、 秋 / 食欲の秋 / Blue vs Pink 使い分け / 再購入) → 5 message', () => {
    const messages = getMonthlyDetailMessages(9, 'テスト秋子');
    expect(messages).toHaveLength(5);
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('テスト秋子') });
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('秋') });
    expect(messages[1].type).toBe('flex');
    expect(messages[2].type).toBe('flex');
    expect(messages[3].type).toBe('flex');
    expect(messages[4].type).toBe('flex');
  });

  it('9 月 alt_text に「秋」 「Blue」 「Pink」 「再購入」 を含む', () => {
    const messages = getMonthlyDetailMessages(9, 'X');
    const altTexts = messages
      .filter((m): m is Extract<typeof m, { type: 'flex' }> => m.type === 'flex')
      .map((m) => m.altText);
    expect(altTexts.join(' ')).toMatch(/秋/);
    expect(altTexts.join(' ')).toMatch(/Blue/);
    expect(altTexts.join(' ')).toMatch(/Pink/);
    expect(altTexts.join(' ')).toMatch(/再購入/);
  });

  it('10 月以降 (= 未実装) は placeholder text のみ 1 件', () => {
    const messages = getMonthlyDetailMessages(10, 'A');
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('10 月') });
  });

  it('display_name null → fallback (= 「お客様」 文字列を返す側で対応、 直接呼出時は呼出側担当)', () => {
    const messages = getMonthlyDetailMessages(6, 'お客様');
    expect(messages[0].type).toBe('text');
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('お客様') });
  });
});

describe('handleMonthlyDetail', () => {
  beforeEach(() => vi.clearAllMocks());

  it('valid 6 月 → reply 5 message + audit success (cost zero)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: '加藤勝久' },
      null,
      'reply-token-monthly',
      'monthly_detail:6',
    );
    expect(result.ok).toBe(true);
    expect(result.month).toBe(6);
    expect(lc.replyMessage).toHaveBeenCalledTimes(1);
    expect(lc.pushMessage).not.toHaveBeenCalled();
    const [token, messages] = lc.replyMessage.mock.calls[0];
    expect(token).toBe('reply-token-monthly');
    expect(messages).toHaveLength(5);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('monthly_postback.detail_sent');
    expect(db.auditRows[0].result).toBe('success');
  });

  it('valid 7 月 → reply 5 messages (= Phase 2.2 拡充済)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: 'X' },
      null,
      'reply-token',
      'monthly_detail:7',
    );
    expect(result.ok).toBe(true);
    const [, messages] = lc.replyMessage.mock.calls[0];
    expect(messages).toHaveLength(5);
  });

  it('valid 8 月 → reply 5 messages (= Phase 2.2 PR #74 で拡充済)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: 'X' },
      null,
      'reply-token',
      'monthly_detail:8',
    );
    expect(result.ok).toBe(true);
    const [, messages] = lc.replyMessage.mock.calls[0];
    expect(messages).toHaveLength(5);
  });

  it('valid 9 月 → reply 5 messages (= Phase 2.2 PR #74 で拡充済)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: 'X' },
      null,
      'reply-token',
      'monthly_detail:9',
    );
    expect(result.ok).toBe(true);
    const [, messages] = lc.replyMessage.mock.calls[0];
    expect(messages).toHaveLength(5);
  });

  it('valid 10 月 → reply 1 message (= 未実装 placeholder)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: 'X' },
      null,
      'reply-token',
      'monthly_detail:10',
    );
    expect(result.ok).toBe(true);
    const [, messages] = lc.replyMessage.mock.calls[0];
    expect(messages).toHaveLength(1);
  });

  it('display_name null → 「お客様」 fallback', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: null },
      null,
      'reply-token-null',
      'monthly_detail:6',
    );
    const [, messages] = lc.replyMessage.mock.calls[0];
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('お客様') });
  });

  it('invalid postback → no reply, audit failure', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleMonthlyDetail(
      db as unknown as D1Database,
      lc,
      { id: FRIEND_ID, display_name: 'A' },
      null,
      'reply-token-invalid',
      'monthly_detail:99',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_format');
    expect(lc.replyMessage).not.toHaveBeenCalled();
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('monthly_postback.detail_invalid');
    expect(db.auditRows[0].result).toBe('failure');
  });
});
