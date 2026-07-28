/**
 * 「稼働中/予約中の配信に触る操作は owner/admin」の回帰ガード。
 *
 * 背景 (2026-07-28 スタッフ手引きの採点で発覚):
 *   一斉配信は送信 (POST /send) と予約 (PUT の scheduledAt 分岐) を owner/admin で守っていたが、
 *   **同じ効果を持つ迂回路が 2 本開いていた**:
 *     - PUT /api/scenarios/:id … isActive の切替に guard が無く、staff が全シナリオ配信を停止/再開できた。
 *       /emergency の「シナリオ一括停止」がまさにこの経路を叩いており、staff にもメニュー表示される。
 *     - DELETE /api/broadcasts/:id … 予約済みでも guard が無く、staff が予約配信を消して実質キャンセルできた。
 *   「/send にだけガードを付けても scheduledAt で迂回できた」(2026-07-23 採点 R2 HIGH) と同じクラスの穴。
 *
 * 本テストは **staff は拒否 / admin は通過** を両方向で固定する。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scenarios } from '../routes/scenarios.js';
import { broadcasts } from '../routes/broadcasts.js';
import type { Env } from '../index.js';

type Row = Record<string, unknown>;

/** 必要最小限の D1 スタブ。SQL の種類でなく呼び出し順ではなく「返す行」で振る舞いを決める。 */
function makeDb(rows: { scenario?: Row | null; broadcast?: Row | null }) {
  const calls: string[] = [];
  const db = {
    calls,
    prepare(sql: string) {
      calls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 80));
      const stmt = {
        bind: () => stmt,
        first: async () => {
          if (/FROM scenarios/i.test(sql)) return rows.scenario ?? null;
          if (/FROM broadcasts/i.test(sql)) return rows.broadcast ?? null;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    },
    batch: async () => [],
  };
  return db;
}

/**
 * staff コンテキストを注入した上でルータを叩く (authMiddleware は通さない)。
 * 実運用では authMiddleware が c.set('staff', …) するので、それを wrapper で再現する。
 */
async function callAs(
  app: Hono<Env>,
  role: 'owner' | 'admin' | 'staff' | null,
  method: string,
  path: string,
  body?: unknown,
  db?: unknown,
): Promise<Response> {
  const wrapper = new Hono<Env>();
  wrapper.use('*', async (c, next) => {
    if (role) c.set('staff', { id: 's1', name: 'tester', role } as never);
    await next();
  });
  wrapper.route('/', app);
  return wrapper.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    { DB: db } as unknown as Env['Bindings'],
  );
}

const ACTIVE_SCENARIO: Row = { id: 'sc1', name: 'welcome', is_active: 1, line_account_id: null };
const DRAFT_SCENARIO: Row = { id: 'sc2', name: 'draft', is_active: 0, line_account_id: null };
const SCHEDULED_BC: Row = { id: 'b1', status: 'scheduled', title: 't', line_account_id: null };
const DRAFT_BC: Row = { id: 'b2', status: 'draft', title: 't', line_account_id: null };

describe('シナリオ: 稼働中の開始・停止・編集は owner/admin', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb({ scenario: ACTIVE_SCENARIO });
  });

  it('staff は isActive:false (= 全配信停止) を実行できない', async () => {
    const res = await callAs(scenarios, 'staff', 'PUT', '/api/scenarios/sc1', { isActive: false }, db);
    expect(res.status, '/emergency のシナリオ一括停止がここを叩く').toBe(403);
  });

  it('staff は稼働中シナリオの文面編集もできない (cron が配信するため)', async () => {
    const res = await callAs(scenarios, 'staff', 'PUT', '/api/scenarios/sc1', { name: '差し替え' }, db);
    expect(res.status).toBe(403);
  });

  it('staff は稼働中シナリオを削除できない (停止の迂回路)', async () => {
    const res = await callAs(scenarios, 'staff', 'DELETE', '/api/scenarios/sc1', undefined, db);
    expect(res.status).toBe(403);
  });

  it('admin は停止できる', async () => {
    const res = await callAs(scenarios, 'admin', 'PUT', '/api/scenarios/sc1', { isActive: false }, db);
    expect(res.status).not.toBe(403);
  });

  it('停止中シナリオの編集は staff でもできる (下書き作業は妨げない)', async () => {
    const d = makeDb({ scenario: DRAFT_SCENARIO });
    const res = await callAs(scenarios, 'staff', 'PUT', '/api/scenarios/sc2', { name: 'メモ' }, d);
    expect(res.status).not.toBe(403);
  });

  it('停止中シナリオを staff が有効化しようとすると拒否される', async () => {
    const d = makeDb({ scenario: DRAFT_SCENARIO });
    const res = await callAs(scenarios, 'staff', 'PUT', '/api/scenarios/sc2', { isActive: true }, d);
    expect(res.status, '有効化 = 全お客様向け配信の開始').toBe(403);
  });
});

describe('一斉配信: 予約済みの削除は owner/admin (予約解除の迂回路)', () => {
  it('staff は予約済み配信を削除できない', async () => {
    const db = makeDb({ broadcast: SCHEDULED_BC });
    const res = await callAs(broadcasts, 'staff', 'DELETE', '/api/broadcasts/b1', undefined, db);
    expect(res.status).toBe(403);
  });

  it('admin は予約済み配信を削除できる', async () => {
    const db = makeDb({ broadcast: SCHEDULED_BC });
    const res = await callAs(broadcasts, 'admin', 'DELETE', '/api/broadcasts/b1', undefined, db);
    expect(res.status).not.toBe(403);
  });

  it('下書きの削除は staff でもできる', async () => {
    const db = makeDb({ broadcast: DRAFT_BC });
    const res = await callAs(broadcasts, 'staff', 'DELETE', '/api/broadcasts/b2', undefined, db);
    expect(res.status).not.toBe(403);
  });
});
