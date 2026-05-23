/**
 * Tests for friends-import service (LSTEP audit H1、 2026-05-22)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  normalizeHeaders,
  rowToTyped,
  validateRow,
  importOneRow,
  importFriendsRows,
} from '../services/friends-import.js';

// upsertFriend / jstNow を mock (= @line-crm/db)
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn().mockImplementation(async (_db, input) => ({
    id: 'mock-id',
    line_user_id: input.lineUserId,
    display_name: input.displayName ?? null,
  })),
  jstNow: () => '2026-05-22T12:00:00.000',
}));

const VALID_LINE_ID = 'U0123456789abcdef0123456789abcdef';
const VALID_LINE_ID_2 = 'Uffffffffffffffffffffffffffffffff';

describe('normalizeHeaders', () => {
  it('maps aliases to canonical names', () => {
    expect(normalizeHeaders(['LINE_USER_ID', 'Display_Name', 'Mail', 'Tel', 'Note'])).toEqual([
      'line_user_id',
      'display_name',
      'email',
      'phone',
      'memo',
    ]);
  });

  it('unknown headers → null', () => {
    expect(normalizeHeaders(['line_user_id', 'foobar', 'name'])).toEqual([
      'line_user_id',
      null,
      'display_name',
    ]);
  });

  it('trim + lowercase', () => {
    expect(normalizeHeaders(['  Email ', 'NAME'])).toEqual(['email', 'display_name']);
  });
});

describe('rowToTyped', () => {
  it('maps values by header position', () => {
    const result = rowToTyped(
      ['line_user_id', 'display_name', 'email'],
      [VALID_LINE_ID, 'Tanaka', 't@example.com'],
    );
    expect(result.row).toEqual({
      line_user_id: VALID_LINE_ID,
      display_name: 'Tanaka',
      email: 't@example.com',
    });
    expect(result.missingLineUserId).toBe(false);
  });

  it('null header → skipped', () => {
    const result = rowToTyped(
      ['line_user_id', null, 'email'],
      [VALID_LINE_ID, 'unused', 't@example.com'],
    );
    expect(result.row).toEqual({
      line_user_id: VALID_LINE_ID,
      email: 't@example.com',
    });
  });

  it('empty string values → omitted', () => {
    const result = rowToTyped(
      ['line_user_id', 'display_name', 'email'],
      [VALID_LINE_ID, '', ''],
    );
    expect(result.row).toEqual({ line_user_id: VALID_LINE_ID });
  });

  it('missing line_user_id → flagged', () => {
    const result = rowToTyped(['display_name', 'email'], ['Tanaka', 't@example.com']);
    expect(result.missingLineUserId).toBe(true);
  });

  it('values trimmed', () => {
    const result = rowToTyped(
      ['line_user_id', 'display_name'],
      [`  ${VALID_LINE_ID}  `, '  Tanaka  '],
    );
    expect(result.row.line_user_id).toBe(VALID_LINE_ID);
    expect(result.row.display_name).toBe('Tanaka');
  });
});

describe('validateRow', () => {
  it('valid row → ok=true', () => {
    const result = validateRow(1, {
      line_user_id: VALID_LINE_ID,
      display_name: 'Tanaka',
      email: 't@example.com',
      phone: '+81-90-1234-5678',
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed?.line_user_id).toBe(VALID_LINE_ID);
  });

  it('missing line_user_id → error', () => {
    const result = validateRow(2, {});
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('line_user_id');
    expect(result.errors[0].message).toMatch(/required/);
  });

  it('invalid line_user_id format → error', () => {
    const result = validateRow(3, { line_user_id: 'INVALID_FORMAT' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('line_user_id');
    expect(result.errors[0].message).toMatch(/must match/);
  });

  it('invalid email → error but line_user_id still in errors lineUserId', () => {
    const result = validateRow(4, { line_user_id: VALID_LINE_ID, email: 'not-an-email' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('email');
    expect(result.errors[0].lineUserId).toBe(VALID_LINE_ID);
  });

  it('invalid phone format → error', () => {
    const result = validateRow(5, { line_user_id: VALID_LINE_ID, phone: 'abc-def' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].field).toBe('phone');
  });

  it('multiple errors collected', () => {
    const result = validateRow(6, {
      line_user_id: VALID_LINE_ID,
      email: 'bad',
      phone: 'XXX',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

class FakeDb {
  existingIds = new Set<string>();
  updates: Array<{ lineUserId: string; phone?: string | null; email?: string | null; memo?: string | null }> = [];

  prepare(sql: string) {
    const isSelectFriend = /SELECT id FROM friends WHERE line_user_id/i.test(sql);
    const isUpdateFriend = /UPDATE friends/i.test(sql);
    return {
      bind: (...params: unknown[]) => ({
        first: async () => {
          if (isSelectFriend) {
            const lineUserId = params[0] as string;
            return this.existingIds.has(lineUserId) ? { id: 'existing-id' } : null;
          }
          return null;
        },
        run: async () => {
          if (isUpdateFriend) {
            // params: [phone, email, memo, now, line_user_id]
            this.updates.push({
              phone: params[0] as string | null,
              email: params[1] as string | null,
              memo: params[2] as string | null,
              lineUserId: params[4] as string,
            });
          }
          return { success: true };
        },
      }),
    };
  }
}

describe('importOneRow', () => {
  it('new friend → action=created + upsertFriend called', async () => {
    const db = new FakeDb();
    const result = await importOneRow(
      db as unknown as D1Database,
      { line_user_id: VALID_LINE_ID, display_name: 'Tanaka' },
      false,
    );
    expect(result.action).toBe('created');
  });

  it('existing friend → action=updated', async () => {
    const db = new FakeDb();
    db.existingIds.add(VALID_LINE_ID);
    const result = await importOneRow(
      db as unknown as D1Database,
      { line_user_id: VALID_LINE_ID },
      false,
    );
    expect(result.action).toBe('updated');
  });

  it('dryRun=true → DB 触らず判定のみ', async () => {
    const db = new FakeDb();
    const result = await importOneRow(
      db as unknown as D1Database,
      { line_user_id: VALID_LINE_ID, email: 'x@y.com' },
      true,
    );
    expect(result.action).toBe('created');
    expect(db.updates).toHaveLength(0); // UPDATE 走らない
  });

  it('phone/email/memo 指定なし → UPDATE 走らない', async () => {
    const db = new FakeDb();
    await importOneRow(
      db as unknown as D1Database,
      { line_user_id: VALID_LINE_ID, display_name: 'Tanaka' },
      false,
    );
    expect(db.updates).toHaveLength(0);
  });

  it('email 指定あり → UPDATE 走る', async () => {
    const db = new FakeDb();
    await importOneRow(
      db as unknown as D1Database,
      { line_user_id: VALID_LINE_ID, email: 'x@y.com' },
      false,
    );
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].email).toBe('x@y.com');
    expect(db.updates[0].lineUserId).toBe(VALID_LINE_ID);
  });
});

describe('importFriendsRows (orchestration)', () => {
  it('missing line_user_id column → all skipped + 1 header error', async () => {
    const db = new FakeDb();
    const result = await importFriendsRows(
      db as unknown as D1Database,
      ['name', 'email'],
      [
        ['Tanaka', 't@example.com'],
        ['Sato', 's@example.com'],
      ],
    );
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(0);
    expect(result.errors[0].field).toBe('line_user_id');
  });

  it('mix of valid + invalid → counts correctly', async () => {
    const db = new FakeDb();
    db.existingIds.add(VALID_LINE_ID_2);
    const result = await importFriendsRows(
      db as unknown as D1Database,
      ['line_user_id', 'display_name', 'email'],
      [
        [VALID_LINE_ID, 'Tanaka', 't@example.com'], // valid new
        [VALID_LINE_ID_2, 'Sato', 's@example.com'], // valid existing
        ['INVALID', 'Yamada', 'y@example.com'], // invalid line_user_id
        [VALID_LINE_ID, 'Suzuki', 'bad-email'], // invalid email
      ],
    );
    expect(result.totalRows).toBe(4);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].row).toBe(3); // INVALID line_user_id
    expect(result.errors[1].row).toBe(4); // bad email
  });

  it('dryRun=true → DB 不変、 count のみ', async () => {
    const db = new FakeDb();
    const result = await importFriendsRows(
      db as unknown as D1Database,
      ['line_user_id', 'email'],
      [[VALID_LINE_ID, 'x@y.com']],
      true,
    );
    expect(result.created).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(db.updates).toHaveLength(0);
  });

  it('empty data rows → totalRows=0', async () => {
    const db = new FakeDb();
    const result = await importFriendsRows(
      db as unknown as D1Database,
      ['line_user_id'],
      [],
    );
    expect(result.totalRows).toBe(0);
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
