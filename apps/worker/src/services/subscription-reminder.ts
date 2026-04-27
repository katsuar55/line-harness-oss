/**
 * Subscription Reminder Service — 定期購買リマインダー
 *
 * Cron で5分ごとに実行し、next_reminder_at が過去の
 * アクティブなリマインダーに対して LINE push を送信。
 * 送信後、次回リマインド日時を interval_days 分進める。
 *
 * Phase 6 PR-3: shopify_product_id がセットされていれば、
 * `purchase_cross_sell_map` から最大 2 件のクロスセル候補を
 * Flex bubble の body に追加する。
 */

import type { LineClient } from '@line-crm/line-sdk';
import { getCrossSellSuggestions } from '@line-crm/db';

interface ReminderRow {
  id: string;
  friend_id: string;
  product_title: string;
  interval_days: number;
  next_reminder_at: string;
  shopify_product_id: string | null;
}

interface CrossSellEntry {
  recommendedProductId: string;
  recommendedTitle: string;
  reason: string | null;
}

/**
 * クロスセル候補の取得 + 商品タイトル解決。
 * 商品タイトルが取れない場合は recommended_product_id を fallback として使う。
 */
async function loadCrossSellEntries(
  db: D1Database,
  sourceProductId: string,
  limit = 2,
): Promise<CrossSellEntry[]> {
  const rules = await getCrossSellSuggestions(db, sourceProductId, { limit });
  if (rules.length === 0) return [];

  const entries: CrossSellEntry[] = [];
  for (const rule of rules) {
    let title = rule.recommended_product_id;
    try {
      const row = await db
        .prepare('SELECT title FROM shopify_products WHERE shopify_product_id = ? LIMIT 1')
        .bind(rule.recommended_product_id)
        .first<{ title: string }>();
      if (row?.title) title = row.title;
    } catch {
      // best-effort: fallback to product id
    }
    entries.push({
      recommendedProductId: rule.recommended_product_id,
      recommendedTitle: title,
      reason: rule.reason,
    });
  }
  return entries;
}

/**
 * クロスセル候補を bubble body に追加するためのコンポーネントを生成。
 * 候補がなければ空配列を返す。
 */
export function buildCrossSellComponents(entries: CrossSellEntry[]): unknown[] {
  if (entries.length === 0) return [];
  const items: unknown[] = [
    { type: 'separator', margin: 'md' },
    {
      type: 'text',
      text: '🎁 こちらもおすすめ',
      weight: 'bold',
      size: 'sm',
      color: '#0EA5E9',
      margin: 'md',
    },
  ];
  for (const e of entries) {
    items.push({
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      margin: 'sm',
      contents: [
        {
          type: 'text',
          text: `・${e.recommendedTitle}`,
          size: 'sm',
          color: '#374151',
          wrap: true,
        },
        ...(e.reason
          ? [
              {
                type: 'text',
                text: e.reason,
                size: 'xxs',
                color: '#9CA3AF',
                wrap: true,
              },
            ]
          : []),
      ],
    });
  }
  return items;
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
      `SELECT sr.id, sr.friend_id, sr.product_title, sr.interval_days,
              sr.next_reminder_at, sr.shopify_product_id
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

      // 4. Cross-sell suggestions (best-effort)
      let crossSellEntries: CrossSellEntry[] = [];
      if (reminder.shopify_product_id) {
        try {
          crossSellEntries = await loadCrossSellEntries(db, reminder.shopify_product_id, 2);
        } catch {
          // ignore — message goes out without cross-sell
        }
      }

      // 5. Send LINE push message
      const reorderUrl = liffUrl ? `${liffUrl}?page=reorder` : '';
      const bodyContents: unknown[] = [
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
        ...buildCrossSellComponents(crossSellEntries),
      ];

      const message = {
        type: 'flex' as const,
        altText: `${reminder.product_title}の再購入時期です`,
        contents: {
          type: 'bubble',
          size: crossSellEntries.length > 0 ? 'mega' : 'kilo',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: bodyContents,
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

      // 6. Update next_reminder_at
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
