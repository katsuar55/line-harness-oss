/**
 * サブスク決済7日前リマインド + 決済失敗リカバリ通知 cron (WI-2)
 * docs/SUBSCRIPTION_ULTRAPLAN_2026-07-14.md / 設計改訂: 採点R1 (scratchpad/wi2-fix-round1.md)
 * 窓の拡張 [3,4] → [3,7]: docs/SUBSCRIPTION_UX_TAP_MINIMAL_2026-07-25.md §10-0 ④
 *
 * フェーズ1 — 決済リマインド:
 *   マイページ操作の締切は「次回決済日の3日前」。既存の事前案内メールは「お届け3日前」≈ 決済後で
 *   間に合わないため、本 cron が締切前に届く唯一の事前通知。
 *   - 対象: 推定次回決済日 ∈ [今日+3, 今日+7] (通常 = 7日前カード。catch-up: 窓の前半を障害・
 *     gate OFF 等で逃しても締切当日 = 3日前までは通知価値が残る。claim が推定日単位なので
 *     二重送信なし = 窓を広げても通数は増えず、届くタイミングが早くなるだけ)
 *   - 文言: 締切までの残り日数で切替 (7日前「あと4日以内」/ 4日前「明日まで」/ 3日前「本日中」)
 *
 * フェーズ2 — 決済失敗リカバリ:
 *   Huckleberry は決済失敗で自動一時停止 (再決済なし)。検知 (customers/update の pause タグ
 *   遷移 → applyCustomerTagsToContracts が同一 upsert で recovery_pending_at を原子設定) と
 *   送信 (本 cron) を分離し、深夜送信・送信失敗での通知喪失・並行 webhook の二重送信を
 *   構造的に排除する。
 *
 * 共通設計:
 *   - gate: SUBSCRIPTION_REMINDER_ENABLED && SUBSCRIPTION_MENU_ENABLED (顧客可視面が閉じた
 *     まま push だけ届く事態を防ぐ。収集のみの SUBSCRIPTION_INGEST_ENABLED では送信しない)
 *   - 送信窓: JST 10:00-19:59
 *   - CAS claim + 送信失敗 (transient) は解放して再試行 / 恒久 4xx は claim 維持 /
 *     claim 後の throw も解放を試み、漏れは leakedClaims として可視化
 *   - X-Line-Retry-Key (契約+キーから決定的生成) で timeout-after-delivery の二重配信も防止
 *   - 未連携は claim 非消費 (リマインド) / 消費 (リカバリ: 連携されるまで毎5分リトライする
 *     ホットループを避ける。未連携者には LINE で届けようがない)
 *   - multi-account: CAS により 1 契約 1 通。⚠️ 第2アカウント追加前に friend.line_account_id と
 *     lineClient の一致確認を入れること (現在は単一アカウント運用)
 */
import type { LineClient } from '@line-crm/line-sdk';
import {
  listContractsDueForReminder,
  listContractsPendingRecovery,
  getFriendByShopifyCustomerId,
  insertCronRunLog,
  jstNow,
  type SubscriptionContractRow,
} from '@line-crm/db';
import { dispatch } from './channel-dispatcher.js';
import {
  buildBillingReminderMessages,
  buildPaymentRecoveryMessages,
  BILLING_DEADLINE_LEAD_DAYS,
} from './subscription-concierge.js';
import {
  addDays,
  computeNextBillingEstimate,
  computeFlowBillingEstimate,
} from './subscription-contracts.js';

export const BILLING_REMINDER_JOB_NAME = 'teiki-billing-reminder';

/**
 * リマインド対象の窓 (決済推定日までの日数、両端 inclusive)。
 *
 * 通常送信 = 決済日の **7日前** (= 設計書の「7日前リマインドカード」)。
 * catch-up 下限 = 3日前 (= 締切当日。締切は決済3日前で据置)。
 *
 * MAX を 7 にした理由 (SUBSCRIPTION_UX_TAP_MINIMAL §10-0 ④): 締切当日に届いても
 * 「今回は間に合わない」ケースが日常的に出るため、締切まで 4 日の余裕を作る。
 * **MIN は 3 から上げないこと** — 上げると「決済3日前に初めて連携した顧客」や
 * 「窓の前半で gate OFF / 障害だった契約」が、まだ行動できるのにリマインドを
 * 1 通も受け取れない (しかも失われたことに誰も気づけない)。
 *
 * 契約あたりの送信は `reminded_for_estimate` の claim により **同一推定日で 1 通**。
 * 窓を広げても通数は増えず、届く**タイミングが早くなる**だけである。
 */
const LEAD_DAYS_MAX = 7;
/** 締切当日を最後のレーンにする = 締切リード日数と一致させる (定数を共有して drift を構造的に防ぐ)。 */
const LEAD_DAYS_MIN = BILLING_DEADLINE_LEAD_DAYS;
/** 送信窓 (JST hour, inclusive-exclusive) */
const WINDOW_START_HOUR = 10;
const WINDOW_END_HOUR = 20;

export interface BillingReminderEnv {
  DB: D1Database;
  SUBSCRIPTION_REMINDER_ENABLED?: string;
  SUBSCRIPTION_MENU_ENABLED?: string;
}

export interface BillingReminderResult {
  skippedGating?: boolean;
  skippedWindow?: boolean;
  due: number;
  sent: number;
  claimedLost: number;
  unlinked: number;
  skippedRecipient: number;
  failed: number;
  leakedClaims: number;
  /**
   * 送信直前の再導出検算で `next_billing_estimate` 列が状態と食い違っていた件数。
   * **誤送信 → 無送信への一括変換弁**なので、>0 は「read-model に drift がある」の警報。
   * claim は消費しないため、列が訂正されれば次の tick で正しい日付で送れる。
   */
  staleEstimate: number;
  /**
   * 恒久 4xx (無効 userId 等)。outcome としては skippedRecipient / recoverySkipped に
   * 計上される (= claim 維持) が、恒久エラー起因の件数を監視で判別できるよう
   * **内数として別カウント**する。
   */
  permanentError: number;
  recoveryDue: number;
  recoverySent: number;
  recoveryUnlinked: number;
  recoverySkipped: number;
  recoveryFailed: number;
}

/**
 * @param nowMs テスト注入用 (未指定は Date.now())
 */
export async function processBillingReminders(
  env: BillingReminderEnv,
  lineClient: LineClient,
  nowMs?: number,
): Promise<BillingReminderResult> {
  const result: BillingReminderResult = {
    due: 0,
    sent: 0,
    claimedLost: 0,
    unlinked: 0,
    skippedRecipient: 0,
    failed: 0,
    leakedClaims: 0,
    staleEstimate: 0,
    permanentError: 0,
    recoveryDue: 0,
    recoverySent: 0,
    recoveryUnlinked: 0,
    recoverySkipped: 0,
    recoveryFailed: 0,
  };
  const db = env.DB;

  // MENU gate も必須 (採点R1): 元の理由は「MENU OFF = derive 停止 = read-model 凍結。
  // 凍結中に送ると解約済み顧客へ誤送信しうる」。収集 gate 分離後 (§10-0 ①) は
  // `SUBSCRIPTION_INGEST_ENABLED` 単独でも read-model は生きうるが、**MENU 必須は据え置く**:
  // 顧客可視面が閉じたまま push だけ届くと、カードを開けない相手に締切を告げることになる。
  // = ここは「read-model が新鮮か」より強い条件を意図的に課している。
  if (
    env.SUBSCRIPTION_REMINDER_ENABLED !== 'true' ||
    env.SUBSCRIPTION_MENU_ENABLED !== 'true'
  ) {
    // gate OFF でも heartbeat は記録する (採点R3: cron-monitor で監視するため。
    // birthday-greetings 等の gated cron と同じ per-tick heartbeat 方式で、
    // skippedGating メトリクスで run/skip を判別。cron-cleanup が古い行を prune する)
    result.skippedGating = true;
    await logRun(db, result);
    return result;
  }

  const now = nowMs ?? Date.now();
  const jst = new Date(now + 9 * 3600_000);
  const hour = jst.getUTCHours();
  if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) {
    result.skippedWindow = true;
    await logRun(db, result);
    return result;
  }

  const todayJst = jst.toISOString().slice(0, 10);

  // ---- フェーズ1: 決済リマインド ----
  const due = await listContractsDueForReminder(
    db,
    addDays(todayJst, LEAD_DAYS_MIN),
    addDays(todayJst, LEAD_DAYS_MAX),
  );
  result.due = due.length;
  for (const contract of due) {
    try {
      // claim の解放責任は remindOne 内に一元化 (throw 経路含む)。ここで二重解放しない
      const outcome = await remindOne(db, lineClient, contract, todayJst, result);
      result[outcome] += 1;
    } catch (err) {
      // remindOne が claim を持ったまま throw することはない (claim 後の失敗は内部で解放済み)
      console.error(`[${BILLING_REMINDER_JOB_NAME}] contract ${contract.contract_id} failed:`, err);
      result.failed += 1;
    }
  }

  // ---- フェーズ2: 決済失敗リカバリ ----
  const pending = await listContractsPendingRecovery(db);
  result.recoveryDue = pending.length;
  for (const contract of pending) {
    try {
      const outcome = await recoverOne(db, lineClient, contract, result);
      result[outcome] += 1;
    } catch (err) {
      console.error(`[${BILLING_REMINDER_JOB_NAME}] recovery ${contract.contract_id} failed:`, err);
      result.recoveryFailed += 1;
    }
  }

  await logRun(db, result);
  return result;
}

/** cron_run_logs へ記録 (subscription-reminder と同じ自前記録方式 → index.ts で二重 wrap しない) */
async function logRun(db: D1Database, result: BillingReminderResult): Promise<void> {
  try {
    await insertCronRunLog(db, {
      jobName: BILLING_REMINDER_JOB_NAME,
      status: result.failed + result.recoveryFailed + result.leakedClaims > 0 ? 'partial' : 'success',
      metrics: result,
    });
  } catch (err) {
    console.error(`[${BILLING_REMINDER_JOB_NAME}] cron log failed:`, err);
  }
}

// ============================================================
// フェーズ1: 決済リマインド
// ============================================================

async function remindOne(
  db: D1Database,
  lineClient: LineClient,
  contract: SubscriptionContractRow,
  todayJst: string,
  result: BillingReminderResult,
): Promise<'sent' | 'claimedLost' | 'unlinked' | 'skippedRecipient' | 'failed' | 'staleEstimate'> {
  // 🚨 送信直前の再導出検算 — **全誤送信経路の合流点にある唯一の関門**。
  //
  // listContractsDueForReminder は `next_billing_estimate` 列だけで対象を選び、
  // その列を最新化するのは webhook 駆動の refreshEstimate しかない。列がアンカー
  // (flow_estimate_anchor / skip_count_at_estimate) や導出材料と食い違ったまま
  // 窓に入ると、そのまま顧客へ push される。
  //
  // 既知の drift 経路 (過去注文による実測差し戻し / rebuild pass3 の基準値正規化 /
  // 収集中に溜まった状態) はいずれも発生源が別なのに、届く瞬間はここを通る。
  // よってここで「列 == 今の状態から導ける値」を検算し、食い違えば送らない。
  // **未知の drift 経路も含めて「誤送信 (回復不能) → 無送信 (次の発火で回復)」へ倒す。**
  //
  // claim は消費しない (return が claim より手前) ので、列が訂正されれば次の tick で送れる。
  //
  // 解約/一時停止中の行はここでは判定しない: どちらの導出関数も null を返すので必ず
  // stale 扱いになってしまうが、停止状態は **claim SQL の述語 (cancelled/paused IS NULL) が
  // 原子的に**弾く。claim 時点で読み直す分そちらの方が正確なので、判定を奪わない。
  if (!contract.cancelled_at && !contract.paused_at) {
    const expected =
      contract.estimate_source === 'flow'
        ? computeFlowBillingEstimate(contract)
        : computeNextBillingEstimate(contract);
    if (expected !== contract.next_billing_estimate) {
      console.warn(
        `[${BILLING_REMINDER_JOB_NAME}] stale estimate: contract=${contract.contract_id} ` +
          `stored=${contract.next_billing_estimate} expected=${expected} source=${contract.estimate_source}`,
      );
      // 集計は呼び出し側が outcome から行う (ここで足すと二重計上になる)
      return 'staleEstimate';
    }
  }

  if (!contract.shopify_customer_id) return 'unlinked';

  // 未連携なら claim を消費しない (将来連携されたサイクルから届けたい)
  const friend = await getFriendByShopifyCustomerId(db, contract.shopify_customer_id);
  if (!friend || !friend.line_user_id) return 'unlinked';

  // 原子的 claim (CAS): この推定日に対する送信権を 1 プロセスだけが獲得する
  const claim = await db
    .prepare(
      `UPDATE subscription_contracts
       SET reminded_for_estimate = next_billing_estimate, updated_at = ?
       WHERE contract_id = ?
         AND next_billing_estimate = ?
         AND cancelled_at IS NULL
         AND paused_at IS NULL
         AND (reminded_for_estimate IS NULL OR reminded_for_estimate != next_billing_estimate)`,
    )
    .bind(jstNow(), contract.contract_id, contract.next_billing_estimate)
    .run();
  if (!claim.meta || claim.meta.changes !== 1) return 'claimedLost';

  const daysUntilBilling = diffDays(todayJst, contract.next_billing_estimate ?? todayJst);

  let sendResult;
  try {
    sendResult = await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'transactional',
        linePayload: {
          messages: [...buildBillingReminderMessages(contract, daysUntilBilling)],
          retryKey: await deterministicRetryKey(
            `reminder:${contract.contract_id}:${contract.next_billing_estimate}`,
          ),
        },
      },
    );
  } catch (err) {
    // claim 後の throw でも約束 (送信失敗は再試行) を守る: 解放して failed として返す。
    // 解放に失敗した場合のみ leakedClaims として可視化 (このサイクルの通知が黙って消えるため)
    console.error(`[${BILLING_REMINDER_JOB_NAME}] dispatch threw for ${contract.contract_id}:`, err);
    if (!(await releaseReminderClaim(db, contract))) result.leakedClaims += 1;
    return 'failed';
  }

  const line = sendResult.results[0];
  if (line?.status === 'sent') return 'sent';
  if (line?.status === 'skipped') {
    // blacklist / 未フォロー: 再試行しても結果は同じなので claim は維持
    return 'skippedRecipient';
  }
  // X-Line-Retry-Key 重複 (409) = 前回の送信が既に LINE 側で受理済み → 配信成功扱い (採点R3:
  // permanentError に計上すると「配信できたのにエラー」で監視が濁る)
  if (line?.status === 'failed' && isRetryKeyDuplicate(line.error)) return 'sent';
  // 恒久エラー (LINE 4xx: 無効 userId 等) は再試行しても無駄 → claim 維持で無限ループ回避
  if (line?.status === 'failed' && isPermanentLineError(line.error)) {
    result.permanentError += 1;
    return 'skippedRecipient';
  }

  // transient 失敗: claim を解放して次サイクルで再試行 (retryKey で二重配信は防止済み)。
  // 解放の失敗は leakedClaims として可視化 (採点R2: 戻り値無視だと黙って消える)
  if (!(await releaseReminderClaim(db, contract))) result.leakedClaims += 1;
  return 'failed';
}

/**
 * 恒久的な LINE API エラーか (再試行しても無駄な 4xx)。
 * 429 は除外 (採点R2): レート制限・月次配信上限は transient であり、claim を解放して
 * quota 回復後の再試行に回す。
 * 409 は呼び出し側で先に isRetryKeyDuplicate として「配信成功」に分類済み (採点R3)。
 */
function isPermanentLineError(error: string): boolean {
  return /LINE API error: (?!429)4\d\d/.test(error);
}

/** X-Line-Retry-Key 重複 (409 Conflict) = 同一リクエストが既に受理済み = 実質配信成功。 */
function isRetryKeyDuplicate(error: string): boolean {
  return /LINE API error: 409/.test(error);
}

async function releaseReminderClaim(
  db: D1Database,
  contract: SubscriptionContractRow,
): Promise<boolean> {
  try {
    const r = await db
      .prepare(
        `UPDATE subscription_contracts
         SET reminded_for_estimate = NULL, updated_at = ?
         WHERE contract_id = ? AND reminded_for_estimate = ?`,
      )
      .bind(jstNow(), contract.contract_id, contract.next_billing_estimate)
      .run();
    return r.meta?.changes === 1;
  } catch {
    return false;
  }
}

// ============================================================
// フェーズ2: 決済失敗リカバリ
// ============================================================

async function recoverOne(
  db: D1Database,
  lineClient: LineClient,
  contract: SubscriptionContractRow,
  result: BillingReminderResult,
): Promise<'recoverySent' | 'recoveryUnlinked' | 'recoverySkipped' | 'recoveryFailed'> {
  // 原子的 claim: notified を立てた 1 プロセスだけが送信権を持つ。
  // paused/cancelled 述語 (採点R2): 検知〜送信の窓 (最大14時間) 内に再開/解約した顧客へ
  // stale な「一時停止しました」を送らない。
  // pending 述語 (採点R3): list〜claim の間に新規注文 webhook がマーカーを解除した
  // (= 決済成功で回復した) 契約へ stale 通知を送らない。
  const claim = await db
    .prepare(
      `UPDATE subscription_contracts
       SET recovery_notified_at = ?, updated_at = ?
       WHERE contract_id = ?
         AND recovery_pending_at IS NOT NULL
         AND recovery_notified_at IS NULL
         AND paused_at IS NOT NULL
         AND cancelled_at IS NULL`,
    )
    .bind(jstNow(), jstNow(), contract.contract_id)
    .run();
  if (!claim.meta || claim.meta.changes !== 1) return 'recoverySkipped';

  // claim 以降は throw しても解放する (採点R2: friend lookup の transient throw で claim が
  // 永久リークし、その契約のリカバリ通知が黙って消えていた)
  let sendResult;
  try {
    // 未連携: claim 消費のまま終了 (連携されるまで毎5分リトライするホットループを避ける。
    // 未連携者には LINE で届けようがない — メール通知は Huckleberry 標準が既に送っている)
    const friend = contract.shopify_customer_id
      ? await getFriendByShopifyCustomerId(db, contract.shopify_customer_id)
      : null;
    if (!friend || !friend.line_user_id) return 'recoveryUnlinked';

    sendResult = await dispatch(
      { db, lineClient },
      {
        recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
        channel: 'line',
        category: 'transactional',
        sourceKind: 'transactional',
        linePayload: {
          messages: [...buildPaymentRecoveryMessages()],
          retryKey: await deterministicRetryKey(
            `recovery:${contract.contract_id}:${contract.recovery_pending_at}`,
          ),
        },
      },
    );
  } catch (err) {
    console.error(`[${BILLING_REMINDER_JOB_NAME}] recovery dispatch threw for ${contract.contract_id}:`, err);
    if (!(await releaseRecoveryClaim(db, contract.contract_id))) result.leakedClaims += 1;
    return 'recoveryFailed';
  }

  const line = sendResult.results[0];
  if (line?.status === 'sent') return 'recoverySent';
  if (line?.status === 'skipped') return 'recoverySkipped';
  // 409 = retry-key 重複 = 既に配信済み (採点R3)
  if (line?.status === 'failed' && isRetryKeyDuplicate(line.error)) return 'recoverySent';
  if (line?.status === 'failed' && isPermanentLineError(line.error)) {
    result.permanentError += 1;
    return 'recoverySkipped';
  }

  if (!(await releaseRecoveryClaim(db, contract.contract_id))) result.leakedClaims += 1;
  return 'recoveryFailed';
}

async function releaseRecoveryClaim(db: D1Database, contractId: string): Promise<boolean> {
  try {
    const r = await db
      .prepare(
        `UPDATE subscription_contracts
         SET recovery_notified_at = NULL, updated_at = ?
         WHERE contract_id = ? AND recovery_notified_at IS NOT NULL`,
      )
      .bind(jstNow(), contractId)
      .run();
    return r.meta?.changes === 1;
  } catch {
    return false;
  }
}

// ============================================================
// 小物
// ============================================================

/** YYYY-MM-DD 同士の日数差 (b - a)。 */
function diffDays(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * 決定的な X-Line-Retry-Key (UUID 形式)。同一 (契約, キー) からは常に同じ値になり、
 * claim 解放 → 再試行の経路でも LINE 側で二重配信されない。
 */
export async function deterministicRetryKey(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const bytes = new Uint8Array(digest).slice(0, 16);
  // RFC 4122 の version (v4) / variant ビットを立てる (採点R2: LINE が UUID を厳密検証しても
  // 拒否されない正規形にする。ビット操作は決定的なので冪等性は保たれる)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const b = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-${b.slice(16, 20)}-${b.slice(20, 32)}`;
}
