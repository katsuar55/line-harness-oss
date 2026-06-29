/**
 * faq-context (AI prompt の FAQ セクション動的生成 + fail-safe fallback) の単体テスト。
 *
 * 重要な不変条件:
 *   - D1 が空 / 読込エラーでも DEFAULT_FAQ_ENTRIES に fallback し、 従来挙動を壊さない。
 *   - 出力形式は旧ハードコードと同一 (「## よくある質問（FAQ）」 ヘッダ + 「Q.質問→ 回答」)。
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FAQ_ENTRIES,
  buildFaqSection,
  getDefaultFaqSection,
  getFaqSection,
} from '../services/faq-context.js';

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

function makeFakeDb(rows: FaqRow[]) {
  const prepare = (sql: string) => ({
    bind: (..._b: unknown[]) => ({
      async all<T>() {
        return { results: rows as unknown as T[] };
      },
    }),
    async all<T>() {
      let res = rows.slice();
      if (/is_active = 1/.test(sql)) res = res.filter((r) => r.is_active === 1);
      res.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      return { results: res as unknown as T[] };
    },
  });
  return { prepare } as unknown as D1Database;
}

const throwingDb = {
  prepare() {
    throw new Error('no such table: faq_items');
  },
} as unknown as D1Database;

describe('faq-context', () => {
  it('DEFAULT_FAQ_ENTRIES は 21 件 (現行ハードコードと同数)', () => {
    expect(DEFAULT_FAQ_ENTRIES).toHaveLength(21);
  });

  it('buildFaqSection: ヘッダと「Q.質問→ 回答」形式', () => {
    const s = buildFaqSection([{ question: '飲み方は？', answer: '水で', category: 'usage' }]);
    expect(s).toContain('## よくある質問（FAQ）');
    expect(s).toContain('Q.飲み方は？→ 水で');
  });

  it('buildFaqSection: 空配列なら DEFAULT に倒す (空セクションを返さない)', () => {
    const s = buildFaqSection([]);
    expect(s).toContain('## よくある質問（FAQ）');
    expect(s).toContain('Q.飲み方は？→');
  });

  it('getDefaultFaqSection: 全 default 質問を含む', () => {
    const s = getDefaultFaqSection();
    for (const e of DEFAULT_FAQ_ENTRIES) {
      expect(s).toContain(`Q.${e.question}→ ${e.answer}`);
    }
  });

  it('getFaqSection: D1 が空 → DEFAULT に fallback', async () => {
    const s = await getFaqSection(makeFakeDb([]));
    expect(s).toBe(getDefaultFaqSection());
  });

  it('getFaqSection: D1 に行があれば動的内容を使う', async () => {
    const now = '2026-06-30 10:00:00';
    const db = makeFakeDb([
      { id: '1', question: 'カスタム質問', answer: 'カスタム回答', category: 'x', sort_order: 10, is_active: 1, created_at: now, updated_at: now },
    ]);
    const s = await getFaqSection(db);
    expect(s).toContain('Q.カスタム質問→ カスタム回答');
    // default の固定文 (芸能人) は含まない = 動的セットに置き換わっている
    expect(s).not.toContain('Kep1er（公式ミューズ）');
  });

  it('getFaqSection: 読込エラー (テーブル欠落等) でも throw せず DEFAULT に fallback', async () => {
    const s = await getFaqSection(throwingDb);
    expect(s).toBe(getDefaultFaqSection());
  });
});
