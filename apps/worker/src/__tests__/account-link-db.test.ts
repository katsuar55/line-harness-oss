/**
 * Tests for @line-crm/db account-link (= 自前 friend↔Shopify customer 連携 Option B、 2026-06-06)
 *
 * 実 @line-crm/db 関数を in-memory fake D1 で直接 test (= vi.mock しない)。
 * カバー:
 *   - insertAccountLinkCode: attempts=0 / consumed_at=NULL で発行
 *   - getActiveAccountLinkCode: 未消費 + 未失効 + 最新 1 件 (= 消費済/失効は除外)
 *   - countRecentAccountLinkCodes: created_at 窓の件数 (= rate-limit)
 *   - incrementAccountLinkAttempts: atomic +1 + 新値返却
 *   - consumeAccountLinkCode: CAS single-use (= 2 回目は consumed=false)
 *   - invalidatePriorAccountLinkCodes: 同 (friend,email) の active を一括無効化
 */
import { describe, it, expect } from 'vitest';
import {
  insertAccountLinkCode,
  invalidatePriorAccountLinkCodes,
  countRecentAccountLinkCodes,
  getActiveAccountLinkCode,
  incrementAccountLinkAttempts,
  consumeAccountLinkCode,
  type AccountLinkCodeRow,
} from '@line-crm/db';

// ============================================================
// in-memory fake D1 (= account_link_codes の SQL を解釈)
// ============================================================

function makeDb(seed: AccountLinkCodeRow[] = []): D1Database & { rows: AccountLinkCodeRow[] } {
  const rows = seed.map((r) => ({ ...r }));
  const db = {
    rows,
    prepare(sql: string) {
      const stmt = {
        _b: [] as unknown[],
        bind(...args: unknown[]) {
          stmt._b = args;
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          // COUNT(*) — rate-limit 窓
          if (sql.includes('SELECT COUNT(*)') && sql.includes('account_link_codes')) {
            const [friendId, since] = stmt._b as [string, string];
            const count = rows.filter((r) => r.friend_id === friendId && r.created_at >= since).length;
            return { count } as unknown as T;
          }
          // UPDATE ... RETURNING attempts (= atomic increment、 .first() で読む)
          if (sql.includes('UPDATE account_link_codes') && sql.includes('RETURNING attempts')) {
            const id = stmt._b[0] as string;
            const r = rows.find((x) => x.id === id);
            if (r) { r.attempts += 1; return { attempts: r.attempts } as unknown as T; }
            return null;
          }
          // SELECT * FROM ... active 逆引き
          if (sql.includes('SELECT * FROM account_link_codes')) {
            const [friendId, email, now] = stmt._b as [string, string, string];
            const matches = rows
              .filter(
                (r) =>
                  r.friend_id === friendId &&
                  r.email === email &&
                  r.consumed_at === null &&
                  r.expires_at > now,
              )
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // created_at DESC
            return (matches[0] ? { ...matches[0] } : null) as unknown as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          // INSERT
          if (sql.includes('INSERT INTO account_link_codes')) {
            const [id, friendId, email, codeHash, expiresAt, createdAt] = stmt._b as [
              string, string, string, string, string, string,
            ];
            rows.push({
              id,
              friend_id: friendId,
              email,
              code_hash: codeHash,
              expires_at: expiresAt,
              attempts: 0,
              consumed_at: null,
              created_at: createdAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          // consume CAS (WHERE id = ? AND consumed_at IS NULL)
          if (sql.includes('SET consumed_at = ?') && sql.includes('WHERE id = ?')) {
            const [consumedAt, id] = stmt._b as [string, string];
            const r = rows.find((x) => x.id === id && x.consumed_at === null);
            if (r) {
              r.consumed_at = consumedAt;
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          // invalidatePrior (WHERE friend_id = ? AND email = ? AND consumed_at IS NULL)
          if (sql.includes('SET consumed_at = ?') && sql.includes('friend_id = ?')) {
            const [consumedAt, friendId, email] = stmt._b as [string, string, string];
            let changes = 0;
            for (const r of rows) {
              if (r.friend_id === friendId && r.email === email && r.consumed_at === null) {
                r.consumed_at = consumedAt;
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
  return db as unknown as D1Database & { rows: AccountLinkCodeRow[] };
}

function row(over: Partial<AccountLinkCodeRow> & { id: string }): AccountLinkCodeRow {
  return {
    id: over.id,
    friend_id: over.friend_id ?? 'f1',
    email: over.email ?? 'a@x.com',
    code_hash: over.code_hash ?? 'hash',
    expires_at: over.expires_at ?? '2026-06-06T10:05:00.000Z',
    attempts: over.attempts ?? 0,
    consumed_at: over.consumed_at ?? null,
    created_at: over.created_at ?? '2026-06-06T10:00:00.000Z',
  };
}

const NOW = '2026-06-06T10:01:00.000Z';

describe('insertAccountLinkCode', () => {
  it('attempts=0 / consumed_at=NULL で発行', async () => {
    const db = makeDb();
    await insertAccountLinkCode(db, {
      id: 'c1',
      friendId: 'f1',
      email: 'a@x.com',
      codeHash: 'h1',
      expiresAt: '2026-06-06T10:05:00.000Z',
      createdAt: '2026-06-06T10:00:00.000Z',
    });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ id: 'c1', attempts: 0, consumed_at: null, code_hash: 'h1' });
  });
});

describe('getActiveAccountLinkCode', () => {
  it('未消費 + 未失効 → 返す', async () => {
    const db = makeDb([row({ id: 'c1' })]);
    const r = await getActiveAccountLinkCode(db, 'f1', 'a@x.com', NOW);
    expect(r?.id).toBe('c1');
  });

  it('消費済 → 除外 (null)', async () => {
    const db = makeDb([row({ id: 'c1', consumed_at: '2026-06-06T10:00:30.000Z' })]);
    expect(await getActiveAccountLinkCode(db, 'f1', 'a@x.com', NOW)).toBeNull();
  });

  it('失効済 (expires_at <= now) → 除外 (null)', async () => {
    const db = makeDb([row({ id: 'c1', expires_at: '2026-06-06T10:00:30.000Z' })]);
    expect(await getActiveAccountLinkCode(db, 'f1', 'a@x.com', NOW)).toBeNull();
  });

  it('複数 active → created_at 最新を返す', async () => {
    const db = makeDb([
      row({ id: 'old', created_at: '2026-06-06T09:00:00.000Z' }),
      row({ id: 'new', created_at: '2026-06-06T10:00:00.000Z' }),
    ]);
    const r = await getActiveAccountLinkCode(db, 'f1', 'a@x.com', NOW);
    expect(r?.id).toBe('new');
  });

  it('別 friend / 別 email は対象外', async () => {
    const db = makeDb([row({ id: 'c1', friend_id: 'f1', email: 'a@x.com' })]);
    expect(await getActiveAccountLinkCode(db, 'f2', 'a@x.com', NOW)).toBeNull();
    expect(await getActiveAccountLinkCode(db, 'f1', 'b@x.com', NOW)).toBeNull();
  });
});

describe('countRecentAccountLinkCodes', () => {
  it('created_at >= since の件数を返す (= rate-limit 窓)', async () => {
    const db = makeDb([
      row({ id: 'c1', created_at: '2026-06-06T10:00:00.000Z' }),
      row({ id: 'c2', created_at: '2026-06-06T10:30:00.000Z' }),
      row({ id: 'old', created_at: '2026-06-06T08:00:00.000Z' }),
    ]);
    expect(await countRecentAccountLinkCodes(db, 'f1', '2026-06-06T09:00:00.000Z')).toBe(2);
  });

  it('別 friend は数えない', async () => {
    const db = makeDb([
      row({ id: 'c1', friend_id: 'f1', created_at: '2026-06-06T10:00:00.000Z' }),
      row({ id: 'c2', friend_id: 'f2', created_at: '2026-06-06T10:00:00.000Z' }),
    ]);
    expect(await countRecentAccountLinkCodes(db, 'f1', '2026-06-06T09:00:00.000Z')).toBe(1);
  });

  it('消費済 / 失効済 code も数える (= spam 抑止: 送信実績で制限)', async () => {
    const db = makeDb([
      row({ id: 'active', friend_id: 'f1', created_at: '2026-06-06T10:00:00.000Z' }),
      row({ id: 'consumed', friend_id: 'f1', consumed_at: '2026-06-06T10:01:00.000Z', created_at: '2026-06-06T10:02:00.000Z' }),
      row({ id: 'expired', friend_id: 'f1', expires_at: '2026-06-06T10:00:30.000Z', created_at: '2026-06-06T10:03:00.000Z' }),
    ]);
    expect(await countRecentAccountLinkCodes(db, 'f1', '2026-06-06T09:00:00.000Z')).toBe(3);
  });
});

describe('incrementAccountLinkAttempts', () => {
  it('atomic +1 + 新値を返す', async () => {
    const db = makeDb([row({ id: 'c1', attempts: 2 })]);
    expect(await incrementAccountLinkAttempts(db, 'c1')).toBe(3);
    expect(db.rows[0].attempts).toBe(3);
  });
});

describe('consumeAccountLinkCode', () => {
  it('1 回目 consumed=true、 2 回目 consumed=false (= CAS single-use)', async () => {
    const db = makeDb([row({ id: 'c1' })]);
    const first = await consumeAccountLinkCode(db, 'c1', NOW);
    expect(first.consumed).toBe(true);
    expect(db.rows[0].consumed_at).toBe(NOW);
    const second = await consumeAccountLinkCode(db, 'c1', '2026-06-06T10:02:00.000Z');
    expect(second.consumed).toBe(false);
    expect(db.rows[0].consumed_at).toBe(NOW); // 上書きされない
  });
});

describe('invalidatePriorAccountLinkCodes', () => {
  it('同 (friend,email) の active を一括無効化 (= 最新発行前のクリーンアップ)', async () => {
    const db = makeDb([
      row({ id: 'a1', friend_id: 'f1', email: 'a@x.com' }),
      row({ id: 'a2', friend_id: 'f1', email: 'a@x.com' }),
      row({ id: 'other-email', friend_id: 'f1', email: 'b@x.com' }),
      row({ id: 'other-friend', friend_id: 'f2', email: 'a@x.com' }),
    ]);
    await invalidatePriorAccountLinkCodes(db, 'f1', 'a@x.com', NOW);
    expect(db.rows.find((r) => r.id === 'a1')?.consumed_at).toBe(NOW);
    expect(db.rows.find((r) => r.id === 'a2')?.consumed_at).toBe(NOW);
    expect(db.rows.find((r) => r.id === 'other-email')?.consumed_at).toBeNull();
    expect(db.rows.find((r) => r.id === 'other-friend')?.consumed_at).toBeNull();
  });
});
