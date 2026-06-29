/**
 * FAQ 管理 route (routes/faq-admin.ts) の behavioral + 統合静的ガード。
 * - CRUD / seed の挙動を in-memory fake D1 で検証 (handler ロジック)。
 * - auth skip が HTML ページのみ (= /api/admin/faq* は API_KEY 保護のまま) を静的ガードで担保
 *   ([[feedback_auth_skiplist_method_independent]] の method 非依存 skip 穴を作らない)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { faqAdmin } from '../routes/faq-admin.js';

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

function makeFakeDb(
  initial: FaqRow[] = [],
  unanswered: Array<{ question: string; count: number; lastAskedAt: string }> = [],
) {
  let rows: FaqRow[] = initial.map((r) => ({ ...r }));
  const prepare = (sql: string) => {
    let binds: unknown[] = [];
    const api = {
      bind: (...b: unknown[]) => {
        binds = b;
        return api;
      },
      async all<T>() {
        if (/FROM conversation_logs/.test(sql)) return { results: unanswered as unknown as T[] };
        let res = rows.slice();
        if (/is_active = 1/.test(sql)) res = res.filter((r) => r.is_active === 1);
        res.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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

const jsonInit = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('faq-admin route — CRUD/seed 挙動', () => {
  it('GET /api/admin/faq: 空一覧', async () => {
    const { db } = makeFakeDb();
    const res = await faqAdmin.request('/api/admin/faq', {}, { DB: db });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { items: unknown[]; count: number } };
    expect(j.data.count).toBe(0);
  });

  it('POST /api/admin/faq: 作成 → GET に反映', async () => {
    const { db } = makeFakeDb();
    const res = await faqAdmin.request('/api/admin/faq', jsonInit('POST', { question: 'q', answer: 'a' }), { DB: db });
    expect(res.status).toBe(200);
    const list = await faqAdmin.request('/api/admin/faq', {}, { DB: db });
    const j = (await list.json()) as { data: { count: number } };
    expect(j.data.count).toBe(1);
  });

  it('POST /api/admin/faq: answer 欠落は 400', async () => {
    const { db } = makeFakeDb();
    const res = await faqAdmin.request('/api/admin/faq', jsonInit('POST', { question: 'q' }), { DB: db });
    expect(res.status).toBe(400);
  });

  it('POST /api/admin/faq/seed: 空なら 21 件投入、再実行は skip (冪等)', async () => {
    const { db } = makeFakeDb();
    const res = await faqAdmin.request('/api/admin/faq/seed', jsonInit('POST'), { DB: db });
    const j = (await res.json()) as { data: { seeded: number; skipped: boolean } };
    expect(j.data.seeded).toBe(21);
    expect(j.data.skipped).toBe(false);
    const again = await faqAdmin.request('/api/admin/faq/seed', jsonInit('POST'), { DB: db });
    const j2 = (await again.json()) as { data: { seeded: number; skipped: boolean } };
    expect(j2.data.skipped).toBe(true);
    expect(j2.data.seeded).toBe(0);
  });

  it('PUT /api/admin/faq/:id: 既存は更新、不在は 404', async () => {
    const { db } = makeFakeDb();
    const created = await (await faqAdmin.request('/api/admin/faq', jsonInit('POST', { question: 'q', answer: 'a' }), { DB: db })).json() as { data: { id: string } };
    const ok = await faqAdmin.request(`/api/admin/faq/${created.data.id}`, jsonInit('PUT', { answer: 'a2' }), { DB: db });
    expect(ok.status).toBe(200);
    const miss = await faqAdmin.request('/api/admin/faq/none', jsonInit('PUT', { answer: 'x' }), { DB: db });
    expect(miss.status).toBe(404);
  });

  it('DELETE /api/admin/faq/:id: 既存は削除、不在は 404', async () => {
    const { db } = makeFakeDb();
    const created = await (await faqAdmin.request('/api/admin/faq', jsonInit('POST', { question: 'q', answer: 'a' }), { DB: db })).json() as { data: { id: string } };
    const ok = await faqAdmin.request(`/api/admin/faq/${created.data.id}`, jsonInit('DELETE'), { DB: db });
    expect(ok.status).toBe(200);
    const miss = await faqAdmin.request('/api/admin/faq/none', jsonInit('DELETE'), { DB: db });
    expect(miss.status).toBe(404);
  });

  it('GET /admin/faq: 管理 HTML を返す', async () => {
    const { db } = makeFakeDb();
    const res = await faqAdmin.request('/admin/faq', {}, { DB: db });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('FAQ 管理');
  });

  it('GET /api/admin/faq/unanswered: fallback 質問を頻度順で返す (/:id と衝突しない)', async () => {
    const { db } = makeFakeDb([], [
      { question: '配合量は？', count: 4, lastAskedAt: '2026-06-30T10:00:00.000' },
      { question: '海外発送は？', count: 2, lastAskedAt: '2026-06-29T10:00:00.000' },
    ]);
    const res = await faqAdmin.request('/api/admin/faq/unanswered?days=30&min=1&limit=10', {}, { DB: db });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { data: { questions: Array<{ question: string; count: number }> } };
    expect(j.data.questions).toHaveLength(2);
    expect(j.data.questions[0].question).toBe('配合量は？');
    expect(j.data.questions[0].count).toBe(4);
  });
});

// ─── 統合 静的ガード ───
const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (rel: string): string => readFileSync(join(root, '..', rel), 'utf8');

describe('faq-admin 統合', () => {
  const adminRoute = readSrc('routes/faq-admin.ts');
  const auth = readSrc('middleware/auth.ts');
  const index = readSrc('index.ts');
  const aiResponse = readSrc('services/ai-response.ts');

  it('route に CRUD API + seed + HTML ページ', () => {
    expect(adminRoute).toContain("'/api/admin/faq'");
    expect(adminRoute).toContain("'/api/admin/faq/seed'");
    expect(adminRoute).toContain("'/api/admin/faq/:id'");
    expect(adminRoute).toContain("'/admin/faq'");
    expect(adminRoute).toContain('DEFAULT_FAQ_ENTRIES');
  });

  it('PR2: 未解決質問エンドポイント + 管理UI の FAQ化導線', () => {
    expect(adminRoute).toContain("'/api/admin/faq/unanswered'");
    expect(adminRoute).toContain('listUnansweredQuestions');
    expect(adminRoute).toContain('未解決のよくある質問');
    expect(adminRoute).toContain('faqify');
  });

  it('auth skip は HTML ページのみ。/api/admin/faq は API_KEY 保護のまま', () => {
    expect(auth).toContain("path === '/admin/faq'");
    expect(auth).not.toMatch(/path === '\/api\/admin\/faq'/);
  });

  it('index.ts が faqAdmin を route 登録', () => {
    expect(index).toContain("from './routes/faq-admin.js'");
    expect(index).toContain('app.route(\'/\', faqAdmin)');
  });

  it('ai-response が FAQ を動的注入 (getFaqSection) し fallback を持つ', () => {
    expect(aiResponse).toContain('getFaqSection');
    expect(aiResponse).toContain('getDefaultFaqSection');
  });
});
