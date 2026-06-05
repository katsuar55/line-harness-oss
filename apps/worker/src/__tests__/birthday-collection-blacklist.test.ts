/**
 * Tests for birthday-collection route blacklist exclusion (H, 2026-06-06).
 *
 * `POST /api/birthday-collection/send` は未登録の全 follower に admin 一斉 multicast する
 * mass 配信。 target SELECT が is_blacklisted を除外していなかった (security review Finding 2)。
 * `/stats` の件数も送信対象の予測値 (unregistered) を出すため整合させる。
 *
 * 実 route を SQL-capture db で driving し、 friends を引く SELECT が
 * COALESCE(is_blacklisted,0)=0 を含むことを検証する (dryRun=true で実送信せず SELECT のみ exercise)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class MockLineClient {
    constructor(public readonly token: string) {}
    async multicast() {}
  },
}));

import { birthdayCollection } from '../routes/birthday-collection.js';
import type { Env } from '../index.js';

/** prepare された全 SQL を記録する db (COUNT は 0、 list は空)。 */
function makeRecordingDb(): { db: D1Database; sqls: string[] } {
  const sqls: string[] = [];
  function stmt(sql: string) {
    return {
      bind: (..._a: unknown[]) => stmt(sql),
      first: async () => ({ c: 0 }),
      all: async () => ({ results: [] as unknown[], success: true }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
  }
  const db = {
    prepare: (sql: string) => {
      sqls.push(sql);
      return stmt(sql);
    },
  } as unknown as D1Database;
  return { db, sqls };
}

function createApp(): InstanceType<typeof Hono<Env>> {
  const app = new Hono<Env>();
  app.route('/', birthdayCollection);
  return app;
}

function makeEnv(db: D1Database): Env['Bindings'] {
  return { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' } as unknown as Env['Bindings'];
}

function normalize(sqls: string[]): string[] {
  return sqls.map((s) => s.replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('birthday-collection route — blacklist 除外', () => {
  it('POST /send の target SELECT は is_blacklisted を除外する (consent/景表法)', async () => {
    const { db, sqls } = makeRecordingDb();
    const res = await createApp().request(
      '/api/birthday-collection/send',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      },
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const sendQuery = normalize(sqls).find(
      (s) => s.includes('FROM friends') && s.includes('json_extract(metadata'),
    );
    expect(sendQuery).toBeDefined();
    expect(sendQuery).toContain('COALESCE(is_blacklisted, 0) = 0');
  });

  it('GET /stats の件数 SELECT も is_blacklisted を除外する (送信予測との整合)', async () => {
    const { db, sqls } = makeRecordingDb();
    const res = await createApp().request(
      '/api/birthday-collection/stats',
      {},
      makeEnv(db),
    );

    expect(res.status).toBe(200);
    const friendQueries = normalize(sqls).filter((s) => s.includes('FROM friends'));
    expect(friendQueries.length).toBeGreaterThanOrEqual(2); // total + registered
    for (const q of friendQueries) {
      expect(q).toContain('COALESCE(is_blacklisted, 0) = 0');
    }
  });
});
