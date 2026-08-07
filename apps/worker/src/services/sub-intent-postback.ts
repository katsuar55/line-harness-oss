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
  SUB_INTENT_OP_LABELS,
  type SubIntentGateEnv,
} from './sub-intents.js';
import {
  buildSubscriptionMenuMessages,
  buildCancelPauseChoiceMessages,
  buildConciergeErrorMessages,
  getContractForFriend,
  subIntentPostbackData,
  formatJpDate,
  MYPAGE_URL,
  SUB_INTENT_POSTBACK_VERSION,
} from './subscription-concierge.js';
import { auditSystem } from './audit-logger.js';

const TEAL_DARK = '#0f766e';

export interface SubIntentPostbackEnv extends SubIntentGateEnv {
  DB: D1Database;
  LIFF_URL?: string;
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

  const friend = await getFriendByLineUserId(db, lineUserId);
  if (!friend) return;
  const conciergeFriend = {
    id: friend.id,
    display_name: friend.display_name,
    shopify_customer_id:
      (friend as { shopify_customer_id?: string | null }).shopify_customer_id ?? null,
  };

  const op = params.get('op') ?? '';
  let outcome = 'unknown';
  try {
    let messages: ReadonlyArray<Message>;

    if (op === 'dismiss') {
      messages = [
        { type: 'text', text: '承知しました。引き続きよろしくお願いいたします🌿\nお手続きが必要になったら、いつでもこのトークルームからどうぞ。' },
      ];
      outcome = 'dismissed';
    } else if (op === 'undo') {
      ({ messages, outcome } = await handleUndo(db, friend.id, params, input.nowMs));
    } else if (op === 'cancel_pause' || ACCEPT_OPS.has(op)) {
      ({ messages, outcome } = await handleContractOp(input, conciergeFriend, op));
    } else {
      messages = await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, {
        subIntent: true,
      });
      outcome = 'invalid_op';
    }

    await lineClient.replyMessage(replyToken, [...messages]);
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
  }
}

// ============================================================
// undo (§3-4 / §1-3)
// ============================================================

async function handleUndo(
  db: D1Database,
  friendId: string,
  params: URLSearchParams,
  nowMs?: number,
): Promise<{ messages: ReadonlyArray<Message>; outcome: string }> {
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
    // §1-3: 実行に踏み込んだ意思の取り消しは「承りました」止まり (取り消せたとは言わない)
    return {
      messages: [
        {
          type: 'text',
          text: `「${label}」の取り消しのご依頼を承りました。\nスタッフが対応状況を確認し、結果を必ずご連絡いたします。`,
        },
      ],
      outcome: 'undo_accepted',
    };
  }
  // not_undoable / not_found: state を正直に伝える (嘘の「取り消しました」を言わない)
  return {
    messages: [
      {
        type: 'text',
        text: `「${label}」のご依頼は現在の状態からは取り消せませんでした (対応が完了しているか、既に取り消し済みの可能性があります)。\nご希望があれば、このトークルームでお知らせください。スタッフが対応いたします。`,
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
): Promise<{ messages: ReadonlyArray<Message>; outcome: string }> {
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

  // 解約済み/一時停止済み契約への古いボタン: 実行不能な受理をしない (最新状態を見せる)
  if (contract.cancelled_at !== null || contract.paused_at !== null) {
    return {
      messages: await buildSubscriptionMenuMessages(db, conciergeFriend, env.LIFF_URL, { subIntent: true }),
      outcome: 'contract_inactive',
    };
  }

  if (op === 'cancel_pause') {
    // 2 タップ目の確認カード (§2: 解約は 2 タップ・一時停止は次のタップで受理)。
    // y/d0 は postback の値でなく**現在の契約から**再構成する (古い値を次のタップへ運ばない)
    return { messages: buildCancelPauseChoiceMessages(contract), outcome: 'choice_shown' };
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
  const payload = op === 'date' ? { requestedDate: pickedDate } : null;

  const result = await acceptSubIntent(db, {
    contractNs: 'hb',
    contractKey: contract.contract_id,
    op: op as 'skip' | 'date' | 'pause' | 'cancel',
    requestedBy: 'customer',
    presentedDate,
    payload,
    acknowledgeLatePromise: params.get('ack') === '1',
    nowMs: input.nowMs,
  });

  if (result.status === 'accepted' || result.status === 'duplicate') {
    const intent = result.intent;
    const label = SUB_INTENT_OP_LABELS[intent.op] ?? intent.op;
    const head =
      result.status === 'duplicate'
        ? `「${label}」のご依頼は既に承っております。スタッフが順に対応しており、完了しましたら必ずご連絡いたします。`
        : (op === 'date' && pickedDate
            ? `${formatJpDate(pickedDate) ?? pickedDate} への変更で、`
            : '') + buildAcceptanceMessage(intent.op, intent.promised_by, intent.executor);
    return {
      messages: [{ type: 'text', text: head }, buildUndoBubble(intent)],
      outcome: result.status,
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
        buildLatePromiseChoiceBubble(op, contract.contract_id, params, input.postbackParams?.date, result.promisedBy),
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
          size: 'sm',
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
  contractId: string,
  original: URLSearchParams,
  pickedDate: string | undefined,
  promisedBy: string,
): Message {
  const params = new URLSearchParams();
  params.set('action', 'sub_intent');
  params.set('op', op);
  params.set('cid', contractId);
  const d0 = original.get('d0');
  if (d0) params.set('d0', d0);
  const y = original.get('y');
  if (y) params.set('y', y);
  params.set('v', SUB_INTENT_POSTBACK_VERSION);
  params.set('ack', '1');
  const acceptAction =
    op === 'date'
      ? {
          // date は希望日を選び直してもらう (datetimepicker の値は postback data に載せられないため)
          type: 'datetimepicker' as const,
          label: 'お願いする',
          data: params.toString(),
          mode: 'date' as const,
          ...(pickedDate ? { initial: pickedDate } : {}),
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
            data: `action=sub_intent&op=dismiss&cid=${encodeURIComponent(contractId)}&v=${SUB_INTENT_POSTBACK_VERSION}`,
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
