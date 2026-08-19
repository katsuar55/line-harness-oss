/**
 * サブスク LIFF API (Ultraplan PR-4、2026-08-20)
 *
 * LIFF ミニアプリの契約画面が呼ぶ 3 endpoint。呼ぶ画面はまだ存在しない (inert)。
 *   GET  /api/liff/sub-contracts               — 契約一覧 + open intent の同梱
 *   POST /api/liff/sub-contracts/:id/intents   — 意思の受理 (skip|date|pause|cancel)
 *   POST /api/liff/sub-intents/:id/undo        — 取り消し (§1-3)
 *
 * 規律 (postback 経路 services/sub-intent-postback.ts と同じ背骨):
 *   - gate: 3 endpoint とも SUBSCRIPTION_MENU_ENABLED 必須。変更系 2 本はさらに
 *     SUB_INTENT_ENABLED 必須。gate OFF は GET = { enabled: false } / POST = 409
 *   - 認証: liffAuthMiddleware (/api/liff/* 自動)。liffUser 不在は 401
 *   - IDOR: 契約は shopify_customer_id、intent は friend_id と必ず突合し、
 *     他人のものは **404 (存在を漏らさない)**
 *   - §3-3: body.cycleKey を現在の契約と突合 — 古い画面のタップを別サイクルに作用させない
 *   - §1: 受理は「承りました」止まり。undo は state で決める (時刻で決めない)
 *   - §4-1: promised_by > deadline_at は受理前に開示 (409 late_promise) → ack 再送で受理
 *   - 受理成立の瞬間にスタッフへ通知 (Discord + info@ メール)。duplicate では鳴らさない
 *     (再タップのたびに鳴ると本当に新規の受理が埋もれる)
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index.js';
import {
  getSubscriptionContractsByCustomerId,
  getSubIntent,
  listOpenSubIntentsByFriend,
  type SubIntentRow,
} from '@line-crm/db';
import {
  getContractForFriend,
  subIntentPresentableDate,
  subIntentCycleKey,
  deadlineText,
  formatJpDate,
} from '../services/subscription-concierge.js';
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
} from '../services/sub-intents.js';
import { auditSystem } from '../services/audit-logger.js';

export const liffSubContracts = new Hono<Env>();

/** 顧客が LIFF から依頼できる op (resume はトーク相談・undo_of は undo endpoint 経由のみ)。 */
const LIFF_ACCEPT_OPS = ['skip', 'date', 'pause', 'cancel'] as const;
type LiffAcceptOp = (typeof LIFF_ACCEPT_OPS)[number];

/** 今日 (JST)。sub-intent-postback.ts の todayJst と同じ規則 (過去日 date の防壁)。 */
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function isMenuEnabled(env: { SUBSCRIPTION_MENU_ENABLED?: string }): boolean {
  return env.SUBSCRIPTION_MENU_ENABLED === 'true';
}

/** IDOR 拒否は「存在しない」と同文・同ステータス (存在確認オラクルを作らない)。 */
function notFoundJson(c: Context<Env>): Response {
  return c.json({ success: false, error: '見つかりませんでした' }, 404);
}

/** open intent の API 射影 (PII なし — id / op / state / 約束期限 / 希望日のみ)。 */
function toIntentSummary(intent: SubIntentRow): {
  id: string;
  op: string;
  opLabel: string;
  state: string;
  promisedBy: string | null;
  requestedDate: string | null;
} {
  return {
    id: intent.id,
    op: intent.op,
    opLabel: SUB_INTENT_OP_LABELS[intent.op] ?? intent.op,
    state: intent.state,
    promisedBy: intent.promised_by,
    requestedDate: requestedDateFromPayload(intent.payload_json),
  };
}

/**
 * 受理成立のスタッフ通知 1 行 (PII なし §1-4)。
 * sub-intent-postback.ts の buildAcceptedAlertLine と同型 + 経路が分かるよう「LIFF から」を入れる。
 */
function buildLiffAcceptedAlertLine(accepted: {
  label: string;
  contractKey: string;
  promisedBy: string | null;
}): string {
  return (
    `🆕 「${accepted.label}」(契約 ${accepted.contractKey}) を LIFF から承りました。` +
    (accepted.promisedBy
      ? `約束期限 ${String(accepted.promisedBy).slice(0, 16).replace('T', ' ')} — /admin/ops で対応してください`
      : '約束期限なし (推定日が出せない契約) — /admin/ops で対応してください')
  );
}

// ============================================================
// GET /api/liff/sub-contracts — 契約一覧 (read-only。gate は menu のみ)
// ============================================================

liffSubContracts.get('/api/liff/sub-contracts', async (c) => {
  const liffUser = c.get('liffUser') as
    | { lineUserId: string; friendId: string; shopifyCustomerId: string | null }
    | undefined;
  if (!liffUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  // gate OFF: 機能の存在だけ伝える (DB 非接触 — ロールバック時も安全)
  if (!isMenuEnabled(c.env)) {
    return c.json({ success: true, data: { enabled: false } });
  }
  const subIntentEnabled = isSubIntentEnabled(c.env);
  if (!liffUser.shopifyCustomerId) {
    // 未連携: 契約は引けない (引かない)。UI は連携導線を出す
    return c.json({
      success: true,
      data: { enabled: true, linked: false, subIntentEnabled, contracts: [] },
    });
  }
  try {
    const contracts = await getSubscriptionContractsByCustomerId(
      c.env.DB,
      liffUser.shopifyCustomerId,
    );
    const openIntents = await listOpenSubIntentsByFriend(c.env.DB, liffUser.friendId);
    const intentsByContract = new Map<string, SubIntentRow[]>();
    for (const intent of openIntents) {
      const list = intentsByContract.get(intent.contract_key) ?? [];
      intentsByContract.set(intent.contract_key, [...list, intent]);
    }
    return c.json({
      success: true,
      data: {
        enabled: true,
        linked: true,
        subIntentEnabled,
        contracts: contracts.map((contract) => ({
          contractId: contract.contract_id,
          planName: contract.plan_name,
          intervalDays: contract.interval_days,
          orderCount: contract.order_count,
          state: contract.cancelled_at ? 'cancelled' : contract.paused_at ? 'paused' : 'active',
          // §3-3: 画面が受理 POST に付け返すサイクル識別子 (postback の y と同形式)
          presentableDate: subIntentPresentableDate(contract),
          cycleKey: subIntentCycleKey(contract),
          deadlineText: deadlineText(contract),
          openIntents: (intentsByContract.get(contract.contract_id) ?? []).map(toIntentSummary),
        })),
      },
    });
  } catch (err) {
    console.error('[liff-sub-contracts] list failed:', err);
    return c.json({ success: false, error: '契約情報を取得できませんでした' }, 500);
  }
});

// ============================================================
// POST /api/liff/sub-contracts/:id/intents — 受理 (§1-1)
// ============================================================

liffSubContracts.post('/api/liff/sub-contracts/:id/intents', async (c) => {
  const liffUser = c.get('liffUser') as
    | { lineUserId: string; friendId: string; shopifyCustomerId: string | null }
    | undefined;
  if (!liffUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!isMenuEnabled(c.env) || !isSubIntentEnabled(c.env)) {
    // gate OFF: 受理の受け皿が無い (409 = 状態起因の拒否。false-success を作らない)
    return c.json(
      { success: false, error: 'gate_off', message: 'この機能は現在ご利用いただけません。お手続きはマイページをご利用ください。' },
      409,
    );
  }
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as {
    op?: string;
    cycleKey?: string;
    requestedDate?: string;
    ack?: boolean;
  };

  // ① op ガード (undo_of / resume は受理経路に載せない)
  const op = (body.op ?? '') as LiffAcceptOp;
  if (!LIFF_ACCEPT_OPS.includes(op)) {
    return c.json({ success: false, error: 'op は skip|date|pause|cancel のいずれかです' }, 400);
  }

  try {
    // ② IDOR: contract id は改ざん可能入力 — 所有者検証に失敗したら存在を漏らさず 404
    const contract = await getContractForFriend(
      db,
      {
        id: liffUser.friendId,
        display_name: null,
        shopify_customer_id: liffUser.shopifyCustomerId,
      },
      c.req.param('id'),
    );
    if (!contract) return notFoundJson(c);

    // ③ §3-3: 画面が見ていたサイクルと現在の契約を突合 (古い画面のタップを別サイクルに作用させない)
    const currentCycleKey = subIntentCycleKey(contract);
    if ((body.cycleKey ?? '') !== currentCycleKey) {
      return c.json(
        {
          success: false,
          error: 'cycle_changed',
          current: { cycleKey: currentCycleKey, presentableDate: subIntentPresentableDate(contract) },
        },
        409,
      );
    }

    // ④ 契約状態: 実行不能な受理をしない (postback と同旨の顧客向け文言)
    if (contract.cancelled_at !== null) {
      return c.json(
        {
          success: false,
          error: 'contract_inactive',
          message: 'この契約は解約済みのため、お手続きの対象がありません。再開はいつでも歓迎です🌿',
        },
        409,
      );
    }
    // 一時停止中: 解約意思は正当に受理する (§1-2 — 停止中の解約を doorway で捨てるのは解約妨害)
    if (contract.paused_at !== null && op !== 'cancel') {
      return c.json(
        {
          success: false,
          error: 'paused_op_unavailable',
          message:
            '現在お届けは一時停止中のため、スキップ・お届け日変更のお手続きはありません🌿\n再開のご希望や解約のご相談は、LINE のトークルームでいつでもどうぞ。',
        },
        409,
      );
    }

    // ⑤ op='date': 希望日は必須・形式・過去日 (JST 今日含む) をサーバ側で弾く
    //   (postback の「picker min は描画時の防壁でしかない」と同じ理由で画面を信じない)
    const requestedDate = (body.requestedDate ?? '').trim();
    if (op === 'date') {
      if (!requestedDate || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return c.json({ success: false, error: '希望日は YYYY-MM-DD 形式で指定してください' }, 400);
      }
      if (requestedDate <= todayJst()) {
        return c.json(
          { success: false, error: '過去のお日にちは選択できません。明日以降のお日にちをお選びください' },
          400,
        );
      }
    }

    // ⑥ 受理 (§1-1)。§4-1 の開示を経た受理は台帳に痕跡を残す (postback / admin 経路と同じ規律)
    const acknowledged = body.ack === true;
    const payload: Record<string, unknown> = {};
    if (op === 'date') payload.requestedDate = requestedDate;
    if (acknowledged) payload.latePromiseAcknowledged = true;
    const result = await acceptSubIntent(db, {
      contractNs: 'hb',
      contractKey: contract.contract_id,
      op,
      requestedBy: 'customer',
      presentedDate: subIntentPresentableDate(contract),
      payload: Object.keys(payload).length > 0 ? payload : null,
      acknowledgeLatePromise: acknowledged,
    });

    // 監査 (PII なし: op と結果のみ)。actorType='api' = 顧客起点の LIFF API
    await auditSystem(db, {
      action: 'sub_intent.liff_accept',
      actorType: 'api',
      targetType: 'friend',
      targetId: liffUser.friendId,
      result:
        result.status === 'accepted' || result.status === 'duplicate' ? 'success' : 'failure',
      errorMessage:
        result.status === 'accepted' || result.status === 'duplicate' ? undefined : result.status,
      metadata: acknowledged ? { op, outcome: result.status, acknowledgedLatePromise: true } : { op, outcome: result.status },
    });

    // ⑦ 結果マッピング
    if (result.status === 'accepted' || result.status === 'duplicate') {
      const intent = result.intent;
      const label = SUB_INTENT_OP_LABELS[intent.op] ?? intent.op;
      if (result.status === 'duplicate') {
        // date の重複は「既存の希望日」を必ず開示 — 新しく選んだ日付が登録されたと誤認させない。
        // 🚨 duplicate では通知を**絶対に鳴らさない** (再タップのたびに鳴ると新規受理が埋もれる)
        const existingDate =
          intent.op === 'date' ? requestedDateFromPayload(intent.payload_json) : null;
        let message = existingDate
          ? `「${label}」は ${formatJpDate(existingDate) ?? existingDate} への変更で既に承っております。スタッフが順に対応しており、完了しましたら必ずご連絡いたします。`
          : `「${label}」のご依頼は既に承っております。スタッフが順に対応しており、完了しましたら必ずご連絡いたします。`;
        if (intent.op === 'date' && requestedDate && requestedDate !== existingDate) {
          message += `\n※ 今回お選びの ${formatJpDate(requestedDate) ?? requestedDate} はまだ登録されていません。日付を変えたい場合は、いまのご依頼を取り消してからもう一度お選びください。`;
        }
        return c.json({
          success: true,
          data: { status: 'duplicate', intent: toIntentSummary(intent), existingDate, message },
        });
      }
      // accepted: §4-1 の約束 (+ cancel は §4-4 の救済手順) を含む文言
      const message =
        (op === 'date' && requestedDate
          ? `${formatJpDate(requestedDate) ?? requestedDate} への変更で、`
          : '') + buildAcceptanceMessage(intent.op, intent.promised_by, intent.executor);
      // 🚨 受理の瞬間にスタッフへ知らせる (accepted のときだけ)。応答生成後の best-effort —
      //   Discord/メールの失敗や遅延は顧客応答に影響しない (内部で握って console.error)
      const line = buildLiffAcceptedAlertLine({
        label,
        contractKey: intent.contract_key,
        promisedBy: intent.promised_by,
      });
      await sendSubIntentAlert(c.env, [line]);
      await sendSubIntentStaffEmail(c.env, `新しいご依頼: ${label}`, [line]);
      return c.json({
        success: true,
        data: {
          status: 'accepted',
          intent: toIntentSummary(intent),
          promisedBy: intent.promised_by,
          message,
        },
      });
    }

    if (result.status === 'promise_after_deadline') {
      // §4-1: 受理していない。開示して顧客に選ばせる (ack=true の再送で受理)
      return c.json(
        {
          success: false,
          error: 'late_promise',
          promisedBy: result.promisedBy,
          deadlineAt: result.deadlineAt,
          disclosure: buildLatePromiseDisclosure(op, result.promisedBy, result.deadlineAt),
        },
        409,
      );
    }

    if (result.status === 'deadline_passed') {
      // 締切超過の skip/date は ack でも受理しない (受理すると sweep が数分後に expire =
      // 「承りました」の即時破棄)。正直な文言で断る
      return c.json(
        {
          success: false,
          error: 'deadline_passed',
          deadlineAt: result.deadlineAt,
          message: `申し訳ございません。今回の変更受付期限 (${formatJpDate(result.deadlineAt.slice(0, 10)) ?? '次回決済日の3日前'}) を過ぎているため、承ることができませんでした。今回の定期便は通常どおりのお手続きとなります🙇\nご要望は LINE のトークルームでご連絡ください。スタッフが必ず対応いたします。`,
        },
        409,
      );
    }

    if (result.status === 'cycle_drift') {
      // ③ の突合後に read-model が動いた race。cycle_changed と同形式で返す (画面は再読込する)
      return c.json(
        {
          success: false,
          error: 'cycle_changed',
          current: {
            cycleKey: `${contract.contract_id}:${result.currentEstimate ?? 'unknown'}`,
            presentableDate: result.currentEstimate,
          },
        },
        409,
      );
    }

    // contract_not_found / invalid_op / invalid_date / conflict — 受理を宣言しない
    return c.json({ success: false, error: `受理できませんでした (${result.status})` }, 400);
  } catch (err) {
    console.error('[liff-sub-contracts] accept failed:', err);
    await auditSystem(db, {
      action: 'sub_intent.liff_accept',
      actorType: 'api',
      targetType: 'friend',
      targetId: liffUser.friendId,
      result: 'failure',
      errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
      metadata: { op, outcome: 'threw' },
    });
    return c.json({ success: false, error: 'お手続きを受け付けられませんでした。時間をおいてお試しください' }, 500);
  }
});

// ============================================================
// POST /api/liff/sub-intents/:id/undo — 取り消し (§1-3)
// ============================================================

liffSubContracts.post('/api/liff/sub-intents/:id/undo', async (c) => {
  const liffUser = c.get('liffUser') as
    | { lineUserId: string; friendId: string; shopifyCustomerId: string | null }
    | undefined;
  if (!liffUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  if (!isMenuEnabled(c.env) || !isSubIntentEnabled(c.env)) {
    return c.json(
      { success: false, error: 'gate_off', message: 'この機能は現在ご利用いただけません。お手続きはマイページをご利用ください。' },
      409,
    );
  }
  const db = c.env.DB;
  const id = c.req.param('id');
  try {
    // IDOR: intent は自分のもの (friend_id 一致) だけ触れる。他人の id は存在を漏らさない (404 同文)
    const intent = await getSubIntent(db, id);
    if (!intent || intent.friend_id !== liffUser.friendId) {
      return notFoundJson(c);
    }
    const result = await undoSubIntent(db, id, { staffId: null, role: null }, { requestedBy: 'customer' });
    const label = SUB_INTENT_OP_LABELS[intent.op] ?? intent.op;
    await auditSystem(db, {
      action: 'sub_intent.liff_undo',
      actorType: 'api',
      targetType: 'friend',
      targetId: liffUser.friendId,
      result: result.status === 'cancelled' || result.status === 'undo_accepted' ? 'success' : 'failure',
      errorMessage:
        result.status === 'cancelled' || result.status === 'undo_accepted' ? undefined : result.status,
      metadata: { op: intent.op, outcome: result.status },
    });

    if (result.status === 'cancelled') {
      return c.json({
        success: true,
        data: {
          status: 'cancelled',
          message: `「${label}」のご依頼を取り消しました。定期便は変更前のまま続きます🌿`,
        },
      });
    }
    if (result.status === 'undo_accepted') {
      // §1-3: 実行に踏み込んだ意思の取り消しは「承りました」止まり (取り消せたとは言わない)。
      // §4-1: 約束期限 (promised_by) を開示する。
      // 着手後の取り消しはスタッフの新規作業が生まれる — postback の handleUndo と同じ規律で
      // スタッフ通知 (Discord + メール) を送る (undo_cancelled は作業が消えるだけなので送らない)
      const promisedBy = result.undoIntent.promised_by;
      const undoLabel = `${label} の取り消し`;
      const line = buildLiffAcceptedAlertLine({
        label: undoLabel,
        contractKey: intent.contract_key,
        promisedBy,
      });
      await sendSubIntentAlert(c.env, [line]);
      await sendSubIntentStaffEmail(c.env, `新しいご依頼: ${undoLabel}`, [line]);
      return c.json({
        success: true,
        data: {
          status: 'undo_accepted',
          promisedBy,
          message:
            `「${label}」の取り消しのご依頼を承りました。\n` +
            (promisedBy
              ? `${formatPromisedBy(promisedBy)} までにスタッフが対応状況を確認し、結果を必ずご連絡いたします。`
              : `スタッフが対応状況を確認し、結果を必ずご連絡いたします。`),
        },
      });
    }
    if (result.status === 'not_undoable') {
      return c.json({ success: false, error: 'not_undoable', state: result.state }, 409);
    }
    // not_found: getSubIntent 後に消えた race — IDOR 拒否と同文 (存在を漏らさない)
    return notFoundJson(c);
  } catch (err) {
    console.error('[liff-sub-contracts] undo failed:', err);
    return c.json({ success: false, error: 'お手続きを受け付けられませんでした。時間をおいてお試しください' }, 500);
  }
});
