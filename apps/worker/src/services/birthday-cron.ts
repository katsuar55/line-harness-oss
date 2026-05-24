/**
 * Birthday cron (Phase 2.2 雛形、 2026-05-24)
 *
 * 役割:
 *   毎月 1 日 10:00 JST 前後に、 friends.birth_month = 現在月 の friend に
 *   「お誕生月おめでとうございます🎉」 + 特別 flex (= 誕生月限定特典案内) を push する。
 *
 * 設計原則:
 *   - **gating**: JST current month の 1 日 10:00-10:04 (= 5 分 cron 1 window) のみ実行
 *     (= 5 分 cron で毎月 1 回だけ trigger、 同じ window 内で複数 cron 走っても idempotent)
 *   - **idempotent**: 同 friend に同月複数回 push しないため、 friend_metadata に
 *     `birthday_greeting_sent_YYYY_MM` キーを記録、 既送なら skip
 *   - **fail-safe**: 個別 friend の push 失敗は errors count + continue (= 他 friend に影響しない)
 *   - **cost zero でない**: push 1 通/friend (= LINE API 課金)、 ただし誕生月の特別感 marketing 優先
 *
 * 環境変数:
 *   - `BIRTHDAY_CRON_FORCE='true'` で月初 gating を bypass (= テスト/手動 trigger 用)
 *
 * 関連:
 *   - apps/worker/src/services/welcome-postback.ts (= birth_month 取得元、 migration 052)
 *   - packages/db/migrations/052_friend_demographics.sql (= birth_month column)
 *   - apps/worker/src/services/audit-logger.ts (= audit_log)
 *   - apps/worker/src/index.ts (= scheduled handler から呼出)
 */

import { LineClient } from '@line-crm/line-sdk';
import type { Message, FlexContainer } from '@line-crm/line-sdk';
import { auditSystem } from './audit-logger.js';

interface BirthdayFriend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  line_account_id: string | null;
  metadata: string | null;
}

export interface BirthdayCronResult {
  readonly month: number;
  readonly skippedDueToGating: boolean;
  readonly candidates: number;
  readonly sent: number;
  readonly alreadySent: number;
  readonly errors: number;
}

interface BirthdayCronEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  BIRTHDAY_CRON_FORCE?: string;
}

interface ProcessOptions {
  /** test 用に「現在時刻」 を override 可能 (= Date 渡せば JST 換算は内部で) */
  now?: Date;
  /** test 用に LineClient mock を inject */
  lineClientFactory?: (accessToken: string) => Pick<LineClient, 'pushMessage'>;
}

/**
 * birthday cron entry point (= scheduled handler から呼出)。
 *
 * 月初 1 日 10:00 JST ± 5 分 のみ実行、 それ以外は skip (= gating)。
 * gating bypass: BIRTHDAY_CRON_FORCE='true'
 *
 * @returns 集計結果 (= skippedDueToGating / candidates / sent / alreadySent / errors)
 */
export async function processBirthdayGreetings(
  env: BirthdayCronEnv,
  options: ProcessOptions = {},
): Promise<BirthdayCronResult> {
  const now = options.now ?? new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstDay = jst.getUTCDate();
  const jstHour = jst.getUTCHours();
  const jstMinute = jst.getUTCMinutes();
  const jstMonth = jst.getUTCMonth() + 1; // 1-12

  const isGatingWindow = jstDay === 1 && jstHour === 10 && jstMinute < 5;
  const forceRun = env.BIRTHDAY_CRON_FORCE === 'true';

  if (!isGatingWindow && !forceRun) {
    return {
      month: jstMonth,
      skippedDueToGating: true,
      candidates: 0,
      sent: 0,
      alreadySent: 0,
      errors: 0,
    };
  }

  // SELECT 候補 friend (= 該当月 + following + 非 blacklist)
  const candidates = await env.DB
    .prepare(
      `SELECT id, line_user_id, display_name, line_account_id, metadata
       FROM friends
       WHERE birth_month = ?
         AND is_following = 1
         AND is_blacklisted = 0`,
    )
    .bind(jstMonth)
    .all<BirthdayFriend>();

  const rows = candidates.results ?? [];
  if (rows.length === 0) {
    return {
      month: jstMonth,
      skippedDueToGating: false,
      candidates: 0,
      sent: 0,
      alreadySent: 0,
      errors: 0,
    };
  }

  // 既送マーカー (= friend_metadata の同月 key)
  const metadataKey = `birthday_greeting_sent_${jst.getUTCFullYear()}_${String(jstMonth).padStart(2, '0')}`;

  const lineClientFactory =
    options.lineClientFactory ?? ((token: string) => new LineClient(token));
  const lineClient = lineClientFactory(env.LINE_CHANNEL_ACCESS_TOKEN);

  let sent = 0;
  let alreadySent = 0;
  let errors = 0;

  for (const friend of rows) {
    // 既送 check (= metadata に同月 key)
    const meta = parseMetadata(friend.metadata);
    if (meta[metadataKey] === true) {
      alreadySent += 1;
      continue;
    }

    const displayName = friend.display_name ?? 'お客様';
    const messages: Message[] = [
      {
        type: 'text',
        text: `🎉 ${displayName}さん、 お誕生月おめでとうございます🌿\n\n今月の特別なお知らせをお届けします💝`,
      },
      {
        type: 'flex',
        altText: `${displayName}さんへ — お誕生月特典`,
        contents: buildBirthdaySpecialFlex(displayName, jstMonth),
      },
    ];

    try {
      await lineClient.pushMessage(friend.line_user_id, messages);
      // 既送マーク (= friend_metadata に key 追加、 immutable update)
      const newMeta = { ...meta, [metadataKey]: true };
      await env.DB
        .prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(newMeta), nowJstIso(), friend.id)
        .run();
      sent += 1;
      await auditSystem(env.DB, {
        action: 'birthday_cron.sent',
        actorType: 'cron',
        targetType: 'friend',
        targetId: friend.id,
        lineAccountId: friend.line_account_id,
        result: 'success',
        metadata: { month: jstMonth, displayName },
      });
    } catch (err) {
      errors += 1;
      console.error(
        `[birthday-cron] push failed for friend=${friend.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      await auditSystem(env.DB, {
        action: 'birthday_cron.error',
        actorType: 'cron',
        targetType: 'friend',
        targetId: friend.id,
        lineAccountId: friend.line_account_id,
        result: 'failure',
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : 'unknown',
        metadata: { month: jstMonth },
      });
    }
  }

  return {
    month: jstMonth,
    skippedDueToGating: false,
    candidates: rows.length,
    sent,
    alreadySent,
    errors,
  };
}

// ============================================================
// flex builder
// ============================================================

/** 誕生月特典 flex (= 「お祝いの言葉」 + 公式ストア button + 「AI に何でも聞く」 button) */
function buildBirthdaySpecialFlex(displayName: string, month: number): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '💝 お誕生月特典', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: `${displayName}さん、 ${month}月 のお誕生月おめでとうございます🌸`, size: 'sm', weight: 'bold', color: '#1e293b', wrap: true },
        { type: 'text', text: '今年も健康と笑顔いっぱいの 1 年でありますように🌿', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '🎁 お誕生月限定の特別なご案内を準備中です。 詳細は近日中に LINE でお届けします✨', size: 'xs', color: '#9d174d', wrap: true, margin: 'sm' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に何でも聞く', text: '私におすすめは?' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

// ============================================================
// helpers
// ============================================================

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore parse errors、 空 metadata として扱う
  }
  return {};
}

function nowJstIso(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, -1) + '+09:00';
}

// テスト用 export
export const __test__ = {
  buildBirthdaySpecialFlex,
  parseMetadata,
};
