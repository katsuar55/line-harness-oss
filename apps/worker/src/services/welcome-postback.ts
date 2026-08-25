/**
 * Welcome postback handler (Phase 1 ULTRATHINK v3、 2026-05-24)
 *
 * 役割:
 *   - LP welcome scenario の「次へ ▶」 (= 誕生月 → 年代) flow を postback chain で処理
 *   - friend.birth_month / age_group を column UPDATE (= migration 052)
 *   - audit_logs に `friend.demographic_collected` 記録
 *   - **全 reply API**: postback event の replyToken を使い 0 通課金で全 sequence 完結
 *   - 年代 tap 後の「ありがとう」 reply に **商品比較 flex + マイクーポン flex を同梱 (= 1 reply 3 message)**
 *     → 旧 step 1 (15 min push) + step 2 (24h push) を統合、 push 0 通化
 *
 * postback data format (= 既存 `birthday_month` action と衝突しない `welcome_` prefix で分離):
 *   - `welcome_intro_step`               → reply 「お誕生日教えて」 flex
 *   - `welcome_birthday:N` (N=1-12)      → friend.birth_month=N + reply 「年代教えて」 flex
 *   - `welcome_age_group:X` (X='10s'..'70+') → friend.age_group=X + reply 「ありがとう + 商品比較 + マイクーポン」 (3 message)
 *
 * design 原則 (= user 合意済 5 軸 + cost zero ULTRATHINK):
 *   - 🌿 やさしい: skip しても coupon は使える (= 強制感ゼロ)
 *   - 💰 お得: コスト 0 (= 全 reply、 push なし)
 *   - 🎯 楽しい: button tap で軽く進む
 *   - 🤝 つながる: 誕生月 → 月 1 通信 + 誕生月特典の data 起点
 *
 * 関連:
 *   - apps/worker/src/routes/webhook.ts (= dispatch 元、 replyToken 必須)
 *   - apps/worker/src/services/audit-logger.ts (= auditSystem)
 *   - packages/db/migrations/052_friend_demographics.sql (= birth_month + age_group column)
 *   - scripts/welcome-scenario-v3-2026-05-24.sql (= step 1/2 削除 + step 0 content 微調整)
 */

import type { LineClient, FlexContainer, Message } from '@line-crm/line-sdk';
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

// ============================================================
// Flex builders
// ============================================================

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
        { type: 'text', text: '🎂 お誕生日を教えてください', size: 'md', weight: 'bold', color: '#9a3412', align: 'center' },
        { type: 'text', text: '誕生月に特別なお知らせをお届けします', size: 'xs', color: '#7c2d12', align: 'center', margin: 'sm', wrap: true },
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
        { type: 'text', text: '※ 日にちは聞きません、 月だけで OK です', size: 'xxs', color: '#9ca3af', align: 'center', margin: 'md' },
      ],
    },
  } as unknown as FlexContainer;
}

/** flex bubble: 「年代を教えてください ✨」 7 段階 button (= 2 列 × 3 行 + 1) */
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
        { type: 'text', text: '✨ 年代を教えてください', size: 'md', weight: 'bold', color: '#1e40af', align: 'center' },
        { type: 'text', text: 'あなたに合う情報をお届けします', size: 'xs', color: '#1e3a8a', align: 'center', margin: 'sm', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        row([{ label: '10代', data: '10s' }, { label: '20代', data: '20s' }]),
        row([{ label: '30代', data: '30s' }, { label: '40代', data: '40s' }]),
        row([{ label: '50代', data: '50s' }, { label: '60代', data: '60s' }]),
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [ageButton('70代以上', '70+')] },
      ],
    },
  } as unknown as FlexContainer;
}

/** flex bubble: 商品比較 (= 旧 step 1 の content を移植、 年代 tap 後の同梱用) */
export function buildProductCompareFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#f0fdf4',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🌿 あなたにぴったりの naturism は？', size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'lg',
      contents: [
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            { type: 'text', text: '🩵 Blue — まずはここから', size: 'sm', weight: 'bold', color: '#0ABAB5' },
            { type: 'text', text: '脂っこい食事が好きな方に。 9 成分配合、 1日¥64〜', size: 'xs', color: '#475569', wrap: true },
          ],
        },
        { type: 'separator' },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            { type: 'text', text: '💗 Pink — 酵素で美容もケア', size: 'sm', weight: 'bold', color: '#1e293b' },
            { type: 'text', text: 'Blue から玄米外皮・胚芽を除き活きた酵素を配合した全10成分。 美容も気になる方に。 1日¥75〜', size: 'xs', color: '#475569', wrap: true },
          ],
        },
        { type: 'separator' },
        {
          type: 'box', layout: 'vertical', spacing: 'sm',
          contents: [
            { type: 'text', text: '🩶 Premium — 本気の体型管理に', size: 'sm', weight: 'bold', color: '#1e293b' },
            { type: 'text', text: '全 16 成分の最高峰。 機能性表示食品。 1日¥149〜', size: 'xs', color: '#475569', wrap: true },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に相談 (おすすめ)', text: 'おすすめ' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/**
 * flex bubble: マイクーポン (= 旧 step 2 から格上げ、 永続表示用に強化)
 * coupon code が null なら fallback text を表示。
 *
 * 🚨 割引額は**台帳の値 (discountValueJpy) が唯一の正**。ここに定数を書かないこと
 *   (2026-08-24): 既発行の ¥300 券を持つ人にこの吹き出しが「500 円 OFF」と言ってしまう。
 *   額が取れないときは金額を出さず条件だけ伝える (既定額で埋めない)。
 *   期限の「7 日」は webhook の follow ハンドラが validDays:7 で発行しているのと対。
 */
export function buildMyCouponFlex(
  couponCode: string | null,
  discountValueJpy?: number | null,
): FlexContainer {
  const rawValue = Number(discountValueJpy);
  const value = Number.isFinite(rawValue) && rawValue > 0 ? Math.round(rawValue) : null;
  const couponSection = couponCode
    ? [
        {
          type: 'box' as const,
          layout: 'vertical' as const,
          backgroundColor: '#fef3c7',
          cornerRadius: '8px',
          paddingAll: '12px',
          spacing: 'sm' as const,
          contents: [
            { type: 'text' as const, text: 'クーポンコード', size: 'xxs' as const, color: '#92400e', align: 'center' as const },
            { type: 'text' as const, text: couponCode, size: 'xl' as const, weight: 'bold' as const, color: '#06C755', align: 'center' as const, margin: 'sm' as const },
            { type: 'text' as const, text: '発行から 7 日間有効 / naturism-diet.com', size: 'xxs' as const, color: '#78350f', align: 'center' as const, wrap: true },
          ],
        },
        // 利用条件は必ず併記する (2026-08-24): 全券共通の最低購入 ¥2,000 を書かないと
        //   ¥2,000 未満の注文でコードが無言で外れ、顧客には「使えなかった」としか見えない。
        //   かつてここには「Blue 7日分 ¥696 → 500円 OFF で 実質 ¥196」という例示があったが、
        //   ¥696 の注文には最低購入額の条件で適用できず、金額・期限とあわせて三重に誤りだった。
        {
          type: 'text' as const,
          text: value
            ? `💡 ¥2,000 以上のご注文で ${value} 円 OFF`
            : '💡 ¥2,000 以上のご注文でお使いいただけます',
          size: 'xs' as const, color: '#475569', align: 'center' as const, wrap: true, margin: 'md' as const,
        },
        { type: 'text' as const, text: '定期便の初回にもお使いいただけます', size: 'xxs' as const, color: '#94a3b8', align: 'center' as const, wrap: true },
      ]
    : [
        { type: 'text' as const, text: 'クーポンは間もなくお届けします', size: 'sm' as const, color: '#78350f', align: 'center' as const, wrap: true },
      ];
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fef3c7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎁 マイクーポン (友だち限定)', size: 'sm', weight: 'bold', color: '#92400e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: couponSection,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアで使う', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に飲み方を聞く', text: '飲み方' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

// ============================================================
// Handlers (= 全 replyMessage 化、 cost 0 通)
// ============================================================

/**
 * postback 'welcome_intro_step' 処理: 「お誕生日教えて」 flex を reply。
 * replyToken は postback event の replyToken (= 約 1 分有効、 1 回のみ使用可)。
 */
export async function handleWelcomeIntroStep(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  replyToken: string,
  lineAccountId: string | null,
): Promise<void> {
  await lineClient.replyMessage(replyToken, [
    { type: 'flex', altText: 'お誕生日を教えてください 🎂', contents: buildBirthdayAskFlex() },
  ]);
  await auditSystem(db, {
    action: 'welcome_postback.intro_step',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { stage: 'ask_birthday', api: 'reply' },
  });
}

/**
 * postback 'welcome_birthday:N' 処理: friend.birth_month UPDATE + 「年代教えて」 flex reply。
 */
export async function handleWelcomeBirthday(
  db: D1Database,
  lineClient: LineClient,
  friendId: string,
  replyToken: string,
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
  await lineClient.replyMessage(replyToken, [
    { type: 'flex', altText: '年代を教えてください ✨', contents: buildAgeGroupAskFlex() },
  ]);
  await auditSystem(db, {
    action: 'friend.demographic_collected',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId,
    result: 'success',
    metadata: { field: 'birth_month', value: month, stage: 'ask_age_group', api: 'reply' },
  });
  return { ok: true, month };
}

/**
 * postback 'welcome_age_group:X' 処理: friend.age_group UPDATE + reply 3 message 同時:
 *   1. text 「ありがとう」 (= 短く端的)
 *   2. flex 商品比較 (= 旧 step 1 移植)
 *   3. flex マイクーポン (= 旧 step 2 格上げ、 coupon code 動的注入)
 *
 * LINE reply API は 1 reply で最大 5 message 同時送信可、 通数 0 カウント。
 * 旧 plan の「15 min 後 step 1 push + 24h 後 step 2 push」 を完全に統合、 全 sequence 0 通課金。
 */
export async function handleWelcomeAgeGroup(
  db: D1Database,
  lineClient: LineClient,
  friend: { id: string; display_name: string | null },
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
      targetId: friend.id,
      lineAccountId,
      result: 'failure',
      errorMessage: `invalid postback data: ${postbackData.slice(0, 80)}`,
    });
    return { ok: false, reason: 'invalid_format' };
  }
  await db
    .prepare('UPDATE friends SET age_group = ?, updated_at = ? WHERE id = ?')
    .bind(ageGroup, new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, -1) + '+09:00', friend.id)
    .run();

  // coupon code を D1 から SELECT (= follow event で issueCouponForFriend が INSERT 済の想定、 失敗時は null)
  const couponRow = await db
    .prepare(
      "SELECT coupon_code, discount_value FROM line_friend_coupons WHERE friend_id = ? AND status = 'issued' ORDER BY issued_at DESC LIMIT 1",
    )
    .bind(friend.id)
    .first<{ coupon_code: string; discount_value: number | null }>()
    .catch(() => null);
  const couponCode = couponRow?.coupon_code ?? null;
  // 額は台帳が正 (既発行の ¥300 券に「500 円」と言わないため)
  const couponValue = couponRow?.discount_value ?? null;

  const displayName = friend.display_name ?? 'お客様';
  const messages: Message[] = [
    {
      type: 'text',
      text: `${displayName}さん、 ありがとうございます🌿\n誕生月と年代を保存しました。\n誕生月には特別なクーポンをお届けします🎁\n\n以下、 一緒に届けますね 👇`,
    },
    {
      type: 'flex',
      altText: 'あなたにぴったりの naturism は?',
      contents: buildProductCompareFlex(),
    },
    {
      type: 'flex',
      altText: 'マイクーポン (友だち限定)',
      contents: buildMyCouponFlex(couponCode, couponValue),
    },
  ];
  await lineClient.replyMessage(replyToken, messages);

  await auditSystem(db, {
    action: 'friend.demographic_collected',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friend.id,
    lineAccountId,
    result: 'success',
    metadata: { field: 'age_group', value: ageGroup, stage: 'complete', api: 'reply', messagesSent: 3, couponCode: couponCode ?? null },
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
