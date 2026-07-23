/**
 * Phase 3 自社課金基盤 — dunning matrix (WI-4 step 3)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md §6.2 (6 クラス) / §4.1 (閉包規則)
 *
 * 本ファイルは **純関数のみ** (D1・fetch を触らない)。失敗 code から「次に何をするか」を
 * 一意に決める。副作用 (claim 更新 / 契約更新 / 通知 enqueue) は own-billing-webhooks.ts。
 *
 * ## code 一覧の出所 (2026-07-24 shopify.dev 実取得)
 * `SubscriptionBillingAttemptErrorCode` の全 54 値を逐語で収載した。設計書 §6.2 は「55 code」と
 * 記述しているが、実スキーマ (admin 2026-07 時点) は 54 値。差分は列挙の版ずれであり、
 * **未知 code は F クラス (ops_hold + 人間) に倒れる**ため、増減しても fail-safe。
 *
 * ## API 2026-04 の破壊的変更への対応
 * `SubscriptionBillingAttempt.errorCode` は deprecated となり、`state` 判別 union
 * (Pending / ActionRequired / Failed / Success) へ移行した。Failed 側の code は 4 つの
 * 型別 enum (Payment / Inventory / General / Unexpected) に再編されたが、**値の綴りは
 * 旧 flat enum の部分集合**であるため、本マトリクスは両者を同一キー空間として扱える。
 * webhook (REST 形状) は旧 flat enum を小文字 snake で送る可能性があるため
 * normalizeErrorCode() で吸収する。
 */

/** §6.2 の 6 クラス */
export type DunningClass = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/** 通知種別 (§3 の kind 全列挙) */
export type NoticeKind =
  | 'fail_notice'
  | 'card_request'
  | 'challenge_link'
  | 'pause_notice'
  | 'resume_notice'
  | 'delivery_notice';

/** own_sub_contracts.dunning_state の値域 (§3) */
export type DunningState =
  | 'none'
  | 'retry_wait'
  | 'await_card'
  | 'challenged'
  | 'ops_hold'
  | 'exhausted';

/**
 * Shopify `SubscriptionBillingAttemptErrorCode` 全値 (2026-07-24 取得)。
 * as const で literal union を作り、CLASS_BY_CODE の Record<...> で**分類漏れを
 * コンパイル時に検出**する (網羅性の第一防壁。第二防壁は exhaustiveness test)。
 */
export const BILLING_ERROR_CODES = [
  'AMOUNT_TOO_LARGE',
  'AMOUNT_TOO_SMALL',
  'AUTHENTICATION_ERROR',
  'AUTHENTICATION_FAILED',
  'AUTHENTICATION_REQUIRED',
  'BUYER_CANCELED_PAYMENT_METHOD',
  'CALL_ISSUER',
  'CANCELLED_PAYMENT',
  'CARD_DECLINED',
  'CARD_NUMBER_INCORRECT',
  'CONFIRMATION_REJECTED',
  'CUSTOMER_INVALID',
  'CUSTOMER_NOT_FOUND',
  'DO_NOT_HONOR',
  'EXPIRED_BUYER_ACTION',
  'EXPIRED_CARD',
  'EXPIRED_PAYMENT_METHOD',
  'FRAUD_SUSPECTED',
  'FREE_GIFT_CARD_NOT_ALLOWED',
  'GENERIC_ERROR',
  'INCORRECT_ADDRESS',
  'INCORRECT_NUMBER',
  'INCORRECT_ZIP',
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_INVENTORY',
  'INVALID_BILLING_ADDRESS',
  'INVALID_CURRENCY',
  'INVALID_CUSTOMER_BILLING_AGREEMENT',
  'INVALID_EXPIRY_DATE',
  'INVALID_NUMBER',
  'INVALID_PAYMENT_METHOD',
  'INVALID_PURCHASE_TYPE',
  'INVALID_SHIPPING_ADDRESS',
  'INVENTORY_ALLOCATIONS_NOT_FOUND',
  'INVOICE_ALREADY_PAID',
  'MERCHANT_ACCOUNT_ERROR',
  'MERCHANT_RULE',
  'NON_TEST_ORDER_LIMIT_REACHED',
  'OFF_SESSION_REJECTED',
  'PAYMENT_METHOD_DECLINED',
  'PAYMENT_METHOD_INCOMPATIBLE_WITH_GATEWAY_CONFIG',
  'PAYMENT_METHOD_NOT_FOUND',
  'PAYMENT_METHOD_NOT_SPECIFIED',
  'PAYMENT_METHOD_UNSUPPORTED',
  'PAYMENT_PROVIDER_ERROR',
  'PAYMENT_PROVIDER_IS_NOT_ENABLED',
  'PAYPAL_ERROR_GENERAL',
  'PROCESSING_ERROR',
  'PURCHASE_TYPE_NOT_SUPPORTED',
  'RETRY_DECLINED',
  'TEST_MODE',
  'TRANSACTION_LIMIT_EXCEEDED',
  'TRANSIENT_ERROR',
  'UNEXPECTED_ERROR',
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/**
 * code → クラス。分類原則 (設計書 §6.2 + §11「未較正は F に倒す」):
 *   A = 時間が解決しうる (残高・一時的な発行体/プロバイダ都合) → 自動リトライ
 *   B = 顧客がカードを差し替え/再認証しない限り必ず失敗する → await_card + card_request
 *   C = 既に支払われている → success として reconcile
 *   D = 店側 (在庫・ゲートウェイ設定・テストモード) 起因 → 顧客に非がないので通知せず ops_hold
 *   E = 発行体の恒久的拒否・不正判定 → リトライ禁止で即 S5 (中立文言)
 *   F = 意味が一意に定まらない → 自動アクションなし。ops_hold + Discord で人間が較正
 */
const CLASS_BY_CODE: Record<BillingErrorCode, DunningClass> = {
  // ── A: ソフトデクライン (リトライで回復しうる) ───────────────────────────
  INSUFFICIENT_FUNDS: 'A', // 残高不足。給料日跨ぎで回復する典型
  CARD_DECLINED: 'A', // 汎用デクライン。理由不明のため一度は再試行する (設計書 §6.2 A の代表例)
  PAYMENT_METHOD_DECLINED: 'A', // 同上 (プロセッサ側の汎用拒否)
  RETRY_DECLINED: 'A', // リトライが弾かれた。時間を空ければ通ることがある
  PROCESSING_ERROR: 'A', // プロバイダ処理エラー = 設計書の PROVIDER_TIMEOUT 相当
  PAYMENT_PROVIDER_ERROR: 'A', // 同上 (プロバイダ例外)
  TRANSIENT_ERROR: 'A', // 公式説明が "try again later" = 定義上 A
  CALL_ISSUER: 'A', // 発行体への連絡要求。顧客が対処すると通る (カード差替は不要)
  TRANSACTION_LIMIT_EXCEEDED: 'A', // 限度額超過。翌月/限度枠回復で通る
  AMOUNT_TOO_LARGE: 'A', // 決済手段の上限超過。限度枠回復で通りうる

  // ── B: カード無効 (顧客の差し替え/再認証が必須) ────────────────────────
  EXPIRED_CARD: 'B',
  EXPIRED_PAYMENT_METHOD: 'B',
  INVALID_PAYMENT_METHOD: 'B',
  INVALID_EXPIRY_DATE: 'B',
  INVALID_NUMBER: 'B',
  INCORRECT_NUMBER: 'B',
  CARD_NUMBER_INCORRECT: 'B',
  PAYMENT_METHOD_NOT_FOUND: 'B',
  PAYMENT_METHOD_NOT_SPECIFIED: 'B',
  PAYMENT_METHOD_UNSUPPORTED: 'B',
  BUYER_CANCELED_PAYMENT_METHOD: 'B',
  INVALID_CUSTOMER_BILLING_AGREEMENT: 'B',
  INCORRECT_ZIP: 'B', // AVS 不一致。登録情報の修正 = 実質カード再登録
  INCORRECT_ADDRESS: 'B', // 同上
  INVALID_BILLING_ADDRESS: 'B', // 同上
  // 3DS/認証系: off-session の再試行では必ず同じ結果になる。顧客が新カードを 3DS 付きで
  // 登録し直すのが唯一の回復経路のため B (card_request) に倒す。challenged webhook が
  // 先に来ている場合は §6.3 challenged レーンが管轄し、本 matrix は適用されない。
  AUTHENTICATION_REQUIRED: 'B',
  AUTHENTICATION_FAILED: 'B',
  AUTHENTICATION_ERROR: 'B',
  OFF_SESSION_REJECTED: 'B',
  EXPIRED_BUYER_ACTION: 'B',
  CONFIRMATION_REJECTED: 'B',

  // ── C: 支払済み ────────────────────────────────────────────────────
  INVOICE_ALREADY_PAID: 'C',

  // ── D: 店側起因 (顧客に非がない → 顧客通知なし・pause なし) ──────────────
  INSUFFICIENT_INVENTORY: 'D',
  INVENTORY_ALLOCATIONS_NOT_FOUND: 'D',
  MERCHANT_ACCOUNT_ERROR: 'D',
  PAYMENT_PROVIDER_IS_NOT_ENABLED: 'D',
  PAYMENT_METHOD_INCOMPATIBLE_WITH_GATEWAY_CONFIG: 'D',
  TEST_MODE: 'D',
  NON_TEST_ORDER_LIMIT_REACHED: 'D',
  INVALID_CURRENCY: 'D',
  FREE_GIFT_CARD_NOT_ALLOWED: 'D',
  INVALID_PURCHASE_TYPE: 'D',
  PURCHASE_TYPE_NOT_SUPPORTED: 'D',
  INVALID_SHIPPING_ADDRESS: 'D', // 契約の配送先不備 = 店側で是正が要る (顧客通知は人間判断)
  AMOUNT_TOO_SMALL: 'D', // 契約金額の設定不備。顧客側では直せない
  CUSTOMER_INVALID: 'D', // 顧客レコードの不整合。運用是正が要る
  CUSTOMER_NOT_FOUND: 'D', // 同上 (顧客に「カードを更新して」と言っても無意味)

  // ── E: ハードデクライン (リトライ禁止・即 S5) ───────────────────────────
  FRAUD_SUSPECTED: 'E',
  DO_NOT_HONOR: 'E',
  MERCHANT_RULE: 'E', // 加盟店ルールでの拒否。再試行は無意味
  CANCELLED_PAYMENT: 'E', // 決済が取り消された。自動再試行しない

  // ── F: 未知/曖昧 (自動アクションなし + 人間較正) ────────────────────────
  GENERIC_ERROR: 'F',
  UNEXPECTED_ERROR: 'F',
  PAYPAL_ERROR_GENERAL: 'F',
};

/** class A のリトライ間隔 (日)。§6.2「+3日, +7日 (計3)」= 初回 + リトライ 2 回 */
export const SOFT_RETRY_OFFSET_DAYS = [3, 7] as const;
/** class A の最大 attempt 数 (初回含む) */
export const SOFT_MAX_ATTEMPTS = SOFT_RETRY_OFFSET_DAYS.length + 1;

/** await_card の期限算術 (§6.2 B): min(失敗+7d, scheduled+13d)。13d は I-6 (14日) 内 clamp */
export const AWAIT_CARD_MAX_DAYS = 7;
export const AWAIT_CARD_SCHEDULED_CLAMP_DAYS = 13;

/**
 * webhook / GraphQL いずれの綴りでも同一キーに正規化する。
 * - REST webhook は小文字 snake ("expired_card") で来る可能性がある
 * - 型別 enum (Payment/Inventory/General/Unexpected) の値は flat enum と同綴り
 * - 記号ゆらぎ (ハイフン・空白) を _ に寄せ、連続 _ を畳む
 * 空文字 / null は null を返す (呼び出し側で F 扱い)。
 */
export function normalizeErrorCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const norm = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return norm.length > 0 ? norm : null;
}

/** 正規化済み code → クラス。未知/null は F (設計書 §11: 未較正は人間へ) */
export function classifyErrorCode(code: string | null): DunningClass {
  if (code === null) return 'F';
  const known = (CLASS_BY_CODE as Record<string, DunningClass | undefined>)[code];
  return known ?? 'F';
}

export interface DunningDecision {
  klass: DunningClass;
  /** 契約の新しい dunning_state */
  dunningState: DunningState;
  /** true = 契約 status を paused へ (S5)。§6.2 の「終端 S5」 */
  pauseContract: boolean;
  /** retry_wait のときの次回試行日 (JST YYYY-MM-DD)。それ以外は null */
  nextRetryDate: string | null;
  /** await_card の期限 (JST ISO)。それ以外は null */
  deadlineAt: string | null;
  /** 顧客への通知種別。null = 顧客通知なし (D/F は仕様上「なし」) */
  notice: NoticeKind | null;
  /** Discord alert (人間判断が要る) */
  alertOps: boolean;
  /** claim を succeeded として reconcile する (C クラスのみ) */
  treatAsSuccess: boolean;
  /** own_sub_contracts.dunning_attempts の新しい値 */
  nextAttempts: number;
}

export interface DunningInput {
  /** 失敗 code (生値。正規化は本関数が行う) */
  rawErrorCode: unknown;
  /** 失敗までに消化した dunning attempt 数 (= 契約の現在値。初回失敗時は 0) */
  currentAttempts: number;
  /** 当該サイクルの課金予定日 (JST YYYY-MM-DD) */
  scheduledDateJst: string;
  /** 失敗を処理している時点 (JST YYYY-MM-DD) */
  todayJst: string;
}

/** YYYY-MM-DD + n 日 (JST 日付文字列のまま扱う) */
export function addDaysJst(dateJst: string, days: number): string {
  const t = new Date(`${dateJst}T00:00:00Z`).getTime();
  return new Date(t + days * 86400_000).toISOString().slice(0, 10);
}

function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * §6.2 matrix 本体。**状態を問わず遷移先を決める** (§4.1 閉包規則)。
 * 呼び出し側は「attempting claim を failed 化した failure webhook」でのみ本関数を使うこと
 * (resolved 済み claim への遅延/再配送 failure は audit のみ = §4.1 適用条件)。
 */
export function decideDunning(input: DunningInput): DunningDecision {
  const code = normalizeErrorCode(input.rawErrorCode);
  const klass = classifyErrorCode(code);

  if (klass === 'C') {
    // 支払済み: 失敗として扱わず success へ寄せる。dunning は全リセット (I-4 相当)
    return {
      klass,
      dunningState: 'none',
      pauseContract: false,
      nextRetryDate: null,
      deadlineAt: null,
      notice: null,
      alertOps: true, // order_id が取れないため突合が要る (§8 双方向突合)
      treatAsSuccess: true,
      nextAttempts: 0,
    };
  }

  if (klass === 'D' || klass === 'F') {
    // 店側起因 / 未知: 顧客通知なし・pause なし。人間が判断するまで発行を止める
    return {
      klass,
      dunningState: 'ops_hold',
      pauseContract: false,
      nextRetryDate: null,
      deadlineAt: null,
      notice: null,
      alertOps: true,
      treatAsSuccess: false,
      nextAttempts: input.currentAttempts + 1,
    };
  }

  if (klass === 'E') {
    // ハードデクライン: リトライ禁止で即 S5。文言は原因を断定しない中立表現
    return {
      klass,
      dunningState: 'exhausted',
      pauseContract: true,
      nextRetryDate: null,
      deadlineAt: null,
      notice: 'fail_notice',
      alertOps: false,
      treatAsSuccess: false,
      nextAttempts: input.currentAttempts + 1,
    };
  }

  if (klass === 'B') {
    // カード無効: リトライせず、顧客のカード更新を待つ。
    // deadline = min(失敗+7d, scheduled+13d)。過去日になる場合は「今」に clamp
    // (I-6 が 14 日でサイクルごと放棄するため、これ以上引き延ばさない)。
    const byFailure = addDaysJst(input.todayJst, AWAIT_CARD_MAX_DAYS);
    const byScheduled = addDaysJst(input.scheduledDateJst, AWAIT_CARD_SCHEDULED_CLAMP_DAYS);
    let deadlineDate = compareDate(byFailure, byScheduled) <= 0 ? byFailure : byScheduled;
    if (compareDate(deadlineDate, input.todayJst) < 0) deadlineDate = input.todayJst;
    return {
      klass,
      dunningState: 'await_card',
      pauseContract: false,
      nextRetryDate: null,
      // JST 23:59:59 を期限とする (日付境界で「まだ当日なのに失効」を作らない)
      deadlineAt: `${deadlineDate}T23:59:59+09:00`,
      notice: 'card_request',
      alertOps: false,
      treatAsSuccess: false,
      nextAttempts: input.currentAttempts + 1,
    };
  }

  // klass === 'A' — ソフトデクライン
  const nextAttempts = input.currentAttempts + 1;
  if (nextAttempts >= SOFT_MAX_ATTEMPTS) {
    // 計 3 回使い切り → S5。最終通知を送る (§6.2「初回+最終」)
    return {
      klass,
      dunningState: 'exhausted',
      pauseContract: true,
      nextRetryDate: null,
      deadlineAt: null,
      notice: 'fail_notice',
      alertOps: false,
      treatAsSuccess: false,
      nextAttempts,
    };
  }
  const offset = SOFT_RETRY_OFFSET_DAYS[nextAttempts - 1] ?? SOFT_RETRY_OFFSET_DAYS[0];
  return {
    klass,
    dunningState: 'retry_wait',
    pauseContract: false,
    nextRetryDate: addDaysJst(input.todayJst, offset),
    deadlineAt: null,
    // 初回のみ通知 (2 回目は沈黙 = §6.2「初回+最終」)。ブロック防止のため通知は最小に保つ
    notice: nextAttempts === 1 ? 'fail_notice' : null,
    alertOps: false,
    treatAsSuccess: false,
    nextAttempts,
  };
}
