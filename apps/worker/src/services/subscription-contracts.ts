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

// ===== gate =====

export interface SubscriptionIngestEnv {
  readonly SUBSCRIPTION_INGEST_ENABLED?: string;
  readonly SUBSCRIPTION_MENU_ENABLED?: string;
}

/**
 * read-model への**収集**が有効か (§10-0 ①)。
 *
 * `SUBSCRIPTION_MENU_ENABLED` は「顧客に見える面」(トーク内の契約カード・サブスク intent・
 * リッチメニュー v4) の gate であり、収集と可視化を 1 つの secret で束ねていた。
 * その結果 **TEIKI_FLOW の実測値を貯めるには先に顧客可視面を開けるしかない**という
 * 循環になっていた (Flow の POST は gate OFF 中 202 で捨てられる)。
 * 収集だけを先に ON にできるよう分離する。
 *
 * - `SUBSCRIPTION_INGEST_ENABLED=true` … 収集のみ (顧客からは何も変わらない)
 * - `SUBSCRIPTION_MENU_ENABLED=true` … 可視面 ON。収集は当然必要なので OR で含める
 *   (= 既存の単一 gate 運用と後方互換。MENU だけ立っている本番設定でも挙動は変わらない)
 *
 * 収集の書込先は `subscription_contracts` のみで、読む経路は全て MENU / REMINDER gate の
 * 内側にある = ingest 単独 ON は顧客挙動・送信を一切変えない。
 */
export function isSubscriptionIngestEnabled(env: SubscriptionIngestEnv): boolean {
  return env.SUBSCRIPTION_INGEST_ENABLED === 'true' || env.SUBSCRIPTION_MENU_ENABLED === 'true';
}

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

/**
 * 日時文字列 → JST の YYYY-MM-DD。解釈不能・暦として不正 (2026-99-99 等) は null。
 * 受理形式 (WI-2 採点R1: Flow の既定フォーマット対応):
 *   - TZ 付き ISO (`2026-08-04T10:00:00+09:00` / `...Z`)
 *   - `YYYY-MM-DD[ HH:MM:SS]` (TZ 無しは JST とみなす)
 *   - `YYYY年M月D日[ hh:mm頃]` (Shopify Flow / 定期購買の既定日付フォーマット)
 */
export function toJstDate(dateTime: string | null | undefined): string | null {
  if (!dateTime) return null;
  const s = dateTime.trim();
  // タイムゾーン情報つき ISO → UTC ms + 9h で JST 日付
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return null;
    return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
  }
  // 和文形式 (Flow 既定): YYYY年M月D日 …
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (jp) {
    return validCalendarDate(Number(jp[1]), Number(jp[2]), Number(jp[3]));
  }
  // タイムゾーン無し (= jstNow() 形式など JST とみなす) → 日付部を暦検証して採用
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    return validCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return null;
}

/** 暦として実在する日付なら YYYY-MM-DD、しないなら null (99月99日 等の素通り防止)。 */
function validCalendarDate(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString().slice(0, 10);
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

/**
 * Flow 実測値 (estimate_source='flow') の実効次回決済日。
 *
 * 実測は「導出で上書きしない」が、**スキップは導出ではなく新しい事実**なので、
 * 実測をアンカーとして残したまま実測受信後の増分だけ先送りする (migration 074):
 *
 *   実効値 = flow_estimate_anchor + interval_days × max(0, skip_count - skip_count_at_estimate)
 *
 * `1 +` を付けないのは、実測が「次回」そのものを指すため (導出は直近注文からの逆算なので `1 +`)。
 *
 * 戻り値の意味:
 *   - string … 実効日 (増分ゼロならアンカーそのもの)
 *   - null   … 日付を出してはいけない (停止/解約中、アンカー消失、
 *              **未消化のスキップがあるのに周期が不明**)
 *
 * ⚠️ 周期不明 + 未消化スキップで null に倒すのが要点。先送り幅を計算できないのに
 * アンカーを保持すると、**スキップ済みと分かっている顧客へ古い決済日を送る**
 * (= 本修正が消そうとしている誤送信そのもの)。null なら窓に入らず無送信で、
 * カードも「マイページでご確認ください」に落ち、次の Flow 発火で復帰する。
 */
export function computeFlowBillingEstimate(row: {
  flow_estimate_anchor: string | null;
  interval_days: number | null;
  skip_count: number;
  skip_count_at_estimate: number;
  cancelled_at: string | null;
  paused_at: string | null;
}): string | null {
  if (row.cancelled_at || row.paused_at) return null;
  if (!row.flow_estimate_anchor) return null;
  const skipDelta = Math.max(0, (row.skip_count ?? 0) - (row.skip_count_at_estimate ?? 0));
  if (skipDelta === 0) return row.flow_estimate_anchor;
  if (!row.interval_days) return null;
  return addDays(row.flow_estimate_anchor, row.interval_days * skipDelta);
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
  /**
   * 注文作成 (≈決済) 日時。webhook 経路は body.created_at (実時刻) を、rebuild 経路は
   * resolveRebuildAnchor の解決値を渡す。null の場合 last_order_at は更新されず、
   * 推定日は出ない (嘘をつかない)。
   */
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
  // 「前例がある」= 既に last_order_at を持っている契約。この有無で扱いを変える (下記)。
  const hasPrior = existing?.last_order_at != null;
  const isNewerOrder =
    !isSameOrder && (!hasPrior || (orderAt !== null && orderAt >= existing!.last_order_at!));

  // ⚠️ `last_order_at` が無い契約 (= ローカル shopify_orders が直近60日分しか無いため
  // Flow 実測が唯一の日付ソースになっている、まさに §10-0 ① の主対象。本番 active 139 中 65 件)
  // では `isNewerOrder` が **orderAt の新旧を問わず無条件 true** になる。
  //
  // そのため、この層に過去注文の `orders/updated` (返金・出荷更新・タグ後付け等) が 1 通届くと
  // 実測アンカーが破棄され、skip 基準値が「消化済み」へリセットされ、推定日が
  // **顧客が既にスキップしたサイクル**へ巻き戻る → その日付でリマインドが飛ぶ。
  //
  // 以前は「実測を保持すると後続のスキップを一切反映しない」ことを理由にこの巻き戻しを
  // 維持していたが、**その根本原因は migration 074 で解消済み** (flow 行もスキップ増分を
  // 反映する)。棄却理由が消えたので、ここは非対称ルールへ改める:
  //
  //   前例あり (hasPrior)  … 従来どおり。新しい注文 = このサイクルの決済完了なので
  //                          skip 基準値をリセットし導出モードへ戻す
  //   前例なし (!hasPrior) … 注文の**事実だけ**を記録する。skip 基準値・実測アンカー・
  //                          estimate_source には触らない
  //
  // 倒し方の根拠 (判断軸): 前例なし層で基準値を残すとスキップが二重計上されうるが、
  // その向きは推定日が**未来へ**動く = 窓 `[3,7]` から外れて無送信 (次の Flow 発火で回復)。
  // 逆にリセットすると過去へ動いて**誤送信** (回復不能)。安全側は「触らない」。
  const claimsCycleComplete = isNewerOrder && hasPrior;

  const row = await upsertSubscriptionContract(db, {
    contractId: parsed.contractId,
    shopifyCustomerId: input.shopifyCustomerId ?? undefined,
    // selling plan JSON は注文経路の正 (顧客タグ経路より優先される想定なので常に反映)
    planName: planName ?? undefined,
    intervalDays: intervalDays ?? undefined,
    ...(isNewerOrder
      ? {
          // 注文の「事実」は前例の有無にかかわらず記録する
          orderCount: parsed.orderCount ?? undefined,
          lastOrderId: input.shopifyOrderId,
          lastOrderAt: orderAt ?? undefined,
          lastDeliveryDate: parsed.deliveryDate ?? undefined,
          // ここから下は「このサイクルの決済が完了した」と解釈できる場合のみ。
          // 前例なし層 (last_order_at 欠落) では届いた注文が新しいのか古いのか判定できないため、
          // skip 基準値・実測アンカー・estimate_source には触らない (undefined = 列を更新しない)。
          ...(claimsCycleComplete
            ? {
                // 新しい注文 = このサイクルの決済完了 → skip 基準値を現累計にリセットし、
                // Flow 実測値 (estimate_source='flow') も役目を終えるため導出モードへ戻す (WI-2)。
                // 決済成功 = 支払い問題は解消済みなのでリカバリマーカーも掃除する (stale pending 防止)
                skipCountAtLastOrder: existing!.skip_count,
                estimateSource: 'derived',
                // 実測アンカーも役目を終える (migration 074)。残すと、後で再び 'flow' になった際に
                // 古いアンカー + 新しい基準値の組み合わせが復活しうる。
                // 受信時刻 (075) も同じ理由でクリア — 残すと次の flow 昇格時に
                // 「古い時刻 + 新しいアンカー」の不整合が復活しうる
                flowEstimateAnchor: null,
                skipCountAtEstimate: existing!.skip_count,
                flowMeasuredAt: null,
                recoveryPendingAt: null,
                recoveryNotifiedAt: null,
              }
            : {}),
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

export interface CustomerTagsApplyResult {
  applied: number;
  /** 状態遷移。同一タグの再受信では発火しない (リカバリマーカー制御に使用) */
  transitions: Array<{
    contractId: string;
    becamePaused: boolean;
    becameCancelled: boolean;
    becameResumed: boolean;
  }>;
}

/**
 * 顧客タグ (plan/cancel/pause/skip-count) を該当契約へ反映。
 * @param opts.suppressRecoveryMarkers rebuild (bootstrap) 用 (採点R3 HIGH)。
 *   rebuild は pass1 で契約行を paused_at=null で先に作るため、pass2 の pause タグが
 *   「遷移」に見えてしまい、歴史的な一時停止に recovery_pending_at を一括ラッチして
 *   gate ON 直後に stale な「一時停止しました」を一斉送信してしまう。bootstrap では
 *   状態 (paused_at) のみ反映し、pending マーカーは立てない。
 *   一方 resume 遷移の**マーカーリセットは suppress 中も実行する** (採点R4): リセットは
 *   冪等で誤送信を生まず、抑止すると「通知済み→resume webhook 欠落→rebuild 再実行→
 *   後日2回目の失敗」で notified が残存し通知が永久に沈黙する。
 */
export async function applyCustomerTagsToContracts(
  db: D1Database,
  shopifyCustomerId: string,
  customerTags: string | null | undefined,
  opts?: { readonly suppressRecoveryMarkers?: boolean },
): Promise<CustomerTagsApplyResult> {
  const states = parseCustomerSubscriptionTags(customerTags);
  const result: CustomerTagsApplyResult = { applied: 0, transitions: [] };
  for (const [contractId, state] of states) {
    // plan 名は注文経路 (selling plan JSON) が正。顧客タグはカンマで断片化しうるため
    // (Shopify タグはカンマ区切り)、既存値が無いときだけ補完する (採点R1 LOW 修正)。
    const existing = await getSubscriptionContract(db, contractId);
    const fillPlan = !existing?.plan_name && state.planName ? state.planName : undefined;
    const fillInterval =
      existing?.interval_days == null ? (parseIntervalDays(state.planName) ?? undefined) : undefined;
    // 初見行 (existing なし) の pause タグは「遷移」ではない (採点R2: 過去の手動停止に
    // 今さらリカバリ通知を出さない)。遷移は既知行の状態変化のみ。
    const becamePaused =
      existing != null && existing.paused_at == null && state.pausedAt != null;
    const becameResumed =
      existing != null && existing.paused_at != null && state.pausedAt == null;
    const becameCancelled =
      existing != null && existing.cancelled_at == null && state.cancelledAt != null;
    const row = await upsertSubscriptionContract(db, {
      contractId,
      shopifyCustomerId,
      planName: fillPlan,
      intervalDays: fillInterval,
      skipCount: state.skipCount ?? undefined,
      // cancel/pause はタグの有無をそのまま反映 (タグが消えた = 再開)
      cancelledAt: state.cancelledAt,
      pausedAt: state.pausedAt,
      // リカバリマーカー (WI-2 採点R2): pause 遷移で pending を、resume 遷移で両マーカーの
      // リセットを、pause 書込と**同一 upsert で原子的に**行う (別 UPDATE だと途中の D1 障害で
      // 検知が失われる)。resume リセットにより 2 回目以降の決済失敗も通知できる (永久ラッチ防止)。
      ...(becamePaused && !opts?.suppressRecoveryMarkers
        ? { recoveryPendingAt: jstNowLocal() }
        : {}),
      ...(becameResumed ? { recoveryPendingAt: null, recoveryNotifiedAt: null } : {}),
    });
    await refreshEstimate(db, row);
    result.applied += 1;
    if (becamePaused || becameCancelled || becameResumed) {
      result.transitions.push({ contractId, becamePaused, becameCancelled, becameResumed });
    }
  }
  return result;
}

/** jstNow 相当 (このサービス内で完結させるための軽量ヘルパー)。 */
function jstNowLocal(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
}

/** 推定次回決済日を再計算して保存。推定が変わったらリマインド冪等キーはそのまま (同一日再送防止のため)。 */
async function refreshEstimate(
  db: D1Database,
  row: SubscriptionContractRow,
): Promise<SubscriptionContractRow> {
  const estimate = computeNextBillingEstimate(row);
  // Flow 実測値 (estimate_source='flow'、WI-2) は導出値で上書きしない。
  // 次の実注文 (deriveContractFromOrder の isNewerOrder) で 'derived' に戻り導出が再開する。
  if (row.estimate_source === 'flow') {
    // 停止/解約は null 強制 (停止中の契約にリマインドを出さない)。
    // アンカーも同時に消費する (migration 074): 再開時に Huckleberry 側は決済日を
    // 引き直しているため、古いアンカーを復元すると停止前の日付が蘇る。
    if (row.cancelled_at || row.paused_at) {
      if (
        row.next_billing_estimate !== null ||
        row.flow_estimate_anchor !== null ||
        row.flow_measured_at !== null
      ) {
        return upsertSubscriptionContract(db, {
          contractId: row.contract_id,
          nextBillingEstimate: null,
          flowEstimateAnchor: null,
          flowMeasuredAt: null,
        });
      }
      return row;
    }
    if (row.flow_estimate_anchor !== null) {
      // 実測後に増えたスキップを先送りとして反映する (migration 074)。
      // 「実測は導出で上書きしない」は維持したまま、**スキップという新しい事実**だけを足す。
      // ここが早期 return だった頃は、スキップ済みの顧客に 1 周期古い決済日で
      // リマインドが飛ぶ経路があった (§10-0 ① の chip)。
      const flowEstimate = computeFlowBillingEstimate(row);
      if (flowEstimate === row.next_billing_estimate) return row;
      return upsertSubscriptionContract(db, {
        contractId: row.contract_id,
        nextBillingEstimate: flowEstimate,
      });
    }
    // アンカーが無い flow 行 = 実測としての裏付けを失っている (pause で消費済み等)。
    // 導出へ復帰させる (採点R1: null のまま固着すると再開後サイクルのカード日付と
    // リマインドが欠落する)。導出も出せなければ日付は消える — flow 行の日付は
    // 「アンカーか導出のどちらかに裏付けられる」を不変条件にする。
    return upsertSubscriptionContract(db, {
      contractId: row.contract_id,
      nextBillingEstimate: estimate,
      estimateSource: 'derived',
      skipCountAtEstimate: row.skip_count,
      flowMeasuredAt: null,
    });
  }
  if (estimate === row.next_billing_estimate) return row;
  return upsertSubscriptionContract(db, {
    contractId: row.contract_id,
    nextBillingEstimate: estimate,
  });
}

/**
 * Flow 実測値の記録 (§10-0 ①)。**`estimate_source='flow'` を書く唯一の経路**。
 *
 * アンカー・基準値・実効値・source を **1 回の upsert で原子的に**書く。
 * 分けたり route 側で raw upsert したりすると、基準値 0 のまま 'flow' になった行が
 * 次の refreshEstimate で skip 累計ぶんを丸ごと先送りする (= 誤った未来日)。
 *
 * 基準値には**受信時点の skip 累計**を入れる。Huckleberry が送ってくる日付は
 * その時点のスキップを既に織り込んでいるため、ここを `skip_count_at_last_order`
 * (直近注文時点) にすると注文〜実測間のスキップを二重計上する。
 *
 * 既知の残存レース: 「スキップ時」トリガーの POST が `customers/update`
 * (skip-count タグ) より先着すると、基準値がスキップ前の値になり 1 周期**後ろ**へずれる。
 * ずれる向きが後ろ = 窓に入らず無送信、かつ実決済 7 日前の必須トリガーで再アンカーされるため、
 * **送信が必要になるまさにその時点で自己修復する**。
 *
 * @param existing 実在が確認済みの契約行。**id ではなく行を受ける** — phantom 行を作らない
 *   責務を呼び出し側の解決処理 (GID 対応) に集約し、同じ行を二度読まないため
 */
export async function recordFlowMeasurement(
  db: D1Database,
  existing: SubscriptionContractRow,
  measuredDate: string,
): Promise<SubscriptionContractRow> {
  // 停止/解約中はアンカーを持たない (「停止中の行に日付は無い」を不変条件にする)。
  // 再開時は Huckleberry が決済日を引き直すので、この実測はどのみち使えない。
  const blocked = existing.cancelled_at != null || existing.paused_at != null;
  const anchor = blocked ? null : measuredDate;
  // `?? 0` は必須: undefined を渡すと upsert が「この列は更新しない」と解釈し、
  // 古い基準値が残ったまま新しいアンカーだけが入る (= 実測後に先送りが誤発生する)
  const baseline = existing.skip_count ?? 0;
  return upsertSubscriptionContract(db, {
    contractId: existing.contract_id,
    nextBillingEstimate: computeFlowBillingEstimate({
      ...existing,
      flow_estimate_anchor: anchor,
      skip_count_at_estimate: baseline,
    }),
    estimateSource: 'flow',
    flowEstimateAnchor: anchor,
    skipCountAtEstimate: baseline,
    // 受信時刻 (migration 075、C2 の鮮度述語が読む)。アンカーと同じライフサイクル —
    // 停止/解約でアンカーを持たない時は時刻も持たない (「時刻だけ新しい」行を作らない)
    flowMeasuredAt: anchor === null ? null : jstNowLocal(),
  });
}

/**
 * rebuild の推定アンカー解決 (採点R2/R3 修正)。
 * metadata.order_created_at (Shopify の実注文日時。webhook 受信・手動 sync の両経路で保存) を
 * 最優先し、無ければ legacy 行のうち source=webhook のみ D1 到達時刻 (≈実時刻) を許容。
 * order_created_at 無しの手動 sync 行 (= 本修正以前の legacy) は取り込み時刻しか持たないため
 * null (=skip、推定を出さない誠実側) に倒す。
 * metadata は COALESCE で後勝ち上書きされるが、両経路とも order_created_at を書くため
 * どちらが最後に書いても実注文日時が保たれる。
 */
export function resolveRebuildAnchor(
  metadataJson: string | null | undefined,
  rowCreatedAt: string,
): string | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as { source?: string; order_created_at?: string | null };
    if (typeof meta.order_created_at === 'string' && meta.order_created_at) {
      return meta.order_created_at;
    }
    if (meta.source === 'webhook') return rowCreatedAt;
  } catch {
    // 壊れた metadata はアンカー不明としてスキップ側に倒す
  }
  return null;
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
 *   - 最終 pass で skip 基準値 (導出用・実測用の 2 本) を現累計に正規化 (= 過去のスキップは
 *     消化済みとみなす。履歴から「直近注文以降のスキップ数」は復元不能なため安全側 delta=0 に倒す)。
 *     これにより **rebuild は冪等**
 *     (2回実行しても同じ結果)。⚠️ 本番稼働後に「未消化のスキップ」がある状態で再実行すると
 *     その先送りは**恒久的に消える** (customers/update は同じ累計値を書くだけで delta は復元されない。
 *     次の実注文 or 追加スキップまで推定日が誤る)。このため endpoint は gate ON 中の実行を
 *     ?force=1 なしでは拒否する (shopify.ts)。rebuild は原則 gate ON 前の bootstrap 専用
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
      const anchor = resolveRebuildAnchor(o.metadata, o.created_at);
      if (!anchor) {
        result.skippedNonWebhook += 1;
        continue;
      }
      try {
        const row = await deriveContractFromOrder(db, {
          tags: o.tags,
          lineItemsJson: o.line_items,
          shopifyOrderId: o.shopify_order_id,
          shopifyCustomerId: o.shopify_customer_id,
          orderCreatedAt: anchor,
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
        // suppressRecoveryMarkers (採点R3 HIGH): bootstrap では pass1 が作った行への pause 反映が
        // 「遷移」に見えるが、歴史的一時停止であり決済失敗の検知ではない。マーカーを立てると
        // gate ON 直後に stale な「一時停止しました」が一斉送信される。
        await applyCustomerTagsToContracts(db, cust.shopify_customer_id, cust.tags, {
          suppressRecoveryMarkers: true,
        });
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
  // 正規化すると drift が解消されるため、空になるまで再クエリすれば cursor 不要でページングできる。
  // pass 3 全体を隔離し、失敗しても pass 1/2 の部分結果レポートを失わない (採点R2)。
  try {
    for (let round = 0; round < 40; round += 1) {
      const drifted = await listContractsWithSkipBaselineDrift(db, REBUILD_BATCH);
      if (drifted.length === 0) break;
      let progressed = 0;
      for (const row of drifted) {
        try {
          const updated = await upsertSubscriptionContract(db, {
            contractId: row.contract_id,
            skipCountAtLastOrder: row.skip_count,
            // 実測側の基準値も同時に正規化する (migration 074)。片方だけだと drift クエリが
            // 同じ行を返し続け、pass3 が終わらない/冪等でなくなる
            skipCountAtEstimate: row.skip_count,
          });
          await refreshEstimate(db, updated);
          result.baselinesNormalized += 1;
          progressed += 1;
        } catch (err) {
          result.firstError ??= err instanceof Error ? err.message.slice(0, 300) : 'unknown';
        }
      }
      if (drifted.length < REBUILD_BATCH) break;
      if (progressed === 0) {
        // 同じ行が失敗し続けている = 無限ループ防止で打ち切り、truncated として可視化
        result.truncated = true;
        break;
      }
    }
  } catch (err) {
    result.firstError ??= err instanceof Error ? err.message.slice(0, 300) : 'unknown';
  }

  result.contractsSeen = seen.size;
  return result;
}
