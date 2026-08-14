/**
 * welcome→referred 格上げ (¥300→¥500, Ultraplan PR-C R3, 2026-08-13)
 *
 * 紹介 claim 成立時、その referred (紹介された側) の未使用 welcome ¥300 を ¥500 に差し替える。
 * 「紹介された方がお得」を体験として届ける (welcome とのダブル発行は構造的に不可能 =
 * 同一行の書き換えで friend_id UNIQUE を保つ)。
 *
 * 手順と防壁 (採点ループ 統合検証 CONFIRMED の反映):
 *   ① metadata json_patch CAS で格上げ権を先取 (status 列は CHECK 制約で増やせないため
 *      metadata.upgrade を印にする)。expires_at > now を条件に含める (期限切れは格上げしない)。
 *      plannedCode も同時に記録 (再駆動の冪等キー)。
 *   ② 旧 ¥300 を discountCodeDeactivate — **create より先に殺す** (逆順だと ¥300+¥500 の併用窓)。
 *      失敗 → marker を外して撤退 (旧 ¥300 は無傷)。
 *   ③ ¥500 create (期限は旧券の残りを引き継ぐ = 格上げで寿命を延ばさない)。
 *      失敗 → 旧 ¥300 を activate で復活 (補償) + marker 解除。
 *   ④ 同一行 UPDATE (WHERE redeemed_at IS NULL を**再適用**)。負け (直前に使用された) →
 *      新 ¥500 を deactivate (補償)。旧 code は metadata.upgrade.oldCode に退避 —
 *      deactivate 前に確定した注文の redemption は redeemCouponByCode の oldCode 照合が拾う。
 *   ⑤ 勝者だけが LINE push 「¥300 → ¥500 に増額しました」(旧番号の失効を明示 — 景表法配慮)。
 *
 * welcome 未発行で claim が先の場合: ¥500 を直接発行し push は 1 本に統合 (2連 push 回避)。
 */

import type { LineClient } from '@line-crm/line-sdk';
import { getShopifyAccessToken } from './shopify-token.js';
import { auditSystem } from './audit-logger.js';
import { dispatch } from './channel-dispatcher.js';
import { deactivateDiscountCode, activateDiscountCode } from './shopify-discount-admin.js';
import {
  issueCouponForFriend,
  UPGRADED_DISCOUNT_VALUE_JPY,
  __test__ as welcomeInternal,
  type ShopifyEnv,
} from './shopify-coupon-issuer.js';

export interface WelcomeUpgradeEnv extends ShopifyEnv {
  REFERRAL_REWARD_ENABLED?: string;
  LIFF_URL?: string;
  WORKER_URL?: string;
}

export interface WelcomeUpgradeResult {
  outcome: 'upgraded' | 'issued_directly' | 'not_eligible' | 'failed' | 'gated_off';
  newCode?: string;
  expiresAt?: string | null;
  pushed?: boolean;
}

interface WelcomeRow {
  id: string;
  coupon_code: string;
  shopify_discount_code_id: string | null;
  discount_value: number;
  expires_at: string | null;
  redeemed_at: string | null;
  status: string;
  line_account_id: string | null;
}

export function buildWelcomeUpgradeMessage(
  newCode: string,
  expiresAt: string | null,
  liffUrl: string,
): { type: 'flex'; altText: string; contents: unknown } {
  const expiryLabel = expiresAt ? `有効期限 ${expiresAt.slice(0, 10)}` : '';
  return {
    type: 'flex',
    altText: '🎁 ご紹介特典: クーポンを¥500に増額しました',
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '🎁 クーポンを ¥500 に増額しました', weight: 'bold', size: 'md', color: '#0f766e', wrap: true },
          { type: 'text', text: 'お友だちからのご紹介経由でしたので、友だち追加クーポンを ¥300 → ¥500 に増額しました。', size: 'sm', color: '#555555', wrap: true, margin: 'sm' },
          {
            type: 'box', layout: 'vertical', margin: 'md', paddingAll: '12px', backgroundColor: '#f0fbfa', cornerRadius: '10px',
            contents: [
              { type: 'text', text: newCode, weight: 'bold', size: 'lg', align: 'center', color: '#0f766e' },
              ...(expiryLabel ? [{ type: 'text', text: expiryLabel, size: 'xxs', align: 'center', color: '#9CA3AF', margin: 'sm' }] : []),
              { type: 'text', text: 'クーポン番号が新しくなっています。以前の番号はご利用いただけません。', size: 'xxs', align: 'center', color: '#9CA3AF', margin: 'sm', wrap: true },
            ],
          },
        ],
      },
      footer: liffUrl
        ? { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label: 'クーポンを見る', uri: liffUrl }, style: 'primary', color: '#0f766e' }] }
        : undefined,
    },
  };
}

export async function upgradeWelcomeCouponForReferred(
  db: D1Database,
  env: WelcomeUpgradeEnv,
  lineClient: LineClient | null,
  input: { friendId: string; lineAccountId?: string | null; now?: () => number; fetchImpl?: typeof fetch },
): Promise<WelcomeUpgradeResult> {
  const { friendId } = input;
  const nowFn = input.now ?? Date.now;
  const fetchImpl = input.fetchImpl ?? fetch.bind(globalThis);

  // 格上げは紹介機能の一部 (紹介 gate に従う)
  if (env.REFERRAL_REWARD_ENABLED !== 'true') return { outcome: 'gated_off' };

  const row = await db
    .prepare(
      `SELECT id, coupon_code, shopify_discount_code_id, discount_value, expires_at, redeemed_at, status, line_account_id
         FROM line_friend_coupons WHERE friend_id = ? LIMIT 1`,
    )
    .bind(friendId)
    .first<WelcomeRow>();

  const nowMs = nowFn();
  const nowIso = new Date(nowMs).toISOString();

  // welcome 未発行 (claim が follow より先 / 発行失敗) → ¥500 を直接発行。push は welcome flow に任せる
  if (!row) {
    const issued = await issueCouponForFriend(db, env, {
      friendId,
      lineAccountId: input.lineAccountId ?? null,
      discountValueJpy: UPGRADED_DISCOUNT_VALUE_JPY,
      validDays: 7,
      fetchImpl,
      now: nowFn,
    });
    return issued
      ? { outcome: 'issued_directly', newCode: issued.code, expiresAt: issued.expiresAt }
      : { outcome: 'failed' };
  }

  // 使用済み (初回購入の目的は達成済み) / 既に ¥500 / 期限切れ / 失効は格上げしない
  if (row.discount_value !== 300 || row.status !== 'issued' || row.redeemed_at) {
    return { outcome: 'not_eligible' };
  }

  // ① CAS: metadata.upgrade を印に格上げ権を先取 (並行 claim の二重格上げ防止)
  const plannedCode = welcomeInternal.generateCouponCode(welcomeInternal.DEFAULT_CODE_PREFIX);
  const casPatch = JSON.stringify({ upgrade: { claimedAt: nowIso, plannedCode } });
  const cas = await db
    .prepare(
      `UPDATE line_friend_coupons
          SET metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE id = ? AND discount_value = 300 AND status = 'issued' AND redeemed_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND json_extract(COALESCE(metadata, '{}'), '$.upgrade') IS NULL`,
    )
    .bind(casPatch, row.id, nowIso)
    .run();
  if ((cas.meta?.changes ?? 0) !== 1) return { outcome: 'not_eligible' };

  const fail = async (stage: string, err: string, clearMarker: boolean): Promise<WelcomeUpgradeResult> => {
    if (clearMarker) {
      // json_patch の null 値はキー削除 = marker 解除 (将来の再試行余地を残す)
      await db
        .prepare(`UPDATE line_friend_coupons SET metadata = json_patch(COALESCE(metadata,'{}'), '{"upgrade":null}') WHERE id = ?`)
        .bind(row.id)
        .run()
        .catch(() => {});
    }
    await auditSystem(db, {
      action: 'welcome_upgrade.failed',
      actorType: 'system',
      targetType: 'friend',
      targetId: friendId,
      lineAccountId: row.line_account_id,
      result: 'failure',
      errorMessage: err,
      metadata: { stage },
    });
    return { outcome: 'failed' };
  };

  if (!env.SHOPIFY_STORE_DOMAIN || !row.shopify_discount_code_id) {
    return fail('precondition', 'store domain or old gid missing', true);
  }
  let accessToken: string;
  try {
    accessToken = await getShopifyAccessToken(db, env);
  } catch (e) {
    return fail('access_token', e instanceof Error ? e.message : String(e), true);
  }

  // ② 旧 ¥300 を先に殺す (逆順だと ¥300+¥500 の併用窓が開く)
  const deact = await deactivateDiscountCode(env.SHOPIFY_STORE_DOMAIN, accessToken, row.shopify_discount_code_id, fetchImpl);
  if (!deact.ok) return fail('deactivate_old', deact.error, true);

  // ③ ¥500 create (期限は旧券の残りを引き継ぐ。expires_at 無しは既定 7 日)
  const remainingDays = row.expires_at
    ? Math.max((Date.parse(row.expires_at) - nowMs) / 86_400_000, 0.01)
    : 7;
  const created = await welcomeInternal.callShopifyDiscountCreate(
    env.SHOPIFY_STORE_DOMAIN,
    accessToken,
    plannedCode,
    UPGRADED_DISCOUNT_VALUE_JPY,
    remainingDays,
    nowMs,
    fetchImpl,
    env.SHOPIFY_WELCOME_CUSTOMER_SEGMENT_ID ?? null,
  );
  if (!created.ok) {
    // 補償: 旧 ¥300 を復活 (best-effort) — 顧客をクーポンレスにしない
    await activateDiscountCode(env.SHOPIFY_STORE_DOMAIN, accessToken, row.shopify_discount_code_id, fetchImpl).catch(() => {});
    return fail('create_new', created.error, true);
  }

  // ④ 同一行 UPDATE (redeemed_at IS NULL を再適用 — deactivate 前に確定した使用に負けない)
  const newExpiresAt = new Date(nowMs + remainingDays * 86_400_000).toISOString();
  const donePatch = JSON.stringify({
    upgrade: { claimedAt: nowIso, plannedCode, completedAt: nowIso, oldCode: row.coupon_code, oldGid: row.shopify_discount_code_id },
  });
  const swap = await db
    .prepare(
      `UPDATE line_friend_coupons
          SET coupon_code = ?, shopify_discount_code_id = ?, discount_value = ?,
              expires_at = ?, metadata = json_patch(COALESCE(metadata, '{}'), ?)
        WHERE id = ? AND redeemed_at IS NULL`,
    )
    .bind(created.actualCode, created.discountCodeId, UPGRADED_DISCOUNT_VALUE_JPY, newExpiresAt, donePatch, row.id)
    .run();
  if ((swap.meta?.changes ?? 0) !== 1) {
    // 直前に旧 ¥300 が使用された (race) → 新 ¥500 は台帳非追跡になるため殺す
    await deactivateDiscountCode(env.SHOPIFY_STORE_DOMAIN, accessToken, created.discountCodeId, fetchImpl).catch(() => {});
    return fail('swap_lost_to_redemption', 'welcome was redeemed mid-upgrade', false);
  }

  await auditSystem(db, {
    action: 'welcome_upgrade.completed',
    actorType: 'system',
    targetType: 'friend',
    targetId: friendId,
    lineAccountId: row.line_account_id,
    result: 'success',
    metadata: { oldCode: row.coupon_code, newCode: created.actualCode, expiresAt: newExpiresAt },
  });

  // ⑤ push (勝者のみ)
  let pushed = false;
  if (lineClient) {
    const friend = await db
      .prepare('SELECT line_user_id FROM friends WHERE id = ?')
      .bind(friendId)
      .first<{ line_user_id: string | null }>();
    if (friend?.line_user_id) {
      try {
        const liffUrl = env.LIFF_URL || env.WORKER_URL || '';
        const r = await dispatch(
          { db, lineClient },
          {
            recipient: { friend: { id: friendId, lineUserId: friend.line_user_id } },
            channel: 'line',
            category: 'transactional',
            sourceKind: 'transactional',
            linePayload: { messages: [buildWelcomeUpgradeMessage(created.actualCode, newExpiresAt, liffUrl)] },
          },
        );
        pushed = r.results.find((x) => x.channel === 'line')?.status === 'sent';
      } catch (e) {
        console.error('[welcome-upgrade] push failed (格上げ自体は完了):', e instanceof Error ? e.name : 'unknown');
      }
    }
  }

  return { outcome: 'upgraded', newCode: created.actualCode, expiresAt: newExpiresAt, pushed };
}
