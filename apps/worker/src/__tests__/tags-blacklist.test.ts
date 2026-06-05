/**
 * Tests for getFriendsByTag blacklist exclusion (H, 2026-06-06).
 *
 * 実 @line-crm/db 関数を SQL-capture mock db で直接 test (= scenarios-claim.test.ts と同様式)。
 * 全配信 (broadcast / A/B test) の tag 対象選択は getFriendsByTag を共有するため、
 * ここで is_blacklisted=0 除外を保証すれば tag 経路を一括でカバーできる。
 * segment-query.ts は既に COALESCE(is_blacklisted,0)=0 を全配信で適用済 (= consent/景表法)、
 * getFriendsByTag だけが除外していなかった不整合を塞ぐ。 vi.mock しない (= 実装を exercise)。
 */
import { describe, it, expect, vi } from 'vitest';
import { getFriendsByTag } from '@line-crm/db';

/** prepare された SQL を捕捉する mock db (.all は空 results)。 */
function makeCapturingDb(onSql: (sql: string) => void): D1Database {
  return {
    prepare: vi.fn((sql: string) => {
      onSql(sql);
      return {
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({ results: [], success: true })),
        })),
      };
    }),
  } as unknown as D1Database;
}

describe('getFriendsByTag — blacklist 除外', () => {
  it('SQL は COALESCE(is_blacklisted,0)=0 で除外する (consent/景表法)', async () => {
    let sql = '';
    const db = makeCapturingDb((s) => {
      sql = s;
    });

    await getFriendsByTag(db, 'tag-1');

    // 空白を畳んで部分一致を堅牢化
    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('is_blacklisted');
    expect(normalized).toContain('COALESCE(f.is_blacklisted, 0) = 0');
  });

  it('既存の tag JOIN / following 並びは維持する (回帰防止)', async () => {
    let sql = '';
    const db = makeCapturingDb((s) => {
      sql = s;
    });

    await getFriendsByTag(db, 'tag-1');

    const normalized = sql.replace(/\s+/g, ' ');
    expect(normalized).toContain('FROM friends f');
    expect(normalized).toContain('INNER JOIN friend_tags ft ON ft.friend_id = f.id');
    expect(normalized).toContain('WHERE ft.tag_id = ?');
    expect(normalized).toContain('ORDER BY f.created_at DESC');
  });
});
