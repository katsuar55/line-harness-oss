/**
 * Welcome postback handler (Phase 1 ULTRATHINK MVP、 2026-05-24)
 *
 * 役割:
 *   - LP welcome scenario の「次へ ▶」 (= 誕生月 → 年代) flow を postback chain で処理
 *   - friend.birth_month / age_group を column UPDATE (= migration 052)
 *   - audit_logs に `friend.demographic_collected` 記録
 *
 * postback data format (= 既存 `birthday_month` action と衝突しない `welcome_` prefix で分離):
 *   - `welcome_intro_step`               → 「お誕生日教えて」 flex push
 *   - `welcome_birthday:N` (N=1-12)      → friend.birth_month=N + 「年代教えて」 flex push
 *   - `welcome_age_group:X` (X='10s'..'70+') → friend.age_group=X + reply「ありがとう」
 *
 * design 原則 (= user 合意済 5 軸):
 *   - 🌿 やさしい: skip しても coupon は使える (= 強制感ゼロ)
 *   - 🎯 楽しい: button tap で軽く進む
 *   - 🤝 つながる: 誕生月 → 月 1 通信 + 誕生月特典の data 起点
 *
 * 関連:
 *   - apps/worker/src/routes/webhook.ts (= dispatch 元)
 *   - apps/worker/src/services/audit-logger.ts (= auditSystem)
 *   - packages/db/migrations/052_friend_demographics.sql (= birth_month + age_group column)
 */

import type { LineClient, FlexContainer } from '@line-crm/line-sdk';
import { auditSystem } from './audit-logger.js';

const AGE_GROUPS = ['10s', '20s', '30s', '40s', '50s', '60s', '70+'] as const;
type AgeGroup = (typeof AGE_GROUPS)[number];

/** postback data から月を抽出 (1-12)、 invalid なら null */
export function parseWelcomeBirthdayPostback(data: string): number | null {
  const match = /^welcome_birthday:(\d{1,2})$/.exec(data);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 12) return null;
  return n;
}

/** postback data から年代を抽出、 invalid なら null */
export function parseWelcomeAgeGroupPostback(data: string): AgeGroup | null {
  const match = /^welcome_age_group:(.+)$/.exec(data);
  if (!match) return null;
  const candidate = match[1] as AgeGroup;
  return AGE_GROUPS.includes(candidate) ? candidate : null;
}

/** flex bubble: 「お誕生日教えてください 🎂」 12 月 button (= 4 列 × 3 行) */
export function buildBirthdayAskFlex(): FlexContainer {
  const monthButton = (n: number) => ({
    type: 'button' as const,
    action: { type: 'postback' as const, label: `${n}月`, data: `welcome_birthday:${n}` },
    style: 'secondary' as const,
    height: 'sm' as const,
    flex: 1,
  });
  const row = (months: number[]) => ({
    type: 'box' as const,
    layout: 'horizontal' as const,
    spacing: 'sm' as const,
    contents: months.map(monthButton),
  });
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fff7ed',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: '🎂 お誕生日を教えてください',
          size: 'md',
          weight: 'bold',
          color: '#9a3412',
          align: 'center',
        },
        {
          type: 'text',
          text: '誕生月に特別なお知らせをお届けします',
          size: 'xs',
          color: '#7c2d12',
          align: 'center',
          margin: 'sm',
          wrap: true,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        row([1, 2, 3, 4]),
        row([5, 6, 7, 8]),
        row([9, 10, 11, 12]),
        {
          type: 'text',
          text: '※ 日にちは聞きません、 月だけで OK です',
          size: 'xxs',
          color: '#9ca3af',
          align: 'center',
          margin: 'md',
        },
      ],
    },
  } as unknown as FlexContainer;
}

/** flex bubble: 「年代を教えてください ✨」 7 段階 button (= 2 列 × 4 行) */
export function buildAgeGroupAskFlex(): FlexContainer {
  const ageButton = (label: string, data: string) => ({
    type: 'button' as const,
    action: { type: 'postback' as const, label, data: `welcome_age_group:${data}` },
    style: 'secondary' as const,
    height: 'sm' as const,
    flex: 1,
  });
  const row = (items: Array<{ label: string; data: string }>) => ({
    type: 'box' as const,
    layout: 'horizontal' as const,
    spacing: 'sm' as const,
    contents: items.map((i) => ageButton(i.label, i.data)),
  });
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#eff6ff',
      paddingAll: '14px',
      contents: [
        {
          type: 'text',
          text: '✨ 年代を教えてください',
          size: 'md',
          weight: 'bold',
          color: '#1e40af',
          align: 'center',
        },
        {
          type: 'text',
          text: 'あなたに合う情報をお届けします',
          size: 'xs',
          color: '#1e3a8a',
          align: 'center',
          margin: 'sm',
          wrap: true,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        row([
          { label: '10代', data: '10s' },
          { label: '20代', data: '20s' },
        ]),
        row([
          { label: '30代', data: '30s' },
          { label: '40代', data: '40s' },
        ]),
        row([
          { label: '50代', data: '50s' },
          { label: '60代', data: '60s' },
        ]),
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [ageButton('70代以上', '70+')],
        },
      ],
    },
  } as unknown as FlexContainer;
}

/**
 * postback 'welcome_intro_step' 処理: 「お誕生日教えて」 flex を push。
 */
export async function handleWelcomeIntroStep(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  lineUserId: string,
  lineAccountId: string | null,
): Promise<void> {
  await lineClient.pushMessage(lineUserId, [
    { type: 'flex', altText: 'お誕生日を教えてください 🎂', contents: buildBirthdayAskFlex() },
  ]);
  await auditSystem(db, {
    action: 'welcome_postback.intro_step',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { stage: 'ask_birthday' },
  });
}

/**
 * postback 'welcome_birthday:N' 処理: friend.birth_month UPDATE + 「年代教えて」 flex push。
 */
export async function handleWelcomeBirthday(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  lineUserId: string,
  lineAccountId: string | null,
  postbackData: string,
): Promise<{ ok: boolean; month?: number; reason?: string }> {
  const month = parseWelcomeBirthdayPostback(postbackData);
  if (month === null) {
    await auditSystem(db, {
      action: 'welcome_postback.birthday_invalid',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: `invalid postback data: ${postbackData.slice(0, 80)}`,
    });
    return { ok: false, reason: 'invalid_format' };
  }
  await db
    .prepare('UPDATE friends SET birth_month = ?, updated_at = ? WHERE id = ?')
    .bind(month, new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, -1) + '+09:00', friendId)
    .run();
  await lineClient.pushMessage(lineUserId, [
    { type: 'flex', altText: '年代を教えてください ✨', contents: buildAgeGroupAskFlex() },
  ]);
  await auditSystem(db, {
    action: 'friend.demographic_collected',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { field: 'birth_month', value: month, stage: 'ask_age_group' },
  });
  return { ok: true, month };
}

/**
 * postback 'welcome_age_group:X' 処理: friend.age_group UPDATE + reply「ありがとう」。
 */
export async function handleWelcomeAgeGroup(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  lineAccountId: string | null,
  replyToken: string,
  postbackData: string,
): Promise<{ ok: boolean; ageGroup?: AgeGroup; reason?: string }> {
  const ageGroup = parseWelcomeAgeGroupPostback(postbackData);
  if (ageGroup === null) {
    await auditSystem(db, {
      action: 'welcome_postback.age_group_invalid',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId,
      result: 'failure',
      errorMessage: `invalid postback data: ${postbackData.slice(0, 80)}`,
    });
    return { ok: false, reason: 'invalid_format' };
  }
  await db
    .prepare('UPDATE friends SET age_group = ?, updated_at = ? WHERE id = ?')
    .bind(ageGroup, new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, -1) + '+09:00', friendId)
    .run();
  // reply「ありがとう」 (= reply は free API、 24h 制限あり)
  await lineClient.replyMessage(replyToken, [
    {
      type: 'text',
      text: 'ありがとうございます🌿\n\n誕生月と年代を保存しました。\n誕生月には特別なクーポンをお送りします🎁\n\n15 分後に商品の比較情報を、 翌日にはお得情報をお届けしますね。\n\nそれまでに何か質問があれば、 『違い』 『おすすめ』 『飲み方』 などと話しかけてください 😊',
    },
  ]);
  await auditSystem(db, {
    action: 'friend.demographic_collected',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { field: 'age_group', value: ageGroup, stage: 'complete' },
  });
  return { ok: true, ageGroup };
}

/** dispatch 用: postback data が welcome_ prefix で start するか */
export function isWelcomePostback(data: string): boolean {
  return (
    data === 'welcome_intro_step' ||
    data.startsWith('welcome_birthday:') ||
    data.startsWith('welcome_age_group:')
  );
}
