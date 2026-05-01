import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getBroadcastById,
  getBroadcasts,
  updateBroadcastStatus,
  getFriendsByTag,
  getEmailTemplateById,
  jstNow,
} from '@line-crm/db';
import type { Broadcast, BroadcastChannel, Friend } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep, addMessageVariation } from './stealth.js';
import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
import {
  buildEmailDispatcherDeps,
  type EmailDispatchConfig,
} from './email-dispatch-config.js';

const MULTICAST_BATCH_SIZE = 500;

/**
 * Round 4 PR-6 段階 2: broadcast を channel='line' / 'email' / 'both' で振り分け配信。
 *
 * - channel='line' (default): 既存挙動 (multicast / broadcast API)
 * - channel='email': dispatcher 経由で email 送信
 * - channel='both': 友だちごとに dispatcher 呼出 (LINE + email 同時)
 *
 * `emailConfig` が null の場合 (RESEND_API_KEY 未設定等)、email 関連 channel は
 * 短絡して status='sent', counts=0 で完了 (cron が空回りしないため)。
 */
export async function processBroadcastSend(
  db: D1Database,
  lineClient: LineClient,
  broadcastId: string,
  workerUrl?: string,
  emailConfig?: EmailDispatchConfig | null,
): Promise<Broadcast> {
  // Mark as sending
  await updateBroadcastStatus(db, broadcastId, 'sending');

  const broadcast = await getBroadcastById(db, broadcastId);
  if (!broadcast) {
    throw new Error(`Broadcast ${broadcastId} not found`);
  }

  const channel: BroadcastChannel = broadcast.channel ?? 'line';

  try {
    if (channel === 'email') {
      const counts = await sendBroadcastEmail(db, broadcast, emailConfig ?? null);
      await updateBroadcastStatus(db, broadcastId, 'sent', counts);
    } else if (channel === 'both') {
      const counts = await sendBroadcastBoth(
        db,
        lineClient,
        broadcast,
        emailConfig ?? null,
        workerUrl,
      );
      await updateBroadcastStatus(db, broadcastId, 'sent', counts);
    } else {
      const counts = await sendBroadcastLine(db, lineClient, broadcast, broadcastId, workerUrl);
      await updateBroadcastStatus(db, broadcastId, 'sent', counts);
    }
  } catch (err) {
    // On failure, reset to draft so it can be retried
    await updateBroadcastStatus(db, broadcastId, 'draft');
    throw err;
  }

  return (await getBroadcastById(db, broadcastId))!;
}

interface DispatchCounts {
  totalCount: number;
  successCount: number;
}

// ============================================================
// LINE 既存実装 (channel='line' default)
// ============================================================

async function sendBroadcastLine(
  db: D1Database,
  lineClient: LineClient,
  broadcast: Broadcast,
  broadcastId: string,
  workerUrl?: string,
): Promise<DispatchCounts> {
  // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl);
    finalType = tracked.messageType;
    finalContent = tracked.content;
  }
  const altText = (broadcast as unknown as Record<string, unknown>).alt_text as string | undefined;
  const message = buildMessage(finalType, finalContent, altText || undefined);

  let totalCount = 0;
  let successCount = 0;

  if (broadcast.target_type === 'all') {
    // Use LINE broadcast API (sends to all followers).
    // Capture X-Line-Request-Id so we can later query open/click stats
    // from LINE Insight API (/v2/bot/insight/message/event).
    const { requestId } = await lineClient.broadcastWithRequestId([message]);
    if (requestId) {
      await db
        .prepare('UPDATE broadcasts SET line_request_id = ? WHERE id = ?')
        .bind(requestId, broadcastId)
        .run();
    }
    // We don't have exact count for broadcast API, set as 0 (unknown)
    return { totalCount: 0, successCount: 0 };
  }

  if (broadcast.target_type === 'tag') {
    if (!broadcast.target_tag_id) {
      throw new Error('target_tag_id is required for tag-targeted broadcasts');
    }

    const friends = await getFriendsByTag(db, broadcast.target_tag_id);
    const followingFriends = friends.filter((f) => f.is_following);
    totalCount = followingFriends.length;

    // Send in batches with stealth delays to mimic human patterns
    const now = jstNow();
    const totalBatches = Math.ceil(followingFriends.length / MULTICAST_BATCH_SIZE);
    for (let i = 0; i < followingFriends.length; i += MULTICAST_BATCH_SIZE) {
      const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
      const batch = followingFriends.slice(i, i + MULTICAST_BATCH_SIZE);
      const lineUserIds = batch.map((f) => f.line_user_id);

      // Stealth: add staggered delay between batches
      if (batchIndex > 0) {
        const delay = calculateStaggerDelay(followingFriends.length, batchIndex);
        await sleep(delay);
      }

      // Stealth: add slight variation to text messages
      let batchMessage = message;
      if (message.type === 'text' && totalBatches > 1) {
        batchMessage = { ...message, text: addMessageVariation(message.text, batchIndex) };
      }

      try {
        await lineClient.multicast(lineUserIds, [batchMessage]);
        successCount += batch.length;

        // Log only successfully sent messages
        for (const friend of batch) {
          const logId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, ?)`,
            )
            .bind(logId, friend.id, broadcast.message_type, broadcast.message_content, broadcastId, now)
            .run();
        }
      } catch (err) {
        console.error(`Multicast batch ${i / MULTICAST_BATCH_SIZE} failed:`, err);
        // Continue with next batch; failed batch is not logged
      }
    }
  }

  return { totalCount, successCount };
}

// ============================================================
// channel='email' 実装
// ============================================================

interface EmailRecipient {
  friend: Friend;
  email: string;
  subscriberId?: string;
}

async function resolveFollowingFriends(
  db: D1Database,
  broadcast: Broadcast,
): Promise<Friend[]> {
  if (broadcast.target_type === 'tag') {
    if (!broadcast.target_tag_id) {
      throw new Error('target_tag_id is required for tag-targeted broadcasts');
    }
    const friends = await getFriendsByTag(db, broadcast.target_tag_id);
    return friends.filter((f) => f.is_following);
  }

  // target_type='all' — all following friends (optionally scoped by line_account_id)
  const lineAccountId = (broadcast as unknown as Record<string, unknown>).line_account_id as
    | string
    | null
    | undefined;
  if (lineAccountId) {
    const result = await db
      .prepare(
        `SELECT * FROM friends WHERE is_following = 1 AND line_account_id = ?`,
      )
      .bind(lineAccountId)
      .all<Friend>();
    return result.results ?? [];
  }
  const result = await db
    .prepare(`SELECT * FROM friends WHERE is_following = 1`)
    .all<Friend>();
  return result.results ?? [];
}

async function lookupEmailRecipients(
  db: D1Database,
  friends: Friend[],
): Promise<EmailRecipient[]> {
  const recipients: EmailRecipient[] = [];
  for (const friend of friends) {
    const sub = await db
      .prepare(
        `SELECT id, email FROM email_subscribers WHERE friend_id = ? LIMIT 1`,
      )
      .bind(friend.id)
      .first<{ id: string; email: string }>();
    if (sub && sub.email) {
      recipients.push({ friend, email: sub.email, subscriberId: sub.id });
    }
  }
  return recipients;
}

async function sendBroadcastEmail(
  db: D1Database,
  broadcast: Broadcast,
  emailConfig: EmailDispatchConfig | null,
): Promise<DispatchCounts> {
  if (!broadcast.email_template_id) {
    throw new Error('email_template_id is required for email broadcast');
  }

  // emailConfig が null の場合は短絡 (cron で RESEND_API_KEY 無し等)。
  if (!emailConfig) {
    console.warn(
      `[broadcast] emailConfig=null → channel='email' broadcast ${broadcast.id} short-circuited (totalCount=0, successCount=0)`,
    );
    return { totalCount: 0, successCount: 0 };
  }

  // Template 取得 + バリデーション
  const template = await getEmailTemplateById(db, broadcast.email_template_id);
  if (!template || template.is_active !== 1) {
    throw new Error('Email template not found or inactive');
  }

  // 対象友だち + email 解決
  const friends = await resolveFollowingFriends(db, broadcast);
  const recipients = await lookupEmailRecipients(db, friends);
  const totalCount = recipients.length;

  if (totalCount === 0) {
    return { totalCount: 0, successCount: 0 };
  }

  const deps: ChannelDispatcherDeps = {
    db,
    ...buildEmailDispatcherDeps(emailConfig),
  };

  let successCount = 0;
  for (const r of recipients) {
    try {
      const result = await dispatch(deps, {
        recipient: {
          friend: { id: r.friend.id, lineUserId: r.friend.line_user_id },
          email: r.email,
          subscriberId: r.subscriberId,
        },
        channel: 'email',
        category: 'marketing',
        sourceKind: 'broadcast',
        emailPayload: {
          subjectTemplate: template.subject,
          htmlTemplate: template.html_content,
          textTemplate: template.text_content,
          preheader: template.preheader ?? undefined,
          variables: { name: r.friend.display_name ?? '' },
          templateId: template.id,
        },
        source: { broadcastId: broadcast.id },
      });
      const emailResult = result.results.find((res) => res.channel === 'email');
      if (emailResult && emailResult.status === 'sent') {
        successCount += 1;
      }
    } catch (err) {
      console.error(
        `[broadcast] email dispatch failed for friend=${r.friend.id}:`,
        err instanceof Error ? err.message : 'unknown',
      );
      // continue with next recipient
    }
  }

  return { totalCount, successCount };
}

// ============================================================
// channel='both' 実装 (LINE + email 同時、効率を犠牲にして対称性を取る)
// ============================================================

async function sendBroadcastBoth(
  db: D1Database,
  lineClient: LineClient,
  broadcast: Broadcast,
  emailConfig: EmailDispatchConfig | null,
  workerUrl?: string,
): Promise<DispatchCounts> {
  if (!broadcast.email_template_id) {
    throw new Error('email_template_id is required for email broadcast');
  }

  // Template 取得 (email 側)
  const template = await getEmailTemplateById(db, broadcast.email_template_id);
  if (!template || template.is_active !== 1) {
    throw new Error('Email template not found or inactive');
  }

  // LINE 側: auto-track 適用後の message を構築
  let finalType: string = broadcast.message_type;
  let finalContent = broadcast.message_content;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, broadcast.message_type, broadcast.message_content, workerUrl);
    finalType = tracked.messageType;
    finalContent = tracked.content;
  }
  const altText = (broadcast as unknown as Record<string, unknown>).alt_text as string | undefined;
  const lineMessage = buildMessage(finalType, finalContent, altText || undefined);

  const friends = await resolveFollowingFriends(db, broadcast);
  const totalCount = friends.length;

  if (totalCount === 0) {
    return { totalCount: 0, successCount: 0 };
  }

  // dispatcher deps
  const deps: ChannelDispatcherDeps = emailConfig
    ? { db, lineClient, ...buildEmailDispatcherDeps(emailConfig) }
    : { db, lineClient };

  let successCount = 0;
  for (const friend of friends) {
    // email lookup (best-effort; missing → email channel skipped)
    let email: string | undefined;
    let subscriberId: string | undefined;
    const sub = await db
      .prepare(`SELECT id, email FROM email_subscribers WHERE friend_id = ? LIMIT 1`)
      .bind(friend.id)
      .first<{ id: string; email: string }>();
    if (sub && sub.email) {
      email = sub.email;
      subscriberId = sub.id;
    }

    try {
      const result = await dispatch(deps, {
        recipient: {
          friend: { id: friend.id, lineUserId: friend.line_user_id },
          email,
          subscriberId,
        },
        channel: 'both',
        category: 'marketing',
        sourceKind: 'broadcast',
        linePayload: { messages: [lineMessage] },
        emailPayload: {
          subjectTemplate: template.subject,
          htmlTemplate: template.html_content,
          textTemplate: template.text_content,
          preheader: template.preheader ?? undefined,
          variables: { name: friend.display_name ?? '' },
          templateId: template.id,
        },
        source: { broadcastId: broadcast.id },
      });
      // 'both': どちらか一方でも sent なら success
      const anySent = result.results.some((r) => r.status === 'sent');
      if (anySent) successCount += 1;
    } catch (err) {
      console.error(
        `[broadcast] both dispatch failed for friend=${friend.id}:`,
        err instanceof Error ? err.message : 'unknown',
      );
    }
  }

  return { totalCount, successCount };
}

// ============================================================
// Cron caller
// ============================================================

export async function processScheduledBroadcasts(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  const allBroadcasts = await getBroadcasts(db);

  const nowMs = Date.now();
  const scheduled = allBroadcasts.filter(
    (b) =>
      b.status === 'scheduled' &&
      b.scheduled_at !== null &&
      new Date(b.scheduled_at).getTime() <= nowMs,
  );

  for (const broadcast of scheduled) {
    try {
      await processBroadcastSend(db, lineClient, broadcast.id, workerUrl, emailConfig ?? null);
    } catch (err) {
      console.error(`Failed to send scheduled broadcast ${broadcast.id}:`, err);
      // Continue with next broadcast
    }
  }
}

function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(messageContent) as {
        originalContentUrl: string;
        previewImageUrl: string;
      };
      return {
        type: 'image',
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl,
      };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  return { type: 'text', text: messageContent };
}
