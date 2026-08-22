/**
 * 再購入リマインダー — 「異常に古い due」の送信前再導出 (採点② 2, 2026-08-23)。
 *
 * 🚨 機構: 稼働契約を持つ友だちは SELECT 側の NOT EXISTS (2026-08-18) で除外され続けるため、
 *   その行の next_reminder_at は**古いまま凍結**する。契約が解約された瞬間に NOT EXISTS が
 *   反転し、「何ヶ月も前が期日」の行が即 due になって、5 分周期の cron が解約直後の顧客へ
 *   再購入 push を撃つ。除外ガードそのものが時限爆弾を仕込む形になっていた。
 *
 * 対策は発生源ごとではなく **送信直前の 1 箇所** (= memory feedback_send_time_recompute_chokepoint)。
 *   - 閾値より古い due は送らず、now + interval_days へ CAS で**前進のみ**再アンカー
 *   - 日付がパース不能な行も**無送信側**へ倒す (誤送信は回復不能・無送信は回復可能 = S11)
 *   - 見送り/再アンカーは黙って捨てずメトリクス化する
 *
 * 観測点は **pushMessage の呼出回数と DB の実値**。sentCount だけを見ると
 * 「送ってから潰す」実装でも緑になるため。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';
import {
  processSubscriptionReminders,
  STALE_DUE_THRESHOLD_MS,
} from '../services/subscription-reminder.js';

const pushMessage = vi.fn(async (_to: string, _messages: unknown[]) => ({}));
const lineClient = { pushMessage } as never;

const PAST = '2026-08-01T00:00:00.000Z';

/** msAgo ミリ秒前の ISO 文字列 */
function agoIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function seed(
  raw: SqliteDatabase,
  opts: { nextReminderAt: string; intervalDays?: number },
): void {
  raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
            VALUES ('F1', 'U_ONESHOT', 'OneShot', 1, '${PAST}', '${PAST}')`);
  const interval = String(opts.intervalDays ?? 30);
  raw.exec(`INSERT INTO subscription_reminders
              (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
            VALUES ('R1', 'F1', 'naturism Pink', ${interval}, '${opts.nextReminderAt}', 1, '${PAST}', '${PAST}')`);
}

function nextOf(raw: SqliteDatabase): string {
  return (raw.prepare(`SELECT next_reminder_at AS n FROM subscription_reminders WHERE id='R1'`).get() as { n: string }).n;
}

describe('異常に古い due は送らず先送りする (解約直後の再購入 push の防止)', () => {
  beforeEach(() => {
    pushMessage.mockClear();
  });

  it('🚨 何ヶ月も前が期日の行は push せず、now + interval_days へ再アンカーする', async () => {
    const raw = createSchemaDb();
    seed(raw, { nextReminderAt: agoIso(120 * 86400_000), intervalDays: 30 });

    const before = Date.now();
    const m = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    // 観測点①: 外部送信を 1 通も呼んでいない
    expect(pushMessage).not.toHaveBeenCalled();
    expect(m.sentCount).toBe(0);
    // 観測点②: DB の実値が前進している (概ね now + 30 日)
    const after = Date.parse(nextOf(raw));
    expect(after).toBeGreaterThan(before + 29 * 86400_000);
    expect(after).toBeLessThan(before + 31 * 86400_000);
    expect(m.staleReanchoredCount).toBe(1);
  });

  it('正常な due (数分前が期日) は従来どおり送る — 退行なし', async () => {
    const raw = createSchemaDb();
    seed(raw, { nextReminderAt: agoIso(3 * 60_000), intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(m.sentCount).toBe(1);
    expect(m.staleReanchoredCount).toBe(0);
  });

  it('閾値の境界: 閾値より新しければ送り、古ければ送らない', async () => {
    // 閾値より 1 時間新しい → 送る
    const fresh = createSchemaDb();
    seed(fresh, { nextReminderAt: agoIso(STALE_DUE_THRESHOLD_MS - 3600_000), intervalDays: 30 });
    await processSubscriptionReminders(asD1(fresh), lineClient, 'https://liff.line.me/test');
    expect(pushMessage).toHaveBeenCalledTimes(1);

    pushMessage.mockClear();

    // 閾値より 1 時間古い → 送らない
    const stale = createSchemaDb();
    seed(stale, { nextReminderAt: agoIso(STALE_DUE_THRESHOLD_MS + 3600_000), intervalDays: 30 });
    await processSubscriptionReminders(asD1(stale), lineClient, 'https://liff.line.me/test');
    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('🚨 lease (10 分) は再アンカーの対象にしない — 閾値は lease より確実に大きい', () => {
    // 送信前 claim が next_reminder_at を now+10min へ進める設計なので、
    // 閾値が 10 分近辺だと正常な lease 行まで巻き込んで送信不能になる
    expect(STALE_DUE_THRESHOLD_MS).toBeGreaterThan(60 * 60_000);
  });

  it('日付がパース不能な行は無送信側へ倒す (誤送信は回復不能・無送信は回復可能)', async () => {
    const raw = createSchemaDb();
    // 文字列順では now より前 (= SELECT に入る) が Date.parse は NaN、という実際に起こりうる壊れ方。
    // 'not-a-date' のような値は文字列比較で now より後になり SELECT に入らないため題材にならない
    seed(raw, { nextReminderAt: '0000-00-00T00:00:00Z', intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    expect(pushMessage).not.toHaveBeenCalled();
    expect(m.staleSkippedCount).toBe(1);
  });

  it('interval_days が 0 でも 30 日で再アンカーする (即時再送の無限ループを作らない)', async () => {
    // interval_days は schema 上 NOT NULL なので、実際に起こりうる壊れ方は 0 や負値
    const raw = createSchemaDb();
    seed(raw, { nextReminderAt: agoIso(120 * 86400_000), intervalDays: 0 });

    const before = Date.now();
    await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    expect(pushMessage).not.toHaveBeenCalled();
    const after = Date.parse(nextOf(raw));
    expect(after).toBeGreaterThan(before + 29 * 86400_000);
  });

  it('再アンカーは前進のみ — 2 回連続で走らせても push は 0 のまま', async () => {
    const raw = createSchemaDb();
    seed(raw, { nextReminderAt: agoIso(120 * 86400_000), intervalDays: 30 });
    const db = asD1(raw);

    await processSubscriptionReminders(db, lineClient, 'https://liff.line.me/test');
    const first = nextOf(raw);
    // 2 回目は due ですらない (未来へ動いているので SELECT に入らない)
    const m2 = await processSubscriptionReminders(db, lineClient, 'https://liff.line.me/test');

    expect(pushMessage).not.toHaveBeenCalled();
    expect(m2.dueCount).toBe(0);
    expect(nextOf(raw)).toBe(first);
  });
});

describe('due の取り出し順 (starvation 防止)', () => {
  beforeEach(() => {
    pushMessage.mockClear();
  });

  it('古い順に処理する — prefs OFF の恒久 due 行が LIMIT 50 を占有して他が飢えない', async () => {
    const raw = createSchemaDb();
    raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
              VALUES ('F1', 'U1', 'A', 1, '${PAST}', '${PAST}')`);
    raw.exec(`INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
              VALUES ('F2', 'U2', 'B', 1, '${PAST}', '${PAST}')`);
    // 新しい方を先に INSERT しても、古い方が先に処理される
    raw.exec(`INSERT INTO subscription_reminders (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
              VALUES ('R-NEW', 'F2', 'P', 30, '${agoIso(60_000)}', 1, '${PAST}', '${PAST}')`);
    raw.exec(`INSERT INTO subscription_reminders (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
              VALUES ('R-OLD', 'F1', 'P', 30, '${agoIso(600_000)}', 1, '${PAST}', '${PAST}')`);

    await processSubscriptionReminders(asD1(raw), lineClient, 'https://liff.line.me/test');

    const order = pushMessage.mock.calls.map((c) => c[0]);
    expect(order).toEqual(['U1', 'U2']);
  });
});
