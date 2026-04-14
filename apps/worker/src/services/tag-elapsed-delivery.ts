/**
 * タグ付与日起点の日数経過トリガー配信 — Cron ジョブ
 *
 * tag_elapsed_deliveries テーブルに登録されたルールに基づき、
 * 特定タグを付与されてから N 日経過した友だちに自動メッセージを送信。
 *
 * 例: "初回購入" タグ付与の7日後にリピート促進メッセージを配信
 */

import { jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { buildMessage } from './step-delivery.js';

interface ElapsedRule {
  id: string;
  trigger_tag_id: string;
  elapsed_days: number;
  message_type: string;
  message_content: string;
  send_hour: number;
}

interface FriendTarget {
  friend_id: string;
  line_user_id: string;
  assigned_at: string;
}

export async function processTagElapsedDeliveries(
  db: D1Database,
  lineClient: LineClient,
  workerUrl: string,
): Promise<{ sent: number; skipped: number; errors: number }> {
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  // 現在時刻を確認（配信時間帯チェック用）
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;

  // アクティブなルールを取得
  const rules = (
    await db
      .prepare('SELECT * FROM tag_elapsed_deliveries WHERE is_active = 1')
      .all<ElapsedRule>()
  ).results;

  if (rules.length === 0) return { sent, skipped, errors };

  for (const rule of rules) {
    // 配信時間帯チェック（±1時間の余裕、Cronが5分毎なので）
    if (Math.abs(jstHour - rule.send_hour) > 0) {
      continue;
    }

    // N日前の日付を計算
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - rule.elapsed_days);
    const targetDateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD

    // 対象となる友だちを検索:
    // - 指定タグを持っている
    // - assigned_at が N日前（日付一致）
    // - まだこの配信を受けていない
    // - フォロー中 & ブラックリストでない
    const targets = (
      await db
        .prepare(
          `SELECT ft.friend_id, f.line_user_id, ft.assigned_at
           FROM friend_tags ft
           JOIN friends f ON f.id = ft.friend_id
           LEFT JOIN tag_elapsed_delivery_logs log
             ON log.delivery_id = ? AND log.friend_id = ft.friend_id
           WHERE ft.tag_id = ?
             AND date(ft.assigned_at) = ?
             AND log.id IS NULL
             AND f.is_following = 1
             AND COALESCE(f.is_blacklisted, 0) = 0
           LIMIT 100`,
        )
        .bind(rule.id, rule.trigger_tag_id, targetDateStr)
        .all<FriendTarget>()
    ).results;

    for (const target of targets) {
      try {
        const message = buildMessage(rule.message_type, rule.message_content);
        await lineClient.pushMessage(target.line_user_id, [message]);

        // 配信ログ記録（重複防止）
        const logId = `${rule.id}_${target.friend_id}`;
        await db
          .prepare(
            'INSERT OR IGNORE INTO tag_elapsed_delivery_logs (id, delivery_id, friend_id, sent_at) VALUES (?, ?, ?, ?)',
          )
          .bind(logId, rule.id, target.friend_id, jstNow())
          .run();

        sent++;
      } catch (err) {
        console.error(`Tag elapsed delivery failed (rule=${rule.id}, friend=${target.friend_id}):`, err);
        errors++;
      }
    }

    skipped += 0; // targets not matched are simply not selected
  }

  if (sent > 0 || errors > 0) {
    console.info(`Tag elapsed deliveries: sent=${sent} errors=${errors}`);
  }

  return { sent, skipped, errors };
}
