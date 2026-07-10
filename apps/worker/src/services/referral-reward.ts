/**
 * Referral Reward on Coupon Redemption (= 紹介者への報酬, 2026-07-10)
 *
 * 役割: referred (紹介された友だち) が「¥500 クーポン (= 友だち追加 welcome クーポン) を利用して購入」
 *   したとき、 その紹介者 (referrer) に ¥500 実クーポンを発行し、 LINE push で通知する。
 *   orders webhook の coupon-redemption 経路 (processOrderCouponRedemption が redeem を確定した
 *   friend) から、 その friend を referredFriendId として呼ばれる。
 *   ※ 任意の購入ではなく「クーポン利用」が条件 (= 成立1件 referred¥500 + referrer¥500 = ¥1,000)。
 *
 * 冪等性 (二重報酬防止):
 *   - issueReferralCoupon が (friend, role='referrer') UNIQUE で冪等 (= 同 referrer に 1 枚)。
 *   - referral_rewards.status を 'pending' → 'rewarded' に条件付き UPDATE (WHERE status='pending')。
 *     changes===1 (= その実行が flip を勝ち取った) のときだけ push を送る → 重複 push なし。
 *   - よって同一注文の再送 / referred の 2 回目以降の購入では報酬は 1 回きり。
 *
 * fail-safe:
 *   - gate off (REFERRAL_REWARD_ENABLED!=true) なら完全 no-op (= 本番 Shopify 未書込・push なし)。
 *   - organic buyer (紹介経由でない friend) は pending reward が無く no-op。
 *   - coupon 発行失敗時は flip せず push もしない (= 次回購入で再試行の余地を残す)。
 *
 * 関連: services/referral-coupon-issuer.ts、 services/channel-dispatcher.ts、 routes/shopify.ts。
 */

import type { LineClient } from '@line-crm/line-sdk';
import { issueReferralCoupon, type ReferralCouponEnv } from './referral-coupon-issuer.js';
import { dispatch } from './channel-dispatcher.js';
import { auditSystem } from './audit-logger.js';

export interface ReferralRewardEnv extends ReferralCouponEnv {
  LIFF_URL?: string;
  WORKER_URL?: string;
}

export interface ProcessReferralRewardInput {
  /** ¥500 クーポンを利用して購入した friend (= 潜在的 referred)。 coupon-redemption が確定した所有 friend_id。 */
  referredFriendId: string;
  lineAccountId?: string | null;
  /** test 用 clock 注入 (referral_rewards.rewarded_at 用) */
  now?: () => number;
}

export interface ReferralRewardResult {
  /** 対象 friend にひもづく pending reward 件数 */
  pendingFound: number;
  /** referrer coupon を発行できた件数 */
  rewarded: number;
  /** LINE push を送れた件数 */
  pushed: number;
}

interface PendingRewardRow {
  id: string;
  referrer_friend_id: string;
}

// ============================================================
// referrer 通知 Flex (pure — test しやすい)
// ============================================================

export function buildReferrerRewardMessage(
  couponCode: string,
  expiresAt: string | null,
  liffUrl: string,
): { type: 'flex'; altText: string; contents: unknown } {
  const expiryLabel = expiresAt ? `有効期限 ${expiresAt.slice(0, 10)}` : '';
  const bodyContents: unknown[] = [
    {
      type: 'text',
      text: '🎉 お友だちが購入しました!',
      weight: 'bold',
      size: 'md',
      color: '#0f766e',
      wrap: true,
    },
    {
      type: 'text',
      text: 'ご紹介ありがとうございます。お礼に500円OFFクーポンをプレゼントします。',
      size: 'sm',
      color: '#555555',
      wrap: true,
      margin: 'sm',
    },
    {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      paddingAll: '12px',
      backgroundColor: '#fff3ec',
      cornerRadius: '10px',
      contents: [
        {
          type: 'text',
          text: couponCode,
          weight: 'bold',
          size: 'lg',
          align: 'center',
          color: '#b84a2e',
        },
        ...(expiryLabel
          ? [{ type: 'text', text: expiryLabel, size: 'xxs', align: 'center', color: '#9CA3AF', margin: 'sm' }]
          : []),
      ],
    },
  ];

  return {
    type: 'flex',
    altText: '🎉 ご紹介ありがとうございます! 500円OFFクーポンをプレゼント',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: bodyContents,
      },
      footer: liffUrl
        ? {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                action: { type: 'uri', label: 'クーポンを見る', uri: liffUrl },
                style: 'primary',
                color: '#0f766e',
              },
            ],
          }
        : undefined,
    },
  };
}

// ============================================================
// main
// ============================================================

export async function processReferralRewardOnPurchase(
  db: D1Database,
  env: ReferralRewardEnv,
  lineClient: LineClient,
  input: ProcessReferralRewardInput,
): Promise<ReferralRewardResult> {
  const result: ReferralRewardResult = { pendingFound: 0, rewarded: 0, pushed: 0 };

  // gate off なら完全 no-op (= 承認前は本番未書込)
  if (env.REFERRAL_REWARD_ENABLED !== 'true') {
    return result;
  }

  const referredFriendId = input.referredFriendId;
  const lineAccountId = input.lineAccountId ?? null;
  const nowFn = input.now ?? Date.now;

  // 1. この friend が「紹介された側」である pending reward を取得。
  //   1 購入で報われる referrer は最古 (先着) の 1 人だけに絞る (ORDER BY created_at ASC LIMIT 1)。
  //   claim 側で referred 単位に cap 済のため通常 1 行だが、 万一の並行 claim race で複数行できても
  //   「1 購入 = 1 referrer 報酬」を保ち報酬増幅を防ぐ (review HIGH の多重防御)。
  const { results } = await db
    .prepare(
      `SELECT id, referrer_friend_id
         FROM referral_rewards
        WHERE referred_friend_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .bind(referredFriendId)
    .all<PendingRewardRow>();

  const pending = results ?? [];
  result.pendingFound = pending.length;
  if (pending.length === 0) return result;

  const liffUrl = env.LIFF_URL || env.WORKER_URL || '';

  for (const reward of pending) {
    // 自己紹介防止の二重ガード (claim でも弾くが、 万一のデータ不整合に備える)
    if (reward.referrer_friend_id === referredFriendId) continue;

    // 2. referrer に referral coupon を発行 (冪等: (friend, 'referrer') UNIQUE)
    const coupon = await issueReferralCoupon(db, env, {
      friendId: reward.referrer_friend_id,
      role: 'referrer',
      rewardId: reward.id,
      lineAccountId,
    });
    if (!coupon) {
      // gate off / 発行失敗 → flip せず (次回購入で再試行の余地)
      continue;
    }
    result.rewarded++;

    // 3. atomic flip: pending → rewarded。 flip を勝ち取った実行だけ push (= 重複 push 防止)
    const rewardedAt = new Date(nowFn()).toISOString();
    const flip = await db
      .prepare(
        `UPDATE referral_rewards SET status = 'rewarded', rewarded_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(rewardedAt, reward.id)
      .run();
    if ((flip.meta?.changes ?? 0) !== 1) {
      // 別実行が既に flip 済 → coupon は冪等発行済、 push は勝者に任せる
      continue;
    }

    // 4. referrer に push — ただし「新規発行クーポン」のときだけ (誤通知防止)。
    //   この referrer が別の referred の購入で既に受給済 (isExisting) なら、 新しいクーポンは無いのに
    //   「クーポンをプレゼント」を再送してしまう。 reward 行は flip 済 (terminal) なので、 push だけ抑止する。
    //   blacklist/not_following は dispatch が自動 skip。
    const referrer = coupon.isExisting
      ? null
      : await db
          .prepare('SELECT line_user_id FROM friends WHERE id = ?')
          .bind(reward.referrer_friend_id)
          .first<{ line_user_id: string | null }>();

    if (referrer?.line_user_id) {
      const message = buildReferrerRewardMessage(coupon.code, coupon.expiresAt, liffUrl);
      try {
        const dispatchResult = await dispatch(
          { db, lineClient },
          {
            recipient: { friend: { id: reward.referrer_friend_id, lineUserId: referrer.line_user_id } },
            channel: 'line',
            category: 'transactional', // 獲得済報酬の通知 (配信停止後も届く区分)
            sourceKind: 'transactional',
            linePayload: { messages: [message] },
          },
        );
        const lineResult = dispatchResult.results.find((r) => r.channel === 'line');
        if (lineResult?.status === 'sent') result.pushed++;
      } catch (err) {
        console.error(
          '[referral-reward] push failed (coupon は発行済):',
          err instanceof Error ? err.name : 'unknown',
        );
      }
    }

    await auditSystem(db, {
      action: 'referral_reward.rewarded',
      actorType: 'webhook',
      targetType: 'friend',
      targetId: reward.referrer_friend_id,
      lineAccountId,
      result: 'success',
      metadata: {
        rewardId: reward.id,
        referredFriendId,
        couponCode: coupon.code,
      },
    });
  }

  return result;
}
