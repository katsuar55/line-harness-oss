/**
 * 再購入リマインダー — 解約直後 push の防止 (採点② 2, 2026-08-23)。
 *
 * 🚨 機構: 稼働契約を持つ友だちは SELECT 側の NOT EXISTS (2026-08-18) で除外され続けるため、
 *   その行の next_reminder_at は**古いまま凍結**する。契約が解約された瞬間に NOT EXISTS が
 *   反転し、凍結済みの行が即 due になって、5 分周期の cron が解約直後の顧客へ
 *   再購入 push を撃つ。除外ガードそのものが時限爆弾を仕込む形になっていた。
 *
 * ⚠️ 当初実装は「3 日以上古い due は送らない」という**古さの代理指標**だったが、
 *   採点ループが実測で反証した: 凍結される期日は「初回注文 + interval (実質 30 日)」で固定され、
 *   **解約はまさにその期日の近傍に集中する**ため、「期日 2 日前 × 解約 1 分前」が窓の内側を
 *   素通りして push が飛んでいた。代理指標をやめ cancelled_at を直接見る設計へ変更した。
 *
 * 観測点は **pushMessage の呼出回数と DB の実値**。sentCount だけを見ると
 * 「送ってから潰す」実装でも緑になるため。
 * 期日・沈黙期間は**定数から導出せず絶対値で書く** — 定数を動かすと fixture も動く
 * 自己参照テストは比較演算子の向きしか測れない (採点ループ R1 HIGH)。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSchemaDb, asD1, type SqliteDatabase } from './helpers/sqlite-d1.js';
import { processSubscriptionReminders } from '../services/subscription-reminder.js';

const pushMessage = vi.fn(async (_to: string, _messages: unknown[]) => ({}));
const lineClient = { pushMessage } as never;
const LIFF = 'https://liff.line.me/test';

const CREATED = '2026-01-01T00:00:00.000Z';
const DAY = 86400_000;

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function seed(
  raw: SqliteDatabase,
  opts: {
    dueAgoMs: number | string;
    intervalDays?: number;
    /** 契約の cancelled_at。null = 契約なし (純粋な単発購入者) */
    cancelledAgoMs?: number | string | null;
  },
): void {
  raw.exec(
    `INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
     VALUES ('F1', 'U_SUB', 'Sub', 1, '${CREATED}', '${CREATED}')`,
  );
  const due = typeof opts.dueAgoMs === 'string' ? opts.dueAgoMs : agoIso(opts.dueAgoMs);
  raw.exec(
    `INSERT INTO subscription_reminders
       (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
     VALUES ('R1', 'F1', 'naturism Pink', ${opts.intervalDays ?? 30}, '${due}', 1, '${CREATED}', '${CREATED}')`,
  );

  if (opts.cancelledAgoMs !== undefined && opts.cancelledAgoMs !== null) {
    const cancelled =
      typeof opts.cancelledAgoMs === 'string' ? opts.cancelledAgoMs : agoIso(opts.cancelledAgoMs);
    raw.exec(`UPDATE friends SET shopify_customer_id='SC1' WHERE id='F1'`);
    raw.exec(
      `INSERT INTO subscription_contracts (contract_id, shopify_customer_id, cancelled_at, created_at, updated_at)
       VALUES ('C1', 'SC1', '${cancelled}', '${CREATED}', '${CREATED}')`,
    );
  }
}

function nextOf(raw: SqliteDatabase): string {
  return (
    raw.prepare(`SELECT next_reminder_at AS n FROM subscription_reminders WHERE id='R1'`).get() as {
      n: string;
    }
  ).n;
}

describe('解約直後は再購入 push を送らない', () => {
  beforeEach(() => pushMessage.mockClear());

  it('🚨 初回サイクル解約 (期日 2 日前 × 解約 1 分前) — 代理指標では素通りしていた本命ケース', async () => {
    // 凍結期日 = 初回注文 + 30 日 = 解約が集中する日そのもの。
    // 「古さ」で判定すると 2 日前は新しすぎて素通りする = 当初実装のバグ
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 2 * DAY, cancelledAgoMs: 60_000, intervalDays: 30 });

    const before = Date.now();
    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).not.toHaveBeenCalled();
    expect(m.sentCount).toBe(0);
    expect(m.cancelReanchoredCount).toBe(1);
    // DB 実値が「解約日 + 30 日」へ動いている
    const after = Date.parse(nextOf(raw));
    expect(after).toBeGreaterThan(before + 29 * DAY);
    expect(after).toBeLessThan(before + 31 * DAY);
  });

  it('長期凍結 (期日 120 日前 × 解約 1 分前) も送らない', async () => {
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 120 * DAY, cancelledAgoMs: 60_000, intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).not.toHaveBeenCalled();
    expect(m.cancelReanchoredCount).toBe(1);
  });

  it('解約から interval を超えていれば送る — 単発購入者に戻った人への促しは温存する', async () => {
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: 31 * DAY, intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(m.sentCount).toBe(1);
    expect(m.cancelReanchoredCount).toBe(0);
  });

  it('沈黙期間の境界は「解約日 + interval」— 定数由来でなく絶対値で pin する', async () => {
    // 解約 29 日前 (interval 30) → まだ沈黙
    const inside = createSchemaDb();
    seed(inside, { dueAgoMs: 5 * 60_000, cancelledAgoMs: 29 * DAY, intervalDays: 30 });
    await processSubscriptionReminders(asD1(inside), lineClient, LIFF);
    expect(pushMessage, '解約 29 日前 (interval 30)').not.toHaveBeenCalled();

    pushMessage.mockClear();

    // 解約 31 日前 → 送る
    const outside = createSchemaDb();
    seed(outside, { dueAgoMs: 5 * 60_000, cancelledAgoMs: 31 * DAY, intervalDays: 30 });
    await processSubscriptionReminders(asD1(outside), lineClient, LIFF);
    expect(pushMessage, '解約 31 日前 (interval 30)').toHaveBeenCalledTimes(1);
  });

  it('interval が違えば沈黙期間も違う (interval 100 日なら解約 31 日前でも沈黙)', async () => {
    // 「3 日固定」のような定数ではなく interval に連動していることの pin
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: 31 * DAY, intervalDays: 100 });

    await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).not.toHaveBeenCalled();
  });

  it('契約が無い純粋な単発購入者には従来どおり送る (退行なし)', async () => {
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: null });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(m.sentCount).toBe(1);
  });

  it('🚨 cron が長期停止して復旧しても、契約が無い行は送られる (古さでは止めない)', async () => {
    // 当初の「3 日以上古い due は送らない」設計は、cron 停止明けに全 due を
    // 一斉に先送りして 1 サイクル丸ごと落としていた (採点ループ R1 MEDIUM)
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 10 * DAY, cancelledAgoMs: null });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(m.sentCount).toBe(1);
  });

  it('cancelled_at がパース不能なら無送信側へ倒す (解約済みか判断できないまま送らない)', async () => {
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: 'cancel-tag-broken', intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage).not.toHaveBeenCalled();
    // 正常な沈黙 (いつか終わる) と永久抑止 (原因が消えるまで終わらない) を
    // 同じカウンタに混ぜると cron_run_logs から見分けられない (採点R2)
    expect(m.cancelUnparsedCount).toBe(1);
    expect(m.cancelReanchoredCount).toBe(0);
  });

  it('本番形式の日付のみ cancelled_at (Shopify タグ由来 YYYY-MM-DD) を正しく解釈する', async () => {
    // 本番の cancelled_at は顧客タグ subscription-{ID}-cancel:{date} の生値 = 日付のみ。
    // テストが完全 ISO だけだと、日付のみ形式で壊れても気付けない (採点R2 LOW)
    const d = new Date(Date.now() - 5 * DAY);
    const dateOnly = d.toISOString().slice(0, 10);

    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: dateOnly, intervalDays: 30 });

    const m = await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    // 解約 5 日前 (interval 30) → まだ沈黙。パース不能扱いにも落ちない
    expect(pushMessage).not.toHaveBeenCalled();
    expect(m.cancelReanchoredCount).toBe(1);
    expect(m.cancelUnparsedCount).toBe(0);
  });
});

describe('壊れた行が cron を専有しない', () => {
  beforeEach(() => pushMessage.mockClear());

  it('🚨 next_reminder_at がパース不能な行は送らず、かつ必ず前進する (無限再選択を断つ)', async () => {
    // 文字列順で now より前 = SELECT に入るが Date.parse は NaN、という実際の壊れ方。
    // 据え置くと 5 分毎に同じ行を拾い続け、ORDER BY の先頭を恒久占有する
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: '0000-00-00T00:00:00Z', cancelledAgoMs: null, intervalDays: 30 });
    const db = asD1(raw);

    const before = Date.now();
    const m1 = await processSubscriptionReminders(db, lineClient, LIFF);

    expect(pushMessage).not.toHaveBeenCalled();
    expect(m1.staleSkippedCount).toBe(1);
    // DB 実値が前進している = 次回はもう due ではない
    const after = Date.parse(nextOf(raw));
    expect(Number.isFinite(after)).toBe(true);
    expect(after).toBeGreaterThan(before + 29 * DAY);

    const m2 = await processSubscriptionReminders(db, lineClient, LIFF);
    expect(m2.dueCount).toBe(0);
  });

  it('interval_days が 0 でも 30 日で前進する (即時再送の無限ループを作らない)', async () => {
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: '0000-00-00T00:00:00Z', cancelledAgoMs: null, intervalDays: 0 });

    const before = Date.now();
    await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(Date.parse(nextOf(raw))).toBeGreaterThan(before + 29 * DAY);
  });
});

describe('再アンカーの CAS (並行実行での二重前進を防ぐ)', () => {
  beforeEach(() => pushMessage.mockClear());

  it('🚨 別実行が先に next_reminder_at を進めていたら、こちらの再アンカーは適用されない', async () => {
    // CAS 述語 (WHERE next_reminder_at = <読んだ値>) が外れると、2 つの cron が
    // 同じ行をそれぞれ +interval して**二重に前進**する。ステータスや件数では
    // 観測できないので、UPDATE の直前に別実行の書き込みを差し込んで DB 実値で見る
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 2 * DAY, cancelledAgoMs: 60_000, intervalDays: 30 });
    const db = asD1(raw);
    const byOther = '2099-01-01T00:00:00.000Z';

    let injected = false;
    const wrapped = {
      ...db,
      prepare(sql: string) {
        // 再アンカーの UPDATE だけを狙う (claim は updated_at を持たない /
        // 送信後の更新は last_sent_at を持つ)
        if (!injected && sql.includes('SET next_reminder_at = ?, updated_at = ?')) {
          injected = true;
          raw.exec(`UPDATE subscription_reminders SET next_reminder_at='${byOther}' WHERE id='R1'`);
        }
        return db.prepare(sql);
      },
    } as D1Database;

    const m = await processSubscriptionReminders(wrapped, lineClient, LIFF);

    expect(injected, '再アンカーの UPDATE が実行された').toBe(true);
    // 別実行の値が生き残る = こちらの UPDATE は 0 行に当たった
    expect(nextOf(raw)).toBe(byOther);
    // 適用されなかったのでカウンタも増えない (「やったつもり」を数えない)
    expect(m.cancelReanchoredCount).toBe(0);
    expect(pushMessage).not.toHaveBeenCalled();
  });
});

describe('interval_days が壊れていても送信ループにならない', () => {
  beforeEach(() => pushMessage.mockClear());

  it('🚨 interval_days が 0 の行は、送信後も now より未来へ進む (5 分毎の無限 push を作らない)', async () => {
    // 生値のまま now + 0 日を書き戻すと即 due に戻り、5 分周期で同じ顧客へ送り続ける。
    // LIFF の POST /api/liff/subscriptions は intervalDays を検証しないので到達しうる (採点R2)
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 5 * 60_000, cancelledAgoMs: null, intervalDays: 0 });
    const db = asD1(raw);

    const before = Date.now();
    const m1 = await processSubscriptionReminders(db, lineClient, LIFF);
    expect(m1.sentCount).toBe(1);

    // DB 実値が未来へ進んでいる = 2 周目はもう due ではない
    expect(Date.parse(nextOf(raw))).toBeGreaterThan(before + 29 * DAY);
    const m2 = await processSubscriptionReminders(db, lineClient, LIFF);
    expect(m2.dueCount).toBe(0);
    expect(pushMessage).toHaveBeenCalledTimes(1);
  });
});

describe('due の取り出し順 (FIFO)', () => {
  beforeEach(() => pushMessage.mockClear());

  it('古い順に処理する', async () => {
    // ⚠️ この検証軸の限界 (採点ループ R1 で判明): idx_sub_reminders_next の先頭列が
    // next_reminder_at のため、ORDER BY を**削除**しても索引由来で昇順が返る
    // (= 削除は等価変異でここでは検出できない)。一方 DESC へ**変える**変異はここで落ちる。
    const raw = createSchemaDb();
    raw.exec(
      `INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
       VALUES ('F1', 'U1', 'A', 1, '${CREATED}', '${CREATED}')`,
    );
    raw.exec(
      `INSERT INTO friends (id, line_user_id, display_name, is_following, created_at, updated_at)
       VALUES ('F2', 'U2', 'B', 1, '${CREATED}', '${CREATED}')`,
    );
    raw.exec(
      `INSERT INTO subscription_reminders (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
       VALUES ('R-NEW', 'F2', 'P', 30, '${agoIso(60_000)}', 1, '${CREATED}', '${CREATED}')`,
    );
    raw.exec(
      `INSERT INTO subscription_reminders (id, friend_id, product_title, interval_days, next_reminder_at, is_active, created_at, updated_at)
       VALUES ('R-OLD', 'F1', 'P', 30, '${agoIso(600_000)}', 1, '${CREATED}', '${CREATED}')`,
    );

    await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    expect(pushMessage.mock.calls.map((c) => c[0])).toEqual(['U1', 'U2']);
  });
});

describe('ガードのヒット数が本番に残る (cron_run_logs)', () => {
  beforeEach(() => pushMessage.mockClear());

  it('🚨 cancelReanchored / staleSkipped が heartbeat の metrics に載る', async () => {
    // 戻り値だけだと呼び出し側 (index.ts の Promise.allSettled) が捨てるため、
    // 本番では「ガードが発火したか」を後から確認する手段がゼロになる (採点ループ R1 HIGH)
    const raw = createSchemaDb();
    seed(raw, { dueAgoMs: 2 * DAY, cancelledAgoMs: 60_000, intervalDays: 30 });

    await processSubscriptionReminders(asD1(raw), lineClient, LIFF);

    const row = raw
      .prepare(
        `SELECT metrics_json AS m FROM cron_run_logs WHERE job_name='subscription-reminder' ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { m: string } | undefined;
    expect(row, 'cron_run_logs に heartbeat 行がある').toBeTruthy();
    const metrics = JSON.parse(row!.m) as Record<string, number>;
    expect(metrics.cancelReanchored).toBe(1);
    expect(metrics).toHaveProperty('staleSkipped');
  });
});
