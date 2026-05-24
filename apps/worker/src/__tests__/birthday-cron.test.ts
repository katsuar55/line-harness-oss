/**
 * Tests for birthday-cron.ts (Phase 2.2 雛形、 2026-05-24)
 *
 * カバー範囲:
 *   - gating: 月初 1 日 10:00 JST window のみ実行
 *   - BIRTHDAY_CRON_FORCE='true' で gating bypass
 *   - 候補 0 → skip
 *   - 候補 1+ → push + metadata 既送マーク
 *   - 既送 friend → alreadySent++、 push せず
 *   - push エラー → errors++、 他 friend に影響なし
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processBirthdayGreetings, __test__ } from '../services/birthday-cron.js';
import { auditSystem } from '../services/audit-logger.js';

// auditSystem mock (= 副作用避ける)
vi.mock('../services/audit-logger.js', () => ({
  auditSystem: vi.fn(async () => {}),
}));

interface FakeFriend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  line_account_id: string | null;
  metadata: string | null;
  birth_month: number;
}

class FakeDb {
  public friends: FakeFriend[] = [];
  public updateCalls: Array<{ id: string; metadata: string }> = [];

  prepare(sql: string) {
    const self = this;
    return {
      bind(...args: unknown[]) {
        return {
          async all() {
            // SELECT friends WHERE birth_month = ? AND is_following = 1 AND is_blacklisted = 0
            if (sql.includes('SELECT id, line_user_id')) {
              const month = args[0] as number;
              const results = self.friends.filter((f) => f.birth_month === month);
              return { results, success: true };
            }
            return { results: [], success: true };
          },
          async run() {
            // UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?
            if (sql.includes('UPDATE friends')) {
              const metadata = args[0] as string;
              const id = args[2] as string;
              self.updateCalls.push({ id, metadata });
              const target = self.friends.find((f) => f.id === id);
              if (target) target.metadata = metadata;
            }
            return { success: true };
          },
        };
      },
    } as unknown as D1PreparedStatement;
  }
}

function makeLineClient() {
  return {
    pushMessage: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const TEST_TOKEN = 'test-token';

describe('birthday-cron — gating', () => {
  it('non-1st-day → skipped (skippedDueToGating=true、 candidates 等 0)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    // 2026-06-15 10:00 JST (= 15 日なので gating skip)
    const now = new Date('2026-06-15T01:00:00.000Z'); // UTC、 JST +9 = 10:00
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.skippedDueToGating).toBe(true);
    expect(result.candidates).toBe(0);
    expect(result.sent).toBe(0);
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });

  it('1st-day 09:55 JST → skipped (= 10:00 window 外)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const now = new Date('2026-07-01T00:55:00.000Z'); // JST 09:55
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.skippedDueToGating).toBe(true);
  });

  it('1st-day 10:00 JST → 実行 (= gating pass)', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    // 7 月の場合
    const now = new Date('2026-07-01T01:02:00.000Z'); // JST 10:02
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.skippedDueToGating).toBe(false);
    expect(result.month).toBe(7);
  });

  it('BIRTHDAY_CRON_FORCE=true → gating bypass、 月日関係なく実行', async () => {
    const db = new FakeDb();
    const lc = makeLineClient();
    const now = new Date('2026-06-15T05:00:00.000Z'); // JST 14:00 (= window 外)
    const result = await processBirthdayGreetings(
      {
        DB: db as unknown as D1Database,
        LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN,
        BIRTHDAY_CRON_FORCE: 'true',
      },
      { now, lineClientFactory: () => lc },
    );
    expect(result.skippedDueToGating).toBe(false);
  });
});

describe('birthday-cron — push 挙動', () => {
  it('候補 0 → sent=0、 push 呼ばれない', async () => {
    const db = new FakeDb();
    db.friends = []; // 候補なし
    const lc = makeLineClient();
    const now = new Date('2026-07-01T01:00:00.000Z'); // gating pass
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.candidates).toBe(0);
    expect(result.sent).toBe(0);
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });

  it('候補 1+ → push + metadata 既送マーク', async () => {
    const db = new FakeDb();
    db.friends = [
      {
        id: 'friend-1',
        line_user_id: 'U_abc',
        display_name: '太郎',
        line_account_id: null,
        metadata: null,
        birth_month: 7,
      },
    ];
    const lc = makeLineClient();
    const now = new Date('2026-07-01T01:00:00.000Z');
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.candidates).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.errors).toBe(0);
    expect(lc.pushMessage).toHaveBeenCalledTimes(1);
    const [userId, messages] = lc.pushMessage.mock.calls[0];
    expect(userId).toBe('U_abc');
    expect(messages).toHaveLength(2); // text + flex
    expect((messages as Array<{ type: string }>)[0].type).toBe('text');
    expect((messages as Array<{ type: string }>)[1].type).toBe('flex');

    // metadata 既送マーク確認
    expect(db.updateCalls).toHaveLength(1);
    const updatedMeta = JSON.parse(db.updateCalls[0].metadata);
    expect(updatedMeta['birthday_greeting_sent_2026_07']).toBe(true);
  });

  it('既送 friend (= metadata に該当月 key あり) → alreadySent++、 push せず', async () => {
    const db = new FakeDb();
    db.friends = [
      {
        id: 'friend-already',
        line_user_id: 'U_already',
        display_name: 'たかし',
        line_account_id: null,
        metadata: JSON.stringify({ birthday_greeting_sent_2026_07: true }),
        birth_month: 7,
      },
    ];
    const lc = makeLineClient();
    const now = new Date('2026-07-01T01:00:00.000Z');
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.alreadySent).toBe(1);
    expect(result.sent).toBe(0);
    expect(lc.pushMessage).not.toHaveBeenCalled();
  });

  it('push エラー → errors++、 他 friend に影響なし', async () => {
    const db = new FakeDb();
    db.friends = [
      { id: 'friend-ok', line_user_id: 'U_ok', display_name: 'OK', line_account_id: null, metadata: null, birth_month: 7 },
      { id: 'friend-fail', line_user_id: 'U_fail', display_name: 'NG', line_account_id: null, metadata: null, birth_month: 7 },
      { id: 'friend-ok2', line_user_id: 'U_ok2', display_name: 'OK2', line_account_id: null, metadata: null, birth_month: 7 },
    ];
    const lc = makeLineClient();
    lc.pushMessage.mockImplementation(async (userId: string) => {
      if (userId === 'U_fail') throw new Error('LINE API down');
    });
    const now = new Date('2026-07-01T01:00:00.000Z');
    const result = await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    expect(result.candidates).toBe(3);
    expect(result.sent).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.alreadySent).toBe(0);
    expect(lc.pushMessage).toHaveBeenCalledTimes(3);
  });

  it('display_name=null → 「お客様」 fallback', async () => {
    const db = new FakeDb();
    db.friends = [
      { id: 'friend-null', line_user_id: 'U_x', display_name: null, line_account_id: null, metadata: null, birth_month: 7 },
    ];
    const lc = makeLineClient();
    const now = new Date('2026-07-01T01:00:00.000Z');
    await processBirthdayGreetings(
      { DB: db as unknown as D1Database, LINE_CHANNEL_ACCESS_TOKEN: TEST_TOKEN },
      { now, lineClientFactory: () => lc },
    );
    const [, messages] = lc.pushMessage.mock.calls[0];
    const text = (messages as Array<{ type: string; text?: string }>)[0].text ?? '';
    expect(text).toContain('お客様');
  });
});

describe('birthday-cron — helpers', () => {
  it('parseMetadata: null → {}', () => {
    expect(__test__.parseMetadata(null)).toEqual({});
  });

  it('parseMetadata: 不正 JSON → {}', () => {
    expect(__test__.parseMetadata('not-json')).toEqual({});
  });

  it('parseMetadata: array → {} (= object のみ受付)', () => {
    expect(__test__.parseMetadata('[1, 2, 3]')).toEqual({});
  });

  it('parseMetadata: valid object → そのまま', () => {
    expect(__test__.parseMetadata('{"foo":"bar"}')).toEqual({ foo: 'bar' });
  });

  it('buildBirthdaySpecialFlex: 構造 sanity', () => {
    const flex = __test__.buildBirthdaySpecialFlex('テスト', 7);
    const json = JSON.stringify(flex);
    expect(json).toContain('お誕生月');
    expect(json).toContain('テスト');
    expect(json).toContain('7月');
    expect(json).toContain('naturism-diet.com');
  });
});
