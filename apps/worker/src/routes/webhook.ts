import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
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
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { generateAiResponse } from '../services/ai-response.js';
import type { Env } from '../index.js';

/**
 * AI 応答テキストを美しい Flex Message に変換
 *
 * AI出力フォーマット:
 *   ## セクション見出し  → 緑背景の太字ヘッダー
 *   **ラベル**: 値       → テーブル行（ラベル太字緑 + 値）
 *   * 箇条書き           → 緑ドット付きリスト
 *   ■見出し / 【見出し】 → セクションヘッダー（互換）
 *   ・箇条書き / - 項目  → リスト（互換）
 *   ラベル: 値            → テーブル行（互換）
 *   ---                  → 区切り線
 *   通常テキスト          → 本文
 */
function buildAiFlexJson(text: string): string {
  const lines = text.split('\n').filter(line => line.trim());
  const bodyContents: object[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // セクション見出し（## / ■ / ● / ▶ / 【】）
    if (/^(##\s+|[■●▶])/.test(trimmed) || /^【.+】$/.test(trimmed)) {
      const label = trimmed
        .replace(/^##\s+/, '')
        .replace(/^[■●▶]\s*/, '')
        .replace(/^【/, '').replace(/】$/, '');
      bodyContents.push({
        type: 'box', layout: 'horizontal',
        backgroundColor: '#f0fdf4', cornerRadius: 'md',
        paddingAll: '10px',
        margin: bodyContents.length > 0 ? 'lg' : 'none',
        contents: [
          { type: 'box', layout: 'vertical', width: '3px',
            backgroundColor: '#06C755', cornerRadius: '2px',
            contents: [{ type: 'filler' }] },
          { type: 'text', text: label,
            size: 'sm', weight: 'bold', color: '#15803d',
            wrap: true, margin: 'sm' },
        ],
      });
    }
    // テーブル行: **ラベル**: 値
    else if (/^\*\*[^*]+\*\*[:：]\s*.+/.test(trimmed)) {
      const match = trimmed.match(/^\*\*([^*]+)\*\*[:：]\s*(.+)/);
      if (match) {
        bodyContents.push({
          type: 'box', layout: 'horizontal', spacing: 'md',
          margin: 'sm', paddingStart: '6px',
          contents: [
            { type: 'text', text: match[1],
              size: 'xs', color: '#15803d', weight: 'bold',
              flex: 3, wrap: false },
            { type: 'text', text: match[2],
              size: 'xs', color: '#1e293b', flex: 7, wrap: true },
          ],
        });
      }
    }
    // テーブル行: ラベル: 値（コロンが前半15文字以内にある）
    else if (/^[^:：\n]{1,15}[:：]\s*.+/.test(trimmed) && !/^https?:/.test(trimmed)) {
      const colonIdx = trimmed.search(/[:：]/);
      const label = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      bodyContents.push({
        type: 'box', layout: 'horizontal', spacing: 'md',
        margin: 'sm', paddingStart: '6px',
        contents: [
          { type: 'text', text: label,
            size: 'xs', color: '#15803d', weight: 'bold',
            flex: 3, wrap: false },
          { type: 'text', text: value,
            size: 'xs', color: '#1e293b', flex: 7, wrap: true },
        ],
      });
    }
    // 箇条書き（* ・ - • で始まる）
    else if (/^[*・\-•]\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^[*・\-•]\s+/, '');
      bodyContents.push({
        type: 'box', layout: 'horizontal', spacing: 'sm',
        margin: 'sm', paddingStart: '8px',
        contents: [
          { type: 'text', text: '▸', size: 'xs', color: '#06C755',
            flex: 0, gravity: 'top' },
          { type: 'text', text: itemText,
            size: 'sm', color: '#334155', wrap: true },
        ],
      });
    }
    // 区切り線
    else if (/^-{3,}$/.test(trimmed)) {
      bodyContents.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
    }
    // 通常テキスト
    else {
      bodyContents.push({
        type: 'text', text: trimmed,
        size: 'sm', color: '#334155', wrap: true,
        margin: bodyContents.length > 0 ? 'md' : 'none',
      });
    }
  }

  if (bodyContents.length === 0) {
    bodyContents.push({ type: 'text', text, size: 'sm', color: '#334155', wrap: true });
  }

  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'horizontal',
      backgroundColor: '#06C755', paddingAll: '12px',
      cornerRadius: 'none',
      contents: [
        { type: 'text', text: '🌿', size: 'sm', flex: 0 },
        { type: 'text', text: 'naturism',
          size: 'xs', color: '#ffffff', weight: 'bold',
          gravity: 'center', margin: 'sm' },
        { type: 'filler' },
        { type: 'text', text: 'AI応答',
          size: 'xxs', color: '#d1fae5', gravity: 'center' },
      ],
    },
    body: {
      type: 'box', layout: 'vertical',
      contents: bodyContents,
      paddingAll: '16px',
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      backgroundColor: '#f8fafc',
      contents: [
        { type: 'box', layout: 'horizontal',
          justifyContent: 'center', spacing: 'xs',
          contents: [
            { type: 'text', text: '詳しくは',
              size: 'xxs', color: '#94a3b8', flex: 0 },
            { type: 'text', text: 'info@kenkoex.com',
              size: 'xxs', color: '#06C755', weight: 'bold',
              flex: 0, decoration: 'underline' },
            { type: 'text', text: 'まで📩',
              size: 'xxs', color: '#94a3b8', flex: 0 },
          ],
        },
      ],
    },
    styles: {
      header: { separator: false },
      body: { separator: false },
      footer: { separator: true },
    },
  };

  return JSON.stringify(bubble);
}

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
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env);
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
): Promise<void> {
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
          if (!existing) {
            const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const expandedContent = expandVariables(firstStep.message_content, friend as { id: string; display_name: string | null; user_id: string | null });
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

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
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
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
    const params = new URLSearchParams(data);
    const action = params.get('action');

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

    // Layer 2/3: キーワードマッチしなかった場合、AI応答を試行
    if (!matched && !replyTokenConsumed && env?.AI) {
      try {
        // ローディングアニメーション表示（「...」を見せてユーザーを待たせない）
        try {
          await lineClient.showLoadingAnimation(userId, 20);
          console.log('Loading animation sent successfully');
        } catch (loadErr) {
          console.error('Loading animation error:', loadErr instanceof Error ? loadErr.message : String(loadErr));
        }

        const aiResult = await generateAiResponse(
          env.AI,
          db,
          friend.id,
          (friend as { score?: number }).score ?? 0,
          (friend as { created_at?: string }).created_at ?? '',
          incomingText,
          env.AI_SYSTEM_PROMPT || undefined,
          env.AI_MODEL_PRIMARY || undefined,
          env.AI_MODEL_FALLBACK || undefined,
        );

        // Flex Message カード形式で送信
        const flexJson = buildAiFlexJson(aiResult.text);
        await lineClient.replyMessage(event.replyToken, [buildMessage('flex', flexJson)]);
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
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
