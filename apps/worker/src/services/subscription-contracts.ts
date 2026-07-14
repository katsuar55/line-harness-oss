/**
 * Shopify サブスク契約 read-model 導出 (WI-1, docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md)
 *
 * Huckleberry「定期購買」は契約 API を公開していない (ENTERPRISE 限定 + 更新系はお届け日変更のみ) が、
 * 注文と顧客に機械可読なタグを付与する:
 *   注文タグ:   subscription-id:{ID} / subscription-count:{N} / delivery-{ID}:{yyyy-mm-dd 時間帯}
 *   顧客タグ:   subscription-{ID}-plan:{プラン名} / subscription-{ID}-cancel:{date}
 *              / subscription-{ID}-skip-count:{n} / subscription-{ID}-pause:{date}
 * これらは既存の shopify_orders.tags / shopify_customers.tags に webhook 経由で保存済みのため、
 * 契約状態 (契約ID・周期・直近決済・スキップ/一時停止/解約) を D1 だけで導出できる。
 *
 * 推定の限界 (誠実表示のための前提):
 *   - 次回決済日は「直近注文日 + 周期 × (1 + 直近注文以降のスキップ数)」の推定。
 *     お届け日変更はタグに現れないためズレうる → UI は必ず「ごろ」表現 + マイページ確認導線。
 *   - 周期はプラン名の「N日に1回」を解析。解析不能なら推定日を出さない (嘘をつかない)。
 */
import {
  upsertSubscriptionContract,
  getSubscriptionContract,
  listContractsWithSkipBaselineDrift,
  type SubscriptionContractRow,
} from '@line-crm/db';

// ===== 純粋関数 (テスト容易性のため export) =====

export interface ParsedOrderSubscription {
  readonly contractId: string;
  readonly orderCount: number | null;
  readonly deliveryDate: string | null;
}

/** 注文タグ文字列 (カンマ区切り) からサブスク情報を抽出。非サブスク注文は null。 */
export function parseOrderSubscriptionTags(
  tags: string | null | undefined,
): ParsedOrderSubscription | null {
  if (!tags) return null;
  const parts = tags.split(',').map((t) => t.trim());
  let contractId: string | null = null;
  let orderCount: number | null = null;
  for (const p of parts) {
    const idMatch = /^subscription-id:(.+)$/.exec(p);
    if (idMatch && idMatch[1]) contractId = idMatch[1].trim();
    const countMatch = /^subscription-count:(\d+)$/.exec(p);
    if (countMatch) orderCount = Number(countMatch[1]);
  }
  if (!contractId) return null;

  let deliveryDate: string | null = null;
  for (const p of parts) {
    // delivery-{ID}:{yyyy-mm-dd ...} — 契約IDが一致するもののみ採用
    const dMatch = new RegExp(`^delivery-${escapeRegExp(contractId)}:(\\d{4}-\\d{2}-\\d{2})`).exec(p);
    if (dMatch) deliveryDate = dMatch[1];
  }
  return { contractId, orderCount, deliveryDate };
}

export interface CustomerContractTagState {
  readonly planName: string | null;
  readonly cancelledAt: string | null;
  readonly pausedAt: string | null;
  readonly skipCount: number | null;
}

/** 顧客タグ文字列から契約ID別の状態 map を抽出。 */
export function parseCustomerSubscriptionTags(
  tags: string | null | undefined,
): Map<string, CustomerContractTagState> {
  const map = new Map<string, CustomerContractTagState>();
  if (!tags) return map;
  for (const raw of tags.split(',')) {
    const p = raw.trim();
    const m = /^subscription-(.+?)-(plan|cancel|pause|skip-count):(.*)$/.exec(p);
    if (!m) continue;
    const [, id, kind, valueRaw] = m;
    const value = valueRaw.trim();
    const prev: CustomerContractTagState =
      map.get(id) ?? { planName: null, cancelledAt: null, pausedAt: null, skipCount: null };
    if (kind === 'plan') map.set(id, { ...prev, planName: value || null });
    else if (kind === 'cancel') map.set(id, { ...prev, cancelledAt: value || null });
    else if (kind === 'pause') map.set(id, { ...prev, pausedAt: value || null });
    else if (kind === 'skip-count') {
      const n = Number(value);
      map.set(id, { ...prev, skipCount: Number.isFinite(n) ? n : null });
    }
  }
  return map;
}

/** line_items JSON から selling plan 名を取り出す (最初に見つかったもの)。 */
export function parseSellingPlanName(lineItemsJson: string | null | undefined): string | null {
  if (!lineItemsJson) return null;
  try {
    const items = JSON.parse(lineItemsJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(items)) return null;
    for (const item of items) {
      const alloc = item?.selling_plan_allocation as Record<string, unknown> | undefined;
      const plan = alloc?.selling_plan as Record<string, unknown> | undefined;
      const name = plan?.name;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch {
    return null;
  }
  return null;
}

/** プラン名から周期日数を解析 (「[5％OFF定期便] 30日に1回配送…」→ 30)。不能なら null。 */
export function parseIntervalDays(planName: string | null | undefined): number | null {
  if (!planName) return null;
  const m = /(\d+)\s*日に\s*1\s*回/.exec(planName);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 && n <= 366 ? n : null;
}

/** 日時文字列 (ISO or 'YYYY-MM-DD HH:MM:SS') → JST の YYYY-MM-DD。解釈不能は null。 */
export function toJstDate(dateTime: string | null | undefined): string | null {
  if (!dateTime) return null;
  const s = dateTime.trim();
  // タイムゾーン情報つき ISO → UTC ms + 9h で JST 日付
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  }
  // タイムゾーン無し (= jstNow() 形式など JST とみなす) → 日付部をそのまま
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/** YYYY-MM-DD に日数を加算。 */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 次回決済日の推定。解約/一時停止/周期不明/直近注文不明なら null (UI は「マイページで確認」に落ちる)。
 * スキップは「直近注文以降に増えた回数」ぶん周期を先送り。
 */
export function computeNextBillingEstimate(row: {
  last_order_at: string | null;
  interval_days: number | null;
  skip_count: number;
  skip_count_at_last_order: number;
  cancelled_at: string | null;
  paused_at: string | null;
}): string | null {
  if (row.cancelled_at || row.paused_at) return null;
  if (!row.interval_days) return null;
  const base = toJstDate(row.last_order_at);
  if (!base) return null;
  const skipDelta = Math.max(0, (row.skip_count ?? 0) - (row.skip_count_at_last_order ?? 0));
  return addDays(base, row.interval_days * (1 + skipDelta));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ===== D1 導出 (webhook / rebuild から呼ばれる) =====

export interface DeriveOrderInput {
  readonly tags: string | null | undefined;
  readonly lineItemsJson: string | null | undefined;
  readonly shopifyOrderId: string;
  readonly shopifyCustomerId: string | null | undefined;
  /** Shopify の注文作成日時 (body.created_at)。無い場合は D1 行の created_at (webhook 到達時刻 ≈ 実時刻)。 */
  readonly orderCreatedAt: string | null | undefined;
}

/**
 * 1 注文からの契約導出。サブスク注文でなければ何もしない。
 *
 * 3 分類で処理する (採点R1 HIGH 修正: 同一注文の orders/updated 再送で skip 基準を壊さない):
 *   - 新しい別注文 (id が異なり orderAt >= 既知): last_order_* 更新 + skip 基準を現累計へリセット
 *     (= このサイクルの決済完了。以後のスキップだけが次回推定を先送りする)
 *   - 同一注文の再送 (orders/updated: 出荷/タグ追記等で高頻度): タグ由来の欠損補完のみ。
 *     **skip 基準には絶対に触れない** (スキップ先送りが巻き戻る実バグの再発防止)
 *   - 古い注文の再送: last_order_* を巻き戻さない
 */
export async function deriveContractFromOrder(
  db: D1Database,
  input: DeriveOrderInput,
): Promise<SubscriptionContractRow | null> {
  const parsed = parseOrderSubscriptionTags(input.tags);
  if (!parsed) return null;

  const planName = parseSellingPlanName(input.lineItemsJson);
  const intervalDays = parseIntervalDays(planName);

  const existing = await getSubscriptionContract(db, parsed.contractId);
  const orderAt = input.orderCreatedAt ?? null;

  const isSameOrder = existing?.last_order_id === input.shopifyOrderId;
  const isNewerOrder =
    !isSameOrder &&
    (!existing?.last_order_at || (orderAt !== null && orderAt >= existing.last_order_at));

  const row = await upsertSubscriptionContract(db, {
    contractId: parsed.contractId,
    shopifyCustomerId: input.shopifyCustomerId ?? undefined,
    // selling plan JSON は注文経路の正 (顧客タグ経路より優先される想定なので常に反映)
    planName: planName ?? undefined,
    intervalDays: intervalDays ?? undefined,
    ...(isNewerOrder
      ? {
          orderCount: parsed.orderCount ?? undefined,
          lastOrderId: input.shopifyOrderId,
          lastOrderAt: orderAt ?? undefined,
          lastDeliveryDate: parsed.deliveryDate ?? undefined,
          // 新しい注文 = このサイクルの決済完了 → skip 基準値を現累計にリセット
          skipCountAtLastOrder: existing ? existing.skip_count : undefined,
        }
      : isSameOrder
        ? {
            // 再送はタグ後付け (Huckleberry は作成後に付与) の補完のみ
            orderCount: parsed.orderCount ?? undefined,
            lastDeliveryDate: parsed.deliveryDate ?? undefined,
          }
        : {}),
  });

  return refreshEstimate(db, row);
}

/** 顧客タグ (plan/cancel/pause/skip-count) を該当契約へ反映。 */
export async function applyCustomerTagsToContracts(
  db: D1Database,
  shopifyCustomerId: string,
  customerTags: string | null | undefined,
): Promise<number> {
  const states = parseCustomerSubscriptionTags(customerTags);
  let applied = 0;
  for (const [contractId, state] of states) {
    // plan 名は注文経路 (selling plan JSON) が正。顧客タグはカンマで断片化しうるため
    // (Shopify タグはカンマ区切り)、既存値が無いときだけ補完する (採点R1 LOW 修正)。
    const existing = await getSubscriptionContract(db, contractId);
    const fillPlan = !existing?.plan_name && state.planName ? state.planName : undefined;
    const fillInterval =
      existing?.interval_days == null ? (parseIntervalDays(state.planName) ?? undefined) : undefined;
    const row = await upsertSubscriptionContract(db, {
      contractId,
      shopifyCustomerId,
      planName: fillPlan,
      intervalDays: fillInterval,
      skipCount: state.skipCount ?? undefined,
      // cancel/pause はタグの有無をそのまま反映 (タグが消えた = 再開)
      cancelledAt: state.cancelledAt,
      pausedAt: state.pausedAt,
    });
    await refreshEstimate(db, row);
    applied += 1;
  }
  return applied;
}

/** 推定次回決済日を再計算して保存。推定が変わったらリマインド冪等キーはそのまま (同一日再送防止のため)。 */
async function refreshEstimate(
  db: D1Database,
  row: SubscriptionContractRow,
): Promise<SubscriptionContractRow> {
  const estimate = computeNextBillingEstimate(row);
  if (estimate === row.next_billing_estimate) return row;
  return upsertSubscriptionContract(db, {
    contractId: row.contract_id,
    nextBillingEstimate: estimate,
  });
}

export interface RebuildResult {
  ordersScanned: number;
  ordersFailed: number;
  skippedNonWebhook: number;
  contractsSeen: number;
  customersScanned: number;
  customersFailed: number;
  baselinesNormalized: number;
  truncated: boolean;
  firstError: string | null;
}

const REBUILD_BATCH = 500;
const REBUILD_MAX_ROWS = 20000;

/**
 * 既存 D1 データからの一括再構築 (バックフィル)。Shopify API は叩かない。
 *
 * 採点R1 修正を反映した設計:
 *   - **webhook 経由で保存された注文のみ採用** (metadata.source='webhook')。手動 sync/backfill 行は
 *     created_at が取り込み時刻 (実注文日でない、既知トラップ feedback_shopify_orders_60day_scope)
 *     のため推定の根拠にせず skippedNonWebhook に計上する
 *   - keyset pagination で全件処理 (LIMIT 切り捨てで最新注文を落とさない)。上限 20,000 行で truncated 報告
 *   - 注文/顧客とも per-item try/catch (部分失敗でも顧客 pass = 解約/一時停止の反映は必ず実行)
 *   - 最終 pass で skip 基準値を現累計に正規化 (= 過去のスキップは消化済みとみなす。履歴から
 *     「直近注文以降のスキップ数」は復元不能なため安全側 delta=0 に倒す)。これにより **rebuild は冪等**
 *     (2回実行しても同じ結果)。注意: 本番稼働後に「未消化のスキップ」がある状態で再実行すると
 *     その先送りは一旦消え、次の customers/update webhook で再導出される
 */
export async function rebuildContractsFromD1(db: D1Database): Promise<RebuildResult> {
  const result: RebuildResult = {
    ordersScanned: 0,
    ordersFailed: 0,
    skippedNonWebhook: 0,
    contractsSeen: 0,
    customersScanned: 0,
    customersFailed: 0,
    baselinesNormalized: 0,
    truncated: false,
    firstError: null,
  };
  const seen = new Set<string>();

  // ---- pass 1: 注文 (古い順に replay、last_order_* が正しく収束) ----
  let cursorAt = '';
  let cursorId = '';
  for (;;) {
    const batch = await db
      .prepare(
        `SELECT shopify_order_id, shopify_customer_id, tags, line_items, created_at, metadata
         FROM shopify_orders
         WHERE tags LIKE '%subscription-id:%'
           AND (created_at > ? OR (created_at = ? AND shopify_order_id > ?))
         ORDER BY created_at ASC, shopify_order_id ASC
         LIMIT ${REBUILD_BATCH}`,
      )
      .bind(cursorAt, cursorAt, cursorId)
      .all<{
        shopify_order_id: string;
        shopify_customer_id: string | null;
        tags: string | null;
        line_items: string | null;
        created_at: string;
        metadata: string | null;
      }>();

    for (const o of batch.results) {
      result.ordersScanned += 1;
      if (!/"source"\s*:\s*"webhook"/.test(o.metadata ?? '')) {
        result.skippedNonWebhook += 1;
        continue;
      }
      try {
        const row = await deriveContractFromOrder(db, {
          tags: o.tags,
          lineItemsJson: o.line_items,
          shopifyOrderId: o.shopify_order_id,
          shopifyCustomerId: o.shopify_customer_id,
          orderCreatedAt: o.created_at,
        });
        if (row) seen.add(row.contract_id);
      } catch (err) {
        result.ordersFailed += 1;
        result.firstError ??= err instanceof Error ? err.message.slice(0, 300) : 'unknown';
      }
    }

    if (batch.results.length < REBUILD_BATCH) break;
    const last = batch.results[batch.results.length - 1];
    cursorAt = last.created_at;
    cursorId = last.shopify_order_id;
    if (result.ordersScanned >= REBUILD_MAX_ROWS) {
      result.truncated = true;
      break;
    }
  }

  // ---- pass 2: 顧客タグ (解約/一時停止/スキップ)。注文 pass が失敗しても必ず実行 ----
  let custCursor = '';
  for (;;) {
    const batch = await db
      .prepare(
        `SELECT shopify_customer_id, tags FROM shopify_customers
         WHERE tags LIKE '%subscription-%' AND shopify_customer_id > ?
         ORDER BY shopify_customer_id ASC
         LIMIT ${REBUILD_BATCH}`,
      )
      .bind(custCursor)
      .all<{ shopify_customer_id: string; tags: string | null }>();

    for (const cust of batch.results) {
      result.customersScanned += 1;
      try {
        await applyCustomerTagsToContracts(db, cust.shopify_customer_id, cust.tags);
      } catch (err) {
        result.customersFailed += 1;
        result.firstError ??= err instanceof Error ? err.message.slice(0, 300) : 'unknown';
      }
    }

    if (batch.results.length < REBUILD_BATCH) break;
    custCursor = batch.results[batch.results.length - 1].shopify_customer_id;
    if (result.customersScanned >= REBUILD_MAX_ROWS) {
      result.truncated = true;
      break;
    }
  }

  // ---- pass 3: skip 基準値の正規化 (冪等性の要) ----
  const drifted = await listContractsWithSkipBaselineDrift(db);
  for (const row of drifted) {
    try {
      const updated = await upsertSubscriptionContract(db, {
        contractId: row.contract_id,
        skipCountAtLastOrder: row.skip_count,
      });
      await refreshEstimate(db, updated);
      result.baselinesNormalized += 1;
    } catch (err) {
      result.firstError ??= err instanceof Error ? err.message.slice(0, 300) : 'unknown';
    }
  }

  result.contractsSeen = seen.size;
  return result;
}
