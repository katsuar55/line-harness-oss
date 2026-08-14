/**
 * welcome→referred 格上げ (¥300→¥500) — 実 SQLite + fake fetch (Ultraplan PR-C R3)。
 * CAS/補償/旧コード redemption 照合という「順序と述語が仕様」の部分を実エンジンで検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/shopify-token.js', () => ({
  getShopifyAccessToken: vi.fn(async () => 'shpat_test'),
}));
vi.mock('../services/audit-logger.js', () => ({ auditSystem: vi.fn(async () => {}) }));
vi.mock('../services/channel-dispatcher.js', () => ({
  dispatch: vi.fn(async () => ({ results: [{ channel: 'line', status: 'sent' }] })),
}));

import { upgradeWelcomeCouponForReferred, buildWelcomeUpgradeMessage } from '../services/welcome-upgrade.js';
import { redeemCouponByCode } from '@line-crm/db';
import { createSchemaDb, asD1, insertFriend } from './helpers/sqlite-d1.js';
import type { SqliteDatabase } from './helpers/sqlite-d1.js';
import type { LineClient } from '@line-crm/line-sdk';

const FIXED_NOW = Date.parse('2026-08-13T12:00:00.000Z');
const ORIG_EXPIRY = new Date(FIXED_NOW + 4 * 86_400_000).toISOString(); // 残り 4 日

let raw: SqliteDatabase;
let db: D1Database;

beforeEach(() => {
  vi.clearAllMocks();
  raw = createSchemaDb();
  db = asD1(raw);
  insertFriend(raw, 'F1');
});

function seedWelcome(over: Partial<{ value: number; redeemedAt: string | null; status: string; gid: string | null }> = {}) {
  raw.prepare(
    `INSERT INTO line_friend_coupons (id, friend_id, coupon_code, shopify_discount_code_id, discount_value, discount_currency, issued_at, expires_at, status, redeemed_at)
     VALUES ('w1', 'F1', 'LINE-OLD30000', ?, ?, 'JPY', '2026-08-10T00:00:00.000Z', ?, ?, ?)`,
  ).run(over.gid === undefined ? 'gid://old' : over.gid, over.value ?? 300, ORIG_EXPIRY, over.status ?? 'issued', over.redeemedAt ?? null);
}

/** deactivate / activate / create を判別する fake fetch。呼び出しの種類を記録する */
function makeFetch(opts: { failCreate?: boolean } = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string; variables?: { basicCodeDiscount?: { code?: string } } };
    if (body.query?.includes('discountCodeDeactivate')) {
      calls.push('deactivate');
      return new Response(JSON.stringify({ data: { discountCodeDeactivate: { codeDiscountNode: { id: 'gid://old' }, userErrors: [] } } }), { status: 200 });
    }
    if (body.query?.includes('discountCodeActivate')) {
      calls.push('activate');
      return new Response(JSON.stringify({ data: { discountCodeActivate: { codeDiscountNode: { id: 'gid://old' }, userErrors: [] } } }), { status: 200 });
    }
    calls.push('create');
    if (opts.failCreate) return new Response('boom', { status: 500 });
    const code = body.variables?.basicCodeDiscount?.code ?? 'LINE-NEW';
    return new Response(
      JSON.stringify({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://new', codeDiscount: { codes: { nodes: [{ code }] } } }, userErrors: [] } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const env = {
  SHOPIFY_STORE_DOMAIN: 'x.myshopify.com',
  SHOPIFY_CLIENT_ID: 'id',
  SHOPIFY_CLIENT_SECRET: 'secret',
  REFERRAL_REWARD_ENABLED: 'true',
  LIFF_URL: 'https://liff.line.me/x',
};
const lineClient = {} as unknown as LineClient;
const run = (fetchImpl: typeof fetch) =>
  upgradeWelcomeCouponForReferred(db, env, lineClient, { friendId: 'F1', now: () => FIXED_NOW, fetchImpl });

describe('upgradeWelcomeCouponForReferred', () => {
  it('happy path: deactivate→create→同一行 ¥500 化。期限は旧券の残りを引き継ぐ (延長しない)', async () => {
    seedWelcome();
    const { fn, calls } = makeFetch();
    const r = await run(fn);
    expect(r.outcome).toBe('upgraded');
    expect(calls).toEqual(['deactivate', 'create']); // 旧を先に殺す順序が仕様
    const row = raw.prepare(`SELECT coupon_code, discount_value, expires_at, json_extract(metadata,'$.upgrade.oldCode') AS old FROM line_friend_coupons WHERE id='w1'`).get() as { coupon_code: string; discount_value: number; expires_at: string; old: string };
    expect(row.discount_value).toBe(500);
    expect(row.coupon_code).not.toBe('LINE-OLD30000');
    expect(row.old).toBe('LINE-OLD30000');
    expect(row.expires_at).toBe(ORIG_EXPIRY); // 残り 4 日のまま
    expect(r.pushed).toBe(true);
  });

  it('使用済み welcome は格上げしない (初回購入の目的は達成済み)', async () => {
    seedWelcome({ redeemedAt: '2026-08-12T00:00:00.000Z', status: 'redeemed' });
    const { fn, calls } = makeFetch();
    const r = await run(fn);
    expect(r.outcome).toBe('not_eligible');
    expect(calls).toEqual([]); // Shopify を触らない
  });

  it('二重格上げ防止: 2 回目は CAS (metadata.upgrade) が弾く', async () => {
    seedWelcome();
    const f1 = makeFetch();
    await run(f1.fn);
    const f2 = makeFetch();
    const r2 = await run(f2.fn);
    // 1 回目で discount_value=500 になっているので入口の 300 チェックでも弾かれるが、
    // 万一 value 判定を壊しても CAS が最終防壁 (mutation で両方測る)
    expect(r2.outcome).toBe('not_eligible');
    expect(f2.calls).toEqual([]);
  });

  it('create 失敗 → 旧 ¥300 を activate で復活 (補償) + marker 解除 = 再試行可能', async () => {
    seedWelcome();
    const { fn, calls } = makeFetch({ failCreate: true });
    const r = await run(fn);
    expect(r.outcome).toBe('failed');
    expect(calls).toEqual(['deactivate', 'create', 'activate']); // 補償の順序
    const row = raw.prepare(`SELECT coupon_code, discount_value, json_extract(metadata,'$.upgrade') AS marker FROM line_friend_coupons WHERE id='w1'`).get() as { coupon_code: string; discount_value: number; marker: string | null };
    expect(row.discount_value).toBe(300); // 無傷
    expect(row.coupon_code).toBe('LINE-OLD30000');
    expect(row.marker).toBeNull(); // 解除済み → 将来の再試行余地
  });

  it('welcome 未発行 → ¥500 を直接発行 (issued_directly)', async () => {
    const { fn } = makeFetch();
    const r = await run(fn);
    expect(r.outcome).toBe('issued_directly');
    const row = raw.prepare(`SELECT discount_value FROM line_friend_coupons WHERE friend_id='F1'`).get() as { discount_value: number };
    expect(row.discount_value).toBe(500);
  });

  it('gate off → 何もしない', async () => {
    seedWelcome();
    const { fn, calls } = makeFetch();
    const r = await upgradeWelcomeCouponForReferred(db, { ...env, REFERRAL_REWARD_ENABLED: undefined }, lineClient, { friendId: 'F1', now: () => FIXED_NOW, fetchImpl: fn });
    expect(r.outcome).toBe('gated_off');
    expect(calls).toEqual([]);
  });
});

describe('CAS 層の単独検証 (入口チェックの影に隠さない — mutation C7/C8 の kill 根拠)', () => {
  it('C8: 別の格上げが in-flight (metadata.upgrade 印あり) なら、入口を通っても CAS が弾く', async () => {
    seedWelcome();
    // 別実行が claim 済みの状態を再現 (value=300 のままなので入口チェックは通る)
    raw.prepare(`UPDATE line_friend_coupons SET metadata = json_patch(COALESCE(metadata,'{}'), '{"upgrade":{"claimedAt":"2026-08-13T11:59:00.000Z","plannedCode":"LINE-INFLIGHT"}}') WHERE id='w1'`).run();
    const { fn, calls } = makeFetch();
    const r = await run(fn);
    expect(r.outcome).toBe('not_eligible');
    expect(calls).toEqual([]); // Shopify を一切触らない (二重格上げの窓なし)
  });

  it('C7: 入口 SELECT の直後に使用された race — CAS の redeemed_at IS NULL が最終防壁', async () => {
    seedWelcome();
    // 入口 SELECT が返った直後に redemption が確定した状況を、SELECT を 1 回だけフックして再現
    let hooked = false;
    const racingDb = {
      prepare(sql: string) {
        const stmt = (db as unknown as { prepare(s: string): { bind(...a: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }> } } }).prepare(sql);
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              ...bound,
              first: async <T,>() => {
                const row = await bound.first<T>();
                if (!hooked && /FROM line_friend_coupons WHERE friend_id/.test(sql)) {
                  hooked = true; // 入口 SELECT の直後に使用が確定。
                  // redeemed_at **のみ**立てる (status は issued のまま) — CAS の redeemed_at IS NULL は
                  // 「使用の事実 > 状態機械」の防御述語なので、status に隠さず単独で測る (queue M5 と同型)
                  raw.prepare(`UPDATE line_friend_coupons SET redeemed_at='2026-08-13T12:00:01.000Z' WHERE id='w1'`).run();
                }
                return row;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const { fn, calls } = makeFetch();
    const r = await upgradeWelcomeCouponForReferred(racingDb, env, lineClient, { friendId: 'F1', now: () => FIXED_NOW, fetchImpl: fn });
    expect(r.outcome).toBe('not_eligible'); // CAS が changes=0 で撤退
    expect(calls).toEqual([]); // 使用済み券の deactivate/差し替えを一切しない
  });
});

describe('旧コードの redemption 照合 (deactivate 前に確定した注文を落とさない)', () => {
  it('格上げ後に旧 ¥300 コードで注文が届いても、同一行が redeem され friendId が返る (紹介者報酬の起点が保たれる)', async () => {
    seedWelcome();
    const { fn } = makeFetch();
    await run(fn);
    const res = await redeemCouponByCode(db, 'friend', 'LINE-OLD30000', new Date(FIXED_NOW + 3_600_000).toISOString(), {});
    expect(res.matched).toBe(true);
    expect(res.redeemed).toBe(true);
    expect(res.friendId).toBe('F1');
    const row = raw.prepare(`SELECT status FROM line_friend_coupons WHERE id='w1'`).get() as { status: string };
    expect(row.status).toBe('redeemed');
  });
});

describe('buildWelcomeUpgradeMessage', () => {
  it('「増額」表現 + 旧番号の失効明示 + 新コードを含む (「プレゼント/もう1枚」と読ませない)', () => {
    const msg = buildWelcomeUpgradeMessage('LINE-NEW500AB', '2026-08-17T00:00:00.000Z', 'https://liff.line.me/x');
    const json = JSON.stringify(msg);
    expect(msg.altText).toContain('増額');
    expect(json).toContain('¥300 → ¥500 に増額');
    expect(json).toContain('以前の番号はご利用いただけません');
    expect(json).toContain('LINE-NEW500AB');
    expect(json).not.toContain('プレゼント');
  });
});
