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

/** 7 月: 夏本番 / BBQ / 焼肉 / かき氷 (= naturism 軸: Blue 強化、 脂質対策、 夏キャンペーン 予告) */
function build7JulyIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 7 月のお知らせです🌻\n\n夏本番、 ビアガーデン・BBQ・焼肉・かき氷の季節☀\n脂っこい食事・甘いものが増えるこの時期、 naturism から夏の食習慣のヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build7JulyTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fef3c7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '☀ 夏の食習慣 3 つの tip', size: 'sm', weight: 'bold', color: '#92400e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🍖 食前に 1 杯の水', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'BBQ や焼肉の前に水を飲むことで食べ過ぎを防ぎ、 消化もスムーズに。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🍨 冷たいものは少量ずつ', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'かき氷・アイスは胃腸を冷やしやすい。 一気食いを避けて少量で楽しむ。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 食事中に naturism を', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '「食べたら、 飲んでおく」 を脂っこい食事の時に意識。 Blue 6 粒 (約 1 食分) が目安。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build7JulyBlueFlex(): FlexContainer {
  // Blue (= 脂質カット特化) を BBQ / 焼肉 文脈で推す
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#cffafe',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🩵 Blue — BBQ・焼肉 に安心の 8 成分', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '夏の外食は脂質が高め。 Blue は脂質カットに特化した naturism のエントリーモデル。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '8 成分配合 (= ウーロン茶ポリフェノール / アロエベラ / サンザシ 等)。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '1日¥64〜 / 7日分お試し ¥696', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: 'Blue を見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に成分を聞く', text: 'Blue の成分' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build7JulyCampaignFlex(): FlexContainer {
  // 夏キャンペーン予告 (= 紹介 reminder と統合、 Phase 4 で実装予定)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎁 夏のキャンペーン (予告)', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '7-8 月限定の特典を準備中です🌸', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌿 友だち紹介で 500 円 OFF (= あなた + お友だち 両方)', size: 'xs', color: '#9d174d', wrap: true, margin: 'sm' },
        { type: 'text', text: '🌿 Blue + Pink セット お試し企画 (検討中)', size: 'xs', color: '#9d174d', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '※ 詳細は公式 LINE で随時お知らせ。 公式 Instagram @naturism_supplement もチェック✨', size: 'xxs', color: '#9ca3af', wrap: true, margin: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build7JulyCallToAction(): FlexContainer {
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
        { type: 'text', text: '夏の食事相談、 商品選び等は気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『私におすすめ』 『価格比較』 『飲み方』 『成分』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に私のおすすめを聞く', text: '私におすすめは?' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 8 月: お盆 / 夏バテ / 残暑 (= naturism 軸: Pink (酵素) で美容 + 疲労、 お盆休み発送 reminder) */
function build8AugustIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 8 月のお知らせです🍉\n\n夏の盛り、 お盆休みや帰省で食生活が乱れがち。\n残暑と紫外線で疲労 + 肌コンディションも気になる季節🥵\nnaturism から夏疲れリカバリのヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build8AugustTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fed7aa',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🥵 夏バテ対策 3 つの tip', size: 'sm', weight: 'bold', color: '#9a3412', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🌅 朝食は抜かない', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '食欲低下時こそ朝の 1 品 (= 味噌汁 / バナナ / ヨーグルト) で 1 日のリズムを整える。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🍦 冷たいものは「少量×回数」', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '一気食いではなく、 室温の水・常温の麦茶を挟んで胃腸を冷やしすぎない。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '😴 食後 30 分は休む', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '消化に血流が必要な時期。 食後すぐの炎天下外出は dehydration ↑。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build8AugustPinkFlex(): FlexContainer {
  // Pink (= 酵素 + 美容) を「夏疲れリカバリ」 文脈で推す
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '💗 Pink — 夏疲れ + 美容ケア', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '夏の紫外線・疲労で代謝が落ちると、 食事の重さを感じやすい時期。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: 'Pink は Blue (8 成分) + 活きた酵素 を配合した上位モデル。 美容を気にする方へ。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '1日¥75〜 / 7日分お試し ¥816', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: 'Pink を見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'Blue との違いを AI に聞く', text: 'Blue と Pink の違い' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build8AugustCampaignFlex(): FlexContainer {
  // お盆休み発送 + 夏キャンペーン 継続
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fde68a',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '📦 お盆休み + 夏キャンペーン', size: 'sm', weight: 'bold', color: '#854d0e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '📅 お盆休み発送案内', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '8/11-15 はご注文受付のみ、 発送は 8/16 から順次対応となります。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 友だち紹介で 500 円 OFF (= 7-8 月継続)', size: 'sm', weight: 'bold', color: '#15803d' },
        { type: 'text', text: 'あなた → 次回購入 / お友だち → 初回購入 で両方お得。 帰省で会うご家族にも🌸', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '※ 紹介プログラム詳細は Phase 4 で実装予定 — まずは LINE 公式で随時お知らせします', size: 'xxs', color: '#9ca3af', wrap: true, margin: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build8AugustCallToAction(): FlexContainer {
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
        { type: 'text', text: '夏バテ対策・商品選び・飲み方は気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『夏バテ対策に何がいい?』 『Pink と Blue の違い』 『飲み方』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: '私におすすめを AI に聞く', text: '私におすすめは?' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 9 月: 秋の入口 / 食欲の秋 / 涼しさで体調整える (= naturism 軸: Pink/Blue 両方の使い分け、 食べ過ぎ対策) */
function build9SeptemberIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 9 月のお知らせです🍂\n\n少しずつ涼しくなり、 食欲の秋がやってきます🍠\n夏に乱れた食生活を整え、 旬の味覚を楽しむ準備の月。\nnaturism から、 秋の食習慣のヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build9SeptemberTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fed7aa',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🍂 秋の食習慣 3 つの tip', size: 'sm', weight: 'bold', color: '#9a3412', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🍠 旬の根菜・きのこを取り入れる', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'さつまいも・かぼちゃ・しめじ・舞茸は食物繊維が豊富、 腸内環境を整える秋の味方。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌾 主食は「先に野菜」 から', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '新米・パスタが美味しい季節。 サラダや野菜スープから食べ始めると糖質吸収もマイルドに。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 食べ過ぎた日のリセット習慣', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '宴会・外食が増える前に、 「食べたら飲んでおく」 を naturism Blue 6 粒で。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build9SeptemberCompareFlex(): FlexContainer {
  // Pink vs Blue 使い分け (= 秋は二刀流推奨、 Pink を初めて検討する人向け)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#e0e7ff',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🩵💗 Blue と Pink の使い分け', size: 'sm', weight: 'bold', color: '#3730a3', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🩵 Blue は脂質カット 8 成分 — 焼肉 / 揚げ物 等の脂質高めの食事の時に', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '💗 Pink は Blue + 酵素 — 美容も気になる方、 食事量が多い方に', size: 'sm', color: '#1e293b', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '秋は外食 + 旬食材の食べ過ぎが増えるので、 二刀流で使い分けるユーザーも多数。', size: 'xs', color: '#475569', wrap: true },
        { type: 'text', text: '1日¥64〜 (Blue) / ¥75〜 (Pink)', size: 'sm', weight: 'bold', color: '#3730a3', align: 'center', margin: 'sm' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '両方見る (公式)', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に違いを聞く', text: '違い' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build9SeptemberReorderFlex(): FlexContainer {
  // 9 月: 再購入リマインダー (= 7 月初回購入者の 2 ヶ月目 cycle)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#dcfce7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🔁 続けることで実感する成分', size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'naturism の素材は「日々の食習慣をサポート」 する設計。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '7 月にお試しいただいた方は、 そろそろ次のサイクルを検討する頃かも🌿', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '🌱 続けると…', size: 'xs', weight: 'bold', color: '#15803d', margin: 'sm' },
        { type: 'text', text: '・宴会後の翌朝がラク (個人差あります)', size: 'xs', color: '#334155' },
        { type: 'text', text: '・食事中に「飲んでおく」 が習慣化', size: 'xs', color: '#334155' },
        { type: 'text', text: '・1 日¥64〜 で長く続けやすい設計', size: 'xs', color: '#334155' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアで再購入', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build9SeptemberCallToAction(): FlexContainer {
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
        { type: 'text', text: '秋の食事相談・商品選び・飲み方は気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『私におすすめ』 『Blue と Pink の違い』 『飲み方』 『成分』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に私のおすすめを聞く', text: '私におすすめは?' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 10 月: 紅葉 / スポーツの秋 / 行楽 (= naturism 軸: 旅先 / 外食を楽しむ Blue 推奨) */
function build10OctoberIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 10 月のお知らせです🍁\n\n紅葉シーズン到来、 行楽 + スポーツの秋を満喫する時期。\n旅先・外食の機会が増えるので、 食事を楽しみつつ食習慣も整えたい月🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build10OctoberTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fef3c7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🍁 行楽シーズンの食習慣 3 つ', size: 'sm', weight: 'bold', color: '#854d0e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🍱 旅先のお弁当は「半分シェア」 を活用', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '色々食べたい時は、 同行者とシェアすれば味のバリエーション + 量も控えめに。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🚶‍♀️ 食後の散策が消化を助ける', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'スポーツの秋にちなんで、 食後 10-15 分の散歩。 紅葉狩りと一石二鳥。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 旅行カバンに naturism を入れる', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '袋ごと持ち運べる小型パッケージ。 旅先の脂質高め食事の時に Blue 6 粒で安心。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build10OctoberTravelKitFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#cffafe',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🩵 Blue を旅のお供に', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: 'naturism Blue は 1 包ずつ個包装。 ポーチや旅行カバンに数日分入れるだけ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🍣 寿司 / 🍖 焼肉 / 🍝 パスタ等、 外食で気になる時に「食べたら飲んでおく」 を 6 粒で。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '1日¥64〜 / 7日分お試し ¥696', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に飲み方を聞く', text: 'Blue の飲み方' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build10OctoberPrePartyHintFlex(): FlexContainer {
  // 忘年会シーズン前の意識づけ (= 11 月以降への布石)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '📅 忘年会シーズン まで 2 ヶ月', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '11 月後半から忘年会シーズン。 今月から食習慣を整えておくと preview 効果◎', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌿 おすすめ準備', size: 'xs', weight: 'bold', color: '#9d174d', margin: 'sm' },
        { type: 'text', text: '・naturism Blue を週 2-3 回継続 (= 体に馴染ませる)', size: 'xs', color: '#334155' },
        { type: 'text', text: '・「食べたら飲む」 を習慣化', size: 'xs', color: '#334155' },
        { type: 'text', text: '・水分補給を意識する', size: 'xs', color: '#334155' },
      ],
    },
  } as unknown as FlexContainer;
}

function build10OctoberCallToAction(): FlexContainer {
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
        { type: 'text', text: '旅行 / 外食 / 飲み方は気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『旅先で何粒?』 『外食の時の飲み方』 『おすすめ』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に飲み方を聞く', text: '飲み方' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 11 月: 忘年会シーズン突入 / 飲み会 / 季節の変わり目 (= naturism 軸: Blue 強化、 飲み会対策) */
function build11NovemberIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 11 月のお知らせです🍂\n\n忘年会シーズンが本格スタート🍻\n季節の変わり目で体調管理も大事な時期、 naturism から飲み会対策のヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build11NovemberPartyTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fed7aa',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🍻 忘年会シーズン 3 つの対策', size: 'sm', weight: 'bold', color: '#9a3412', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🥤 飲む前に水 1 杯', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '空腹で飲酒スタートすると吸収速い + 食べ過ぎリスク高。 まず水で胃を整える。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🍢 「先に野菜・タンパク質」 を意識', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '枝豆 / 焼き鳥 / サラダから手をつけると糖質吸収もマイルドに。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 食べたら飲んでおく習慣', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '揚げ物・脂質が多いコースの時に Blue 6 粒。 「翌日が違う」 と言う実感の声も。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build11NovemberBlueBoostFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#cffafe',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🩵 Blue — 忘年会の頼れる相棒', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '11 月-12 月は飲み会が連続しがち。 「いつでも 1 包」 をバッグに入れる習慣を🌿', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '8 成分配合 (= ウーロン茶ポリフェノール / アロエベラ / サンザシ 等) で脂質カットに特化。', size: 'xs', color: '#475569', wrap: true, margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '💡 1 ヶ月分 (30 袋) でほぼ毎晩カバー可', size: 'sm', weight: 'bold', color: '#0ABAB5', align: 'center' },
        { type: 'text', text: '1日¥64〜 / 30日分 ¥1,980', size: 'xs', color: '#475569', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: 'Blue を見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に飲み会対策を聞く', text: '飲み会対策' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build11NovemberHealthFlex(): FlexContainer {
  // 季節変わり目 = 体調管理 / インフル対策
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#dcfce7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🍵 季節の変わり目を整える', size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '気温差で体調を崩しやすい時期。 食事 + 睡眠 + 適度な水分補給を意識。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌿 忘年会で疲れた翌朝は…', size: 'xs', weight: 'bold', color: '#15803d', margin: 'sm' },
        { type: 'text', text: '・温かいお茶・スープで胃腸を労る', size: 'xs', color: '#334155' },
        { type: 'text', text: '・朝食は軽めに (おかゆ / 味噌汁 等)', size: 'xs', color: '#334155' },
        { type: 'text', text: '・水分補給を 1.5L 目安に', size: 'xs', color: '#334155' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '※ 体調不良時は無理せず医療機関を受診してください', size: 'xxs', color: '#9ca3af', wrap: true, margin: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build11NovemberCallToAction(): FlexContainer {
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
        { type: 'text', text: '飲み会対策・体調管理・商品選びは気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『飲み会対策』 『飲み方』 『私におすすめ』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に飲み会対策を聞く', text: '飲み会対策' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 12 月: 年末年始 / クリスマス / 大晦日 / おせち準備 (= naturism 軸: Blue 主役、 帰省土産 hint) */
function build12DecemberIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 12 月のお知らせです🎄\n\nクリスマス / 忘年会 / 大晦日 / おせち準備 — 1 年で最も食事イベントが多い月🍗\n暴飲暴食しがちな時期、 naturism から年末対策のヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build12DecemberTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fee2e2',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎄 年末年始 3 つの食事 tip', size: 'sm', weight: 'bold', color: '#991b1b', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🍗 クリスマス / 大晦日の主役は楽しんで', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'チキン・寿司・年越し蕎麦は美味しく頂きつつ、 「飲んでおく」 を意識すれば気持ち的にも楽。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🍱 おせちは「タンパク質+食物繊維」 を先に', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '黒豆・昆布巻き・煮しめ等を先に取ると糖質吸収もマイルドに。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 連続イベント時こそ naturism', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: 'クリスマス→忘年会→大晦日→正月、 と続く時期は「毎晩 6 粒」 を目安に。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build12DecemberGiftFlex(): FlexContainer {
  // 帰省土産 / 家族用 hint (= 60 代の親世代も購入対象)
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎁 帰省土産にも naturism', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '帰省でご家族と過ごす方へ、 食習慣サポートを「会話のきっかけ」 として持参するのも◎', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🎀 親世代へのちょっとしたプレゼントに', size: 'xs', weight: 'bold', color: '#9d174d', margin: 'sm' },
        { type: 'text', text: '・7 日分お試し ¥696 (Blue) / ¥816 (Pink)', size: 'xs', color: '#334155' },
        { type: 'text', text: '・「最近健康気になるよね」 の自然な会話と一緒に', size: 'xs', color: '#334155' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '※ 個人差があります、 商品はサプリメントです', size: 'xxs', color: '#9ca3af', wrap: true, margin: 'sm' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build12DecemberShippingFlex(): FlexContainer {
  // 年末年始 発送案内
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fde68a',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '📦 年末年始 発送スケジュール', size: 'sm', weight: 'bold', color: '#854d0e', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🚛 年末発送 最終受付', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '12/27 までのご注文 → 年内発送 (= 配送業者次第で 12/29-31 着)', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🎍 年始発送 再開', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '1/4 から順次発送再開 (= 1/3 までは年末年始休業)', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '💡 早めの注文がオススメ', size: 'xs', weight: 'bold', color: '#854d0e', margin: 'sm' },
        { type: 'text', text: '帰省前に届けたい方は 12/25 までに注文を', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build12DecemberCallToAction(): FlexContainer {
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
        { type: 'text', text: '年末年始の食事 / 飲み方 / 帰省土産は気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『年末対策』 『飲み方』 『親へのプレゼント』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に年末対策を聞く', text: '年末対策' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/** 1 月: 新年リセット / 三が日 / 七草粥 / 寒さで運動少 (= naturism 軸: 新年習慣スタート、 Pink 推奨) */
function build1JanuaryIntro(displayName: string): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 新年あけましておめでとうございます🎍\n\n1 月は「新しい習慣をスタートしやすい」 時期。\n年末年始で食べ過ぎた方も多いはず、 naturism から新年リセットのヒントをお届けします🌿\n\n4 つのカードを順番にどうぞ 👇`,
  };
}

function build1JanuaryResetTipFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#e0f2fe',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎍 新年リセット 3 つの tip', size: 'sm', weight: 'bold', color: '#075985', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '🍵 七草粥でゆっくり胃腸を労る', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '1/7 の七草粥は消化に優しく、 年末年始の胃腸疲れリセットに最適 (= 古くからの知恵)。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '💧 水分補給を意識的に', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '冬は喉の渇きを感じにくく水分不足になりがち。 1.5L を目安に。', size: 'xs', color: '#475569', wrap: true },
        { type: 'separator', margin: 'sm' },
        { type: 'text', text: '🌿 「今年こそ習慣化」 を naturism と', size: 'sm', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: '新年は新しい習慣を始めるベストタイミング。 食事毎に Blue / Pink 6 粒で「習慣化」 を。', size: 'xs', color: '#475569', wrap: true },
      ],
    },
  } as unknown as FlexContainer;
}

function build1JanuaryPinkFlex(): FlexContainer {
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fce7f3',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '💗 Pink — 新年は美容も含めてケア', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '年末年始で胃腸も肌コンディションも乱れがち。 Pink は Blue + 活きた酵素で総合ケア。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌸 新年から「自分への投資」 を始める方に', size: 'xs', weight: 'bold', color: '#9d174d', margin: 'sm' },
        { type: 'separator', margin: 'md' },
        { type: 'text', text: '1日¥75〜 / 30日分 ¥2,250', size: 'sm', weight: 'bold', color: '#9d174d', align: 'center' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'uri', label: 'Pink を見る', uri: 'https://naturism-diet.com/' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'message', label: 'AI に Pink を聞く', text: 'Pink の成分' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

function build1JanuaryHabitFlex(): FlexContainer {
  // 新年の習慣化応援 hint
  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#dcfce7',
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '🎯 1 月の「習慣化チャレンジ」', size: 'sm', weight: 'bold', color: '#15803d', align: 'center' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        { type: 'text', text: '行動心理学的に、 21 日続けると習慣として定着しやすい (= "21 日の法則")', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '🌱 1 月にスタートすると…', size: 'xs', weight: 'bold', color: '#15803d', margin: 'sm' },
        { type: 'text', text: '・1/1 から始めれば 1/21 で定着、 春までに 3 ヶ月習慣', size: 'xs', color: '#334155' },
        { type: 'text', text: '・「食べたら飲む」 を当たり前に', size: 'xs', color: '#334155' },
        { type: 'text', text: '・新年の目標と一緒に達成感も◎', size: 'xs', color: '#334155' },
      ],
    },
  } as unknown as FlexContainer;
}

function build1JanuaryCallToAction(): FlexContainer {
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
        { type: 'text', text: '新年の食習慣 / リセット / 商品選びは気軽に AI へ。', size: 'sm', color: '#1e293b', wrap: true },
        { type: 'text', text: '『新年リセット』 『私におすすめ』 『習慣化のコツ』', size: 'sm', weight: 'bold', color: '#1e40af', wrap: true, margin: 'sm' },
        { type: 'text', text: '等と話しかけると AI が即お答えします 🤖', size: 'sm', color: '#1e293b', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        { type: 'button', action: { type: 'message', label: 'AI に新年リセットを聞く', text: '新年リセット' }, style: 'primary', color: '#06C755', height: 'sm' },
        { type: 'button', action: { type: 'uri', label: '公式ストアを見る', uri: 'https://naturism-diet.com/' }, style: 'secondary', height: 'sm' },
      ],
    },
  } as unknown as FlexContainer;
}

/**
 * month (1-12) → 5 message (= reply 1 回で送信)
 * Phase 2.1: 6 月のみ充実、 Phase 2.2 で 7-12 + 1 月追加、 他月は placeholder text (= 順次拡充)
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
    case 7:
      // Phase 2.2 (2026-05-24): 7 月 = 夏本番 / BBQ / 焼肉 / かき氷 / Blue 強化推奨
      return [
        build7JulyIntro(displayName),
        { type: 'flex', altText: '夏の食習慣 3 つの tip', contents: build7JulyTipFlex() },
        { type: 'flex', altText: 'Blue 強化 — BBQ・焼肉 に安心', contents: build7JulyBlueFlex() },
        { type: 'flex', altText: '夏キャンペーン (予告)', contents: build7JulyCampaignFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build7JulyCallToAction() },
      ];
    case 8:
      // Phase 2.2 (2026-05-26): 8 月 = お盆 / 夏バテ / 残暑 / Pink (酵素 + 美容) 強化推奨
      return [
        build8AugustIntro(displayName),
        { type: 'flex', altText: '夏バテ対策 3 つの tip', contents: build8AugustTipFlex() },
        { type: 'flex', altText: 'Pink — 夏疲れ + 美容ケア', contents: build8AugustPinkFlex() },
        { type: 'flex', altText: 'お盆休み + 夏キャンペーン', contents: build8AugustCampaignFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build8AugustCallToAction() },
      ];
    case 9:
      // Phase 2.2 (2026-05-26): 9 月 = 秋の入口 / 食欲の秋 / Blue vs Pink 使い分け / 再購入 reminder
      return [
        build9SeptemberIntro(displayName),
        { type: 'flex', altText: '秋の食習慣 3 つの tip', contents: build9SeptemberTipFlex() },
        { type: 'flex', altText: 'Blue と Pink の使い分け', contents: build9SeptemberCompareFlex() },
        { type: 'flex', altText: '続けることで実感する成分 (再購入)', contents: build9SeptemberReorderFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build9SeptemberCallToAction() },
      ];
    case 10:
      // Phase 2.2 PR #75 (2026-05-26): 10 月 = 紅葉 / スポーツの秋 / 行楽 / Blue 旅のお供
      return [
        build10OctoberIntro(displayName),
        { type: 'flex', altText: '行楽シーズンの食習慣 3 つ', contents: build10OctoberTipFlex() },
        { type: 'flex', altText: 'Blue を旅のお供に', contents: build10OctoberTravelKitFlex() },
        { type: 'flex', altText: '忘年会シーズン まで 2 ヶ月', contents: build10OctoberPrePartyHintFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build10OctoberCallToAction() },
      ];
    case 11:
      // Phase 2.2 PR #75 (2026-05-26): 11 月 = 忘年会シーズン / 飲み会 / 季節変わり目 / Blue 強化
      return [
        build11NovemberIntro(displayName),
        { type: 'flex', altText: '忘年会シーズン 3 つの対策', contents: build11NovemberPartyTipFlex() },
        { type: 'flex', altText: 'Blue — 忘年会の頼れる相棒', contents: build11NovemberBlueBoostFlex() },
        { type: 'flex', altText: '季節の変わり目を整える', contents: build11NovemberHealthFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build11NovemberCallToAction() },
      ];
    case 12:
      // Phase 2.2 PR #76 (2026-05-26): 12 月 = 年末年始 / クリスマス / 大晦日 / おせち / 帰省土産
      return [
        build12DecemberIntro(displayName),
        { type: 'flex', altText: '年末年始 3 つの食事 tip', contents: build12DecemberTipFlex() },
        { type: 'flex', altText: '帰省土産にも naturism', contents: build12DecemberGiftFlex() },
        { type: 'flex', altText: '年末年始 発送スケジュール', contents: build12DecemberShippingFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build12DecemberCallToAction() },
      ];
    case 1:
      // Phase 2.2 PR #76 (2026-05-26): 1 月 = 新年リセット / 七草粥 / Pink / 21 日習慣化
      return [
        build1JanuaryIntro(displayName),
        { type: 'flex', altText: '新年リセット 3 つの tip', contents: build1JanuaryResetTipFlex() },
        { type: 'flex', altText: 'Pink — 新年は美容もケア', contents: build1JanuaryPinkFlex() },
        { type: 'flex', altText: '1 月の習慣化チャレンジ', contents: build1JanuaryHabitFlex() },
        { type: 'flex', altText: '何でもお気軽に', contents: build1JanuaryCallToAction() },
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
