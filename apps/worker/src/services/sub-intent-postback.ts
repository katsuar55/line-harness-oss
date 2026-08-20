/**
 * sub_intent postback ハンドラ (§10-5、 2026-08-07)
 *
 * リマインドカード / 契約カードの受理ボタン (subscription-concierge.ts の subIntent モード) から
 * 届く postback を、受理レイヤー (services/sub-intents.ts) へ配線する。
 *
 * 規律:
 *   - §8-2: 受理はここで **reply** する (push しない)。完了/失敗の push は /admin/ops 側 (§10-4)
 *   - §3-3: postback の y/d0/v をそのまま信じない — acceptSubIntent が presentedDate (d0) を
 *     現在の read-model と突合し、ズレは受理せず最新カードへフォールバックする
 *   - §1: 受理は「承りました」止まり (false-success を型で防ぐ)。undo は state で決める
 *   - §4-1: promised_by > deadline_at の開示は 2 タップ化 (ack=1 の再タップで受理 — §2 ※1)
 *   - IDOR: cid / id は改ざん可能入力。契約は friend の顧客IDと、intent は friend_id と必ず突合する
 *   - gate SUB_INTENT_ENABLED OFF: DB 非接触の固定応答 (ロールバック時の履歴ボタンを死なせない)
 */
import type { LineClient, Message } from '@line-crm/line-sdk';
import { getFriendByLineUserId, getSubIntent, type SubIntentRow } from '@line-crm/db';
import {
  acceptSubIntent,
  undoSubIntent,
  isSubIntentEnabled,
  buildAcceptanceMessage,
  buildLatePromiseDisclosure,
  formatPromisedBy,
  requestedDateFromPayload,
  SUB_INTENT_OP_LABELS,
  sendSubIntentAlert,
  sendSubIntentStaffEmail,
  type SubIntentGateEnv,
} from './sub-intents.js';
import {
  buildSubscriptionMenuMessages,
  buildCancelPauseChoiceMessages,
  buildConciergeErrorMessages,
  getContractForFriend,
  subIntentPostbackData,
  subIntentCycleKey,
  datePickerBounds,
  formatJpDate,
  MYPAGE_URL,
  SUB_INTENT_POSTBACK_VERSION,
} from './subscription-concierge.js';
import type { SubscriptionContractRow } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';

const TEAL_DARK = '#0f766e';

/** 今日 (JST)。nowMs はテスト注入用。 */
function todayJst(nowMs?: number): string {
  return new Date((nowMs ?? Date.now()) + 9 * 3600_000).toISOString().slice(0, 10);
}

export interface SubIntentPostbackEnv extends SubIntentGateEnv {
  DB: D1Database;
  LIFF_URL?: string;
  // 受理の瞬間にスタッフへ知らせるための Discord (best-effort)。未設定なら通知しない。
  DISCORD_WEBHOOK_URL?: string;
  ACCOUNT_NAME?: string;
  // 同じ受理をスタッフメール (info@) にも届ける (2026-08-18 Katsu 指示)。未設定なら skip。
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  STAFF_NOTIFY_EMAIL?: string;
}

export interface SubIntentPostbackInput {
  env: SubIntentPostbackEnv;
  lineClient: LineClient;
  replyToken: string;
  lineUserId: string;
  lineAccountId: string | null;
  params: URLSearchParams;
  /** datetimepicker の選択値 (op='date' の希望日) */
  postbackParams?: { date?: string } | null;
  /** テスト注入用 */
  nowMs?: number;
}

const ACCEPT_OPS = new Set(['skip', 'date', 'pause', 'cancel']);

/**
 * webhook (action='sub_intent') のエントリポイント。reply までここで完結する。
 * 例外は投げない (内部で正直な謝罪カードに畳み、audit に残す)。
 */
export async function handleSubIntentPostback(input: SubIntentPostbackInput): Promise<void> {
  const { env, lineClient, replyToken, lineUserId, lineAccountId, params } = input;
  const db = env.DB;

  // gate OFF: カードはそもそも配られていない (描画も gate 配下)。ロールバック後に
  // 履歴上のボタンから届いた場合のみここに来る — DB 非接触で正直に案内する
  if (!isSubIntentEnabled(env)) {
    try {
      await lineClient.replyMessage(replyToken, [
        {
          type: 'text',
          text: `申し訳ありません、この機能は現在準備中です🙇\n定期便のお手続きはマイページをご利用ください。\n${MYPAGE_URL}`,
        },
      ]);
    } catch {
      // reply 失敗は無視 (gate OFF 中は DB にも触れない)
    }
    return;
  }

  // friend 引きも失敗しうる (D1 一過性障害)。「例外は投げない」の約束をここでも守る
  let friend;
  try {
    friend = await getFriendByLineUserId(db, lineUserId);
  } catch (err) {
    console.error('[sub-intent-postback] friend lookup failed:', err);
    try {
      await lineClient.replyMessage(replyToken, [...buildConciergeErrorMessages()]);
    } catch {
      // token 期限切れは諦める
    }
    return;
  }
  if (!friend) return;
  const conciergeFriend = {
    id: friend.id,
    display_name: friend.display_name,
    shopify_customer_id:
      (friend as { shopify_customer_id?: string | null }).shopify_customer_id ?? null,
  };

  const op = params.get('op') ?? '';
  let outcome = 'unknown';
  let messages: ReadonlyArray<Message>;
  // 新規受理が成立したときだけ入る (スタッフ通知用)。duplicate/拒否系では undefined のまま。
  // label は表示用 (受理 = op ラベル / undo 受理 = 「◯◯ の取り消し」)。
  let accepted: { label: string; contractKey: string; promisedBy: string | null } | undefined;
  try {
    if (op === 'dismiss') {
      messages = [
        { type: 'text', text: '承知しました。引き続きよろしくお願いいたします🌿\nお手続きが必要になったら、いつでもこのトークルームからどうぞ。' },
      ];
      outcome = 'dismissed';
    } else if (op === 'undo') {
      ({ messages, outcome, accepted } = await handleUndo(db, friend.id, params, input.nowMs));
    } else if (op === 'cancel_pause' || ACCEPT_OPS.has(op)) {
      ({ messages, outcome, accepted } = await handleContractOp(input, conciergeFriend, op));
    } else {
      messages = await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, {
        subIntent: true,
      });
      outcome = 'invalid_op';
    }
  } catch (err) {
    console.error('[sub-intent-postback] failed:', err);
    try {
      await lineClient.replyMessage(replyToken, [...buildConciergeErrorMessages()]);
    } catch {
      // reply 済み / token 期限切れは諦める (audit には残す)
    }
    await auditSystem(db, {
      action: 'sub_intent.postback_threw',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friend.id,
      lineAccountId,
      result: 'failure',
      errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      metadata: { op },
    });
    return;
  }

  // reply の失敗は台帳を巻き戻せない (受理 INSERT は成立済みでありうる)。
  // ここで「確認できませんでした」の謝罪カードを送ると**受理の成立を否定する嘘**になる
  // (§10-5 監査 MEDIUM) — 送らずに audit へ残す。顧客の再タップは duplicate 文言が受け止める
  try {
    await lineClient.replyMessage(replyToken, [...messages]);
  } catch (err) {
    console.error('[sub-intent-postback] reply failed:', err);
    await auditSystem(db, {
      action: 'sub_intent.reply_failed',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friend.id,
      lineAccountId,
      result: 'failure',
      errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      metadata: { op, outcome },
    });
    // 🚨 reply が失敗しても、受理 (INSERT) は既に成立している (§10-5: 巻き戻さない)。
    //   この経路こそ通知の必要性が最も高い — 顧客は受理文言を一度も見ておらず、
    //   スタッフだけが約束を知っている状態になるため (採点 ①-3)。
    if (accepted) {
      const line = `${buildAcceptedAlertLine(accepted)}\n⚠️ 顧客への受理文言は届いていません (reply 失敗) — 最優先で対応し、必要なら手動でご連絡ください`;
      await sendSubIntentAlert(env, [line]);
      await sendSubIntentStaffEmail(env, `新しいご依頼: ${accepted.label} (要・最優先対応)`, [line]);
    }
    return;
  }
  await auditSystem(db, {
    action: 'sub_intent.postback',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friend.id,
    lineAccountId,
    result: 'success',
    // PII なし: op と結果のみ (§1-4)
    metadata: { op, outcome },
  });

  // 🚨 受理の瞬間にスタッフへ知らせる (2026-08-17 採点ループ HIGH)。
  //   これが無いと、システムが自動で出す最初の通知が §4-2 の「約束期限を超過」=
  //   **顧客へ謝罪 push を送った後**になる。つまり誰も /admin/ops を開かなければ
  //   全依頼が既定で謝罪に落ちる構造だった。push は回復不能なので、無送信側でなく
  //   「先に気付ける」側に倒す。
  //   ・reply と audit の**後**に置く = Discord の失敗や遅延が顧客体験に一切触れない
  //     (LINE の 1 秒応答制限にも影響しない)
  //   ・PII は載せない (§1-4) — op / 契約キー / 約束期限のみ
  if (accepted) {
    const line = buildAcceptedAlertLine(accepted);
    await sendSubIntentAlert(env, [line]);
    // 2026-08-18 Katsu 指示: Discord を見ないスタッフも受信箱で気付けるよう info@ へも送る
    await sendSubIntentStaffEmail(env, `新しいご依頼: ${accepted.label}`, [line]);
  }
}

/** 受理成立のスタッフ通知 1 行 (PII なし §1-4)。reply 成否の但し書きは呼び出し側で付ける。 */
function buildAcceptedAlertLine(accepted: {
  label: string;
  contractKey: string;
  promisedBy: string | null;
}): string {
  return (
    `🆕 「${accepted.label}」(契約 ${accepted.contractKey}) を承りました。` +
    (accepted.promisedBy
      ? `約束期限 ${String(accepted.promisedBy).slice(0, 16).replace('T', ' ')} — /admin/ops で対応してください`
      : '約束期限なし (推定日が出せない契約) — /admin/ops で対応してください')
  );
}

// ============================================================
// undo (§3-4 / §1-3)
// ============================================================

async function handleUndo(
  db: D1Database,
  friendId: string,
  params: URLSearchParams,
  nowMs?: number,
): Promise<{
  messages: ReadonlyArray<Message>;
  outcome: string;
  /** undo_accepted (= スタッフの新規作業が生まれた) ときだけ載る。undo_cancelled は作業が消えるだけなので載せない。 */
  accepted?: { label: string; contractKey: string; promisedBy: string | null };
}> {
  const id = params.get('id') ?? '';
  const intent = id ? await getSubIntent(db, id) : null;
  // IDOR: intent は自分のもの (friend_id 一致) だけ触れる。他人の id は存在を漏らさない
  if (!intent || intent.friend_id !== friendId) {
    return {
      messages: [
        { type: 'text', text: 'このご依頼は見つかりませんでした。お手続きの状況は、このトークルームでお気軽にお尋ねください。' },
      ],
      outcome: 'undo_not_found',
    };
  }
  const result = await undoSubIntent(db, id, { staffId: null, role: null }, { requestedBy: 'customer', nowMs });
  const label = SUB_INTENT_OP_LABELS[intent.op] ?? intent.op;
  if (result.status === 'cancelled') {
    return {
      messages: [
        { type: 'text', text: `「${label}」のご依頼を取り消しました。定期便は変更前のまま続きます🌿` },
      ],
      outcome: 'undo_cancelled',
    };
  }
  if (result.status === 'undo_accepted') {
    // §1-3: 実行に踏み込んだ意思の取り消しは「承りました」止まり (取り消せたとは言わない)。
    // §4-1: 約束期限 (promised_by) を開示する — 開示していない約束を §4-2 の督促が
    // 「お約束したお時間」と語ると、顧客が一度も見ていない期限で謝罪する矛盾になる (採点 ①-4)。
    const promisedBy = result.undoIntent.promised_by;
    return {
      messages: [
        {
          type: 'text',
          text:
            `「${label}」の取り消しのご依頼を承りました。\n` +
            (promisedBy
              ? `${formatPromisedBy(promisedBy)} までにスタッフが対応状況を確認し、結果を必ずご連絡いたします。`
              : `スタッフが対応状況を確認し、結果を必ずご連絡いたします。`),
        },
      ],
      outcome: 'undo_accepted',
      accepted: {
        label: `${label} の取り消し`,
        contractKey: intent.contract_key,
        promisedBy,
      },
    };
  }
  // not_undoable / not_found: **実際の state** を正直に伝える (推測の羅列で濁さない §10-5 監査 LOW)
  const stateText =
    result.status === 'not_undoable'
      ? ({
          expired: '受付期限を過ぎて失効しているため、取り消しの対象がありません',
          cancelled: '既に取り消し済みです',
          superseded: '新しいご依頼に引き継がれています',
          failed: 'お手続きができなかったため、取り消しの対象がありません',
          done: '対応が完了しています',
        } as Record<string, string>)[result.state] ?? '現在の状態からは取り消せませんでした'
      : '見つかりませんでした';
  return {
    messages: [
      {
        type: 'text',
        text: `「${label}」のご依頼は${stateText}。\nご希望があれば、このトークルームでお知らせください。スタッフが対応いたします。`,
      },
    ],
    outcome: `undo_${result.status}`,
  };
}

// ============================================================
// 受理 (skip / date / pause / cancel) と確認カード (cancel_pause)
// ============================================================

async function handleContractOp(
  input: SubIntentPostbackInput,
  conciergeFriend: { id: string; display_name: string | null; shopify_customer_id: string | null },
  op: string,
): Promise<{
  messages: ReadonlyArray<Message>;
  outcome: string;
  /** 新規受理が成立したときだけ載る (スタッフ通知用)。duplicate では載せない。 */
  accepted?: { label: string; contractKey: string; promisedBy: string | null };
}> {
  const { env, params } = input;
  const db = env.DB;
  const cid = params.get('cid') ?? '';

  // IDOR ガード: cid は改ざん可能入力。所有者検証に失敗したら契約の存在有無を漏らさず
  // 最新のメニューカードへフォールバック
  const contract = await getContractForFriend(db, conciergeFriend, cid);
  if (!contract) {
    return {
      messages: await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true }),
      outcome: 'denied',
    };
  }

  // §3-3: スキーマ版が旧い吹き出し = 互換を保証できない。受理せず最新カードへ
  if (params.get('v') !== SUB_INTENT_POSTBACK_VERSION) {
    return {
      messages: [
        { type: 'text', text: 'このご案内は期限切れです。最新のご契約内容からあらためてお手続きください🌿' },
        ...(await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true })),
      ],
      outcome: 'stale_version',
    };
  }

  // §3-3: y (サイクル識別子) を現在の契約と突合する — d0 の drift 検査 (acceptSubIntent) だけだと
  // 「d0 の無いカード (推定不明時に配られた)」と「推定が null 化した後の旧カード」の両向きが
  // 素通りする (§10-5 監査 CONFIRMED)。unknown ↔ 実日付の食い違いもここで止まる
  if ((params.get('y') ?? '') !== subIntentCycleKey(contract, input.nowMs)) {
    return {
      messages: [
        { type: 'text', text: 'このご案内の後にご契約の状況が変わっています。お手数ですが、最新のカードからあらためてお手続きください🙇' },
        ...(await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true })),
      ],
      outcome: 'cycle_key_mismatch',
    };
  }

  // 解約済み契約への古いボタン: 実行不能な受理をしない (最新状態を見せる)
  if (contract.cancelled_at !== null) {
    return {
      messages: await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true }),
      outcome: 'contract_inactive',
    };
  }
  // 一時停止中: 解約意思は正当に受理する (§1-2 — 停止中の解約を doorway で捨てるのは解約妨害)。
  // skip/date/pause は停止中に意味を成さないので、理由を言って受理しない (§10-5 監査 MEDIUM)
  if (contract.paused_at !== null && op !== 'cancel' && op !== 'cancel_pause') {
    return {
      messages: [
        {
          type: 'text',
          text: '現在お届けは一時停止中のため、スキップ・お届け日変更のお手続きはありません🌿\n再開のご希望や解約のご相談は、このトークルームでいつでもどうぞ。',
        },
        ...(await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true })),
      ],
      outcome: 'paused_op_unavailable',
    };
  }

  if (op === 'cancel_pause') {
    // 2 タップ目の確認カード (§2: 解約は 2 タップ・一時停止は次のタップで受理)。
    // y/d0 は postback の値でなく**現在の契約から**再構成する (古い値を次のタップへ運ばない)
    return { messages: buildCancelPauseChoiceMessages(contract, input.nowMs), outcome: 'choice_shown' };
  }

  // ---- 受理 (§1-1) ----
  const d0 = params.get('d0');
  const presentedDate = d0 && /^\d{4}-\d{2}-\d{2}$/.test(d0) ? d0 : undefined;
  // op='date': datetimepicker の選択値が希望日 (§4-3 の照合対象として構造化)
  const pickedDate = input.postbackParams?.date;
  if (op === 'date' && (!pickedDate || !/^\d{4}-\d{2}-\d{2}$/.test(pickedDate))) {
    return {
      messages: [
        { type: 'text', text: '希望日を受け取れませんでした。お手数ですが、カードの「日付を変える」からもう一度お選びください🙇' },
      ],
      outcome: 'date_missing',
    };
  }
  // picker の min は描画時の防壁でしかない (古い吹き出しでは過去化する) — サーバ側でも過去日を弾く
  if (op === 'date' && pickedDate && pickedDate <= todayJst(input.nowMs)) {
    return {
      messages: [
        { type: 'text', text: '過去のお日にちは選択できません🙇 お手数ですが、カードの「日付を変える」から明日以降のお日にちをお選びください。' },
      ],
      outcome: 'date_in_past',
    };
  }
  const payloadObj: Record<string, unknown> = {};
  if (op === 'date' && pickedDate) payloadObj.requestedDate = pickedDate;
  // §4-1 の開示を経た受理は台帳に痕跡を残す (admin 経路の latePromiseAcknowledged と同じ規律)
  const acknowledged = params.get('ack') === '1';
  if (acknowledged) payloadObj.latePromiseAcknowledged = true;

  const result = await acceptSubIntent(db, {
    contractNs: 'hb',
    contractKey: contract.contract_id,
    op: op as 'skip' | 'date' | 'pause' | 'cancel',
    requestedBy: 'customer',
    presentedDate,
    payload: Object.keys(payloadObj).length > 0 ? payloadObj : null,
    acknowledgeLatePromise: acknowledged,
    nowMs: input.nowMs,
  });

  if (result.status === 'accepted' || result.status === 'duplicate') {
    const intent = result.intent;
    const label = SUB_INTENT_OP_LABELS[intent.op] ?? intent.op;
    let head: string;
    if (result.status === 'duplicate') {
      // date の重複は「既存の希望日」を必ず開示する — 新しく選んだ日付が登録されたと
      // 誤認させない (§10-5 監査 CONFIRMED: false-success)
      const existingDate = intent.op === 'date' ? requestedDateFromPayload(intent.payload_json) : null;
      head = existingDate
        ? `「${label}」は ${formatJpDate(existingDate) ?? existingDate} への変更で既に承っております。スタッフが順に対応しており、完了しましたら必ずご連絡いたします。`
        : `「${label}」のご依頼は既に承っております。スタッフが順に対応しており、完了しましたら必ずご連絡いたします。`;
      if (intent.op === 'date' && pickedDate && pickedDate !== existingDate) {
        head += `\n※ 今回お選びの ${formatJpDate(pickedDate) ?? pickedDate} はまだ登録されていません。日付を変えたい場合は、下の [取り消す] のあと、もう一度カードからお選びください。`;
      }
    } else {
      head =
        (op === 'date' && pickedDate ? `${formatJpDate(pickedDate) ?? pickedDate} への変更で、` : '') +
        buildAcceptanceMessage(intent.op, intent.promised_by, intent.executor);
    }
    return {
      messages: [{ type: 'text', text: head }, buildUndoBubble(intent)],
      outcome: result.status,
      // 🚨 duplicate では載せない。顧客の再タップのたびに Discord が鳴ると、
      // 本当に新規の受理が埋もれる (= 通知を入れた意味が消える)。
      ...(result.status === 'accepted'
        ? {
            accepted: {
              label: SUB_INTENT_OP_LABELS[intent.op] ?? intent.op,
              contractKey: intent.contract_key,
              promisedBy: intent.promised_by,
            },
          }
        : {}),
    };
  }

  if (result.status === 'deadline_passed') {
    // 締切超過の skip/date は受理しない (§10-5 監査 CONFIRMED — 受理すると数分後の sweep が
    // expire し「承りました」を機械が即時破棄する)。§3-3 の期限切れ結末に合流する
    return {
      messages: [
        {
          type: 'text',
          text: `申し訳ございません。今回の変更受付期限 (${formatJpDate(result.deadlineAt.slice(0, 10)) ?? '次回決済日の3日前'}) を過ぎているため、承ることができませんでした。今回の定期便は通常どおりのお手続きとなります🙇\nご要望がございましたら、このトークルームでご連絡ください。スタッフが必ず対応いたします。`,
        },
        ...(await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true })),
      ],
      outcome: 'deadline_passed',
    };
  }

  if (result.status === 'cycle_drift') {
    // §3-3: 提示時からサイクルが動いている。承ったと言わず、最新の予定で選び直してもらう
    return {
      messages: [
        {
          type: 'text',
          text: `ご案内のあとにご予定が更新されています (現在の決済予定: ${formatJpDate(result.currentEstimate) ?? 'マイページでご確認ください'})。お手数ですが、最新のカードからあらためてお手続きください🙇`,
        },
        ...(await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true })),
      ],
      outcome: 'cycle_drift',
    };
  }

  if (result.status === 'promise_after_deadline') {
    // §4-1: 受理前開示 — 「今回は間に合いません」を見せて選んでもらう (§2 ※1 の 2 タップ)
    return {
      messages: [
        { type: 'text', text: buildLatePromiseDisclosure(op as 'skip' | 'date' | 'pause' | 'cancel', result.promisedBy, result.deadlineAt) },
        buildLatePromiseChoiceBubble(op, contract, params, input.postbackParams?.date, result.promisedBy, input.nowMs),
      ],
      outcome: 'late_promise_disclosed',
    };
  }

  // contract_not_found / invalid_op / invalid_date / conflict — 正直に (受理を宣言しない)
  return {
    messages: [...buildConciergeErrorMessages()],
    outcome: result.status,
  };
}

/** §3-4: 受理応答に必ず併記する [取り消す]。期限は時刻でなく state (「スタッフ着手前まで」)。 */
function buildUndoBubble(intent: SubIntentRow): Message {
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: 'このご依頼は、スタッフの着手前までいつでも取り消せます。',
          size: 'md', // §7-2: 本文は md 以上
          color: '#334155',
          wrap: true,
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'md',
          margin: 'md',
          action: {
            type: 'postback',
            label: '取り消す',
            data: `action=sub_intent&op=undo&id=${encodeURIComponent(intent.id)}&v=${SUB_INTENT_POSTBACK_VERSION}`,
            displayText: 'さきほどの依頼を取り消します',
          },
        },
      ],
    },
  };
  return {
    type: 'flex',
    altText: 'ご依頼の取り消し',
    contents: bubble as unknown as never,
  };
}

/** §4-1 開示後の選択肢 (2 タップ目)。ack=1 を付けて同じ受理経路を再走行する。 */
function buildLatePromiseChoiceBubble(
  op: string,
  contract: SubscriptionContractRow,
  original: URLSearchParams,
  pickedDate: string | undefined,
  promisedBy: string,
  nowMs?: number,
): Message {
  const params = new URLSearchParams();
  params.set('action', 'sub_intent');
  params.set('op', op);
  params.set('cid', contract.contract_id);
  const d0 = original.get('d0');
  if (d0) params.set('d0', d0);
  const y = original.get('y');
  if (y) params.set('y', y);
  params.set('v', SUB_INTENT_POSTBACK_VERSION);
  params.set('ack', '1');
  // picker の可動域を必ず付ける (§10-5 監査 MEDIUM — 無いと過去日が選べてしまう。
  // サーバ側の過去日検証と二重防壁)。initial は前回選択を可動域内にクランプ
  const bounds = datePickerBounds(contract, nowMs);
  const initial =
    pickedDate && pickedDate >= bounds.min && pickedDate <= bounds.max ? pickedDate : bounds.initial;
  const acceptAction =
    op === 'date'
      ? {
          // date は希望日を選び直してもらう (datetimepicker の値は postback data に載せられないため)
          type: 'datetimepicker' as const,
          label: 'お願いする',
          data: params.toString(),
          mode: 'date' as const,
          initial,
          min: bounds.min,
          max: bounds.max,
        }
      : {
          type: 'postback' as const,
          label: 'お願いする',
          data: params.toString(),
          displayText: '間に合わない可能性を承知のうえでお願いします',
        };
  const bubble = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        {
          type: 'text',
          text: `反映予定: ${formatPromisedBy(promisedBy)}`,
          size: 'xl',
          weight: 'bold',
          color: TEAL_DARK,
          wrap: true,
        },
        {
          type: 'button',
          style: 'primary',
          color: TEAL_DARK,
          height: 'md',
          margin: 'md',
          action: acceptAction,
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'md',
          margin: 'sm',
          action: {
            type: 'postback',
            label: '今回はやめておく',
            data: `action=sub_intent&op=dismiss&cid=${encodeURIComponent(contract.contract_id)}&v=${SUB_INTENT_POSTBACK_VERSION}`,
            displayText: '今回はやめておきます',
          },
        },
      ],
    },
  };
  return {
    type: 'flex',
    altText: '反映予定のご確認',
    contents: bubble as unknown as never,
  };
}
