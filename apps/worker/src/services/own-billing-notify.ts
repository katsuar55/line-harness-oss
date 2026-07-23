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
import { getFriendByShopifyCustomerId } from '@line-crm/db';
import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
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
}

export interface EnqueueInput {
  contractGid: string;
  cycleKey: string;
  attemptNo: number;
  kind: NoticeKind;
  shopifyCustomerId: string;
  payload: NoticePayload;
}

export type EnqueueResult = 'enqueued' | 'duplicate' | 'already_sent';

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
    if (/UNIQUE|constraint/i.test(msg)) return 'duplicate';
    throw e;
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
}

export interface NoticeDispatchDeps {
  lineClient?: LineClient;
  emailProvider?: ChannelDispatcherDeps['emailProvider'];
  emailRenderer?: ChannelDispatcherDeps['emailRenderer'];
  emailFrom?: string;
  emailReplyTo?: string;
}

export interface NoticeDispatchResult {
  window: boolean;
  picked: number;
  sentLine: number;
  sentEmail: number;
  failed: number;
  abandoned: number;
  noRecipient: number;
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
  };
  if (!result.window) return result;

  const rows = await db
    .prepare(
      `SELECT id, contract_gid, cycle_key, attempt_no, kind, shopify_customer_id,
              payload_json, dispatch_attempts
         FROM own_billing_notice_queue
        WHERE status = 'queued'
        ORDER BY queued_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(MAX_NOTICE_PER_TICK)
    .all<QueueRow>();

  for (const row of rows.results ?? []) {
    // CAS: 'queued' を取れた 1 プロセスだけが送信権を持つ
    const claimed = await db
      .prepare(
        `UPDATE own_billing_notice_queue
            SET status = 'sending', dispatch_attempts = dispatch_attempts + 1
          WHERE id = ? AND status = 'queued'`,
      )
      .bind(row.id)
      .run();
    if ((claimed.meta?.changes ?? 0) !== 1) continue;
    result.picked += 1;

    try {
      const outcome = await deliverOne(db, deps, row, nowIso);
      if (outcome === 'line') result.sentLine += 1;
      else if (outcome === 'email') result.sentEmail += 1;
      else if (outcome === 'no_recipient') result.noRecipient += 1;
      else result.failed += 1;
      if (outcome === 'failed' && row.dispatch_attempts + 1 >= MAX_DISPATCH_ATTEMPTS) {
        result.abandoned += 1;
      }
    } catch (e: unknown) {
      // deliverOne 内で状態を戻せなかった場合の最終防波堤 (行が 'sending' で固着しない)
      await markFailed(db, row, e instanceof Error ? e.message : String(e), nowIso);
      result.failed += 1;
    }
  }
  return result;
}

type DeliverOutcome = 'line' | 'email' | 'failed' | 'no_recipient';

async function deliverOne(
  db: D1Database,
  deps: NoticeDispatchDeps,
  row: QueueRow,
  nowIso: string,
): Promise<DeliverOutcome> {
  const kind = row.kind as NoticeKind;
  let payload: NoticePayload;
  try {
    payload = JSON.parse(row.payload_json) as NoticePayload;
  } catch {
    payload = {};
  }

  const friend = await getFriendByShopifyCustomerId(db, row.shopify_customer_id);
  const email = await lookupCustomerEmail(db, row.shopify_customer_id);
  const text = buildNoticeText(kind, payload);
  const subject = buildNoticeSubject(kind);

  // ── ① LINE (連携済みのみ)
  if (friend?.line_user_id && deps.lineClient) {
    const sent = await tryDispatch(db, deps, {
      recipient: { friend: { id: friend.id, lineUserId: friend.line_user_id } },
      channel: 'line',
      text,
      subject,
    });
    if (sent) {
      await markSent(db, row, 'line', nowIso);
      return 'line';
    }
    // failed/skipped (ブロック・未フォロー・LINE 障害) → email fallback (§2)
  }

  // ── ② email fallback (未連携 / LINE 不達)
  if (email && deps.emailProvider && deps.emailRenderer) {
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

  // ── ③ 到達手段なし。再試行しても結果は同じなので即 abandoned にして滞留を作らない
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
      ? { linePayload: { messages: [{ type: 'text', text: args.text }] } }
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
      `UPDATE own_billing_notice_queue
          SET status = 'sent', channel = ?, sent_at = ?, last_error = NULL
        WHERE id = ?`,
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
      const deadline = new Date(Date.parse(nowIso) + CHALLENGE_DEADLINE_HOURS * 3600_000)
        .toISOString()
        .replace('Z', '+00:00');
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
      `UPDATE own_billing_notice_queue
          SET status = 'abandoned', last_error = 'no_reachable_channel', sent_at = ?
        WHERE id = ? AND status = 'sending'`,
    )
    .bind(nowIso, row.id)
    .run();
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

const MYPAGE_HINT = 'お手続きはマイページからお願いします。';

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
        '\nお心当たりがない場合や、お支払い方法を変更される場合はマイページからご確認ください。'
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
      return (
        '📦 お支払いを確認できたため、定期便のお届けを再開しました。\n' +
        '次回のお届け予定はマイページからご確認いただけます。'
      );
    case 'delivery_notice':
      return (
        '📦 直前のお支払いが完了していたため、今回分をお届けします。\n' +
        'ご不明な点がありましたらお問い合わせください。'
      );
  }
}
