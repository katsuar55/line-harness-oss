/**
 * Phase 3 自社課金基盤 — Shopify Admin GraphQL adapter (WI-4 step 3)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md §1 (前提) / §4.0 (cadence-by-scheduleEdit)
 *
 * own-billing-engine.ts の `ShopifyBillingApi` を実 API で満たす唯一の実装。
 * 全 operation は 2026-07-24 に shopify.dev の validate_graphql_codeblocks で検証済み。
 *
 * ## API 2026-04 の破壊的変更 (設計書 v6 執筆時点より後)
 * `SubscriptionBillingAttempt` の `ready` / `nextActionUrl` / `errorCode` / `errorMessage` /
 * `order` は **すべて deprecated** となり、判別 union `state` に統合された:
 *   PendingState(processing) / ActionRequiredState(action.nextActionUrl,status) /
 *   FailedState(error: Payment|Inventory|General|Unexpected) / SuccessState(order)
 * 本 adapter は `state` のみを読む (deprecated フィールドは一切参照しない)。
 * 3 つの error 型で `code` の GraphQL 型が異なるため **alias 必須** (同名選択は schema error)。
 *
 * ## Workers ランタイム規約 (CLAUDE.md)
 * fetch は closure ローカルに束ねて呼ぶ (オブジェクト/クラスのプロパティに unbound 保持しない)。
 */
import type {
  ShopifyBillingApi,
  BillingCycleInfo,
  AttemptTerminalStatus,
  SyncAttemptResult,
} from './own-billing-engine.js';

const SHOPIFY_API_VERSION = '2026-04';
const SHOPIFY_TIMEOUT_MS = 10_000;

/**
 * listCycles の照会窓 (日)。
 * 過去側: I-6 (14日) を十分に覆う 90 日。移行 catch-up の取りこぼしも拾える。
 * 未来側: 30日 interval で 4 サイクル先まで見える 120 日。
 * first:50 と併せて 1 契約 1 リクエストに収める (Workers Free の subrequest 予算)。
 */
export const CYCLE_WINDOW_PAST_DAYS = 90;
export const CYCLE_WINDOW_FUTURE_DAYS = 120;
const CYCLE_PAGE_SIZE = 50;

// ─── GraphQL operations (すべて validate 済み) ───

const Q_LIST_CYCLES = `query OwnBillingListCycles($contractId: ID!, $startDate: DateTime!, $endDate: DateTime!) {
  subscriptionBillingCycles(
    first: ${CYCLE_PAGE_SIZE}
    contractId: $contractId
    billingCyclesDateRangeSelector: { startDate: $startDate, endDate: $endDate }
  ) {
    edges { node { cycleIndex billingAttemptExpectedDate skipped status } }
  }
}`;

const M_SCHEDULE_EDIT_DATE = `mutation OwnBillingScheduleEdit($contractId: ID!, $index: Int!, $date: DateTime!) {
  subscriptionBillingCycleScheduleEdit(
    billingCycleInput: { contractId: $contractId, selector: { index: $index } }
    input: { billingDate: $date, reason: BUYER_INITIATED }
  ) {
    billingCycle { cycleIndex billingAttemptExpectedDate }
    userErrors { field message code }
  }
}`;

const M_SCHEDULE_EDIT_SKIP = `mutation OwnBillingSetSkip($contractId: ID!, $index: Int!, $skip: Boolean!) {
  subscriptionBillingCycleScheduleEdit(
    billingCycleInput: { contractId: $contractId, selector: { index: $index } }
    input: { skip: $skip, reason: BUYER_INITIATED }
  ) {
    billingCycle { cycleIndex skipped }
    userErrors { field message code }
  }
}`;

const M_ATTEMPT_CREATE = `mutation OwnBillingAttemptCreate($contractId: ID!, $index: Int!, $idempotencyKey: String!) {
  subscriptionBillingAttemptCreate(
    subscriptionContractId: $contractId
    subscriptionBillingAttemptInput: {
      idempotencyKey: $idempotencyKey
      billingCycleSelector: { index: $index }
    }
  ) {
    subscriptionBillingAttempt { id state { __typename } }
    userErrors { field message code }
  }
}`;

const Q_ATTEMPT_STATE = `query OwnBillingAttemptStatus($id: ID!) {
  subscriptionBillingAttempt(id: $id) {
    id
    idempotencyKey
    state {
      __typename
      ... on SubscriptionBillingAttemptPendingState { processing }
      ... on SubscriptionBillingAttemptActionRequiredState {
        action {
          __typename
          ... on SubscriptionBillingAttemptPaymentChallenge { nextActionUrl status }
        }
      }
      ... on SubscriptionBillingAttemptFailedState {
        error {
          __typename
          ... on SubscriptionBillingAttemptPaymentError { paymentCode: code }
          ... on SubscriptionBillingAttemptInventoryError { inventoryCode: code }
          ... on SubscriptionBillingAttemptGeneralError { generalCode: code }
          ... on SubscriptionBillingAttemptUnexpectedError { message }
        }
      }
      ... on SubscriptionBillingAttemptSuccessState { order { id } }
    }
  }
}`;

// ─── 型 ───

/** attempt の詳細 (challenged レーン §6.3 / 失効 sweep §5.2 / reconciliation §5.3 が使う) */
export interface AttemptDetail {
  attemptGid: string;
  idempotencyKey: string | null;
  status: AttemptTerminalStatus;
  /** ActionRequired のとき 3DS 認証 URL (§6.3 でそのまま顧客へ直送) */
  nextActionUrl: string | null;
  /** Failed のとき正規化前の error code。UnexpectedError は 'UNEXPECTED_ERROR' に寄せる */
  errorCode: string | null;
  /** Success のとき生成された Order gid (§6.1 の突合連結キー) */
  orderGid: string | null;
}

/**
 * step 3 で必要になる拡張 API。engine が依存する narrow interface は変更しない
 * (既存 test の fake を壊さないため — 新メソッドは本 interface 側に足す)。
 */
export interface ShopifyBillingApiExt extends ShopifyBillingApi {
  getAttemptDetail(attemptGid: string): Promise<AttemptDetail | null>;
}

export interface AdapterOptions {
  storeDomain: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** テスト用の時刻注入 (listCycles の照会窓に使う) */
  nowMs?: () => number;
}

interface GraphqlEnvelope {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string }>;
}

type UserError = { field?: string[] | null; message?: string; code?: string | null };

// ─── 実装 ───

export function createShopifyBillingAdapter(options: AdapterOptions): ShopifyBillingApiExt {
  // CLAUDE.md Workers ルール: global fetch は closure ローカルに bind 済みで保持する
  // (オブジェクトプロパティに unbound 保持すると Illegal invocation)。
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const now = options.nowMs ?? (() => Date.now());
  const url = `https://${options.storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  async function callGraphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': options.accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    let body: GraphqlEnvelope;
    try {
      body = (await res.json()) as GraphqlEnvelope;
    } catch (e: unknown) {
      return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (body.errors && body.errors.length > 0) {
      return { ok: false, error: body.errors.map((x) => x.message ?? 'error').join('; ') };
    }
    if (!body.data) return { ok: false, error: 'no data in response' };
    return { ok: true, data: body.data };
  }

  /** userErrors 配列を「最初の code (なければ message)」に畳む */
  function foldUserErrors(raw: unknown): { code: string | null; message: string } | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const errs = raw as UserError[];
    const first = errs[0];
    return {
      code: first?.code ?? null,
      message: errs.map((e) => `${e.code ?? 'ERR'}: ${e.message ?? ''}`).join('; '),
    };
  }

  function isoDaysFromNow(days: number): string {
    return new Date(now() + days * 86400_000).toISOString();
  }

  async function listCycles(contractGid: string): Promise<BillingCycleInfo[]> {
    const res = await callGraphql(Q_LIST_CYCLES, {
      contractId: contractGid,
      startDate: isoDaysFromNow(-CYCLE_WINDOW_PAST_DAYS),
      endDate: isoDaysFromNow(CYCLE_WINDOW_FUTURE_DAYS),
    });
    if (!res.ok) {
      // 照会不能は「サイクル無し」に化けさせない (engine が誤って no_due_cycle と判定し、
      // 障害が静かな課金漏れになるのを防ぐ)。throw して契約単位の try/catch に拾わせる。
      throw new Error(`listCycles failed: ${res.error}`);
    }
    const conn = res.data.subscriptionBillingCycles as
      | { edges?: Array<{ node?: Record<string, unknown> }> }
      | undefined;
    const edges = conn?.edges ?? [];
    const cycles: BillingCycleInfo[] = [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const cycleIndex = Number(node.cycleIndex);
      const expectedDate = node.billingAttemptExpectedDate;
      if (!Number.isFinite(cycleIndex) || typeof expectedDate !== 'string') continue;
      cycles.push({
        cycleIndex,
        expectedDate,
        // enum は BILLED | UNBILLED の 2 値のみ (2026-07 時点)。BILLED 以外は未課金扱い
        billed: node.status === 'BILLED',
        skipped: node.skipped === true,
      });
    }
    return cycles.sort((a, b) => a.cycleIndex - b.cycleIndex);
  }

  async function scheduleCycleDate(
    contractGid: string,
    cycleIndex: number,
    billingDateIso: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await callGraphql(M_SCHEDULE_EDIT_DATE, {
      contractId: contractGid,
      index: cycleIndex,
      // engine は JST の YYYY-MM-DD を渡す。DateTime! なので JST 正午に固定して
      // UTC 変換による前日/翌日ずれを構造的に避ける (§10.1⑦ JST/UTC 境界)。
      date: toDateTime(billingDateIso),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const payload = res.data.subscriptionBillingCycleScheduleEdit as Record<string, unknown> | undefined;
    const ue = foldUserErrors(payload?.userErrors);
    if (ue) return { ok: false, error: ue.message };
    return { ok: true };
  }

  async function setCycleSkip(
    contractGid: string,
    cycleIndex: number,
    skip: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const res = await callGraphql(M_SCHEDULE_EDIT_SKIP, {
      contractId: contractGid,
      index: cycleIndex,
      skip,
    });
    if (!res.ok) return { ok: false, error: res.error };
    const payload = res.data.subscriptionBillingCycleScheduleEdit as Record<string, unknown> | undefined;
    const ue = foldUserErrors(payload?.userErrors);
    if (ue) return { ok: false, error: ue.message };
    return { ok: true };
  }

  async function createAttempt(
    contractGid: string,
    cycleIndex: number,
    idempotencyKey: string,
  ): Promise<SyncAttemptResult> {
    const res = await callGraphql(M_ATTEMPT_CREATE, {
      contractId: contractGid,
      index: cycleIndex,
      idempotencyKey,
    });
    if (!res.ok) {
      // ネットワーク/HTTP 障害は「同期 userError」ではない。userErrorCode を付けずに返し、
      // engine 側の hold レーンに落とす (未知同期エラーと同じ = 自動再発行しない)。
      // attempt が Shopify 側で成立している可能性があるため、これは意図した保守的挙動。
      return { ok: false, error: res.error };
    }
    const payload = res.data.subscriptionBillingAttemptCreate as Record<string, unknown> | undefined;
    const ue = foldUserErrors(payload?.userErrors);
    if (ue) {
      const result: SyncAttemptResult = { ok: false, error: ue.message };
      if (ue.code) result.userErrorCode = ue.code;
      return result;
    }
    const attempt = payload?.subscriptionBillingAttempt as { id?: string } | undefined;
    if (!attempt?.id) {
      // userErrors 無し + id 無し = 応答パース不能。engine は stuck_unrecorded に倒し
      // reconciliation (idempotencyKey 逆引き) へ決着を委ねる (二重課金を作らない)。
      return { ok: true };
    }
    return { ok: true, attemptGid: attempt.id };
  }

  async function getAttemptDetail(attemptGid: string): Promise<AttemptDetail | null> {
    const res = await callGraphql(Q_ATTEMPT_STATE, { id: attemptGid });
    if (!res.ok) return null;
    const attempt = res.data.subscriptionBillingAttempt as Record<string, unknown> | null | undefined;
    if (!attempt) return null;
    return parseAttemptNode(attempt);
  }

  async function getAttemptStatus(attemptGid: string): Promise<AttemptTerminalStatus | null> {
    const detail = await getAttemptDetail(attemptGid);
    return detail ? detail.status : null;
  }

  return {
    listCycles,
    scheduleCycleDate,
    setCycleSkip,
    createAttempt,
    getAttemptStatus,
    getAttemptDetail,
  };
}

/**
 * YYYY-MM-DD → JST 正午の ISO。既に日時形式ならそのまま返す。
 * 正午固定の理由: Shopify は DateTime を UTC 正規化するため、00:00+09:00 だと UTC 前日
 * 15:00 になり「予定日が 1 日前」に見える実装差が生まれる。正午なら UTC 03:00 で同日を保つ。
 */
export function toDateTime(dateOrIso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso) ? `${dateOrIso}T12:00:00+09:00` : dateOrIso;
}

/**
 * `state` union → AttemptDetail。webhook 経路と共有しないため export して単体テスト可能にする。
 * 未知の __typename は 'pending' に倒す (= 非 terminal 扱い)。no-parallel-attempt 原則の下では
 * 「分からないものを terminal と誤認して再発行する」ことが唯一の致命傷なので、fail-closed 側。
 */
export function parseAttemptNode(attempt: Record<string, unknown>): AttemptDetail {
  const attemptGid = typeof attempt.id === 'string' ? attempt.id : '';
  const idempotencyKey = typeof attempt.idempotencyKey === 'string' ? attempt.idempotencyKey : null;
  const state = attempt.state as Record<string, unknown> | null | undefined;
  const base: AttemptDetail = {
    attemptGid,
    idempotencyKey,
    status: 'pending',
    nextActionUrl: null,
    errorCode: null,
    orderGid: null,
  };
  if (!state || typeof state.__typename !== 'string') return base;

  switch (state.__typename) {
    case 'SubscriptionBillingAttemptSuccessState': {
      const order = state.order as { id?: string } | null | undefined;
      return { ...base, status: 'succeeded', orderGid: order?.id ?? null };
    }
    case 'SubscriptionBillingAttemptActionRequiredState': {
      const action = state.action as Record<string, unknown> | null | undefined;
      const nextActionUrl = typeof action?.nextActionUrl === 'string' ? action.nextActionUrl : null;
      return { ...base, status: 'challenged', nextActionUrl };
    }
    case 'SubscriptionBillingAttemptFailedState': {
      const error = state.error as Record<string, unknown> | null | undefined;
      const code =
        pickString(error?.paymentCode) ??
        pickString(error?.inventoryCode) ??
        pickString(error?.generalCode) ??
        // UnexpectedError は code を持たない (message のみ) → 既知の F クラス値に寄せる
        (error?.__typename === 'SubscriptionBillingAttemptUnexpectedError'
          ? 'UNEXPECTED_ERROR'
          : null);
      return { ...base, status: 'failed', errorCode: code };
    }
    case 'SubscriptionBillingAttemptPendingState':
    default:
      return base;
  }
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
