/**
 * faq_items CRUD (packages/db/src/faq.ts) の behavioral テスト。
 * migration 029 で本番に既存の faq_items を再利用する FAQ動的化 PR1 の基盤。
 * 実挙動 (insert→list→update→delete→count→bulk) を in-memory fake D1 で検証する。
 */
import { describe, it, expect } from 'vitest';
import {
  listActiveFaqItems,
  listAllFaqItems,
  getFaqItemById,
  countFaqItems,
  createFaqItem,
  updateFaqItem,
  deleteFaqItem,
  bulkInsertFaqItems,
} from '@line-crm/db';

interface FaqRow {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  sort_order: number | null;
  is_active: number | null;
  created_at: string;
  updated_at: string;
}

/** faq_items の操作を最小限解釈する in-memory fake D1。 */
function makeFakeDb(initial: FaqRow[] = []) {
  let rows: FaqRow[] = initial.map((r) => ({ ...r }));
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const api = {
      bind: (...b: unknown[]) => {
        binds = b;
        return api;
      },
      async all<T>() {
        let res = rows.slice();
        if (/is_active = 1/.test(sql)) res = res.filter((r) => r.is_active === 1);
        res.sort(
          (a, b) =>
            (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
            (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0),
        );
        return { results: res as unknown as T[] };
      },
      async first<T>() {
        if (/COUNT\(\*\)/.test(sql)) return { n: rows.length } as unknown as T;
        if (/WHERE id = \?/.test(sql)) {
          const id = binds[binds.length - 1];
          return (rows.find((r) => r.id === id) ?? null) as unknown as T;
        }
        return null as unknown as T;
      },
      async run() {
        if (/^\s*INSERT INTO faq_items/.test(sql)) {
          const [id, question, answer, category, sort_order, is_active, created_at, updated_at] =
            binds as [string, string, string, string, number, number, string, string];
          rows.push({ id, question, answer, category, sort_order, is_active, created_at, updated_at });
          return { meta: { changes: 1 } };
        }
        if (/^\s*UPDATE faq_items/.test(sql)) {
          const id = binds[binds.length - 1];
          const setPart = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
          const cols = setPart.split(',').map((s) => s.trim().split('=')[0].trim());
          const idx = rows.findIndex((r) => r.id === id);
          if (idx === -1) return { meta: { changes: 0 } };
          const row: FaqRow = { ...rows[idx] };
          cols.forEach((col, i) => {
            (row as unknown as Record<string, unknown>)[col] = binds[i];
          });
          rows[idx] = row;
          return { meta: { changes: 1 } };
        }
        if (/^\s*DELETE FROM faq_items/.test(sql)) {
          const id = binds[binds.length - 1];
          const before = rows.length;
          rows = rows.filter((r) => r.id !== id);
          return { meta: { changes: before - rows.length } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return api;
  };
  return { db: { prepare } as unknown as D1Database, getRows: () => rows };
}

describe('faq CRUD', () => {
  it('createFaqItem: id/timestamp 生成・default 正規化 (category=general, isActive=true)', async () => {
    const { db } = makeFakeDb();
    const item = await createFaqItem(db, { question: '飲み方は？', answer: '水で' });
    expect(item.id).toBeTruthy();
    expect(item.category).toBe('general');
    expect(item.isActive).toBe(true);
    expect(item.sortOrder).toBe(0);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('listAllFaqItems: 追加した行を返す (inactive 含む)', async () => {
    const { db } = makeFakeDb();
    await createFaqItem(db, { question: 'q1', answer: 'a1', sortOrder: 20 });
    await createFaqItem(db, { question: 'q2', answer: 'a2', sortOrder: 10, isActive: false });
    const all = await listAllFaqItems(db);
    expect(all).toHaveLength(2);
    // sort_order ASC
    expect(all[0].question).toBe('q2');
    expect(all[1].question).toBe('q1');
  });

  it('listActiveFaqItems: is_active=1 のみ返す', async () => {
    const { db } = makeFakeDb();
    await createFaqItem(db, { question: 'active', answer: 'a', isActive: true });
    await createFaqItem(db, { question: 'hidden', answer: 'a', isActive: false });
    const active = await listActiveFaqItems(db);
    expect(active.map((x) => x.question)).toEqual(['active']);
  });

  it('updateFaqItem: 部分更新 + 存在しない id は null', async () => {
    const { db } = makeFakeDb();
    const item = await createFaqItem(db, { question: 'q', answer: 'a', category: 'usage' });
    const updated = await updateFaqItem(db, item.id, { answer: 'a2' });
    expect(updated?.answer).toBe('a2');
    expect(updated?.question).toBe('q'); // 未指定は維持
    expect(updated?.category).toBe('usage');
    const missing = await updateFaqItem(db, 'nope', { answer: 'x' });
    expect(missing).toBeNull();
  });

  it('updateFaqItem: isActive=false で非表示化', async () => {
    const { db } = makeFakeDb();
    const item = await createFaqItem(db, { question: 'q', answer: 'a' });
    const updated = await updateFaqItem(db, item.id, { isActive: false });
    expect(updated?.isActive).toBe(false);
    const active = await listActiveFaqItems(db);
    expect(active).toHaveLength(0);
  });

  it('deleteFaqItem: 削除で true / 不在で false', async () => {
    const { db } = makeFakeDb();
    const item = await createFaqItem(db, { question: 'q', answer: 'a' });
    expect(await deleteFaqItem(db, item.id)).toBe(true);
    expect(await deleteFaqItem(db, item.id)).toBe(false);
    expect(await countFaqItems(db)).toBe(0);
  });

  it('countFaqItems / bulkInsertFaqItems', async () => {
    const { db } = makeFakeDb();
    expect(await countFaqItems(db)).toBe(0);
    const n = await bulkInsertFaqItems(db, [
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: 'a2' },
    ]);
    expect(n).toBe(2);
    expect(await countFaqItems(db)).toBe(2);
  });

  it('getFaqItemById: 取得 / 不在は null', async () => {
    const { db } = makeFakeDb();
    const item = await createFaqItem(db, { question: 'q', answer: 'a' });
    expect((await getFaqItemById(db, item.id))?.question).toBe('q');
    expect(await getFaqItemById(db, 'x')).toBeNull();
  });
});
