/**
 * Tests for friends プロフィール一括補完 — 第2波-③ 支援 (2026-07-02)
 *
 * Covers:
 *   service (refreshMissingFriendProfiles):
 *     - 補完成功 (display_name/picture/status 更新・remaining 減少)
 *     - 404/403 = 永続失敗マーク (metadata) で選定から除外 (auto ループ収束)
 *     - 429/5xx = 一時失敗はマークせず retry 対象のまま
 *     - 空 displayName (200) は永続マーク
 *     - 選定述語 (display_name 設定済 / unfollow / 失敗マーク済 は選ばれない)
 *     - limit 遵守・D1 書込は batch 集約
 *   route (POST /api/admin/friends/refresh-profiles):
 *     - 401 / happy path (LineClient + global fetch stub)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  refreshMissingFriendProfiles,
  FRIEND_PROFILE_PENDING_PREDICATE,
} from '../services/friend-profile-refresh.js';
import { friendsProfileAdmin } from '../routes/friends-profile-admin.js';

const API_KEY = 'test-api-key';

// ============================================================
// Fake D1 (選定述語 + batch を模す)
// ============================================================

interface FriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url?: string | null;
  status_message?: string | null;
  is_following: number;
  metadata: string | null;
  created_at: string;
}

class FakeDb {
  friends: FriendRow[];
  batchCalls = 0;

  constructor(friends: FriendRow[]) {
    this.friends = friends;
  }

  pending(): FriendRow[] {
    return this.friends
      .filter(
        (f) =>
          f.is_following === 1 &&
          f.line_user_id !== '' &&
          (f.display_name === null || f.display_name === '') &&
          !(f.metadata ?? '').includes('profile_refresh_failed_at'),
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  prepare(sql: string) {
    const self = this;
    const make = (params: unknown[]) => ({
      __sql: sql,
      __params: params,
      bind: (...p: unknown[]) => make(p),
      async all() {
        if (sql.includes('SELECT id, line_user_id')) {
          const limit = Number(params[0] ?? 10);
          return {
            results: self.pending().slice(0, limit).map((f) => ({ id: f.id, line_user_id: f.line_user_id })),
          };
        }
        return { results: [] };
      },
      async first() {
        if (sql.includes('COUNT(*) AS n')) return { n: self.pending().length };
        return null;
      },
      async run() {
        self.apply(sql, params);
        return { success: true, meta: { changes: 1 } };
      },
    });
    return make([]);
  }

  async batch(stmts: Array<{ __sql: string; __params: unknown[] }>) {
    this.batchCalls += 1;
    for (const s of stmts) this.apply(s.__sql, s.__params);
    return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
  }

  apply(sql: string, params: unknown[]) {
    if (sql.includes('SET display_name = ?')) {
      const [name, pic, status, , id] = params;
      const f = this.friends.find((x) => x.id === id);
      if (f) {
        f.display_name = String(name);
        f.picture_url = pic as string | null;
        f.status_message = status as string | null;
      }
      return;
    }
    if (sql.includes('json_patch')) {
      const [patch, , id] = params;
      const f = this.friends.find((x) => x.id === id);
      if (f) {
        const base = f.metadata && f.metadata !== '' ? (JSON.parse(f.metadata) as Record<string, unknown>) : {};
        f.metadata = JSON.stringify({ ...base, ...(JSON.parse(String(patch)) as Record<string, unknown>) });
      }
    }
  }
}

function friend(overrides: Partial<FriendRow> = {}): FriendRow {
  return {
    id: 'f1',
    line_user_id: 'U-1',
    display_name: null,
    is_following: 1,
    metadata: null,
    created_at: '2026-06-29T00:00:00.000+09:00',
    ...overrides,
  };
}

function httpError(status: number): Error & { status: number } {
  const err = new Error(`LINE API error: ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

// ============================================================
// service
// ============================================================

describe('refreshMissingFriendProfiles', () => {
  it('プロフィール取得成功で display_name を補完し remaining が減る', async () => {
    const db = new FakeDb([
      friend({ id: 'f1', line_user_id: 'U-1' }),
      friend({ id: 'f2', line_user_id: 'U-2', created_at: '2026-06-29T00:00:01.000+09:00' }),
    ]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async (uid) => ({ displayName: `名前-${uid}`, pictureUrl: 'https://p/x.jpg' }) },
      { limit: 10 },
    );
    expect(r.selected).toBe(2);
    expect(r.updated).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.remaining).toBe(0);
    expect(db.friends[0].display_name).toBe('名前-U-1');
    expect(db.friends[0].picture_url).toBe('https://p/x.jpg');
    // D1 書込は batch 1 回に集約
    expect(db.batchCalls).toBe(1);
  });

  it('404 は永続失敗マークで選定から除外される (auto ループ収束)', async () => {
    const db = new FakeDb([friend()]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => { throw httpError(404); } },
      { limit: 10 },
    );
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(0); // マークにより pending から抜けた
    expect(db.friends[0].display_name).toBeNull();
    expect(db.friends[0].metadata).toContain('profile_refresh_failed_at');
    expect(db.friends[0].metadata).toContain('"profile_refresh_failed_status":"404"');
  });

  it('一時失敗 (5xx) はマークせず retry 対象に残る', async () => {
    const db = new FakeDb([friend()]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => { throw httpError(500); } },
      { limit: 10 },
    );
    expect(r.transientErrors).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.remaining).toBe(1); // pending のまま
    expect(db.friends[0].metadata).toBeNull();
  });

  it('200 だが displayName 空は永続マーク (再選択の無限化防止)', async () => {
    const db = new FakeDb([friend()]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => ({ displayName: '   ' }) },
      { limit: 10 },
    );
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(0);
    expect(db.friends[0].metadata).toContain('empty_profile');
  });

  it('display_name 設定済 / unfollow / 失敗マーク済 は選定されない', async () => {
    const db = new FakeDb([
      friend({ id: 'f-named', display_name: '既存名' }),
      friend({ id: 'f-unfollow', is_following: 0 }),
      friend({ id: 'f-marked', metadata: '{"profile_refresh_failed_at":"2026-07-01"}' }),
      friend({ id: 'f-target' }),
    ]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => ({ displayName: 'X' }) },
      { limit: 10 },
    );
    expect(r.selected).toBe(1);
    expect(db.friends.find((f) => f.id === 'f-target')?.display_name).toBe('X');
    expect(db.friends.find((f) => f.id === 'f-named')?.display_name).toBe('既存名');
  });

  it('limit を超えて選定しない', async () => {
    const db = new FakeDb(
      Array.from({ length: 5 }, (_, i) =>
        friend({ id: `f${i}`, line_user_id: `U-${i}`, created_at: `2026-06-29T00:00:0${i}.000+09:00` }),
      ),
    );
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => ({ displayName: 'X' }) },
      { limit: 2 },
    );
    expect(r.selected).toBe(2);
    expect(r.remaining).toBe(3);
  });

  // ===== adversarial review 反映の regression =====

  it('review MEDIUM: 選定述語の本文 pinning (FakeDb は実 SQL を評価しないため drift をここで検知)', () => {
    expect(FRIEND_PROFILE_PENDING_PREDICATE).toContain('is_following = 1');
    expect(FRIEND_PROFILE_PENDING_PREDICATE).toContain("display_name IS NULL OR display_name = ''");
    // 失敗マーク除外 (auto ループ収束の要)
    expect(FRIEND_PROFILE_PENDING_PREDICATE).toContain("json_extract(metadata, '$.profile_refresh_failed_at') IS NULL");
    // 不正 JSON ガード (1 行の malformed metadata で全呼び出し 500 を防ぐ)
    expect(FRIEND_PROFILE_PENDING_PREDICATE).toContain('NOT json_valid(metadata)');
  });

  it('review MEDIUM: 401 (token 異常) は呼び出しを即中断し aborted を返す (loop 不収束防止)', async () => {
    const db = new FakeDb([
      friend({ id: 'f1', line_user_id: 'U-1' }),
      friend({ id: 'f2', line_user_id: 'U-2', created_at: '2026-06-29T00:00:01.000+09:00' }),
    ]);
    let calls = 0;
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: async () => { calls += 1; throw httpError(401); } },
      { limit: 10 },
    );
    expect(r.aborted).toBe('401');
    expect(calls).toBe(1); // 2 人目へ追い打ちしない
    expect(r.failed).toBe(0); // 永続マークもしない (token 復旧後に再処理可能)
    expect(r.remaining).toBe(2);
  });

  it('review LOW: fetch timeout は呼び出しを中断し aborted=timeout を返す', async () => {
    const db = new FakeDb([friend()]);
    const r = await refreshMissingFriendProfiles(
      db as unknown as D1Database,
      { getProfileImpl: () => new Promise(() => { /* never resolves */ }) },
      { limit: 10, fetchTimeoutMs: 20 },
    );
    expect(r.aborted).toBe('timeout');
    expect(r.remaining).toBe(1);
  });
});

// ============================================================
// route
// ============================================================

function createApp() {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    if (!auth || auth !== `Bearer ${API_KEY}`) return c.json({ error: 'Unauthorized' }, 401);
    return next();
  });
  app.route('/', friendsProfileAdmin);
  return app;
}

describe('POST /api/admin/friends/refresh-profiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires auth (401)', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/friends/refresh-profiles',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { DB: new FakeDb([]), LINE_CHANNEL_ACCESS_TOKEN: 'tok' },
    );
    expect(res.status).toBe(401);
  });

  it('happy path: LINE profile を取得して補完する', async () => {
    const db = new FakeDb([friend()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ displayName: '田中照美', pictureUrl: 'https://p/t.jpg' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/friends/refresh-profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ limit: 5 }),
      },
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'tok' },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { updated: number; remaining: number } };
    expect(json.success).toBe(true);
    expect(json.data.updated).toBe(1);
    expect(json.data.remaining).toBe(0);
    expect(db.friends[0].display_name).toBe('田中照美');
  });

  it('review LOW: body が JSON literal null でも 500 にならず default limit で処理する', async () => {
    const db = new FakeDb([]);
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/admin/friends/refresh-profiles',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: 'null',
      },
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'tok' },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { selected: number } };
    expect(json.success).toBe(true);
    expect(json.data.selected).toBe(0);
  });
});
