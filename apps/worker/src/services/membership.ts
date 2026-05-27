/**
 * Membership service (= Phase 4 PR #82、 2026-05-27)
 *
 * 役割:
 *   会員ランク 制度の純関数 + 1 entry (= promoteAndNotify)。
 *   Shopify orders 連動 (= 累計購入額 update) は別 PR (= PR #83 想定)、
 *   cron 接続 + LINE 通知大量 dispatch は別 PR (= PR #84 想定)。
 *
 * 本 PR (= scaffolding) で完結する範囲:
 *   - buildTierUpFlex: 昇格通知の Flex Message 構築 (= 純関数、 unit test 容易)
 *   - formatTierBenefits: tier perks の human-readable 表現 (= 純関数)
 *   - promoteAndNotify: 1 member の昇格 check + LINE push (= unit test mock 必要)
 *
 * cost zero design:
 *   - 昇格時 push 1 通 / member (= 昇格は数ヶ月 1 回程度の頻度)
 *   - 既 promoted は push なし (= db.last_promotion_at check 不要、 promoteMemberIfEligible
 *     が「昇格時のみ true」 返す)
 *
 * 関連:
 *   - migration 058 = membership_tiers + members (PR #80 で apply 済)
 *   - packages/db/src/membership.ts = query module
 */
import type { LineClient, FlexContainer, Message } from '@line-crm/line-sdk';
import {
  promoteMemberIfEligible,
  getMembershipTierById,
  getMemberByFriendId,
  type MembershipTier,
} from '@line-crm/db';

// ============================================================
// 純関数: tier benefits フォーマット
// ============================================================

/**
 * tier の perks を「人間が読める」 1 行説明に変換 (= 純関数)。
 */
export function formatTierBenefits(tier: MembershipTier): string[] {
  const lines: string[] = [];
  if (tier.perks.discountPercent && tier.perks.discountPercent > 0) {
    lines.push(`🎁 全商品 ${tier.perks.discountPercent}% OFF`);
  }
  if (tier.perks.prioritySupport) {
    lines.push(`💬 優先サポート (= 平日 24h 以内返信目標)`);
  }
  if (tier.perks.exclusiveProducts && tier.perks.exclusiveProducts.length > 0) {
    lines.push(
      `✨ 限定商品アクセス (= ${tier.perks.exclusiveProducts.slice(0, 3).join(' / ')})`,
    );
  }
  if (tier.perks.affiliateCode) {
    lines.push(`🌟 アフィリエイト code 発行可 (= 紹介リンク収益化)`);
  }
  if (lines.length === 0) {
    lines.push(`🌿 naturism コミュニティへようこそ`);
  }
  return lines;
}

// ============================================================
// 純関数: 昇格通知 Flex 構築
// ============================================================

/**
 * 昇格通知の Flex Container 構築 (= 純関数、 LineClient 不要)。
 *
 * @example
 *   buildTierUpFlex(bronzeTier, silverTier, '加藤') → FlexContainer
 */
export function buildTierUpFlex(
  oldTier: MembershipTier,
  newTier: MembershipTier,
  displayName: string,
): FlexContainer {
  const benefits = formatTierBenefits(newTier);
  const accentColor = newTier.badgeColor ?? '#06C755';

  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: accentColor,
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: `${newTier.badgeEmoji ?? '🎉'} ランクアップ!`,
          size: 'lg',
          weight: 'bold',
          color: '#ffffff',
          align: 'center',
        },
        {
          type: 'text',
          text: `${oldTier.name} → ${newTier.name}`,
          size: 'sm',
          color: '#ffffff',
          align: 'center',
          margin: 'sm',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'md',
      contents: [
        {
          type: 'text',
          text: `${displayName}さん、 おめでとうございます🌿`,
          size: 'md',
          weight: 'bold',
          color: '#1e293b',
          wrap: true,
        },
        {
          type: 'text',
          text: `naturism のご愛顧、 ありがとうございます。 ${newTier.name} 会員ランクへ昇格しました。`,
          size: 'sm',
          color: '#475569',
          wrap: true,
        },
        { type: 'separator', margin: 'md' },
        {
          type: 'text',
          text: '✨ 新しい特典',
          size: 'sm',
          weight: 'bold',
          color: '#1e293b',
          margin: 'sm',
        },
        ...benefits.map((line) => ({
          type: 'text' as const,
          text: line,
          size: 'xs' as const,
          color: '#334155',
          wrap: true,
        })),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '公式ストアを見る',
            uri: 'https://naturism-diet.com/',
          },
          style: 'primary',
          color: '#06C755',
          height: 'sm',
        },
      ],
    },
  } as unknown as FlexContainer;
}

/**
 * 昇格通知の text intro (= flex の前に送る挨拶 text)。
 */
export function buildTierUpIntro(displayName: string, newTier: MembershipTier): Message {
  return {
    type: 'text',
    text: `${displayName}さん、 嬉しいお知らせです🌿\n\nnaturism 会員ランクが ${newTier.badgeEmoji ?? '✨'} ${newTier.name} に昇格しました。\n\n新しい特典を以下のカードでご確認ください 👇`,
  };
}

// ============================================================
// 1 member の昇格 + 通知 (= entry point、 cron / webhook から呼ぶ)
// ============================================================

export interface PromoteAndNotifyEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}

export interface PromoteAndNotifyResult {
  promoted: boolean;
  fromTier: string;
  toTier: string;
  pushed: boolean;
  reason?: string;
}

/**
 * 1 friend の昇格 check + 昇格時 LINE push。
 *
 * 設計:
 *   - promoteMemberIfEligible で db update (= 純関数、 既 promoted なら no-op)
 *   - promoted=true の場合のみ LINE push (= cost zero design)
 *   - friend の display_name 取得 (= 通知 personalization)
 *   - push 失敗で例外 throw せず、 pushed=false で返す (= cron 全体止めない)
 */
export async function promoteAndNotify(
  env: PromoteAndNotifyEnv,
  lineClient: LineClient,
  friendId: string,
  lineUserId: string,
  displayName: string | null,
): Promise<PromoteAndNotifyResult> {
  const result = await promoteMemberIfEligible(env.DB, friendId);

  if (!result.promoted) {
    return {
      promoted: false,
      fromTier: result.fromTier,
      toTier: result.toTier,
      pushed: false,
      reason: 'not eligible for higher tier',
    };
  }

  const oldTier = await getMembershipTierById(env.DB, result.fromTier);
  const newTier = await getMembershipTierById(env.DB, result.toTier);
  if (!oldTier || !newTier) {
    return {
      promoted: true,
      fromTier: result.fromTier,
      toTier: result.toTier,
      pushed: false,
      reason: 'tier lookup failed',
    };
  }

  const name = displayName ?? 'お客様';
  const messages: Message[] = [
    buildTierUpIntro(name, newTier),
    {
      type: 'flex',
      altText: `${newTier.badgeEmoji ?? '✨'} ${newTier.name} に昇格しました`,
      contents: buildTierUpFlex(oldTier, newTier, name),
    },
  ];

  try {
    await lineClient.pushMessage(lineUserId, messages);
    return {
      promoted: true,
      fromTier: result.fromTier,
      toTier: result.toTier,
      pushed: true,
    };
  } catch (err) {
    console.error(
      '[membership] tier-up push failed',
      friendId,
      err instanceof Error ? err.message : 'unknown',
    );
    return {
      promoted: true,
      fromTier: result.fromTier,
      toTier: result.toTier,
      pushed: false,
      reason: err instanceof Error ? err.message : 'push failed',
    };
  }
}

/**
 * friend 1 件 lookup + promote (= webhook で 1 friend の購入後 trigger 用)。
 */
export async function checkAndNotifyForFriend(
  env: PromoteAndNotifyEnv,
  lineClient: LineClient,
  friendId: string,
): Promise<PromoteAndNotifyResult> {
  const member = await getMemberByFriendId(env.DB, friendId);
  if (!member) {
    return {
      promoted: false,
      fromTier: '',
      toTier: '',
      pushed: false,
      reason: 'member not found',
    };
  }

  // friend lookup (= line_user_id + display_name)
  const friend = await env.DB
    .prepare(`SELECT line_user_id, display_name FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ line_user_id: string; display_name: string | null }>();
  if (!friend) {
    return {
      promoted: false,
      fromTier: '',
      toTier: '',
      pushed: false,
      reason: 'friend not found',
    };
  }

  return promoteAndNotify(env, lineClient, friendId, friend.line_user_id, friend.display_name);
}

// ============================================================
// テスト用エクスポート
// ============================================================

export const __test__ = {
  formatTierBenefits,
  buildTierUpFlex,
  buildTierUpIntro,
};
