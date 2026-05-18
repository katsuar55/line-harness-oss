import { extractFlexAltText } from '../utils/flex-alt-text.js';
import {
  getFriendScenariosDueForDelivery,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  getFriendById,
  getEmailTemplateById,
  jstNow,
  type ScenarioStep,
  type EmailTemplate,
  type Friend,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import type { Message } from '@line-crm/line-sdk';
import { jitterDeliveryTime, addJitter, sleep } from './stealth.js';
import { dispatch, type ChannelDispatcherDeps } from './channel-dispatcher.js';
import {
  buildEmailDispatcherDeps,
  type EmailDispatchConfig,
} from './email-dispatch-config.js';
import { getCouponCodeForFriend } from './shopify-coupon-issuer.js';

/**
 * Replace template variables in message content.
 *
 * Supported variables:
 * - {{name}}                    → friend's display name
 * - {{uid}}                     → friend's user UUID
 * - {{friend_id}}               → friend's internal ID
 * - {{ref}}                     → friend's ref_code (空文字 if 未設定)
 * - {{line_friend_coupon_code}} → LINE 友だち追加時発行 coupon code (5β-1d-2b、 空文字 if 未発行)
 * - {{auth_url:CHANNEL_ID}}     → full /auth/line URL with uid for cross-account linking
 *
 * Conditional blocks:
 * - {{#if_ref}}...{{/if_ref}}       → ref_code が truthy ならブロックを表示
 * - {{#if_coupon}}...{{/if_coupon}} → line_friend_coupon_code が truthy なら表示 (5β-1d-2b)
 */
export function expandVariables(
  content: string,
  friend: {
    id: string;
    display_name: string | null;
    user_id: string | null;
    ref_code?: string | null;
    line_friend_coupon_code?: string | null;
  },
  apiOrigin?: string,
): string {
  let result = content;
  result = result.replace(/\{\{name\}\}/g, friend.display_name || '');
  result = result.replace(/\{\{uid\}\}/g, friend.user_id || '');
  result = result.replace(/\{\{friend_id\}\}/g, friend.id);
  result = result.replace(/\{\{ref\}\}/g, friend.ref_code || '');
  result = result.replace(/\{\{line_friend_coupon_code\}\}/g, friend.line_friend_coupon_code || '');

  // Conditional block: {{#if_ref}}...{{/if_ref}} — only shown if ref_code exists
  if (friend.ref_code) {
    result = result.replace(/\{\{#if_ref\}\}([\s\S]*?)\{\{\/if_ref\}\}/g, '$1');
  } else {
    result = result.replace(/\{\{#if_ref\}\}[\s\S]*?\{\{\/if_ref\}\}/g, '');
  }

  // Conditional block: {{#if_coupon}}...{{/if_coupon}} — only shown if line_friend_coupon_code exists (5β-1d-2b)
  if (friend.line_friend_coupon_code) {
    result = result.replace(/\{\{#if_coupon\}\}([\s\S]*?)\{\{\/if_coupon\}\}/g, '$1');
  } else {
    result = result.replace(/\{\{#if_coupon\}\}[\s\S]*?\{\{\/if_coupon\}\}/g, '');
  }

  if (apiOrigin) {
    result = result.replace(/\{\{auth_url:([^}]+)\}\}/g, (_match, channelId) => {
      const params = new URLSearchParams({ account: channelId, ref: 'cross-link' });
      if (friend.user_id) params.set('uid', friend.user_id);
      return `${apiOrigin}/auth/line?${params.toString()}`;
    });
  }
  return result;
}

/** Default delivery window: 9:00-23:00 JST. If outside, push to next 9:00 AM. */
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 23;

function enforceDeliveryWindow(date: Date, preferredHour?: number): Date {
  // date is already shifted to JST epoch (+9h)
  const hours = date.getUTCHours();
  const startHour = preferredHour ?? DEFAULT_START_HOUR;
  const endHour = DEFAULT_END_HOUR;

  if (hours >= startHour && hours < endHour) return date;

  // Outside window: push to next preferred start hour
  const result = new Date(date);
  if (hours >= endHour) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  result.setUTCHours(startHour, 0, 0, 0);
  return result;
}

export async function processStepDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl?: string,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  // Skip delivery outside 9:00-23:00 JST window
  const jstHour = new Date(Date.now() + 9 * 60 * 60_000).getUTCHours();
  if (jstHour < DEFAULT_START_HOUR || jstHour >= DEFAULT_END_HOUR) return;

  const now = jstNow();
  const dueFriendScenarios = await getFriendScenariosDueForDelivery(db, now);

  for (let i = 0; i < dueFriendScenarios.length; i++) {
    const fs = dueFriendScenarios[i];
    try {
      // Stealth: add small random delay between deliveries to avoid burst patterns
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }
      await processSingleDelivery(db, lineClient, fs, workerUrl, emailConfig);
    } catch (err) {
      console.error(`Error processing friend_scenario ${fs.id}:`, err);
      // Continue with next one
    }
  }
}

async function processSingleDelivery(
  db: D1Database,
  lineClient: LineClient,
  fs: {
    id: string;
    friend_id: string;
    scenario_id: string;
    current_step_order: number;
    status: string;
    next_delivery_at: string | null;
  },
  workerUrl?: string,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  // Get friend first to read preferred delivery hour from metadata
  const friend = await getFriendById(db, fs.friend_id);
  if (!friend || !friend.is_following) {
    await completeFriendScenario(db, fs.id);
    return;
  }
  // 既存ヘルパー parseMetadata で安全 parse (malformed/null/array 等で fallback to {})。
  // 直接 JSON.parse すると "null" / 配列 / 切り詰め JSON で TypeError → scenario が永久 stuck になる。
  const metadata = parseMetadata((friend as { metadata?: string | null }).metadata);
  const preferredHour = typeof metadata.preferred_hour === 'number' ? metadata.preferred_hour : undefined;

  // Get all steps for this scenario
  const steps = await getScenarioSteps(db, fs.scenario_id);
  if (steps.length === 0) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Steps are sorted by step_order but may not be contiguous (e.g., 1, 3, 5 after deletions).
  // Find the next step whose step_order > current_step_order.
  const currentStep = steps.find((s) => s.step_order > fs.current_step_order);

  if (!currentStep) {
    await completeFriendScenario(db, fs.id);
    return;
  }

  // Check step condition before sending
  if (currentStep.condition_type) {
    const conditionMet = await evaluateCondition(db, fs.friend_id, currentStep);
    if (!conditionMet) {
      if (currentStep.next_step_on_false !== null && currentStep.next_step_on_false !== undefined) {
        const jumpStep = steps.find((s) => s.step_order === currentStep.next_step_on_false);
        if (jumpStep) {
          const nextDate = new Date(Date.now() + 9 * 60 * 60_000);
          nextDate.setMinutes(nextDate.getMinutes() + jumpStep.delay_minutes);
          const windowedDate = enforceDeliveryWindow(nextDate, preferredHour);
          const jitteredDate = jitterDeliveryTime(windowedDate);
          await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
          return;
        }
      }
      const nextIndex = steps.indexOf(currentStep) + 1;
      if (nextIndex < steps.length) {
        const nextStep = steps[nextIndex];
        const nextDate = new Date(Date.now() + 9 * 60 * 60_000);
        nextDate.setMinutes(nextDate.getMinutes() + nextStep.delay_minutes);
        const windowedDate = enforceDeliveryWindow(nextDate, preferredHour);
        const jitteredDate = jitterDeliveryTime(windowedDate);
        await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
      } else {
        await completeFriendScenario(db, fs.id);
      }
      return;
    }
  }

  // Round 4 PR-6.2: route to channel-dispatcher when channel='email' / 'both'.
  // Default 'line' (or undefined for backward compat) keeps existing pushMessage path.
  const channel = currentStep.channel ?? 'line';

  if (channel === 'line') {
    await sendLineStep(db, lineClient, friend, currentStep, workerUrl);
  } else if (channel === 'email') {
    await sendEmailStep(db, friend, currentStep, emailConfig);
  } else {
    // 'both' — LINE と email は独立に試行する。LINE が throw しても email を
    // 送らないと「片方しか届かない」事故になるので、両者の失敗を吸収して進める。
    try {
      await sendLineStep(db, lineClient, friend, currentStep, workerUrl);
    } catch (err) {
      console.error(
        `[step-delivery] LINE step ${currentStep.id} failed for friend ${friend.id}; continuing with email:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
    }
    try {
      await sendEmailStep(db, friend, currentStep, emailConfig);
    } catch (err) {
      console.error(
        `[step-delivery] email step ${currentStep.id} failed for friend ${friend.id}:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
    }
  }

  // Determine next step (find the step after currentStep in the sorted list)
  const currentIndex = steps.indexOf(currentStep);
  const nextStep = currentIndex + 1 < steps.length ? steps[currentIndex + 1] : null;

  if (nextStep) {
    // Schedule next delivery with stealth jitter + delivery window enforcement
    const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
    nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + nextStep.delay_minutes);
    const windowedDate = enforceDeliveryWindow(nextDeliveryDate, preferredHour);
    const jitteredDate = jitterDeliveryTime(windowedDate);
    await advanceFriendScenario(db, fs.id, currentStep.step_order, jitteredDate.toISOString().slice(0, -1) + '+09:00');
  } else {
    // This was the last step
    await completeFriendScenario(db, fs.id);
  }
}

/**
 * Send a LINE step (existing pushMessage path, factored out so dispatcher logic
 * stays readable). Behavior is unchanged from before PR-6.2.
 */
async function sendLineStep(
  db: D1Database,
  lineClient: LineClient,
  friend: Friend,
  currentStep: ScenarioStep,
  workerUrl?: string,
): Promise<void> {
  // 5β-1d-2b: LINE 友だち追加時発行 coupon を DB から取得 (env なしで動く、 read-only)
  // 未発行なら null → expandVariables 内で空文字 + {{#if_coupon}} block 非表示
  let lineFriendCouponCode: string | null = null;
  try {
    lineFriendCouponCode = await getCouponCodeForFriend(db, friend.id);
  } catch (err) {
    // DB error は coupon を欠落させるだけ (caller 業務阻害なし)
    console.warn(
      '[step-delivery] getCouponCodeForFriend failed (continuing without coupon):',
      err instanceof Error ? err.message : String(err),
    );
  }
  // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}}, {{line_friend_coupon_code}}, etc.)
  const expandedContent = expandVariables(
    currentStep.message_content,
    { ...friend, line_friend_coupon_code: lineFriendCouponCode },
    workerUrl,
  );
  // Auto-wrap URLs with tracking links (text with URLs → Flex with button)
  let trackedType: string = currentStep.message_type;
  let trackedContent = expandedContent;
  if (workerUrl) {
    const { autoTrackContent } = await import('./auto-track.js');
    const tracked = await autoTrackContent(db, currentStep.message_type, expandedContent, workerUrl);
    trackedType = tracked.messageType;
    trackedContent = tracked.content;
  }
  const message = buildMessage(trackedType, trackedContent);
  await lineClient.pushMessage(friend.line_user_id, [message]);

  // Log outgoing message
  const logId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
       VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, ?)`,
    )
    .bind(logId, friend.id, currentStep.message_type, currentStep.message_content, currentStep.id, jstNow())
    .run();
}

/**
 * Send an email step via channel-dispatcher.
 *
 * fail-soft semantics: any "skip" condition (no config, missing template, no
 * email address) logs and returns. Caller advances the scenario regardless so
 * we never get stuck in a retry loop.
 */
async function sendEmailStep(
  db: D1Database,
  friend: Friend,
  currentStep: ScenarioStep,
  emailConfig?: EmailDispatchConfig | null,
): Promise<void> {
  if (!emailConfig) {
    console.warn(
      `[step-delivery] email step ${currentStep.id} skipped: emailConfig not set`,
    );
    return;
  }

  if (!currentStep.email_template_id) {
    console.error(
      `[step-delivery] email step ${currentStep.id} skipped: email_template_id missing`,
    );
    return;
  }

  const template = await getEmailTemplateById(db, currentStep.email_template_id);
  if (!template) {
    console.error(
      `[step-delivery] email step ${currentStep.id} skipped: template ${currentStep.email_template_id} not found`,
    );
    return;
  }
  if (!template.is_active) {
    console.error(
      `[step-delivery] email step ${currentStep.id} skipped: template ${template.id} inactive`,
    );
    return;
  }

  // Resolve email — prefer email_subscribers (active marketing list), fall
  // back to friends.email (identity column added by migration 032).
  const subscriberRow = await db
    .prepare(
      `SELECT email FROM email_subscribers
        WHERE friend_id = ? AND is_active = 1 LIMIT 1`,
    )
    .bind(friend.id)
    .first<{ email: string }>();

  const friendEmail =
    (friend as Friend & { email?: string | null }).email ?? null;
  const email = subscriberRow?.email ?? friendEmail;
  if (!email) {
    console.warn(
      `[step-delivery] email step ${currentStep.id} skipped: no email for friend ${friend.id}`,
    );
    return;
  }

  // EmailRenderer expands {{name}} via the variables map. We intentionally
  // pass display_name only — keeps parity with send_email automation action.
  const variables: Record<string, string> = {
    name: friend.display_name ?? '',
  };

  const deps: ChannelDispatcherDeps = {
    db,
    ...buildEmailDispatcherDeps(emailConfig),
  };

  await dispatch(deps, {
    recipient: {
      friend: { id: friend.id, lineUserId: friend.line_user_id },
      email,
    },
    channel: 'email',
    category: 'marketing',
    // step-delivery is scenario-driven, not a one-off broadcast — 'manual' is
    // the closest enum value (see EmailSourceKind).
    sourceKind: 'manual',
    emailPayload: {
      subjectTemplate: template.subject,
      htmlTemplate: template.html_content,
      textTemplate: template.text_content,
      preheader: template.preheader ?? undefined,
      variables,
      templateId: template.id,
    },
    source: { scenarioStepId: currentStep.id },
  });
}

async function evaluateCondition(
  db: D1Database,
  friendId: string,
  step: { condition_type: string | null; condition_value: string | null },
): Promise<boolean> {
  if (!step.condition_type || !step.condition_value) return true;

  switch (step.condition_type) {
    case 'tag_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !!tag;
    }
    case 'tag_not_exists': {
      const tag = await db
        .prepare('SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?')
        .bind(friendId, step.condition_value)
        .first();
      return !tag;
    }
    case 'metadata_equals': {
      const cond = parseConditionValue(step.condition_value);
      if (!cond) return false; // 不正 JSON / key 不在は条件不成立扱い
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = parseMetadata(friend?.metadata);
      return metadata[cond.key] === cond.value;
    }
    case 'metadata_not_equals': {
      const cond = parseConditionValue(step.condition_value);
      if (!cond) return false;
      const friend = await db
        .prepare('SELECT metadata FROM friends WHERE id = ?')
        .bind(friendId)
        .first<{ metadata: string }>();
      const metadata = parseMetadata(friend?.metadata);
      return metadata[cond.key] !== cond.value;
    }
    default:
      return true;
  }
}

/**
 * step.condition_value (JSON 文字列) を `{ key, value }` にパース。
 * 不正 JSON / key 不在 / 型不正の場合は null を返し、
 * 呼び出し側は条件不成立 (false) として扱う。
 */
function parseConditionValue(raw: string | null): { key: string; value: unknown } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'key' in parsed &&
      typeof (parsed as { key: unknown }).key === 'string'
    ) {
      const key = (parsed as { key: string }).key;
      const value = (parsed as { value?: unknown }).value;
      return { key, value };
    }
    return null;
  } catch {
    return null;
  }
}

/** friend.metadata (JSON 文字列) を安全に parse。 */
function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}


/** Remove empty text nodes from Flex JSON (caused by conditional blocks) */
function cleanEmptyNodes(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  const node = obj as Record<string, unknown>;
  for (const key of ['header', 'body', 'footer']) {
    if (node[key]) cleanEmptyNodes(node[key]);
  }
  if (Array.isArray(node.contents)) {
    node.contents = (node.contents as unknown[]).filter((c) => {
      if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
        const text = (c as Record<string, unknown>).text;
        return typeof text === 'string' && text.trim().length > 0;
      }
      return true;
    });
    for (const c of node.contents as unknown[]) cleanEmptyNodes(c);
  }
}

export function buildMessage(messageType: string, messageContent: string, altText?: string): Message {
  if (messageType === 'text') {
    return { type: 'text', text: messageContent };
  }

  if (messageType === 'image') {
    // messageContent is expected to be JSON: { originalContentUrl, previewImageUrl }
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
      // Fallback: treat as text if parsing fails
      return { type: 'text', text: messageContent };
    }
  }

  if (messageType === 'flex') {
    try {
      const contents = JSON.parse(messageContent);
      // Remove empty text nodes (from {{#if_ref}} conditional blocks)
      cleanEmptyNodes(contents);
      // Extract first text element for altText (shown in notifications)
      return { type: 'flex', altText: altText || extractFlexAltText(contents), contents };
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  // Quick Reply — テキスト + 選択肢ボタン
  // messageContent format: JSON { text: string, items: [{ label: string, text?: string, data?: string }] }
  if (messageType === 'quick_reply') {
    try {
      const parsed = JSON.parse(messageContent) as {
        text: string;
        items: Array<{ label: string; text?: string; data?: string }>;
      };
      const quickReplyItems = parsed.items.map((item) => {
        if (item.data) {
          // Postback action
          return {
            type: 'action' as const,
            action: { type: 'postback' as const, label: item.label, data: item.data, displayText: item.label },
          };
        }
        // Message action
        return {
          type: 'action' as const,
          action: { type: 'message' as const, label: item.label, text: item.text || item.label },
        };
      });
      return {
        type: 'text',
        text: parsed.text,
        quickReply: { items: quickReplyItems },
      } as Message;
    } catch {
      return { type: 'text', text: messageContent };
    }
  }

  // Fallback
  return { type: 'text', text: messageContent };
}
