/**
 * Monthly broadcast postback handler (Phase 2.1、 2026-05-24)
 *
 * 役割:
 *   - 月 1 通信 (= 年 12 イベント broadcast) の「詳しく見る ▶」 postback で reply 5 message 同時送信
 *   - push 1 通/friend (= broadcast 自体) + reply 0 通 (= 詳細) = コスト最小の月 1 接点
 *
 * postback data format:
 *   - `monthly_detail:N` (N=1-12) → 当該月の詳細 5 message reply
 *
 * design 原則 (= 5 軸 + cost zero):
 *   - 💰 お得: 月 1 push 1 通だけ、 詳細は reply 0 通
 *   - 🌿 やさしい: tap しない人には詳細送らない (= 強制感ゼロ)
 *   - 🧠 賢い: 月別 theme + 製品 + 教育 tip を 5 message に統合
 *   - 🤝 つながる: 紹介 reminder / 誕生月特典告知 を組合せ可能 (= push 数追加なし)
 *
 * 関連:
 *   - apps/worker/src/services/welcome-postback.ts (= 同じ reply chain pattern)
 *   - scripts/monthly-broadcast-*-seed.sql (= 各月 broadcast seed、 「詳しく見る ▶」 button 含む)
 */

import type { LineClient, FlexContainer, Message } from '@line-crm/line-sdk';
import { auditSystem } from './audit-logger.js';

/** postback data から月を抽出 (1-12)、 invalid なら null */
export function parseMonthlyDetailPostback(data: string): number | null {
  const match = /^monthly_detail:(\d{1,2})$/.exec(data);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 12) return null;
  return n;
}

/** dispatch 用: postback data が monthly_ prefix で start するか */
export function isMonthlyBroadcastPostback(data: string): boolean {
  return data.startsWith('monthly_detail:');
}

// ============================================================
// 月別 content builder (= Phase 2.1 では 6 月のみ充実、 他月は Phase 2.2 で順次)
// ============================================================

/** 6 月: 梅雨 / 体調管理 (= naturism 軸: インナーケア + Pink 酵素 + 教育) */
function build6JuneIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 6 月のお知らせです🌿\n\n梅雨は気圧と湿度で体内リズムが乱れがち。\nnaturism から、 今月のヒントをお届けします☔\n\n3 つのカードを順番にどうぞ 👇`,
  };
}

function build6JuneTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#a5f3fc',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '☔ 梅雨の食習慣 3 つの tip', size: 'sm', weight: 'bold', color: '#0c4a6e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '💧 こまめな水分補給', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '湿度で汗をかきやすく、 体内のミネラルバランスが乱れがち。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🥗 発酵食品をプラス', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '腸内環境を整えると、 気だるさ・むくみ対策に。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 食べた後の習慣に', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '「食べたら、 飲んでおく」 = naturism Blue を 6 粒 (約 1 食分)。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build6JunePinkFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '💗 Pink — 酵素で美容もケア', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '梅雨は肌コンディションも崩れがち。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: 'Pink は Blue ＋ 活きた酵素配合で、 美容も気になる方におすすめ。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '1日¥75〜 / 7日分お試し可', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: 'Pink を見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に成分を聞く', text: 'Pink の成分' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build6JuneReferralFlex(): FlexContainer {
  // 紹介プログラム reminder (= 3 ヶ月に 1 回 → 月 1 通信に組合せ、 push +0 通)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#dcfce7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎁 友だち紹介で 500 円 OFF', size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'お友だちを naturism 公式 LINE に招待すると、', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌿 あなた → 次回購入で 500 円 OFF', size: 'xs', color: '#15803d', wrap: true, margin: 'sm' },
        { type: 'text', text: '🌿 お友だち → 初回購入で 500 円 OFF', size: 'xs', color: '#15803d', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '※ 紹介プログラム詳細は Phase 4 で実装予定 — まずは「公式 LINE 楽しい」 と感じてもらってから', size: 'xxs', color: '#9ca3af', wrap: true, margin: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build6JuneCallToAction(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#eff6ff',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '✨ 何でもお気軽にどうぞ', size: 'sm', weight: 'bold', color: '#1e40af', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'naturism について気になることは、', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『違い』 『おすすめ』 『飲み方』 『成分』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に違いを聞く', text: '違い' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/**
 * month (1-12) → 5 message (= reply 1 回で送信)
 * Phase 2.1: 6 月のみ充実、 他月は placeholder text (= Phase 2.2 で順次拡充)
 */
export function getMonthlyDetailMessages(month: number, displayName: string): Message[] {
  switch (month) {
    case 6:
      return [
        build6JuneIntro(displayName),
        { type: 'flex', altText: '梅雨の食習慣 3 つの tip', contents: build6JuneTipFlex() },
        { type: 'flex', altText: 'Pink — 酵素で美容もケア', contents: build6JunePinkFlex() },
        { type: 'flex', altText: '友だち紹介で 500 円 OFF', contents: build6JuneReferralFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build6JuneCallToAction() },
      ];
    default:
      // Phase 2.2 で順次拡充、 当面 placeholder
      return [
        {
          type: 'text',
          text: `${displayName}さん、 今月 (${month} 月) のコンテンツを準備中です🌿\n\nそれまでに何かご質問あれば、 『違い』 『おすすめ』 『飲み方』 などと話しかけてください 😊`,
        },
      ];
  }
}

// ============================================================
// Handler
// ============================================================

/**
 * postback 'monthly_detail:N' 処理: reply で当月詳細 5 message 同時送信。
 * push 0 通追加 (= reply API は通数対象外)。
 */
export async function handleMonthlyDetail(
  db: D1Database,
  lineClient: LineClient,
  friend: { id: string; display_name: string | null },
  lineAccountId: string | null,
  replyToken: string,
  postbackData: string,
): Promise<{ ok: boolean; month?: number; reason?: string }> {
  const month = parseMonthlyDetailPostback(postbackData);
  if (month === null) {
    await auditSystem(db, {
      action: 'monthly_postback.detail_invalid',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: friend.id,
      lineAccountId,
      result: 'failure',
      errorMessage: `invalid postback data: ${postbackData.slice(0, 80)}`,
    });
    return { ok: false, reason: 'invalid_format' };
  }

  const displayName = friend.display_name ?? 'お客様';
  const messages = getMonthlyDetailMessages(month, displayName);
  await lineClient.replyMessage(replyToken, messages);

  await auditSystem(db, {
    action: 'monthly_postback.detail_sent',
    actorType: 'webhook',
    targetType: 'friend',
    targetId: friend.id,
    lineAccountId,
    result: 'success',
    metadata: { month, messagesSent: messages.length, api: 'reply' },
  });
  return { ok: true, month };
}
