import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getAbTestById,
  getAbTests,
  updateAbTestStatus,
  updateAbTestWinner,
  updateAbTestTrackedLinks,
  batchCreateAbTestAssignments,
  getAssignedFriendIds,
  getFriendsByTag,
  jstNow,
} from '@line-crm/db';
import type { AbTest } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { calculateStaggerDelay, sleep, addMessageVariation } from './stealth.js';

const MULTICAST_BATCH_SIZE = 500;

// ---------- Message Builder ----------

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

// ---------- Fisher-Yates Shuffle ----------

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------- Audience Resolution ----------

interface AudienceFriend {
  id: string;
  line_user_id: string;
}

async function resolveAudience(
  db: D1Database,
  abTest: AbTest,
): Promise<AudienceFriend[]> {
  if (abTest.target_type === 'tag') {
    if (!abTest.target_tag_id) {
      throw new Error('target_tag_id is required for tag-targeted AB tests');
    }
    const friends = await getFriendsByTag(db, abTest.target_tag_id);
    return friends
      .filter((f) => f.is_following)
      .map((f) => ({ id: f.id, line_user_id: f.line_user_id }));
  }

  // target_type === 'all': query all following friends
  const result = await db
    .prepare('SELECT id, line_user_id FROM friends WHERE is_following = 1')
    .all<AudienceFriend>();
  return result.results;
}

// ---------- Multicast with Stealth ----------

async function multicastWithStealth(
  lineClient: LineClient,
  db: D1Database,
  friends: AudienceFriend[],
  message: Message,
  abTestId: string,
  variant: 'A' | 'B',
): Promise<{ total: number; success: number }> {
  let successCount = 0;
  const now = jstNow();
  const totalBatches = Math.ceil(friends.length / MULTICAST_BATCH_SIZE);

  for (let i = 0; i < friends.length; i += MULTICAST_BATCH_SIZE) {
    const batchIndex = Math.floor(i / MULTICAST_BATCH_SIZE);
    const batch = friends.slice(i, i + MULTICAST_BATCH_SIZE);
    const lineUserIds = batch.map((f) => f.line_user_id);

    // Stealth: staggered delay between batches
    if (batchIndex > 0) {
      const delay = calculateStaggerDelay(friends.length, batchIndex);
      await sleep(delay);
    }

    // Stealth: message variation for text
    let batchMessage = message;
    if (message.type === 'text' && totalBatches > 1) {
      batchMessage = { ...message, text: addMessageVariation(message.text, batchIndex) };
    }

    try {
      await lineClient.multicast(lineUserIds, [batchMessage]);
      successCount += batch.length;

      // Log each message
      for (const friend of batch) {
        const logId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO messages_log (id, friend_id, direction, message_type, content, ab_test_id, scenario_step_id, created_at)
             VALUES (?, ?, 'outgoing', ?, ?, ?, NULL, ?)`,
          )
          .bind(logId, friend.id, message.type, JSON.stringify(message), abTestId, now)
          .run();
      }
    } catch (err) {
      console.error(`AB test multicast batch ${batchIndex} (variant ${variant}) failed:`, err);
    }
  }

  return { total: friends.length, success: successCount };
}

// ---------- Public API ----------

/**
 * Send the A/B test: resolve audience, shuffle, split, multicast each variant.
 */
export async function processAbTestSend(
  db: D1Database,
  lineClient: LineClient,
  abTestId: string,
  workerUrl?: string,
): Promise<AbTest> {
  await updateAbTestStatus(db, abTestId, 'sending');

  const abTest = await getAbTestById(db, abTestId);
  if (!abTest) {
    throw new Error(`AB test ${abTestId} not found`);
  }

  try {
    // Resolve full audience
    const audience = await resolveAudience(db, abTest);
    if (audience.length === 0) {
      await updateAbTestStatus(db, abTestId, 'test_sent', {
        variantATotal: 0,
        variantASuccess: 0,
        variantBTotal: 0,
        variantBSuccess: 0,
      });
      return (await getAbTestById(db, abTestId))!;
    }

    // Shuffle and split
    const shuffled = shuffleArray(audience);
    const splitIndex = Math.floor(shuffled.length * abTest.split_ratio / 100);
    const groupA = shuffled.slice(0, splitIndex);
    const groupB = shuffled.slice(splitIndex);

    // Auto-track URLs for each variant
    let finalTypeA = abTest.variant_a_message_type as string;
    let finalContentA = abTest.variant_a_message_content;
    let finalTypeB = abTest.variant_b_message_type as string;
    let finalContentB = abTest.variant_b_message_content;

    if (workerUrl) {
      const { autoTrackContent } = await import('./auto-track.js');
      const trackedA = await autoTrackContent(db, finalTypeA, finalContentA, workerUrl);
      finalTypeA = trackedA.messageType;
      finalContentA = trackedA.content;

      const trackedB = await autoTrackContent(db, finalTypeB, finalContentB, workerUrl);
      finalTypeB = trackedB.messageType;
      finalContentB = trackedB.content;
    }

    // Build messages
    const messageA = buildMessage(finalTypeA, finalContentA, abTest.variant_a_alt_text || undefined);
    const messageB = buildMessage(finalTypeB, finalContentB, abTest.variant_b_alt_text || undefined);

    // Record assignments
    const assignments = [
      ...groupA.map((f) => ({ abTestId, friendId: f.id, variant: 'A' as const })),
      ...groupB.map((f) => ({ abTestId, friendId: f.id, variant: 'B' as const })),
    ];
    await batchCreateAbTestAssignments(db, assignments);

    // Send variant A
    const resultA = await multicastWithStealth(lineClient, db, groupA, messageA, abTestId, 'A');

    // Send variant B
    const resultB = await multicastWithStealth(lineClient, db, groupB, messageB, abTestId, 'B');

    // Update status
    await updateAbTestStatus(db, abTestId, 'test_sent', {
      variantATotal: resultA.total,
      variantASuccess: resultA.success,
      variantBTotal: resultB.total,
      variantBSuccess: resultB.success,
    });
  } catch (err) {
    await updateAbTestStatus(db, abTestId, 'draft');
    throw err;
  }

  return (await getAbTestById(db, abTestId))!;
}

/**
 * Send the winning variant to users NOT in the original test.
 * Only tag-targeted AB tests can have a meaningful winner send
 * (since 'all' already covers everyone).
 */
export async function processAbTestWinnerSend(
  db: D1Database,
  lineClient: LineClient,
  abTestId: string,
  winner: 'A' | 'B',
  workerUrl?: string,
): Promise<AbTest> {
  const abTest = await getAbTestById(db, abTestId);
  if (!abTest) {
    throw new Error(`AB test ${abTestId} not found`);
  }
  if (abTest.status !== 'test_sent') {
    throw new Error('AB test must be in test_sent status to send winner');
  }

  // Record winner
  await updateAbTestWinner(db, abTestId, winner);

  // If target_type is 'all', everyone already received a variant — no remaining users
  if (abTest.target_type === 'all') {
    await updateAbTestStatus(db, abTestId, 'winner_sent', {
      winnerTotal: 0,
      winnerSuccess: 0,
    });
    return (await getAbTestById(db, abTestId))!;
  }

  // Get already-assigned friend IDs
  const assignedIds = await getAssignedFriendIds(db, abTestId);

  // Resolve full audience and exclude assigned
  const fullAudience = await resolveAudience(db, abTest);
  const remaining = fullAudience.filter((f) => !assignedIds.has(f.id));

  if (remaining.length === 0) {
    await updateAbTestStatus(db, abTestId, 'winner_sent', {
      winnerTotal: 0,
      winnerSuccess: 0,
    });
    return (await getAbTestById(db, abTestId))!;
  }

  // Build winning message
  const msgType = winner === 'A' ? abTest.variant_a_message_type : abTest.variant_b_message_type;
  const msgContent = winner === 'A' ? abTest.variant_a_message_content : abTest.variant_b_message_content;
  const msgAltText = winner === 'A' ? abTest.variant_a_alt_text : abTest.variant_b_alt_text;

  let finalType = msgType as string;
  let finalContent = msgContent;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, finalType, finalContent, workerUrl);
    finalType = tracked.messageType;
    finalContent = tracked.content;
  }

  const message = buildMessage(finalType, finalContent, msgAltText || undefined);
  const result = await multicastWithStealth(lineClient, db, remaining, message, abTestId, winner);

  await updateAbTestStatus(db, abTestId, 'winner_sent', {
    winnerTotal: result.total,
    winnerSuccess: result.success,
  });

  return (await getAbTestById(db, abTestId))!;
}

/**
 * Get click stats for each variant.
 */
export interface AbTestStats {
  variantA: { sent: number; clicks: number; clickRate: number };
  variantB: { sent: number; clicks: number; clickRate: number };
  winner: { sent: number; clicks: number; clickRate: number } | null;
}

export async function getAbTestStats(
  db: D1Database,
  abTestId: string,
): Promise<AbTestStats> {
  const abTest = await getAbTestById(db, abTestId);
  if (!abTest) {
    throw new Error(`AB test ${abTestId} not found`);
  }

  // Count unique clickers per variant
  async function countClicks(variant: 'A' | 'B'): Promise<number> {
    const trackedIdsJson =
      variant === 'A' ? abTest!.variant_a_tracked_link_ids : abTest!.variant_b_tracked_link_ids;
    if (!trackedIdsJson) return 0;

    let trackedIds: string[];
    try {
      trackedIds = JSON.parse(trackedIdsJson);
    } catch {
      return 0;
    }
    if (trackedIds.length === 0) return 0;

    const placeholders = trackedIds.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT COUNT(DISTINCT lc.friend_id) as count
         FROM link_clicks lc
         WHERE lc.tracked_link_id IN (${placeholders})
           AND lc.friend_id IN (
             SELECT friend_id FROM ab_test_assignments
             WHERE ab_test_id = ? AND variant = ?
           )`,
      )
      .bind(...trackedIds, abTestId, variant)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }

  const clicksA = await countClicks('A');
  const clicksB = await countClicks('B');

  const sentA = abTest.variant_a_success;
  const sentB = abTest.variant_b_success;

  return {
    variantA: {
      sent: sentA,
      clicks: clicksA,
      clickRate: sentA > 0 ? Math.round((clicksA / sentA) * 10000) / 100 : 0,
    },
    variantB: {
      sent: sentB,
      clicks: clicksB,
      clickRate: sentB > 0 ? Math.round((clicksB / sentB) * 10000) / 100 : 0,
    },
    winner: abTest.winner
      ? {
          sent: abTest.winner_success,
          clicks: 0, // Winner clicks tracked separately if needed
          clickRate: 0,
        }
      : null,
  };
}

/**
 * Process scheduled AB tests (called from cron).
 */
export async function processScheduledAbTests(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
): Promise<void> {
  const allTests = await getAbTests(db);
  const nowMs = Date.now();

  const scheduled = allTests.filter(
    (t) =>
      t.status === 'scheduled' &&
      t.scheduled_at !== null &&
      new Date(t.scheduled_at).getTime() <= nowMs,
  );

  for (const test of scheduled) {
    try {
      await processAbTestSend(db, lineClient, test.id, workerUrl);
    } catch (err) {
      console.error(`Failed to send scheduled AB test ${test.id}:`, err);
    }
  }
}
