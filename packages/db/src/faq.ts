/**
 * faq_items CRUD (= 管理画面から編集可能な FAQ、 migration 029 で定義済の既存テーブルを再利用)
 *
 * 用途 (2026-06-30 FAQ動的化 PR1):
 *   - AI system prompt の「よくある質問」 を D1 から動的に注入する (旧: ai-response.ts ハードコード)。
 *   - LIFF portal の FAQ タブ (`/api/liff/faq`、 liff-portal.ts) も同テーブルを読む (= 一元管理)。
 *   - 管理 CRUD (routes/faq-admin.ts) で運用者が deploy なしに追加・編集できる。
 *
 * 本ファイルは純 D1 CRUD のみ (= worker 非依存・テスト容易)。 id / timestamp は内部生成。
 * テーブルは migration 029 で本番に既存のため、 新規 migration は不要。
 */

export interface FaqItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FaqItemRow {
  id: string;
  question: string;
  answer: string;
  category: string | null;
  sort_order: number | null;
  is_active: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = 'id, question, answer, category, sort_order, is_active, created_at, updated_at';

function rowToFaqItem(r: FaqItemRow): FaqItem {
  return {
    id: r.id,
    question: r.question,
    answer: r.answer,
    category: r.category ?? 'general',
    sortOrder: r.sort_order ?? 0,
    isActive: (r.is_active ?? 1) === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** JST 'YYYY-MM-DD HH:MM:SS' (= 既存 brand_config 等と同形式)。 */
function nowJst(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/** is_active=1 のみ、 表示順 (sort_order ASC, created_at ASC)。 liff-portal の FAQ タブと同一順序。 */
export async function listActiveFaqItems(db: D1Database): Promise<FaqItem[]> {
  const res = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM faq_items
        WHERE is_active = 1
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .all<FaqItemRow>();
  return (res.results ?? []).map(rowToFaqItem);
}

/** 全件 (inactive 含む)、 管理画面用。 */
export async function listAllFaqItems(db: D1Database): Promise<FaqItem[]> {
  const res = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM faq_items
        ORDER BY sort_order ASC, created_at ASC`,
    )
    .all<FaqItemRow>();
  return (res.results ?? []).map(rowToFaqItem);
}

export async function getFaqItemById(db: D1Database, id: string): Promise<FaqItem | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM faq_items WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<FaqItemRow>();
  return row ? rowToFaqItem(row) : null;
}

/** faq_items の総数 (seed 冪等判定用)。 */
export async function countFaqItems(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM faq_items`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface CreateFaqItemInput {
  question: string;
  answer: string;
  category?: string;
  sortOrder?: number;
  isActive?: boolean;
}

/** 1 件追加。 id / timestamp は内部生成し、 作成された FaqItem を返す。 */
export async function createFaqItem(db: D1Database, input: CreateFaqItemInput): Promise<FaqItem> {
  const id = crypto.randomUUID();
  const now = nowJst();
  const item: FaqItem = {
    id,
    question: input.question,
    answer: input.answer,
    category: input.category && input.category.trim() ? input.category.trim() : 'general',
    sortOrder: Number.isFinite(input.sortOrder) ? Math.trunc(input.sortOrder as number) : 0,
    isActive: input.isActive !== false,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .prepare(
      `INSERT INTO faq_items (id, question, answer, category, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.question,
      item.answer,
      item.category,
      item.sortOrder,
      item.isActive ? 1 : 0,
      item.createdAt,
      item.updatedAt,
    )
    .run();
  return item;
}

export interface UpdateFaqItemInput {
  question?: string;
  answer?: string;
  category?: string;
  sortOrder?: number;
  isActive?: boolean;
}

/**
 * 部分更新。 指定された field のみ SET し updated_at を更新する。
 * 対象が無ければ null を返す (= 404 判定用)。
 */
export async function updateFaqItem(
  db: D1Database,
  id: string,
  patch: UpdateFaqItemInput,
): Promise<FaqItem | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.question !== undefined) {
    sets.push('question = ?');
    binds.push(patch.question);
  }
  if (patch.answer !== undefined) {
    sets.push('answer = ?');
    binds.push(patch.answer);
  }
  if (patch.category !== undefined) {
    sets.push('category = ?');
    binds.push(patch.category.trim() || 'general');
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    binds.push(Number.isFinite(patch.sortOrder) ? Math.trunc(patch.sortOrder) : 0);
  }
  if (patch.isActive !== undefined) {
    sets.push('is_active = ?');
    binds.push(patch.isActive ? 1 : 0);
  }
  // 変更が無くても updated_at は前進させ、 存在確認も兼ねる。
  sets.push('updated_at = ?');
  binds.push(nowJst());
  binds.push(id);
  const res = await db
    .prepare(`UPDATE faq_items SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  if ((res.meta?.changes ?? 0) === 0) return null;
  return getFaqItemById(db, id);
}

/** 1 件削除。 削除できたら true。 */
export async function deleteFaqItem(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM faq_items WHERE id = ?`).bind(id).run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * 複数件を一括追加 (seed 用)。 各行は createFaqItem と同じ正規化を行い、 追加件数を返す。
 * 冪等性 (空のときだけ seed) は呼び出し側 (route) が countFaqItems で判定する。
 */
export async function bulkInsertFaqItems(
  db: D1Database,
  items: ReadonlyArray<CreateFaqItemInput>,
): Promise<number> {
  let inserted = 0;
  for (const it of items) {
    await createFaqItem(db, it);
    inserted += 1;
  }
  return inserted;
}

// ─── FAQ gap 分析 (PR2: 未解決質問の自動FAQ化ループ) ───
//
// AI が答えられなかった質問 (= conversation_logs.ai_layer='fallback') を頻度順に集計し、
// 管理画面で「FAQ化すべき未登録の質問」 として提示する。 conversation_logs は migration 053
// で本番に既存 (= 新規 migration 不要)。 本ファイルは read-only 集計のみで AI 応答経路は不変。

export interface UnansweredQuestion {
  question: string;
  count: number;
  lastAskedAt: string;
}

export interface UnansweredQuestionOptions {
  /** この JST ISO 以降の質問のみ集計 (created_at と同形式・末尾 Z なし)。 未指定なら全期間。 */
  sinceIso?: string;
  /** 上位何件返すか (default 30、 1-200 に clamp)。 */
  limit?: number;
  /** 最低出現回数 (default 1)。 */
  minCount?: number;
}

/**
 * nowMs から days 日前の JST ISO (conversation_logs.created_at と同形式・末尾 Z なし) を返す。
 * 純関数 (nowMs 引数化) なので期間境界をテスト可能。
 */
export function jstIsoDaysAgo(days: number, nowMs: number): string {
  const d = Number.isFinite(days) ? Math.max(0, days) : 90;
  return new Date(nowMs - d * 86400000 + 9 * 60 * 60 * 1000).toISOString().slice(0, 23);
}

/**
 * AI が答えられなかった (ai_layer='fallback') 質問を出現回数の多い順に集計する。
 * user_message は TRIM して同一視し、 空文字は除外する。 = FAQ化候補 (離脱を生む未解決質問)。
 */
export async function listUnansweredQuestions(
  db: D1Database,
  opts: UnansweredQuestionOptions = {},
): Promise<UnansweredQuestion[]> {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.trunc(opts.limit as number))) : 30;
  const minCount = Number.isFinite(opts.minCount) ? Math.max(1, Math.trunc(opts.minCount as number)) : 1;
  const sinceIso = opts.sinceIso ?? '0000-00-00T00:00:00.000';
  const res = await db
    .prepare(
      `SELECT TRIM(user_message) AS question, COUNT(*) AS count, MAX(created_at) AS lastAskedAt
         FROM conversation_logs
        WHERE ai_layer = 'fallback'
          AND created_at >= ?
          AND TRIM(user_message) != ''
        GROUP BY TRIM(user_message)
        HAVING COUNT(*) >= ?
        ORDER BY COUNT(*) DESC, MAX(created_at) DESC
        LIMIT ?`,
    )
    .bind(sinceIso, minCount, limit)
    .all<{ question: string; count: number; lastAskedAt: string }>();
  return (res.results ?? []).map((r) => ({
    question: r.question,
    count: r.count,
    lastAskedAt: r.lastAskedAt,
  }));
}
