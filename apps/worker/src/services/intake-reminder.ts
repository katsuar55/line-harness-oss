/**
 * 服用リマインダー配信処理 — Cronトリガーで5分毎に実行
 *
 * intake_reminders テーブルから配信対象を取得し、
 * LINE Messaging API でプッシュ通知を送信する。
 *
 * 条件:
 * - is_active = 1
 * - friends.is_following = 1
 * - reminder_time <= 現在時刻(HH:MM)
 * - last_sent_at < 今日 (1日1回のみ)
 * - snooze_until が null または過去
 */

import {
  getActiveIntakeReminders,
  updateReminderLastSent,
  getFriendById,
  getIntakeStreak,
  jstNow,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { addJitter, sleep } from './stealth.js';

/**
 * メイン処理: 配信対象のリマインダーを取得しプッシュ送信
 */
export async function processIntakeReminders(
  db: D1Database,
  lineClient: LineClient,
): Promise<{ sent: number; skipped: number; errors: number }> {
  const now = jstNow();
  const currentTime = now.slice(11, 16); // "HH:MM"

  const dueReminders = await getActiveIntakeReminders(db, currentTime);

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < dueReminders.length; i++) {
    const reminder = dueReminders[i];

    try {
      // スヌーズチェック
      if (reminder.snooze_until) {
        const snoozeTime = new Date(reminder.snooze_until).getTime();
        const nowTime = new Date(now).getTime();
        if (snoozeTime > nowTime) {
          skipped++;
          continue;
        }
      }

      // ステルス: バースト回避のランダム遅延
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }

      const friend = await getFriendById(db, reminder.friend_id);
      if (!friend || !friend.is_following) {
        skipped++;
        continue;
      }

      // streak情報を取得してメッセージをパーソナライズ
      const streak = await getIntakeStreak(db, reminder.friend_id);
      const message = buildReminderMessage(streak);

      await lineClient.pushMessage(friend.line_user_id, [message]);
      await updateReminderLastSent(db, reminder.id);

      // メッセージログに記録
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
           VALUES (?, ?, 'outgoing', 'flex', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          reminder.friend_id,
          JSON.stringify(message),
          now,
        )
        .run();

      sent++;
    } catch (err) {
      console.error(`Intake reminder error for ${reminder.friend_id}:`, err);
      errors++;
    }
  }

  if (sent > 0 || errors > 0) {
    console.log(`Intake reminders: sent=${sent}, skipped=${skipped}, errors=${errors}`);
  }

  return { sent, skipped, errors };
}

/**
 * streak情報に基づくパーソナライズされたリマインドメッセージ
 * 薬機法準拠: 効能効果の断定なし
 */
function buildReminderMessage(
  streak: { currentStreak: number; longestStreak: number; totalDays: number } | null,
): { type: 'flex'; altText: string; contents: Record<string, unknown> } {
  const currentStreak = streak?.currentStreak ?? 0;
  const totalDays = streak?.totalDays ?? 0;

  // streakに応じた応援メッセージ
  let encouragement: string;
  let emoji: string;

  if (currentStreak >= 30) {
    emoji = '\u{1F525}'; // fire
    encouragement = `${currentStreak}日連続達成！素晴らしい継続力ですね。`;
  } else if (currentStreak >= 7) {
    emoji = '\u2B50'; // star
    encouragement = `${currentStreak}日連続！良い調子ですね。`;
  } else if (currentStreak >= 3) {
    emoji = '\u{1F331}'; // seedling
    encouragement = `${currentStreak}日連続！習慣になってきましたね。`;
  } else if (totalDays > 0) {
    emoji = '\u{1F44B}'; // wave
    encouragement = 'また今日も一緒にがんばりましょう。';
  } else {
    emoji = '\u{1F48A}'; // pill
    encouragement = '今日からnaturismを始めてみませんか？';
  }

  return {
    type: 'flex',
    altText: `${emoji} naturism 服用リマインド`,
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
            text: `${emoji} おはようございます！`,
            weight: 'bold',
            size: 'md',
            color: '#06C755',
          },
          {
            type: 'text',
            text: encouragement,
            size: 'sm',
            color: '#666666',
            wrap: true,
          },
          {
            type: 'text',
            text: `累計 ${totalDays}日の記録があります`,
            size: 'xs',
            color: '#999999',
            margin: 'sm',
          },
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '服用を記録する',
              uri: 'https://liff.line.me/', // LIFF URLはCron時に利用できないのでプレースホルダ
            },
            style: 'primary',
            color: '#06C755',
            margin: 'lg',
            height: 'sm',
          },
        ],
      },
    },
  };
}
