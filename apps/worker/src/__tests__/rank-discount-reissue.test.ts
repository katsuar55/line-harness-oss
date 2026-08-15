/**
 * ランク割引の再発行閾値 + supersede 時の Shopify 側 deactivate (Ultraplan PR-D) — 実 SQLite。
 *
 * 根治対象バグ: 従来は同 rank なら無条件再利用のため、45日で Shopify 側が失効しても
 * DB は active のままコードが二度と再発行されなかった。
 *
 * 閾値の契約 (採点ループ算術確定 + R2 knife-edge 修正):
 *   - 残寿命 ≥ 13日 → 再利用 (月1 cron [残最短 45-31=14日] で毎月全員再発行しない。
 *     14 だと cron の秒ジッタで全員再発行へ雪崩れるため 13 = 丸1日の slack)
 *   - 残寿命 < 13日 / 期限切れ → supersede + 再発行 + 旧コード deactivate
 * 回帰ガード: getActiveRankDiscount は期限**無フィルタ** — 期限切れ active 行も supersede
 *   されること (フィルタを足すと期限切れ行が永久に active 残留する — 採点 CONFIRMED)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));

import { issueRankDiscountForFriend, __test__ } from '../services/rank-discount-issuer.js';
import { markRankDiscountShopifyDeactivated } from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';

const NOW = Date.parse('2026-08-15T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const DAY = 86_400_000;

const ENV_ON = {
  SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
  SHOPIFY_CLIENT_ID: 'i',
  SHOPIFY_CLIENT_SECRET: 's',
  RANK_DISCOUNT_ENABLED: 'true',
};

/** create/deactivate を body で見分ける fetch mock */
function makeFetch(opts: { deactivateFails?: boolean } = {}) {
  const kinds: string[] = [];
  let deactivatedGid: string | null = null;
  const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: { id?: string; basicCodeDiscount?: { code?: string } };
    };
    if (String(body.query).includes('discountCodeDeactivate')) {
      kinds.push('deactivate');
      deactivatedGid = body.variables?.id ?? null;
      if (opts.deactivateFails) {
        return new Response(
          JSON.stringify({ data: { discountCodeDeactivate: { codeDiscountNode: null, userErrors: [{ code: 'X', message: 'boom' }] } } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ data: { discountCodeDeactivate: { codeDiscountNode: { id: body.variables?.id }, userErrors: [] } } }),
        { status: 200 },
      );
    }
    kinds.push('create');
    const code = body.variables?.basicCodeDiscount?.code ?? 'X';
    return new Response(
      JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://new/1', codeDiscount: { codes: { nodes: [{ code }] } } }, userErrors: [] } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, kinds, getDeactivatedGid: () => deactivatedGid };
}

function seedActiveRow(
  raw: SqliteDatabase,
  o: { id: string; friendId: string; rankId: string; percent: number; code: string; nodeId: string | null; expiresAt: string | null },
): void {
  raw.prepare(
    `INSERT INTO loyalty_rank_discounts
       (id, friend_id, rank_id, code, shopify_discount_node_id, discount_percent, status, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', '2026-07-01T00:00:00.000Z', ?)`,
  ).run(o.id, o.friendId, o.rankId, o.code, o.nodeId, o.percent, o.expiresAt);
}

function rowById(raw: SqliteDatabase, id: string) {
  return raw
    .prepare(`SELECT status, shopify_deactivated_at FROM loyalty_rank_discounts WHERE id = ?`)
    .get(id) as { status: string; shopify_deactivated_at: string | null };
}

let raw: SqliteDatabase;
let db: D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  raw = createSchemaDb();
  db = asD1(raw);
  insertFriend(raw, 'F1');
});

describe('冪等再利用の残寿命閾値', () => {
  it('残寿命 15日 (≥13) → 再利用・Shopify 未呼出', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-KEEP1234',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW + 15 * DAY).toISOString(),
    });
    const { fn } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(true);
    expect(r?.code).toBe('NLR-SILVER-KEEP1234');
    expect(fn).not.toHaveBeenCalled();
  });

  it('残寿命ちょうど閾値 (13日・境界) → 再利用', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-EDGE1234',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW + __test__.REISSUE_MIN_REMAINING_MS).toISOString(),
    });
    const { fn } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('expires_at NULL (無期限) → 再利用', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-NOEXP123',
      nodeId: 'gid://old/1', expiresAt: null,
    });
    const { fn } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('残寿命不足 → supersede + 再発行 + 旧コード deactivate', () => {
  it('残寿命 12日 (<13) → 新コード発行・旧 superseded・deactivate 実呼出・マーカー記録', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-OLD12345',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW + 12 * DAY).toISOString(),
    });
    const { fn, kinds, getDeactivatedGid } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(false);
    expect(r?.code).not.toBe('NLR-SILVER-OLD12345');
    expect(kinds).toEqual(['create', 'deactivate']); // insert 先行 → 旧 kill (no-active 窓なし)
    expect(getDeactivatedGid()).toBe('gid://old/1');
    const old = rowById(raw, 'old');
    expect(old.status).toBe('superseded');
    expect(old.shopify_deactivated_at).toBe(NOW_ISO);
    // active は新行 1 本だけ
    const actives = raw.prepare(`SELECT id FROM loyalty_rank_discounts WHERE status='active'`).all();
    expect(actives).toHaveLength(1);
  });

  it('期限切れ active 行 → supersede される (無フィルタ read の回帰ガード) + API は呼ばずマークのみ', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-DEAD1234',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW - 1 * DAY).toISOString(),
    });
    const { fn, kinds } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(false);
    // Shopify 側は endsAt で自然死済み → deactivate API は呼ばない
    expect(kinds).toEqual(['create']);
    const old = rowById(raw, 'old');
    expect(old.status).toBe('superseded'); // ← ここが期限フィルタ回帰で真っ先に死ぬ
    expect(old.shopify_deactivated_at).toBe(NOW_ISO);
  });

  it('deactivate 失敗 → マーカー NULL のまま (日次 sweep の再試行対象として残る)', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-FAIL1234',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW + 5 * DAY).toISOString(),
    });
    const { fn } = makeFetch({ deactivateFails: true });
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'silver', discountPercent: 4, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.isExisting).toBe(false); // 発行自体は成功 (deactivate は best-effort)
    const old = rowById(raw, 'old');
    expect(old.status).toBe('superseded');
    expect(old.shopify_deactivated_at).toBeNull();
  });

  it('マーカー CAS: 二重マークは false・先勝ちの時刻を保持 (並行 sweep の二重記録防止)', async () => {
    seedActiveRow(raw, {
      id: 'row1', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-CAS12345',
      nodeId: 'gid://old/1', expiresAt: null,
    });
    expect(await markRankDiscountShopifyDeactivated(db, 'row1', '2026-08-15T00:00:00.000Z')).toBe(true);
    expect(await markRankDiscountShopifyDeactivated(db, 'row1', '2026-08-16T00:00:00.000Z')).toBe(false);
    expect(rowById(raw, 'row1').shopify_deactivated_at).toBe('2026-08-15T00:00:00.000Z');
  });

  it('ランク変更 (percent 違い) → 残寿命が十分でも supersede + 再発行 + deactivate', async () => {
    seedActiveRow(raw, {
      id: 'old', friendId: 'F1', rankId: 'silver', percent: 4, code: 'NLR-SILVER-UP123456',
      nodeId: 'gid://old/1', expiresAt: new Date(NOW + 40 * DAY).toISOString(),
    });
    const { fn, kinds } = makeFetch();
    const r = await issueRankDiscountForFriend(db, ENV_ON, {
      friendId: 'F1', rankId: 'gold', discountPercent: 6, fetchImpl: fn, now: () => NOW,
    });
    expect(r?.rankId).toBe('gold');
    expect(kinds).toEqual(['create', 'deactivate']);
    expect(rowById(raw, 'old').status).toBe('superseded');
  });
});
