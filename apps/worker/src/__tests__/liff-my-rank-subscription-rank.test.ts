/**
 * 定期便ランク (= HB ネイティブ会員ランク連動, B案 2026-08-16) のテスト
 *
 * 1. parseSubscriptionRankFromTags — shopify_customers.tags のパース (純関数)
 * 2. /api/liff/my-rank — subscriptionRank フィールドの出し分け (連携有無 / タグ有無 / fetch 失敗)
 * 3. /liff/my-rank ページ — renderSubRank の定義**と呼出** + 文言ガード
 *
 * 採点ループ (2026-08-16) の反映:
 * - 期待値は literal でピン (HB_SUBSCRIPTION_RANKS 自身をオラクルにしない — tautology 回避)
 * - 複数既知タグの競合は**最低ランク**採用 (旧・高ランクタグの残留で実際より高い % を
 *   約束しない = 有利誤認回避。低く見せる誤りは実割引が上回るだけ)
 * - makeDb は prepare/bind を記録し「読まない」「正しい id で読む」を直接観測する
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { liffMyRank } from '../routes/liff-my-rank.js';
import {
  parseSubscriptionRankFromTags,
  HB_SUBSCRIPTION_RANKS,
} from '../services/subscription-rank.js';

// HB 側で「公開」済み = 凍結されたランク表 (literal ピン。実装をオラクルにしない)
const FROZEN_RANKS: Array<[name: string, pct: number]> = [
  ['ブロンズ', 2],
  ['シルバー', 4],
  ['ゴールド', 6],
  ['プラチナ', 8],
];

describe('HB_SUBSCRIPTION_RANKS (凍結表)', () => {
  it('公開済み HB ランク表と完全一致 (名前・%・件数)', () => {
    expect(HB_SUBSCRIPTION_RANKS).toEqual(
      FROZEN_RANKS.map(([name, discountPercent]) => ({ name, discountPercent })),
    );
  });
});

describe('parseSubscriptionRankFromTags', () => {
  it('null / undefined / 非文字列 / 空文字 → null', () => {
    expect(parseSubscriptionRankFromTags(null)).toBeNull();
    expect(parseSubscriptionRankFromTags(undefined)).toBeNull();
    expect(parseSubscriptionRankFromTags(123)).toBeNull();
    expect(parseSubscriptionRankFromTags('')).toBeNull();
  });

  it('subscription-rank タグが無い → null (他の subscription- 系タグに誤反応しない)', () => {
    expect(parseSubscriptionRankFromTags('vip, subscription-id:100, subscription-count:3')).toBeNull();
    // prefix が近いだけのタグ (値なし) にも反応しない
    expect(parseSubscriptionRankFromTags('subscription-rank:')).toBeNull();
  });

  it.each(FROZEN_RANKS)('既知ランク %s → discountPercent %d', (name, pct) => {
    expect(parseSubscriptionRankFromTags(`subscription-rank:${name}`)).toEqual({
      name,
      discountPercent: pct,
    });
  });

  it('前後空白・他タグとの混在でも拾う (Shopify tags はカンマ+空白区切り)', () => {
    expect(
      parseSubscriptionRankFromTags('vip,  subscription-rank:ゴールド , subscription-100-skip-count:1'),
    ).toEqual({ name: 'ゴールド', discountPercent: 6 });
  });

  it('既知ランクが複数残っている過渡状態 → 最低ランクを採用 (高い % を約束しない)', () => {
    // 降格 (キャンセル減算は実測済み) の途中で旧・高ランクタグが残っても、
    // 実際より高い % を顧客に見せない。昇格過渡で一瞬低く出るのは実割引が上回るだけで無害。
    expect(
      parseSubscriptionRankFromTags('subscription-rank:ブロンズ, subscription-rank:プラチナ'),
    ).toEqual({ name: 'ブロンズ', discountPercent: 2 });
    // 順序を逆にしても同じ
    expect(
      parseSubscriptionRankFromTags('subscription-rank:プラチナ, subscription-rank:ブロンズ'),
    ).toEqual({ name: 'ブロンズ', discountPercent: 2 });
  });

  it('未知のランク名 → 名前だけ返し % は断定しない (fail-honest)', () => {
    expect(parseSubscriptionRankFromTags('subscription-rank:ダイヤモンド')).toEqual({
      name: 'ダイヤモンド',
      discountPercent: null,
    });
  });

  it('未知と既知の混在 → 既知を優先 (順序不問)', () => {
    expect(
      parseSubscriptionRankFromTags('subscription-rank:ダイヤモンド, subscription-rank:シルバー'),
    ).toEqual({ name: 'シルバー', discountPercent: 4 });
    expect(
      parseSubscriptionRankFromTags('subscription-rank:シルバー, subscription-rank:ダイヤモンド'),
    ).toEqual({ name: 'シルバー', discountPercent: 4 });
  });
});

// ─── API 統合: /api/liff/my-rank の subscriptionRank ───

interface RecordedQuery {
  sql: string;
  binds: unknown[];
}

function makeDb(opts: {
  shopifyCustomerId?: string | null;
  customerTags?: string | null;
  customerFetchThrows?: boolean;
}): { db: D1Database; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = {
    prepare(sql: string) {
      const rec: RecordedQuery = { sql, binds: [] };
      queries.push(rec);
      const stmt = {
        bind(...args: unknown[]) {
          rec.binds.push(...args);
          return stmt;
        },
        async first<T>(): Promise<T | null> {
          if (sql.includes('FROM friends')) {
            return {
              id: 'f1',
              line_user_id: 'U1',
              shopify_customer_id: opts.shopifyCustomerId ?? null,
            } as unknown as T;
          }
          if (sql.includes('FROM shopify_customers')) {
            if (opts.customerFetchThrows) throw new Error('D1_ERROR: transient');
            return {
              id: 'sc1',
              shopify_customer_id: opts.shopifyCustomerId,
              tags: opts.customerTags ?? null,
            } as unknown as T;
          }
          if (sql.includes('SUM(amount_jpy)')) {
            return { total: 15000 } as unknown as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, queries };
}

function makeApp() {
  const app = new Hono<Env>();
  app.use('/api/liff/*', async (c, next) => {
    (c as { set: (k: string, v: unknown) => void }).set('liffUser', {
      lineUserId: 'U1',
      friendId: 'f1',
    });
    await next();
  });
  app.route('/', liffMyRank);
  return app;
}

async function callApi(db: D1Database) {
  const res = await makeApp().request('/api/liff/my-rank', undefined, {
    DB: db,
  } as unknown as Env['Bindings']);
  return (await res.json()) as { success: boolean; data?: { subscriptionRank: unknown } };
}

describe('GET /api/liff/my-rank — subscriptionRank', () => {
  it('連携済み + subscription-rank タグあり → name/% を返す (lookup は正しい customer id で行う)', async () => {
    const { db, queries } = makeDb({
      shopifyCustomerId: '6458785661181',
      customerTags: 'vip, subscription-rank:シルバー',
    });
    const body = await callApi(db);
    expect(body.success).toBe(true);
    expect(body.data?.subscriptionRank).toEqual({ name: 'シルバー', discountPercent: 4 });
    // lookup が friend.shopify_customer_id そのもので bind されている (id 取り違えの直接観測)
    const customerQueries = queries.filter((q) => q.sql.includes('FROM shopify_customers'));
    expect(customerQueries).toHaveLength(1);
    expect(customerQueries[0].binds).toContain('6458785661181');
  });

  it('連携済みだがタグ無し → null', async () => {
    const { db } = makeDb({ shopifyCustomerId: '6458785661181', customerTags: 'vip' });
    const body = await callApi(db);
    expect(body.data?.subscriptionRank).toBeNull();
  });

  it('未知ランク名も API まで素通しで {name, discountPercent:null} (client の % 非表示分岐の入力契約)', async () => {
    const { db } = makeDb({
      shopifyCustomerId: '6458785661181',
      customerTags: 'subscription-rank:ダイヤモンド',
    });
    const body = await callApi(db);
    expect(body.data?.subscriptionRank).toEqual({ name: 'ダイヤモンド', discountPercent: null });
  });

  it('未連携 (shopify_customer_id なし) → null + shopify_customers を一切読まない (直接観測)', async () => {
    // 毒入れ (読んだら non-null になるタグ) と prepare 記録の二重観測
    const { db, queries } = makeDb({
      shopifyCustomerId: null,
      customerTags: 'subscription-rank:ゴールド',
    });
    const body = await callApi(db);
    expect(body.data?.subscriptionRank).toBeNull();
    expect(queries.filter((q) => q.sql.includes('FROM shopify_customers'))).toHaveLength(0);
  });

  it('shopify_customers の読み取りが throw しても会員証本体は 200 + subscriptionRank null', async () => {
    const { db } = makeDb({ shopifyCustomerId: '6458785661181', customerFetchThrows: true });
    const body = await callApi(db);
    expect(body.success).toBe(true);
    expect(body.data?.subscriptionRank).toBeNull();
  });
});

// ─── ページ HTML: renderSubRank の存在・呼出・文言 ───

describe('GET /liff/my-rank — 定期便ランクカード', () => {
  const env = {
    LIFF_URL: 'https://liff.line.me/2000000000-abcd1234',
    WORKER_URL: 'https://example.workers.dev',
  };

  async function fetchHtml(): Promise<string> {
    const res = await liffMyRank.request('/liff/my-rank', {}, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(200);
    return res.text();
  }

  it('renderSubRank が定義され、renderAll から**呼び出される** (呼出削除 mutant を殺す)', async () => {
    const html = await fetchHtml();
    expect(html).toContain('function renderSubRank');
    // セミコロン付きは呼出行のみに一致 (定義行は 'renderSubRank(d){')
    expect(html).toContain('renderSubRank(d);');
    expect(html).toContain('id="subrank-card"');
  });

  it('文言ガード: 事実ベースの断定のみ・誤読の芽を持ち込まない', async () => {
    const html = await fetchHtml();
    expect(html).toContain('定期便ランク');
    // 集計対象と適用先の区別 (採点 CONFIRMED HIGH 2 件の恒久ガード):
    // ① 起算点の開示 (公開 2026-08-16 以後のみ集計 — 長期継続者の「累計が反映されない」誤解対策)
    expect(html).toContain('ランクの集計は 2026年8月 に始まりました');
    // ② 会員ランク側の「すべてのお買い物」は**判定**の説明であり割引適用範囲と読ませない
    expect(html).toContain('合計金額でランクを判定');
    expect(html).not.toContain('すべてのお買い物が対象');
    // ③ 定期便ランク割引の適用先の限定
    expect(html).toContain('定期便のお支払いにだけ自動で適用');
    // ④ 「下がりません」は書かない (キャンセルで累計減算される実測があるため)
    expect(html).not.toContain('下がりません');
    // ⑤ 既存会員ランクのバッジは「常時割引」でなく通常購入クーポンであることを明示
    expect(html).toContain('通常購入 ');
    expect(html).not.toContain('常時割引');
    // ⑥ 進捗バーの帰属 (どのランク制度の進捗か)
    expect(html).toContain('次のランク（会員ランク）');
  });

  it('demo データ・非表示分岐・% 非表示分岐 (fail-honest) を含む', async () => {
    const html = await fetchHtml();
    // demo データにも subscriptionRank (= ?demo=1 で UI 確認可能)
    expect(html).toMatch(/subscriptionRank:\s*\{ name: 'シルバー', discountPercent: 4 \}/);
    // タグ無し顧客はカード非表示
    expect(html).toContain("if(!sr || !sr.name){ card.style.display='none'; return; }");
    // 未知ランク名 (discountPercent null) では % を表示しない分岐
    expect(html).toContain('Number.isFinite(sr.discountPercent)');
  });
});
