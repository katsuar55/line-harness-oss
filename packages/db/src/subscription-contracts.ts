import { jstNow } from './utils.js';

// ===== Shopify サブスク契約 read-model (WI-1) =====
// Huckleberry「定期購買」のタグから導出した契約キャッシュへのアクセス層。
// 既存 subscription_reminders (再購入リマインド) とは別物。

export interface SubscriptionContractRow {
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
  /** 実効値 (= リマインド SQL が引く値)。flow 行では anchor にスキップ増分を足した結果 */
  next_billing_estimate: string | null;
  estimate_source: string;
  /** migration 074: Flow 実測日そのもの (先送り前)。estimate_source='flow' のときだけ意味を持つ */
  flow_estimate_anchor: string | null;
  /** migration 074: 実測を受けた時点の skip 累計。これ以降の増分だけが先送りになる */
  skip_count_at_estimate: number;
  reminded_for_estimate: string | null;
  /** WI-2 (migration 070): 決済失敗リカバリ通知の検知マーカー (送信は cron が担当) */
  recovery_pending_at: string | null;
  /** WI-2 (migration 070): リカバリ通知の送信済みマーカー (CAS claim 対象) */
  recovery_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionContractPatch {
  contractId: string;
  shopifyCustomerId?: string | null;
  planName?: string | null;
  intervalDays?: number | null;
  orderCount?: number | null;
  lastOrderId?: string | null;
  lastOrderAt?: string | null;
  lastDeliveryDate?: string | null;
  skipCount?: number;
  skipCountAtLastOrder?: number;
  pausedAt?: string | null;
  cancelledAt?: string | null;
  nextBillingEstimate?: string | null;
  estimateSource?: string;
  /**
   * migration 074。**`estimateSource: 'flow'` を単独で書かないこと** —
   * アンカーと基準値が伴わない flow 行は、次の refreshEstimate で skip 累計ぶんを
   * 丸ごと先送りする。書込は services の `recordFlowMeasurement()` に一本化してある。
   */
  flowEstimateAnchor?: string | null;
  skipCountAtEstimate?: number;
  remindedForEstimate?: string | null;
  /** WI-2: pause 遷移の検知と同一 upsert で原子的に設定/解除する (別 UPDATE に分けない) */
  recoveryPendingAt?: string | null;
  recoveryNotifiedAt?: string | null;
}

/**
 * 単文 upsert (INSERT ... ON CONFLICT DO UPDATE)。
 * **undefined のフィールドは UPDATE 句に含めない = 既存値を必ず維持** (明示的に null を渡すとクリア)。
 * 事前 SELECT したスナップショットを書き戻さないため、並行 webhook (例: customers/update の
 * 解約タグ反映 と orders/updated の導出) が交錯しても pause/cancel が巻き戻らない
 * (feedback_atomic_counter_increment の lost-update パターン対策)。
 */
export async function upsertSubscriptionContract(
  db: D1Database,
  patch: SubscriptionContractPatch,
): Promise<SubscriptionContractRow> {
  const now = jstNow();

  const insertBinds = [
    patch.contractId,
    patch.shopifyCustomerId ?? null,
    patch.planName ?? null,
    patch.intervalDays ?? null,
    patch.orderCount ?? null,
    patch.lastOrderId ?? null,
    patch.lastOrderAt ?? null,
    patch.lastDeliveryDate ?? null,
    patch.skipCount ?? 0,
    patch.skipCountAtLastOrder ?? 0,
    patch.pausedAt ?? null,
    patch.cancelledAt ?? null,
    patch.nextBillingEstimate ?? null,
    patch.estimateSource ?? 'derived',
    patch.flowEstimateAnchor ?? null,
    patch.skipCountAtEstimate ?? 0,
    patch.remindedForEstimate ?? null,
    patch.recoveryPendingAt ?? null,
    patch.recoveryNotifiedAt ?? null,
    now,
    now,
  ];

  const sets: string[] = [];
  const setBinds: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    setBinds.push(value);
  };
  if (patch.shopifyCustomerId !== undefined) set('shopify_customer_id', patch.shopifyCustomerId);
  if (patch.planName !== undefined) set('plan_name', patch.planName);
  if (patch.intervalDays !== undefined) set('interval_days', patch.intervalDays);
  if (patch.orderCount !== undefined) set('order_count', patch.orderCount);
  if (patch.lastOrderId !== undefined) set('last_order_id', patch.lastOrderId);
  if (patch.lastOrderAt !== undefined) set('last_order_at', patch.lastOrderAt);
  if (patch.lastDeliveryDate !== undefined) set('last_delivery_date', patch.lastDeliveryDate);
  if (patch.skipCount !== undefined) set('skip_count', patch.skipCount);
  if (patch.skipCountAtLastOrder !== undefined) set('skip_count_at_last_order', patch.skipCountAtLastOrder);
  if (patch.pausedAt !== undefined) set('paused_at', patch.pausedAt);
  if (patch.cancelledAt !== undefined) set('cancelled_at', patch.cancelledAt);
  if (patch.nextBillingEstimate !== undefined) set('next_billing_estimate', patch.nextBillingEstimate);
  if (patch.estimateSource !== undefined) set('estimate_source', patch.estimateSource);
  if (patch.flowEstimateAnchor !== undefined) set('flow_estimate_anchor', patch.flowEstimateAnchor);
  if (patch.skipCountAtEstimate !== undefined) set('skip_count_at_estimate', patch.skipCountAtEstimate);
  if (patch.remindedForEstimate !== undefined) set('reminded_for_estimate', patch.remindedForEstimate);
  if (patch.recoveryPendingAt !== undefined) set('recovery_pending_at', patch.recoveryPendingAt);
  if (patch.recoveryNotifiedAt !== undefined) set('recovery_notified_at', patch.recoveryNotifiedAt);
  set('updated_at', now);

  await db
    .prepare(
      `INSERT INTO subscription_contracts (
         contract_id, shopify_customer_id, plan_name, interval_days, order_count,
         last_order_id, last_order_at, last_delivery_date,
         skip_count, skip_count_at_last_order, paused_at, cancelled_at,
         next_billing_estimate, estimate_source,
         flow_estimate_anchor, skip_count_at_estimate, reminded_for_estimate,
         recovery_pending_at, recovery_notified_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contract_id) DO UPDATE SET ${sets.join(', ')}`,
    )
    .bind(...insertBinds, ...setBinds)
    .run();

  return (await getSubscriptionContract(db, patch.contractId))!;
}

export async function getSubscriptionContract(
  db: D1Database,
  contractId: string,
): Promise<SubscriptionContractRow | null> {
  const row = await db
    .prepare(`SELECT * FROM subscription_contracts WHERE contract_id = ?`)
    .bind(contractId)
    .first<SubscriptionContractRow>();
  return row ?? null;
}

/** 顧客の契約一覧。アクティブ (未解約) を先頭に、新しい順。 */
export async function getSubscriptionContractsByCustomerId(
  db: D1Database,
  shopifyCustomerId: string,
): Promise<SubscriptionContractRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM subscription_contracts
       WHERE shopify_customer_id = ?
       ORDER BY (cancelled_at IS NULL) DESC, last_order_at DESC
       LIMIT 10`,
    )
    .bind(shopifyCustomerId)
    .all<SubscriptionContractRow>();
  return result.results;
}

/**
 * WI-2 リマインド対象: 推定次回決済日が [fromDate, toDate] (YYYY-MM-DD, 両端含む) にあり、
 * 未解約・未一時停止・その推定日にまだ送っていない契約。
 * 範囲照会なのは catch-up のため (採点R1: 4日前の送信窓を障害等で丸ごと逃しても、
 * 締切当日 = 3日前まではまだ通知価値が残る。claim が推定日単位なので二重送信はない)。
 */
export async function listContractsDueForReminder(
  db: D1Database,
  fromDate: string,
  toDate: string,
  limit = 100,
): Promise<SubscriptionContractRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM subscription_contracts
       WHERE next_billing_estimate >= ? AND next_billing_estimate <= ?
         AND cancelled_at IS NULL
         AND paused_at IS NULL
         AND (reminded_for_estimate IS NULL OR reminded_for_estimate != next_billing_estimate)
       LIMIT ?`,
    )
    .bind(fromDate, toDate, limit)
    .all<SubscriptionContractRow>();
  return result.results;
}

/**
 * WI-2 決済失敗リカバリ通知の送信対象: 検知済み (pending)・未送信・**今も一時停止中**。
 * 検知は customers/update の pause 遷移 (applyCustomerTagsToContracts が同一 upsert で
 * pending を原子設定)、送信は cron の JST 送信窓 + CAS claim。
 * paused/cancelled 述語により、検知〜送信の窓 (最大14時間) 内に再開/解約した顧客へ
 * stale な「一時停止しました」を送らない (採点R2)。マーカーは resume 遷移・新規決済成功で
 * リセットされるため、2回目以降の決済失敗も通知される (永久ラッチしない)。
 */
export async function listContractsPendingRecovery(
  db: D1Database,
  limit = 50,
): Promise<SubscriptionContractRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM subscription_contracts
       WHERE recovery_pending_at IS NOT NULL
         AND recovery_notified_at IS NULL
         AND paused_at IS NOT NULL
         AND cancelled_at IS NULL
       LIMIT ?`,
    )
    .bind(limit)
    .all<SubscriptionContractRow>();
  return result.results;
}

/**
 * rebuild 用: skip 基準値が累計とズレている契約 (正規化対象) を列挙。
 * 基準値は 2 本ある (導出用の skip_count_at_last_order / 実測用の skip_count_at_estimate)。
 * **両方を見ること** — 片方だけだと flow 行の drift が残り、rebuild が冪等でなくなる。
 */
export async function listContractsWithSkipBaselineDrift(
  db: D1Database,
  limit = 1000,
): Promise<SubscriptionContractRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM subscription_contracts
       WHERE skip_count_at_last_order != skip_count
          OR skip_count_at_estimate != skip_count
       LIMIT ?`,
    )
    .bind(limit)
    .all<SubscriptionContractRow>();
  return result.results;
}
