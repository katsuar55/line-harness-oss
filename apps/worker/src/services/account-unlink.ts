/**
 * アカウント連携の解除サービス (2026-08-28)
 *
 * DB の巻き戻し本体は packages/db の unlinkFriendFromShopifyCustomer (= 何を消して何を残すかの
 * 判断はそちらの冒頭コメントが正)。ここは **監査** と **Shopify metafield の後始末** を足す。
 *
 * ## 🚨 metafield を消さないと cron が連携を復活させうる
 * OTP 連携は成功時に Shopify customer の metafield へ line_user_id を書く
 * (services/account-link.ts の setCustomerLineUserIdMetafield)。一方 friend-customer-linker cron は
 * metafield を逆引きして friends.shopify_customer_id を埋め直す。両者の namespace は現状の本番設定では
 * 別 (cron=FRIEND_LINK_METAFIELD_* / OTP=ACCOUNT_LINK_METAFIELD_*) なので**今すぐ復活はしない**が、
 * 統合 op を実行した後は同一 namespace になり「解除したのに翌 02:00 に戻る」が成立する。
 * 将来の地雷を踏まないため、解除時に metafield も消しておく (best-effort)。
 *
 * ## 実行者の記録
 * 顧客自身の解除 (LIFF) と運用者の解除 (admin) を audit の actor で区別する。
 * 誤連携の是正なのか顧客の意思なのかを事後に切り分けられないと、再連携の可否を判断できない。
 */
import { unlinkFriendFromShopifyCustomer, type UnlinkResult } from '@line-crm/db';
import { auditSystem } from './audit-logger.js';
import { getShopifyAccessToken } from './shopify-token.js';
import { deleteCustomerLineUserIdMetafield } from './account-link-shopify.js';

const DEFAULT_METAFIELD_NAMESPACE = 'naturism';
const DEFAULT_METAFIELD_KEY = 'line_user_id';

export interface UnlinkEnv {
  DB: D1Database;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  ACCOUNT_LINK_METAFIELD_NAMESPACE?: string;
  ACCOUNT_LINK_METAFIELD_KEY?: string;
}

export interface UnlinkOptions {
  friendId: string;
  /** 'customer' = 本人が LIFF から解除 / 'admin' = 運用者が代行。audit の actor に残る。 */
  actor: 'customer' | 'admin';
  /** 運用者の識別子 (admin のときのみ)。PII は入れない。 */
  actorId?: string | null;
  /** test 用注入。 */
  deleteMetafieldImpl?: typeof deleteCustomerLineUserIdMetafield;
  fetchImpl?: typeof fetch;
}

export interface UnlinkOutcome extends UnlinkResult {
  /** Shopify metafield を消せたか (未設定・失敗時 false)。連携解除の成否とは独立。 */
  readonly metafieldDeleted: boolean;
}

export async function unlinkAccount(env: UnlinkEnv, options: UnlinkOptions): Promise<UnlinkOutcome> {
  const result = await unlinkFriendFromShopifyCustomer(env.DB, options.friendId);

  // 未連携なら書込ゼロ = 監査も残さない (冪等な no-op)
  if (!result.unlinked) return { ...result, metafieldDeleted: false };

  // metafield の後始末 (best-effort)。ここで失敗しても D1 の解除は既に成立している。
  let metafieldDeleted = false;
  try {
    if (env.SHOPIFY_STORE_DOMAIN) {
      const token = await getShopifyAccessToken(env.DB, env as unknown as Record<string, string | undefined>);
      const del = options.deleteMetafieldImpl ?? deleteCustomerLineUserIdMetafield;
      const r = await del(
        env.SHOPIFY_STORE_DOMAIN,
        token,
        result.shopifyCustomerId as string,
        env.ACCOUNT_LINK_METAFIELD_NAMESPACE || DEFAULT_METAFIELD_NAMESPACE,
        env.ACCOUNT_LINK_METAFIELD_KEY || DEFAULT_METAFIELD_KEY,
        options.fetchImpl ?? fetch.bind(globalThis),
      );
      metafieldDeleted = r.ok;
    }
  } catch (err) {
    console.warn('[account-unlink] metafield delete failed (non-fatal):', err instanceof Error ? err.message : 'unknown');
  }

  // 監査 (PII なし)。cleared の内訳まで残すのは、誤連携の影響範囲を事後に測るため。
  await auditSystem(env.DB, {
    action: 'account_link.unlinked',
    // auditSystem の actorType は system/cron/webhook/api のみ。実行者の区別は metadata に持つ
    actorType: 'api',
    actorId: options.actorId ?? undefined,
    targetType: 'friend',
    targetId: options.friendId,
    result: 'success',
    metadata: {
      shopifyCustomerId: result.shopifyCustomerId,
      // 誤連携の是正 (admin) か顧客の意思 (customer) かは再連携の可否判断に要る
      unlinkedBy: options.actor,
      cleared: result.cleared,
      metafieldDeleted,
      // 🚨 連携特典 ¥300 の台帳は意図的に残している (二重発行防止の冪等キー)
      linkRewardLedgerKept: true,
    },
  });

  return { ...result, metafieldDeleted };
}
