/**
 * cron atomic claim (CAS) の DB 関数 unit test (Launch-readiness review B6-B8)。
 *
 * 重複 cron / 手動送信が同じ対象を二重送信しないよう、 送信前に claim する。
 * claim は「初めて取れた実行」 だけ changes===1 で true、 既に取られていれば false。
 */

import { describe, it, expect } from 'vitest';
import { claimAbTestForSending, claimReminderStepDelivery } from '@line-crm/db';

type RunResult = { success: boolean; meta: { changes: number } };

function captureDb(changes: number) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        _args: [] as unknown[],
        bind(...a: unknown[]) {
          this._args = a;
          return this;
        },
        async run(): Promise<RunResult> {
          calls.push({ sql, args: this._args });
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('claimAbTestForSending', () => {
  it('changes===1 → true (claim 成功)', async () => {
    const { db } = captureDb(1);
    expect(await claimAbTestForSending(db, 'ab-1')).toBe(true);
  });

  it('changes===0 → false (既に sending/sent)', async () => {
    const { db } = captureDb(0);
    expect(await claimAbTestForSending(db, 'ab-1')).toBe(false);
  });

  it('CAS WHERE は draft|scheduled のみを sending に遷移する', async () => {
    const { db, calls } = captureDb(1);
    await claimAbTestForSending(db, 'ab-1');
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain("SET status = 'sending'");
    expect(sql).toContain("status IN ('draft', 'scheduled')");
  });
});

describe('claimReminderStepDelivery', () => {
  it('初回 (changes===1) → true', async () => {
    const { db } = captureDb(1);
    expect(await claimReminderStepDelivery(db, 'fr-1', 'step-1')).toBe(true);
  });

  it('2回目 (UNIQUE 競合, changes===0) → false', async () => {
    const { db } = captureDb(0);
    expect(await claimReminderStepDelivery(db, 'fr-1', 'step-1')).toBe(false);
  });

  it('INSERT OR IGNORE で friend_reminder_deliveries に入れる', async () => {
    const { db, calls } = captureDb(1);
    await claimReminderStepDelivery(db, 'fr-1', 'step-1');
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('INSERT OR IGNORE INTO friend_reminder_deliveries');
  });
});
