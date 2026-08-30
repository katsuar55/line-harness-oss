/**
 * Tests for member-purchase-backfill (= 自社内製ロイヤリティ PR3-B, 2026-06-05)
 *
 * link 連動 過去注文 backfill の money path を検証:
 *   - gating (MEMBER_BACKFILL_ENABLED / shopify config / accessToken / customerId allowlist)
 *   - order gid → 数値正規化 (= webhook の shopify_order_id と一致 → 二重計上防止)
 *   - occurred_at = 実注文日 / source='backfill' / JPY zero-decimal (× 100 しない)
 *   - 非JPY skip / pagination + cap / HTTP・GraphQL エラーで打ち切り (= 部分 backfill、 link は壊さない)
 *
 * addPurchaseEvent は spy (= service の責務 = 「Shopify から取得して正しい引数で addPurchaseEvent を呼ぶ」 を検証)。
 * idempotency の dedup 本体 (UNIQUE shopify_order_id) は membership-db.test.ts で別途検証済。
 * isoMonthsAgo / jstNow は importActual で実物 (= window 計算の正確性を保つ)。
 * service は static import のみ (= vi.mock + dynamic import 干渉トラップなし)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addPurchaseEventMock } = vi.hoisted(() => ({ addPurchaseEventMock: vi.fn() }));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<typeof import('@line-crm/db')>();
  return { ...actual, addPurchaseEvent: addPurchaseEventMock };
});
// 完了 audit の result/metadata を検証する (Codex P2: capped=success だと sweep が永久に再訪しない)
vi.mock('../services/audit-logger.js', () => ({
  auditSystem: vi.fn(async () => {}),
}));
import { auditSystem } from '../services/audit-logger.js';
const mockedAuditSystem = vi.mocked(auditSystem);

import {
  backfillCustomerOrders,
  normalizeShopifyOrderId,
  type BackfillEnv,
} from '../services/member-purchase-backfill.js';

// ─── no-op D1 (= addPurchaseEvent は mock、 auditSystem は best-effort no-op) ───
const fakeDb = {
  prepare: () => ({
    bind: () => ({
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [], success: true }),
    }),
  }),
} as unknown as D1Database;

const ENV_ON: BackfillEnv = {
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
  MEMBER_BACKFILL_ENABLED: 'true',
};

const BASE = {
  customerId: '6601471787261',
  friendId: 'f1',
  accessToken: 'shpat_test',
  asOfIso: '2026-06-05T00:00:00.000+09:00',
};

interface OrderNode {
  id: string;
  createdAt?: string | null;
  displayFinancialStatus?: string | null;
  totalPriceSet?: { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null;
}

function order(id: string, amount: string, createdAt: string, currency = 'JPY', status = 'PAID'): OrderNode {
  return {
    id,
    createdAt,
    displayFinancialStatus: status,
    totalPriceSet: { shopMoney: { amount, currencyCode: currency } },
  };
}

/** orders ページを順番に返す fetch mock (= after cursor を辿る pagination 再現) */
function mockOrdersFetch(pages: Array<{ nodes: OrderNode[]; hasNextPage?: boolean; endCursor?: string | null }>) {
  let call = 0;
  return vi.fn(async () => {
    const p = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return new Response(
      JSON.stringify({
        data: {
          orders: {
            edges: p.nodes.map((n, i) => ({ cursor: `c${call}_${i}`, node: n })),
            pageInfo: { hasNextPage: p.hasNextPage ?? false, endCursor: p.endCursor ?? null },
          },
        },
      }),
      { status: 200 },
    );
  });
}

beforeEach(() => {
  addPurchaseEventMock.mockReset();
  // default: 新規 applied (= newTotalPurchaseJpy 非 null → backfilled としてカウント)
  addPurchaseEventMock.mockImplementation(async (_db: unknown, input: { shopifyOrderId: string; amountJpy: number; friendId: string }) => ({
    inserted: true,
    applied: true,
    eventId: `e-${input.shopifyOrderId}`,
    friendId: input.friendId,
    amountJpy: Math.floor(input.amountJpy),
    newTotalPurchaseJpy: Math.floor(input.amountJpy),
  }));
});

describe('normalizeShopifyOrderId', () => {
  it('gid → 数値 / 数値はそのまま / 不正は null', () => {
    expect(normalizeShopifyOrderId('gid://shopify/Order/6874188710141')).toBe('6874188710141');
    expect(normalizeShopifyOrderId('123456')).toBe('123456');
    expect(normalizeShopifyOrderId('gid://shopify/Customer/1')).toBeNull();
    expect(normalizeShopifyOrderId(null)).toBeNull();
    expect(normalizeShopifyOrderId('')).toBeNull();
  });
});

describe('backfillCustomerOrders — gating', () => {
  it('MEMBER_BACKFILL_ENABLED!=true → skipped (gated_off)・fetch せず', async () => {
    const fetchImpl = mockOrdersFetch([{ nodes: [order('gid://shopify/Order/1', '2830', '2026-05-01T00:00:00Z')] }]);
    const r = await backfillCustomerOrders(
      fakeDb,
      { ...ENV_ON, MEMBER_BACKFILL_ENABLED: undefined },
      { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('gated_off');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(addPurchaseEventMock).not.toHaveBeenCalled();
  });

  it('SHOPIFY_STORE_DOMAIN 未設定 → skipped (shopify_not_configured)', async () => {
    const r = await backfillCustomerOrders(fakeDb, { ...ENV_ON, SHOPIFY_STORE_DOMAIN: undefined }, { ...BASE });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('shopify_not_configured');
  });

  it('accessToken 空 → skipped (no_access_token)', async () => {
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, accessToken: '' });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_access_token');
  });

  it('customerId が数値でない (= 注入リスク) → skipped (invalid_customer_id)・fetch せず', async () => {
    const fetchImpl = mockOrdersFetch([{ nodes: [] }]);
    const r = await backfillCustomerOrders(
      fakeDb,
      ENV_ON,
      { ...BASE, customerId: '123 OR 1=1', fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('invalid_customer_id');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('backfillCustomerOrders — backfill', () => {
  it('paid 注文を addPurchaseEvent(source=backfill, occurredAt=実注文日) で記録', async () => {
    const fetchImpl = mockOrdersFetch([
      {
        nodes: [
          order('gid://shopify/Order/100', '2830', '2026-05-01T10:00:00Z'),
          order('gid://shopify/Order/101', '14159.0', '2026-04-12T09:00:00Z'),
        ],
      },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.skipped).toBe(false);
    expect(r.scanned).toBe(2);
    expect(r.backfilled).toBe(2);
    expect(r.totalJpy).toBe(2830 + 14159);

    expect(addPurchaseEventMock).toHaveBeenCalledTimes(2);
    const first = addPurchaseEventMock.mock.calls[0][1];
    expect(first.shopifyOrderId).toBe('100'); // gid → 数値正規化 (= webhook と一致)
    expect(first.source).toBe('backfill');
    expect(first.occurredAt).toBe('2026-05-01T10:00:00Z');
    expect(first.amountJpy).toBe(2830);
  });

  it('JPY zero-decimal: amount を × 100 しない ("14159.0" → 14159)', async () => {
    const fetchImpl = mockOrdersFetch([{ nodes: [order('gid://shopify/Order/9', '14159.0', '2026-05-01T00:00:00Z')] }]);
    await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(addPurchaseEventMock.mock.calls[0][1].amountJpy).toBe(14159);
  });

  it('既適用 (newTotalPurchaseJpy=null) は alreadyApplied として冪等カウント', async () => {
    addPurchaseEventMock.mockResolvedValue({
      inserted: false,
      applied: true,
      eventId: 'e',
      friendId: 'f1',
      amountJpy: 2830,
      newTotalPurchaseJpy: null,
      reason: 'duplicate (already applied)',
    });
    const fetchImpl = mockOrdersFetch([{ nodes: [order('gid://shopify/Order/100', '2830', '2026-05-01T00:00:00Z')] }]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.backfilled).toBe(0);
    expect(r.alreadyApplied).toBe(1);
    expect(r.totalJpy).toBe(0);
  });

  it('非JPY 通貨は skip (= amount_jpy 整数前提の防御)', async () => {
    const fetchImpl = mockOrdersFetch([
      {
        nodes: [
          order('gid://shopify/Order/1', '2830', '2026-05-01T00:00:00Z', 'JPY'),
          order('gid://shopify/Order/2', '20.00', '2026-05-02T00:00:00Z', 'USD'),
        ],
      },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.scanned).toBe(1);
    expect(addPurchaseEventMock).toHaveBeenCalledTimes(1);
    expect(addPurchaseEventMock.mock.calls[0][1].shopifyOrderId).toBe('1');
  });

  it('displayFinancialStatus が PAID でない order は skip (= 過剰 credit 防止)', async () => {
    const fetchImpl = mockOrdersFetch([
      {
        nodes: [
          order('gid://shopify/Order/1', '2830', '2026-05-01T00:00:00Z', 'JPY', 'PAID'),
          order('gid://shopify/Order/2', '5000', '2026-05-02T00:00:00Z', 'JPY', 'REFUNDED'),
        ],
      },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.scanned).toBe(1);
    expect(addPurchaseEventMock.mock.calls[0][1].shopifyOrderId).toBe('1');
  });
});

describe('backfillCustomerOrders — pagination', () => {
  it('hasNextPage を辿って全ページ処理', async () => {
    const fetchImpl = mockOrdersFetch([
      { nodes: [order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z')], hasNextPage: true, endCursor: 'cur1' },
      { nodes: [order('gid://shopify/Order/2', '2000', '2026-05-02T00:00:00Z')], hasNextPage: false },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.scanned).toBe(2);
    expect(r.backfilled).toBe(2);
    expect(r.capped).toBe(false);
  });

  it('maxPages cap 到達で capped=true (= silent 切捨て禁止)', async () => {
    const fetchImpl = mockOrdersFetch([
      { nodes: [order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z')], hasNextPage: true, endCursor: 'cur1' },
    ]);
    const r = await backfillCustomerOrders(
      fakeDb,
      ENV_ON,
      { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, maxPages: 1 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.capped).toBe(true);
    expect(r.scanned).toBe(1);
  });
});

describe('backfillCustomerOrders — error handling (link を壊さない)', () => {
  it('HTTP error → errors++ で打ち切り (skipped=false)', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }));
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.skipped).toBe(false);
    expect(r.errors).toBe(1);
    expect(r.backfilled).toBe(0);
    expect(addPurchaseEventMock).not.toHaveBeenCalled();
  });

  it('GraphQL errors → errors++ で打ち切り', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'throttled' }] }), { status: 200 }));
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.errors).toBe(1);
    expect(r.backfilled).toBe(0);
  });

  it('fetch throw (network) → errors++ で打ち切り', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.errors).toBe(1);
    expect(r.backfilled).toBe(0);
  });

  it('個別 addPurchaseEvent 失敗は errors++ するが他 order は継続', async () => {
    addPurchaseEventMock
      .mockRejectedValueOnce(new Error('db busy'))
      .mockImplementation(async (_db: unknown, input: { shopifyOrderId: string; amountJpy: number; friendId: string }) => ({
        inserted: true,
        applied: true,
        eventId: 'e',
        friendId: input.friendId,
        amountJpy: input.amountJpy,
        newTotalPurchaseJpy: input.amountJpy,
      }));
    const fetchImpl = mockOrdersFetch([
      {
        nodes: [
          order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z'),
          order('gid://shopify/Order/2', '2000', '2026-05-02T00:00:00Z'),
        ],
      },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.errors).toBe(1);
    expect(r.backfilled).toBe(1);
    expect(r.totalJpy).toBe(2000);
  });
});

// ============================================================
// processMemberBackfillSweep (2026-08-26 採点ループ HIGH の恒久対策)
//   インライン backfill (redeem / OTP verify) が subrequest 予算切れで途中死した friend を
//   専用 invocation で収束させる cron。1 run 1 friend・成功 audit で対象から外れる。
// ============================================================

import { processMemberBackfillSweep, __test__ } from '../services/member-purchase-backfill.js';

function sweepDb(opts: { pending?: number; target?: { id: string; shopify_customer_id: string } | null } = {}) {
  const seen: string[] = [];
  const db = {
    prepare(sql: string) {
      seen.push(sql);
      const respond = () => {
        if (sql.includes('COUNT(*) AS n')) return { n: opts.pending ?? 0 };
        if (sql.includes('LIMIT 1')) return opts.target ?? null;
        return null;
      };
      return {
        bind: () => ({ first: async () => respond(), all: async () => ({ results: [] }), run: async () => ({ success: true }) }),
        first: async () => respond(),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      };
    },
  };
  return { db: db as unknown as D1Database, seen };
}

const SWEEP_ENV_ON = {
  SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com',
  MEMBER_BACKFILL_ENABLED: 'true',
};

describe('processMemberBackfillSweep — gating', () => {
  it.each([[undefined], ['false'], ['TRUE'], ['true\r'], ['']])(
    "MEMBER_BACKFILL_ENABLED=%j → skippedGating (D1 に 1 query も触れない)",
    async (gate) => {
      const { db, seen } = sweepDb();
      const r = await processMemberBackfillSweep(
        { DB: db, SHOPIFY_STORE_DOMAIN: 'x', ...(gate === undefined ? {} : { MEMBER_BACKFILL_ENABLED: gate }) },
        { getTokenImpl: vi.fn(), backfillImpl: vi.fn() as unknown as typeof backfillCustomerOrders },
      );
      expect(r.skippedGating).toBe(true);
      expect(r.processed).toBe(0);
      // 観測点は「触れていないこと」(status だけ見ると「読んでから捨てる」実装で緑になる)
      expect(seen).toHaveLength(0);
    },
  );
});

describe('processMemberBackfillSweep — 対象選定と実行', () => {
  it('pending 0 → 何もしない (token 取得もしない)', async () => {
    const { db } = sweepDb({ pending: 0 });
    const getTokenImpl = vi.fn();
    const r = await processMemberBackfillSweep(
      { DB: db, ...SWEEP_ENV_ON },
      { getTokenImpl, backfillImpl: vi.fn() as unknown as typeof backfillCustomerOrders },
    );
    expect(r).toMatchObject({ skippedGating: false, pending: 0, processed: 0, friendId: null });
    expect(getTokenImpl).not.toHaveBeenCalled();
  });

  it('🚨pending あり → 1 friend を取得済 token で backfill (maxPages 指定なし = 専用予算をフルに使う)', async () => {
    const { db } = sweepDb({ pending: 3, target: { id: 'f9', shopify_customer_id: '777' } });
    const getTokenImpl = vi.fn(async () => 'tok-1');
    const backfillImpl = vi.fn(async () => ({
      skipped: false, scanned: 5, backfilled: 4, alreadyApplied: 1, errors: 0, totalJpy: 9000, capped: false,
    }));
    const r = await processMemberBackfillSweep(
      { DB: db, ...SWEEP_ENV_ON },
      { getTokenImpl, backfillImpl: backfillImpl as unknown as typeof backfillCustomerOrders },
    );
    expect(r).toMatchObject({ skippedGating: false, pending: 3, processed: 1, friendId: 'f9', backfilled: 4, alreadyApplied: 1, errors: 0 });
    expect(backfillImpl).toHaveBeenCalledTimes(1);
    const [, env, opts] = backfillImpl.mock.calls[0] as unknown as [unknown, Record<string, string>, Record<string, unknown>];
    expect(env).toMatchObject({ SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', MEMBER_BACKFILL_ENABLED: 'true' });
    expect(opts).toMatchObject({ customerId: '777', friendId: 'f9', accessToken: 'tok-1' });
    // インライン (redeem) と違い専用 invocation なので既定ページ数のまま (= 絞らない)
    expect(opts.maxPages).toBeUndefined();
  });

  it('token 取得失敗 → errors 1・backfill を呼ばず pending に残す (次 run で retry)', async () => {
    const { db } = sweepDb({ pending: 1, target: { id: 'f9', shopify_customer_id: '777' } });
    const backfillImpl = vi.fn();
    const r = await processMemberBackfillSweep(
      { DB: db, ...SWEEP_ENV_ON },
      { getTokenImpl: vi.fn(async () => { throw new Error('token down'); }), backfillImpl: backfillImpl as unknown as typeof backfillCustomerOrders },
    );
    expect(r).toMatchObject({ processed: 0, errors: 1, pending: 1 });
    expect(backfillImpl).not.toHaveBeenCalled();
  });

  it('🚨対象述語: 成功 audit 除外・失敗 CAP・連携済み限定が SQL に実在する (fake が守り続ける偽緑の防止)', async () => {
    const { db, seen } = sweepDb({ pending: 1, target: { id: 'f9', shopify_customer_id: '777' } });
    await processMemberBackfillSweep(
      { DB: db, ...SWEEP_ENV_ON },
      { getTokenImpl: vi.fn(async () => 't'), backfillImpl: vi.fn(async () => ({ skipped: false, scanned: 0, backfilled: 0, alreadyApplied: 0, errors: 0, totalJpy: 0, capped: false })) as unknown as typeof backfillCustomerOrders },
    );
    const predicateSql = seen.find((s) => s.includes('LIMIT 1'));
    expect(predicateSql).toBeTruthy();
    for (const p of [
      'shopify_customer_id IS NOT NULL',
      "a.action = 'loyalty_purchase_backfill.completed'",
      "a.result = 'success'",
      "a.result = 'failure'",
      `< ${__test__.SWEEP_FAILURE_CAP}`,
    ]) {
      expect(predicateSql, p).toContain(p);
    }
  });

  // 🚨 2026-08-28 Codex P1。解除 (#282) は member_purchase_events の applied_at を戻すので
  //    再連携直後のランクは本当に ¥0 に戻る。一方 audit_logs は append-only で解除時も消さない。
  //    「完了 audit が在るか」だけで見ると**前回の連携の完了記録**が当たり、sweep がその friend を
  //    二度と拾わなくなる (= 再連携後にインライン backfill が落ちると復旧経路が消える)。
  //    しかも解除→再連携は**こちらから案内している復旧手順**なので確実に踏む。
  it('🚨対象述語: 成功も失敗も「直近の連携解除より後」に限定している', async () => {
    const { db, seen } = sweepDb({ pending: 1, target: { id: 'f9', shopify_customer_id: '777' } });
    await processMemberBackfillSweep(
      { DB: db, ...SWEEP_ENV_ON },
      { getTokenImpl: vi.fn(async () => 't'), backfillImpl: vi.fn(async () => ({ skipped: false, scanned: 0, backfilled: 0, alreadyApplied: 0, errors: 0, totalJpy: 0, capped: false })) as unknown as typeof backfillCustomerOrders },
    );
    const predicateSql = seen.find((s) => s.includes('LIMIT 1')) ?? '';
    // 解除時刻より後、という条件が成功側と失敗側の**両方**に入っていること
    // 境界の正は**解除の batch 内**で書かれる unlink_boundary (worker 側の unlinked は best-effort)。
    // 旧記録との互換のため両方見る。
    expect(predicateSql).toContain("u.action IN ('account_link.unlink_boundary', 'account_link.unlinked')");
    const occurrences = predicateSql.split('MAX(u.created_at)').length - 1;
    expect(occurrences).toBe(2);
    // 解除記録が無い friend を弾かないための既定値
    expect(predicateSql).toContain("), '')");
  });
});

// ─── cron 配線 (index.ts) — 配線が消えたら落ちるテスト (鮮度ルールの「手配線だけにしない」と同旨) ───
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

describe('member-backfill-sweep の cron 配線', () => {
  it('scheduled handler に withHeartbeat 付きで配線されている', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const idx = readFileSync(join(root, '..', 'index.ts'), 'utf8');
    expect(idx).toContain("withHeartbeat(env.DB, 'member-backfill-sweep'");
    expect(idx).toMatch(/processMemberBackfillSweep\(/);
    // metrics に pending / skippedGating が入る (= dashboard/cron_run_logs から生存が見える)
    expect(idx).toMatch(/pending: r\.pending[\s\S]{0,200}skippedGating: r\.skippedGating/);
  });
});

// ─── 完了 audit の result 意味論 (Codex P2 2026-08-26) ───
// sweep / admin op は success audit を「完遂」とみなして pending から外す。
// capped (一部未取得) を success で書くと、上限より注文の多い顧客が不完全なまま永久に再訪されない。
describe('backfillCustomerOrders — 完了 audit の result (capped は success にしない)', () => {
  beforeEach(() => {
    mockedAuditSystem.mockClear();
  });
  const auditCall = () =>
    mockedAuditSystem.mock.calls.find(([, i]) => i.action === 'loyalty_purchase_backfill.completed')?.[1];

  it('全件取得 (cap 未到達・エラー 0) → success', async () => {
    const fetchImpl = mockOrdersFetch([{ nodes: [order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z')] }]);
    await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(auditCall()).toMatchObject({ result: 'success', metadata: { capped: false } });
  });

  it('🚨cap 到達 (エラー 0) → failure (= pending に残り sweep が再訪する。放置しない)', async () => {
    const fetchImpl = mockOrdersFetch([
      { nodes: [order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z')], hasNextPage: true, endCursor: 'c1' },
      { nodes: [order('gid://shopify/Order/2', '1000', '2026-05-02T00:00:00Z')], hasNextPage: true, endCursor: 'c2' },
    ]);
    const r = await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, maxPages: 2, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.capped).toBe(true);
    expect(r.errors).toBe(0);
    expect(auditCall()).toMatchObject({ result: 'failure', metadata: { capped: true } });
  });

  it('個別エラーあり → failure', async () => {
    addPurchaseEventMock.mockRejectedValueOnce(new Error('db busy'));
    const fetchImpl = mockOrdersFetch([{ nodes: [order('gid://shopify/Order/1', '1000', '2026-05-01T00:00:00Z')] }]);
    await backfillCustomerOrders(fakeDb, ENV_ON, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(auditCall()).toMatchObject({ result: 'failure' });
  });
});

// ============================================================
// isPurchaseImportPending — 「取り込み中」の判定 (2026-08-28)
// ============================================================
import { isPurchaseImportPending } from '../services/member-purchase-backfill.js';

describe('isPurchaseImportPending', () => {
  function spyDb(row: unknown, opts: { throws?: boolean } = {}) {
    const sqls: string[] = [];
    const binds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        sqls.push(sql);
        return {
          bind: (...p: unknown[]) => {
            binds.push(p);
            return {
              first: async () => {
                if (opts.throws) throw new Error('D1 down');
                return row;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    return { db, sqls, binds };
  }

  it('完了 audit があれば false (= 取り込み済み)', async () => {
    const { db } = spyDb({ n: 1 });
    expect(await isPurchaseImportPending(db, 'f1')).toBe(false);
  });

  it('完了 audit が無ければ true (= 取り込み中)', async () => {
    const { db } = spyDb(null);
    expect(await isPurchaseImportPending(db, 'f1')).toBe(true);
  });

  it('判定できないときは false (= 余計なことを言わない fail-honest)', async () => {
    const { db } = spyDb(null, { throws: true });
    expect(await isPurchaseImportPending(db, 'f1')).toBe(false);
  });

  // 🚨 Codex P1 (2026-08-28)。解除→再連携は**こちらから案内している復旧手順**なので、
  //    前回の連携の完了 audit を拾うと「取り込み中」と言わずに ¥0 のランクを断定する。
  it('🚨 SQL が「直近の連携解除より後」に限定し、friendId を 2 回 bind する', async () => {
    const { db, sqls, binds } = spyDb(null);
    await isPurchaseImportPending(db, 'f-target');
    const sql = sqls[0] ?? '';
    expect(sql).toContain("a.action = 'loyalty_purchase_backfill.completed'");
    expect(sql).toContain("u.action IN ('account_link.unlink_boundary', 'account_link.unlinked')");
    expect(sql).toContain('MAX(u.created_at)');
    // 解除記録が無い friend を弾かないための既定値
    expect(sql).toContain("), '')");
    // 外側 (a.target_id) と内側 (u.target_id) の 2 箇所に同じ friendId が要る。
    // 1 回しか bind しないと内側が未束縛になり判定が壊れる。
    expect(binds[0]).toEqual(['f-target', 'f-target']);
    expect((sql.match(/target_id = \?/g) ?? []).length).toBe(2);
  });
});
