/**
 * Phase 3 自社課金基盤 — 通知キュー + チャネル規則 (WI-4 step 3)
 * 設計の正: docs/PHASE3_BILLING_DESIGN_2026-07-19.md
 *   §2 通知チャネル規則 / §3 冪等マーカー / §5.6 配送窓 (JST 10:00-19:59) / §6.2 通知
 *
 * ## 二段構え (migration 072 のコメントと対)
 *   enqueue: own_billing_notice_queue へ UNIQUE (contract, cycle, attempt, kind) で INSERT。
 *            衝突 = 既に積まれている → 何もしない (webhook 再配送で二重通知しない)。
 *   dispatch: status を 'queued' → 'sending' に CAS してから送る (複数 tick の競合排他)。
 *            成功時のみ own_billing_notices (§3 永続マーカー) へ INSERT。
 *
 * ## チャネル規則 (§2)
 *   LINE 連携済み → LINE。**dispatch 結果が failed/skipped (ブロック等) なら email へ fallback**。
 *   未連携 → 最初から email。連携済みブロック顧客の「全チャネル沈黙」を作らないための規則。
 *   例外: challenge_link (3DS) のみ Shopify の nextActionUrl を直送 (マイページを経由しない)。
 *
 * ## 薬機法
 *   本ファイルの文面に効能効果の表現を入れないこと。事務連絡 (金額・日付・手続き) に限る。
 */
import type { LineClient } from '@line-crm/line-sdk';
import {
  getFriendByShopifyCustomerId,
  getEmailSubscriberByEmail,
  upsertEmailSubscriber,
} from '@line-crm/db';
import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
import { MYPAGE_URL } from './subscription-concierge.js';
import type { NoticeKind } from './own-billing-dunning.js';

/**
 * challenged (3DS) の顧客持ち時間 (§6.3)。起点は**リンク送付時刻** (§5.6)。
 * webhooks 側もこの定数を参照する (定数の所在をキュー側に置くことで循環 import を作らない)。
 */
export const CHALLENGE_DEADLINE_HOURS = 72;

/** §5.6 通知キュー配送窓 (JST)。夜間・早朝に課金失敗通知を送りつけない */
export const NOTICE_WINDOW_START_HOUR = 10;
export const NOTICE_WINDOW_END_HOUR = 20;

/** 1 tick の配送予算 (Workers Free の subrequest 予算。1 通 = LINE 1 + email 1 が上限) */
export const MAX_NOTICE_PER_TICK = 5;

/**
 * 候補取得の倍率。凍結行 (excludelist / quarantine) がキュー先頭を占有しても
 * 後続が配送されるようにする。engine の DUE_CANDIDATE_LIMIT=100 と較正を揃える
 * (契約は最大 76 件想定なので 20 行では凍結が並ぶと全停止しうる — 採点 R4 LOW)。
 */
export const NOTICE_CANDIDATE_FACTOR = 20;

/** 'sending' 固着行を 'queued' へ戻すまでの猶予 (isolate 強制終了からの回収) */
export const SENDING_REAP_AFTER_MS = 30 * 60_000;

/** 配送失敗時の最大再試行回数。超過で abandoned (無限ループ防止) */
export const MAX_DISPATCH_ATTEMPTS = 3;

export function isNoticeWindow(nowMs: number): boolean {
  const jstHour = new Date(nowMs + 9 * 3600_000).getUTCHours();
  return jstHour >= NOTICE_WINDOW_START_HOUR && jstHour < NOTICE_WINDOW_END_HOUR;
}

/** 文面組立パラメータ。PII を持ち込まない (氏名・住所・カード番号は入れない) */
export interface NoticePayload {
  /** 課金予定日 (JST YYYY-MM-DD) */
  scheduledDate?: string;
  /** 次回リトライ日 (JST YYYY-MM-DD) */
  nextRetryDate?: string;
  /** 手続き期限 (JST YYYY-MM-DD) */
  deadlineDate?: string;
  /** challenge_link 専用: Shopify の 3DS 認証 URL */
  nextActionUrl?: string;
  /** 最終失敗かどうか (fail_notice の文面分岐) */
  isFinal?: boolean;
  /** resume_notice: 実際に入金を確認できた再開か (カード更新起因の再開では false) */
  paymentConfirmed?: boolean;
  /** delivery_notice: 契約自体が停止/解約済みか (継続前提の案内をしない) */
  contractClosed?: boolean;
}

export interface EnqueueInput {
  contractGid: string;
  cycleKey: string;
  attemptNo: number;
  kind: NoticeKind;
  shopifyCustomerId: string;
  payload: NoticePayload;
}

export type EnqueueResult = 'enqueued' | 'duplicate' | 'already_sent' | 'revived';

/**
 * 通知を積む (冪等)。既に送信済み (§3 マーカーあり) / 既にキュー済みなら積まない。
 * 失敗しても呼び出し側の主処理 (claim/契約更新) を巻き戻さない — 呼び出し側で握る。
 */
export async function enqueueNotice(
  db: D1Database,
  input: EnqueueInput,
  nowIso: string,
): Promise<EnqueueResult> {
  const sent = await db
    .prepare(
      `SELECT 1 AS x FROM own_billing_notices
        WHERE contract_gid = ? AND cycle_key = ? AND attempt_no = ? AND kind = ?`,
    )
    .bind(input.contractGid, input.cycleKey, input.attemptNo, input.kind)
    .first<{ x: number }>();
  if (sent) return 'already_sent';

  try {
    await db
      .prepare(
        `INSERT INTO own_billing_notice_queue
           (contract_gid, cycle_key, attempt_no, kind, shopify_customer_id,
            payload_json, status, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .bind(
        input.contractGid,
        input.cycleKey,
        input.attemptNo,
        input.kind,
        input.shopifyCustomerId,
        JSON.stringify(input.payload),
        nowIso,
      )
      .run();
    return 'enqueued';
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE|constraint/i.test(msg)) throw e;
    // 既存行が **abandoned** (凍結中に stale 化した / 到達手段が無かった / 再試行を使い切った)
    // なら復活させる (採点 R2 HIGH)。復活経路が無いと、UNIQUE 制約が「二度と積めない」に化け、
    // billing-kill を 36h 超で解除したケースなどで「停止したのに通知なし」が恒久化する。
    // sent / queued / sending は触らない (= 二重送信は依然として起きない)。
    const revived = await db
      .prepare(
        `UPDATE own_billing_notice_queue
            SET status = 'queued', queued_at = ?, dispatch_attempts = 0,
                last_error = NULL, sent_at = NULL, payload_json = ?
          WHERE contract_gid = ? AND cycle_key = ? AND attempt_no = ? AND kind = ?
            AND status = 'abandoned'`,
      )
      .bind(
        nowIso,
        JSON.stringify(input.payload),
        input.contractGid,
        input.cycleKey,
        input.attemptNo,
        input.kind,
      )
      .run();
    return (revived.meta?.changes ?? 0) === 1 ? 'revived' : 'duplicate';
  }
}

interface QueueRow {
  id: number;
  contract_gid: string;
  cycle_key: string;
  attempt_no: number;
  kind: string;
  shopify_customer_id: string;
  payload_json: string;
  dispatch_attempts: number;
  queued_at: string;
}

export interface NoticeDispatchDeps {
  lineClient?: LineClient;
  emailProvider?: ChannelDispatcherDeps['emailProvider'];
  emailRenderer?: ChannelDispatcherDeps['emailRenderer'];
  emailFrom?: string;
  emailReplyTo?: string;
  /**
   * 契約単位の配送可否 (§5.2 の凍結規則を通知にも適用する)。
   * excludelist / quarantine に入れた契約は「分類が怪しいので止めた」状態なので、
   * その顧客へ「お支払いを確認できませんでした」を送るのが最大の事故になる。
   * 未注入なら全件配送 (テスト・既存挙動互換)。
   */
  canDispatch?: (contractGid: string) => boolean;
}

export interface NoticeDispatchResult {
  window: boolean;
  picked: number;
  sentLine: number;
  sentEmail: number;
  failed: number;
  abandoned: number;
  noRecipient: number;
  /** 契約単位 gate (excludelist / quarantine) で配送を見送った件数 */
  gateFrozen: number;
  /** 配送直前の再検証で「既に支払済み」と判明し破棄した件数 */
  superseded: number;
  /** 古すぎて (日付が陳腐化して) 破棄した件数 */
  stale: number;
}

/**
 * キューの配送 (§5.6)。窓外・キュー空なら何もしない。
 * 1 通ずつ CAS で 'sending' を取ってから送るため、同時刻の複数 tick でも二重送信しない。
 */
export async function dispatchQueuedNotices(
  db: D1Database,
  deps: NoticeDispatchDeps,
  nowMs: number,
  nowIso: string,
): Promise<NoticeDispatchResult> {
  const result: NoticeDispatchResult = {
    window: isNoticeWindow(nowMs),
    picked: 0,
    sentLine: 0,
    sentEmail: 0,
    failed: 0,
    abandoned: 0,
    noRecipient: 0,
    gateFrozen: 0,
    superseded: 0,
    stale: 0,
  };
  if (!result.window) return result;

  // 'sending' に固着した行の回収 (採点 R2 LOW)。CAS 後に isolate が落ちると行は 'sending' の
  // まま残り、UNIQUE 制約により再 enqueue もできず通知が恒久喪失する。
  // 十分に古い 'sending' は配送されなかったものとみなして 'queued' に戻す
  // (retryKey / 冪等マーカーがあるので、実際には送れていた場合も二重配信にならない)。
  try {
    await db
      .prepare(
        // **sending_at (CAS 時刻) で判定する** (採点 R3 MEDIUM)。queued_at は enqueue 時刻の
        // ままなので、それで判定すると配送中の行を別 tick が即座に奪い、
        // email 経路 (冪等キーなし) で同じ課金失敗通知を 2 通送ってしまう。
        `UPDATE own_billing_notice_queue SET status = 'queued'
          WHERE status = 'sending' AND sending_at IS NOT NULL AND sending_at <= ?`,
      )
      // 時刻列は JST 表記 (jstIso) なので閾値も **JST に寄せてから**文字列化する。
      // UTC のまま +09:00 を付けると 9 時間ずれて回収されない。
      .bind(
        new Date(nowMs + 9 * 3600_000 - SENDING_REAP_AFTER_MS).toISOString().replace('Z', '+09:00'),
      )
      .run();
  } catch {
    /* reaper の失敗で配送を止めない */
  }

  // 候補は予算より多めに取り、**実際に配送を試みた件数**だけを予算として数える。
  // LIMIT を予算と同じにすると、キュー先頭に凍結対象 (excludelist / quarantine) が並んだ瞬間に
  // 候補枠を占有され、他の契約の通知が永久に配送されない (採点 R1 HIGH の飢餓)。
  const rows = await db
    .prepare(
      `SELECT id, contract_gid, cycle_key, attempt_no, kind, shopify_customer_id,
              payload_json, dispatch_attempts, queued_at
         FROM own_billing_notice_queue
        WHERE status = 'queued'
        ORDER BY queued_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(MAX_NOTICE_PER_TICK * NOTICE_CANDIDATE_FACTOR)
    .all<QueueRow>();

  for (const row of rows.results ?? []) {
    if (result.picked >= MAX_NOTICE_PER_TICK) break;
    // 契約単位の凍結 (§5.2): 'queued' のまま残し、除外解除後の tick が届ける。
    // 凍結は予算を消費しない。
    if (deps.canDispatch && !deps.canDispatch(row.contract_gid)) {
      result.gateFrozen += 1;
      continue;
    }
    // CAS: 'queued' を取れた 1 プロセスだけが送信権を持つ
    const claimed = await db
      .prepare(
        `UPDATE own_billing_notice_queue
            SET status = 'sending', sending_at = ?, dispatch_attempts = dispatch_attempts + 1
          WHERE id = ? AND status = 'queued'`,
      )
      .bind(nowIso, row.id)
      .run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    result.picked += 1;

    try {
      const outcome = await deliverOne(db, deps, row, nowIso);
      if (outcome === 'line') result.sentLine += 1;
      else if (outcome === 'email') result.sentEmail += 1;
      else if (outcome === 'superseded') result.superseded += 1;
      else if (outcome === 'stale') result.stale += 1;
      else if (outcome === 'no_recipient') result.noRecipient += 1;
      // failed と abandoned は排他 (同一行を両方に数えると heartbeat の件数が二重計上になる)
      else if (row.dispatch_attempts + 1 >= MAX_DISPATCH_ATTEMPTS) result.abandoned += 1;
      else result.failed += 1;
    } catch (e: unknown) {
      // deliverOne 内で状態を戻せなかった場合の最終防波堤 (行が 'sending' で固着しない)
      await markFailed(db, row, e instanceof Error ? e.message : String(e), nowIso);
      result.failed += 1;
    }
  }
  return result;
}

type DeliverOutcome = 'line' | 'email' | 'failed' | 'no_recipient' | 'superseded' | 'stale';

/**
 * enqueue からこの時間を超えた通知は送らない。
 * 36h = 「配送窓 (1日1回、最大 ~14h 待ち) を 1 回逃しても届く」が「凍結明けの過去日案内は
 * 送らない」境界。日付を含む案内 (締切・リトライ日) の陳腐化を防ぐ。
 */
export const NOTICE_MAX_AGE_MS = 36 * 3600_000;

async function deliverOne(
  db: D1Database,
  deps: NoticeDispatchDeps,
  row: QueueRow,
  nowIso: string,
): Promise<DeliverOutcome> {
  const kind = row.kind as NoticeKind;

  // ── 鮮度チェック (採点 R1 MEDIUM)。
  // billing-kill / breaker で数日凍結したあと解除すると、キューには「もう過ぎた締切日」を
  // 含む通知が残っている。過去日を案内するのは誤情報なので、古い通知は送らず破棄する。
  // **日付を含む案内だけを対象にする** (採点 R4 HIGH)。
  // pause/resume/delivery は「起きた事実」の通知で陳腐化せず、しかも再 enqueue する主体が
  // 存在しない (matrix は一度しか積まない) ため、stale 破棄すると
  // 「一時停止したのに顧客に一切通知が届かない」が恒久化する。
  // **文面に日付を含む通知だけ**を stale 破棄対象にする (採点 R7 MEDIUM)。
  // isFinal の fail_notice (「一時停止しました」) は日付を持たず、しかも exhausted 契約には
  // 再 enqueue する主体が存在しない (matrix は 1 サイクル 1 回)。これを stale 破棄すると
  // 「停止したのに最終通知が一切届かない」が恒久化する。payload の日付有無で判定する。
  let hasDate = false;
  try {
    const p = JSON.parse(row.payload_json) as NoticePayload;
    // isFinal (終端 pause 通知) は文面が日付を使わないので常に stale 対象外
    // (発生源が誤って scheduledDate を入れても、ここでも二重に弾く)。
    hasDate = !p.isFinal && Boolean(p.scheduledDate || p.nextRetryDate || p.deadlineDate);
  } catch {
    hasDate = false;
  }
  const ageMs = Date.parse(nowIso) - Date.parse(row.queued_at);
  if (hasDate && Number.isFinite(ageMs) && ageMs > NOTICE_MAX_AGE_MS) {
    await db
      .prepare(
        `UPDATE own_billing_notice_queue
            SET status = 'abandoned', last_error = 'stale', sent_at = ?, payload_json = '{}'
          WHERE id = ? AND status = 'sending'`,
      )
      .bind(nowIso, row.id)
      .run();
    console.error(
      `own-billing: 通知 ${row.kind} (contract=${row.contract_gid} cycle=${row.cycle_key}) が古すぎるため破棄しました`,
    );
    return 'stale';
  }

  let payload: NoticePayload;
  try {
    payload = JSON.parse(row.payload_json) as NoticePayload;
  } catch {
    payload = {};
  }

  // ── 配送直前の再検証 (採点 R1 HIGH)。
  // enqueue から配送窓まで最大 十数時間 空くため、その間に支払いが通っている可能性がある。
  // 支払済みの顧客へ「お支払いを確認できませんでした」「本人確認をお願いします」を送るのは
  // 本機能で最も避けたい事故なので、失敗起因の通知は claim が succeeded なら破棄する。
  // (delivery_notice / resume_notice は「成功したこと」を伝える通知なので対象外)
  const FAILURE_KINDS: NoticeKind[] = ['fail_notice', 'card_request', 'challenge_link'];
  if (FAILURE_KINDS.includes(kind)) {
    const claim = await db
      .prepare(
        `SELECT status FROM billing_cycle_claims WHERE contract_gid = ? AND cycle_key = ?`,
      )
      .bind(row.contract_gid, row.cycle_key)
      .first<{ status: string }>();
    // **契約の現在状態も見る** (採点 R2 MEDIUM): claim が succeeded でなくても、カード更新等で
    // dunning が解除されていれば案内は陳腐化している。「更新してください」と言われた直後に
    // 更新した顧客へ、翌配送窓で同じ依頼が届くのを防ぐ。
    const contract = await db
      .prepare(`SELECT status, dunning_state FROM own_sub_contracts WHERE contract_gid = ?`)
      .bind(row.contract_gid)
      .first<{ status: string; dunning_state: string }>();
    const dunningCleared = contract !== null && contract.dunning_state === 'none';
    const contractGone = contract !== null && (contract.status === 'cancelled' || contract.status === 'expired');
    if (claim?.status === 'succeeded' || dunningCleared || contractGone) {
      await db
        .prepare(
          `UPDATE own_billing_notice_queue
              SET status = 'abandoned', last_error = 'superseded_by_success', sent_at = ?
            WHERE id = ? AND status = 'sending'`,
        )
        .bind(nowIso, row.id)
        .run();
      return 'superseded';
    }
  }

  // resume_notice も配送直前に再検証する (採点 R4 MEDIUM)。
  // enqueue から配送窓までの間に顧客が解約/再停止していると、
  // 「定期便のお届けを再開しました」が事実と食い違う。
  if (kind === 'resume_notice') {
    const contract = await db
      .prepare(`SELECT status, dunning_state FROM own_sub_contracts WHERE contract_gid = ?`)
      .bind(row.contract_gid)
      .first<{ status: string; dunning_state: string }>();
    // **dunning_state も評価する** (採点 R9 HIGH — 取得済みなのに使っていなかった)。
    // resume_notice は enqueue 時点で必ず dunning_state='none'。配送時に非 none なら
    // 「再開判断のあとに新たな失敗が起きた」ことを意味するので、「再開しました」を送らない。
    // (§S5 復旧 → 新カードで再試行 → その attempt が失敗、の窓でこの誤送信が起きる)
    if (contract !== null && (contract.status !== 'active' || contract.dunning_state !== 'none')) {
      await db
        .prepare(
          `UPDATE own_billing_notice_queue
              SET status = 'abandoned', last_error = 'superseded_by_state', sent_at = ?,
                  payload_json = '{}'
            WHERE id = ? AND status = 'sending'`,
        )
        .bind(nowIso, row.id)
        .run();
      return 'superseded';
    }
  }

  // 二重防壁 (採点 R3 MEDIUM): 送信済みマーカーが既にあるなら送らない。
  // reaper と CAS の競合で同じ行を 2 度拾っても、email 経路 (冪等キーなし) で
  // 二重配信にならないようにする。
  const alreadySent = await db
    .prepare(
      `SELECT 1 AS x FROM own_billing_notices
        WHERE contract_gid = ? AND cycle_key = ? AND attempt_no = ? AND kind = ?`,
    )
    .bind(row.contract_gid, row.cycle_key, row.attempt_no, row.kind)
    .first<{ x: number }>();
  if (alreadySent) {
    await db
      .prepare(
        `UPDATE own_billing_notice_queue SET status = 'sent', sent_at = ?, payload_json = '{}'
          WHERE id = ? AND status = 'sending'`,
      )
      .bind(nowIso, row.id)
      .run();
    return 'superseded';
  }

  // delivery_notice は配送直前に契約終端を再検証する (採点 R9 LOW)。
  // active 向けに積んだ「次回分から反映されます」を、その後解約された顧客へ
  // 継続前提のまま届けないよう、payload.contractClosed を補正する。
  let payloadOverride: NoticePayload | null = null;
  if (kind === 'delivery_notice' && !payload.contractClosed) {
    const contract = await db
      .prepare(`SELECT status FROM own_sub_contracts WHERE contract_gid = ?`)
      .bind(row.contract_gid)
      .first<{ status: string }>();
    if (contract !== null && (contract.status === 'cancelled' || contract.status === 'expired')) {
      payloadOverride = { ...payload, contractClosed: true };
    }
  }
  const effectivePayload = payloadOverride ?? payload;

  const friend = await getFriendByShopifyCustomerId(db, row.shopify_customer_id);
  const email = await lookupCustomerEmail(db, row.shopify_customer_id);
  const text = buildNoticeText(kind, effectivePayload);
  const subject = buildNoticeSubject(kind);
  // 「到達手段が存在しない」と「存在するチャネルが全部失敗した」を区別する (採点 R1 MEDIUM)。
  // 区別しないと、LINE の一時障害 + email 未登録の顧客で 1 回目の失敗が即 abandoned になり、
  // queue 行の UNIQUE 制約により以後の enqueue が 'duplicate' で弾かれて **通知が永久に消える**。
  let anyChannelTried = false;

  // ── ① LINE (連携済みのみ)
  if (friend?.line_user_id && deps.lineClient) {
    anyChannelTried = true;
    const sent = await tryDispatch(db, deps, {
      recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
      channel: 'line',
      text,
      subject,
      // X-Line-Retry-Key: キュー側で最大 MAX_DISPATCH_ATTEMPTS 回まで再試行するため、
      // 冪等キーが無いと「送信は成功したがレスポンスを取り逃した」ケースで同じ
      // 課金失敗通知が複数回届く (WI-2 の deterministicRetryKey と同じ理由)。
      retryKey: await noticeRetryKey(row),
    });
    if (sent) {
      await markSent(db, row, 'line', nowIso);
      return 'line';
    }
    // failed/skipped (ブロック・未フォロー・LINE 障害) → email fallback (§2)
  }

  // email が判っているのに provider/renderer が未注入 = **設定漏れ**。到達手段なしと同一視して
  // abandoned にすると、設定を直しても通知が復活せず alert も出ない (採点 R1 MEDIUM)。
  // 再試行に回して人間に見えるようにする。
  if (email && (!deps.emailProvider || !deps.emailRenderer)) {
    await markFailed(db, row, 'email_provider_not_configured', nowIso);
    console.error(
      `own-billing: email 送信先はあるが provider/renderer が未注入 (contract=${row.contract_gid} kind=${row.kind})`,
    );
    return 'failed';
  }

  // ── ② email fallback (未連携 / LINE 不達)
  if (email && deps.emailProvider && deps.emailRenderer) {
    // ChannelDispatcher は email_subscribers 行が無いと `skipped:no_subscriber` で落とす。
    // 本番の email_subscribers はメルマガ opt-in 由来の数件しか無く、定期便顧客はほぼ全員
    // 行を持たない = このままだと課金失敗通知が **誰にも届かない**。
    // 事務連絡 (課金・配送) は既存顧客への通知であり opt-in を要さないため、行が無い場合のみ
    // **transactional_only=1 / is_active=0** で作成する (= marketing 配信許諾は一切与えない。
    // 既存行があれば upsert は consent フラグに触らないので、配信停止済みの顧客を
    // 復活させることもない)。
    anyChannelTried = true;
    await ensureTransactionalSubscriber(db, email);
    // 【受容済みの tradeoff・採点 R9 LOW】email には LINE の retryKey に相当する冪等キーが無い。
    // 送信受理〜markSent の間 (数十 ms) に isolate が落ち、30 分後の reaper で再取得されると
    // 同じ事務連絡が 2 通届きうる (二重課金ではなく通知重複)。Resend 側に決定的キーを
    // 渡せるようになれば消せるが、現状は at-least-once として許容する。
    const sent = await tryDispatch(db, deps, {
      recipient: { email },
      channel: 'email',
      text,
      subject,
    });
    if (sent) {
      await markSent(db, row, 'email', nowIso);
      return 'email';
    }
    await markFailed(db, row, 'email_dispatch_failed', nowIso);
    return 'failed';
  }

  // ── ③ チャネルは存在したが全部失敗 → 再試行に回す (MAX_DISPATCH_ATTEMPTS まで)
  if (anyChannelTried) {
    await markFailed(db, row, 'all_channels_failed', nowIso);
    return 'failed';
  }

  // ── ④ そもそも到達手段が無い。再試行しても結果は同じなので即 abandoned にして滞留を作らない
  //     (§8 の監視は「通知できなかった契約」を件数で可視化する)
  await markNoRecipient(db, row, nowIso);
  return 'no_recipient';
}

async function tryDispatch(
  db: D1Database,
  deps: NoticeDispatchDeps,
  args: {
    recipient: { friend?: { id: string; lineUserId: string }; email?: string };
    channel: 'line' | 'email';
    text: string;
    subject: string;
    retryKey?: string;
  },
): Promise<boolean> {
  const dispatcherDeps: ChannelDispatcherDeps = { db };
  if (deps.lineClient) dispatcherDeps.lineClient = deps.lineClient;
  if (deps.emailProvider) dispatcherDeps.emailProvider = deps.emailProvider;
  if (deps.emailRenderer) dispatcherDeps.emailRenderer = deps.emailRenderer;
  if (deps.emailFrom) dispatcherDeps.emailFrom = deps.emailFrom;
  if (deps.emailReplyTo) dispatcherDeps.emailReplyTo = deps.emailReplyTo;

  const res = await dispatch(dispatcherDeps, {
    recipient: args.recipient,
    channel: args.channel,
    // 課金・配送の事務連絡は transactional (配信停止後も届く。法令ゲートの正しい側)
    category: 'transactional',
    sourceKind: 'transactional',
    ...(args.channel === 'line'
      ? {
          linePayload: {
            messages: [{ type: 'text', text: args.text }],
            ...(args.retryKey ? { retryKey: args.retryKey } : {}),
          },
        }
      : {
          emailPayload: {
            subjectTemplate: args.subject,
            htmlTemplate: `<p>${escapeHtml(args.text).replace(/\n/g, '<br>')}</p>`,
            textTemplate: args.text,
            variables: {},
            templateId: 'own-billing-notice',
          },
        }),
  });
  return res.results.some((r) => r.status === 'sent');
}

/**
 * 事務連絡を届けるための最小限の subscriber 行を保証する。
 *
 * **やること**: 行が無いときだけ `transactional_only=1 / is_active=0` で作成する。
 * **やらないこと**: 既存行の consent フラグ変更 (upsertEmailSubscriber は既存行では
 * friend_id / consent_source しか触らない = 配信停止済みを復活させない)。
 *
 * 法令上の位置づけ: 特定電子メール法のオプトイン規制は広告宣伝メールが対象で、
 * 取引条件・決済・配送の通知 (取引関係にある顧客への事務連絡) は対象外。
 * marketing 側は is_active=0 のままなので、この行が広告配信に使われることはない。
 */
async function ensureTransactionalSubscriber(db: D1Database, email: string): Promise<void> {
  try {
    const existing = await getEmailSubscriberByEmail(db, email);
    if (existing) {
      // 採点 R2 MEDIUM: consentGate は transactional でも
      // `transactional_only !== 1 && is_active !== 1` を拒否する。つまり **メルマガを解除した
      // 顧客には課金失敗通知も届かない**。schema のコメント自身が
      // 「marketing 解除しても transactional_only は 0 にしない (注文確認等は届く)」と
      // 意図を書いているので、事務連絡の宛先としては transactional_only を立て直す。
      // **is_active には触らない** = 広告配信は解除されたまま。
      if (existing.transactional_only !== 1 && existing.is_active !== 1) {
        await db
          .prepare(`UPDATE email_subscribers SET transactional_only = 1, updated_at = ? WHERE id = ?`)
          .bind(new Date().toISOString(), existing.id)
          .run();
      }
      return;
    }
    await upsertEmailSubscriber(db, {
      email,
      marketingOptIn: false, // → is_active=0 / transactional_only=1
      consentSource: 'own_billing_transactional',
    });
  } catch (e: unknown) {
    // 作成に失敗しても送信自体は試みる (dispatcher が no_subscriber で skip → 通常の失敗経路)
    console.error(
      `own-billing: transactional subscriber の作成に失敗: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * 通知単位の決定的 UUID (X-Line-Retry-Key)。同じ (contract, cycle, attempt, kind) の
 * 再試行は LINE 側でも同一リクエストとして扱われ、二重配信にならない。
 */
export async function noticeRetryKey(row: {
  contract_gid: string;
  cycle_key: string;
  attempt_no: number;
  kind: string;
}): Promise<string> {
  const seed = `own-billing-notice:${row.contract_gid}:${row.cycle_key}:${row.attempt_no}:${row.kind}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // RFC 4122 v4 形式に整形 (LINE は UUID 形式を要求する)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function lookupCustomerEmail(db: D1Database, shopifyCustomerId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT email FROM shopify_customers WHERE shopify_customer_id = ?`)
    .bind(shopifyCustomerId)
    .first<{ email: string | null }>();
  const email = row?.email ?? null;
  return email && email.includes('@') ? email : null;
}

async function markSent(
  db: D1Database,
  row: QueueRow,
  channel: 'line' | 'email',
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      // 送信後は payload を落とす: challenge_link の 3DS URL (capability link) を
      // D1 に無期限保持しないため (再送は不要 — 冪等マーカーで二度と送らない)。
      // `AND status = 'sending'` を付ける (markFailed / markNoRecipient と同じ規則)。
      // 無いと、reaper で 'queued' に戻され別 tick が配送中の行を、遅れて復帰した
      // 旧 tick が無条件に 'sent' へ書き換えて状態が壊れる (採点 R6 LOW)。
      `UPDATE own_billing_notice_queue
          SET status = 'sent', channel = ?, sent_at = ?, last_error = NULL, payload_json = '{}'
        WHERE id = ? AND status = 'sending'`,
    )
    .bind(channel, nowIso, row.id)
    .run();
  // §3 永続マーカー。キューを刈っても「送った事実」は残す (二重送信の恒久防止)
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO own_billing_notices
           (contract_gid, cycle_key, attempt_no, kind, sent_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(row.contract_gid, row.cycle_key, row.attempt_no, row.kind, nowIso)
      .run();
  } catch {
    // マーカー書き込み失敗で「送信済み」を失わせない (queue 側の status='sent' が一次防壁)
  }

  // §5.6 / §6.3: challenged の 72h は「リンク**送付**時刻」起点。配送窓 (JST 10-20) の待ち時間を
  // 顧客の持ち時間から差し引かないため、enqueue 時ではなく送信成功したここで初めて設定する。
  // dunning_state='challenged' 条件付き = 送信までに状態が変わっていたら期限を書かない。
  if (row.kind === 'challenge_link') {
    try {
      // 期限は **JST (+09:00) 表記に統一**する (採点 R1 LOW)。decideDunning の await_card 期限も
      // `...T23:59:59+09:00` で書くため、表記が混ざると step4 の sweep が
      // `WHERE dunning_deadline_at <= ?` の文字列比較で最大 9 時間ずれる。
      const deadline = new Date(Date.parse(nowIso) + CHALLENGE_DEADLINE_HOURS * 3600_000 + 9 * 3600_000)
        .toISOString()
        .replace('Z', '+09:00');
      await db
        .prepare(
          `UPDATE own_sub_contracts SET dunning_deadline_at = ?, updated_at = ?
            WHERE contract_gid = ? AND dunning_state = 'challenged'`,
        )
        .bind(deadline, nowIso, row.contract_gid)
        .run();
    } catch {
      // 期限が書けなくても送信自体は成立している。§8 の「deadline 未設定 challenged 24h」
      // 検出器が滞留として拾う。
    }
  }
}

async function markFailed(
  db: D1Database,
  row: QueueRow,
  reason: string,
  nowIso: string,
): Promise<void> {
  // 再試行上限に達したら abandoned (queued に戻さない = 無限ループ防止)
  const exhausted = row.dispatch_attempts + 1 >= MAX_DISPATCH_ATTEMPTS;
  if (exhausted) {
    console.error(
      `own-billing: 通知 ${row.kind} が ${MAX_DISPATCH_ATTEMPTS} 回失敗したため断念しました (contract=${row.contract_gid} cycle=${row.cycle_key} reason=${reason})`,
    );
  }
  await db
    .prepare(
      `UPDATE own_billing_notice_queue
          SET status = ?, last_error = ?, sent_at = CASE WHEN ? THEN ? ELSE sent_at END
        WHERE id = ? AND status = 'sending'`,
    )
    .bind(exhausted ? 'abandoned' : 'queued', reason.slice(0, 200), exhausted ? 1 : 0, nowIso, row.id)
    .run();
}

async function markNoRecipient(db: D1Database, row: QueueRow, nowIso: string): Promise<void> {
  await db
    .prepare(
      // payload も落とす (3DS capability URL を D1 に無期限保持しない)
      `UPDATE own_billing_notice_queue
          SET status = 'abandoned', last_error = 'no_reachable_channel', sent_at = ?,
              payload_json = '{}'
        WHERE id = ? AND status = 'sending'`,
    )
    .bind(nowIso, row.id)
    .run();
  // 沈黙させない (採点 R1 MEDIUM): 到達手段が無い顧客は §8 の監視対象。特に challenge_link が
  // 送れないと deadline が設定されず、契約が challenged のまま固着する。
  console.error(
    `own-billing: 通知 ${row.kind} を届けられる手段がありません (contract=${row.contract_gid} cycle=${row.cycle_key}) — LINE 未連携かつ email 不明`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 文面 (事務連絡のみ。薬機法 NG 表現を入れない) ───

// email 受信者 (現状 112 名中 109 名) は LINE のリッチメニューを持たないため、
// **文面に必ず URL を載せる**。載せないと「マイページから」と言われて到達できない
// (採点 R1 HIGH)。移行前は Huckleberry の顧客マイページが正 (WI-2 と同一 URL)。
const MYPAGE_HINT = `お手続きはマイページからお願いします。\n${MYPAGE_URL}`;

export function buildNoticeSubject(kind: NoticeKind): string {
  switch (kind) {
    case 'fail_notice':
      return '【naturism】お支払いの確認ができませんでした';
    case 'card_request':
      return '【naturism】お支払い方法のご更新のお願い';
    case 'challenge_link':
      return '【naturism】お支払いの本人確認のお願い';
    case 'pause_notice':
      return '【naturism】定期便を一時停止しました';
    case 'resume_notice':
      return '【naturism】定期便を再開しました';
    case 'delivery_notice':
      return '【naturism】今回分のお届けについて';
  }
}

/** JST YYYY-MM-DD → 「8月5日(火)」。不正値は空文字 (文面から日付行ごと落とす) */
export function formatJpDate(dateJst: string | undefined): string {
  if (!dateJst || !/^\d{4}-\d{2}-\d{2}$/.test(dateJst)) return '';
  const d = new Date(`${dateJst}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return '';
  const jst = new Date(d.getTime() + 9 * 3600_000);
  const wd = ['日', '月', '火', '水', '木', '金', '土'][jst.getUTCDay()];
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日(${wd})`;
}

/**
 * 通知本文。原因を断定しない・不安を煽らない・必ず次の行動を 1 つ示す。
 * (WI-2 の buildPaymentRecoveryMessages と同じ配慮 — pause の原因を断定しない)
 */
export function buildNoticeText(kind: NoticeKind, p: NoticePayload): string {
  const scheduled = formatJpDate(p.scheduledDate);
  const retry = formatJpDate(p.nextRetryDate);
  const deadline = formatJpDate(p.deadlineDate);

  switch (kind) {
    case 'fail_notice': {
      if (p.isFinal) {
        return (
          '📦 定期便のお支払いを確認できなかったため、次回のお届けを一時停止しました。\n' +
          'お支払い方法をご確認・ご更新いただくと、お届けを再開できます。\n' +
          MYPAGE_HINT
        );
      }
      const retryLine = retry ? `\n${retry}ごろに、もう一度お手続きを試みます。` : '';
      return (
        `📦 定期便のお支払いを確認できませんでした。${scheduled ? `(お手続き予定日 ${scheduled})` : ''}` +
        retryLine +
        `\nお心当たりがない場合や、お支払い方法を変更される場合は下記からご確認ください。\n${MYPAGE_URL}`
      );
    }
    case 'card_request': {
      const deadlineLine = deadline ? `\n${deadline}までにご更新いただけますと、お届けを続けられます。` : '';
      return (
        '💳 定期便のお支払い方法をご確認ください。\n' +
        '現在のお支払い方法ではお手続きが完了できませんでした。' +
        deadlineLine +
        `\n${MYPAGE_HINT}`
      );
    }
    case 'challenge_link': {
      // 3DS はカード会社側の認証。URL は Shopify 発行の nextActionUrl を直送する (§2 例外)
      const url = p.nextActionUrl ? `\n${p.nextActionUrl}` : '';
      return (
        '🔐 定期便のお支払いに、カード会社の本人確認が必要です。\n' +
        '下記から認証をお願いします (お手続きは数分で完了します)。' +
        url
      );
    }
    case 'pause_notice':
      return (
        '📦 定期便のお届けを一時停止しました。\n' +
        'お心当たりがない場合は、お支払い方法に問題があった可能性があります。\n' +
        `再開はいつでも可能です。${MYPAGE_HINT}`
      );
    case 'resume_notice':
      // 入金確認による再開と、カード更新による再開を区別する (後者はまだ支払われていない)。
      // 断定すると「確認できたと言われたのにまた失敗した」という不利な証拠になる。
      return p.paymentConfirmed
        ? '📦 お支払いを確認できたため、定期便のお届けを再開しました。\n' +
            `次回のお届け予定は下記からご確認いただけます。\n${MYPAGE_URL}`
        : '📦 お支払い方法のご更新を確認したため、定期便のお届けを再開しました。\n' +
            `次回のお届け予定は下記からご確認いただけます。\n${MYPAGE_URL}`;
    case 'delivery_notice': {
      // スキップ済みサイクルへの遅延成功もこの通知で受ける。「頼んでいないのに届く」と
      // 受け取られないよう、行き違いである旨と問い合わせ導線を明示する。
      // 解約/停止済みの契約には「次回分から反映されます」と言わない (継続を前提にしない)。
      const nextLine = p.contractClosed
        ? 'お届けは今回分のみで、定期便は停止したままです。'
        : 'お休み(スキップ)のお手続きをされていた場合は、次回分から反映されます。';
      return (
        '📦 お手続きの行き違いにより、直前のお支払いが完了していたため今回分をお届けします。\n' +
        `${nextLine}\n` +
        `ご不明な点・キャンセルのご希望は下記からご連絡ください。\n${MYPAGE_URL}`
      );
    }
  }
}
