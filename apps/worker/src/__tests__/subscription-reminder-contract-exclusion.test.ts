/**
 * 再購入リマインダーの「稼働契約者 除外」ガード (2026-08-18)。
 *
 * 背景: この cron は単発購入者への再購入促しだが、除外が無く、稼働中の定期便契約を
 *   持つ友だちにも「ワンタッチで再注文」を push していた (本番実測 — 30 日周期の
 *   リマインダーが 100 日周期の稼働契約者へ着弾。実顧客への誤送信はゼロで、
 *   届いたのはテスト行を持つ owner 1 名のみ)。定期便と二重の単発注文を促す形になる。
 *
 * fake DB では SQL 述語を検証できない (fake がガードの代わりに守ってしまう) ため、
 * 実 SQLite に schema.sql を流して **SELECT の NOT EXISTS そのもの**を観測点にする。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';
import { processSubscriptionReminders } from '../services/subscription-reminder.js';

// LINE 送信だけを偽物にする (それ以外は実 SQLite に対する実コード)
const pushMessage = vi.fn(async (_to: string, _messages: unknown[]) => ({}));
const lineClient = { pushMessage } as never;

const PAST = '2026-08-01T00:00:00.000Z';

function seed(db: SqliteDatabase, opts: { contractState: 'active' | 'cancelled' | 'none' }): void {
  db.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
           VALUES ('F1', 'U_SUB', 'Subscriber', 1, '${PAST}', '${PAST}')`);
  db.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
           VALUES ('F2', 'U_ONESHOT', 'OneShot', 1, '${PAST}', '${PAST}')`);
  db.exec(`UPDATE friends SET shopify_customer_id='SC1' WHERE id='F1'`);
  db.exec(`UPDATE friends SET shopify_customer_id='SC2' WHERE id='F2'`);

  for (const f of ['F1', 'F2']) {
    db.exec(`INSERT INTO subscription_reminders
               (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
             VALUES ('R-${f}', '${f}', 'naturism Pink', 30, '${PAST}', 1, '${PAST}', '${PAST}')`);
  }

  if (opts.contractState !== 'none') {
    const cancelled = opts.contractState === 'cancelled' ? `'${PAST}'` : 'NULL';
    db.exec(`INSERT INTO subscription_contracts (contract_id, shopify_customer_id, cancelled_at, created_at, updated_at)
             VALUES ('C1', 'SC1', ${cancelled}, '${PAST}', '${PAST}')`);
  }
}

describe('再購入リマインダー — 稼働契約者の除外 (実 SQLite で述語を検証)', () => {
  beforeEach(() => {
    pushMessage.mockClear();
  });

  it('稼働契約を持つ友だちには送らず、持たない友だちには送る', async () => {
    const raw = createSchemaDb();
    seed(raw, { contractState: 'active' });

    const metrics = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    // F1 (稼働契約あり) は due にすら含まれない = LINE push は F2 の 1 通のみ
    expect(metrics.sentCount).toBe(1);
    const sentTo = pushMessage.mock.calls.map((c) => c[0]);
    expect(sentTo).toEqual(['U_ONESHOT']);
    expect(sentTo).not.toContain('U_SUB');
  });

  it('契約が解約されたらリマインダーは自動で復活する (行を消さない設計の意図)', async () => {
    const raw = createSchemaDb();
    seed(raw, { contractState: 'cancelled' });

    const metrics = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    // cancelled_at が立った契約は「稼働」でない = F1 にも届く (単発購入者に戻った扱い)
    expect(metrics.sentCount).toBe(2);
    expect(pushMessage.mock.calls.map((c) => c[0]).sort()).toEqual(['U_ONESHOT', 'U_SUB']);
  });

  it('契約が無ければ従来どおり全員に送る (既存挙動の不変)', async () => {
    const raw = createSchemaDb();
    seed(raw, { contractState: 'none' });

    const metrics = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    expect(metrics.sentCount).toBe(2);
  });
});
