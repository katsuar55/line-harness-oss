/**
 * /admin/ops — サブスク受理レイヤーのスタッフ卓 (§10-3、 2026-08-06)
 *
 * - GET  /admin/ops                        : スタッフ卓 HTML (公開 shell。操作は保護 API 経由)。
 *                                            routes/friend-coupon.ts と同型 — apps/web は本番
 *                                            デプロイされないため worker 配信の自己完結ページ。
 * - GET  /api/admin/sub-intents            : 一覧 + 集計 (requireRole owner|admin)
 * - POST /api/admin/sub-intents            : スタッフ受理 (電話/メールで受けた依頼の台帳化)
 * - POST /api/admin/sub-intents/:id/claim  : 着手 (received → executing の CAS)
 * - POST /api/admin/sub-intents/:id/done   : 完了 (executing → done の CAS)
 * - POST /api/admin/sub-intents/:id/fail   : 正直な失敗 (executing → failed、理由必須)
 * - POST /api/admin/sub-intents/:id/release: 誤 claim の取り下げ (明示的な人間の判断のみ)
 * - POST /api/admin/sub-intents/:id/undo   : 取り消し (received|deferred → cancelled の CAS)
 *
 * セキュリティ (§1-4 / §4):
 *   - 全 API は requireRole('owner','admin')。
 *   - **変更系は共有 env API_KEY (env-owner) を拒否** — 「誰がやったか」を個人単位で
 *     追跡できない代行は運用に載せない (§4: 個人キーのみ)。閲覧 (GET) は env-owner 可。
 *   - 変更系は gate SUB_INTENT_ENABLED='true' が必須 (既定 OFF = 本番 dormant)。
 *     gate OFF で受理だけ通ると「受け皿の無い台帳」が育つ (§10-5 の禁止形と同根)。
 *   - 全遷移を auditAdminAction (targetType='sub_intent') に記録。metadata は
 *     contract_key と op のみ (PII を残さない §1-4)。
 *
 * HTML shell は**値の埋め込みゼロの静的文字列** (全データは API から取得) —
 * inline script への値埋め込み事故 (73日障害クラス) を構造的に排除する。
 * liff-script-syntax.test.ts の OTHER_HTML_PAGES で打ち切り/parse を検証している。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditAdminAction } from '../services/admin-audit.js';
import {
  acceptSubIntent,
  claimSubIntent,
  completeSubIntent,
  failSubIntent,
  releaseSubIntent,
  undoSubIntent,
  isSubIntentEnabled,
  sendSubIntentAlert,
  SUB_INTENT_OP_LABELS,
  HUMAN_CLAIM_ALERT_MINUTES,
  ACCEPTABLE_OPS,
} from '../services/sub-intents.js';
import {
  listSubIntentsForOps,
  getSubIntentStats,
  jstNow,
  toJstString,
  type SubIntentRow,
  type SubIntentOp,
} from '@line-crm/db';

export const adminOps = new Hono<Env>();

adminOps.use('/api/admin/sub-intents', requireRole('owner', 'admin'));
adminOps.use('/api/admin/sub-intents/*', requireRole('owner', 'admin'));

/**
 * 変更系の共通ガード: ① 共有 env API_KEY (env-owner) を拒否 (§4: 個人キーのみ)
 * ② gate SUB_INTENT_ENABLED 未投入なら拒否 (死んだ台帳を育てない)。
 * 拒否時は Response、許可なら null。
 */
async function denyMutation(c: Context<Env>): Promise<Response | null> {
  const staff = c.get('staff') as { id: string; role: string } | undefined;
  if (!staff || staff.id === 'env-owner') {
    await auditAdminAction(c, {
      action: 'admin.sub_intent.denied_env_owner',
      targetType: 'sub_intent',
      result: 'failure',
      errorMessage: '共有キーでの受理レイヤー操作は禁止 (個人キーのみ)',
    });
    return c.json(
      {
        success: false,
        error:
          '共有 API キーでは受理レイヤーを操作できません。/admin/staff で発行した個人キーを使ってください (誰が対応したかを記録するため)',
      },
      403,
    );
  }
  if (!isSubIntentEnabled(c.env)) {
    return c.json(
      {
        success: false,
        error:
          'SUB_INTENT_ENABLED が未投入のため受理レイヤーは停止中です (本番挙動を変えない既定 OFF)。有効化は Katsu 承認のうえ secret を投入してください',
      },
      400,
    );
  }
  return null;
}

function claimAgeMinutes(row: SubIntentRow, nowMs: number): number | null {
  if (row.state !== 'executing' || !row.claimed_at) return null;
  const claimed = Date.parse(row.claimed_at);
  if (!Number.isFinite(claimed)) return null;
  return Math.max(0, Math.floor((nowMs - claimed) / 60_000));
}

function toApiRow(row: SubIntentRow, nowMs: number) {
  return {
    id: row.id,
    contractKey: row.contract_key,
    contractNs: row.contract_ns,
    op: row.op,
    opLabel: SUB_INTENT_OP_LABELS[row.op] ?? row.op,
    state: row.state,
    requestedBy: row.requested_by,
    presentedDate: row.presented_scheduled_date,
    deadlineAt: row.deadline_at,
    claimedAt: row.claimed_at,
    /** §1-2: human claim の未解決時間を常時可視化する (30 分超は一覧の先頭に固定) */
    claimAgeMinutes: claimAgeMinutes(row, nowMs),
    claimAlert: (claimAgeMinutes(row, nowMs) ?? 0) >= HUMAN_CLAIM_ALERT_MINUTES,
    actorStaffId: row.actor_staff_id,
    executor: row.executor,
    payload: row.payload_json,
    failReason: row.fail_reason,
    carryoverCount: row.carryover_count,
    escalated: row.escalated_at !== null,
    linked: row.friend_id !== null,
    supersedesIntentId: row.supersedes_intent_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// ─── 一覧 (閲覧は env-owner でも可 — 可視性を止めない) ───
adminOps.get('/api/admin/sub-intents', async (c) => {
  const nowMs = Date.now();
  const sevenDaysAgo = toJstString(new Date(nowMs - 7 * 86_400_000));
  try {
    const [rows, stats] = await Promise.all([
      listSubIntentsForOps(c.env.DB),
      getSubIntentStats(c.env.DB, sevenDaysAgo),
    ]);
    return c.json({
      success: true,
      data: {
        gateEnabled: isSubIntentEnabled(c.env),
        alertThresholdMinutes: HUMAN_CLAIM_ALERT_MINUTES,
        stats,
        intents: rows.map((r) => toApiRow(r, nowMs)),
        serverTime: jstNow(),
      },
    });
  } catch (err) {
    // migration 076 未適用 (コード先行デプロイ) でも 500 にせず状態を正直に返す —
    // gate OFF の dormancy を「閲覧が壊れる」で破らない。それ以外の D1 例外は再 throw
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('no such table')) throw err;
    return c.json({
      success: true,
      data: {
        gateEnabled: isSubIntentEnabled(c.env),
        alertThresholdMinutes: HUMAN_CLAIM_ALERT_MINUTES,
        migrationMissing: true,
        stats: {
          received: 0, executing: 0, deferred: 0, cancelRequested: 0,
          doneLast7d: 0, failedLast7d: 0, expiredLast7d: 0,
        },
        intents: [],
        serverTime: jstNow(),
      },
    });
  }
});

// ─── スタッフ受理 (電話/メール依頼の台帳化) ───
adminOps.post('/api/admin/sub-intents', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const staff = c.get('staff') as { id: string; role: string };
  const body = (await c.req.json().catch(() => ({}))) as {
    contractKey?: string;
    op?: string;
    presentedDate?: string;
    note?: string;
  };
  const contractKey = (body.contractKey ?? '').trim();
  const op = (body.op ?? '') as SubIntentOp;
  if (!contractKey || !ACCEPTABLE_OPS.includes(op)) {
    return c.json({ success: false, error: 'contractKey と op (skip|date|pause|resume|cancel) は必須です' }, 400);
  }
  // note は台帳に残る。PII を書かない運用はページ側の注意書き + ここでの長さ制限で支える
  const note = (body.note ?? '').trim().slice(0, 200);
  const result = await acceptSubIntent(c.env.DB, {
    contractNs: 'hb',
    contractKey,
    op,
    requestedBy: 'staff',
    presentedDate: body.presentedDate?.trim() || undefined,
    payload: note ? { note } : null,
    actorStaffId: staff.id,
    actorRole: staff.role,
  });
  await auditAdminAction(c, {
    action: 'admin.sub_intent.accept',
    targetType: 'sub_intent',
    targetId: result.status === 'accepted' || result.status === 'duplicate' ? result.intent.id : null,
    result: result.status === 'accepted' || result.status === 'duplicate' ? 'success' : 'failure',
    errorMessage: result.status === 'accepted' || result.status === 'duplicate' ? undefined : result.status,
    metadata: { contractKey, op },
  });
  if (result.status === 'accepted' || result.status === 'duplicate') {
    return c.json({ success: true, data: { status: result.status, intent: toApiRow(result.intent, Date.now()) } });
  }
  if (result.status === 'contract_not_found') {
    return c.json({ success: false, error: '契約が見つかりません。契約ID (Huckleberry の定期購買ID) を確認してください' }, 404);
  }
  if (result.status === 'cycle_drift') {
    return c.json(
      { success: false, error: '指定の予定日が現在の推定 (' + (result.currentEstimate ?? '不明') + ') と一致しません。最新の状況を確認してから受理してください' },
      409,
    );
  }
  if (result.status === 'invalid_date') {
    return c.json({ success: false, error: '予定日は YYYY-MM-DD 形式で入力してください' }, 400);
  }
  return c.json({ success: false, error: '受理できませんでした (' + result.status + ')' }, 400);
});

// ─── 着手 (claim) ───
adminOps.post('/api/admin/sub-intents/:id/claim', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const staff = c.get('staff') as { id: string; role: string };
  const id = c.req.param('id');
  const result = await claimSubIntent(c.env.DB, id, { staffId: staff.id, role: staff.role });
  await auditAdminAction(c, {
    action: 'admin.sub_intent.claim',
    targetType: 'sub_intent',
    targetId: id,
    result: result.status === 'claimed' ? 'success' : 'failure',
    errorMessage: result.status === 'claimed' ? undefined : result.status,
    metadata: result.status !== 'not_found' && result.intent ? { contractKey: result.intent.contract_key, op: result.intent.op } : {},
  });
  if (result.status === 'claimed') {
    return c.json({ success: true, data: { intent: toApiRow(result.intent, Date.now()) } });
  }
  if (result.status === 'not_found') return c.json({ success: false, error: '対象が見つかりません' }, 404);
  return c.json(
    { success: false, error: '着手できませんでした (他のスタッフが着手済み・締切超過・または取り消し済み)。一覧を更新して最新の状態を確認してください' },
    409,
  );
});

// ─── 完了 (done) ───
adminOps.post('/api/admin/sub-intents/:id/done', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const staff = c.get('staff') as { id: string; role: string };
  const id = c.req.param('id');
  const result = await completeSubIntent(c.env.DB, id, { staffId: staff.id, role: staff.role });
  await auditAdminAction(c, {
    action: 'admin.sub_intent.done',
    targetType: 'sub_intent',
    targetId: id,
    result: result.status === 'done' ? 'success' : 'failure',
    errorMessage: result.status === 'done' ? undefined : result.status,
    metadata: result.status !== 'not_found' && result.intent ? { contractKey: result.intent.contract_key, op: result.intent.op } : {},
  });
  if (result.status === 'done') {
    // undo_of 完了なのに元 intent を解決できなかった場合は握り潰さない
    // (元が executing のまま = 人間が元 claim を解決する必要がある)
    if (result.intent.op === 'undo_of' && !result.originalResolved) {
      await sendSubIntentAlert(c.env, [
        `⚠️ 取り消し (${result.intent.contract_key}) は完了しましたが、元の依頼を自動で解決できませんでした (対応中のまま)。/admin/ops で元の依頼を確認してください`,
      ]);
    }
    return c.json({ success: true, data: { intent: toApiRow(result.intent, Date.now()), originalResolved: result.originalResolved } });
  }
  if (result.status === 'not_found') return c.json({ success: false, error: '対象が見つかりません' }, 404);
  // §1-2: CAS 0 行 = 「完了」と宣言しない。二重実行の疑いを握り潰さず Discord にも上げる
  // (409 を受けた操作者が画面を更新して流しても、管理者に届く経路を残す)
  const staffForAlert = c.get('staff') as { id: string } | undefined;
  await sendSubIntentAlert(c.env, [
    `🚨 二重対応の疑い: 完了記録が競合しました (intent ${id})。操作者 ${staffForAlert?.id ?? '不明'}。Huckleberry 管理画面の実際の状態を確認してください`,
  ]);
  return c.json(
    { success: false, error: '完了を記録できませんでした (状態が変わっています = 二重対応の疑い)。一覧を更新し、Huckleberry 管理画面の実際の状態を確認してください', suspectDoubleExecution: true },
    409,
  );
});

// ─── 正直な失敗 (failed) ───
adminOps.post('/api/admin/sub-intents/:id/fail', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const staff = c.get('staff') as { id: string; role: string };
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason = (body.reason ?? '').trim().slice(0, 200);
  if (!reason) return c.json({ success: false, error: '失敗理由は必須です (顧客への説明の土台になります)' }, 400);
  const result = await failSubIntent(c.env.DB, id, reason, { staffId: staff.id, role: staff.role });
  await auditAdminAction(c, {
    action: 'admin.sub_intent.fail',
    targetType: 'sub_intent',
    targetId: id,
    result: result.status === 'failed' ? 'success' : 'failure',
    // 理由本文は append-only の audit_logs に入れない (自由記述 = PII 混入リスク。
    // 本文は sub_intents.fail_reason にのみ保持し、訂正の余地を残す)
    errorMessage: result.status === 'failed' ? 'staff_reason_recorded' : result.status,
    metadata: result.status !== 'not_found' && result.intent ? { contractKey: result.intent.contract_key, op: result.intent.op } : {},
  });
  if (result.status === 'failed') {
    return c.json({ success: true, data: { intent: toApiRow(result.intent, Date.now()), originalRestored: result.originalRestored } });
  }
  if (result.status === 'not_found') return c.json({ success: false, error: '対象が見つかりません' }, 404);
  return c.json({ success: false, error: '失敗を記録できませんでした (状態が変わっています)。一覧を更新してください' }, 409);
});

// ─── 誤 claim の取り下げ (release) ───
adminOps.post('/api/admin/sub-intents/:id/release', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const id = c.req.param('id');
  const result = await releaseSubIntent(c.env.DB, id);
  await auditAdminAction(c, {
    action: 'admin.sub_intent.release',
    targetType: 'sub_intent',
    targetId: id,
    result: result.status === 'released' ? 'success' : 'failure',
    errorMessage: result.status === 'released' ? undefined : result.status,
    metadata: result.status !== 'not_found' && result.intent ? { contractKey: result.intent.contract_key, op: result.intent.op } : {},
  });
  if (result.status === 'released') {
    return c.json({ success: true, data: { intent: toApiRow(result.intent, Date.now()) } });
  }
  if (result.status === 'not_found') return c.json({ success: false, error: '対象が見つかりません' }, 404);
  return c.json({ success: false, error: '解放できませんでした (状態が変わっています)。一覧を更新してください' }, 409);
});

// ─── 取り消し (undo) ───
adminOps.post('/api/admin/sub-intents/:id/undo', async (c) => {
  const denied = await denyMutation(c);
  if (denied) return denied;
  const staff = c.get('staff') as { id: string; role: string };
  const id = c.req.param('id');
  // /admin/ops 経由の undo はスタッフ発 (§1-4: requested_by は種別。顧客発は §10-5 で 'customer')
  const result = await undoSubIntent(c.env.DB, id, { staffId: staff.id, role: staff.role }, { requestedBy: 'staff' });
  const undone =
    result.status === 'cancelled' ? result.intent : result.status === 'undo_accepted' ? result.undoIntent : null;
  await auditAdminAction(c, {
    action: 'admin.sub_intent.undo',
    targetType: 'sub_intent',
    targetId: id,
    result: result.status === 'cancelled' || result.status === 'undo_accepted' ? 'success' : 'failure',
    errorMessage: result.status === 'cancelled' || result.status === 'undo_accepted' ? undefined : result.status,
    // §4 受入条件「/admin/logs から契約単位で追跡できる」— undo だけ metadata を欠かさない
    metadata: undone ? { contractKey: undone.contract_key, op: undone.op } : {},
  });
  if (result.status === 'cancelled') {
    return c.json({ success: true, data: { status: 'cancelled', intent: toApiRow(result.intent, Date.now()) } });
  }
  if (result.status === 'undo_accepted') {
    // §1-3: 実行に踏み込んだ意思は「取り消しのご依頼を承りました」止まり
    return c.json({ success: true, data: { status: 'undo_accepted', undoIntent: toApiRow(result.undoIntent, Date.now()) } });
  }
  if (result.status === 'not_found') return c.json({ success: false, error: '対象が見つかりません' }, 404);
  return c.json({ success: false, error: 'この状態 (' + result.state + ') からは取り消せません' }, 409);
});

// ─── スタッフ卓ページ (公開 HTML shell。実操作は上記保護 API 経由) ───
adminOps.get('/admin/ops', (c) => c.html(OPS_PAGE_HTML));

// 値の埋め込みゼロ (静的文字列)。全データは fetch で取得する。
// ⚠️ この文字列に ${} や バックスラッシュ+シングルクォート や script 終了タグの literal を
//    書かないこと (CLAUDE.md「LIFF inline JS コーディングルール」)。
const OPS_PAGE_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0ABAB5">
  <meta name="robots" content="noindex,nofollow">
  <title>定期便の受理台帳 (スタッフ卓)</title>
  <style>
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    body{font-family:system-ui,-apple-system,'Segoe UI','Noto Sans JP',sans-serif;background:#f4f8f8;margin:0;padding:20px;color:#1f2937}
    .wrap{max-width:760px;margin:0 auto}
    h1{font-size:19px;margin:0 0 4px}
    .sub{font-size:12px;color:#6b7280;margin:0 0 16px;line-height:1.6}
    .card{background:#fff;border:1px solid #e2e8e8;border-radius:14px;padding:16px;margin-bottom:14px}
    label{display:block;font-size:12px;font-weight:700;color:#374151;margin:12px 0 4px}
    input[type=text],input[type=password],input[type=date],select,textarea{width:100%;padding:10px 12px;border:1.5px solid #dbe5e5;border-radius:10px;font-size:14px;background:#fff}
    input:focus,select:focus,textarea:focus{outline:none;border-color:#0ABAB5;box-shadow:0 0 0 3px rgba(10,186,181,.14)}
    .hint{font-size:11px;color:#9ca3af;margin-top:4px;line-height:1.5}
    button{cursor:pointer;border:none;border-radius:10px;font-weight:800;transition:transform .12s ease-out}
    button:active{transform:scale(.96)}
    .btn-main{width:100%;padding:13px;background:#0ABAB5;color:#fff;font-size:15px;margin-top:8px}
    .btn-sm{padding:7px 12px;font-size:12px;margin:2px 4px 2px 0}
    .b-claim{background:#0ABAB5;color:#fff}
    .b-done{background:#0e7d79;color:#fff}
    .b-fail{background:#fff;color:#b45309;border:1.5px solid #f3d9a8}
    .b-release{background:#fff;color:#6b7280;border:1.5px solid #d5dede}
    .b-undo{background:#fff;color:#be123c;border:1.5px solid #f5c9d4}
    #status{font-size:13px;font-weight:700;text-align:center;min-height:20px;margin-top:10px}
    .ok{color:#0e7d79}.err{color:#dc2626}
    .gate{padding:10px 14px;border-radius:10px;font-size:13px;font-weight:700;margin-bottom:14px}
    .gate-off{background:#fef3c7;color:#92400e}
    .gate-on{background:#d8f3f2;color:#0e7d79}
    .stats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
    .stat{flex:1;min-width:100px;background:#fff;border:1px solid #e2e8e8;border-radius:12px;padding:10px 12px;text-align:center}
    .stat .n{font-size:22px;font-weight:800;color:#0e7d79}
    .stat .t{font-size:11px;color:#6b7280}
    .intent{border:1px solid #e2e8e8;border-radius:12px;padding:12px;margin-bottom:10px;background:#fff}
    .intent.alert{border-color:#f5b3b3;background:#fff7f7}
    .row1{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
    .oplabel{font-size:15px;font-weight:800}
    .meta{font-size:11.5px;color:#6b7280;margin-top:4px;line-height:1.6}
    .badge{display:inline-block;font-size:11px;font-weight:800;border-radius:999px;padding:2px 10px}
    .st-received{background:#e0f2f1;color:#0e7d79}
    .st-executing{background:#fff7ed;color:#c2410c}
    .st-deferred{background:#eef2ff;color:#4338ca}
    .st-cancel_requested{background:#fdf2f8;color:#be185d}
    .st-done{background:#ecfdf5;color:#047857}
    .st-expired,.st-failed{background:#fef2f2;color:#b91c1c}
    .st-cancelled,.st-superseded{background:#f3f4f6;color:#6b7280}
    .age{font-size:12px;font-weight:800;color:#c2410c}
    .age.over{color:#dc2626}
    .esc{font-size:11px;font-weight:800;color:#dc2626}
    .empty{font-size:13px;color:#9ca3af;text-align:center;padding:18px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <p style="margin:0 0 8px"><a href="/admin" style="font-size:12px;color:#0e7d79;text-decoration:none;font-weight:700">← ダッシュボードに戻る</a></p>
    <h1>📋 定期便の受理台帳</h1>
    <p class="sub">お客様やお電話で承った定期便のご依頼 (スキップ・お届け日変更・一時停止・解約など) を記録し、対応状況を管理する画面です。<br>
    <b>流れ: ① 受理 → ② 着手 (Huckleberry 管理画面で操作する直前に押す) → ③ 完了 or 失敗を記録</b>。完了を記録するまで、お客様には「承りました」までしか伝わっていない前提で扱ってください。</p>

    <div id="gate" class="gate gate-off">状態を確認しています…</div>

    <div class="card">
      <label>スタッフ個人の APIキー</label>
      <input type="password" id="apikey" placeholder="/admin/staff で発行した個人キー" autocomplete="off">
      <p class="hint">共有キーでは操作できません (誰が対応したかを記録するため)。この端末にのみ保存されます。</p>
    </div>

    <div class="stats" id="stats"></div>

    <div class="card">
      <div class="row1"><b style="font-size:14px">対応が必要な依頼</b><button class="btn-sm b-release" id="reload">再読込</button></div>
      <div id="list"><p class="empty">読み込み中…</p></div>
    </div>

    <div class="card">
      <b style="font-size:14px">新しい依頼を受理する (電話・メールで承った場合)</b>
      <label>契約ID (Huckleberry の定期購買ID)</label>
      <input type="text" id="ckey" placeholder="例: 181614444797" autocomplete="off">
      <label>ご依頼の内容</label>
      <select id="cop">
        <option value="skip">次回スキップ</option>
        <option value="date">お届け日の変更</option>
        <option value="pause">一時停止</option>
        <option value="resume">再開</option>
        <option value="cancel">解約</option>
      </select>
      <label>メモ (任意・お客様の氏名や連絡先は書かないでください)</label>
      <input type="text" id="cnote" placeholder="例: 9月分から。希望日は 9/10" autocomplete="off">
      <button class="btn-main" id="accept">受理する</button>
      <div id="status"></div>
    </div>
  </div>
  <script>
    var $ = function(id){ return document.getElementById(id); };
    var KEY = 'lh_admin_apikey';
    $('apikey').value = localStorage.getItem(KEY) || '';
    var ALERT_MIN = 30;

    function setStatus(msg, ok){ var s=$('status'); s.textContent=msg; s.className= ok?'ok':'err'; }
    function headers(){ var k=$('apikey').value.trim(); return { 'Content-Type':'application/json', 'Authorization':'Bearer '+k }; }

    function stateBadge(it){
      var names = { received:'受理済み', executing:'対応中', deferred:'移行窓 (実行保留)', cancel_requested:'取り消し依頼あり', done:'完了', expired:'期限切れ', failed:'失敗', cancelled:'取り消し済み', superseded:'新しい依頼に引き継ぎ' };
      var sp = document.createElement('span');
      sp.className = 'badge st-' + it.state;
      sp.textContent = names[it.state] || it.state;
      return sp;
    }

    function addBtn(box, cls, text, fn){
      var b = document.createElement('button');
      b.className = 'btn-sm ' + cls; b.textContent = text;
      b.addEventListener('click', fn);
      box.appendChild(b);
    }

    function post(path, body, doneMsg){
      fetch(path, { method:'POST', headers: headers(), body: JSON.stringify(body || {}) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if(res.ok && res.j.success){ setStatus(doneMsg, true); load(); }
          else { setStatus(res.j.error || '操作できませんでした', false); load(); }
        })
        .catch(function(e){ setStatus('通信エラー: '+e.message, false); });
    }

    function renderIntent(it){
      var div = document.createElement('div');
      div.className = 'intent' + ((it.claimAlert || it.escalated) ? ' alert' : '');
      var r1 = document.createElement('div'); r1.className = 'row1';
      var left = document.createElement('div');
      var op = document.createElement('span'); op.className = 'oplabel'; op.textContent = it.opLabel; left.appendChild(op);
      left.appendChild(document.createTextNode(' '));
      left.appendChild(stateBadge(it));
      if(it.escalated){ var e = document.createElement('span'); e.className='esc'; e.textContent=' 🚨要対応'; left.appendChild(e); }
      r1.appendChild(left);
      if(it.state === 'executing' && it.claimAgeMinutes !== null){
        var age = document.createElement('span');
        age.className = 'age' + (it.claimAgeMinutes >= ALERT_MIN ? ' over' : '');
        age.textContent = '未解決 ' + it.claimAgeMinutes + '分';
        r1.appendChild(age);
      }
      div.appendChild(r1);

      var meta = document.createElement('div'); meta.className = 'meta';
      var lines = [];
      lines.push('契約: ' + it.contractKey + (it.linked ? ' (LINE連携済み)' : ' (LINE未連携)'));
      if(it.presentedDate) lines.push('対象サイクル: ' + it.presentedDate);
      if(it.deadlineAt) lines.push('受付期限: ' + String(it.deadlineAt).slice(0,10));
      lines.push('受理: ' + String(it.createdAt).slice(0,16).replace('T',' ') + ' (' + (it.requestedBy === 'staff' ? 'スタッフ' : 'お客様') + ')');
      if(it.actorStaffId && it.state === 'executing') lines.push('担当: ' + it.actorStaffId);
      if(it.carryoverCount > 0) lines.push('繰越し ' + it.carryoverCount + ' 回');
      if(it.failReason) lines.push('失敗理由: ' + it.failReason);
      if(it.payload){ try { var p = JSON.parse(it.payload); if(p && p.note) lines.push('メモ: ' + p.note); } catch(e){} }
      meta.textContent = lines.join(' ／ ');
      div.appendChild(meta);

      var btns = document.createElement('div'); btns.style.marginTop = '8px';
      if(it.state === 'received'){
        addBtn(btns, 'b-claim', '着手する', function(){
          if(!window.confirm('「' + it.opLabel + '」(契約 ' + it.contractKey + ') に着手します。\\n\\nこれから Huckleberry 管理画面 (定期購買一覧) で実際の操作を行ってください。完了/失敗を記録するまで、この依頼はあなたの担当のまま残ります。')) return;
          post('/api/admin/sub-intents/' + it.id + '/claim', {}, '着手しました。Huckleberry 管理画面で操作を行い、完了を記録してください');
        });
        addBtn(btns, 'b-undo', '取り消し', function(){
          if(!window.confirm('この依頼を取り消します (お客様のご依頼の取り下げ、または誤登録の削除)。よろしいですか？')) return;
          post('/api/admin/sub-intents/' + it.id + '/undo', {}, '取り消しました');
        });
      } else if(it.state === 'executing'){
        addBtn(btns, 'b-done', '完了を記録', function(){
          if(!window.confirm('Huckleberry 管理画面での「' + it.opLabel + '」の操作は完了しましたか？\\n\\n完了を記録すると、お客様への表示も「完了」になります。実際に操作を終えてから押してください。')) return;
          post('/api/admin/sub-intents/' + it.id + '/done', {}, '完了を記録しました');
        });
        addBtn(btns, 'b-fail', '失敗を記録', function(){
          var reason = window.prompt('失敗の理由を入力してください (お客様への説明の土台になります)。\\n⚠️ お客様の氏名・連絡先は書かないでください (記録は削除できません)。\\n例: 受付期限を過ぎていた / Huckleberry 側でエラー');
          if(!reason) return;
          post('/api/admin/sub-intents/' + it.id + '/fail', { reason: reason }, '失敗を記録しました。お客様へのフォローをお願いします');
        });
        addBtn(btns, 'b-release', '着手を取り下げ', function(){
          if(!window.confirm('着手を取り下げて「受理済み」に戻します。\\n\\n⚠️ Huckleberry 管理画面でまだ何も操作していない場合のみ取り下げてください。操作済みなのに取り下げると、別のスタッフが二重に実行する危険があります。')) return;
          post('/api/admin/sub-intents/' + it.id + '/release', {}, '着手を取り下げました');
        });
      } else if(it.state === 'deferred'){
        addBtn(btns, 'b-undo', '取り消し', function(){
          if(!window.confirm('移行窓で保留中の依頼を取り消します。よろしいですか？')) return;
          post('/api/admin/sub-intents/' + it.id + '/undo', {}, '取り消しました');
        });
      } else if(it.state === 'cancel_requested'){
        // 取り消し依頼の行 (undo_of) が別途一覧にあるのが正常。無い場合 (障害の残留) の復旧口
        addBtn(btns, 'b-claim', '取り消し依頼を確認/再作成', function(){
          post('/api/admin/sub-intents/' + it.id + '/undo', {}, '取り消し依頼を確認しました (一覧の「取り消し」行から対応してください)');
        });
      }
      div.appendChild(btns);
      return div;
    }

    function render(data){
      var g = $('gate');
      if(data.migrationMissing){ g.className = 'gate gate-off'; g.textContent = 'データベース未準備 (migration 076 未適用)。適用後にご利用ください'; }
      else if(data.gateEnabled){ g.className = 'gate gate-on'; g.textContent = '受理レイヤー: 稼働中'; }
      else { g.className = 'gate gate-off'; g.textContent = '受理レイヤー: 停止中 (SUB_INTENT_ENABLED 未投入)。閲覧はできますが、受理や状態の変更はできません'; }

      var st = $('stats'); st.textContent = '';
      var items = [
        { n: data.stats.received, t: '受理済み (未着手)' },
        { n: data.stats.executing, t: '対応中' },
        { n: data.stats.doneLast7d, t: '完了 (7日)' },
        { n: data.stats.failedLast7d + data.stats.expiredLast7d, t: '失敗・期限切れ (7日)' }
      ];
      for(var i=0;i<items.length;i++){
        var d = document.createElement('div'); d.className = 'stat';
        var n = document.createElement('div'); n.className = 'n'; n.textContent = String(items[i].n);
        var t = document.createElement('div'); t.className = 't'; t.textContent = items[i].t;
        d.appendChild(n); d.appendChild(t); st.appendChild(d);
      }

      var list = $('list'); list.textContent = '';
      if(!data.intents.length){
        var p = document.createElement('p'); p.className = 'empty'; p.textContent = '依頼はありません';
        list.appendChild(p);
        return;
      }
      for(var j=0;j<data.intents.length;j++){ list.appendChild(renderIntent(data.intents[j])); }
    }

    function load(){
      var k=$('apikey').value.trim(); if(!k){ setStatus('APIキーを入力してください', false); return; }
      fetch('/api/admin/sub-intents', { headers: headers() })
        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(j){ localStorage.setItem(KEY,k); render(j.data); })
        .catch(function(e){ setStatus('読み込み失敗: '+e.message+' (owner/admin の個人キーが必要です)', false); });
    }

    $('apikey').addEventListener('change', load);
    $('reload').addEventListener('click', load);
    if($('apikey').value) load();
    // §1-2: 未解決時間の常時可視化 — 60 秒ごとに再取得して age を進める
    setInterval(function(){ if($('apikey').value.trim()) load(); }, 60000);

    $('accept').addEventListener('click', function(){
      var ckey = $('ckey').value.trim();
      var op = $('cop').value;
      if(!ckey){ setStatus('契約IDを入力してください', false); return; }
      var opNames = { skip:'次回スキップ', date:'お届け日の変更', pause:'一時停止', resume:'再開', cancel:'解約' };
      if(!window.confirm('契約 ' + ckey + ' の「' + (opNames[op]||op) + '」を受理します。\\n\\n受理すると台帳に記録され、担当スタッフが Huckleberry 管理画面で代行します。よろしいですか？')) return;
      $('accept').disabled = true; setStatus('受理しています…', true);
      fetch('/api/admin/sub-intents', { method:'POST', headers: headers(), body: JSON.stringify({ contractKey: ckey, op: op, note: $('cnote').value }) })
        .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
        .then(function(res){
          if(res.ok && res.j.success){
            if(res.j.data.status === 'duplicate'){ setStatus('この内容は既に受理済みです (二重登録は作られません)', true); }
            else { setStatus('受理しました', true); }
            $('ckey').value=''; $('cnote').value=''; load();
          } else { setStatus(res.j.error || '受理できませんでした', false); }
        })
        .catch(function(e){ setStatus('通信エラー: '+e.message, false); })
        .finally(function(){ $('accept').disabled = false; });
    });
  </script>
</body>
</html>`;
