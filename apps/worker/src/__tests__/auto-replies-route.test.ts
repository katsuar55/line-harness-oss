/**
 * Tests for /api/auto-replies CRUD + /api/auto-replies/batch.
 * Review 反映分を中心に: PATCH ガード (isActive 非boolean→400, 空文字→400)、
 * responseType enum、書き込み時 薬機 redact、batch の原子的作成 + 既存スキップ。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PROHIBITED_PHRASES } from '@line-crm/ai-provider';

vi.mock('@line-crm/db', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@line-crm/db');
  return {
    ...original,
    getStaffByApiKey: vi.fn(async () => null),
    jstNow: vi.fn(() => '2026-06-12T12:00:00+09:00'),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { autoReplies } from '../routes/auto-replies.js';
import type { Env } from '../index.js';

const TEST_API_KEY = 'test-api-key-secret-12345';

interface DbCall {
  sql: string;
  binds: unknown[];
}

/** 記録付き mock DB。existingKeywords は batch の既存重複 SELECT が返す行。 */
function makeDb(opts: { existingRow?: Record<string, unknown> | null; existingKeywords?: Array<{ keyword: string; match_type: string }> } = {}) {
  const calls: DbCall[] = [];
  const batched: DbCall[][] = [];
  const db = {
    prepare(sql: string) {
      const make = (binds: unknown[]) => ({
        sql,
        binds,
        async first() {
          if (sql.startsWith('SELECT * FROM auto_replies WHERE id')) return opts.existingRow ?? { id: 'r1', keyword: 'k', match_type: 'contains', response_type: 'text', response_content: 'c', is_active: 1 };
          if (sql.startsWith('SELECT id FROM auto_replies WHERE id')) return opts.existingRow === null ? null : { id: 'r1' };
          return null;
        },
        async all() {
          if (sql.includes('SELECT keyword, match_type FROM auto_replies')) {
            return { results: opts.existingKeywords ?? [], success: true };
          }
          return { results: [], success: true };
        },
        async run() {
          calls.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
      });
      const stmt = {
        bind(...args: unknown[]) {
          return make(args);
        },
        ...make([]),
      };
      return stmt as unknown as D1PreparedStatement;
    },
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      batched.push(stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
      return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  } as unknown as D1Database;
  return { db, calls, batched };
}

function makeApp() {
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', autoReplies);
  return app;
}

function req(method: string, path: string, body?: unknown) {
  return [
    path,
    {
      method,
      headers: { Authorization: `Bearer ${TEST_API_KEY}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  ] as const;
}

function envOf(db: D1Database): Env['Bindings'] {
  return { DB: db, API_KEY: TEST_API_KEY } as unknown as Env['Bindings'];
}

describe('/api/auto-replies CRUD guards', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST falls back to text for an unknown responseType (enum allowlist)', async () => {
    const { db, calls } = makeDb();
    const [p, init] = req('POST', '/api/auto-replies', {
      keyword: '営業時間',
      responseContent: '平日10-18時です',
      responseType: 'evil_custom_type',
    });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO auto_replies'));
    expect(insert?.binds[3]).toBe('text'); // response_type
  });

  it('POST redacts 薬機 phrases in responseContent and returns warnings', async () => {
    const banned = PROHIBITED_PHRASES[0];
    const { db, calls } = makeDb();
    const [p, init] = req('POST', '/api/auto-replies', {
      keyword: '質問',
      responseContent: `これは${banned}です`,
    });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.length).toBeGreaterThan(0);
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO auto_replies'));
    expect(String(insert?.binds[4])).not.toContain(banned); // response_content redacted
  });

  it('PATCH rejects non-boolean isActive (null) with 400', async () => {
    const { db } = makeDb();
    const [p, init] = req('PATCH', '/api/auto-replies/r1', { isActive: null });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(400);
  });

  it('PATCH rejects whitespace-only keyword with 400 (not silent no-op)', async () => {
    const { db } = makeDb();
    const [p, init] = req('PATCH', '/api/auto-replies/r1', { keyword: '   ' });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auto-replies/batch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atomically creates all items via db.batch and reports created', async () => {
    const { db, batched } = makeDb();
    const [p, init] = req('POST', '/api/auto-replies/batch', {
      items: [
        { keyword: '営業時間', responseContent: '平日10-18時です', isActive: false },
        { keyword: '何時まで', responseContent: '平日10-18時です', isActive: false },
      ],
    });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { created: unknown[]; skipped: string[] } };
    expect(body.data.created).toHaveLength(2);
    expect(body.data.skipped).toEqual([]);
    expect(batched).toHaveLength(1); // 1 回の atomic batch
    expect(batched[0]).toHaveLength(2);
    expect(batched[0][0].binds[4]).toBe(0); // is_active=0 (gated 保存)
  });

  it('skips items whose (keyword, match_type) already exists — retry-safe', async () => {
    const { db, batched } = makeDb({
      existingKeywords: [{ keyword: '営業時間', match_type: 'contains' }],
    });
    const [p, init] = req('POST', '/api/auto-replies/batch', {
      items: [
        { keyword: '営業時間', responseContent: 'x' },
        { keyword: '何時まで', responseContent: 'x' },
      ],
    });
    const res = await makeApp().request(p, init, envOf(db));
    const body = (await res.json()) as { data: { created: Array<{ keyword: string }>; skipped: string[] } };
    expect(body.data.skipped).toEqual(['営業時間']);
    expect(body.data.created.map((c) => c.keyword)).toEqual(['何時まで']);
    expect(batched[0]).toHaveLength(1);
  });

  it('dedupes duplicates inside the payload', async () => {
    const { db, batched } = makeDb();
    const [p, init] = req('POST', '/api/auto-replies/batch', {
      items: [
        { keyword: '営業時間', responseContent: 'x' },
        { keyword: ' 営業時間 ', responseContent: 'x' },
      ],
    });
    const res = await makeApp().request(p, init, envOf(db));
    const body = (await res.json()) as { data: { created: unknown[] } };
    expect(body.data.created).toHaveLength(1);
    expect(batched[0]).toHaveLength(1);
  });

  it('rejects the whole batch (no writes) when one item is invalid', async () => {
    const { db, batched, calls } = makeDb();
    const [p, init] = req('POST', '/api/auto-replies/batch', {
      items: [
        { keyword: '営業時間', responseContent: 'x' },
        { keyword: '', responseContent: 'x' },
      ],
    });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(400);
    expect(batched).toHaveLength(0);
    expect(calls.filter((c) => c.sql.startsWith('INSERT'))).toHaveLength(0);
  });

  it('rejects more than 6 items', async () => {
    const { db } = makeDb();
    const items = Array.from({ length: 7 }, (_, i) => ({ keyword: `k${i}`, responseContent: 'x' }));
    const [p, init] = req('POST', '/api/auto-replies/batch', { items });
    const res = await makeApp().request(p, init, envOf(db));
    expect(res.status).toBe(400);
  });
});
