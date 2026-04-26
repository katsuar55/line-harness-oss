/**
 * 誕生月再収集シナリオ
 *
 * DMM チャットブースト解約 (2026-06〜07月) で消える誕生日データを
 * naturism-line-crm 側で先回り収集するための機能。
 *
 * フロー:
 *   1. 管理画面 (or API) から「誕生月をまだ未登録の友だち」にブロードキャスト
 *   2. メッセージ末尾に Quick Reply 12個 (1月〜12月) を付与
 *   3. ユーザーがタップ → postback `action=birthday_month&month=N` (N: 1-12)
 *   4. webhook.ts の postback handler が friends.metadata.birth_month を更新
 *   5. お礼メッセージを reply
 *
 * 保存場所: friends.metadata.birth_month (TEXT "1"〜"12")
 *   - DB 変更 (migration) 不要
 *   - segment_query の metadata_not_equals フィルタで未登録者を抽出可能
 *   - 既存の friends.birthday (YYYY-MM-DD) は本来の誕生日データ用に温存
 */
import type { TextMessage } from '@line-crm/line-sdk';
import { quickReply, withQuickReply } from '@line-crm/line-sdk';

export const BIRTHDAY_METADATA_KEY = 'birth_month';

/**
 * 誕生月収集メッセージ (Quick Reply 12個付き) を組み立てる。
 *
 * @param customText カスタムメッセージ本文。未指定時はデフォルト文言。
 */
export function buildBirthdayCollectionMessage(
  customText?: string,
): TextMessage & { quickReply: ReturnType<typeof quickReply> } {
  const text = customText ?? defaultPromptText();

  const items = MONTHS.map((month) => ({
    type: 'action' as const,
    action: {
      type: 'postback' as const,
      label: `${month}月`,
      data: `action=birthday_month&month=${month}`,
      displayText: `${month}月`,
    },
  }));

  const message: TextMessage = { type: 'text', text };
  return withQuickReply(message, quickReply(items)) as TextMessage & {
    quickReply: ReturnType<typeof quickReply>;
  };
}

/**
 * 誕生月選択後のお礼メッセージ。
 */
export function buildBirthdayThanksText(month: number): string {
  return `${month}月生まれですね、教えていただきありがとうございます🎉\nお誕生月にちょっとしたお祝いメッセージをお送りしますね。`;
}

/**
 * postback data から month (1-12) を安全にパースする。
 * 不正値は null を返す。
 */
export function parseBirthdayMonthPostback(data: string): number | null {
  const params = new URLSearchParams(data);
  if (params.get('action') !== 'birthday_month') return null;
  const raw = params.get('month');
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return n;
}

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

function defaultPromptText(): string {
  return [
    'naturism からのお願い 🎂',
    '',
    'お誕生月をこっそり教えていただけると、',
    '誕生月にちょっとしたお祝いメッセージをお送りできます。',
    '',
    '下のボタンから当てはまる月を選んでくださいね。',
  ].join('\n');
}
