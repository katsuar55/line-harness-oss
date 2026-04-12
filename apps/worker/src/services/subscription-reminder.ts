/**
 * Subscription Reminder Service — 定期購買リマインダー
 *
 * Cron で5分ごとに実行し、next_reminder_at が過去の
 * アクティブなリマインダーに対して LINE push を送信。
 * 送信後、次回リマインド日時を interval_days 分進める。
 */

import type { LineClient } from '@line-crm/line-sdk';

interface ReminderRow {
  id: string;
  friend_id: string;
  product_title: string;
  interval_days: number;
  next_reminder_at: string;
}

export async function processSubscriptionReminders(
  db: D1Database,
  lineClient: LineClient,
  liffUrl: string,
): Promise<void> {
  const now = new Date().toISOString();

  // 1. Get due reminders
  const { results: dueReminders } = await db
    .prepare(
      `SELECT sr.id, sr.friend_id, sr.product_title, sr.interval_days, sr.next_reminder_at
       FROM subscription_reminders sr
       WHERE sr.is_active = 1 AND sr.next_reminder_at <= ?
       LIMIT 50`,
    )
    .bind(now)
    .all<ReminderRow>();

  if (!dueReminders || dueReminders.length === 0) return;

  for (const reminder of dueReminders) {
    try {
      // 2. Get friend's LINE user ID
      const friend = await db
        .prepare('SELECT line_user_id FROM friends WHERE id = ?')
        .bind(reminder.friend_id)
        .first<{ line_user_id: string }>();

      if (!friend?.line_user_id) continue;

      // 3. Check notification preference
      const prefs = await db
        .prepare('SELECT reorder_reminder FROM friend_notification_preferences WHERE friend_id = ?')
        .bind(reminder.friend_id)
        .first<{ reorder_reminder: number }>();

      // Default ON if no prefs record
      if (prefs && !prefs.reorder_reminder) continue;

      // 4. Send LINE push message
      const reorderUrl = liffUrl ? `${liffUrl}?page=reorder` : '';
      const message = {
        type: 'flex' as const,
        altText: `${reminder.product_title}の再購入時期です`,
        contents: {
          type: 'bubble',
          size: 'kilo',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              {
                type: 'text',
                text: '🔔 再購入のお知らせ',
                weight: 'bold',
                size: 'md',
                color: '#059669',
              },
              {
                type: 'text',
                text: `${reminder.product_title}の再購入時期になりました。`,
                size: 'sm',
                color: '#555555',
                wrap: true,
              },
              {
                type: 'text',
                text: `${reminder.interval_days}日サイクルで設定中`,
                size: 'xs',
                color: '#999999',
              },
            ],
          },
          footer: reorderUrl
            ? {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    action: {
                      type: 'uri',
                      label: 'ワンタッチで再注文',
                      uri: reorderUrl,
                    },
                    style: 'primary',
                    color: '#06C755',
                  },
                ],
              }
            : undefined,
        },
      };

      await lineClient.pushMessage(friend.line_user_id, [message]);

      // 5. Update next_reminder_at
      const nextAt = new Date(Date.now() + reminder.interval_days * 86400000).toISOString();
      await db
        .prepare('UPDATE subscription_reminders SET next_reminder_at = ?, last_sent_at = ?, updated_at = ? WHERE id = ?')
        .bind(nextAt, now, now, reminder.id)
        .run();
    } catch {
      // Continue with next reminder on failure
    }
  }
}
