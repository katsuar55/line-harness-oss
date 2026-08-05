/**
 * サブスク契約 read-model 導出のテスト (WI-1, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)
 *
 * 対象: タグ解析 (注文/顧客)・周期解析・JST 日付・推定次回決済日・
 *       同一注文再送/巻き戻り防止・顧客タグ反映 (解約/一時停止/スキップ)・
 *       rebuild (webhook 行限定・冪等・skip 基準正規化)・IDOR ガード。
 * fake D1 は実 SQL の LIKE / keyset / ON CONFLICT 挙動を再現する (採点R1: fake と実 SQL の乖離修正)。
 */
import { describe, it, expect } from 'vitest';
import {
  parseOrderSubscriptionTags,
  parseCustomerSubscriptionTags,
  parseSellingPlanName,
  parseIntervalDays,
  toJstDate,
  addDays,
  computeNextBillingEstimate,
  computeFlowBillingEstimate,
  recordFlowMeasurement,
  deriveContractFromOrder,
  applyCustomerTagsToContracts,
  rebuildContractsFromD1,
  resolveRebuildAnchor,
  isSubscriptionIngestEnabled,
} from '../services/subscription-contracts.js';
import { getContractForFriend } from '../services/subscription-concierge.js';
import {
  upsertSubscriptionContract,
  getSubscriptionContract,
  listContractsDueForReminder,
  listContractsPendingRecovery,
} from '@line-crm/db';

/**
 * 実測の記録。route と同じく「実在行を解決してから渡す」形をなぞる
 * (recordFlowMeasurement は phantom 行を作らないよう行を受け取る)。
 */
async function measure(db: D1Database, contractId: string, date: string) {
  const row = await getSubscriptionContract(db, contractId);
  if (!row) throw new Error(`契約 ${contractId} が存在しない (テストの前提ミス)`);
  return recordFlowMeasurement(db, row, date);
}

// ===== fake D1 =====

interface ContractRow {
  contract_id: string;
  shopify_customer_id: string | null;
  plan_name: string | null;
  interval_days: number | null;
  order_count: number | null;
  last_order_id: string | null;
  last_order_at: string | null;
  last_delivery_date: string | null;
  skip_count: number;
  skip_count_at_last_order: number;
  paused_at: string | null;
  cancelled_at: string | null;
  next_billing_estimate: string | null;
  estimate_source: string;
  flow_estimate_anchor: string | null;
  skip_count_at_estimate: number;
  flow_measured_at: string | null;
  reminded_for_estimate: string | null;
  recovery_pending_at: string | null;
  recovery_notified_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

const WEBHOOK_META = '{"source":"webhook","topic":"orders/create"}';

function createFakeDb(seed?: {
  orders?: Array<Record<string, unknown>>;
  customers?: Array<Record<string, unknown>>;
}) {
  const contracts = new Map<string, ContractRow>();
  const orders = seed?.orders ?? [];
  const customers = seed?.customers ?? [];

  const db = {
    contracts,
    prepare(sql: string) {
      // 実 D1 同様、bind() 無しでも first/all/run を呼べるようにする
      const exec = (binds: unknown[]) => ({
        async first() {
          if (sql.includes('FROM subscription_contracts WHERE contract_id')) {
            return contracts.get(binds[0] as string) ?? null;
          }
          throw new Error(`fake first() unsupported sql: ${sql}`);
        },
        async all() {
          if (sql.includes('skip_count_at_last_order != skip_count')) {
            // 基準値は 2 本 (導出用/実測用)。片方だけ見る実装に戻ると flow 行の drift が
            // 残って rebuild が冪等でなくなるため、SQL 文字列の実在も検証する
            if (!sql.includes('skip_count_at_estimate != skip_count')) {
              throw new Error('drift SQL から実測側の基準値 (skip_count_at_estimate) が消えている');
            }
            return {
              results: [...contracts.values()].filter(
                (r) =>
                  r.skip_count_at_last_order !== r.skip_count ||
                  r.skip_count_at_estimate !== r.skip_count,
              ),
            };
          }
          if (sql.includes('next_billing_estimate >= ?')) {
            // WI-2 リマインド対象 list (採点R4 MEDIUM): 範囲述語は claim SQL に重複がなく
            // 無防備だったため、SQL 文字列の実在検証 + 実評価の両方で退行を fail させる
            for (const p of [
              'next_billing_estimate >= ?',
              'next_billing_estimate <= ?',
              'cancelled_at IS NULL',
              'paused_at IS NULL',
              // C2: 実測限定 + 鮮度。これが消えると導出 (derived) や前サイクルの古い実測に
              // リマインドが飛ぶ (お届け日変更を追えない日付での誤送信 = 回復不能)
              "estimate_source = 'flow'",
              'flow_measured_at IS NOT NULL',
              "flow_measured_at >= datetime('now','+9 hours','-10 day')",
              '(reminded_for_estimate IS NULL OR reminded_for_estimate != next_billing_estimate)',
            ]) {
              if (!sql.includes(p)) throw new Error(`list SQL から述語が消えている: ${p}`);
            }
            const [from, to, limit] = binds as [string, string, number];
            const freshFloor = new Date(Date.now() + 9 * 3600_000 - 10 * 86_400_000)
              .toISOString()
              .replace('T', ' ')
              .slice(0, 19);
            const rows = [...contracts.values()].filter(
              (r) =>
                r.next_billing_estimate !== null &&
                r.next_billing_estimate >= from &&
                r.next_billing_estimate <= to &&
                r.cancelled_at === null &&
                r.paused_at === null &&
                r.estimate_source === 'flow' &&
                r.flow_measured_at !== null &&
                r.flow_measured_at >= freshFloor &&
                (r.reminded_for_estimate === null ||
                  r.reminded_for_estimate !== r.next_billing_estimate),
            );
            return { results: rows.slice(0, limit) };
          }
          if (sql.includes('recovery_pending_at IS NOT NULL')) {
            for (const p of [
              'recovery_pending_at IS NOT NULL',
              'recovery_notified_at IS NULL',
              'paused_at IS NOT NULL',
              'cancelled_at IS NULL',
              // 鮮度 (TTL) 述語。これが消えると、送信面が閉じている間に溜まった古いマーカーが
              // gate を開けた瞬間に一斉 flush される (「たった今一時停止しました」を数週間後に送る)
              "recovery_pending_at >= datetime('now','+9 hours','-3 day')",
            ]) {
              if (!sql.includes(p)) throw new Error(`list SQL から述語が消えている: ${p}`);
            }
            const limit = binds[0] as number;
            const ttlFloor = new Date(Date.now() + 9 * 3600_000 - 3 * 86_400_000)
              .toISOString()
              .replace('T', ' ')
              .slice(0, 19);
            const rows = [...contracts.values()].filter(
              (r) =>
                r.recovery_pending_at !== null &&
                r.recovery_notified_at === null &&
                r.paused_at !== null &&
                r.cancelled_at === null &&
                (r.recovery_pending_at as string) >= ttlFloor,
            );
            return { results: rows.slice(0, limit) };
          }
          if (sql.includes('FROM subscription_contracts')) {
            const cid = binds[0] as string;
            const rows = [...contracts.values()]
              .filter((r) => r.shopify_customer_id === cid)
              .sort((a, b) => {
                const aActive = a.cancelled_at === null ? 1 : 0;
                const bActive = b.cancelled_at === null ? 1 : 0;
                if (aActive !== bActive) return bActive - aActive;
                return (b.last_order_at ?? '').localeCompare(a.last_order_at ?? '');
              });
            return { results: rows.slice(0, 10) };
          }
          if (sql.includes('FROM shopify_orders')) {
            // 実 SQL: WHERE tags LIKE '%subscription-id:%' AND keyset > cursor ORDER BY created_at, id LIMIT 500
            const cursorAt = (binds[0] as string) ?? '';
            const cursorId = (binds[2] as string) ?? '';
            const rows = orders
              .filter((o) => String(o.tags ?? '').includes('subscription-id:'))
              .filter((o) => {
                const at = String(o.created_at);
                const id = String(o.shopify_order_id);
                return at > cursorAt || (at === cursorAt && id > cursorId);
              })
              .sort(
                (a, b) =>
                  String(a.created_at).localeCompare(String(b.created_at)) ||
                  String(a.shopify_order_id).localeCompare(String(b.shopify_order_id)),
              )
              .slice(0, 500);
            return { results: rows };
          }
          if (sql.includes('FROM shopify_customers')) {
            const cursor = (binds[0] as string) ?? '';
            const rows = customers
              .filter((c) => String(c.tags ?? '').includes('subscription-'))
              .filter((c) => String(c.shopify_customer_id) > cursor)
              .sort((a, b) =>
                String(a.shopify_customer_id).localeCompare(String(b.shopify_customer_id)),
              )
              .slice(0, 500);
            return { results: rows };
          }
          throw new Error(`fake all() unsupported sql: ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT INTO subscription_contracts')) {
            // 列と bind の対応は **SQL の列リストから導出**する。添字を手書きすると、
            // 列追加のたびにズレて「静かに間違った行を作る fake」になりうる
            const insertCols = sql
              .slice(sql.indexOf('(') + 1, sql.indexOf(') VALUES'))
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            // VALUES(...) の ? だけを数える (ON CONFLICT 以降の SET 句の ? を含めない)
            const valuesPart = sql.slice(sql.indexOf(') VALUES'), sql.indexOf('ON CONFLICT'));
            const placeholders = (valuesPart.match(/\?/g) ?? []).length;
            if (insertCols.length !== placeholders) {
              throw new Error(
                `fake: INSERT 列数 ${insertCols.length} と placeholder 数 ${placeholders} が不一致`,
              );
            }
            const contractId = binds[0] as string;
            const existing = contracts.get(contractId);
            if (!existing) {
              const row = Object.fromEntries(
                insertCols.map((col, i) => [col, binds[i]]),
              ) as unknown as ContractRow;
              // NOT NULL DEFAULT を持つ列は null 束縛でも既定値になる
              row.skip_count ??= 0;
              row.skip_count_at_last_order ??= 0;
              row.skip_count_at_estimate ??= 0;
              row.estimate_source ??= 'derived';
              contracts.set(contractId, row);
            } else {
              // ON CONFLICT DO UPDATE SET a = ?, b = ? … を実際の SET 句から再現する
              const setPart = sql.split('DO UPDATE SET')[1];
              if (!setPart) throw new Error('fake: DO UPDATE SET missing');
              const cols = setPart.split(',').map((s) => s.trim().split(' ')[0]);
              const setBinds = binds.slice(insertCols.length);
              cols.forEach((col, i) => {
                (existing as Record<string, unknown>)[col] = setBinds[i];
              });
            }
            return { meta: { changes: 1 } };
          }
          throw new Error(`fake run() unsupported sql: ${sql}`);
        },
      });
      return { bind: (...binds: unknown[]) => exec(binds), ...exec([]) };
    },
  };
  return db as unknown as D1Database & { contracts: Map<string, ContractRow> };
}

// ===== 純粋関数 =====

describe('parseOrderSubscriptionTags', () => {
  it('null / 空 / 非サブスクタグは null', () => {
    expect(parseOrderSubscriptionTags(null)).toBeNull();
    expect(parseOrderSubscriptionTags('')).toBeNull();
    expect(parseOrderSubscriptionTags('vip, repeat-customer')).toBeNull();
  });

  it('契約ID・回数・お届け日タグを抽出する', () => {
    const r = parseOrderSubscriptionTags(
      'subscription-id:12345, subscription-count:3, delivery-12345:2026-08-04 14時-16時',
    );
    expect(r).toEqual({ contractId: '12345', orderCount: 3, deliveryDate: '2026-08-04' });
  });

  it('別契約の delivery タグは拾わない', () => {
    const r = parseOrderSubscriptionTags('subscription-id:1, delivery-2:2026-08-04');
    expect(r?.contractId).toBe('1');
    expect(r?.deliveryDate).toBeNull();
  });

  it('count 欠落でも契約IDだけで成立する', () => {
    const r = parseOrderSubscriptionTags('subscription-id:99');
    expect(r).toEqual({ contractId: '99', orderCount: null, deliveryDate: null });
  });
});

describe('parseCustomerSubscriptionTags', () => {
  it('契約ID別に plan/cancel/pause/skip-count を仕分ける', () => {
    const map = parseCustomerSubscriptionTags(
      'subscription-11-plan:[5％OFF定期便] 30日に1回配送（2回目からは5%OFF), ' +
        'subscription-11-skip-count:2, subscription-22-cancel:2026-07-10, vip',
    );
    expect(map.get('11')?.planName).toContain('30日に1回配送');
    expect(map.get('11')?.skipCount).toBe(2);
    expect(map.get('11')?.cancelledAt).toBeNull();
    expect(map.get('22')?.cancelledAt).toBe('2026-07-10');
    expect(map.has('vip')).toBe(false);
  });

  it('pause タグと数値でない skip-count', () => {
    const map = parseCustomerSubscriptionTags(
      'subscription-5-pause:2026-07-12, subscription-5-skip-count:abc',
    );
    expect(map.get('5')?.pausedAt).toBe('2026-07-12');
    expect(map.get('5')?.skipCount).toBeNull();
  });
});

describe('parseSellingPlanName / parseIntervalDays', () => {
  it('line_items JSON から selling plan 名を取り出す', () => {
    const json = JSON.stringify([
      { title: 'naturism Premium', selling_plan_allocation: { selling_plan: { name: '[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)' } } },
    ]);
    expect(parseSellingPlanName(json)).toContain('30日に1回配送');
  });

  it('selling plan なし / 壊れた JSON は null', () => {
    expect(parseSellingPlanName(JSON.stringify([{ title: 'one-time' }]))).toBeNull();
    expect(parseSellingPlanName('{broken')).toBeNull();
    expect(parseSellingPlanName(null)).toBeNull();
  });

  it('周期日数の解析', () => {
    expect(parseIntervalDays('[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)')).toBe(30);
    expect(parseIntervalDays('[2回目以降]90日に1回配送（5%OFF)')).toBe(90);
    expect(parseIntervalDays('100日に1回配送')).toBe(100);
    expect(parseIntervalDays('毎月お届け')).toBeNull();
    expect(parseIntervalDays(null)).toBeNull();
  });
});

describe('toJstDate / addDays', () => {
  it('タイムゾーンつき ISO は JST に変換する', () => {
    expect(toJstDate('2026-07-05T23:30:00+09:00')).toBe('2026-07-05');
    // UTC 20:30 = JST 翌 05:30
    expect(toJstDate('2026-07-05T20:30:00Z')).toBe('2026-07-06');
  });

  it('タイムゾーン無し (jstNow 形式) は日付部をそのまま使う', () => {
    expect(toJstDate('2026-07-05 10:00:00')).toBe('2026-07-05');
  });

  it('解釈不能は null', () => {
    expect(toJstDate('garbage')).toBeNull();
    expect(toJstDate(null)).toBeNull();
  });

  it('addDays は月末・年末をまたげる', () => {
    expect(addDays('2026-07-30', 5)).toBe('2026-08-04');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
  });
});

describe('computeNextBillingEstimate', () => {
  const base = {
    last_order_at: '2026-07-05T10:00:00+09:00',
    interval_days: 30,
    skip_count: 0,
    skip_count_at_last_order: 0,
    cancelled_at: null,
    paused_at: null,
  };

  it('直近注文 + 周期', () => {
    expect(computeNextBillingEstimate(base)).toBe('2026-08-04');
  });

  it('直近注文以降のスキップは周期ぶん先送り', () => {
    expect(computeNextBillingEstimate({ ...base, skip_count: 2 })).toBe('2026-10-03');
    // 過去のスキップ (基準値と同じ) は影響しない
    expect(
      computeNextBillingEstimate({ ...base, skip_count: 2, skip_count_at_last_order: 2 }),
    ).toBe('2026-08-04');
  });

  it('解約・一時停止・周期不明・注文不明は null (嘘をつかない)', () => {
    expect(computeNextBillingEstimate({ ...base, cancelled_at: '2026-07-10' })).toBeNull();
    expect(computeNextBillingEstimate({ ...base, paused_at: '2026-07-10' })).toBeNull();
    expect(computeNextBillingEstimate({ ...base, interval_days: null })).toBeNull();
    expect(computeNextBillingEstimate({ ...base, last_order_at: null })).toBeNull();
  });
});

describe('computeFlowBillingEstimate (migration 074: 実測アンカー + スキップ増分)', () => {
  const base = {
    flow_estimate_anchor: '2026-08-10',
    interval_days: 30,
    skip_count: 0,
    skip_count_at_estimate: 0,
    cancelled_at: null,
    paused_at: null,
  };

  it('増分ゼロならアンカーそのもの (実測を動かさない)', () => {
    expect(computeFlowBillingEstimate(base)).toBe('2026-08-10');
    // 実測受信時点で既にあったスキップは織り込み済み = 影響しない
    expect(
      computeFlowBillingEstimate({ ...base, skip_count: 3, skip_count_at_estimate: 3 }),
    ).toBe('2026-08-10');
  });

  it('実測後のスキップだけが周期ぶん先送りされる (導出の 1+delta とは違い delta のみ)', () => {
    expect(computeFlowBillingEstimate({ ...base, skip_count: 1 })).toBe('2026-09-09');
    expect(computeFlowBillingEstimate({ ...base, skip_count: 2 })).toBe('2026-10-09');
    expect(
      computeFlowBillingEstimate({ ...base, skip_count: 4, skip_count_at_estimate: 3 }),
    ).toBe('2026-09-09');
  });

  it('累計の減少 (スキップ取消) では前倒ししない', () => {
    expect(
      computeFlowBillingEstimate({ ...base, skip_count: 1, skip_count_at_estimate: 3 }),
    ).toBe('2026-08-10');
  });

  it('解約・一時停止・アンカー無しは null', () => {
    expect(computeFlowBillingEstimate({ ...base, cancelled_at: '2026-08-01' })).toBeNull();
    expect(computeFlowBillingEstimate({ ...base, paused_at: '2026-08-01' })).toBeNull();
    expect(computeFlowBillingEstimate({ ...base, flow_estimate_anchor: null })).toBeNull();
  });

  it('🚨周期不明: 未消化スキップがあるなら null、無いならアンカー保持', () => {
    // 先送り幅が計算できないのに古い日付を保持すると誤送信になる
    expect(
      computeFlowBillingEstimate({ ...base, interval_days: null, skip_count: 1 }),
    ).toBeNull();
    // スキップが無ければ実測はそのまま正しい (周期は先送り計算にしか要らない)
    expect(computeFlowBillingEstimate({ ...base, interval_days: null })).toBe('2026-08-10');
  });
});

// ===== D1 導出 =====

const PLAN_30 = '[5％OFF定期便] 30日に1回配送（2回目からは5%OFF)';
const ITEMS_30 = JSON.stringify([
  { title: 'naturism Premium 180粒', selling_plan_allocation: { selling_plan: { name: PLAN_30 } } },
]);

describe('deriveContractFromOrder', () => {
  it('サブスク注文から契約を作成し推定日を計算する', async () => {
    const db = createFakeDb();
    const row = await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1, delivery-100:2026-07-08',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    expect(row?.contract_id).toBe('100');
    expect(row?.interval_days).toBe(30);
    expect(row?.order_count).toBe(1);
    expect(row?.last_delivery_date).toBe('2026-07-08');
    expect(row?.next_billing_estimate).toBe('2026-08-04');
  });

  it('非サブスク注文は何もしない', async () => {
    const db = createFakeDb();
    const row = await deriveContractFromOrder(db, {
      tags: 'vip',
      lineItemsJson: null,
      shopifyOrderId: 'ord-2',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    expect(row).toBeNull();
    expect(db.contracts.size).toBe(0);
  });

  it('古い注文の再送で last_order_* が巻き戻らない', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:2',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-new',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    const row = await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-old',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-06-05T10:00:00+09:00',
    });
    expect(row?.last_order_id).toBe('ord-new');
    expect(row?.order_count).toBe(2);
    expect(row?.next_billing_estimate).toBe('2026-08-04');
  });

  it('🚨採点R1 HIGH: 同一注文の orders/updated 再送でスキップ先送りが巻き戻らない', async () => {
    const db = createFakeDb();
    // ①7/5 注文 → 推定 8/4
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    // ②顧客がスキップ → 推定 9/3 に先送り
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-09-03');
    // ③同一注文の orders/updated 再送 (出荷/タグ編集で高頻度) → 先送りが維持される
    const row = await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1, delivery-100:2026-07-08',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    expect(row?.skip_count_at_last_order).toBe(0);
    expect(row?.next_billing_estimate).toBe('2026-09-03');
    // 再送によるタグ後付け (delivery) は補完される
    expect(row?.last_delivery_date).toBe('2026-07-08');
  });

  it('新しい別注文が来たら skip 基準値を現累計にリセットする', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-06-05T10:00:00+09:00',
    });
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-08-04'); // 6/5+30×2

    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:2',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-2',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-08-04T10:00:00+09:00',
    });
    const row = db.contracts.get('100')!;
    expect(row.skip_count_at_last_order).toBe(1);
    expect(row.next_billing_estimate).toBe('2026-09-03');
  });
});

describe('applyCustomerTagsToContracts', () => {
  it('解約タグで cancelled_at + 推定 null', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-cancel:2026-07-12`,
    );
    const row = db.contracts.get('100')!;
    expect(row.cancelled_at).toBe('2026-07-12');
    expect(row.next_billing_estimate).toBeNull();
  });

  it('一時停止 → タグ消滅 (再開) で推定が復活する', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    expect(db.contracts.get('100')!.paused_at).toBe('2026-07-12');
    expect(db.contracts.get('100')!.next_billing_estimate).toBeNull();

    // 再開 = pause タグが消えて plan タグだけ残る
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    expect(db.contracts.get('100')!.paused_at).toBeNull();
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-08-04');
  });

  it('注文が先に無くても顧客タグだけで契約行を作れる (周期は plan タグから)', async () => {
    const db = createFakeDb();
    const result = await applyCustomerTagsToContracts(
      db,
      'cust-9',
      `subscription-500-plan:${PLAN_30}`,
    );
    expect(result.applied).toBe(1);
    const row = db.contracts.get('500')!;
    expect(row.shopify_customer_id).toBe('cust-9');
    expect(row.interval_days).toBe(30);
    // 注文が無いので推定は出さない
    expect(row.next_billing_estimate).toBeNull();
  });

  it('顧客タグの plan 名 (カンマで断片化しうる) は既存 plan/interval を上書きしない', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    // カンマ分割で先頭断片だけになった plan タグが来ても、selling plan 由来の値が残る
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-plan:[5％OFF定期便] 断片');
    const row = db.contracts.get('100')!;
    expect(row.plan_name).toBe(PLAN_30);
    expect(row.interval_days).toBe(30);
  });

  it('WI-2: pause 遷移は初回のみ transitions に載り、pending マーカーが pause 書込と原子的に立つ', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    const first = await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    expect(first.transitions).toEqual([
      { contractId: '100', becamePaused: true, becameCancelled: false, becameResumed: false },
    ]);
    expect(db.contracts.get('100')!.recovery_pending_at).not.toBeNull();
    // 同一タグの再受信 (customers/update は高頻度) → 遷移なし
    const again = await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    expect(again.transitions).toEqual([]);
  });

  it('🚨採点R2: resume 遷移で両マーカーがリセットされ、2回目の決済失敗も通知可能 (永久ラッチ防止)', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    // 1回目の失敗 → pause → 通知済み相当 (notified を疑似セット)
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`);
    const row1 = db.contracts.get('100')!;
    row1.recovery_notified_at = '2026-07-13 10:00:00';
    // 顧客が支払方法を更新して再開 → 両マーカーがリセットされる
    const resumed = await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    expect(resumed.transitions[0]?.becameResumed).toBe(true);
    expect(db.contracts.get('100')!.recovery_pending_at).toBeNull();
    expect(db.contracts.get('100')!.recovery_notified_at).toBeNull();
    // 数ヶ月後の 2 回目の失敗 → pending が再度立つ (契約生涯1回のラッチにならない)
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-12-01`);
    expect(db.contracts.get('100')!.recovery_pending_at).not.toBeNull();
    expect(db.contracts.get('100')!.recovery_notified_at).toBeNull();
  });

  it('🚨採点R3: suppressRecoveryMarkers で pause 遷移してもマーカーを立てない (rebuild 用)', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    const r = await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
      { suppressRecoveryMarkers: true },
    );
    // 状態 (paused_at) は反映されるが、リカバリ通知の検知マーカーは立たない
    expect(r.transitions[0]?.becamePaused).toBe(true);
    expect(db.contracts.get('100')!.paused_at).toBe('2026-07-12');
    expect(db.contracts.get('100')!.recovery_pending_at ?? null).toBeNull();
  });

  it('🚨採点R2: 初見行 (read-model 未登録) の pause タグは遷移扱いしない (過去の停止に通知しない)', async () => {
    const db = createFakeDb();
    const r = await applyCustomerTagsToContracts(
      db,
      'cust-new',
      `subscription-900-plan:${PLAN_30}, subscription-900-pause:2026-01-01`,
    );
    expect(r.applied).toBe(1);
    expect(r.transitions).toEqual([]);
    expect(db.contracts.get('900')!.recovery_pending_at ?? null).toBeNull();
  });

  it('WI-2: 新しい実注文 (決済成功) で両マーカーが掃除される', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`);
    // 再開タグ + 新注文 (次サイクル決済成功)
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    db.contracts.get('100')!.recovery_pending_at = '2026-07-12 09:00:00'; // 残骸を疑似再現
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:2',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-2',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-08-04T10:00:00+09:00',
    });
    expect(db.contracts.get('100')!.recovery_pending_at).toBeNull();
    expect(db.contracts.get('100')!.recovery_notified_at).toBeNull();
  });
});

describe('rebuildContractsFromD1', () => {
  const seed = () => ({
    orders: [
      {
        shopify_order_id: 'o1',
        shopify_customer_id: 'c1',
        tags: 'subscription-id:100, subscription-count:1',
        line_items: ITEMS_30,
        created_at: '2026-07-01 10:00:00',
        metadata: WEBHOOK_META,
      },
      {
        shopify_order_id: 'o2',
        shopify_customer_id: 'c1',
        tags: 'subscription-id:100, subscription-count:2, delivery-100:2026-08-03',
        line_items: ITEMS_30,
        created_at: '2026-07-31 10:00:00',
        metadata: WEBHOOK_META,
      },
      // 非サブスク注文 → SQL の LIKE で除外され scan 対象にならない
      {
        shopify_order_id: 'o3',
        shopify_customer_id: 'c2',
        tags: null,
        line_items: null,
        created_at: '2026-07-02 10:00:00',
        metadata: WEBHOOK_META,
      },
      // 手動 sync 行 → created_at が取り込み時刻のため推定の根拠にしない (skip 計上)
      {
        shopify_order_id: 'o4',
        shopify_customer_id: 'c1',
        tags: 'subscription-id:100, subscription-count:1',
        line_items: ITEMS_30,
        created_at: '2026-07-03 10:00:00',
        metadata: '{"source":"manual_sync"}',
      },
    ],
    customers: [
      { shopify_customer_id: 'c1', tags: `subscription-100-plan:${PLAN_30}, subscription-100-skip-count:2` },
      { shopify_customer_id: 'c3', tags: 'subscription-200-cancel:2026-07-01' },
    ],
  });

  it('既存 D1 の webhook 由来データから一括再構築する (Shopify API 不要)', async () => {
    const db = createFakeDb(seed());
    const result = await rebuildContractsFromD1(db);
    expect(result.ordersScanned).toBe(3); // LIKE で o3 除外、o1/o2/o4 が対象
    expect(result.skippedNonWebhook).toBe(1); // o4 (manual_sync)
    expect(result.ordersFailed).toBe(0);
    expect(result.contractsSeen).toBe(1);
    expect(result.customersScanned).toBe(2);
    expect(result.truncated).toBe(false);

    const c100 = db.contracts.get('100')!;
    expect(c100.last_order_id).toBe('o2');
    expect(c100.order_count).toBe(2);
    // skip 基準は正規化 (過去スキップは消化済みとみなす) → 推定 = 直近注文 + 周期
    expect(c100.skip_count).toBe(2);
    expect(c100.skip_count_at_last_order).toBe(2);
    expect(c100.next_billing_estimate).toBe('2026-08-30'); // 7/31 + 30
    expect(result.baselinesNormalized).toBe(1);

    // 顧客タグだけの契約 (解約済みで注文情報なし) も行になる
    expect(db.contracts.get('200')!.cancelled_at).toBe('2026-07-01');
  });

  it('🚨これを壊すと誤送信になる: pass3 の基準値正規化は実測の受信時刻も無効化する', async () => {
    // pass3 は skip 基準値を現累計へ揃える = flow 行の**未消化スキップの先送りを恒久的に消す**
    // (推定日がアンカーへ巻き戻る)。鮮度だけ残すと、巻き戻った古い日付が送信資格を保ったまま
    // 窓に入りうる。受信時刻も落として「次の Flow 発火まで無送信」に倒すのが安全側。
    const db = createFakeDb();
    await upsertSubscriptionContract(db, {
      contractId: '400',
      shopifyCustomerId: 'c4',
      intervalDays: 30,
      // 未消化スキップがある実測行 (= pass3 の正規化対象)
      skipCount: 1,
      skipCountAtLastOrder: 0,
      estimateSource: 'flow',
      flowEstimateAnchor: '2026-09-01',
      skipCountAtEstimate: 0,
      nextBillingEstimate: '2026-10-01', // 9/01 + 30×1
      flowMeasuredAt: '2026-08-20 10:00:00',
    });

    const result = await rebuildContractsFromD1(db);

    const row = db.contracts.get('400')!;
    expect(result.baselinesNormalized).toBe(1);
    expect(row.skip_count_at_estimate).toBe(1); // 正規化された = 先送りが消えた
    expect(row.next_billing_estimate).toBe('2026-09-01'); // アンカーへ巻き戻っている
    expect(row.flow_measured_at).toBeNull(); // その日付に送信資格を与えない
  });

  it('🚨採点R3: rebuild 経由では recovery_pending_at が立たない (歴史的 pause への一斉通知防止)', async () => {
    // pass1 が契約行を paused_at=null で先に作る → pass2 の pause タグが「遷移」に見える
    // 迂回路。ここでマーカーが立つと gate ON 直後に stale な「一時停止しました」が一斉送信される。
    const db = createFakeDb({
      orders: [
        {
          shopify_order_id: 'o1',
          shopify_customer_id: 'c1',
          tags: 'subscription-id:100, subscription-count:1',
          line_items: ITEMS_30,
          created_at: '2026-07-01 10:00:00',
          metadata: WEBHOOK_META,
        },
      ],
      customers: [
        {
          shopify_customer_id: 'c1',
          tags: `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-05-01`,
        },
      ],
    });
    await rebuildContractsFromD1(db);
    const row = db.contracts.get('100')!;
    expect(row.paused_at).toBe('2026-05-01'); // 状態は正しく反映
    expect(row.recovery_pending_at ?? null).toBeNull(); // マーカーは立たない
    expect(row.recovery_notified_at ?? null).toBeNull();
  });

  it('🚨採点R1: rebuild は冪等 (2回実行しても同じ結果)', async () => {
    const db = createFakeDb(seed());
    await rebuildContractsFromD1(db);
    const snapshot1 = JSON.stringify(
      [...db.contracts.entries()].map(([k, v]) => [k, { ...v, updated_at: 'x' }]),
    );
    const result2 = await rebuildContractsFromD1(db);
    const snapshot2 = JSON.stringify(
      [...db.contracts.entries()].map(([k, v]) => [k, { ...v, updated_at: 'x' }]),
    );
    expect(snapshot2).toBe(snapshot1);
    expect(result2.baselinesNormalized).toBe(0);
  });
});

describe('listContractsDueForReminder / listContractsPendingRecovery — 実 SQL を exercise (採点R4)', () => {
  // マーカー時刻は **実時計からの相対**で作る。固定日付だとその日を過ぎた瞬間に
  // TTL 述語で全件落ちて CI が確定 red になる (時限爆弾)。
  const jstAgo = (hours: number) =>
    new Date(Date.now() + 9 * 3600_000 - hours * 3600_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

  // C2: 送信資格のある行 = flow 実測 + 新しい受信時刻。テストの seed でも
  // 「資格あり」の既定をここに集約する (アンカー = 実効値、増分ゼロの自己整合形)
  const flowFresh = (estimate: string | null) => ({
    estimateSource: 'flow',
    flowEstimateAnchor: estimate,
    flowMeasuredAt: jstAgo(24), // 1日前受信 = 鮮度内
  });

  it('リマインド対象: 日付範囲 [from, to] 両端含む + 安全述語 (cancelled/paused/reminded) を実評価', async () => {
    const db = createFakeDb();
    const seed = (id: string, patch: Record<string, unknown>) =>
      upsertSubscriptionContract(db, { contractId: id, shopifyCustomerId: 'c1', ...patch });
    const at = (estimate: string | null, patch: Record<string, unknown> = {}) => ({
      nextBillingEstimate: estimate,
      ...flowFresh(estimate),
      ...patch,
    });
    await seed('in-from', at('2026-07-17')); // 下限ちょうど → 対象
    await seed('in-to', at('2026-07-18')); // 上限ちょうど → 対象
    await seed('below', at('2026-07-16')); // 範囲外 (下)
    await seed('above', at('2026-07-19')); // 範囲外 (上) — 上限述語喪失なら混入
    await seed('cancelled', at('2026-07-18', { cancelledAt: '2026-07-01' }));
    await seed('paused', at('2026-07-18', { pausedAt: '2026-07-01' }));
    await seed('reminded', at('2026-07-18', { remindedForEstimate: '2026-07-18' })); // 同一推定日は送信済み
    await seed('re-remind', at('2026-07-18', { remindedForEstimate: '2026-07-10' })); // 推定日が変わっていれば再対象
    await seed('no-estimate', at(null));

    const due = await listContractsDueForReminder(db, '2026-07-17', '2026-07-18');
    expect(due.map((r) => r.contract_id).sort()).toEqual(['in-from', 'in-to', 're-remind']);
  });

  it('🚨これを壊すと誤送信になる (C2): 導出 (derived) は窓内でも送信対象にしない', async () => {
    // 導出は「直近注文 + 周期」の推定にすぎず、お届け日変更を原理的に追えない。
    // 誤送信は回復不能・無送信は回復可能 — 実測が入るまで 1 通も送らないのが仕様。
    const db = createFakeDb();
    const seed = (id: string, patch: Record<string, unknown>) =>
      upsertSubscriptionContract(db, { contractId: id, shopifyCustomerId: 'c1', ...patch });
    await seed('derived-in-window', { nextBillingEstimate: '2026-07-18' }); // 既定 = derived
    await seed('flow-ok', { nextBillingEstimate: '2026-07-18', ...flowFresh('2026-07-18') });

    const due = await listContractsDueForReminder(db, '2026-07-17', '2026-07-18');
    expect(due.map((r) => r.contract_id)).toEqual(['flow-ok']);
  });

  it('🚨これを壊すと誤送信になる (C2): 古い実測・受信時刻なしの実測は送信対象にしない', async () => {
    // 「お届け日変更 + 7日前通知」の両 Flow を取りこぼした契約では、前サイクルの実測が
    // そのまま窓に入りうる。受信から 10 日を超えた実測は今サイクルの裏付けにならない。
    const db = createFakeDb();
    const seed = (id: string, patch: Record<string, unknown>) =>
      upsertSubscriptionContract(db, { contractId: id, shopifyCustomerId: 'c1', ...patch });
    const base = { nextBillingEstimate: '2026-07-18', ...flowFresh('2026-07-18') };
    await seed('fresh', { ...base, flowMeasuredAt: jstAgo(24) });
    await seed('edge-inside', { ...base, flowMeasuredAt: jstAgo(24 * 10 - 2) }); // 10日の内側
    await seed('stale', { ...base, flowMeasuredAt: jstAgo(24 * 11) }); // 11日前 = 期限切れ
    await seed('no-measured-at', { ...base, flowMeasuredAt: null }); // 075 適用前の既存 flow 行

    const due = await listContractsDueForReminder(db, '2026-07-17', '2026-07-18');
    expect(due.map((r) => r.contract_id).sort()).toEqual(['edge-inside', 'fresh']);
  });

  it('リカバリ対象: pending 有り・未送信・一時停止中・未解約のみ', async () => {
    const db = createFakeDb();
    const seed = (id: string, patch: Record<string, unknown>) =>
      upsertSubscriptionContract(db, { contractId: id, shopifyCustomerId: 'c1', ...patch });
    const paused = jstAgo(10);
    await seed('target', { pausedAt: paused, recoveryPendingAt: jstAgo(9) });
    await seed('no-pending', { pausedAt: paused });
    await seed('notified', {
      pausedAt: paused,
      recoveryPendingAt: jstAgo(9),
      recoveryNotifiedAt: jstAgo(1),
    });
    await seed('resumed', { recoveryPendingAt: jstAgo(9) }); // paused_at null
    await seed('cancelled', {
      pausedAt: paused,
      recoveryPendingAt: jstAgo(9),
      cancelledAt: paused,
    });

    const pending = await listContractsPendingRecovery(db);
    expect(pending.map((r) => r.contract_id)).toEqual(['target']);
  });

  it('🚨これを壊すと誤送信になる: 3日を超えた古いマーカーは送信対象にしない', async () => {
    // 送信面が閉じている期間に溜まったマーカーが、gate を開けた瞬間に一斉 flush されると
    // 「たった今一時停止しました」を数週間後に送ることになる。TTL はその恒久ガード。
    const db = createFakeDb();
    const seed = (id: string, hoursAgo: number) =>
      upsertSubscriptionContract(db, {
        contractId: id,
        shopifyCustomerId: 'c1',
        pausedAt: jstAgo(hoursAgo),
        recoveryPendingAt: jstAgo(hoursAgo),
      });
    await seed('fresh', 12);
    await seed('edge-inside', 24 * 3 - 2); // 3日の内側
    await seed('stale', 24 * 4); // 4日前 = 期限切れ
    await seed('very-stale', 24 * 30);

    const pending = await listContractsPendingRecovery(db);
    expect(pending.map((r) => r.contract_id).sort()).toEqual(['edge-inside', 'fresh']);
  });
});

describe('getContractForFriend (IDOR ガード)', () => {
  it('他人の契約IDでは null (存在有無も漏らさない)', async () => {
    const db = createFakeDb();
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-A',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
    const attacker = { id: 'f2', display_name: 'x', shopify_customer_id: 'cust-B' };
    expect(await getContractForFriend(db, attacker, '100')).toBeNull();
    const unlinked = { id: 'f3', display_name: 'y', shopify_customer_id: null };
    expect(await getContractForFriend(db, unlinked, '100')).toBeNull();
    const owner = { id: 'f1', display_name: 'o', shopify_customer_id: 'cust-A' };
    expect((await getContractForFriend(db, owner, '100'))?.contract_id).toBe('100');
  });
});

describe('resolveRebuildAnchor (採点R2: metadata 化け対策)', () => {
  it('order_created_at (実注文日時) があれば出所に関わらず最優先', () => {
    expect(
      resolveRebuildAnchor(
        '{"source":"manual_sync","order_created_at":"2026-07-05T10:00:00+09:00"}',
        '2026-07-31 10:00:00',
      ),
    ).toBe('2026-07-05T10:00:00+09:00');
  });

  it('order_created_at 無し + source=webhook → D1 到達時刻 (≈実時刻) を許容', () => {
    expect(resolveRebuildAnchor('{"source":"webhook","topic":"orders/create"}', '2026-07-31 10:00:00')).toBe(
      '2026-07-31 10:00:00',
    );
  });

  it('手動 sync 行 (order_created_at 無し)・壊れた JSON・null は skip (null)', () => {
    expect(resolveRebuildAnchor('{"source":"manual_sync"}', '2026-07-31 10:00:00')).toBeNull();
    expect(resolveRebuildAnchor('{broken', '2026-07-31 10:00:00')).toBeNull();
    expect(resolveRebuildAnchor(null, '2026-07-31 10:00:00')).toBeNull();
  });
});

describe('toJstDate — 和文/暦バリデーション (WI-2 採点R1)', () => {
  it('Flow 既定の和文形式 YYYY年M月D日 [hh:mm頃] を受理する', () => {
    expect(toJstDate('2026年8月4日 10:00頃')).toBe('2026-08-04');
    expect(toJstDate('2026年12月31日')).toBe('2026-12-31');
  });

  it('暦として不正な日付は素通しせず null (99月99日 表示の防止)', () => {
    expect(toJstDate('2026-99-99')).toBeNull();
    expect(toJstDate('2026-02-30 10:00:00')).toBeNull();
    expect(toJstDate('2026年13月1日')).toBeNull();
  });
});

describe('estimate_source=flow の3ルール (WI-2 採点R1)', () => {
  const seedOrder = async (db: Parameters<typeof deriveContractFromOrder>[0]) =>
    deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-1',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-07-05T10:00:00+09:00',
    });
  // 実測の書込は必ず recordFlowMeasurement を通す (= 本番と同じ経路)。raw upsert で
  // estimate_source='flow' を書くとアンカーと基準値が伴わない行になる (migration 074)。
  const promoteToFlow = async (db: Parameters<typeof deriveContractFromOrder>[0]) =>
    measure(db, '100', '2026-08-10');

  it('ルール1: Flow 実測値は導出 (顧客タグ由来の再計算) で上書きされない', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    // スキップを伴わない再計算 (plan タグの補完等) では flow 値は不変。
    // 導出値は 2026-08-04 (7/5 + 30) なので、上書きされていれば検出できる
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    const row = db.contracts.get('100')!;
    expect(row.next_billing_estimate).toBe('2026-08-10');
    expect(row.estimate_source).toBe('flow');
    // C2: 実測記録は受信時刻も残す (リマインドの鮮度述語が読む。無いと永久に送信対象外)
    expect(row.flow_measured_at).not.toBeNull();
  });

  // ---- migration 074: 実測をアンカーとして、実測後のスキップ増分だけ先送りする ----
  //
  // 以前はここが早期 return で、flow 行はスキップを一切反映しなかった。その結果
  // **スキップ済みの顧客に 1 周期古い決済日でリマインドが push される**経路があった。
  // 「実測は導出で上書きしない」は維持したまま、スキップという新しい事実だけを足す。
  it('🚨これを壊すと誤送信になる: 実測後のスキップが実測日を1周期先送りする', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db); // 実測 8/10、この時点の skip 累計 = 0
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    const row = db.contracts.get('100')!;
    // 8/10 のままだと「スキップ済みと分かっている顧客」へ 8/10 で決済リマインドを送る
    expect(row.next_billing_estimate).toBe('2026-09-09'); // 8/10 + 30×1
    expect(row.estimate_source).toBe('flow'); // 実測であることは失わない
    expect(row.flow_estimate_anchor).toBe('2026-08-10'); // アンカーは動かさない
  });

  it('スキップ 2 回は 2 周期ぶん先送りする (増分が累積する)', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:2');
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-10-09'); // 8/10 + 60
  });

  it('同じ skip-count の再受信では二重に先送りしない (customers/update は高頻度)', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-09-09');
  });

  it('実測受信時点で既にスキップ済みなら二重計上しない (実測が織り込み済み)', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    // 先にスキップが届き、そのあと Huckleberry が先送り後の日付を送ってくる順序
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    await measure(db, '100', '2026-09-04');
    const row = db.contracts.get('100')!;
    // 基準値が「直近注文時点」(=0) だと 10/04 になる = skip_count_at_last_order 流用の罠
    expect(row.next_billing_estimate).toBe('2026-09-04');
    expect(row.skip_count_at_estimate).toBe(1);
  });

  it('スキップ取消 (累計の減少) では実測日より前に戻さない', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:2');
    await measure(db, '100', '2026-09-04');
    await applyCustomerTagsToContracts(db, 'cust-1', 'subscription-100-skip-count:1');
    // 実測前のスキップが何日ぶんだったかは復元不能。前倒しは誤送信を生むのでアンカー据置
    expect(db.contracts.get('100')!.next_billing_estimate).toBe('2026-09-04');
  });

  it('一時停止中に実測が届いても日付は復活しない (停止中の契約にリマインドを出さない)', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    await measure(db, '100', '2026-08-10');
    const row = db.contracts.get('100')!;
    expect(row.next_billing_estimate).toBeNull();
    expect(row.flow_estimate_anchor).toBeNull(); // 再開時は Huckleberry が引き直す
    // 時刻だけ新しい行を作らない (アンカー無しで鮮度だけ通る状態を構造的に排除)
    expect(row.flow_measured_at).toBeNull();
  });

  it('🚨周期不明 + 未消化スキップでは日付を出さない (古い日付で送らない)', async () => {
    const db = createFakeDb();
    // interval_days を解析できない契約 (プラン名が無い/読めない) に実測だけが入っている状態
    await upsertSubscriptionContract(db, { contractId: '300', shopifyCustomerId: 'cust-3' });
    await measure(db, '300', '2026-09-19');
    expect(db.contracts.get('300')!.next_billing_estimate).toBe('2026-09-19');
    await applyCustomerTagsToContracts(db, 'cust-3', 'subscription-300-skip-count:1');
    // 先送り幅が計算できない。保持すると「スキップ済み顧客へ 9/19 で送信」になるため null。
    // null = 窓に入らず無送信 + カードは「マイページでご確認ください」→ 次の Flow 発火で復帰
    expect(db.contracts.get('300')!.next_billing_estimate).toBeNull();
  });

  it('ルール2: pause/cancel は flow でも null を強制 (停止中にリマインドしない)', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    expect(db.contracts.get('100')!.next_billing_estimate).toBeNull();
    // C2: 停止でアンカーを消費する時は受信時刻も消費する (再開後に古い鮮度が蘇らない)
    expect(db.contracts.get('100')!.flow_measured_at).toBeNull();
  });

  it('アンカー無しの flow 行を derived へ戻すとき受信時刻も消す (鮮度だけ残る行を作らない)', async () => {
    // 「アンカーは失ったが受信時刻は残っている」不整合行 (pause の途中失敗・手書き更新等) は
    // 本番でも作りうる。ここで時刻を残すと、日付の裏付けが無いのに鮮度述語だけ通る行になる。
    // fallback は日付・source・鮮度をまとめて整合させる掃除役なので、時刻も落とすのが不変条件
    const db = createFakeDb();
    await seedOrder(db);
    await upsertSubscriptionContract(db, {
      contractId: '100',
      estimateSource: 'flow',
      flowEstimateAnchor: null,
      flowMeasuredAt: '2026-08-01 10:00:00',
    });
    // 何らかの再計算を通す (顧客タグの再受信 = 本番で最も高頻度な経路)
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    const row = db.contracts.get('100')!;
    expect(row.estimate_source).toBe('derived');
    expect(row.flow_measured_at).toBeNull();
  });

  it('ルール2b: resume 後は null 固着せず derived で推定が復活する', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    await applyCustomerTagsToContracts(
      db,
      'cust-1',
      `subscription-100-plan:${PLAN_30}, subscription-100-pause:2026-07-12`,
    );
    // 再開 (pause タグ消滅)
    await applyCustomerTagsToContracts(db, 'cust-1', `subscription-100-plan:${PLAN_30}`);
    const row = db.contracts.get('100')!;
    expect(row.next_billing_estimate).toBe('2026-08-04'); // 7/5 + 30 (derived 再計算)
    expect(row.estimate_source).toBe('derived');
  });

  it('ルール3: 次の実注文 (決済成功) で derived に復帰し通常の推定が再開する', async () => {
    const db = createFakeDb();
    await seedOrder(db);
    await promoteToFlow(db);
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:2',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-2',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-08-10T10:00:00+09:00',
    });
    const row = db.contracts.get('100')!;
    expect(row.estimate_source).toBe('derived');
    expect(row.next_billing_estimate).toBe('2026-09-09'); // 8/10 + 30
    // 実測アンカーも役目を終える (残すと、後で再び flow になった際に古い日付が蘇りうる)
    expect(row.flow_estimate_anchor).toBeNull();
    // 受信時刻も同時に消す (次の flow 昇格で「古い時刻 + 新アンカー」が復活しないように)
    expect(row.flow_measured_at).toBeNull();
  });

  // ---- 前例なし層 (last_order_at 欠落) の非対称ルール ----
  //
  // 本番 active 139 件中 65 件が last_order_at を持たない (ローカル shopify_orders が
  // 直近60日分しか無いため)。この層では isNewerOrder が **orderAt の新旧を問わず true** になる。
  //
  // 以前はここで実測アンカーを破棄し skip 基準値をリセットしていたため、過去注文の
  // orders/updated が 1 通届くだけで推定日が**顧客が既にスキップしたサイクル**へ巻き戻った
  // (= その日付でリマインドが飛ぶ = 回復不能な誤送信)。
  // その挙動を維持していた理由 (「実測を保持すると後続スキップを反映しない」) は
  // migration 074 で解消済みなので、非対称ルールへ改めた:
  //   前例なし → 注文の事実だけ記録し、基準値・アンカー・source には触らない。
  // 基準値を残すと推定日は**未来へ**動きうる (窓の外 = 無送信 = 回復可能) が、
  // リセットすると過去へ動く (誤送信 = 回復不能)。安全側は「触らない」。
  const flowOnlyContract = async (db: ReturnType<typeof createFakeDb>) => {
    // 周期はタグ経由で判明済み・注文はローカルに無い = 本番の 65 件と同じ形
    await upsertSubscriptionContract(db, {
      contractId: '200',
      shopifyCustomerId: 'cust-2',
      intervalDays: 30,
    });
    return measure(db, '200', '2026-09-19');
  };

  it('🚨これを壊すと誤送信になる: 前例なし契約に過去注文が届いても実測が生き残る', async () => {
    const db = createFakeDb();
    await flowOnlyContract(db); // 実測 9/19 のみ (last_order_at なし)
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:200, subscription-count:3',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-old',
      shopifyCustomerId: 'cust-2',
      orderCreatedAt: '2026-08-20T10:00:00+09:00',
    });
    const row = db.contracts.get('200')!;
    // 旧挙動では derived + 9/19 (8/20+30) に差し戻っていた。日付が偶然一致していても
    // 「実測が破棄されたか」は source とアンカーで判別する
    expect(row.estimate_source).toBe('flow');
    expect(row.flow_estimate_anchor).toBe('2026-09-19');
    expect(row.next_billing_estimate).toBe('2026-09-19');
    // 注文の「事実」自体は記録される (次回以降の判定材料になる)
    expect(row.last_order_id).toBe('ord-old');
    expect(row.last_order_at).toBe('2026-08-20T10:00:00+09:00');
  });

  it('🚨これを壊すと誤送信になる: 過去注文でスキップ基準値がリセットされない', async () => {
    const db = createFakeDb();
    await flowOnlyContract(db);
    // 顧客は既に 1 回スキップ済み → 実測後の増分として先送りされている
    await applyCustomerTagsToContracts(db, 'cust-2', 'subscription-200-skip-count:1');
    expect(db.contracts.get('200')!.next_billing_estimate).toBe('2026-10-19'); // 9/19 + 30

    // ここへ過去注文が届く。基準値をリセットすると先送りが消え、
    // 顧客が既にスキップしたサイクルの日付へ巻き戻る
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:200, subscription-count:3',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-old',
      shopifyCustomerId: 'cust-2',
      orderCreatedAt: '2026-08-20T10:00:00+09:00',
    });
    const row = db.contracts.get('200')!;
    expect(row.skip_count_at_estimate).toBe(0); // リセットされていない
    expect(row.next_billing_estimate).toBe('2026-10-19'); // 先送りが生き残る
  });

  it('前例あり契約では従来どおり: 新しい注文で derived に戻り基準値もリセットされる', async () => {
    const db = createFakeDb();
    await seedOrder(db); // last_order_at = 2026-07-05 (前例あり)
    await promoteToFlow(db);
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:2',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-2',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-08-10T10:00:00+09:00',
    });
    const row = db.contracts.get('100')!;
    expect(row.estimate_source).toBe('derived');
    expect(row.flow_estimate_anchor).toBeNull();
    expect(row.next_billing_estimate).toBe('2026-09-09');
  });

  it('前例あり契約に古い注文が届いても巻き戻らない (従来の isNewerOrder ガード)', async () => {
    const db = createFakeDb();
    await seedOrder(db); // 7/05
    await deriveContractFromOrder(db, {
      tags: 'subscription-id:100, subscription-count:1',
      lineItemsJson: ITEMS_30,
      shopifyOrderId: 'ord-older',
      shopifyCustomerId: 'cust-1',
      orderCreatedAt: '2026-05-01T10:00:00+09:00',
    });
    const row = db.contracts.get('100')!;
    expect(row.last_order_at).toBe('2026-07-05T10:00:00+09:00');
    expect(row.next_billing_estimate).toBe('2026-08-04');
  });
});

describe('isSubscriptionIngestEnabled (§10-0 ①: 収集と顧客可視面の分離)', () => {
  it('既定 (両方未設定) は false = 挙動ゼロ変更', () => {
    expect(isSubscriptionIngestEnabled({})).toBe(false);
  });

  it('MENU=true は収集も含む (既存の単一 gate 運用と後方互換)', () => {
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_MENU_ENABLED: 'true' })).toBe(true);
  });

  it('INGEST=true 単独で収集が動く (顧客可視面は閉じたまま)', () => {
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_INGEST_ENABLED: 'true' })).toBe(true);
  });

  it("'true' 以外の値では有効にならない (typo / 'false' / 空文字で誤作動しない)", () => {
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_INGEST_ENABLED: 'false' })).toBe(false);
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_INGEST_ENABLED: '1' })).toBe(false);
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_INGEST_ENABLED: 'TRUE' })).toBe(false);
    expect(isSubscriptionIngestEnabled({ SUBSCRIPTION_INGEST_ENABLED: '' })).toBe(false);
  });
});
