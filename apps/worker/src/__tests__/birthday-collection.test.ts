/**
 * Tests for birthday-collection (誕生月再収集シナリオ).
 *
 * Covers:
 *   - parseBirthdayMonthPostback() — postback data の妥当性検証
 *   - buildBirthdayCollectionMessage() — Quick Reply 12個 (1月〜12月)
 *   - buildBirthdayThanksText() — お礼メッセージ
 *   - setFriendMetadataField() — friends.metadata JSON 部分更新 (新規/上書き/削除)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  BIRTHDAY_METADATA_KEY,
  buildBirthdayCollectionMessage,
  buildBirthdayThanksText,
  parseBirthdayMonthPostback,
} from '../services/birthday-collection.js';
import { setFriendMetadataField } from '@line-crm/db';

describe('parseBirthdayMonthPostback', () => {
  it('returns 1-12 for valid month', () => {
    expect(parseBirthdayMonthPostback('action=birthday_month&month=1')).toBe(1);
    expect(parseBirthdayMonthPostback('action=birthday_month&month=6')).toBe(6);
    expect(parseBirthdayMonthPostback('action=birthday_month&month=12')).toBe(12);
  });

  it('returns null for wrong action', () => {
    expect(parseBirthdayMonthPostback('action=daily_tip')).toBeNull();
    expect(parseBirthdayMonthPostback('action=other&month=5')).toBeNull();
  });

  it('returns null for missing month', () => {
    expect(parseBirthdayMonthPostback('action=birthday_month')).toBeNull();
  });

  it('returns null for out-of-range month', () => {
    expect(parseBirthdayMonthPostback('action=birthday_month&month=0')).toBeNull();
    expect(parseBirthdayMonthPostback('action=birthday_month&month=13')).toBeNull();
    expect(parseBirthdayMonthPostback('action=birthday_month&month=-1')).toBeNull();
  });

  it('returns null for non-integer month', () => {
    expect(parseBirthdayMonthPostback('action=birthday_month&month=abc')).toBeNull();
    expect(parseBirthdayMonthPostback('action=birthday_month&month=1.5')).toBeNull();
    expect(parseBirthdayMonthPostback('action=birthday_month&month=')).toBeNull();
  });
});

describe('buildBirthdayCollectionMessage', () => {
  it('attaches Quick Reply with 12 month buttons', () => {
    const msg = buildBirthdayCollectionMessage();
    expect(msg.type).toBe('text');
    expect(msg.quickReply.items).toHaveLength(12);

    msg.quickReply.items.forEach((item, i) => {
      expect(item.type).toBe('action');
      const month = i + 1;
      expect(item.action).toMatchObject({
        type: 'postback',
        label: `${month}月`,
        data: `action=birthday_month&month=${month}`,
      });
    });
  });

  it('uses default prompt text when no customText is supplied', () => {
    const msg = buildBirthdayCollectionMessage();
    expect(msg.text).toContain('誕生月');
    expect(msg.text).toContain('naturism');
  });

  it('uses customText when supplied', () => {
    const msg = buildBirthdayCollectionMessage('お誕生月教えてね!');
    expect(msg.text).toBe('お誕生月教えてね!');
  });
});

describe('buildBirthdayThanksText', () => {
  it('includes the month number', () => {
    expect(buildBirthdayThanksText(5)).toContain('5月');
    expect(buildBirthdayThanksText(12)).toContain('12月');
  });

  it('thanks the user', () => {
    expect(buildBirthdayThanksText(7)).toContain('ありがとうございます');
  });
});

describe('BIRTHDAY_METADATA_KEY', () => {
  it('is the stable key "birth_month"', () => {
    expect(BIRTHDAY_METADATA_KEY).toBe('birth_month');
  });
});

describe('setFriendMetadataField (integration with mock D1)', () => {
  function buildMockDb(initialMetadata: string | null) {
    const updates: Array<{ metadata: string }> = [];
    const first = vi.fn().mockResolvedValue(
      initialMetadata !== null ? { metadata: initialMetadata } : null,
    );
    const run = vi.fn().mockResolvedValue({});
    const bind = vi.fn();

    bind.mockImplementation(function (this: unknown, ...args: unknown[]) {
      const sql = (this as { _sql?: string })._sql ?? '';
      if (sql.startsWith('UPDATE')) {
        updates.push({ metadata: args[0] as string });
      }
      return { first, run, all: vi.fn() };
    });

    const prepare = vi.fn().mockImplementation((sql: string) => {
      const ctx = { _sql: sql };
      return {
        bind: bind.bind(ctx),
      };
    });

    return { db: { prepare } as unknown as D1Database, updates };
  }

  it('creates new metadata object when row has no metadata', async () => {
    const { db, updates } = buildMockDb(null);
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '7');
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].metadata)).toEqual({ birth_month: '7' });
  });

  it('merges into existing metadata JSON', async () => {
    const { db, updates } = buildMockDb('{"foo":"bar"}');
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '5');
    expect(JSON.parse(updates[0].metadata)).toEqual({ foo: 'bar', birth_month: '5' });
  });

  it('overwrites existing key', async () => {
    const { db, updates } = buildMockDb('{"birth_month":"1"}');
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '12');
    expect(JSON.parse(updates[0].metadata)).toEqual({ birth_month: '12' });
  });

  it('deletes the key when value is empty string', async () => {
    const { db, updates } = buildMockDb('{"birth_month":"3","other":"keep"}');
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '');
    expect(JSON.parse(updates[0].metadata)).toEqual({ other: 'keep' });
  });

  it('recovers gracefully from invalid JSON metadata', async () => {
    const { db, updates } = buildMockDb('not-json');
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '8');
    expect(JSON.parse(updates[0].metadata)).toEqual({ birth_month: '8' });
  });

  it('treats array-shaped JSON as empty object (defensive)', async () => {
    const { db, updates } = buildMockDb('[1,2,3]');
    await setFriendMetadataField(db, 'friend-1', 'birth_month', '4');
    expect(JSON.parse(updates[0].metadata)).toEqual({ birth_month: '4' });
  });
});
