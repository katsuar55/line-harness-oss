/**
 * 週次レポート配信処理 — Cronトリガーで毎週月曜に実行
 *
 * 全アクティブ友だちに服用率・体調サマリーをFlex Messageで送信
 * 薬機法準拠: 効能効果の断定なし
 */

import { getIntakeStreak, getHealthSummary, jstNow } from '@line-crm/db';
import type { LineClient } from '@line-crm/line-sdk';
import { addJitter, sleep } from './stealth.js';

// 既存 altText "📋 ${name}さんの週次レポート" に含まれる固有フレーズをマーカーとして再利用
const WEEKLY_REPORT_MARKER = 'さんの週次レポート';
const DEDUP_WINDOW_DAYS = 6;

function getJstDayOfWeek(jstIso: string): number {
  const dateStr = jstIso.slice(0, 10);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * メイン処理: 月曜日のみ実行 → 全フォロー中の友だちにレポート送信
 * 同一週内で既送のfriendは必ずスキップ（cron多重発火でも1回まで）。
 */
export async function processWeeklyReports(
  db: D1Database,
  lineClient: LineClient,
): Promise<{ sent: number; skipped: number; errors: number }> {
  const now = jstNow();
  const dayOfWeek = getJstDayOfWeek(now);

  if (dayOfWeek !== 1) {
    return { sent: 0, skipped: 0, errors: 0 };
  }

  const { results: friends } = await db
    .prepare(
      `SELECT id, line_user_id, display_name
       FROM friends
       WHERE is_following = 1
       ORDER BY created_at ASC
       LIMIT 5000`,
    )
    .all<{ id: string; line_user_id: string; display_name: string | null }>();

  const dedupCutoff = new Date(new Date(now).getTime() - DEDUP_WINDOW_DAYS * 86_400_000).toISOString();
  const { results: recentRows } = await db
    .prepare(
      `SELECT DISTINCT friend_id
       FROM messages_log
       WHERE direction = 'outgoing'
         AND message_type = 'flex'
         AND content LIKE ?
         AND created_at > ?`,
    )
    .bind(`%${WEEKLY_REPORT_MARKER}%`, dedupCutoff)
    .all<{ friend_id: string }>();
  const alreadySent = new Set(recentRows.map((r) => r.friend_id));

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < friends.length; i++) {
    const friend = friends[i];

    if (alreadySent.has(friend.id)) {
      skipped++;
      continue;
    }

    try {
      const streak = await getIntakeStreak(db, friend.id);
      const health = await getHealthSummary(db, friend.id);

      if ((!streak || streak.totalDays === 0) && health.totalLogs === 0) {
        skipped++;
        continue;
      }

      // ステルス: バースト回避
      if (i > 0) {
        await sleep(addJitter(50, 200));
      }

      const message = buildWeeklyReportMessage(
        friend.display_name,
        streak,
        health,
      );

      await lineClient.pushMessage(friend.line_user_id, [message]);

      // ログ記録
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, created_at)
           VALUES (?, ?, 'outgoing', 'flex', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, JSON.stringify(message), now)
        .run();

      sent++;
    } catch (err) {
      console.error(`Weekly report error for ${friend.id}:`, err);
      errors++;
    }
  }

  if (sent > 0 || errors > 0) {
    console.info(`Weekly reports: sent=${sent}, skipped=${skipped}, errors=${errors}`);
  }

  return { sent, skipped, errors };
}

/**
 * 週次レポートFlex Message組み立て
 */
function buildWeeklyReportMessage(
  displayName: string | null,
  streak: { currentStreak: number; longestStreak: number; totalDays: number } | null,
  health: { totalLogs: number; avgWeight: number | null; goodDays: number; normalDays: number; badDays: number; latestWeight: number | null },
): { type: 'flex'; altText: string; contents: Record<string, unknown> } {
  const name = displayName || 'ユーザー';
  const currentStreak = streak?.currentStreak ?? 0;
  const totalDays = streak?.totalDays ?? 0;

  // 服用率（直近7日）
  const intakeRate = totalDays > 0 ? Math.min(100, Math.round((Math.min(currentStreak, 7) / 7) * 100)) : 0;

  // 体調スコア
  const totalHealthDays = health.goodDays + health.normalDays + health.badDays;
  const conditionText = totalHealthDays > 0
    ? `良い ${health.goodDays}日 / 普通 ${health.normalDays}日 / 不調 ${health.badDays}日`
    : '記録なし';

  // 励ましメッセージ
  let encouragement: string;
  if (intakeRate >= 80) {
    encouragement = '素晴らしい1週間でした！この調子で続けましょう。';
  } else if (intakeRate >= 50) {
    encouragement = '良いペースです。もう少し習慣化できるといいですね。';
  } else if (intakeRate > 0) {
    encouragement = '少しずつでも続けることが大切です。今週も一緒にがんばりましょう！';
  } else {
    encouragement = '今週からnaturismを始めてみませんか？';
  }

  const bodyContents: Record<string, unknown>[] = [
    {
      type: 'text',
      text: `${name}さんの週次レポート`,
      weight: 'bold',
      size: 'md',
      color: '#1e293b',
    },
    { type: 'separator', margin: 'lg', color: '#e2e8f0' },
    // 服用セクション
    {
      type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm',
      contents: [
        { type: 'text', text: '\u{1F48A} 服用状況', size: 'sm', weight: 'bold', color: '#15803d' },
        {
          type: 'box', layout: 'horizontal', margin: 'sm',
          contents: [
            { type: 'text', text: '今週の服用率', size: 'xs', color: '#64748b', flex: 4 },
            { type: 'text', text: `${intakeRate}%`, size: 'sm', weight: 'bold', color: '#06C755', flex: 2, align: 'end' },
          ],
        },
        {
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '連続日数', size: 'xs', color: '#64748b', flex: 4 },
            { type: 'text', text: `${currentStreak}日`, size: 'sm', weight: 'bold', color: '#1e293b', flex: 2, align: 'end' },
          ],
        },
        {
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '累計記録', size: 'xs', color: '#64748b', flex: 4 },
            { type: 'text', text: `${totalDays}日`, size: 'sm', color: '#1e293b', flex: 2, align: 'end' },
          ],
        },
      ],
    },
  ];

  // 体調セクション（データがある場合のみ）
  if (totalHealthDays > 0) {
    bodyContents.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
    bodyContents.push({
      type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm',
      contents: [
        { type: 'text', text: '\u{1F4CA} 体調サマリー', size: 'sm', weight: 'bold', color: '#15803d' },
        {
          type: 'box', layout: 'horizontal', margin: 'sm',
          contents: [
            { type: 'text', text: '今週の体調', size: 'xs', color: '#64748b', flex: 4 },
            { type: 'text', text: conditionText, size: 'xs', color: '#1e293b', flex: 6, wrap: true, align: 'end' },
          ],
        },
        ...(health.latestWeight ? [{
          type: 'box', layout: 'horizontal',
          contents: [
            { type: 'text', text: '最新体重', size: 'xs', color: '#64748b', flex: 4 },
            { type: 'text', text: `${health.latestWeight}kg`, size: 'sm', color: '#1e293b', flex: 2, align: 'end' },
          ],
        }] : []),
      ],
    });
  }

  // 励まし
  bodyContents.push({ type: 'separator', margin: 'lg', color: '#e2e8f0' });
  bodyContents.push({
    type: 'text', text: encouragement, size: 'xs', color: '#64748b',
    wrap: true, margin: 'lg',
  });

  return {
    type: 'flex',
    altText: `\u{1F4CB} ${name}さんの週次レポート`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box', layout: 'horizontal',
        backgroundColor: '#06C755', paddingAll: '12px',
        contents: [
          { type: 'text', text: '\u{1F4CB}', size: 'sm', flex: 0 },
          { type: 'text', text: 'naturism 週次レポート',
            size: 'xs', color: '#ffffff', weight: 'bold',
            gravity: 'center', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical',
        contents: bodyContents,
        paddingAll: '16px',
      },
    },
  };
}
