/**
 * 服用リマインダー配信処理 — Cronトリガーで5分毎に実行
 *
 * intake_reminders テーブルから配信対象を取得し、
 * LINE Messaging API でプッシュ通知を送信する。
 *
 * 複数リマインダー対応:
 * - 1ユーザーが複数時刻を設定可能（朝食前/昼食前/夕食前 etc）
 * - 各リマインダーごとに last_sent_at で1日1回制限
 *
 * メッセージテンプレート対応:
 * - reminder_messages テーブルから時間帯別にランダム取得
 * - 過去送信済みメッセージを回避（年間重複なし）
 * - テンプレートが未登録の場合はフォールバックメッセージ使用
 */

import {
  getActiveIntakeReminders,
  updateReminderLastSent,
  getFriendById,
  getIntakeStreak,
  pickReminderMessage,
  logReminderMessage,
  jstNow,
} from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { addJitter, sleep } from './stealth.js';

/**
 * 時刻(HH:MM)から時間帯を判定
 */
function getTimeSlot(time: string): 'morning' | 'noon' | 'evening' {
  const hour = parseInt(time.slice(0, 2), 10);
  if (hour < 11) return 'morning';
  if (hour < 16) return 'noon';
  return 'evening';
}

/**
 * 時間帯に応じた挨拶
 */
function getGreeting(timeSlot: 'morning' | 'noon' | 'evening'): string {
  switch (timeSlot) {
    case 'morning': return 'おはようございます！';
    case 'noon': return 'お昼の時間です！';
    case 'evening': return 'こんばんは！';
  }
}

/**
 * メイン処理: 配信対象のリマインダーを取得しプッシュ送信
 */
export async function processIntakeReminders(
  db: D1Database,
  lineClient: LineClient,
  liffUrl?: string,
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

      // 時間帯判定
      const timeSlot = getTimeSlot(reminder.reminder_time);

      // テンプレートメッセージ取得（重複回避つき）
      const templateMsg = await pickReminderMessage(db, reminder.friend_id, timeSlot);

      // streak情報
      const streak = await getIntakeStreak(db, reminder.friend_id);
      const message = buildReminderMessage(streak, liffUrl, timeSlot, templateMsg?.message ?? null);

      await lineClient.pushMessage(friend.line_user_id, [message]);
      await updateReminderLastSent(db, reminder.id);

      // テンプレート送信履歴を記録
      if (templateMsg) {
        await logReminderMessage(db, reminder.friend_id, templateMsg.id);
      }

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
 * リマインドメッセージ組み立て
 *
 * テンプレートメッセージがある場合はそれを使用、
 * なければフォールバック（streak応援メッセージ）
 *
 * 薬機法準拠: 効能効果の断定なし
 */
function buildReminderMessage(
  streak: { currentStreak: number; longestStreak: number; totalDays: number } | null,
  liffUrl: string | undefined,
  timeSlot: 'morning' | 'noon' | 'evening',
  templateMessage: string | null,
): { type: 'flex'; altText: string; contents: Record<string, unknown> } {
  const currentStreak = streak?.currentStreak ?? 0;
  const totalDays = streak?.totalDays ?? 0;

  const greeting = getGreeting(timeSlot);

  // streakに応じた絵文字
  let emoji: string;
  if (currentStreak >= 30) {
    emoji = '\u{1F525}'; // fire
  } else if (currentStreak >= 7) {
    emoji = '\u2B50'; // star
  } else if (currentStreak >= 3) {
    emoji = '\u{1F331}'; // seedling
  } else {
    emoji = '\u{1F48A}'; // pill
  }

  // メインメッセージ: テンプレートがあればそれ、なければstreak応援
  let mainText: string;
  if (templateMessage) {
    mainText = templateMessage;
  } else if (currentStreak >= 30) {
    mainText = `${currentStreak}日連続達成！素晴らしい継続力ですね。`;
  } else if (currentStreak >= 7) {
    mainText = `${currentStreak}日連続！良い調子ですね。`;
  } else if (currentStreak >= 3) {
    mainText = `${currentStreak}日連続！習慣になってきましたね。`;
  } else if (totalDays > 0) {
    mainText = 'また今日も一緒にがんばりましょう。';
  } else {
    mainText = '忘れずにnaturismを飲みましょう。';
  }

  return {
    type: 'flex',
    altText: `${emoji} naturism リマインド`,
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
            text: `${emoji} ${greeting}`,
            weight: 'bold',
            size: 'md',
            color: '#06C755',
          },
          {
            type: 'text',
            text: mainText,
            size: 'sm',
            color: '#666666',
            wrap: true,
          },
          ...(totalDays > 0
            ? [
                {
                  type: 'text',
                  text: `🔥 ${currentStreak}日連続 ・ 累計 ${totalDays}日`,
                  size: 'xs',
                  color: '#999999',
                  margin: 'sm',
                },
              ]
            : []),
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '服用を記録する',
              uri: liffUrl ? `${liffUrl}?tab=intake` : 'https://liff.line.me/',
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
