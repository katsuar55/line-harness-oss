import { extractFlexAltText } from '../utils/flex-alt-text.js';

/**
 * SSRF 対策: URL が安全な外部 HTTPS であることを検証
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    // プライベート/ループバック/メタデータ IP を拒否
    if (
      host === 'localhost' ||
      host === '[::1]' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^0\./.test(host) ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * イベントバス — システム内イベントの発火と処理
 *
 * イベント発生時に以下を実行:
 * 1. アクティブな送信Webhookへ通知
 * 2. スコアリングルール適用
 * 3. 自動化ルール(IF-THEN)実行
 * 4. 通知ルール処理
 */

import {
  getActiveOutgoingWebhooksByEvent,
  applyScoring,
  getActiveAutomationsByEvent,
  createAutomationLog,
  getActiveNotificationRulesByEvent,
  createNotification,
  addTagToFriend,
  removeTagFromFriend,
  enrollFriendInScenario,
  jstNow,
  getFriendScore,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { sendAdConversions } from './ad-conversion.js';
import { executeSendEmailAction, type SendEmailActionParams } from './send-email-action.js';
import type { EmailDispatchConfig } from './email-dispatch-config.js';

export interface EventPayload {
  friendId?: string;
  eventData?: Record<string, unknown>;
  conversionEventName?: string;
  conversionValue?: number;
  replyToken?: string;
}

/**
 * Fire an event and run all registered handlers.
 *
 * Execution is split into two sequential phases so that score_threshold
 * conditions in automation rules see the score already updated by this event:
 *
 *   Phase 1 (concurrent): outgoing webhooks + scoring
 *   Phase 2 (concurrent): automations + notifications, with currentScore injected
 */
export async function fireEvent(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  /**
   * Round 4 PR-6: 'send_email' automation action 用。null/undefined なら send_email は skip。
   * `buildEmailDispatchConfig(env)` で組み立てる (services/email-dispatch-config.ts)。
   */
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  // Phase 1: fire webhooks, apply scoring rules, and ad conversion postback concurrently.
  const phase1: Promise<unknown>[] = [
    fireOutgoingWebhooks(db, eventType, payload),
    processScoring(db, eventType, payload),
    processBadgeEvaluation(db, eventType, payload),
  ];
  if (payload.friendId && payload.conversionEventName) {
    phase1.push(
      sendAdConversions(db, payload.friendId, payload.conversionEventName, payload.conversionValue),
    );
  }
  await Promise.allSettled(phase1);

  // Build an enriched payload with the freshly-updated score.
  const enrichedPayload: EventPayload = payload.friendId
    ? {
        ...payload,
        eventData: {
          ...payload.eventData,
          currentScore: await getFriendScore(db, payload.friendId),
        },
      }
    : payload;

  // Phase 2: evaluate automations and create notifications concurrently.
  await Promise.allSettled([
    processAutomations(db, eventType, enrichedPayload, lineAccessToken, lineAccountId, emailConfig),
    processNotifications(db, eventType, enrichedPayload, lineAccountId),
  ]);
}

/** 送信Webhookへの通知 */
async function fireOutgoingWebhooks(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  try {
    const webhooks = await getActiveOutgoingWebhooksByEvent(db, eventType);
    for (const wh of webhooks) {
      try {
        const body = JSON.stringify({
          event: eventType,
          timestamp: jstNow(),
          data: payload,
        });

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };

        // HMAC署名（シークレットがある場合）
        if (wh.secret) {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(wh.secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
          const hexSignature = Array.from(new Uint8Array(signature))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          headers['X-Webhook-Signature'] = hexSignature;
        }

        if (!isSafeUrl(wh.url)) {
          console.warn(`Webhook ${wh.id} blocked: unsafe URL ${wh.url}`);
        } else {
          await fetch(wh.url, { method: 'POST', headers, body });
        }
      } catch (err) {
        console.error(`送信Webhook ${wh.id} への通知失敗:`, err);
      }
    }
  } catch (err) {
    console.error('fireOutgoingWebhooks error:', err);
  }
}

/** Phase 2: バッジ判定 (intake_log / cv_fire / referral_completed) */
async function processBadgeEvaluation(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  if (!payload.friendId) return;
  try {
    const { evaluateBadgesForEvent } = await import('./badge-evaluator.js');
    await evaluateBadgesForEvent(db, eventType, {
      friendId: payload.friendId,
      eventData: payload.eventData,
    });
  } catch (err) {
    console.error('processBadgeEvaluation error:', err);
  }
}

/** スコアリングルール適用 */
async function processScoring(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
): Promise<void> {
  if (!payload.friendId) return;
  try {
    await applyScoring(db, payload.friendId, eventType);
  } catch (err) {
    console.error('processScoring error:', err);
  }
}

/** 自動化ルール(IF-THEN)実行 (= export は test 用) */
export async function processAutomations(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccessToken?: string,
  lineAccountId?: string | null,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  try {
    const allAutomations = await getActiveAutomationsByEvent(db, eventType);
    // Filter by account: match this account's automations + unassigned (backward compat)
    const automations = allAutomations.filter(
      (a) => !a.line_account_id || !lineAccountId || a.line_account_id === lineAccountId,
    );

    for (const automation of automations) {
      // per-row guard: 1 行の corrupt JSON (conditions/actions parse) や予期せぬ失敗が、
      // 同 event の **以降の automation を止めない** よう各行を隔離する (= 旧実装は parse が
      // loop 外 catch に飛び loop 全体が中断していた)。
      try {
        const conditions = JSON.parse(automation.conditions) as Record<string, unknown>;
        const actions = JSON.parse(automation.actions) as Array<{ type: string; params: Record<string, string> }>;

        // 条件チェック（簡易版: 条件が空なら常にマッチ）
        if (!matchConditions(conditions, payload)) continue;

        const results: Array<{ action: string; success: boolean; error?: string }> = [];

        for (const action of actions) {
          try {
            await executeAction(db, action, payload, lineAccessToken, emailConfig);
            results.push({ action: action.type, success: true });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            results.push({ action: action.type, success: false, error: errorMsg });
          }
        }

        const allSuccess = results.every((r) => r.success);
        const anySuccess = results.some((r) => r.success);

        await createAutomationLog(db, {
          automationId: automation.id,
          friendId: payload.friendId,
          eventData: JSON.stringify(payload.eventData ?? {}),
          actionsResult: JSON.stringify(results),
          status: allSuccess ? 'success' : anySuccess ? 'partial' : 'failed',
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`processAutomations: automation ${automation.id} failed:`, errorMsg);
        // 可観測性: 壊れた行も failed log を best-effort で残す (= silent skip しない)。
        try {
          await createAutomationLog(db, {
            automationId: automation.id,
            friendId: payload.friendId,
            eventData: JSON.stringify(payload.eventData ?? {}),
            actionsResult: JSON.stringify([{ action: 'parse', success: false, error: errorMsg }]),
            status: 'failed',
          });
        } catch (logErr) {
          console.error(
            `processAutomations: failed to log automation ${automation.id} failure:`,
            logErr instanceof Error ? logErr.message : String(logErr),
          );
        }
      }
    }
  } catch (err) {
    console.error('processAutomations error:', err);
  }
}

/** 条件マッチング */
function matchConditions(
  conditions: Record<string, unknown>,
  payload: EventPayload,
): boolean {
  // 条件が空 → 常にマッチ
  if (Object.keys(conditions).length === 0) return true;

  // score_threshold チェック (fail-safe: score 不明なイベントでは閾値条件は不成立扱い)。
  // 従来は currentScore=undefined で素通り→ score 無関係イベントでも score 条件付き
  // automation が発火していた。 score が取れない限りマッチさせない。
  if (conditions.score_threshold !== undefined) {
    const currentScore = payload.eventData?.currentScore as number | undefined;
    if (currentScore === undefined || currentScore < (conditions.score_threshold as number)) {
      return false;
    }
  }

  // tag_id チェック
  if (conditions.tag_id !== undefined && payload.eventData) {
    if (payload.eventData.tagId !== conditions.tag_id) return false;
  }

  // keyword チェック（message_received イベント用）
  if (conditions.keyword !== undefined && payload.eventData) {
    const text = payload.eventData.text as string | undefined;
    if (!text || !text.includes(conditions.keyword as string)) return false;
  }

  return true;
}

/** アクション実行 */
async function executeAction(
  db: D1Database,
  action: { type: string; params: Record<string, string> },
  payload: EventPayload,
  lineAccessToken?: string,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  const friendId = payload.friendId;
  if (!friendId && action.type !== 'send_webhook') {
    throw new Error('friendId is required for this action');
  }

  switch (action.type) {
    case 'add_tag':
      await addTagToFriend(db, friendId!, action.params.tagId);
      break;

    case 'remove_tag':
      await removeTagFromFriend(db, friendId!, action.params.tagId);
      break;

    case 'start_scenario':
      await enrollFriendInScenario(db, friendId!, action.params.scenarioId);
      break;

    case 'send_message': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      const msgType = action.params.messageType || 'text';
      let msg: Message;
      if (msgType === 'flex') {
        const contents = JSON.parse(action.params.content);
        msg = { type: 'flex', altText: action.params.altText || extractFlexAltText(contents), contents };
      } else {
        msg = { type: 'text', text: action.params.content };
      }
      // Prefer replyMessage (free) when replyToken is available
      if (payload.replyToken) {
        try {
          await lineClient.replyMessage(payload.replyToken, [msg]);
          // replyToken is single-use, clear it so subsequent actions fall back to push
          payload.replyToken = undefined;
        } catch (err: unknown) {
          // Token-consumed/expired errors contain "400" or "Invalid reply token" in the message.
          // Fall back to push only for those; re-throw other errors (5xx, validation).
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTokenError = errMsg.includes('400') || errMsg.includes('Invalid reply token');
          if (isTokenError) {
            await lineClient.pushMessage(friend.line_user_id, [msg]);
          } else {
            throw err;
          }
        }
      } else {
        await lineClient.pushMessage(friend.line_user_id, [msg]);
      }
      break;
    }

    case 'send_webhook': {
      const url = action.params.url;
      if (url && isSafeUrl(url)) {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ friendId, ...payload.eventData }),
        });
      } else if (url) {
        console.warn(`Automation send_webhook blocked: unsafe URL ${url}`);
      }
      break;
    }

    case 'switch_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.linkRichMenuToUser(friend.line_user_id, action.params.richMenuId);
      break;
    }

    case 'remove_rich_menu': {
      if (!lineAccessToken || !friendId) break;
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ line_user_id: string }>();
      if (!friend) break;
      const lineClient = new LineClient(lineAccessToken);
      await lineClient.unlinkRichMenuFromUser(friend.line_user_id);
      break;
    }

    case 'set_metadata': {
      if (!friendId) break;
      const existing = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const current = JSON.parse(existing?.metadata || '{}') as Record<string, unknown>;
      const patch = JSON.parse(action.params.data || '{}') as Record<string, unknown>;
      const merged = { ...current, ...patch };
      await db
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(merged), jstNow(), friendId)
        .run();
      break;
    }

    case 'send_email': {
      // Round 4 PR-6: ChannelDispatcher 経由でメール送信
      // emailConfig 未設定 (= RESEND_API_KEY 等の env 不足) なら無音 skip。
      if (!friendId || !emailConfig) break;
      // Phase 5α-8: payload.eventData を template の {{var}} 用に passthrough。
      // caller (Shopify webhook 等) が事前に template-friendly な key 名 ({{order_number}} 等)
      // で eventData を作る責任を持つ (key 名 normalize は scope 外)。
      const eventVariables: Record<string, string> = {};
      if (payload.eventData) {
        for (const [k, v] of Object.entries(payload.eventData)) {
          if (v !== null && v !== undefined) {
            eventVariables[k] = typeof v === 'string' ? v : String(v);
          }
        }
      }
      const params: SendEmailActionParams = {
        templateId: action.params.templateId || undefined,
        subject: action.params.subject || undefined,
        htmlContent: action.params.htmlContent || undefined,
        textContent: action.params.textContent || undefined,
        preheader: action.params.preheader || undefined,
        category:
          action.params.category === 'transactional' ? 'transactional' : 'marketing',
        eventVariables,
      };
      const r = await executeSendEmailAction(
        { db, friendId, emailConfig },
        params,
      );
      // skipped/failed は throw しない (= 他 action を巻き込まない)。
      // 結果は automation_logs の results 配列で success=true として残るが、
      // KPI は email_messages_log で別途集計。
      if (r.status === 'failed') {
        console.warn(
          `[event-bus] send_email failed for friend ${friendId}: ${r.reason}`,
        );
      }
      break;
    }

    default:
      console.warn(`未知のアクションタイプ: ${action.type}`);
  }
}

/** 通知ルール処理 */
async function processNotifications(
  db: D1Database,
  eventType: string,
  payload: EventPayload,
  lineAccountId?: string | null,
): Promise<void> {
  try {
    const allRules = await getActiveNotificationRulesByEvent(db, eventType);
    const rules = allRules.filter(
      (r) => !r.line_account_id || !lineAccountId || r.line_account_id === lineAccountId,
    );

    for (const rule of rules) {
      // per-rule 隔離: 1 件の壊れた channels JSON で以降の rule が全 skip されるのを防ぐ
      // (event-bus per-row 隔離 #102 と同方針)。
      try {
        let channels: string[] = JSON.parse(rule.channels);
        // Guard against double-encoded JSON strings (e.g. "\"[\\\"webhook\\\"]\"")
        if (typeof channels === 'string') channels = JSON.parse(channels);

        for (const channel of channels) {
          await createNotification(db, {
            ruleId: rule.id,
            eventType,
            title: `${rule.name}: ${eventType}`,
            body: JSON.stringify(payload),
            channel,
            metadata: JSON.stringify(payload.eventData ?? {}),
          });

          // Webhook通知チャネルの場合は即時配信
          if (channel === 'webhook') {
            // 送信Webhookと統合（既にfireOutgoingWebhooksで処理済み）
          }
          // email チャネルの場合はSendGrid等で送信（将来実装）
          // dashboard チャネルの場合はDB記録のみ（上記createNotificationで完了）
        }
      } catch (err) {
        console.error(`processNotifications: rule ${rule.id} skipped:`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.error('processNotifications error:', err);
  }
}
