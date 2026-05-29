/**
 * Tests for @line-crm/db upsertFriend preservation semantics (= follow-funnel hardening、 2026-05-29)
 *
 * 予防 review (= friend-add funnel) で発見: profile 取得失敗時や LIFF 由来 null での re-follow で、
 * 既存 friend の display_name / picture_url / status_message を null 上書きしてしまう bug
 * (= 旧実装 `'displayName' in input ? (input.displayName ?? null) : existing`)。
 * 修正後は `input.x ?? existing.x` で「null/undefined = 既存維持」 を保証。
 *
 * NOTE: 実 @line-crm/db を import (= vi.mock しない)。 in-memory D1 mock で UPDATE 結果を検証。
 */
import { describe, it, expect } from 'vitest';
import { upsertFriend, getFriendByLineUserId } from '@line-crm/db';

interface FriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  last_unfollowed_at: string | null;
  last_refollowed_at: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

function makeDb() {
  const byUser = new Map<string, FriendRow>();
  const byId = new Map<string, FriendRow>();

  function prepare(sql: string) {
    const p: unknown[] = [];
    const stmt = {
      bind(...args: unknown[]) {
        p.push(...args);
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        // 順序重要: "line_user_id = ?" は "id = ?" を部分文字列に含むため先に判定
        if (sql.includes('FROM friends') && sql.includes('line_user_id = ?')) {
          return ((byUser.get(p[0] as string) ?? null) as T) ?? null;
        }
        if (sql.includes('FROM friends') && sql.includes('id = ?')) {
          return ((byId.get(p[0] as string) ?? null) as T) ?? null;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[]; success: boolean }> {
        return { results: [], success: true };
      },
      async run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (sql.includes('INSERT INTO friends')) {
          // binds: id, line_user_id, display_name, picture_url, status_message, created_at, updated_at
          const row: FriendRow = {
            id: p[0] as string,
            line_user_id: p[1] as string,
            display_name: (p[2] as string | null) ?? null,
            picture_url: (p[3] as string | null) ?? null,
            status_message: (p[4] as string | null) ?? null,
            is_following: 1,
            last_unfollowed_at: null,
            last_refollowed_at: null,
            user_id: null,
            created_at: p[5] as string,
            updated_at: p[6] as string,
          };
          byUser.set(row.line_user_id, row);
          byId.set(row.id, row);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE friends') && sql.includes('line_user_id = ?')) {
          // binds: display_name, picture_url, status_message, now(refollow), now(updated), line_user_id
          const row = byUser.get(p[5] as string);
          if (row) {
            row.display_name = (p[0] as string | null) ?? null;
            row.picture_url = (p[1] as string | null) ?? null;
            row.status_message = (p[2] as string | null) ?? null;
            row.is_following = 1;
            row.updated_at = p[4] as string;
          }
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
    return stmt;
  }

  return { prepare } as unknown as D1Database;
}

describe('upsertFriend', () => {
  it('new friend: INSERT with provided fields', async () => {
    const db = makeDb();
    const f = await upsertFriend(db, {
      lineUserId: 'U1',
      displayName: 'Taro',
      pictureUrl: 'https://x/p.jpg',
      statusMessage: 'hi',
    });
    expect(f.display_name).toBe('Taro');
    expect(f.picture_url).toBe('https://x/p.jpg');
    expect(f.is_following).toBe(1);
  });

  it('re-follow with null fields PRESERVES existing (= profile fetch fail safe)', async () => {
    const db = makeDb();
    await upsertFriend(db, { lineUserId: 'U1', displayName: 'Taro', pictureUrl: 'p1', statusMessage: 's1' });
    // profile 取得失敗を模擬: 全 field null で再呼出
    await upsertFriend(db, { lineUserId: 'U1', displayName: null, pictureUrl: null, statusMessage: null });
    const f = await getFriendByLineUserId(db, 'U1');
    expect(f?.display_name).toBe('Taro'); // null 上書きされず維持
    expect(f?.picture_url).toBe('p1');
    expect(f?.status_message).toBe('s1');
  });

  it('re-follow with new values UPDATES', async () => {
    const db = makeDb();
    await upsertFriend(db, { lineUserId: 'U1', displayName: 'Taro' });
    await upsertFriend(db, { lineUserId: 'U1', displayName: 'Jiro' });
    expect((await getFriendByLineUserId(db, 'U1'))?.display_name).toBe('Jiro');
  });

  it('omitted field (undefined) PRESERVES existing', async () => {
    const db = makeDb();
    await upsertFriend(db, { lineUserId: 'U1', displayName: 'Taro', pictureUrl: 'p1', statusMessage: 's1' });
    // displayName のみ更新、 picture/status は省略 → 維持
    await upsertFriend(db, { lineUserId: 'U1', displayName: 'Jiro' });
    const f = await getFriendByLineUserId(db, 'U1');
    expect(f?.display_name).toBe('Jiro');
    expect(f?.picture_url).toBe('p1');
    expect(f?.status_message).toBe('s1');
  });
});
