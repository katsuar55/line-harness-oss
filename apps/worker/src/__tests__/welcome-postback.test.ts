/**
 * Tests for welcome-postback service (Phase 1 ULTRATHINK MVP、 2026-05-24)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWelcomeBirthdayPostback,
  parseWelcomeAgeGroupPostback,
  isWelcomePostback,
  handleWelcomeBirthday,
  handleWelcomeAgeGroup,
  handleWelcomeIntroStep,
  buildBirthdayAskFlex,
  buildAgeGroupAskFlex,
} from '../services/welcome-postback.js';
import type { LineClient } from '@line-crm/line-sdk';

const FRIEND_ID = '38215b51-9c9c-4f8d-a6ae-94c9fcd071a0';
const LINE_USER_ID = 'U7e2822a8d8cba751f5340e1c9fe13111';

interface AuditRow {
  action: string;
  result: string;
  target_id: string;
}

class FakeDb {
  updateCalls: Array<{ sql: string; params: unknown[] }> = [];
  auditRows: AuditRow[] = [];
  prepareThrows = false;

  prepare(sql: string) {
    if (this.prepareThrows) throw new Error('D1 down');
    const isUpdateFriends = /UPDATE friends SET/i.test(sql);
    const isInsertAudit = /INSERT INTO audit_logs/i.test(sql);
    return {
      bind: (...params: unknown[]) => ({
        first: async () => null,
        run: async () => {
          if (isUpdateFriends) {
            this.updateCalls.push({ sql, params });
          }
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

describe('parseWelcomeBirthdayPostback', () => {
  it.each([
    ['welcome_birthday:1', 1],
    ['welcome_birthday:6', 6],
    ['welcome_birthday:12', 12],
  ])('valid: %s → %d', (data, expected) => {
    expect(parseWelcomeBirthdayPostback(data)).toBe(expected);
  });

  it.each([
    'welcome_birthday:0',
    'welcome_birthday:13',
    'welcome_birthday:abc',
    'welcome_birthday:',
    'welcome_birthday',
    'birthday:5',
    'welcome_birthday:1;DROP TABLE',
  ])('invalid: %s → null', (data) => {
    expect(parseWelcomeBirthdayPostback(data)).toBeNull();
  });
});

describe('parseWelcomeAgeGroupPostback', () => {
  it.each([
    ['welcome_age_group:10s', '10s'],
    ['welcome_age_group:30s', '30s'],
    ['welcome_age_group:70+', '70+'],
  ])('valid: %s → %s', (data, expected) => {
    expect(parseWelcomeAgeGroupPostback(data)).toBe(expected);
  });

  it.each([
    'welcome_age_group:5s',
    'welcome_age_group:80s',
    'welcome_age_group:young',
    'welcome_age_group:',
    'age_group:30s',
    'welcome_age_group:30s;DROP',
  ])('invalid: %s → null', (data) => {
    expect(parseWelcomeAgeGroupPostback(data)).toBeNull();
  });
});

describe('isWelcomePostback', () => {
  it.each([
    ['welcome_intro_step', true],
    ['welcome_birthday:5', true],
    ['welcome_age_group:30s', true],
    ['birthday_month', false],
    ['action=foo', false],
    ['', false],
  ])('%s → %s', (data, expected) => {
    expect(isWelcomePostback(data)).toBe(expected);
  });
});

describe('buildBirthdayAskFlex / buildAgeGroupAskFlex', () => {
  it('birthday flex contains 12 month buttons', () => {
    const flex = buildBirthdayAskFlex() as unknown as {
      body: { contents: Array<{ contents?: Array<{ action?: { data?: string } }> }> };
    };
    const allButtons = flex.body.contents
      .flatMap((row) => row.contents ?? [])
      .filter((c) => c.action?.data?.startsWith('welcome_birthday:'));
    expect(allButtons.length).toBe(12);
    for (let m = 1; m <= 12; m++) {
      expect(allButtons.some((b) => b.action?.data === `welcome_birthday:${m}`)).toBe(true);
    }
  });

  it('age_group flex contains 7 age buttons (10s..70+)', () => {
    const flex = buildAgeGroupAskFlex() as unknown as {
      body: { contents: Array<{ contents?: Array<{ action?: { data?: string } }> }> };
    };
    const allButtons = flex.body.contents
      .flatMap((row) => row.contents ?? [])
      .filter((c) => c.action?.data?.startsWith('welcome_age_group:'));
    expect(allButtons.length).toBe(7);
    const expected = ['10s', '20s', '30s', '40s', '50s', '60s', '70+'];
    for (const age of expected) {
      expect(allButtons.some((b) => b.action?.data === `welcome_age_group:${age}`)).toBe(true);
    }
  });
});

describe('handleWelcomeIntroStep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('push birthday flex + audit', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    await handleWelcomeIntroStep(db as unknown as D1Database, lc, FRIEND_ID, LINE_USER_ID, null);
    expect(lc.pushMessage).toHaveBeenCalledTimes(1);
    expect(lc.pushMessage).toHaveBeenCalledWith(
      LINE_USER_ID,
      expect.arrayContaining([expect.objectContaining({ type: 'flex' })]),
    );
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('welcome_postback.intro_step');
    expect(db.auditRows[0].target_id).toBe(FRIEND_ID);
  });
});

describe('handleWelcomeBirthday', () => {
  beforeEach(() => vi.clearAllMocks());

  it('valid postback → UPDATE birth_month + push age_group flex + audit success', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleWelcomeBirthday(
      db as unknown as D1Database,
      lc,
      FRIEND_ID,
      LINE_USER_ID,
      null,
      'welcome_birthday:7',
    );
    expect(result.ok).toBe(true);
    expect(result.month).toBe(7);
    expect(db.updateCalls).toHaveLength(1);
    expect(db.updateCalls[0].params[0]).toBe(7);
    expect(db.updateCalls[0].params[2]).toBe(FRIEND_ID);
    expect(lc.pushMessage).toHaveBeenCalledTimes(1);
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('friend.demographic_collected');
  });

  it('invalid postback → no UPDATE, audit failure', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleWelcomeBirthday(
      db as unknown as D1Database,
      lc,
      FRIEND_ID,
      LINE_USER_ID,
      null,
      'welcome_birthday:99',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_format');
    expect(db.updateCalls).toHaveLength(0);
    expect(lc.pushMessage).not.toHaveBeenCalled();
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('welcome_postback.birthday_invalid');
    expect(db.auditRows[0].result).toBe('failure');
  });
});

describe('handleWelcomeAgeGroup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('valid postback → UPDATE age_group + reply thank you + audit success', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleWelcomeAgeGroup(
      db as unknown as D1Database,
      lc,
      FRIEND_ID,
      null,
      'reply-token-xxx',
      'welcome_age_group:30s',
    );
    expect(result.ok).toBe(true);
    expect(result.ageGroup).toBe('30s');
    expect(db.updateCalls).toHaveLength(1);
    expect(db.updateCalls[0].params[0]).toBe('30s');
    expect(lc.replyMessage).toHaveBeenCalledTimes(1);
    expect(lc.replyMessage).toHaveBeenCalledWith(
      'reply-token-xxx',
      expect.arrayContaining([expect.objectContaining({ type: 'text' })]),
    );
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('friend.demographic_collected');
  });

  it('invalid postback → no UPDATE, no reply, audit failure', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleWelcomeAgeGroup(
      db as unknown as D1Database,
      lc,
      FRIEND_ID,
      null,
      'reply-token-xxx',
      'welcome_age_group:young',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_format');
    expect(db.updateCalls).toHaveLength(0);
    expect(lc.replyMessage).not.toHaveBeenCalled();
    expect(db.auditRows).toHaveLength(1);
    expect(db.auditRows[0].action).toBe('welcome_postback.age_group_invalid');
  });

  it('70+ (= 上限) も valid', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const result = await handleWelcomeAgeGroup(
      db as unknown as D1Database,
      lc,
      FRIEND_ID,
      null,
      'reply-token',
      'welcome_age_group:70+',
    );
    expect(result.ok).toBe(true);
    expect(result.ageGroup).toBe('70+');
  });
});
