/**
 * かご落ちリカバリー配信 — Cron ジョブ
 *
 * abandoned_carts テーブルで status='pending' かつ
 * notification_scheduled_at を過ぎたレコードを検出し、
 * LINE プッシュメッセージを送信する。
 *
 * 送信後に status を 'notified' に更新。
 * friend_id が無いレコード（メールマッチ未成立）はスキップ。
 */

import {
  getPendingAbandonedCarts,
  updateAbandonedCartStatus,
  jstNow,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';

interface CartRow {
  id: string;
  friend_id: string | null;
  email: string | null;
  line_items: string;
  total_price: number;
  currency: string;
  checkout_url: string | null;
}

export async function processAbandonedCartNotifications(
  db: D1Database,
  lineClient: LineClient,
  liffUrl: string,
): Promise<{ sent: number; skipped: number; errors: number }> {
  const now = jstNow();
  const pendingCarts = (await getPendingAbandonedCarts(db, now)) as CartRow[];

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const cart of pendingCarts) {
    // friend_id が無い場合はスキップ（LINE友だちとマッチしていない）
    if (!cart.friend_id) {
      skipped++;
      continue;
    }

    try {
      // LINE user ID を取得
      const friend = await db
        .prepare('SELECT line_user_id, is_following FROM friends WHERE id = ? AND is_following = 1')
        .bind(cart.friend_id)
        .first<{ line_user_id: string; is_following: number }>();

      if (!friend) {
        skipped++;
        continue;
      }

      // ブラックリストチェック
      const bl = await db
        .prepare('SELECT is_blacklisted FROM friends WHERE id = ?')
        .bind(cart.friend_id)
        .first<{ is_blacklisted: number }>();
      if (bl?.is_blacklisted) {
        skipped++;
        continue;
      }

      // 商品名を抽出
      let itemSummary = 'カートの商品';
      try {
        const items = JSON.parse(cart.line_items || '[]') as Array<{ title?: string }>;
        if (items.length > 0 && items[0].title) {
          itemSummary = items.length === 1
            ? items[0].title
            : `${items[0].title} 他${items.length - 1}点`;
        }
      } catch { /* parse error — use default */ }

      // メッセージ送信
      const price = cart.total_price ? `¥${Math.round(cart.total_price).toLocaleString()}` : '';
      const checkoutLink = cart.checkout_url || `${liffUrl}#reorder`;
      const message = [
        `お買い忘れはありませんか？`,
        ``,
        `「${itemSummary}」${price ? `（${price}）` : ''}がカートに残っています。`,
        ``,
        `▼ お買い物を続ける`,
        checkoutLink,
      ].join('\n');

      await lineClient.pushMessage(friend.line_user_id, [{ type: 'text', text: message }]);

      await updateAbandonedCartStatus(db, cart.id, 'notified', { notifiedAt: now });
      sent++;
    } catch (err) {
      console.error(`Abandoned cart notification failed (id=${cart.id}):`, err);
      errors++;
    }
  }

  if (sent > 0 || errors > 0) {
    console.info(`Abandoned cart notifications: sent=${sent} skipped=${skipped} errors=${errors}`);
  }

  return { sent, skipped, errors };
}
