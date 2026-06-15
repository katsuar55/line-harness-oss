/**
 * Tests for bounded cron delivery queries (P2 launch-scale hardening, 2026-06-15).
 *
 * 数千友だち規模で `.all()` の 10,000 行上限による silent truncation (= 配信欠落) と
 * cron の CPU/subrequest 枯渇を防ぐため、 配信 cron の SELECT を「due 判定を SQL に push +
 * ORDER BY + LIMIT で bounded」 に変更する。
 *
 * - getFriendScenariosDueForDelivery: unixepoch() で TZ offset (Z/+09:00 混在) を吸収して
 *   due 判定を SQL 側に移し、 ORDER BY ... ASC + LIMIT で 1 tick の処理数を上限化。
 * - getDueReminderDeliveries: EXISTS(due 未配信 step) で配信すべき friend_reminder のみを
 *   LIMIT 付きで取得し、 steps/deliveries を IN 句で一括取得 (N+1 解消)。 due の最終判定は
 *   従来どおり JS が authoritative。 H2 blacklist 除外を維持。
 *
 * 実 @line-crm/db 関数を SQL-capture / routing mock db で直接 test (= reminders-blacklist.test.ts と同様式)。
 *
 * 【unixepoch 正規化の検証について】
 * mock db は unixepoch() を実行できない (固定 results を返すだけ) ため、 SQL の意味的正しさ
 * (= Z / +09:00 / ミリ秒 を同一 epoch に正規化) は本番 D1 で直接検証済:
 *   unixepoch('2026-06-15T12:00:00+09:00')      = 1781492400
 *   unixepoch('2026-06-15T03:00:00Z')           = 1781492400
 *   unixepoch('2026-06-15T12:00:00.000+09:00')  = 1781492400   → 全て一致 (equal=1)
 * ここでは SQL の shape (unixepoch 述語/ORDER BY/LIMIT) と、 JS 側 due 判定の whole-second 整合
 * (= SQL prefilter と完全一致し空 slot を生まない) を mock で検証する。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  getFriendScenariosDueForDelivery,
  getDueReminderDeliveries,
  type FriendReminderRow,
  type ReminderStepRow,
} from '@line-crm/db';

const norm = (s: string) => s.replace(/\s+/g, ' ');

/** prepare/bind した SQL と bind 引数を記録し、 SQL パターンで .all 結果を出し分けるルーティング db。 */
function makeRoutingDb(routes: Array<{ match: RegExp; results: unknown[] }>) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const resultFor = (sql: string) => {
    const r = routes.find((route) => route.match.test(norm(sql)));
    return r ? r.results : [];
  };
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: vi.fn((...a: unknown[]) => stmt(sql, a)),
    all: vi.fn(async () => {
      calls.push({ sql, args });
      return { results: resultFor(sql) };
    }),
    first: vi.fn(async () => null),
    run: vi.fn(async () => ({ meta: { changes: 0 } })),
  });
  const prepared: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      prepared.push(sql);
      return stmt(sql);
    }),
  } as unknown as D1Database;
  return { db, calls, prepared };
}

// ===========================================================================
// getFriendScenariosDueForDelivery — unixepoch predicate + ORDER BY + LIMIT
// ===========================================================================
describe('getFriendScenariosDueForDelivery (bounded)', () => {
  it('due 判定を SQL の unixepoch 比較に push し、 ORDER BY + LIMIT を付ける', async () => {
    const { db, prepared, calls } = makeRoutingDb([
      { match: /FROM friend_scenarios/, results: [] },
    ]);
    await getFriendScenariosDueForDelivery(db, '2026-06-15T12:00:00+09:00');

    const q = norm(prepared.find((s) => /FROM friend_scenarios/.test(norm(s)))!);
    expect(q).toContain("status = 'active'");
    expect(q).toContain('next_delivery_at IS NOT NULL');
    // 混在形式 (Z/+09:00) を epoch 化して比較する
    expect(q).toMatch(/unixepoch\(next_delivery_at\)\s*<=\s*unixepoch\(\?\)/);
    expect(q).toMatch(/ORDER BY unixepoch\(next_delivery_at\) ASC/);
    expect(q).toContain('LIMIT ?');
    // JS 側の再フィルタ/再ソートは廃止 → bind は (now, limit) のみ
    expect(calls[0].args).toEqual(['2026-06-15T12:00:00+09:00', 200]);
  });

  it('DB が返した行をそのまま返す (JS 再フィルタなし)', async () => {
    const rows = [
      { id: 'a', next_delivery_at: '2026-06-15T09:00:00+09:00' },
      { id: 'b', next_delivery_at: '2026-06-15T10:00:00+09:00' },
    ];
    const { db } = makeRoutingDb([{ match: /FROM friend_scenarios/, results: rows }]);
    const out = await getFriendScenariosDueForDelivery(db, '2026-06-15T12:00:00+09:00');
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('limit 引数を尊重する (default 200)', async () => {
    const { db, calls } = makeRoutingDb([{ match: /FROM friend_scenarios/, results: [] }]);
    await getFriendScenariosDueForDelivery(db, '2026-06-15T12:00:00+09:00', 25);
    expect(calls[0].args).toEqual(['2026-06-15T12:00:00+09:00', 25]);
  });
});

// ===========================================================================
// getDueReminderDeliveries — EXISTS-bounded candidate + IN-batched (no N+1)
// ===========================================================================
const CAND = /FROM friend_reminders fr/;
const STEPS_IN = /FROM reminder_steps\s+WHERE reminder_id IN/;
const DELIV_IN = /FROM friend_reminder_deliveries\s+WHERE friend_reminder_id IN/;

function frRow(over: Partial<FriendReminderRow>): FriendReminderRow {
  return {
    id: 'fr1',
    friend_id: 'f1',
    reminder_id: 'r1',
    target_date: '2026-06-15T00:00:00+09:00',
    status: 'active',
    created_at: '',
    updated_at: '',
    ...over,
  };
}
function stepRow(over: Partial<ReminderStepRow>): ReminderStepRow {
  return {
    id: 's1',
    reminder_id: 'r1',
    offset_minutes: 0,
    message_type: 'text',
    message_content: 'hi',
    created_at: '',
    ...over,
  };
}

describe('getDueReminderDeliveries (bounded + N+1 解消)', () => {
  it('候補クエリは blacklist 除外 (H2) + due 未配信 EXISTS + ORDER BY + LIMIT を持つ', async () => {
    const { db, prepared, calls } = makeRoutingDb([{ match: CAND, results: [] }]);
    await getDueReminderDeliveries(db, '2026-06-15T12:00:00+09:00');

    const q = norm(prepared.find((s) => CAND.test(norm(s)))!);
    // H2 regression: blacklist 除外を維持
    expect(q).toContain('JOIN friends');
    expect(q).toContain('COALESCE(f.is_blacklisted, 0) = 0');
    expect(q).toContain("fr.status = 'active'");
    expect(q).toContain('r.is_active = 1');
    // due かつ未配信の step が 1 つ以上ある reminder のみ
    expect(q).toContain('EXISTS');
    expect(q).toContain('NOT EXISTS');
    expect(q).toMatch(/unixepoch\(fr\.target_date\)\s*\+\s*rs\.offset_minutes\s*\*\s*60\s*<=\s*unixepoch\(\?\)/);
    expect(q).toMatch(/ORDER BY unixepoch\(fr\.target_date\) ASC/);
    expect(q).toContain('LIMIT ?');
    expect(calls[0].args).toEqual(['2026-06-15T12:00:00+09:00', 100]);
  });

  it('候補が空なら早期 return し、 N+1 クエリを発行しない (prepare 1 回)', async () => {
    const { db, prepared } = makeRoutingDb([{ match: CAND, results: [] }]);
    const out = await getDueReminderDeliveries(db, '2026-06-15T12:00:00+09:00');
    expect(out).toEqual([]);
    expect(prepared.length).toBe(1);
  });

  it('steps/deliveries を IN 句で一括取得し N+1 を出さない (prepare ちょうど 3 回)', async () => {
    const candidates = [
      frRow({ id: 'frA', reminder_id: 'rA', target_date: '2026-06-15T00:00:00+09:00' }),
      frRow({ id: 'frB', reminder_id: 'rB', target_date: '2026-06-15T00:00:00+09:00' }),
    ];
    const steps = [
      stepRow({ id: 'sA1', reminder_id: 'rA', offset_minutes: 0 }),
      stepRow({ id: 'sA2', reminder_id: 'rA', offset_minutes: 600 }), // 未来 → due でない
      stepRow({ id: 'sB1', reminder_id: 'rB', offset_minutes: 0 }),
    ];
    const delivered = [{ friend_reminder_id: 'frB', reminder_step_id: 'sB1' }]; // frB は配信済

    const { db, prepared } = makeRoutingDb([
      { match: CAND, results: candidates },
      { match: STEPS_IN, results: steps },
      { match: DELIV_IN, results: delivered },
    ]);

    // now = target_date + 60min なので offset 0 のみ due (offset 600 は未来)
    const out = await getDueReminderDeliveries(db, '2026-06-15T01:00:00+09:00');

    // N+1 でなく一括: candidate + steps-IN + deliveries-IN = 3 prepare
    expect(prepared.length).toBe(3);
    expect(prepared.some((s) => STEPS_IN.test(norm(s)))).toBe(true);
    expect(prepared.some((s) => DELIV_IN.test(norm(s)))).toBe(true);

    // frA: sA1(offset0,未配信)=due, sA2(offset600)=未来 → steps=[sA1]
    // frB: sB1(offset0) は配信済 → due step なし → 除外
    expect(out.map((r) => r.id)).toEqual(['frA']);
    expect(out[0].steps.map((s) => s.id)).toEqual(['sA1']);
  });

  it('due 判定は SQL prefilter と同じ whole-second 精度 (同一秒内のミリ秒境界で due)', async () => {
    // target+offset = 12:00:00.999, now = 12:00:00.001。 旧 ms 比較なら .999 > .001 で「未 due」
    // と落とすが、 SQL prefilter (unixepoch=秒) は同一秒で due。 JS を whole-second に揃えたので
    // ここでも due になり、 空 slot (= SQL が拾い JS が落とす) を生まない。
    const candidates = [frRow({ id: 'frX', reminder_id: 'rX', target_date: '2026-06-15T12:00:00.999+09:00' })];
    const steps = [stepRow({ id: 'sX', reminder_id: 'rX', offset_minutes: 0 })];
    const { db } = makeRoutingDb([
      { match: CAND, results: candidates },
      { match: STEPS_IN, results: steps },
      { match: DELIV_IN, results: [] },
    ]);
    const out = await getDueReminderDeliveries(db, '2026-06-15T12:00:00.001+09:00');
    expect(out.map((r) => r.id)).toEqual(['frX']);
    expect(out[0].steps.map((s) => s.id)).toEqual(['sX']);
  });

  it('whole-second で 1 秒先の step は除外', async () => {
    // target+offset = 12:00:01.000, now = 12:00:00.500 → 秒が後なので未 due。
    const candidates = [frRow({ id: 'frY', reminder_id: 'rY', target_date: '2026-06-15T12:00:01.000+09:00' })];
    const steps = [stepRow({ id: 'sY', reminder_id: 'rY', offset_minutes: 0 })];
    const { db } = makeRoutingDb([
      { match: CAND, results: candidates },
      { match: STEPS_IN, results: steps },
      { match: DELIV_IN, results: [] },
    ]);
    const out = await getDueReminderDeliveries(db, '2026-06-15T12:00:00.500+09:00');
    expect(out).toEqual([]);
  });
});
