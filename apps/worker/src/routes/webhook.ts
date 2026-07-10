import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage, ImageEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  getLineAccountByBotUserId,
  setLineAccountBotUserId,
  setFriendMetadataField,
  insertFoodLog,
  setFoodLogImageUrl,
  updateFoodLogAnalysis,
  markFoodLogFailed,
  jstNow,
  recordWebhookDelivery,
} from '@line-crm/db';
import {
  BIRTHDAY_METADATA_KEY,
  buildBirthdayThanksText,
  parseBirthdayMonthPostback,
} from '../services/birthday-collection.js';
import { fireEvent } from '../services/event-bus.js';
import { buildEmailDispatchConfig } from '../services/email-dispatch-config.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { generateAiResponse } from '../services/ai-response.js';
import { analyzeFoodImage, FoodAnalyzerError } from '../services/food-analyzer.js';
import { downloadLineContent, LineContentError } from '../services/line-content.js';
import { createAIRouterFromEnv } from '../services/ai-router-factory.js';
import { issueCouponForFriend } from '../services/shopify-coupon-issuer.js';
import { auditSystem } from '../services/audit-logger.js';
import {
  isWelcomePostback,
  handleWelcomeIntroStep,
  handleWelcomeBirthday,
  handleWelcomeAgeGroup,
} from '../services/welcome-postback.js';
import {
  isMonthlyBroadcastPostback,
  handleMonthlyDetail,
} from '../services/monthly-broadcast-postback.js';
import { handleRestockPostback } from '../services/restock.js';
import {
  isQuickQuizPostback,
  isQuickQuizStartPostback,
  handleQuickQuizStart,
  handleQuickQuizAnswer,
} from '../services/quick-quiz.js';
import type { Env } from '../index.js';

import { buildAiMessage } from '../services/ai-message-builder.js';
// ULTRATHINK fix (2026-05-26): deterministic keyword routing (= Plan A-1/A-3/A-6 safety net)
import { detectIntent, buildMessagesForIntentAsync } from '../services/intent-router.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account signature verification:
  // 1. Use "destination" (bot user ID) from webhook body for O(1) account lookup
  // 2. Fall back to env-level secret for single-account / unconfigured setups
  // 3. Legacy fallback: iterate all accounts if destination lookup misses
  //    (handles accounts that haven't had bot_user_id populated yet)
  const destination = body.destination;
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if (destination) {
    // Fast path: direct lookup by bot_user_id (indexed, O(1))
    const accountByDest = await getLineAccountByBotUserId(db, destination);
    if (accountByDest) {
      // Verify signature with the matched account's secret
      const isValid = await verifySignature(accountByDest.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = accountByDest.channel_secret;
        channelAccessToken = accountByDest.channel_access_token;
        matchedAccountId = accountByDest.id;
      } else {
        // Signature mismatch with the account we found by destination — reject immediately.
        // This prevents an attacker from spoofing the destination field.
        console.error('Signature mismatch for destination:', destination);
        return c.json({ status: 'ok' }, 200);
      }
    } else {
      // Slow path: bot_user_id not yet populated in DB. Iterate accounts to find a match,
      // then auto-populate bot_user_id for future O(1) lookups.
      const accounts = await getLineAccounts(db);
      for (const account of accounts) {
        if (!account.is_active) continue;
        const isValid = await verifySignature(account.channel_secret, rawBody, signature);
        if (isValid) {
          channelSecret = account.channel_secret;
          channelAccessToken = account.channel_access_token;
          matchedAccountId = account.id;
          // Auto-populate bot_user_id so future lookups are O(1)
          if (!account.bot_user_id) {
            c.executionCtx.waitUntil(
              setLineAccountBotUserId(db, account.id, destination),
            );
          }
          break;
        }
      }
    }
  }

  // Final signature verification with the resolved secret
  // (skipped if we already verified against a DB account above)
  if (!matchedAccountId) {
    const valid = await verifySignature(channelSecret, rawBody, signature);
    if (!valid) {
      console.error('Invalid LINE signature');
      return c.json({ status: 'ok' }, 200);
    }
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env, c.executionCtx);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  env?: Env['Bindings'],
  /** ctx?: バックグラウンド処理 (画像解析等) を後続イベントのブロックなしに走らせるため */
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
  // ③ webhook event dedup (2026-06-26): LINE の再送による二重 fireEvent
  //   (automation 発火 / スコア加算 / クーポン発行 / welcome 配信) を防ぐ。
  //   event.webhookEventId (= LINE が各 event に付与する一意 ID) を冪等 key に記録し、
  //   初見の event だけ処理する。 全 event 種別の分岐より前に置くことで全 fireEvent 経路をカバー。
  //   fail-open: webhookEventId 欠落 or DB エラー (= migration 066 未適用含む) 時は処理続行
  //   (= 正当な event を dedup 障害で落とさない)。
  const webhookEventId = event.webhookEventId;
  if (webhookEventId) {
    try {
      const isNew = await recordWebhookDelivery(db, webhookEventId, new Date().toISOString());
      if (!isNew) {
        console.info('[webhook] duplicate event skipped:', webhookEventId);
        return;
      }
    } catch (err) {
      console.warn(
        '[webhook] dedup check failed (continuing fail-open):',
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    // Set line_account_id for multi-account tracking
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ? WHERE id = ? AND line_account_id IS NULL')
        .bind(lineAccountId, friend.id).run();
    }

    // 5β-1d-2b: LINE 友だち追加時 Shopify 動的クーポン発行 (1 friend 1 回限り、 失敗時は null fallback)
    // env が無い (test 等) / Shopify 未設定 / API 失敗時は null → message にクーポン文言が出ない (safe)
    // 5β-1d-2f: caller 側で throw 検知時の audit_logs 永続化追加 (= 内部 audit 到達しない場合用)
    let lineFriendCouponCode: string | null = null;
    if (env) {
      try {
        const couponResult = await issueCouponForFriend(db, env, {
          friendId: friend.id,
          lineAccountId,
          // 有効期限 7 日: 友だち追加特典であり、 かつ友だち紹介 (referred が 7 日以内に利用) の起点。
          //   referred の ¥500 = この welcome クーポン (別途の紹介クーポンは発行しない = 二重¥500 回避)。
          validDays: 7,
        });
        lineFriendCouponCode = couponResult?.code ?? null;
      } catch (err) {
        // safe fallback: coupon なしで message を送る (caller の処理を阻害しない)
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          '[webhook] issueCouponForFriend threw (continuing without coupon):',
          errMsg,
        );
        await auditSystem(db, {
          action: 'line_friend_coupon.issue_threw',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'failure',
          errorMessage: errMsg,
          metadata: {
            stack: err instanceof Error ? err.stack?.slice(0, 1000) ?? null : null,
          },
        });
      }
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          const existing = await db
            .prepare(`SELECT id FROM friend_scenarios WHERE friend_id = ? AND scenario_id = ?`)
            .bind(friend.id, scenario.id)
            .first<{ id: string }>();
          // H6 (2026-05-23): 既存 enrollment 検知 = silent skip path、 audit_log を残す
          //   LP リハーサル時に「リフォローしても何も起きない」 と運用側が困惑したため。
          //   `action='scenario.enrollment_skipped_already_enrolled'` で admin /audit-logs で
          //   filter 可能。 既存 block 構造は維持 (= `if (!existing)` redundant 化はあえて許容)。
          if (existing) {
            await auditSystem(db, {
              action: 'scenario.enrollment_skipped_already_enrolled',
              actorType: 'webhook',
              targetType: 'friend_scenarios',
              targetId: existing.id,
              lineAccountId,
              result: 'success',
              metadata: { friendId: friend.id, scenarioId: scenario.id, stage: 'idempotent_skip' },
            });
          }
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const expandedContent = expandVariables(firstStep.message_content, {
                  id: friend.id,
                  display_name: friend.display_name,
                  user_id: friend.user_id,
                  line_friend_coupon_code: lineFriendCouponCode,
                });
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.info(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
          }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // デフォルト朝リマインド自動設定（08:00、有効状態）
    try {
      const existingReminder = await db
        .prepare('SELECT id FROM intake_reminders WHERE friend_id = ?')
        .bind(friend.id)
        .first<{ id: string }>();
      if (!existingReminder) {
        await db
          .prepare(
            `INSERT INTO intake_reminders (id, friend_id, reminder_time, timezone, reminder_type, is_active, created_at, updated_at)
             VALUES (?, ?, '08:00', 'Asia/Tokyo', 'morning', 1, ?, ?)`,
          )
          .bind(crypto.randomUUID(), friend.id, jstNow(), jstNow())
          .run();
      }
    } catch (err) {
      console.error('Failed to set default reminder for', friend.id, err);
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(
      db,
      'friend_add',
      { friendId: friend.id, eventData: { displayName: friend.display_name } },
      lineAccessToken,
      lineAccountId,
      env ? buildEmailDispatchConfig(env) : null,
    );
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // ── Postback イベント処理 ──
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const data = (event as { postback?: { data?: string } }).postback?.data ?? '';

    // Phase 1 ULTRATHINK v3 (2026-05-24): welcome scenario の postback chain
    // `welcome_intro_step` / `welcome_birthday:N` / `welcome_age_group:X` を early dispatch
    // (= 既存 URLSearchParams ベースの `action=birthday_month` 等とは別系統)
    // **全 reply API 化**: postback event の replyToken を全 handler に渡し、 push を一切使わない。
    // 年代 tap 後は 1 reply で 3 message 同時 (= ありがとう + 商品比較 + マイクーポン) でコスト 0 通。
    if (isWelcomePostback(data)) {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;
      try {
        if (data === 'welcome_intro_step') {
          await handleWelcomeIntroStep(db, lineClient, friend.id, event.replyToken, lineAccountId);
        } else if (data.startsWith('welcome_birthday:')) {
          await handleWelcomeBirthday(db, lineClient, friend.id, event.replyToken, lineAccountId, data);
        } else if (data.startsWith('welcome_age_group:')) {
          await handleWelcomeAgeGroup(
            db,
            lineClient,
            { id: friend.id, display_name: friend.display_name },
            lineAccountId,
            event.replyToken,
            data,
          );
        }
      } catch (err) {
        console.error('[webhook] welcome postback failed:', err);
        await auditSystem(db, {
          action: 'welcome_postback.handler_threw',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'failure',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          metadata: { postbackData: data.slice(0, 200) },
        });
      }
      return;
    }

    // Phase 2.1 (2026-05-24): 月 1 通信 (= 年 12 イベント broadcast) の「詳しく見る ▶」 postback chain
    // `monthly_detail:N` (N=1-12) → reply で当該月の詳細 5 message 同時送信、 push 0 通追加
    if (isMonthlyBroadcastPostback(data)) {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;
      try {
        await handleMonthlyDetail(
          db,
          lineClient,
          { id: friend.id, display_name: friend.display_name },
          lineAccountId,
          event.replyToken,
          data,
        );
      } catch (err) {
        console.error('[webhook] monthly broadcast postback failed:', err);
        await auditSystem(db, {
          action: 'monthly_postback.handler_threw',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'failure',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          metadata: { postbackData: data.slice(0, 200) },
        });
      }
      return;
    }

    // Plan A-3 (2026-05-24): LINE chat 内 5 質問 quick diagnose の postback chain
    // `quick_quiz:start` → Q1 reply、 `quick_quiz:a:XXXX` → 次質問 or 結果 reply
    if (isQuickQuizPostback(data)) {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;
      try {
        if (isQuickQuizStartPostback(data)) {
          await handleQuickQuizStart(db, lineClient, friend.id, event.replyToken, lineAccountId);
        } else {
          await handleQuickQuizAnswer(db, lineClient, friend.id, event.replyToken, lineAccountId, data);
        }
      } catch (err) {
        console.error('[webhook] quick_quiz postback failed:', err);
        await auditSystem(db, {
          action: 'quick_quiz.handler_threw',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'failure',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          metadata: { postbackData: data.slice(0, 200) },
        });
      }
      return;
    }

    const params = new URLSearchParams(data);
    const action = params.get('action');

    // 誕生月収集 (DMM 解約前のデータ救出シナリオ)
    if (action === 'birthday_month') {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;

      const month = parseBirthdayMonthPostback(data);
      if (month === null) {
        console.error('Invalid birthday_month postback:', data);
        return;
      }

      try {
        await setFriendMetadataField(
          db,
          friend.id,
          BIRTHDAY_METADATA_KEY,
          String(month),
        );
        await lineClient.replyMessage(event.replyToken, [
          buildMessage('text', buildBirthdayThanksText(month)),
        ]);
      } catch (err) {
        console.error('Birthday month postback error:', err);
      }
      return;
    }

    // 再入荷お知らせ登録 (Task#3): 商品カードの「🔔 再入荷したらお知らせ」postback
    if (action === 'restock_request') {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;
      try {
        const result = await handleRestockPostback(
          db,
          lineClient,
          { id: friend.id, display_name: friend.display_name },
          event.replyToken,
          params,
        );
        await auditSystem(db, {
          action: 'restock_request.postback',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'success',
          metadata: { outcome: result.outcome, postbackData: data.slice(0, 200) },
        });
      } catch (err) {
        console.error('[webhook] restock postback failed:', err);
        await auditSystem(db, {
          action: 'restock_request.handler_threw',
          actorType: 'webhook',
          targetType: 'friend',
          targetId: friend.id,
          lineAccountId,
          result: 'failure',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
          metadata: { postbackData: data.slice(0, 200) },
        });
      }
      return;
    }

    if (action === 'daily_tip') {
      const friend = await getFriendByLineUserId(db, userId);
      if (!friend) return;

      try {
        const { getTodayTip } = await import('@line-crm/db');
        const tip = await getTodayTip(db);

        if (tip) {
          const tipFlex = {
            type: 'bubble',
            size: 'kilo',
            header: {
              type: 'box', layout: 'horizontal',
              backgroundColor: '#06C755', paddingAll: '12px',
              contents: [
                { type: 'text', text: '\u{1F331}', size: 'sm', flex: 0 },
                { type: 'text', text: '\u4eca\u65e5\u306e\u30d2\u30f3\u30c8',
                  size: 'xs', color: '#ffffff', weight: 'bold',
                  gravity: 'center', margin: 'sm' },
                { type: 'filler' },
                { type: 'text', text: tip.category || '',
                  size: 'xxs', color: '#d1fae5', gravity: 'center' },
              ],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
              contents: [
                { type: 'text', text: tip.title, weight: 'bold', size: 'md',
                  color: '#1e293b', wrap: true },
                { type: 'text', text: tip.content, size: 'sm',
                  color: '#475569', wrap: true },
              ],
            },
          };
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify(tipFlex)),
          ]);
        } else {
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('text', '\u4eca\u65e5\u306e\u30d2\u30f3\u30c8\u306f\u307e\u3060\u767b\u9332\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002\u307e\u305f\u660e\u65e5\u30c1\u30a7\u30c3\u30af\u3057\u3066\u304f\u3060\u3055\u3044\u306d\uff01'),
          ]);
        }
      } catch (err) {
        console.error('Daily tip postback error:', err);
        // reply token 未消費なら定型文で応答 (= 無言で落とさない)。
        try {
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('text', 'すみません、今はヒントをお届けできませんでした。またあとでお試しください🙏'),
          ]);
        } catch {
          // reply token が既に消費/失効 — これ以上はできることがないので諦める
        }
      }
      return;
    }

    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${(friend.display_name || '').replace(/[\x00-\x1f]/g, '').slice(0, 50)}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(env?.LIFF_URL ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${env.LIFF_URL}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC LIMIT 100`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC LIMIT 100`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const expandedContent = expandVariables(rule.response_content, friend as { id: string; display_name: string | null; user_id: string | null }, workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
          // replyToken may still be unused if replyMessage threw before LINE accepted it
        }

        matched = true;
        break;
      }
    }

    // ─── AI コスト・DoS 防御ガード（Layer 1.5） ──────────────────────────
    // 1) ノイズフィルタ: 「？」「a」等の短文は AI に渡さず定型で処理
    // 2) バーストクールダウン: 同じ friend_id が 30秒以内に 5件超 → AI 呼ばない
    // 3) 日次上限: 1 friend_id あたり AI 応答 100件/日 超 → 上限通知
    // 悪意あるユーザーの連投で AI コストが爆発しないように保険。
    const BURST_THRESHOLD = 5;      // 30秒あたりの閾値
    const BURST_WINDOW_SEC = 30;
    const DAILY_AI_CAP = 100;       // 1 friend / 1 JST日 あたりの AI 応答上限

    // Capture narrowed values into stable locals so the helper closure has concrete types
    const guardReplyToken: string = event.replyToken;
    const guardFriendId: string = friend.id;

    async function trySendGuard(text: string, reason: string): Promise<void> {
      try {
        await lineClient.replyMessage(guardReplyToken, [buildMessage('text', text)]);
        replyTokenConsumed = true;
      } catch (err) {
        console.error(`guard-reply failed (${reason}):`, err);
      }
      matched = true;
      // ログに残す（管理画面で [guard:*] プレフィックスで見える）
      try {
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', ?)`,
          )
          .bind(crypto.randomUUID(), guardFriendId, `[guard:${reason}] ${text}`, jstNow())
          .run();
      } catch { /* best-effort log */ }
    }

    if (!matched && !replyTokenConsumed && env?.AI) {
      // Guard 1: ノイズフィルタ — 短すぎ/記号のみ/同一文字の連打 など
      const trimmed = incomingText.trim();
      const isOnlySymbols = /^[\s\?？!！。、.,…・ー~〜"'`]+$/.test(trimmed);
      const isSingleCharRepeat = /^(.)\1{0,3}$/s.test(trimmed);
      const isNoise = trimmed.length === 0 || trimmed.length <= 1 || isOnlySymbols || isSingleCharRepeat;
      if (isNoise) {
        await trySendGuard(
          '何かお手伝いできることはありますか？😊 naturism の商品や使い方などお気軽にご質問ください。「Q&A お問い合わせ」メニューもご利用いただけます。',
          'noise',
        );
      }
    }

    if (!matched && !replyTokenConsumed && env?.AI) {
      // Guard 2: バーストクールダウン — 直近 BURST_WINDOW_SEC 秒の incoming 件数
      // (SQL injection 防御層: 数値は placeholder 経由で bind し、テンプレ埋め込みを避ける)
      try {
        const burst = await db
          .prepare(
            `SELECT COUNT(*) as cnt FROM messages_log
             WHERE friend_id = ? AND direction = 'incoming'
             AND datetime(created_at) > datetime('now', ?)`,
          )
          .bind(guardFriendId, `-${BURST_WINDOW_SEC} seconds`)
          .first<{ cnt: number }>();
        if ((burst?.cnt ?? 0) >= BURST_THRESHOLD) {
          await trySendGuard(
            '少しお時間をいただいております。数秒後にもう一度お試しください🙏',
            'burst',
          );
        }
      } catch (err) {
        console.error('burst guard query failed:', err);
      }
    }

    if (!matched && !replyTokenConsumed && env?.AI) {
      // Guard 3: 日次 AI 応答上限 — [ai:...] プレフィックス付きの outgoing を当日分カウント
      try {
        const jstTodayPrefix = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        const daily = await db
          .prepare(
            `SELECT COUNT(*) as cnt FROM messages_log
             WHERE friend_id = ? AND direction = 'outgoing'
             AND content LIKE '[ai:%' AND created_at LIKE ?`,
          )
          .bind(friend.id, `${jstTodayPrefix}%`)
          .first<{ cnt: number }>();
        if ((daily?.cnt ?? 0) >= DAILY_AI_CAP) {
          await trySendGuard(
            '本日の AI 応答の上限に達しました。詳しいご質問はカスタマーサポート (info@kenkoex.com / 03-6411-5513) までご連絡ください。明日また自動応答をご利用いただけます。',
            'daily-cap',
          );
        }
      } catch (err) {
        console.error('daily-cap guard query failed:', err);
      }
    }

    // Layer 1.5: deterministic intent routing (= 5/26 ULTRATHINK fix)
    //   AI に prefix を任せると Llama が rule を無視するため、 重要 intent は keyword で確実に
    //   - quiz_invite: 「私におすすめ」 等 → buildQuickQuizInviteMessage flex
    //   - price_table: 「価格教えて」 等 → buildPriceTableMessage grid flex
    //   - my_rank: 「会員ランク」 「マイランク」 等 → マイランク LIFF (`${liffUrl}#rank`) 誘導 text
    //   - feature_unavailable: 「紹介プログラム」 等 未実装機能 → 「近日リリース」 固定 text
    //   matched 後は Layer 2 (= AI) を skip
    if (!matched && !replyTokenConsumed) {
      const intentResult = detectIntent(incomingText);
      if (intentResult) {
        // deterministic intent が確定した時点で matched=true (= reply 失敗でも Layer2 AI に
        // 上書きさせない)。 auto_replies パス (matched を try 外で立てる) と対称にする。
        matched = true;
        try {
          // PR 2 (2026-05-26): async build に切替 (= my_coupon の D1 SELECT 等で fact 取得可)
          // #10-1 (2026-06-12): liffUrl 注入 (= my_rank がマイランク LIFF `${liffUrl}#rank` へ誘導)
          const messages = await buildMessagesForIntentAsync(intentResult.intent, {
            db,
            friendId: friend.id,
            liffUrl: env?.LIFF_URL,
          });
          await lineClient.replyMessage(event.replyToken, [...messages]);
          replyTokenConsumed = true;
          await auditSystem(db, {
            action: `intent_router.${intentResult.intent.type}`,
            actorType: 'webhook',
            targetType: 'friend',
            targetId: friend.id,
            lineAccountId,
            result: 'success',
            metadata: {
              intent: intentResult.intent,
              matchedKeyword: intentResult.matchedKeyword,
              textHead: incomingText.slice(0, 100),
              messagesSent: messages.length,
              api: 'reply',
            },
          });
        } catch (err) {
          console.error('[intent-router] reply failed:', err);
          await auditSystem(db, {
            action: 'intent_router.reply_failed',
            actorType: 'webhook',
            targetType: 'friend',
            targetId: friend.id,
            lineAccountId,
            result: 'failure',
            errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
            metadata: { intent: intentResult.intent, matchedKeyword: intentResult.matchedKeyword },
          });
        }
      }
    }

    // Layer 2/3: キーワードマッチしなかった場合、AI応答を試行
    if (!matched && !replyTokenConsumed && env?.AI) {
      try {
        // ローディングアニメーション表示（「...」を見せてユーザーを待たせない）
        try {
          await lineClient.showLoadingAnimation(userId, 20);
        } catch (loadErr) {
          console.error('Loading animation error:', loadErr instanceof Error ? loadErr.message : String(loadErr));
        }

        // Phase 5β-prep adoption: AIRouter 経由
        const { createAIRouterFromEnv } = await import('../services/ai-router-factory.js');
        const aiRouter = createAIRouterFromEnv(env);
        // Phase 3.1 ULTRATHINK (2026-05-24): friend profile context を AI に注入 (= 個別化)
        //   birth_month / age_group / display_name を渡し、 system prompt 内の
        //   「## このユーザーの情報」 セクションに表示される
        const friendRecord = friend as {
          score?: number;
          created_at?: string;
          birth_month?: number | null;
          age_group?: string | null;
          display_name?: string | null;
          line_account_id?: string | null;
        };
        const aiResult = await generateAiResponse(
          aiRouter,
          db,
          friend.id,
          friendRecord.score ?? 0,
          friendRecord.created_at ?? '',
          incomingText,
          env.AI_SYSTEM_PROMPT || undefined,
          {
            birthMonth: friendRecord.birth_month ?? null,
            ageGroup: friendRecord.age_group ?? null,
            displayName: friendRecord.display_name ?? null,
            // Plan A-2: broadcast context filter 用 (= multi-tenant 対応)
            lineAccountId: friendRecord.line_account_id ?? lineAccountId ?? null,
          },
        );

        // Plan A-4 (2026-05-24): context-aware に text or flex を選択 (= AI prefix hint + heuristics)
        await lineClient.replyMessage(event.replyToken, [buildAiMessage(aiResult.text)]);
        replyTokenConsumed = true;
        matched = true;

        // AI応答ログ保存
        const aiLogId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
             VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', ?)`,
          )
          .bind(aiLogId, friend.id, `[${aiResult.layer}${aiResult.model ? ':' + aiResult.model.split('/').pop() : ''}] ${aiResult.text}`, jstNow())
          .run();
      } catch (err) {
        console.error('AI response failed:', err);
      }
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(
      db,
      'message_received',
      {
        friendId: friend.id,
        eventData: { text: incomingText, matched },
        replyToken: replyTokenConsumed ? undefined : event.replyToken,
      },
      lineAccessToken,
      lineAccountId,
      env ? buildEmailDispatchConfig(env) : null,
    );

    return;
  }

  // ── Image message → AI 食事画像解析 (Phase 3) ──
  if (event.type === 'message' && event.message.type === 'image') {
    const imageMessage = event.message as ImageEventMessage;
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await getFriendByLineUserId(db, userId);
    if (!friend) return;

    const messageId = imageMessage.id;
    const foodLogId = crypto.randomUUID();
    const now = jstNow();

    // 受信ログ (image)
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
           VALUES (?, ?, 'incoming', 'image', ?, NULL, NULL, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, `[image:${messageId}]`, now)
        .run();
    } catch (err) {
      console.error('Failed to log incoming image message:', err);
    }

    // food_logs に pending 行を先に作る (失敗してもログは残す方針)
    try {
      await insertFoodLog(
        db,
        { friendId: friend.id, ateAt: now, imageUrl: null, mealType: null },
        foodLogId,
      );
    } catch (err) {
      console.error('Failed to insert pending food_log:', err);
      return;
    }

    // 即座に「解析中」を返信 (LINE は 1 秒応答制限のため reply token は同期消費)
    try {
      await lineClient.replyMessage(event.replyToken, [
        buildMessage('text', '🍽 食事の写真を受け取りました！解析中です…少々お待ちください 🙏'),
      ]);
    } catch (err) {
      console.error('Failed to send analyzing reply:', err);
    }

    // バックグラウンド処理: ダウンロード → R2 → AI 解析 → push 結果通知
    const friendLineUserId = userId;
    const friendId = friend.id;
    const apiKey = env?.ANTHROPIC_API_KEY;
    const r2 = env?.IMAGES;
    const baseWorkerUrl = workerUrl || env?.WORKER_URL || '';

    const sendErrorPush = async (errMessage: string): Promise<void> => {
      try {
        await lineClient.pushMessage(friendLineUserId, [
          buildMessage('text', `🙏 ${errMessage}`),
        ]);
      } catch (err) {
        console.error('Failed to push error message:', err);
      }
    };

    const sendSuccessPush = async (
      analysis: { calories: number; protein_g: number; fat_g: number; carbs_g: number; items: ReadonlyArray<{ name: string; qty?: string }>; notes?: string },
    ): Promise<void> => {
      // 判別困難判定: AI が「unknown」 を返した、 もしくは calories=0 (= 量推測も不可) なら正直に案内
      const isUnknown =
        analysis.items.length === 0 ||
        analysis.items.every((it) => it.name === 'unknown' || it.name === '') ||
        (analysis.calories === 0 && analysis.protein_g === 0 && analysis.fat_g === 0 && analysis.carbs_g === 0);

      if (isUnknown) {
        const unknownBubble = {
          type: 'bubble',
          header: {
            type: 'box', layout: 'horizontal',
            backgroundColor: '#fef3c7', paddingAll: '12px',
            contents: [
              { type: 'text', text: '🤔', size: 'sm', flex: 0 },
              { type: 'text', text: '画像の詳細が判別できません',
                size: 'sm', color: '#92400e', weight: 'bold',
                gravity: 'center', margin: 'sm' },
            ],
          },
          body: {
            type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
            contents: [
              { type: 'text', text: analysis.notes || 'もしよろしければ、 料理名や食材を文字でお送りください🙏', size: 'sm', color: '#1e293b', wrap: true },
              { type: 'separator', margin: 'md', color: '#e2e8f0' },
              { type: 'text', text: '例: 「とんこつラーメン」 「サラダボウル (アボカド + チキン)」', size: 'xs', color: '#64748b', wrap: true, margin: 'md' },
            ],
          },
        };
        try {
          await lineClient.pushMessage(friendLineUserId, [
            buildMessage('flex', JSON.stringify(unknownBubble)),
          ]);
        } catch (err) {
          console.error('Failed to push unknown image flex:', err);
        }
        return;
      }

      const itemsLine = analysis.items
        .slice(0, 5)
        .map((it) => (it.qty ? `${it.name} (${it.qty})` : it.name))
        .join(' / ');
      const bubble = {
        type: 'bubble',
        header: {
          type: 'box', layout: 'horizontal',
          backgroundColor: '#06C755', paddingAll: '12px',
          contents: [
            { type: 'text', text: '🍽', size: 'sm', flex: 0 },
            { type: 'text', text: '食事を記録しました',
              size: 'sm', color: '#ffffff', weight: 'bold',
              gravity: 'center', margin: 'sm' },
          ],
        },
        body: {
          type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
          contents: [
            { type: 'box', layout: 'horizontal', spacing: 'md',
              contents: [
                { type: 'text', text: 'カロリー', size: 'xs', color: '#15803d', weight: 'bold', flex: 3 },
                { type: 'text', text: `${Math.round(analysis.calories)} kcal`, size: 'sm', color: '#1e293b', flex: 7, weight: 'bold' },
              ],
            },
            { type: 'separator', margin: 'sm', color: '#e2e8f0' },
            { type: 'box', layout: 'horizontal', spacing: 'md',
              contents: [
                { type: 'text', text: 'たんぱく質', size: 'xs', color: '#15803d', weight: 'bold', flex: 3 },
                { type: 'text', text: `${analysis.protein_g} g`, size: 'sm', color: '#1e293b', flex: 7 },
              ],
            },
            { type: 'box', layout: 'horizontal', spacing: 'md',
              contents: [
                { type: 'text', text: '脂質', size: 'xs', color: '#15803d', weight: 'bold', flex: 3 },
                { type: 'text', text: `${analysis.fat_g} g`, size: 'sm', color: '#1e293b', flex: 7 },
              ],
            },
            { type: 'box', layout: 'horizontal', spacing: 'md',
              contents: [
                { type: 'text', text: '炭水化物', size: 'xs', color: '#15803d', weight: 'bold', flex: 3 },
                { type: 'text', text: `${analysis.carbs_g} g`, size: 'sm', color: '#1e293b', flex: 7 },
              ],
            },
            ...(itemsLine
              ? [
                  { type: 'separator', margin: 'md', color: '#e2e8f0' },
                  { type: 'text', text: itemsLine, size: 'xs', color: '#64748b', wrap: true, margin: 'md' },
                ]
              : []),
          ],
        },
      };
      try {
        await lineClient.pushMessage(friendLineUserId, [
          buildMessage('flex', JSON.stringify(bubble)),
        ]);
      } catch (err) {
        console.error('Failed to push food analysis result:', err);
      }
    };

    // バックグラウンド処理本体: 後続イベントをブロックしないよう waitUntil で独立スケジュール
    const runImagePipeline = async (): Promise<void> => {
      // Phase 5β-prep adoption batch 2: vision provider 利用可否は ANTHROPIC_API_KEY で早期判定
      // (AIRouter 経由でも同じ判定だが、 router 構築コストを省く + 既存テスト互換性のため
      //  apiKey 直接 check を残す)
      if (!apiKey) {
        await markFoodLogFailed(db, foodLogId, 'AI解析が無効です');
        await sendErrorPush('AI解析機能は現在ご利用いただけません。');
        return;
      }

      // 1) LINE Content API で画像取得
      let blob;
      try {
        blob = await downloadLineContent(messageId, lineAccessToken);
      } catch (err) {
        if (err instanceof LineContentError) {
          if (err.code === 'size_exceeded') {
            await markFoodLogFailed(db, foodLogId, '画像サイズが大きすぎます (5MB上限)');
            await sendErrorPush('画像サイズが大きすぎます (5MB上限)。もう少し小さい写真でお試しください。');
            return;
          }
          if (err.code === 'timeout') {
            await markFoodLogFailed(db, foodLogId, '画像取得がタイムアウトしました');
            await sendErrorPush('画像の取得に時間がかかりすぎました。もう一度お試しください。');
            return;
          }
          await markFoodLogFailed(db, foodLogId, `画像取得エラー: ${err.code}`);
          await sendErrorPush('画像を取得できませんでした。もう一度お試しください。');
          return;
        }
        throw err;
      }

      // 2) R2 へアップロード (best-effort: 失敗しても解析は続ける)
      if (r2) {
        try {
          const subtype = (blob.contentType.split('/')[1] || 'jpg').toLowerCase();
          const ext = subtype === 'jpeg' ? 'jpg' : subtype.replace(/[^a-z0-9]/g, '') || 'jpg';
          const key = `food/${foodLogId}.${ext}`;
          await r2.put(key, blob.bytes as unknown as ArrayBuffer, {
            httpMetadata: { contentType: blob.contentType },
            customMetadata: { foodLogId, friendId },
          });
          if (baseWorkerUrl) {
            const publicUrl = `${baseWorkerUrl.replace(/\/$/, '')}/images/${key}`;
            try {
              await setFoodLogImageUrl(db, foodLogId, publicUrl);
            } catch (urlErr) {
              console.error('Failed to set food_log image_url:', urlErr);
            }
          }
        } catch (uploadErr) {
          console.error('R2 upload failed (non-fatal):', uploadErr);
        }
      }

      // 3) Vision で解析 (Phase 5β-prep adoption batch 2: AIRouter 経由)
      const router = createAIRouterFromEnv(env as Parameters<typeof createAIRouterFromEnv>[0]);
      let analysis;
      try {
        analysis = await analyzeFoodImage({
          imageBytes: blob.bytes,
          mimeType: blob.contentType,
          router,
        });
      } catch (err) {
        if (err instanceof FoodAnalyzerError) {
          if (err.code === 'timeout') {
            await markFoodLogFailed(db, foodLogId, '解析がタイムアウトしました');
            await sendErrorPush('解析に時間がかかりすぎました。もう一度お試しください。');
            return;
          }
          if (err.code === 'invalid_mime_type') {
            await markFoodLogFailed(db, foodLogId, '対応していない画像形式です');
            await sendErrorPush('対応していない画像形式です。JPEG/PNG/WebP/GIF でお試しください。');
            return;
          }
          await markFoodLogFailed(db, foodLogId, `解析エラー: ${err.code}`);
          await sendErrorPush('解析できませんでした。もう一度お試しください 🙏');
          return;
        }
        throw err;
      }

      // 4) 成功 → DB 更新 + push
      await updateFoodLogAnalysis(db, foodLogId, analysis);
      await sendSuccessPush(analysis);

      // 5) イベントバス通知 (将来の自動化向け)
      try {
        await fireEvent(
          db,
          'food_logged',
          {
            friendId,
            eventData: {
              foodLogId,
              calories: analysis.calories,
              protein_g: analysis.protein_g,
              fat_g: analysis.fat_g,
              carbs_g: analysis.carbs_g,
            },
          },
          lineAccessToken,
          lineAccountId,
          env ? buildEmailDispatchConfig(env) : null,
        );
      } catch (eventErr) {
        // err 全体ではなく要約のみログ (secret leak 対策)
        console.error('food_logged event fire failed (non-fatal):', eventErr instanceof Error ? eventErr.name : 'unknown');
      }
    };

    // pipeline を non-blocking で実行 (後続 webhook event を待たせない)
    const pipeline = runImagePipeline().catch(async (err) => {
      // pipeline 全体の最終 catch — 安全に救済 + 友だち通知
      // err 全体ではなく name のみログに出す (lineAccessToken / apiKey の closure を持つ scope のため)
      console.error('Unexpected error in image webhook handler:', err instanceof Error ? err.name : 'unknown');
      try {
        await markFoodLogFailed(db, foodLogId, '予期せぬエラー');
      } catch { /* best effort */ }
      await sendErrorPush('解析できませんでした。もう一度お試しください 🙏');
    });
    if (ctx) {
      ctx.waitUntil(pipeline);
    } else {
      // ctx が無いケース (テスト等) は await して挙動を維持
      await pipeline;
    }
    return;
  }
}

export { webhook };
